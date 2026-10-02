/**
 * CDS IA — F8.1-B4A: contrato de APRESENTACAO estruturada de vendas ML.
 *
 * Prova que os quatro agregados e o periodo que o runtime do Mercado
 * Livre JA calculou:
 *
 *   sao criados  (laco, so em sucesso completo de `mercadolivre.vendas.consultar`)
 *   persistem    (repositorio REAL, `passos` jsonb simulado por JSON)
 *   sao relidos  (repositorio REAL)
 *   chegam validados ao frontend (`lerConversaDoChat` REAL, fetch stubado)
 *
 * e que NADA alem deles atravessa: nem `porDia`, nem `diagnostico`, nem o
 * `data` inteiro da Tool. Os valores das fixtures sao sinteticos.
 *
 * Sem rede, sem banco, sem IA. Rodar:
 *   npx tsx scripts/testar-apresentacao-vendas-ml.ts
 */
import "./_env-inerte";
import "./_server-only-inerte";

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { declararFerramentas } from "@/lib/agentes/ia/ferramentas";
import { criarAdaptadorFakeComFerramentas } from "@/lib/agentes/ia/ferramentas-fake";
import { conversarComFerramentas, type PassoDeFerramenta } from "@/lib/agentes/ia/laco-ferramentas";
import { FUNCOES } from "@/lib/agentes/funcoes/registry";
import { interpretarSaidaVendasML } from "@/lib/agentes/funcoes/mercadolivre-vendas";
import {
  apresentacaoDoPasso, FUNCAO_VENDAS_ML, type PassoRegistrado,
} from "@/lib/agentes/conversas/tipos";
import { criarPortaDeConversas } from "@/lib/agentes/conversas/repositorio";
import { dataDoEnvelope } from "@/lib/agentes/conversas/retomada";
import { lerConversaDoChat } from "@/lib/ia/agentes-http";

let passou = 0;
let falhou = 0;
const ok = (nome: string, cond: boolean, det = ""): void => {
  if (cond) { passou += 1; console.log(`  PASS  ${nome}`); }
  else { falhou += 1; console.log(`  FAIL  ${nome}${det ? `  — ${det}` : ""}`); }
};
const secao = (t: string) =>
  console.log(`\n── ${t} ${"─".repeat(Math.max(2, 58 - t.length))}`);

const RAIZ = join(__dirname, "..");
const ler = (rel: string) => readFileSync(join(RAIZ, rel), "utf8").replace(/\r\n/g, "\n");

const DONO = "11111111-1111-4111-8111-111111111111";
const AGENTE = "22222222-2222-4222-8222-222222222222";
const CONVERSA = "33333333-3333-4333-8333-333333333333";

// ── Fixtures: a SAIDA BRUTA do runtime ML, passada pelo interpretador ──
//
// O `data` do envelope de sucesso e exatamente o que `interpretarSaida`
// devolve. Montar a fixture pelo interpretador garante que o teste usa a
// forma REAL, e nao uma forma imaginada.

const BRUTAS = { valor: 1234.56, vendas: 7, unidades: 9, ticketMedio: 176.37 };
const PERIODO = { de: "2026-09-01", ate: "2026-09-30", rotulo: "setembro", fuso: "America/Sao_Paulo" };

function saidaBruta(completo: boolean): Record<string, unknown> {
  return {
    vendasBrutas: completo ? BRUTAS : null,
    porDia: completo ? [{ dia: "2026-09-02", valor: 100, vendas: 1, unidades: 1 }] : [],
    periodo: PERIODO,
    fonte: "mercadolivre_api",
    completo,
    truncado: !completo,
    parcial: null,
    diagnostico: {
      paginasLidas: 1, recebidosDoProvider: 7, foraDoPeriodo: 0,
      duplicadosDescartados: 0, excluidosPackSplitted: 0,
      divergenciasDeValor: 0, campoDeData: "order.date_closed",
    },
    erro: null,
  };
}

function dataInterpretado(completo: boolean): unknown {
  const l = interpretarSaidaVendasML(saidaBruta(completo));
  if (l.tipo !== "sucesso") throw new Error(`fixture invalida: ${l.tipo}`);
  return l.data;
}

