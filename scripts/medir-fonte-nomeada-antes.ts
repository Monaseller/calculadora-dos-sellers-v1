/**
 * REPRODUCAO PRE-CORRECAO — F7b.4.8.2 §5.
 *
 * Mede o comportamento ATUAL, com o codigo como esta, para os dois bugs
 * que o Rodrigo encontrou. Nao afirma nada: imprime.
 *
 * Roda com:
 *   OPENAI_MODEL_AGENTE=gpt-5.2 npx tsx scripts/medir-fonte-nomeada-antes.ts
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

const DONO = "c7b00000-f483-4000-8000-0000000000d0";
const AGENTE = "c7b00000-f483-4000-8000-000000000090";
const LOJA = "c7b00000-f483-4000-8000-0000000a0001";
const PERGUNTA = "Quanto vendi esta semana no Mercado Livre?";
const GENERICA = "consulte as vendas";

async function main(): Promise<void> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const chaveDb = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !chaveDb) { console.error("ERRO: env do Supabase."); process.exit(1); }
  const db = createClient(url, chaveDb);

  const { detectarCapacidadeFaltante, capacidadesPedidasNoTexto } = await import(
    "../lib/agentes/factory/capacidade-faltante");
  const { DECLARACOES } = await import("../lib/agentes/ia/ferramentas");

  console.log("══ REPRODUCAO PRE-CORRECAO — F7b.4.8.2 ══");

  // ── BUG B: o cartao com tres fontes de vendas ─────────────────────
  console.log("\nB. O cartao que o Rodrigo viu");
  for (const [rotulo, texto, jaTem] of [
    ["generica, agente COM Mercado Livre", GENERICA, ["Mercado Livre"]],
    ["nomeada,  agente COM Mercado Livre", PERGUNTA, ["Mercado Livre"]],
    ["nomeada,  agente SEM Mercado Livre", PERGUNTA, ["Planilhas"]],
    ["generica, agente SEM nada de vendas", GENERICA, ["Planilhas"]],
  ] as const) {
    const r = await detectarCapacidadeFaltante({ texto, nomesQueJaTem: [...jaTem] });
    const chaves = r.desfecho === "falta_capacidade"
      ? r.opcoes.map((o) => o.chave).join(", ") : "—";
    console.log(`  ${rotulo}`);
    console.log(`    desfecho=${r.desfecho}  necessidade=${
      r.desfecho === "falta_capacidade" ? r.necessidade : "—"}`);
    console.log(`    opcoes=[${chaves}]`);
  }

  console.log("\n  packs que os gatilhos apontam:");
  for (const t of [PERGUNTA, GENERICA]) {
    console.log(`    "${t}" -> ${
      capacidadesPedidasNoTexto(t).map((p) => `${p.packId}(${p.termo})`).join(", ") || "nenhum"}`);
  }

  // ── BUG A: o schema que convida ao argumento ambiguo ──────────────
  console.log("\nA. O schema declarado ao provedor");
  const decl = DECLARACOES["mercadolivre.vendas.consultar"];
  const schema = (decl?.schemaEntrada ?? {}) as {
    properties?: Record<string, unknown>; required?: string[];
  };
  console.log(`    properties = [${Object.keys(schema.properties ?? {}).join(", ")}]`);
  console.log(`    required   = [${(schema.required ?? []).join(", ")}]`);

  // ── E o turno real, com OpenAI ────────────────────────────────────
  if (process.env.OPENAI_API_KEY && process.env.OPENAI_MODEL_AGENTE) {
    const { emitirTokenSessao, COOKIE_SESSAO } = await import("../lib/autenticacao");
    const { criarPortaDeConversas } = await import(
      "../lib/agentes/conversas/repositorio");
    const { definirPermissaoDeFuncaoDoAgente } = await import(
      "../lib/agentes/permissoes/escrita");
    const { MARKETPLACE_POR_PLATAFORMA } = await import("../lib/agentes/conexoes/estado");
    const rota = await import(
      "../app/api/agentes/[agenteId]/conversas/[conversaId]/route");

    for (const t of ["agente_capacidades_pendentes", "agente_conexoes",
      "agente_conversas", "agente_permissoes"]) {
      await db.from(t).delete().eq("user_id", DONO);
    }
    await db.from("agentes").upsert({
      id: AGENTE, user_id: DONO, nome: "ZZ FIXTURE medicao f4882",
      tipo: "personalizado", ativo: true, provedor_ia: "openai",
      memoria_ativa: true, instrucoes: "Responda sobre vendas. Seja curto.",
    }, { onConflict: "id" });
    await db.from("lojas").upsert({
      id: LOJA, user_id: DONO,
      marketplace: MARKETPLACE_POR_PLATAFORMA["mercado_livre"] as string,
      nome: "Loja Medicao", nickname: "MEDICAO", seller_id: "555000111",
      ativo: true, access_token: "fixture-nao-e-token-real",
      refresh_token: "fixture-nao-e-refresh-real",
      token_expires_at: new Date(Date.now() + 6 * 3600 * 1000).toISOString(),
    }, { onConflict: "id" });
    for (const recurso of ["vendas", "perguntas"]) {
      await db.from("agente_conexoes").insert({
        user_id: DONO, agente_id: AGENTE,
        plataforma: "mercado_livre", recurso, loja_id: LOJA,
      });
    }
    for (const f of ["mercadolivre.perguntas.listar", "mercadolivre.vendas.consultar"]) {
      await definirPermissaoDeFuncaoDoAgente({
        userId: DONO, agenteId: AGENTE, funcaoId: f, nivel: "automatico",
      });
    }

    const cookie = `${COOKIE_SESSAO}=${(await emitirTokenSessao(DONO)).token}`;
    const conversa = await criarPortaDeConversas(db).criarConversa(DONO, AGENTE, null);
    const r = await rota.POST(
      new Request(`http://local/api/agentes/${AGENTE}/conversas/${conversa.id}`, {
        method: "POST", headers: { cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ texto: PERGUNTA }),
      }), { params: { agenteId: AGENTE, conversaId: conversa.id } });
    const corpo = await r.json() as Record<string, unknown>;
    const passos = ((corpo.resposta as { passos?: unknown[] } | undefined)?.passos ?? []) as
      { funcaoId?: string; desfecho?: string; codigo?: string | null }[];

    console.log("\nC. O turno real, rota real, OpenAI real");
    console.log(`    HTTP ${r.status}  motivo=${String(corpo.motivo)} categoria=${String(corpo.categoriaDoBloqueio)}`);
    console.log(`    passos: ${passos.map((p) =>
      `${p.funcaoId}=${p.desfecho}${p.codigo ? `/${p.codigo}` : ""}`).join(" | ") || "nenhum"}`);
    const texto = (corpo.resposta as { conteudo?: string } | undefined)?.conteudo ?? "";
    console.log(`    resposta (${texto.length} chars): ${texto.slice(0, 120)}`);

    const { data: aud } = await db.from("agente_funcao_chamadas")
      .select("funcao_id, fase, status, codigo_desfecho, mensagem_desfecho")
      .eq("agente_id", AGENTE).order("criado_em", { ascending: false }).limit(6);
    console.log("    auditoria:");
    for (const a of (aud ?? []) as Record<string, unknown>[]) {
      console.log(`      ${String(a.funcao_id)} ${String(a.fase)}/${String(a.status)} ` +
        `${String(a.codigo_desfecho)} — ${String(a.mensagem_desfecho).slice(0, 80)}`);
    }

    for (const t of ["agente_capacidades_pendentes", "agente_conexoes",
      "agente_conversas", "agente_permissoes"]) {
      await db.from(t).delete().eq("user_id", DONO);
    }
    await db.from("lojas").delete().eq("user_id", DONO);
    await db.from("lojas").update({ ativo: false, access_token: null })
      .eq("user_id", DONO);
    await db.from("agentes").update({ ativo: false }).eq("user_id", DONO);
  }
}

void main();
