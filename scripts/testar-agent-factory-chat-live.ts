/**
 * AGENT-FACTORY-F7b §1 — UM turno REAL pelo runtime novo.
 *
 * ── Esta suite VAI A REDE, GASTA CREDITO E ESCREVE EM PRODUCAO ──────
 *
 * Ela existe para fechar uma pergunta que nenhum teste sem rede
 * responde: `responderNaConversa` funciona de ponta a ponta contra a
 * Anthropic de verdade?
 *
 * O caminho exercitado e o inteiro:
 *
 *   fixture (dono + agente + permissao)
 *     -> conversa criada
 *     -> mensagem do usuario PERSISTIDA
 *     -> contexto montado (F6)
 *     -> Anthropic real
 *     -> pedido de ferramenta
 *     -> guard
 *     -> calculadora.calcular
 *     -> resultado de volta ao provedor
 *     -> resposta final
 *     -> mensagem do assistente PERSISTIDA
 *
 * Nao roda em varredura nenhuma. E invocada a mao, num gate que
 * autoriza o custo, e apaga tudo no fim — inclusive quando um assert
 * falha, porque o cleanup vive no `finally`.
 *
 * NAO toca o Agente de Mensagens: o dono e sintetico e o agente e
 * criado e destruido aqui.
 *
 * Rodar:
 *   ANTHROPIC_MODEL_AGENTE=claude-haiku-4-5 \
 *   npx tsx scripts/testar-agent-factory-chat-live.ts
 */
import "./_server-only-inerte";

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { criarPortaDeConversas } from "@/lib/agentes/conversas/repositorio";
import { responderNaConversa } from "@/lib/agentes/conversas/runtime";

const RAIZ = join(__dirname, "..");

const PREFIXO = "FIXTURE-CHATLIVE";
const DONO = `${PREFIXO}-DONO`;
const AGENTE = "c7b00000-0000-4000-8000-000000000001";
const ID_CALC = "calculadora.calcular";

// A conta: 1500 - 275 = 1225. O modelo acerta de cabeca — e e
// justamente por isso que ela serve: o que se prova aqui NAO e que o
// numero apareceu, e que ele veio da FERRAMENTA.
const ESPERADO = "1225";

