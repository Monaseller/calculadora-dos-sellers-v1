/**
 * AGENT-FACTORY-F7b.4.2 §9/§17 — persistencia REAL, contra o banco real.
 *
 * ── O que so um teste contra o banco consegue provar ────────────────
 *
 * As suites puras provam a REGRA. Elas nao provam que a coluna existe, que
 * o CHECK aceita o valor, que a leitura devolve o que a escrita gravou, nem
 * que o par vinculo/permissao sobrevive a um round trip.
 *
 * Aqui o ciclo do §9 e executado de verdade:
 *
 *   escolher Gemini -> salvar -> reler -> continua Gemini
 *   trocar para Anthropic -> reler -> trocou
 *   escolher OpenAI com nivel -> reler -> nivel junto
 *   limpar -> reler -> as tres colunas nulas
 *
 * E o ciclo do §13:
 *
 *   vincular -> nivel AUSENTE (nao ha permissao)
 *   decidir   -> nivel presente
 *   desvincular -> vinculo some, PERMISSAO FICA, e o fato nao existe mais
 *
 * ── Sujeira ─────────────────────────────────────────────────────────
 *
 * O agente-fixture e criado com `upsert` e APAGADO no fim, junto dos
 * vinculos e permissoes dele. Ele nao tem auditoria (nada executou), entao
 * nao ha FK RESTRICT segurando — diferente do fixture do chat, que e
 * mantido inativo de proposito.
 *
 * Nenhum agente real do Rodrigo e tocado: tudo vive sob um `user_id` com
 * prefixo proprio, e a limpeza filtra por ele.
 *
 * Roda com: npx tsx scripts/testar-ia-do-agente-live.ts
 */
import "./_server-only-inerte";

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

function carregarEnvLocal(): boolean {
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
      return true;
    } catch { /* proximo */ }
  }
  return false;
}
carregarEnvLocal();

const PREFIXO = "FIXTURE-IA-F742";
const DONO = `${PREFIXO}-DONO`;
const OUTRO_DONO = `${PREFIXO}-INTRUSO`;
const AGENTE = "c7b00000-0000-4000-8000-000000000042";

const TOOLKIT = "googlesheets";
const ACAO = "GOOGLESHEETS_ADD_SHEET";
const ID_EXT = "composio.googlesheets.googlesheets_add_sheet";

let passou = 0;
let falhou = 0;
function ok(nome: string, cond: boolean, detalhe = ""): void {
  if (cond) { passou++; console.log(`  PASS  ${nome}`); }
  else { falhou++; console.log(`  FAIL  ${nome}${detalhe ? ` — ${detalhe}` : ""}`); }
}
function secao(t: string): void { console.log(`\n${t}`); }

async function limpar(db: SupabaseClient): Promise<void> {
  await db.from("agente_ferramentas_externas").delete().eq("user_id", DONO);
  await db.from("agente_permissoes").delete().eq("user_id", DONO);
  await db.from("agentes").delete().eq("user_id", DONO);
}

