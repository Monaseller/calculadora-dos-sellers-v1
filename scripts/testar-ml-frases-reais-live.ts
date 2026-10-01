/**
 * AGENT-FACTORY-F7b.4.8.3 §39 — as sete frases, na rota real.
 *
 * Suite LIVE: sessao assinada, rota real de conversa, runtime real,
 * **OpenAI real**, tool loop real, guard real, e a **API oficial do
 * Mercado Livre** na loja que o dono ja autorizou. Somente LEITURA.
 *
 * ── Por que no agente REAL, e nao numa fixture ──────────────────────
 *
 * O guard exige `cobertura === "confirmada"`, e so uma chamada remota de
 * verdade ao Mercado Livre concede isso. Loja fixture nao tem credencial e
 * para em `conexao_ausente` — ela e estruturalmente incapaz de atravessar
 * o caminho que este gate manda provar.
 *
 * Nada do agente e alterado: nenhuma permissao concedida, nenhuma fonte
 * acrescentada, nenhuma instrucao tocada. A suite CRIA uma conversa, fala
 * nela, e apaga a conversa no fim — `agente_conversas` e CASCADE e nada a
 * referencia com RESTRICT (medido). O agente em si nao poderia ser criado
 * e apagado: `agente_funcao_chamadas.agente_id` e RESTRICT, entao um
 * agente de teste ficaria para sempre na conta de uma pessoa real.
 *
 * ── Como se prova que o numero esta certo ───────────────────────────
 *
 * `entrada_resumo` da auditoria e `{}` — nenhum chamador de producao o
 * alimenta, entao o periodo que o modelo mandou NAO esta gravado. Ler o
 * argumento, porem, seria a prova menor. A prova que importa e outra:
 * para cada frase a suite calcula o total pela fonte deterministica e
 * exige que ESSE numero apareca no texto que a pessoa le. Se o modelo
 * tivesse inventado outra janela, ou feito a conta de cabeca, o valor nao
 * bateria.
 *
 * Roda com:
 *   OPENAI_MODEL_AGENTE=gpt-5.2 npx tsx scripts/testar-ml-frases-reais-live.ts
 */
import "./_server-only-inerte";

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@supabase/supabase-js";