/** Porta de execucao roteirizada: o lugar do guard nos testes. */
function porta(resposta: Record<string, unknown>) {
  return (async () => ({ requestId: "req-1", ...resposta })) as never;
}

const FERRAMENTAS = declararFerramentas({
  catalogo: FUNCOES,
  permissoes: [
    { funcaoId: FUNCAO_VENDAS_ML, nivel: "automatico" },
    { funcaoId: "vendas.consultar", nivel: "automatico" },
  ],
});

async function umPasso(funcaoId: string, resposta: Record<string, unknown>): Promise<PassoDeFerramenta> {
  const r = await conversarComFerramentas({
    userId: DONO, agenteId: AGENTE, instrucao: "i", mensagemDoUsuario: "Quanto vendi?",
    ferramentas: FERRAMENTAS,
    adaptador: criarAdaptadorFakeComFerramentas([
      { tipo: "pede", pedidos: [{ nome: funcaoId, argumentos: {} }] },
      { tipo: "fala", texto: "ok" },
    ]),
    executar: porta(resposta),
  });
  const p = r.passos[0];
  if (p === undefined) throw new Error("o laco nao registrou passo");
  return p;
}

/** O mapeamento de `runtime.ts` — conferido contra a fonte em E2. */
function paraRegistrado(p: PassoDeFerramenta): PassoRegistrado {
  return {
    funcaoId: p.funcaoId, desfecho: p.desfecho, executou: p.executou, requestId: p.requestId,
    ...(p.aprovacaoId === undefined ? {} : { aprovacaoId: p.aprovacaoId }),
    ...(p.apresentacao === undefined ? {} : { apresentacao: p.apresentacao }),
  };
}

// ── Supabase FALSO em memoria — so o que o repositorio de conversas usa ─
//
// `insert` guarda a linha passada por JSON (e o que `jsonb` faz: o objeto
// volta como dado, nunca como referencia). `select` devolve copias.

type Linha = Record<string, unknown>;
function supabaseFalso() {
  const tabelas: Record<string, Linha[]> = {};
  let seq = 0;
  const from = (tabela: string) => {
    const linhas = (tabelas[tabela] ??= []);
    let filtros: [string, unknown][] = [];
    let inserida: Linha | null = null;
    let modo: "select" | "insert" | "update" = "select";
    const filtradas = () =>
      linhas.filter((l) => filtros.every(([c, v]) => l[c] === v))
        .sort((a, b) => Number(a.ordem ?? 0) - Number(b.ordem ?? 0))
        .map((l) => JSON.parse(JSON.stringify(l)) as Linha);
    const q: Record<string, unknown> = {
      select: () => q,
      eq: (c: string, v: unknown) => { filtros = [...filtros, [c, v]]; return q; },
      order: () => q,
      limit: () => q,
      insert: (l: Linha) => {
        modo = "insert";
        seq += 1;
        inserida = JSON.parse(JSON.stringify({
          id: `msg-${seq}`, criado_em: "2026-10-01T12:00:00.000Z", ...l,
        })) as Linha;
        linhas.push(inserida);
        return q;
      },
      update: () => { modo = "update"; return q; },
      single: async () => ({ data: JSON.parse(JSON.stringify(inserida)), error: null }),
      maybeSingle: async () => {
        const todas = filtradas();
        return { data: todas.length ? todas[todas.length - 1] : null, error: null };
      },
      then: (res: (v: unknown) => unknown) =>
        res(modo === "select" ? { data: filtradas(), error: null } : { data: null, error: null }),
    };
    return q;
  };
  return { from } as never;
}

/** A forma de `paraUI` da rota GET — conferida contra a fonte em G1. */
function corpoDaRota(mensagens: readonly { id: string; papel: string; conteudo: string;
  criadoEm: string; passos: readonly PassoRegistrado[] | null; modelo: string | null }[]) {
  return {
    ok: true,
    mensagens: mensagens.map((m) => ({
      id: m.id, papel: m.papel, conteudo: m.conteudo, criadoEm: m.criadoEm,
      passos: m.passos ?? [], modelo: m.modelo, uso: null,
    })),
  };
}