// ─── Saida sem segredo ────────────────────────────────────────────────
function valoresSensiveis(): string[] {
  const fora: string[] = [];
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v !== "string" || v.length < 12) continue;
    if (/KEY|SECRET|TOKEN|PASSWORD|SENHA|CREDENTIAL|AUTH/i.test(k)) fora.push(v);
  }
  return fora;
}
let SENSIVEIS: string[] = [];
function limpar(t: string): string {
  let s = t;
  for (const v of SENSIVEIS) s = s.split(v).join("«REDIGIDO»");
  return s.replace(/eyJ[A-Za-z0-9_-]{20,}/g, "«REDIGIDO»")
          .replace(/sk-ant-[A-Za-z0-9_-]{8,}/g, "«REDIGIDO»");
}
function log(...p: unknown[]): void {
  console.log(limpar(p.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")));
}

let passou = 0;
let falhou = 0;
function ok(nome: string, cond: boolean, detalhe?: string): void {
  if (cond) { passou += 1; log(`  PASS  ${nome}`); }
  else { falhou += 1; log(`  FAIL  ${nome}${detalhe ? ` — ${detalhe}` : ""}`); }
}
function secao(t: string): void {
  log(`\n── ${t} ${"─".repeat(Math.max(2, 56 - t.length))}`);
}

function carregarEnvLocal(): void {
  for (const caminho of [
    join(RAIZ, ".env.local"),
    join("C:", "Users", "USER", "Desktop", "calculadora-dos-sellers-v1", ".env.local"),
  ]) {
    try {
      for (const linha of readFileSync(caminho, "utf-8").split("\n")) {
        const l = linha.trim();
        if (!l || l.startsWith("#")) continue;
        const i = l.indexOf("=");
        if (i === -1) continue;
        const k = l.slice(0, i).trim();
        let v = l.slice(i + 1).trim();
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
          v = v.slice(1, -1);
        }
        if (!(k in process.env)) process.env[k] = v;
      }
      return;
    } catch { /* tenta o proximo */ }
  }
}

/**
 * Limpa o que a APLICACAO pode limpar.
 *
 * ── O que ela NAO pode, e por que isso esta certo ───────────────────
 *
 * `agente_funcao_chamadas` e APPEND-ONLY para a aplicacao: medido, nao
 * suposto — `service_role` tem INSERT, SELECT, REFERENCES e TRIGGER, e
 * NAO tem DELETE nem UPDATE. Isso e a garantia de que auditoria de
 * execucao nao desaparece, e ela vale tambem para um teste.
 *
 * E a FK dessa tabela para `agentes` e ON DELETE RESTRICT. Somando os
 * dois: um agente que EXECUTOU uma Funcao de verdade nao pode ser
 * apagado pela aplicacao. Nunca.
 *
 * A primeira versao deste script tentava apagar o agente e falhava
 * calada. A segunda passou a checar o erro — e o erro revelou a causa.
 * Esta versao para de tentar:
 *
 *   conversas, mensagens, permissoes  -> apagadas (a aplicacao pode)
 *   agente + suas linhas de auditoria -> FICAM, e isso e correto
 *
 * Por isso o agente tem id FIXO: rodar dez vezes deixa UM agente
 * sintetico, e nao dez. Ele nasce e continua `ativo = false`, com dono
 * que nao existe em `perfil`, entao nao aparece para ninguem e nao
 * executa nada sozinho.
 *
 * Remover de vez exige papel privilegiado (`postgres`), que a aplicacao
 * nao tem e nao deve ter. Fica registrado no relatorio em vez de
 * escondido num delete que falha.
 */
async function limparOQuePodemos(db: SupabaseClient): Promise<string> {
  const partes: string[] = [];
  for (const [tabela, rotulo] of [
    ["agente_conversas", "conversas"],
    ["agente_permissoes", "permissoes"],
  ] as [string, string][]) {
    const { count, error } = await db.from(tabela)
      .delete({ count: "exact" }).like("user_id", `${PREFIXO}%`);
    partes.push(error
      ? `${rotulo}: ERRO (${String(error.message).slice(0, 50)})`
      : `${count ?? 0} ${rotulo}`);
  }
  // O agente NAO e apagado. Garantimos que ele continua INATIVO, que e
  // a propriedade que importa: ele nao roda, nao aparece, nao decide.
  const { error: eU } = await db.from("agentes")
    .update({ ativo: false }).like("user_id", `${PREFIXO}%`);
  partes.push(eU ? `agente: ERRO ao inativar` : "agente mantido INATIVO");
  return partes.join(", ");
}

async function main(): Promise<void> {
  carregarEnvLocal();
  SENSIVEIS = valoresSensiveis();

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const chave = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !chave) {
    console.error("ERRO: env do Supabase ausente.");
    process.exit(1);
  }
  if (!process.env.ANTHROPIC_API_KEY || !process.env.ANTHROPIC_MODEL_AGENTE?.trim()) {
    console.error("ERRO: ANTHROPIC_API_KEY / ANTHROPIC_MODEL_AGENTE ausentes.");
    process.exit(1);
  }
  const db = createClient(url, chave);
  const portaC = criarPortaDeConversas(db);

  log("\n══ F7b §1 — UM turno REAL pelo runtime de conversa ══");
  log(`  modelo: ${process.env.ANTHROPIC_MODEL_AGENTE}`);

  try {
    await limparOQuePodemos(db);

    // ═════════════════════════════════════════════════════════════════
    secao("A. Fixture");
    // ═════════════════════════════════════════════════════════════════
    {
      // `upsert` porque o agente PERSISTE entre execucoes: a auditoria
      // dele e append-only e a FK e RESTRICT. Ver `limparOQuePodemos`.
      const { error: eA } = await db.from("agentes").upsert({
        id: AGENTE, user_id: DONO, nome: "ZZ FIXTURE chat live",
        tipo: "personalizado", ativo: false,
        instrucoes: "Voce ajuda com contas. Use as ferramentas para QUALQUER calculo.",
      }, { onConflict: "id" });
      ok("A1  agente-fixture pronto (INATIVO — testar nao ativa)", eA === null,
        eA ? String(eA.message).slice(0, 80) : "");

      // Permissao REAL na tabela real: e ela que o guard le.
      const { error: eP } = await db.from("agente_permissoes").insert({
        agente_id: AGENTE, user_id: DONO, funcao_id: ID_CALC, nivel: "automatico",
      });
      ok("A2  permissao `automatico` para a calculadora", eP === null,
        eP ? String(eP.message).slice(0, 80) : "");
    }

    // ═════════════════════════════════════════════════════════════════
    secao("B. Um turno, ponta a ponta");
    // ═════════════════════════════════════════════════════════════════
    const conversa = await portaC.criarConversa(DONO, AGENTE, "Turno de prova");
    ok("B1  conversa criada e persistida",
      (await portaC.obterConversa(DONO, conversa.id)) !== null);

    const r = await responderNaConversa({
      userId: DONO, agenteId: AGENTE, conversaId: conversa.id,
      texto: "Use a calculadora para calcular 1500 - 275.",
    });

    if (!r.ok) {
      ok("B2  o turno respondeu", false, `${r.codigo}: ${r.mensagem}`);
    } else {
      ok("B2  o turno respondeu", true);
      ok("B3  a mensagem do usuario foi PERSISTIDA",
        r.mensagemDoUsuario.papel === "usuario" && r.mensagemDoUsuario.ordem === 0);
      ok("B4  a resposta do assistente foi PERSISTIDA",
        r.resposta.papel === "assistente" && r.resposta.ordem === 1);
      ok("B5  o turno concluiu (nao foi bloqueado nem bateu no teto)",
        r.motivo === "concluido", r.motivo);

      // A prova central: a FERRAMENTA rodou, e o guard foi o caminho.
      ok("B6  uma ferramenta foi pedida e EXECUTOU",
        r.resposta.passos !== null && r.resposta.passos.length >= 1 &&
        r.resposta.passos.some((p) => p.funcaoId === ID_CALC && p.executou),
        JSON.stringify(r.resposta.passos));
      ok("B7  e o desfecho dela foi `sucesso` — logo passou pelo guard",
        (r.resposta.passos ?? []).some((p) => p.desfecho === "sucesso"),
        JSON.stringify(r.resposta.passos));
      ok("B8  o passo carrega requestId — houve ABERTURA no ledger",
        (r.resposta.passos ?? []).some((p) => p.requestId !== null && p.requestId !== ""),
        JSON.stringify((r.resposta.passos ?? []).map((p) => p.requestId !== null)));

      ok(`B9  a resposta final contem ${ESPERADO}`,
        r.resposta.conteudo.replace(/[.,\s]/g, "").includes(ESPERADO),
        r.resposta.conteudo.slice(0, 120));
      ok("B10 o uso do provedor foi registrado",
        r.resposta.provedor === "anthropic" &&
        (r.resposta.tokensEntrada ?? 0) > 0 && (r.resposta.tokensSaida ?? 0) > 0,
        `${r.resposta.provedor} in=${r.resposta.tokensEntrada} out=${r.resposta.tokensSaida}`);
      ok("B11 e o modelo tambem", typeof r.resposta.modelo === "string" &&
        (r.resposta.modelo ?? "").length > 0, String(r.resposta.modelo));

      log(`  resposta: ${r.resposta.conteudo.slice(0, 160)}`);
    }

    // ═════════════════════════════════════════════════════════════════
    secao("C. O historico no banco");
    // ═════════════════════════════════════════════════════════════════
    {
      const msgs = await portaC.listarMensagens(DONO, conversa.id);
      ok("C1  duas mensagens, na ordem", msgs.length === 2 &&
        msgs[0].papel === "usuario" && msgs[1].papel === "assistente",
        `${msgs.length}: ${msgs.map((m) => m.papel).join(">")}`);
      ok("C2  a proveniencia ficou gravada em jsonb",
        Array.isArray(msgs[1].passos) && (msgs[1].passos ?? []).length >= 1);
      ok("C3  e NENHUM caminho de storage ou credencial no historico",
        !/agente-fontes|eyJ|sk-ant|service_role/.test(JSON.stringify(msgs)));
      ok("C4  a instrucao de sistema NAO foi persistida — ela e montada por turno",
        !JSON.stringify(msgs).includes("REGRAS_DO_SISTEMA"));
      ok("C5  o dono nao aparece duplicado como autoridade na mensagem",
        msgs.every((m) => m.userId === DONO));
    }

    // ═════════════════════════════════════════════════════════════════
    secao("D. Sem permissao, nada de numero (F4.1 no runtime real)");
    // ═════════════════════════════════════════════════════════════════
    {
      await db.from("agente_permissoes")
        .update({ nivel: "bloqueado" })
        .eq("user_id", DONO).eq("agente_id", AGENTE).eq("funcao_id", ID_CALC);

      const conversa2 = await portaC.criarConversa(DONO, AGENTE, "Sem permissao");
      const r2 = await responderNaConversa({
        userId: DONO, agenteId: AGENTE, conversaId: conversa2.id,
        texto: "Use a calculadora para calcular 1500 - 275.",
      });

      if (!r2.ok) {
        ok("D1  o turno terminou de forma controlada", false, r2.codigo);
      } else {
        ok("D1  o turno terminou de forma controlada", true);
        ok("D2  o motivo e `bloqueado_por_ferramenta`",
          r2.motivo === "bloqueado_por_ferramenta", r2.motivo);
        ok("D3  NENHUMA ferramenta executou",
          (r2.resposta.passos ?? []).every((p) => !p.executou),
          JSON.stringify(r2.resposta.passos));
        ok(`D4  e ${ESPERADO} NAO aparece na resposta`,
          !r2.resposta.conteudo.replace(/[.,\s]/g, "").includes(ESPERADO),
          r2.resposta.conteudo.slice(0, 120));
        log(`  resposta: ${r2.resposta.conteudo.slice(0, 140)}`);
      }

      // O historico do turno 1 NAO vaza para a conversa 2.
      const m2 = await portaC.listarMensagens(DONO, conversa2.id);
      ok("D5  a conversa nova nao traz o historico da anterior",
        m2.length === 2 && !JSON.stringify(m2).includes("Turno de prova"));
    }
  } finally {
    const removido = await limparOQuePodemos(db);
    log(`\n  cleanup: ${removido}`);

    const { count: sobraC } = await db.from("agente_conversas")
      .select("id", { count: "exact", head: true }).like("user_id", `${PREFIXO}%`);
    const { count: sobraM } = await db.from("agente_mensagens")
      .select("id", { count: "exact", head: true }).like("user_id", `${PREFIXO}%`);
    const { count: sobraP } = await db.from("agente_permissoes")
      .select("agente_id", { count: "exact", head: true }).like("user_id", `${PREFIXO}%`);
    const { data: ag } = await db.from("agentes")
      .select("id,ativo").like("user_id", `${PREFIXO}%`);

    ok("Z1  cleanup: zero conversas", (sobraC ?? 0) === 0, String(sobraC));
    ok("Z2  cleanup: zero mensagens (CASCADE)", (sobraM ?? 0) === 0, String(sobraM));
    ok("Z3  cleanup: zero permissoes", (sobraP ?? 0) === 0, String(sobraP));
    // O agente FICA — ver o docblock de `limparOQuePodemos`. O que se
    // cobra e que ele seja UM e que esteja INATIVO.
    ok("Z4  o agente-fixture e UM so — id fixo, nao acumula",
      (ag ?? []).length <= 1, String((ag ?? []).length));
    ok("Z5  e ele continua INATIVO — nao roda, nao aparece",
      (ag ?? []).every((a) => (a as { ativo: boolean }).ativo === false),
      JSON.stringify(ag));
    ok("Z6  nenhuma fixture de OUTRO prefixo ficou para tras",
      ((await db.from("agentes").select("id", { count: "exact", head: true })
        .like("user_id", "FIXTURE-%").not("user_id", "like", `${PREFIXO}%`)).count ?? 0) === 0);
  }

  log(`\n── placar ${"─".repeat(48)}`);
  log(`  PASS ${passou}   FAIL ${falhou}`);
}

void main().then(
  () => process.exit(falhou > 0 ? 1 : 0),
  (e) => {
    console.error("ERRO NAO TRATADO:", limpar(String((e as Error).message ?? e)).slice(0, 300));
    process.exit(1);
  }
);