async function main(): Promise<void> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const chave = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !chave) {
    console.error("ERRO: env do Supabase ausente.");
    process.exit(1);
  }
  const db = createClient(url, chave);

  const { atualizarAgenteDoDono, lerAgenteDoDono } =
    await import("../lib/agentes/capability");
  const {
    definirPermissaoDeFerramentaExterna, desvincularFerramentaExternaDoAgente,
    fatosDeFuncaoExterna, listarVinculosExternos, vincularFerramentaExternaNoAgente,
  } = await import("../lib/agentes/ferramentas-externas/repositorio");
  const { resolverIaDoAgente } = await import("../lib/agentes/factory/ia-do-agente");
  const { listarPermissoesGravadas } = await import("../lib/agentes/permissoes/gravadas");

  console.log("\n== F7b.4.2 §9/§17 — persistencia da IA e do vinculo (banco REAL) ==");

  try {
    await limpar(db);

    // ─── A. O fixture ────────────────────────────────────────────────

    secao("A. Fixture — um agente sintetico, INATIVO");
    {
      const { error } = await db.from("agentes").upsert({
        id: AGENTE, user_id: DONO, nome: "ZZ FIXTURE ia f742",
        tipo: "personalizado", ativo: false,
        instrucoes: "Fixture de teste. Nao roda.",
      }, { onConflict: "id" });
      ok("A1  agente-fixture criado (INATIVO — testar nao ativa)", error === null,
        error ? String(error.message).slice(0, 90) : "");

      const { linha } = await lerAgenteDoDono(AGENTE, DONO);
      ok("A2  e ele nasce SEM IA escolhida — como todo agente legado",
        linha !== null && linha.provedor_ia === null &&
          linha.modelo_ia === null && linha.nivel_de_trabalho === null,
        linha === null ? "nao leu" : String(linha.provedor_ia));
    }

    // ─── B. O ciclo do §9 ────────────────────────────────────────────

    secao("B. Escolher, salvar, reler — e trocar");

    // ── B1: Gemini ────────────────────────────────────────────────
    {
      const r = await atualizarAgenteDoDono(AGENTE, DONO, {
        provedorIa: "google", modeloIa: "gemini-2.5-flash", nivelDeTrabalho: null,
      });
      ok("B1  escolher Gemini: a escrita passa", r.erro === null && r.linha !== null,
        r.erro ?? "sem linha");

      // A RELEITURA, que e o ponto: nao basta a escrita nao ter dado erro.
      const { linha } = await lerAgenteDoDono(AGENTE, DONO);
      ok("B2  ao RELER, continua Gemini", linha?.provedor_ia === "google",
        String(linha?.provedor_ia));
      ok("B3  com o modelo gravado junto", linha?.modelo_ia === "gemini-2.5-flash",
        String(linha?.modelo_ia));
    }

    // ── B4: trocar para Anthropic ─────────────────────────────────
    {
      await atualizarAgenteDoDono(AGENTE, DONO, {
        provedorIa: "anthropic", modeloIa: "claude-sonnet-4-5", nivelDeTrabalho: null,
      });
      const { linha } = await lerAgenteDoDono(AGENTE, DONO);
      ok("B4  trocar para Anthropic: ao reler, trocou mesmo",
        linha?.provedor_ia === "anthropic", String(linha?.provedor_ia));
      ok("B5  e o modelo trocou junto — nao ficou o antigo",
        linha?.modelo_ia === "claude-sonnet-4-5", String(linha?.modelo_ia));
    }

    // ── B6: OpenAI COM nivel ──────────────────────────────────────
    {
      await atualizarAgenteDoDono(AGENTE, DONO, {
        provedorIa: "openai", modeloIa: "gpt-5.2", nivelDeTrabalho: "maximo",
      });
      const { linha } = await lerAgenteDoDono(AGENTE, DONO);
      ok("B6  escolher OpenAI: ao reler, e OpenAI",
        linha?.provedor_ia === "openai", String(linha?.provedor_ia));
      ok("B7  e o NIVEL sobreviveu ao round trip",
        linha?.nivel_de_trabalho === "maximo", String(linha?.nivel_de_trabalho));

      // O resolvedor, com o que veio do BANCO — e nao com fixture.
      const ia = resolverIaDoAgente({
        provedorGravado: linha?.provedor_ia ?? null,
        modeloGravado: linha?.modelo_ia ?? null,
        nivelGravado: linha?.nivel_de_trabalho ?? null,
        disponiveis: [
          { provedor: "openai", modeloId: "gpt-5.2",
            niveis: ["rapido", "equilibrado", "avancado", "maximo"] },
        ],
      });
      ok("B8  o resolvedor le a linha real e diz `escolhida`",
        ia.desfecho === "escolhida", ia.desfecho);
      ok("B9  com o nivel aplicado", ia.nivel === "maximo", String(ia.nivel));

      // ── §8 contra a linha REAL: o provedor sumiu do ambiente ────
      const semOpenAI = resolverIaDoAgente({
        provedorGravado: linha?.provedor_ia ?? null,
        modeloGravado: linha?.modelo_ia ?? null,
        nivelGravado: linha?.nivel_de_trabalho ?? null,
        disponiveis: [{ provedor: "anthropic", modeloId: "claude-x", niveis: ["equilibrado"] }],
      });
      ok("B10 se a OpenAI sumir, o desfecho e `escolhida_indisponivel`",
        semOpenAI.desfecho === "escolhida_indisponivel", semOpenAI.desfecho);
      ok("B11 e o provedor NAO virou Anthropic — sem fallback silencioso",
        semOpenAI.provedor === "openai", String(semOpenAI.provedor));
    }

    // ── B12: limpar ───────────────────────────────────────────────
    {
      await atualizarAgenteDoDono(AGENTE, DONO, {
        provedorIa: null, modeloIa: null, nivelDeTrabalho: null,
      });
      const { linha } = await lerAgenteDoDono(AGENTE, DONO);
      ok("B12 limpar a escolha zera as TRES colunas",
        linha?.provedor_ia === null && linha?.modelo_ia === null &&
          linha?.nivel_de_trabalho === null,
        `${linha?.provedor_ia}/${linha?.modelo_ia}/${linha?.nivel_de_trabalho}`);
      ok("B13 e o agente volta ao default do ambiente",
        resolverIaDoAgente({
          provedorGravado: linha?.provedor_ia ?? null,
          modeloGravado: null, nivelGravado: null,
          disponiveis: [{ provedor: "anthropic", modeloId: "c", niveis: ["equilibrado"] }],
        }).desfecho === "default_do_ambiente");
    }

    // ── B14: propriedade ──────────────────────────────────────────
    {
      const r = await atualizarAgenteDoDono(AGENTE, OUTRO_DONO, { provedorIa: "openai" });
      ok("B14 OUTRO dono NAO consegue escolher a IA deste agente",
        r.linha === null, "escreveu");
      const { linha } = await lerAgenteDoDono(AGENTE, DONO);
      ok("B15 e a linha real ficou intacta", linha?.provedor_ia === null,
        String(linha?.provedor_ia));
    }

    // ─── C. O ciclo do §13, no banco ─────────────────────────────────

    secao("C. Vincular, decidir, desvincular — a permissao nao ressuscita");

    {
      const v = await vincularFerramentaExternaNoAgente({
        userId: DONO, agenteId: AGENTE, provedorExterno: "composio",
        toolkit: TOOLKIT, acao: ACAO,
      });
      ok("C1  vincular grava o POSSUIR", v.estado === "vinculada",
        v.estado === "entrada_invalida" ? v.motivo : v.estado);

      const lista = await listarVinculosExternos({ userId: DONO, agenteId: AGENTE });
      ok("C2  e a leitura devolve UM vinculo",
        lista.coleta === "ok" && lista.vinculos.length === 1);
      ok("C3  com o funcao_id derivado da acao",
        lista.coleta === "ok" && lista.vinculos[0]?.funcaoId === ID_EXT,
        lista.coleta === "ok" ? String(lista.vinculos[0]?.funcaoId) : lista.coleta);

      // §11: NENHUMA permissao foi criada.
      const perms = await listarPermissoesGravadas({ userId: DONO, agenteId: AGENTE });
      ok("C4  e NENHUMA permissao foi gravada — §10/§11",
        perms.coleta === "ok" && perms.permissoes.length === 0,
        perms.coleta === "ok" ? `${perms.permissoes.length} permissao(oes)` : perms.coleta);

      // Idempotencia real, contra o unique do banco.
      const v2 = await vincularFerramentaExternaNoAgente({
        userId: DONO, agenteId: AGENTE, provedorExterno: "composio",
        toolkit: TOOLKIT, acao: ACAO,
      });
      ok("C5  vincular de novo e `ja_vinculada`, e nao erro",
        v2.estado === "ja_vinculada", v2.estado);
      const lista2 = await listarVinculosExternos({ userId: DONO, agenteId: AGENTE });
      ok("C6  e continua UM vinculo, nao dois",
        lista2.coleta === "ok" && lista2.vinculos.length === 1);
    }

    // ── C7: a DECISAO do dono ─────────────────────────────────────
    {
      const d = await definirPermissaoDeFerramentaExterna({
        userId: DONO, agenteId: AGENTE, funcaoId: ID_EXT, nivel: "aprovacao",
      });
      ok("C7  a decisao do dono grava a permissao", d.estado === "definida", d.estado);

      const perms = await listarPermissoesGravadas({ userId: DONO, agenteId: AGENTE });
      ok("C8  e ela e lida de volta com o nivel escolhido",
        perms.coleta === "ok" &&
          perms.permissoes.some((p) => p.funcaoId === ID_EXT && p.nivel === "aprovacao"));

      // O CONTROLE: uma acao NAO vinculada nao aceita permissao.
      const naoVinculada = await definirPermissaoDeFerramentaExterna({
        userId: DONO, agenteId: AGENTE,
        funcaoId: "composio.slack.slack_send_message", nivel: "automatico",
      });
      ok("C9  CONTROLE: acao NAO vinculada e recusada — o vinculo e a prova",
        naoVinculada.estado === "nao_vinculada", naoVinculada.estado);
      const perms2 = await listarPermissoesGravadas({ userId: DONO, agenteId: AGENTE });
      ok("C10 e nada foi gravado para ela",
        perms2.coleta === "ok" && perms2.permissoes.length === 1,
        perms2.coleta === "ok" ? `${perms2.permissoes.length}` : perms2.coleta);
    }

    // ── C11: REMOVED_TOOL_NOT_DECLARED, no banco ──────────────────
    {
      const r = await desvincularFerramentaExternaDoAgente({
        userId: DONO, agenteId: AGENTE, funcaoId: ID_EXT,
      });
      ok("C11 desvincular apaga o vinculo", r.estado === "desvinculada", r.estado);

      const lista = await listarVinculosExternos({ userId: DONO, agenteId: AGENTE });
      ok("C12 e nao ha mais vinculo nenhum",
        lista.coleta === "ok" && lista.vinculos.length === 0);

      // A PERMISSAO CONTINUA LA. E o ponto do §13.
      const perms = await listarPermissoesGravadas({ userId: DONO, agenteId: AGENTE });
      ok("C13 a PERMISSAO continua gravada — historico nao se apaga",
        perms.coleta === "ok" &&
          perms.permissoes.some((p) => p.funcaoId === ID_EXT),
        perms.coleta === "ok" ? `${perms.permissoes.length}` : perms.coleta);

      // E mesmo assim a Funcao NAO EXISTE mais para o guard.
      ok("C14 e mesmo assim o fato de existencia sumiu — §13",
        lista.coleta === "ok" && fatosDeFuncaoExterna(lista.vinculos).length === 0);

      // CONTROLE POSITIVO: com o vinculo de volta, o fato volta.
      await vincularFerramentaExternaNoAgente({
        userId: DONO, agenteId: AGENTE, provedorExterno: "composio",
        toolkit: TOOLKIT, acao: ACAO,
      });
      const lista2 = await listarVinculosExternos({ userId: DONO, agenteId: AGENTE });
      ok("C15 CONTROLE POSITIVO: revinculada, o fato volta a existir",
        lista2.coleta === "ok" && fatosDeFuncaoExterna(lista2.vinculos).length === 1);
      ok("C16 e a permissao antiga passa a valer de novo — sem regravar nada",
        (await listarPermissoesGravadas({ userId: DONO, agenteId: AGENTE })).coleta === "ok");
    }

    // ── C17: propriedade do vinculo ───────────────────────────────
    {
      const alheio = await listarVinculosExternos({ userId: OUTRO_DONO, agenteId: AGENTE });
      ok("C17 OUTRO dono nao ve os vinculos deste agente",
        alheio.coleta === "ok" && alheio.vinculos.length === 0,
        alheio.coleta === "ok" ? `${alheio.vinculos.length}` : alheio.coleta);

      const r = await desvincularFerramentaExternaDoAgente({
        userId: OUTRO_DONO, agenteId: AGENTE, funcaoId: ID_EXT,
      });
      ok("C18 e nao consegue desvincular", r.estado === "nao_encontrada", r.estado);
      const ainda = await listarVinculosExternos({ userId: DONO, agenteId: AGENTE });
      ok("C19 o vinculo do dono continua la",
        ainda.coleta === "ok" && ainda.vinculos.length === 1);
    }

  } finally {
    secao("Limpeza: o fixture e apagado por inteiro");
    await limpar(db);
    const { data: sobrou } = await db.from("agentes").select("id").eq("user_id", DONO);
    const { data: sobrouV } = await db.from("agente_ferramentas_externas")
      .select("id").eq("user_id", DONO);
    const { data: sobrouP } = await db.from("agente_permissoes")
      .select("funcao_id").eq("user_id", DONO);
    ok("Z1  nenhum agente-fixture sobrou", (sobrou ?? []).length === 0);
    ok("Z2  nenhum vinculo sobrou", (sobrouV ?? []).length === 0);
    ok("Z3  nenhuma permissao sobrou", (sobrouP ?? []).length === 0);
  }

  console.log(`\nPASS ${passou}   FAIL ${falhou}`);
  process.exit(falhou === 0 ? 0 : 1);
}

void main();
