/**
 * AGENT-FACTORY-F7b.4.3 §23/§24/§25 — o ciclo COMPLETO, real.
 *
 *   provider real
 *     -> Function externa pedida pelo modelo
 *     -> laco da CDS
 *     -> GUARD da CDS
 *     -> adaptador Composio
 *     -> action real, resultado real
 *     -> provider real
 *     -> resposta final
 *
 * Tudo pela MESMA `responderNaConversa` que a Factory usa. Nada de mock.
 *
 * ── A verdade-terreno, e o PAR que a torna prova ────────────────────
 *
 * O autor do item 2921983 do Hacker News e `norvig`. E um comentario
 * obscuro: nao e o primeiro post, nao e o do Dropbox, nao esta em lista
 * de "posts famosos". Um modelo nao sabe isso de cabeca.
 *
 *   A. com a ferramenta em `automatico` -> `norvig` APARECE na resposta
 *   B. com a MESMA ferramenta bloqueada -> `norvig` NAO aparece
 *
 * So o par prova. Sozinho, o caso A passaria com um modelo que chutou; e
 * sozinho, o caso B passaria com um modelo que recusa tudo.
 *
 * ── O que NAO acontece aqui ─────────────────────────────────────────
 *
 * Nenhum Google e conectado (§32). Nenhuma escrita externa. Nenhum dado
 * pessoal. O agente-fixture fica INATIVO — a auditoria de Funcao e
 * append-only e a FK e RESTRICT, entao apaga-lo e impossivel por desenho.
 *
 * Roda com:
 *   npx tsx scripts/testar-runtime-externo-live.ts
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

const PREFIXO = "FIXTURE-RTEXT-F743";
const DONO = `${PREFIXO}-DONO`;
const AGENTE = "c7b00000-0000-4000-8000-000000000044";

const TOOLKIT = "hackernews";
const ACAO = "HACKERNEWS_GET_ITEM_WITH_ID";
const ID_EXT = "composio.hackernews.hackernews_get_item_with_id";

const ITEM = "2921983";
const AUTOR = "norvig";

const PERGUNTA =
  `Qual é o nome de usuário do autor do item ${ITEM} do Hacker News? ` +
  "Use a ferramenta disponível. Responda apenas com o nome de usuário.";

/** Valores que NUNCA podem sair em log. */
let SENSIVEIS: string[] = [];
function limpo(t: string): string {
  let s = t;
  for (const v of SENSIVEIS) if (v) s = s.split(v).join("«REDIGIDO»");
  return s;
}

let passou = 0;
let falhou = 0;
function ok(nome: string, cond: boolean, detalhe = ""): void {
  if (cond) { passou++; console.log(`  PASS  ${nome}`); }
  else { falhou++; console.log(`  FAIL  ${nome}${detalhe ? ` — ${limpo(detalhe)}` : ""}`); }
}
function secao(t: string): void { console.log(`\n${t}`); }

async function limparFixture(db: SupabaseClient): Promise<void> {
  await db.from("agente_ferramentas_externas").delete().eq("user_id", DONO);
  await db.from("agente_permissoes").delete().eq("user_id", DONO);
  // As conversas SAO apagadas: elas nao tem FK de auditoria e acumular
  // uma por execucao encheria a tabela de lixo. As mensagens caem por
  // CASCADE, como a suite do chat ja provou.
  await db.from("agente_conversas").delete().eq("user_id", DONO);
  // O agente NAO e apagado: FK RESTRICT da auditoria append-only. Fica
  // INATIVO, que e a propriedade que importa.
  await db.from("agentes").update({ ativo: false }).eq("user_id", DONO);
}