function carregarEnvLocal(): void {
  for (const caminho of [
    join(__dirname, "..", ".env.local"),
    join("C:", "Users", "USER", "Desktop", "calculadora-dos-sellers-v1", ".env.local"),
  ]) {
    try {
      for (const linha of readFileSync(caminho, "utf-8").split("\n")) {
        const l = linha.trim();
        if (!l || l.startsWith("#")) continue;
        const i = l.indexOf("=");
        if (i <= 0) continue;
        const k = l.slice(0, i).trim();
        if (!process.env[k]) process.env[k] = l.slice(i + 1).trim().replace(/^["']|["']$/g, "");
      }
      return;
    } catch { /* proximo */ }
  }
}
carregarEnvLocal();

/** A loja MONAMOR — conexao autorizada pelo dono. LEITURA apenas. */
const LOJA_REAL = "50165b6f-5185-4da7-991a-07c0c6bc8f39";
const FUNCAO_ML = "mercadolivre.vendas.consultar";

/** As sete frases do §39, na ordem em que o gate as escreve. */
const FRASES: readonly {
  readonly texto: string;
  readonly janelas: readonly string[];
  /** F7b.4.8.5 §14: a resposta precisa trazer valor, vendas E unidades. */
  readonly exigeOsTres?: boolean;
}[] = [
  { texto: "Quanto vendi esta semana no Mercado Livre?", janelas: ["esta semana"] },
  {
    texto: "Compare esta semana com a semana passada e me fale a diferença em reais e em porcentagem.",
    janelas: ["esta semana", "semana passada"],
  },
  { texto: "me traz os últimos 7 dias", janelas: ["últimos 7 dias"] },
  { texto: "quanto vendi de 10/09/2026 até 20/09/2026?", janelas: ["de 10/09/2026 até 20/09/2026"] },
  { texto: "quanto vendi em agosto de 2026?", janelas: ["agosto de 2026"] },
  { texto: "quanto vendi no dia 15/08/2026?", janelas: ["dia 15/08/2026"] },
  { texto: "compare agosto com setembro", janelas: ["agosto de 2026", "setembro de 2026"] },
  // F7b.4.8.5 §14/§20: a frase que o dono vai digitar no teste manual.
  {
    texto: "Quanto vendi em setembro de 2026 no Mercado Livre?",
    janelas: ["setembro de 2026"], exigeOsTres: true,
  },
];

let pass = 0;
let fail = 0;
const abertos: string[] = [];
function ok(nome: string, cond: boolean, detalhe = ""): void {
  if (cond) { pass += 1; console.log(`  PASS  ${nome}`); }
  else { fail += 1; console.log(`  FAIL  ${nome}${detalhe ? `  — ${detalhe}` : ""}`); }
}
function secao(t: string): void { console.log(`\n${t}`); }

/**
 * Todos os numeros que aparecem no texto, em reais.
 *
 * pt-BR: ponto separa milhar, virgula separa centavos. Um numero sem
 * virgula e reais inteiros. Percentuais entram na lista tambem — nao faz
 * mal: a busca e por um valor especifico, e casar por acidente com um
 * percentual exigiria que ele fosse identico ao faturamento.
 */
function numerosNoTexto(texto: string): number[] {
  const achados: number[] = [];
  // O separador de milhar pode vir como espaco NORMAL ou como espaco
  // inquebravel, e a resposta do modelo usa os dois. Normalizar antes
  // evita um caractere invisivel dentro da expressao — a primeira
  // versao trazia um U+00A0 literal na classe, e ninguem o veria.
  const normalizado = texto.replace(new RegExp("\u00a0", "g"), " ");
  for (const m of normalizado.matchAll(/\d[\d. ]*(?:,\d+)?/g)) {
    const cru = m[0].replace(/ /g, "");
    const n = Number(cru.replace(/\./g, "").replace(",", "."));
    if (Number.isFinite(n)) achados.push(n);
  }
  return achados;
}

/**
 * Algum numero do texto cai no intervalo [min, max]?
 *
 * ── Por que intervalo, e nao valor ──────────────────────────────────
 *
 * "Esta semana" e "ultimos 7 dias" terminam HOJE, e a loja vende enquanto
 * o teste roda. Na primeira versao deste oraculo a comparacao era por
 * igualdade, e ela reprovou uma resposta CERTA: o oraculo leu 771 pedidos
 * e R$ 27.438,39, o agente leu 772 e R$ 27.459,58 dezesseis segundos
 * depois. A venda a mais era real.
 *
 * Entao a janela viva e medida DUAS vezes, antes e depois do turno. O
 * valor verdadeiro no instante da leitura do agente esta entre as duas, e
 * e isso que se exige. Janela fechada tem min = max, e ai a exigencia
 * volta a ser igualdade.
 */
function contemNoIntervalo(texto: string, min: number, max: number): boolean {
  const piso = Math.round(min * 100) / 100 - 0.011;
  const teto = Math.round(max * 100) / 100 + 0.011;
  const numeros = numerosNoTexto(texto);
  if (numeros.some((n) => n >= piso && n <= teto)) return true;
  // Muita resposta arredonda para reais inteiros, e isso nao e erro.
  return numeros.some((n) => n >= Math.floor(piso) && n <= Math.ceil(teto)
    && Number.isInteger(n));
}

async function main(): Promise<void> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const chaveDb = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !chaveDb) { console.error("ERRO: env do Supabase."); process.exit(1); }
  if (!process.env.OPENAI_API_KEY || !process.env.OPENAI_MODEL_AGENTE) {
    console.error("ERRO: env da OpenAI. Passe OPENAI_MODEL_AGENTE inline.");
    process.exit(1);
  }
  const db = createClient(url, chaveDb);

  const { emitirTokenSessao, COOKIE_SESSAO } = await import("../lib/autenticacao");
  const { criarPortaDeConversas } = await import("../lib/agentes/conversas/repositorio");
  const { criarLeiturasDeVendasML } = await import("../lib/agentes/dados/vendas-ml");
  const { resolverExpressaoDePeriodo } = await import(
    "../lib/agentes/funcoes/periodo-em-texto");
  const rota = await import(
    "../app/api/agentes/[agenteId]/conversas/[conversaId]/route");

  console.log("══ F7b.4.8.3 §39 — as sete frases na rota real ══");

  // ── Quem e o dono, e qual e o agente dele ─────────────────────────

  secao("A. O caminho real existe");
  const { data: linhaLoja } = await db.from("lojas")
    .select("user_id, ativo, marketplace").eq("id", LOJA_REAL).maybeSingle();
  const loja = linhaLoja as { user_id?: string; ativo?: boolean; marketplace?: string } | null;
  const dono = String(loja?.user_id ?? "");
  ok("A1  a loja autorizada existe e esta ativa", dono !== "" && loja?.ativo === true);
  ok("A2  e ela e do Mercado Livre", loja?.marketplace === "ML", String(loja?.marketplace));
  if (dono === "") { console.log(`\nPASS ${pass}   FAIL ${fail}`); process.exit(1); }

  // O agente do dono que JA pode consultar o Mercado Livre. A suite nao
  // concede permissao nenhuma: se nao houver, ela para e diz.
  const { data: perms } = await db.from("agente_permissoes")
    .select("agente_id, nivel").eq("user_id", dono).eq("funcao_id", FUNCAO_ML);
  const candidatos = ((perms ?? []) as { agente_id: string; nivel: string }[])
    .filter((p) => p.nivel === "automatico");
  ok("A3  ha agente com permissao AUTOMATICA para a consulta",
    candidatos.length >= 1, `${candidatos.length}`);
  if (candidatos.length === 0) { console.log(`\nPASS ${pass}   FAIL ${fail}`); process.exit(1); }

  const { data: ags } = await db.from("agentes")
    .select("id, ativo, provedor_ia")
    .in("id", candidatos.map((c) => c.agente_id)).eq("ativo", true);
  const openai = ((ags ?? []) as { id: string; provedor_ia: string }[])
    .filter((a) => a.provedor_ia === "openai");
  ok("A4  §39: e ele usa OpenAI — o gate nao aceita substituto",
    openai.length >= 1, `openai=${openai.length} de ${(ags ?? []).length}`);
  if (openai.length === 0) { console.log(`\nPASS ${pass}   FAIL ${fail}`); process.exit(1); }
  const agenteId = openai[0].id;

  const portaC = criarPortaDeConversas(db);
  const cookie = `${COOKIE_SESSAO}=${(await emitirTokenSessao(dono)).token}`;
  const criadas: string[] = [];

  async function ler(r: Response) {
    let corpo: Record<string, unknown> = {};
    try { corpo = await r.json() as Record<string, unknown>; } catch { /* vazio */ }
    return { status: r.status, corpo };
  }
  const enviar = async (cid: string, texto: string, envioId: string) =>
    ler(await rota.POST(
      new Request(`http://local/api/agentes/${agenteId}/conversas/${cid}`, {
        method: "POST", headers: { cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ texto, envioId }),
      }), { params: { agenteId, conversaId: cid } }));

  /** O total da janela pela fonte deterministica — o oraculo. */
  const totalDa = async (expressao: string) => {
    const r = await criarLeiturasDeVendasML(dono, LOJA_REAL, Date.now())(
      { periodo: expressao });
    return r;
  };

  /** Hoje no fuso de Sao Paulo. Janela que termina daqui para a frente
   *  ainda esta recebendo venda, e nao pode ser exigida por igualdade. */
  const hojeBRT = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString().slice(0, 10);

  // `FRASES=5,7` roda so aquelas — a lista inteira custa duas varreduras
  // de mes por frase comparativa, e reinvestigar uma delas nao precisa
  // repetir as outras seis.
  const filtro = (process.env.FRASES ?? "").trim() === ""
    ? null
    : new Set((process.env.FRASES as string).split(",").map((n) => Number(n.trim())));

  try {
    // ── B. O oraculo: cada janela, pela fonte oficial ───────────────

    secao("B. As janelas, pela fonte deterministica");
    const esperado = new Map<string, {
      total: number; pedidos: number; unidades: number; de: string; ate: string;
    }>();
      // So as janelas das frases que vao rodar: medir uma janela de mes
    // que ninguem vai perguntar e custo sem prova.
    const janelas = [...new Set(FRASES
      .filter((_, i) => filtro === null || filtro.has(i + 1))
      .flatMap((f) => f.janelas))];
    for (const j of janelas) {
      const alvo = resolverExpressaoDePeriodo(j, Date.now());
      const r = await totalDa(j);
      const bom = r.erro === null && r.completo === true && r.vendasBrutas !== null
        && alvo !== null;
      ok(`B  "${j}" -> ${alvo?.de}..${alvo?.ate}`, bom,
        `erro=${String(r.erro)} completo=${String(r.completo)}`);
      if (bom && r.vendasBrutas !== null && alvo !== null) {
        esperado.set(j, {
          total: r.vendasBrutas.valor, pedidos: r.vendasBrutas.vendas,
          unidades: r.vendasBrutas.unidades, de: alvo.de, ate: alvo.ate,
        });
        console.log(`       ${r.vendasBrutas.vendas} vendas, ${r.vendasBrutas.unidades} unidades, ` +
          `vendas brutas ${r.vendasBrutas.valor.toFixed(2)}`);
      }
    }

    // CONTROLE de anti-vacuidade: as janelas tem totais DIFERENTES. Sem
    // isso, "o numero aparece no texto" poderia estar casando com
    // qualquer coisa.
    const totais = [...esperado.values()].map((e) => e.total);
    ok("B0  CONTROLE: as janelas nao tem todas o mesmo total",
      new Set(totais.map((t) => t.toFixed(2))).size === totais.length,
      totais.map((t) => t.toFixed(2)).join(" | "));

    // ── C. As sete frases, uma conversa nova para cada ──────────────

    for (let i = 0; i < FRASES.length; i += 1) {
      if (filtro !== null && !filtro.has(i + 1)) continue;
      const frase = FRASES[i];
      secao(`C${i + 1}. "${frase.texto}"`);

      // Conversa nova por frase: assim o modelo nao herda o numero da
      // anterior e ter de consultar de novo.
      const c = await portaC.criarConversa(dono, agenteId, null);
      criadas.push(c.id);

      const t0 = Date.now();
      const r = await enviar(c.id, frase.texto, `f4883-39-${i}`);
      const ms = Date.now() - t0;
      ok(`C${i + 1}a a rota responde 200`, r.status === 200,
        `${r.status} ${String(r.corpo.motivo)}`);
      const resposta = r.corpo.resposta as
        { conteudo?: string; passos?: { funcaoId: string; desfecho: string; executou: boolean }[] }
        | null | undefined;
      const texto = resposta?.conteudo ?? "";
      ok(`C${i + 1}b com resposta em texto`, texto.trim() !== "", `${texto.length} chars`);
      console.log(`       ${ms}ms — ${texto.replace(/\s+/g, " ").slice(0, 220)}`);

      // A ferramenta rodou, e rodou bem.
      const passos = resposta?.passos ?? [];
      const doML = passos.filter((p) => p.funcaoId === FUNCAO_ML);
      ok(`C${i + 1}c §36: a consulta oficial foi CHAMADA`,
        doML.length >= 1, `passos=${JSON.stringify(passos.map((p) => p.funcaoId))}`);
      // `sucesso` e o literal que `laco-ferramentas.ts` grava no passo —
      // MEDIDO, nao suposto: a primeira versao deste oraculo esperava
      // "ok" e reprovou um turno que tinha funcionado.
      ok(`C${i + 1}d e executou com desfecho de sucesso`,
        doML.length >= 1 && doML.every((p) => p.executou && p.desfecho === "sucesso"),
        doML.map((p) => `${p.desfecho}/${p.executou}`).join(" "));
      ok(`C${i + 1}e §37: ${frase.janelas.length} janela(s) -> ${frase.janelas.length} chamada(s)`,
        doML.length >= frase.janelas.length, `${doML.length}`);

      // ── O numero que a pessoa le e o numero da fonte ─────────────
      //
      // Janela viva e relida AGORA: o valor no instante da leitura do
      // agente esta entre a medicao de antes e a de depois.
      const falhasAntes = fail;
      const faixas = new Map<string, { min: number; max: number }>();
      for (const j of frase.janelas) {
        const e = esperado.get(j);
        if (e === undefined) {
          abertos.push(`C${i + 1}: janela "${j}" sem oraculo`);
          ok(`C${i + 1}f "${j}": sem oraculo — nao da para afirmar`, false);
          continue;
        }
        let min = e.total;
        let max = e.total;
        if (e.ate >= hojeBRT) {
          const agora = await totalDa(j);
          if (agora.erro === null && agora.completo === true && agora.vendasBrutas !== null) {
            min = Math.min(min, agora.vendasBrutas.valor);
            max = Math.max(max, agora.vendasBrutas.valor);
          }
        }
        faixas.set(j, { min, max });
        const viva = e.ate >= hojeBRT ? " (janela viva)" : "";
        ok(`C${i + 1}f §38: o faturamento de "${j}" aparece no texto`,
          contemNoIntervalo(texto, min, max),
          `esperado ${min.toFixed(2)}..${max.toFixed(2)}${viva}`);

        // ── F7b.4.8.5 §14: os TRES numeros, e nao so o dinheiro ─────
        //
        // Venda e unidade sao contagens diferentes, e o painel do Mercado
        // Livre mostra as duas. Uma resposta que diga "11.361 vendas" num
        // mes de 10.898 esta errada sem parecer errada.
        if (frase.exigeOsTres === true) {
          ok(`C${i + 1}f1 §14: a QUANTIDADE de vendas aparece`,
            contemNoIntervalo(texto, e.pedidos, e.pedidos),
            `esperado ${e.pedidos}`);
          ok(`C${i + 1}f2 §14: e a de UNIDADES tambem`,
            contemNoIntervalo(texto, e.unidades, e.unidades),
            `esperado ${e.unidades}`);
          ok(`C${i + 1}f3 ANCORA: as duas contagens sao DIFERENTES`,
            e.unidades !== e.pedidos, `${e.unidades} vs ${e.pedidos}`);
          ok(`C${i + 1}f4 §14: e a resposta NAO cita o Dashboard nem a tabela da CDS`,
            !/dashboard|tabela de pedidos|vendas registradas na cds/i.test(texto));
        }
      }

      // §38: comparacao exige a diferenca, e ela tambem vem da fonte.
      if (frase.janelas.length === 2) {
        const a = faixas.get(frase.janelas[0]);
        const b = faixas.get(frase.janelas[1]);
        if (a !== undefined && b !== undefined) {
          // A diferenca de dois intervalos e um intervalo, e a resposta
          // certa esta nele. Em modulo, porque o texto pode dizer "caiu
          // R$ X" em vez de "-X".
          const difMin = a.min - b.max;
          const difMax = a.max - b.min;
          const cantos = [difMin, difMax].map(Math.abs);
          ok(`C${i + 1}g a diferenca em reais aparece`,
            contemNoIntervalo(texto, Math.min(...cantos), Math.max(...cantos)),
            `esperado ${Math.min(...cantos).toFixed(2)}..${Math.max(...cantos).toFixed(2)}`);

          // ── As DUAS bases valem ───────────────────────────────────
          //
          // Uma variacao percentual entre dois valores tem dois
          // denominadores legitimos. A primeira versao deste oraculo fixou
          // um e reprovou uma resposta certa: o modelo disse "+17,22%"
          // (sobre agosto, a base natural de "de agosto para setembro") e
          // o oraculo exigia 14,69% (sobre setembro).
          //
          // Exigir uma base seria exigir uma redacao, e nao um numero.
          //
          // Cada base e um intervalo PROPRIO, e basta um deles casar.
          // Aceitar o vao inteiro entre as duas bases seria aceitar
          // qualquer percentual no meio, e ai a sonda nao provaria nada.
          const bases = [a, b].filter((x) => x.min !== 0 && x.max !== 0);
          const faixasPct = bases.map((base) => {
            const cantos = [
              Math.abs((difMin / base.max) * 100),
              Math.abs((difMax / base.min) * 100),
            ];
            return { min: Math.min(...cantos), max: Math.max(...cantos) };
          });
          ok(`C${i + 1}h e a diferenca em porcentagem tambem`,
            faixasPct.length === 0 ||
              faixasPct.some((f) => contemNoIntervalo(texto, f.min, f.max)),
            `esperado ${faixasPct.map((f) => `${f.min.toFixed(2)}..${f.max.toFixed(2)}`).join(" ou ")}%`);
        }
      }

      // Valor que nao bate exige o texto INTEIRO. Com 220 caracteres nao
      // se distingue "o modelo errou a conta" de "o meu leitor de numero
      // nao entende a formatacao dele" — e da primeira vez essa diferenca
      // custou uma investigacao.
      if (fail > falhasAntes) {
        console.log(`       ── resposta completa ──\n${texto}\n       ──────`);
      }

      // §12: um numero sem cobertura seria pior que nenhum. Se a
      // varredura nao completasse, o texto nao poderia trazer total.
      ok(`C${i + 1}i e a resposta NAO diz que nao conseguiu`,
        !/n[ãa]o (foi poss[íi]vel|consegui)/i.test(texto), texto.slice(0, 120));
    }

  } catch (erro) {
    fail += 1;
    console.log(`  ERRO  ${erro instanceof Error ? erro.message : String(erro)}`);
  } finally {
    secao("Limpeza — so as conversas desta suite");
    for (const id of criadas) {
      await db.from("agente_conversas").delete().eq("id", id).eq("user_id", dono);
    }
    const { count } = await db.from("agente_conversas")
      .select("id", { count: "exact", head: true }).in("id", criadas.length ? criadas : ["-"]);
    ok("Z1  nenhuma conversa desta suite sobrou", (count ?? 0) === 0, String(count));
    if (abertos.length > 0) console.log(`\nABERTOS: ${abertos.join(" | ")}`);
    console.log(`\nPASS ${pass}   FAIL ${fail}`);
    process.exit(fail === 0 ? 0 : 1);
  }
}

void main();
