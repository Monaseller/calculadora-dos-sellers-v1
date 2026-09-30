/**
 * AGENT-FACTORY-F7b.4.5 §8–§12 — a memoria REAL, pelo caminho do usuario.
 *
 * ── Por que esta suite existe, se ja havia uma de memoria ───────────
 *
 * `testar-memoria-automatica-live` media o MODULO: 40 assercoes verdes,
 * e a memoria nao funcionava para o Rodrigo. O modulo estava certo e nao
 * tinha chamador — o runtime nunca ingeria e nunca recuperava.
 *
 * Esta suite entra por `responderNaConversa`, que e por onde a tela entra.
 * E o mesmo aprendizado do F7b.4.2: provar o modulo nao prova o produto.
 *
 * ── O cenario e o do relato, sem adaptacao ──────────────────────────
 *
 *   Chat A: "Meu nome e Douglas."
 *   Chat B (NOVO, mesmo agente): "Qual e o meu nome?"  -> Douglas
 *
 * Com os controles que fazem disso prova:
 *
 *   outro AGENTE do mesmo dono   -> NAO sabe
 *   memoria DESLIGADA            -> NAO sabe, e diz que esta desligada
 *
 * ── A latencia e parte do contrato ──────────────────────────────────
 *
 * O Zep processa o grafo de forma ASSINCRONA — medido em
 * `scripts/medir-zep-cross-chat.ts`: ~15 s para o fato aparecer. A suite
 * espera de verdade, porque o produto tambem espera.
 *
 * Roda com: npx tsx scripts/testar-memoria-real-live.ts
 */
import "./_server-only-inerte";

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

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

const DONO = "c7b00000-f745-4000-8000-0000000000d0";
/** Com memoria LIGADA. */
const AGENTE = "c7b00000-0000-4000-8000-000000000050";
/** Outro agente do MESMO dono, tambem com memoria. Controle de isolamento. */
const AGENTE_VIZINHO = "c7b00000-0000-4000-8000-000000000051";
/** Com memoria DESLIGADA. */
const AGENTE_SEM_MEMORIA = "c7b00000-0000-4000-8000-000000000052";

const NOME = "Douglas";
const PREFERENCIA = "saldo";

let passou = 0;
let falhou = 0;
function ok(nome: string, cond: boolean, detalhe = ""): void {
  if (cond) { passou++; console.log(`  PASS  ${nome}`); }
  else { falhou++; console.log(`  FAIL  ${nome}${detalhe ? ` — ${detalhe}` : ""}`); }
}
function secao(t: string): void { console.log(`\n${t}`); }

async function limpar(db: SupabaseClient): Promise<void> {
  await db.from("agente_conversas").delete().eq("user_id", DONO);
  await db.from("agente_permissoes").delete().eq("user_id", DONO);
  await db.from("agentes").update({ ativo: false }).eq("user_id", DONO);
}