async function main(): Promise<void> {
  SENSIVEIS = [
    process.env.COMPOSIO_API_KEY ?? "",
    process.env.ANTHROPIC_API_KEY ?? "",
    process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
    process.env.ZEP_API_KEY ?? "",
  ].filter((v) => v !== "");

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const chaveDb = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !chaveDb) { console.error("ERRO: env do Supabase ausente."); process.exit(1); }
  if (!process.env.COMPOSIO_API_KEY) {
    console.error("ERRO: COMPOSIO_API_KEY ausente."); process.exit(1);
  }
  if (!process.env.ANTHROPIC_API_KEY || !process.env.ANTHROPIC_MODEL_AGENTE) {
    console.error("ERRO: ANTHROPIC_API_KEY / ANTHROPIC_MODEL_AGENTE ausentes.");
    process.exit(1);
  }
  const db = createClient(url, chaveDb);

  const { responderNaConversa } = await import("../lib/agentes/conversas/runtime");
  const { criarPortaDeConversas } = await import("../lib/agentes/conversas/repositorio");
  const {
    vincularFerramentaExternaNoAgente, definirPermissaoDeFerramentaExterna,
  } = await import("../lib/agentes/ferramentas-externas/repositorio");

  const portaC = criarPortaDeConversas(db);

  console.log("\n== F7b.4.3 §24 — provider -> externa -> guard -> Composio -> provider ==");
  console.log(`  modelo: ${process.env.ANTHROPIC_MODEL_AGENTE}`);

  try {
    await limparFixture(db);

    // ─── A. Fixture ──────────────────────────────────────────────────

    secao("A. Um agente sintetico, pelas MESMAS camadas da Factory");
    {
      const { error } = await db.from("agentes").upsert({
        id: AGENTE, user_id: DONO, nome: "ZZ FIXTURE runtime externo",
        tipo: "personalizado", ativo: false,
        instrucoes:
          "Voce responde sobre o Hacker News. Use SEMPRE a ferramenta disponivel " +
          "para obter qualquer dado. NUNCA responda de cabeca: se a ferramenta " +
          "nao estiver disponivel, diga que nao consegue.",
        // §23: memoria LIGADA, como um agente real configurado.
        memoria_ativa: true,
        // §18: provider escolhido e gravado, e nao herdado do ambiente.
        provedor_ia: "anthropic",
        modelo_ia: process.env.ANTHROPIC_MODEL_AGENTE,
        nivel_de_trabalho: null,
      }, { onConflict: "id" });
      ok("A1  agente-fixture pronto, INATIVO e com memoria LIGADA", error === null,
        error ? String(error.message).slice(0, 90) : "");

      const v = await vincularFerramentaExternaNoAgente({
        userId: DONO, agenteId: AGENTE, provedorExterno: "composio",
        toolkit: TOOLKIT, acao: ACAO,
      });
      ok("A2  a acao externa esta VINCULADA",
        v.estado === "vinculada" || v.estado === "ja_vinculada", v.estado);

      const p = await definirPermissaoDeFerramentaExterna({
        userId: DONO, agenteId: AGENTE, funcaoId: ID_EXT, nivel: "automatico",
      });
      ok("A3  e com permissao `automatico`, decidida pelo dono",
        p.estado === "definida", p.estado);
    }

    // ─── B. O ciclo COMPLETO ─────────────────────────────────────────

    secao("B. O ciclo completo — e o dado so pode ter vindo da ferramenta");
    {
      const conversa = await portaC.criarConversa(DONO, AGENTE, "Externa real");
      const r = await responderNaConversa(
        { userId: DONO, agenteId: AGENTE, conversaId: conversa.id, texto: PERGUNTA },
        portaC
      );

      ok("B1  o turno terminou com sucesso", r.ok === true,
        r.ok ? "" : `${r.codigo}: ${r.mensagem}`);
      if (!r.ok) throw new Error("turno falhou");

      const passos = r.resposta.passos ?? [];
      const externos = passos.filter((p) => p.funcaoId === ID_EXT);
      ok("B2  o modelo PEDIU a Funcao externa", externos.length >= 1,
        passos.map((p) => `${p.funcaoId}:${p.desfecho}`).join(", ") || "nenhum passo");
      ok("B3  o guard AUTORIZOU e ela EXECUTOU",
        externos.some((p) => p.executou === true && p.desfecho === "sucesso"),
        externos.map((p) => `${p.desfecho}/executou=${p.executou}`).join(", "));
      ok("B4  e ela executou exatamente UMA vez",
        externos.filter((p) => p.executou === true).length === 1,
        `${externos.filter((p) => p.executou === true).length}`);
      ok("B5  cada execucao tem `requestId` — ha auditoria, nao so efeito",
        externos.every((p) => p.executou !== true || typeof p.requestId === "string"));

      const texto = r.resposta.conteudo ?? "";
      console.log(`  resposta: ${limpo(texto).slice(0, 180)}`);
      ok(`B6  a resposta final carrega o dado REAL (\`${AUTOR}\`)`,
        texto.toLowerCase().includes(AUTOR),
        limpo(texto).slice(0, 120));

      // O resultado da ferramenta NAO vira mensagem de conversa: historico
      // e assunto, e payload de ferramenta nao e assunto.
      const mensagens = await portaC.listarMensagens(DONO, conversa.id);
      ok("B7  nenhuma mensagem da conversa e payload cru de ferramenta",
        mensagens.every((m) => m.papel === "usuario" || m.papel === "assistente"));
      ok("B8  e nenhuma delas carrega a chave do Composio",
        mensagens.every((m) => !SENSIVEIS.some((v) => (m.conteudo ?? "").includes(v))));
    }

    // ─── C. O PAR: a mesma pergunta, ferramenta BLOQUEADA ────────────

    secao("C. CONTROLE NEGATIVO — bloqueada, o dado NAO aparece");
    {
      const p = await definirPermissaoDeFerramentaExterna({
        userId: DONO, agenteId: AGENTE, funcaoId: ID_EXT, nivel: "bloqueado",
      });
      ok("C1  a MESMA acao passa a `bloqueado`", p.estado === "definida", p.estado);

      // Conversa NOVA: o historico da anterior traria `norvig` de graca, e
      // o teste passaria sem a ferramenta ter feito nada.
      const conversa = await portaC.criarConversa(DONO, AGENTE, "Externa bloqueada");
      const r = await responderNaConversa(
        { userId: DONO, agenteId: AGENTE, conversaId: conversa.id, texto: PERGUNTA },
        portaC
      );
      ok("C2  o turno terminou de forma controlada", r.ok === true,
        r.ok ? "" : `${r.codigo}`);
      if (!r.ok) throw new Error("turno bloqueado falhou");

      const passos = r.resposta.passos ?? [];
      const externos = passos.filter((p) => p.funcaoId === ID_EXT);
      ok("C3  a Funcao continua DECLARADA — o modelo a pediu",
        externos.length >= 1,
        passos.map((p) => p.funcaoId).join(", ") || "nenhum passo");
      ok("C4  o guard NEGOU: NENHUMA execucao",
        externos.every((p) => p.executou !== true),
        externos.map((p) => `${p.desfecho}/executou=${p.executou}`).join(", "));
      ok("C5  e o laco fechou o turno por bloqueio",
        r.motivo === "bloqueado_por_ferramenta", String(r.motivo));

      const texto = r.resposta.conteudo ?? "";
      console.log(`  resposta: ${limpo(texto).slice(0, 180)}`);
      ok(`C6  a resposta NAO contem \`${AUTOR}\` — nada foi inventado`,
        !texto.toLowerCase().includes(AUTOR),
        limpo(texto).slice(0, 120));
    }

    // ─── D. Falha externa nao vira resposta inventada (§13) ──────────

    secao("D. Com o catalogo externo fora, o agente nao inventa");
    {
      await definirPermissaoDeFerramentaExterna({
        userId: DONO, agenteId: AGENTE, funcaoId: ID_EXT, nivel: "automatico",
      });

      const guardada = process.env.COMPOSIO_API_KEY;
      delete process.env.COMPOSIO_API_KEY;
      const conversa = await portaC.criarConversa(DONO, AGENTE, "Externa indisponivel");
      const r = await responderNaConversa(
        { userId: DONO, agenteId: AGENTE, conversaId: conversa.id, texto: PERGUNTA },
        portaC
      );
      process.env.COMPOSIO_API_KEY = guardada;

      ok("D1  o turno terminou de forma controlada", r.ok === true,
        r.ok ? "" : `${r.codigo}`);
      if (r.ok) {
        const texto = r.resposta.conteudo ?? "";
        console.log(`  resposta: ${limpo(texto).slice(0, 180)}`);
        ok(`D2  e a resposta NAO contem \`${AUTOR}\``,
          !texto.toLowerCase().includes(AUTOR), limpo(texto).slice(0, 120));
        // A ferramenta nem chega a ser declarada: sem catalogo nao ha
        // schema, e declarar sem schema seria inventar contrato.
        const externos = (r.resposta.passos ?? []).filter((p) => p.funcaoId === ID_EXT);
        ok("D3  nenhuma execucao externa aconteceu",
          externos.every((p) => p.executou !== true));
      }
    }

    // ─── E. As INTERNAS continuam funcionando (§13) ──────────────────

    secao("E. Falha do externo nao derruba a ferramenta interna");
    {
      // A calculadora e interna e nao tem nada com o Composio.
      const { error } = await db.from("agente_permissoes").upsert({
        agente_id: AGENTE, user_id: DONO,
        funcao_id: "calculadora.calcular", nivel: "automatico",
        alterado_em: new Date().toISOString(),
      }, { onConflict: "agente_id,funcao_id" });
      ok("E1  a calculadora interna esta em `automatico`", error === null,
        error ? String(error.message).slice(0, 80) : "");

      const guardada = process.env.COMPOSIO_API_KEY;
      delete process.env.COMPOSIO_API_KEY;
      const conversa = await portaC.criarConversa(DONO, AGENTE, "Interna com externo fora");
      const r = await responderNaConversa(
        {
          userId: DONO, agenteId: AGENTE, conversaId: conversa.id,
          texto: "Quanto e 184530.20 menos 137810.55? Use a ferramenta.",
        },
        portaC
      );
      process.env.COMPOSIO_API_KEY = guardada;

      ok("E2  o turno funcionou mesmo com o catalogo externo fora", r.ok === true,
        r.ok ? "" : `${r.codigo}`);
      if (r.ok) {
        const texto = r.resposta.conteudo ?? "";
        console.log(`  resposta: ${limpo(texto).slice(0, 160)}`);
        ok("E3  e a Funcao INTERNA executou",
          (r.resposta.passos ?? []).some(
            (p) => p.funcaoId === "calculadora.calcular" && p.executou === true),
          (r.resposta.passos ?? []).map((p) => `${p.funcaoId}:${p.executou}`).join(", "));
        ok("E4  com o numero certo na resposta", texto.includes("46719.65") ||
          texto.includes("46.719,65") || texto.includes("46719,65"),
          limpo(texto).slice(0, 120));
      }
    }

  } finally {
    secao("Limpeza: nada executavel sobra");
    await limparFixture(db);
    const { data: agentes } = await db.from("agentes")
      .select("id, ativo").eq("user_id", DONO);
    const { data: vinculos } = await db.from("agente_ferramentas_externas")
      .select("id").eq("user_id", DONO);
    const { count: conversas } = await db.from("agente_conversas")
      .select("id", { count: "exact", head: true }).eq("user_id", DONO);
    ok("Z1  nenhum vinculo externo sobrou", (vinculos ?? []).length === 0);
    ok("Z2  o agente-fixture esta INATIVO",
      (agentes ?? []).length === 1 && (agentes ?? [])[0]?.ativo === false);
    ok("Z3  nenhuma conversa de teste sobrou", (conversas ?? 0) === 0,
      String(conversas));
  }

  console.log(`\nPASS ${passou}   FAIL ${falhou}`);
  process.exit(falhou === 0 ? 0 : 1);
}

void main();