function comFetch<T>(corpo: unknown, f: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify(corpo), {
    status: 200, headers: { "content-type": "application/json" },
  })) as typeof fetch;
  return f().finally(() => { globalThis.fetch = original; });
}

async function main(): Promise<void> {
  console.log("\n══ CDS IA — F8.1-B4A: apresentacao estruturada de vendas ML ══");

  // =====================================================================
  secao("A. Execucao ML completa: o passo carrega a apresentacao");
  const completo = await umPasso(FUNCAO_VENDAS_ML, {
    tipo: "sucesso", envelope: { ok: true, data: dataInterpretado(true) },
  });
  const ap = completo.apresentacao;
  ok("A1  apresentacao.tipo = vendas_ml", ap?.tipo === "vendas_ml", JSON.stringify(ap));
  ok("A2  valor copiado exatamente", ap?.valor === BRUTAS.valor);
  ok("A3  vendas copiado exatamente", ap?.vendas === BRUTAS.vendas);
  ok("A4  unidades copiado exatamente", ap?.unidades === BRUTAS.unidades);
  ok("A5  ticketMedio copiado do runtime, NAO recalculado",
    ap?.ticketMedio === BRUTAS.ticketMedio &&
      ap?.ticketMedio !== BRUTAS.valor / BRUTAS.vendas,
    `${ap?.ticketMedio} vs valor/vendas=${BRUTAS.valor / BRUTAS.vendas}`);
  ok("A6  periodo copiado exatamente (de/ate)",
    ap?.periodo.de === PERIODO.de && ap?.periodo.ate === PERIODO.ate);
  ok("A7  so as chaves allowlisted — nada de porDia/diagnostico/fonte/rotulo",
    JSON.stringify(Object.keys(ap ?? {}).sort()) ===
      JSON.stringify(["periodo", "ticketMedio", "tipo", "unidades", "valor", "vendas"]) &&
      JSON.stringify(Object.keys(ap?.periodo ?? {}).sort()) === JSON.stringify(["ate", "de"]),
    JSON.stringify(ap));
  ok("A8  o passo continua com o resto intacto",
    completo.desfecho === "sucesso" && completo.executou === true && completo.requestId === "req-1");

  // =====================================================================
  secao("B. Quando NAO ha apresentacao");
  const incompleto = await umPasso(FUNCAO_VENDAS_ML, {
    tipo: "sucesso", envelope: { ok: true, data: dataInterpretado(false) },
  });
  ok("B1  consulta incompleta (completo=false, vendasBrutas=null): ausente",
    incompleto.desfecho === "sucesso" && !("apresentacao" in incompleto));

  const erro = await umPasso(FUNCAO_VENDAS_ML, { tipo: "erro", codigo: "credencial_ausente" });
  ok("B2  erro: ausente", erro.desfecho === "erro" && !("apresentacao" in erro), erro.desfecho);

  const pendente = await umPasso(FUNCAO_VENDAS_ML, {
    tipo: "aguardando_aprovacao", aprovacaoId: "apr-1",
  });
  ok("B3  aprovacao pendente: ausente",
    pendente.desfecho === "aguardando_aprovacao" && !("apresentacao" in pendente));

  const outra = await umPasso("vendas.consultar", {
    tipo: "sucesso", envelope: { ok: true, data: dataInterpretado(true) },
  });
  ok("B4  Tool diferente (mesmo data!): ausente",
    outra.desfecho === "sucesso" && !("apresentacao" in outra));

  const torto = { ...(dataInterpretado(true) as Record<string, unknown>),
    vendasBrutas: { ...BRUTAS, valor: "1234,56" } };
  ok("B5  resultado malformado: null", apresentacaoDoPasso(FUNCAO_VENDAS_ML, torto) === null);
  ok("B6  vendasBrutas null com completo=true: null",
    apresentacaoDoPasso(FUNCAO_VENDAS_ML, { ...(torto), vendasBrutas: null }) === null);
  ok("B7  periodo vazio: null",
    apresentacaoDoPasso(FUNCAO_VENDAS_ML,
      { ...(dataInterpretado(true) as object), periodo: { de: "", ate: "" } }) === null);
  ok("B8  data nao-objeto: null", apresentacaoDoPasso(FUNCAO_VENDAS_ML, "x") === null);

  // =====================================================================
  secao("C. Persistir e reler (repositorio REAL, jsonb simulado)");
  const db = supabaseFalso();
  const repo = criarPortaDeConversas(db);
  await repo.anexarMensagem({
    userId: DONO, conversaId: CONVERSA, papel: "usuario", conteudo: "Quanto vendi?",
  });
  await repo.anexarMensagem({
    userId: DONO, conversaId: CONVERSA, papel: "assistente", conteudo: "Voce vendeu.",
    passos: [paraRegistrado(completo)],
  });
  const relidas = await repo.listarMensagens(DONO, CONVERSA);
  const passoRelido = relidas[1]?.passos?.[0];
  ok("C1  apresentacao sobrevive ao round-trip",
    JSON.stringify(passoRelido?.apresentacao) === JSON.stringify(ap),
    JSON.stringify(passoRelido));
  const gravado = JSON.stringify(relidas);
  ok("C2  nada de porDia/diagnostico/order/buyer no que foi persistido",
    !/porDia|diagnostico|order_items|buyer|seller|date_closed|recebidosDoProvider/.test(gravado));

  // =====================================================================
  secao("D. Retomada depois de aprovacao: mesmo contrato");
  // A forma de `retomarAprovacao` em sucesso: o MESMO envelope da
  // execucao direta (`executarComAberturaFeita`).
  const execucao = {
    tipo: "sucesso", requestId: "req-2",
    envelope: { contrato: "v1", ok: true, request_id: "req-2", data: dataInterpretado(true) },
  };
  const apRetomada = apresentacaoDoPasso(FUNCAO_VENDAS_ML, dataDoEnvelope(execucao));
  ok("D1  retomada produz a MESMA apresentacao da execucao direta",
    JSON.stringify(apRetomada) === JSON.stringify(ap));
  ok("D2  envelope de erro nao produz apresentacao",
    apresentacaoDoPasso(FUNCAO_VENDAS_ML,
      dataDoEnvelope({ tipo: "erro", envelope: { ok: false, error: {} } })) === null);
  await repo.anexarMensagem({
    userId: DONO, conversaId: CONVERSA, papel: "assistente", conteudo: "Aprovado.",
    passos: [{ funcaoId: FUNCAO_VENDAS_ML, desfecho: "sucesso", executou: true,
      requestId: "req-2", ...(apRetomada === null ? {} : { apresentacao: apRetomada }) }],
  });
  const aposRetomada = await repo.listarMensagens(DONO, CONVERSA);
  ok("D3  a apresentacao da retomada sobrevive ao round-trip",
    JSON.stringify(aposRetomada[2]?.passos?.[0]?.apresentacao) === JSON.stringify(ap));

  const RETOMADA = ler("lib/agentes/conversas/retomada.ts");
  ok("D4  FONTE: retomada usa o extrator unico sobre o data do envelope",
    /apresentacaoDoPasso\(aprovacao\.funcaoId, dataDoEnvelope\(execucao\)\)/.test(RETOMADA));
  ok("D5  FONTE: so quando executou",
    /const apresentacao = executou\s*\?\s*apresentacaoDoPasso/.test(RETOMADA));
  ok("D6  FONTE: o passo persistido da retomada espalha a apresentacao",
    /requestId: \(execucao as \{ requestId\?: string \}\)\.requestId \?\? null,\n\s*\.\.\.\(apresentacao === null \? \{\} : \{ apresentacao \}\),/
      .test(RETOMADA));

  // =====================================================================
  secao("E. Fonte do caminho normal");
  const RUNTIME = ler("lib/agentes/conversas/runtime.ts");
  ok("E1  FONTE: laco cria pelo extrator unico, so no ramo de sucesso",
    /const apresentacao = apresentacaoDoPasso\(pedido\.nome, data\);/
      .test(ler("lib/agentes/ia/laco-ferramentas.ts")));
  ok("E2  FONTE: runtime repassa sem recalcular",
    /\.\.\.\(p\.apresentacao === undefined \? \{\} : \{ apresentacao: p\.apresentacao \}\),/
      .test(RUNTIME));
  const TIPOS = ler("lib/agentes/conversas/tipos.ts");
  ok("E3  FONTE: o extrator monta o objeto chave a chave (sem spread do data)",
    /return \{ tipo: "vendas_ml", valor, vendas, unidades, ticketMedio, periodo: \{ de, ate \} \};/
      .test(TIPOS) && !/\.\.\.saida|\.\.\.brutas|\.\.\.data/.test(TIPOS));
  // So o CORPO do extrator: o comentario do tipo cita `valor/vendas` para
  // documentar a semantica do runtime, e isso nao e conta.
  const iExtrator = TIPOS.indexOf("export function apresentacaoDoPasso(");
  const corpoExtrator = TIPOS.slice(iExtrator, TIPOS.indexOf("\n}\n", iExtrator));
  ok("E4  FONTE: o extrator nao faz conta (sem / * + - sobre os agregados)",
    iExtrator > 0 && corpoExtrator.length > 200 &&
      !/(valor|vendas|unidades|ticketMedio)\s*[-+*/]|[-+*/]\s*(valor|vendas|unidades|ticketMedio)\b/
        .test(corpoExtrator),
    corpoExtrator.length.toString());

  // =====================================================================
  secao("F. Parser do frontend (lerConversaDoChat REAL)");
  const corpo = corpoDaRota(aposRetomada);
  const lida = await comFetch(corpo, () => lerConversaDoChat(AGENTE, CONVERSA));
  const pUI = lida.estado === "ok" ? lida.dados.mensagens[1]?.passos[0] : undefined;
  ok("F1  aceita apresentacao valida", lida.estado === "ok" &&
    JSON.stringify(pUI?.apresentacao) === JSON.stringify(ap), JSON.stringify(pUI));
  ok("F2  passo sem apresentacao vira `null`, e a mensagem continua valida",
    lida.estado === "ok" && lida.dados.mensagens[0]?.passos.length === 0);

  const semCampo = corpoDaRota([{ ...aposRetomada[1], passos: [{
    funcaoId: "vendas.consultar", desfecho: "sucesso", executou: true, requestId: null }] }]);
  const lidaSem = await comFetch(semCampo, () => lerConversaDoChat(AGENTE, CONVERSA));
  ok("F3  apresentacao AUSENTE e aceita como null",
    lidaSem.estado === "ok" && lidaSem.dados.mensagens[0]?.passos[0]?.apresentacao === null);

  const tortos: [string, unknown][] = [
    ["tipo desconhecido", { ...ap, tipo: "vendas_shopee" }],
    ["valor string", { ...ap, valor: "1234.56" }],
    ["vendas NaN", { ...ap, vendas: Number.NaN }],
    ["unidades ausente", { ...ap, unidades: undefined }],
    ["ticketMedio Infinity", { ...ap, ticketMedio: Number.POSITIVE_INFINITY }],
    ["periodo ausente", { ...ap, periodo: undefined }],
    ["periodo.de numero", { ...ap, periodo: { de: 1, ate: "2026-09-30" } }],
    ["apresentacao string", "vendas_ml"],
  ];
  for (const [rotulo, apTorta] of tortos) {
    // JSON.stringify transforma NaN/Infinity em null — que tambem precisa
    // reprovar. Montado a mao para nao depender do que a fixture e.
    const c = corpoDaRota([{ ...aposRetomada[1], passos: [{
      funcaoId: FUNCAO_VENDAS_ML, desfecho: "sucesso", executou: true, requestId: null,
      apresentacao: apTorta as never }] }]);
    const r = await comFetch(c, () => lerConversaDoChat(AGENTE, CONVERSA));
    ok(`F4  rejeita apresentacao malformada: ${rotulo}`, r.estado === "falha", r.estado);
  }

  // =====================================================================
  secao("G. A rota GET devolve `passos` inteiro");
  ok("G1  FONTE: paraUI repassa m.passos sem remapear campo a campo",
    /passos: m\.passos \?\? \[\],/.test(ler("app/api/agentes/[agenteId]/conversas/[conversaId]/route.ts")));

  console.log(`\n── placar ${"─".repeat(50)}\n  PASS ${passou}   FAIL ${falhou}\n`);
  if (falhou > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