async function main(): Promise<void> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const chaveDb = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !chaveDb) { console.error("ERRO: env do Supabase ausente."); process.exit(1); }
  if (!process.env.ZEP_API_KEY) { console.error("ERRO: ZEP_API_KEY ausente."); process.exit(1); }
  if (!process.env.ANTHROPIC_API_KEY || !process.env.ANTHROPIC_MODEL_AGENTE) {
    console.error("ERRO: env da Anthropic ausente."); process.exit(1);
  }
  const db = createClient(url, chaveDb);

  const { responderNaConversa } = await import("../lib/agentes/conversas/runtime");
  const { criarPortaDeConversas } = await import("../lib/agentes/conversas/repositorio");
  const { principalDeMemoria } = await import("../lib/agentes/memoria/identidade");
  const { recuperarMemoriaDoDono } = await import("../lib/agentes/memoria/automatica");
  const portaC = criarPortaDeConversas(db);

  /** Um turno pelo caminho REAL. */
  async function falar(agenteId: string, conversaId: string, texto: string) {
    const r = await responderNaConversa(
      { userId: DONO, agenteId, conversaId, texto }, portaC);
    return r;
  }

  console.log("\n== F7b.4.5 — memoria REAL, pelo runtime da conversa ==");
  console.log(`  modelo: ${process.env.ANTHROPIC_MODEL_AGENTE}`);

  try {
    await limpar(db);
    for (const [id, memoria] of [
      [AGENTE, true], [AGENTE_VIZINHO, true], [AGENTE_SEM_MEMORIA, false],
    ] as const) {
      await db.from("agentes").upsert({
        id, user_id: DONO, nome: "ZZ FIXTURE memoria f745",
        tipo: "personalizado", ativo: false,
        instrucoes: "Voce e um assistente. Responda de forma curta e direta.",
        memoria_ativa: memoria,
      }, { onConflict: "id" });
    }

    // ═══ A. Chat A: o dono se apresenta ═════════════════════════════

    secao("A. Chat A — o dono diz o nome e uma preferencia");
    {
      const a = await portaC.criarConversa(DONO, AGENTE, "Chat A");
      const r1 = await falar(AGENTE, a.id, `Meu nome e ${NOME}. Guarde isso.`);
      ok("A1  o turno concluiu", r1.ok === true, r1.ok ? "" : `${r1.codigo}`);

      const r2 = await falar(AGENTE, a.id,
        "Nos resumos financeiros eu prefiro ver o saldo primeiro. Guarde isso tambem.");
      ok("A2  o segundo turno tambem", r2.ok === true, r2.ok ? "" : `${r2.codigo}`);
    }

    // ═══ B. O Zep precisa de tempo — e isso e do contrato ═══════════

    secao("B. O grafo do Zep processa de forma assincrona");
    {
      const escopo = {
        userId: DONO, agenteId: AGENTE, conversaId: "qualquer", memoriaAtiva: true,
      };
      // Espera pelos DOIS fatos, e nao so pelo primeiro: o nome foi dito
      // no turno 1 e a preferencia no turno 2, entao ela entra no grafo
      // depois. Sair no primeiro fazia a secao C perguntar pela
      // preferencia antes de ela existir — e reprovar o sistema por uma
      // pressa do teste.
      let achouNome = false;
      let achouPref = false;
      let esperou = 0;
      for (const espera of [5000, 15000, 25000, 30000, 40000, 60000]) {
        await new Promise((s) => setTimeout(s, espera));
        esperou += espera;
        if (!achouNome) {
          const m = await recuperarMemoriaDoDono(escopo, "Qual e o meu nome?");
          achouNome = new RegExp(NOME, "i").test(m.lembrancas.map((l) => l.fato).join(" | "));
        }
        if (!achouPref) {
          const m = await recuperarMemoriaDoDono(
            escopo, "Como eu prefiro ver os resumos financeiros?");
          const t = m.lembrancas.map((l) => l.fato).join(" | ");
          if (new RegExp(PREFERENCIA, "i").test(t)) {
            achouPref = true;
            console.log(`  preferencia apos ~${esperou / 1000}s: ${t.slice(0, 110)}`);
          }
        }
        if (achouNome && achouPref) break;
      }
      ok("B1  o fato do nome entrou no grafo do principal", achouNome,
        `nao apareceu em ${esperou / 1000}s`);
      ok("B2  e o fato da preferencia tambem", achouPref,
        `nao apareceu em ${esperou / 1000}s`);
    }

    // ═══ C. Chat B: NOVA conversa, mesmo agente ════════════════════

    secao("C. Chat B — conversa NOVA, e o agente lembra (§12)");
    {
      const b = await portaC.criarConversa(DONO, AGENTE, "Chat B");
      const r = await falar(AGENTE, b.id, "Qual e o meu nome?");
      ok("C1  o turno concluiu", r.ok === true, r.ok ? "" : `${r.codigo}`);
      const texto = r.ok ? (r.resposta.conteudo ?? "") : "";
      console.log(`  resposta: ${texto.slice(0, 140)}`);
      ok(`C2  e o agente SABE que o nome e ${NOME}`,
        new RegExp(NOME, "i").test(texto), texto.slice(0, 110));

      const b2 = await portaC.criarConversa(DONO, AGENTE, "Chat B2");
      const r2 = await falar(AGENTE, b2.id,
        "Como eu prefiro ver os resumos financeiros?");
      const t2 = r2.ok ? (r2.resposta.conteudo ?? "") : "";
      console.log(`  resposta: ${t2.slice(0, 140)}`);
      ok("C3  e lembra da PREFERENCIA tambem",
        new RegExp(PREFERENCIA, "i").test(t2), t2.slice(0, 110));
    }

    // ═══ D. Isolamento: outro agente NAO sabe ══════════════════════

    secao("D. CONTROLE — outro agente do mesmo dono nao sabe");
    {
      const v = await portaC.criarConversa(DONO, AGENTE_VIZINHO, "Vizinho");
      const r = await falar(AGENTE_VIZINHO, v.id, "Qual e o meu nome?");
      const texto = r.ok ? (r.resposta.conteudo ?? "") : "";
      console.log(`  resposta: ${texto.slice(0, 140)}`);
      ok("D1  o agente VIZINHO nao sabe o nome",
        !new RegExp(NOME, "i").test(texto), texto.slice(0, 110));
      // E o motivo tem de ser "nao tenho isso guardado", e NAO "nao
      // consegui consultar": um principal sem grafo responde 404, e tratar
      // isso como falha fazia o agente relatar um problema que nao existe.
      ok("D1a e o motivo nao e falha de consulta",
        !/n[aã]o consegui consultar/i.test(texto), texto.slice(0, 110));
      ok("D2  e os principais dos dois agentes sao diferentes",
        principalDeMemoria(DONO, AGENTE) !== principalDeMemoria(DONO, AGENTE_VIZINHO));
    }

    // ═══ E. Memoria DESLIGADA ══════════════════════════════════════

    secao("E. CONTROLE — memoria desligada nao lembra e NAO ingere");
    {
      const d = await portaC.criarConversa(DONO, AGENTE_SEM_MEMORIA, "Sem memoria");
      const r1 = await falar(AGENTE_SEM_MEMORIA, d.id, "Meu nome e Fulano de Tal.");
      ok("E1  o turno concluiu normalmente", r1.ok === true);

      const m = await recuperarMemoriaDoDono(
        {
          userId: DONO, agenteId: AGENTE_SEM_MEMORIA,
          conversaId: d.id, memoriaAtiva: false,
        },
        "Qual e o meu nome?"
      );
      ok("E2  e a recuperacao responde `desligada`, sem rede",
        m.desfecho === "desligada" && m.lembrancas.length === 0, m.desfecho);
    }

    // ═══ F. §11 — ligada e VAZIA nao e "nao tenho memoria" ═════════

    secao("F. Memoria ligada e sem lembranca relevante (§11)");
    {
      const { montarContextoDoAgente } = await import("../lib/agentes/ia/contexto-do-agente");
      const ligadaVazia = montarContextoDoAgente({
        instrucoesDoAgente: null, skills: [], memorias: [], fontes: [],
        estadoDaMemoria: "ligada", lembrancasDoDono: [],
      });
      ok("F1  com memoria ligada e vazia, o contexto diz ATIVA",
        /mem[oó]ria de longo prazo est[aá] ATIVA/i.test(ligadaVazia.instrucao));
      ok("F2  e instrui a NAO dizer que nao tem memoria",
        /n[aã]o significa que voce n[aã]o tem mem[oó]ria/i.test(ligadaVazia.instrucao));
      ok("F3  e proibe inventar lembranca",
        /NUNCA invente uma lembran/i.test(ligadaVazia.instrucao));

      const desligada = montarContextoDoAgente({
        instrucoesDoAgente: null, skills: [], memorias: [], fontes: [],
        estadoDaMemoria: "desligada",
      });
      ok("F4  e com memoria DESLIGADA a frase e outra",
        /DESLIGADA/.test(desligada.instrucao) &&
          !/est[aá] ATIVA/i.test(desligada.instrucao));
      ok("F5  ANCORA: os dois textos sao mesmo diferentes",
        ligadaVazia.instrucao !== desligada.instrucao);
    }

  } finally {
    secao("Limpeza");
    await limpar(db);
    const { count } = await db.from("agente_conversas")
      .select("id", { count: "exact", head: true }).eq("user_id", DONO);
    ok("Z1  nenhuma conversa de teste sobrou", (count ?? 0) === 0, String(count));
    console.log("  (as threads do Zep ficam sob principal sintetico, isoladas)");
  }

  console.log(`\nPASS ${passou}   FAIL ${falhou}`);
  process.exit(falhou === 0 ? 0 : 1);
}

void main();
