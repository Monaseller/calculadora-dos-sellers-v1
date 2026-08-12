#!/usr/bin/env node
/**
 * Cria o projeto e o job sintéticos usados para validar o teste "ping"
 * da Fase 0 (AI Gateway fake + fila). NÃO faz parte do fluxo de
 * produção — é só o setup manual desta tarefa de validação.
 *
 * Cria (e NÃO apaga depois — os registros ficam para revisão):
 *   1 linha em estudio_anuncios_projetos (nome_produto = "TESTE_FASE_0_PING")
 *   1 linha em estudio_anuncios_jobs (etapa = "ping", status = "pendente",
 *     provedor = "fake")
 *
 * user_id usado é um valor de teste fixo ("teste-fase-0-ping"), não um
 * usuário real do CDS — escolhido de propósito para nunca colidir com
 * um user_id de produção nem aparecer em nenhuma tela real (nenhuma
 * tela hoje lista projetos deste módulo).
 *
 * Uso: node scripts/testar-estudio-anuncios-ping.mjs
 * Depois: node scripts/estudio-anuncios-worker.mjs (com `npm run dev` já rodando)
 */
import { createClient } from "@supabase/supabase-js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function carregarEnvLocal() {
  try {
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const envPath = path.join(__dirname, "..", ".env.local");
    const raw = fs.readFileSync(envPath, "utf-8");
    for (const linha of raw.split("\n")) {
      const l = linha.trim();
      if (!l || l.startsWith("#")) continue;
      const idx = l.indexOf("=");
      if (idx === -1) continue;
      const chave = l.slice(0, idx).trim();
      let valor = l.slice(idx + 1).trim();
      if ((valor.startsWith('"') && valor.endsWith('"')) || (valor.startsWith("'") && valor.endsWith("'"))) {
        valor = valor.slice(1, -1);
      }
      if (!(chave in process.env)) process.env[chave] = valor;
    }
  } catch {
    // .env.local ausente/ilegível — segue só com o que já estiver em process.env
  }
}
carregarEnvLocal();

const SUPABASE_URL     = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error("ERRO: NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY ausentes (defina em .env.local).");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

async function main() {
  const { data: projeto, error: erroProjeto } = await supabase
    .from("estudio_anuncios_projetos")
    .insert({
      user_id: "teste-fase-0-ping",
      nome_produto: "TESTE_FASE_0_PING",
      status: "rascunho",
    })
    .select("id")
    .single();

  if (erroProjeto) {
    console.error("ERRO ao criar projeto de teste:", erroProjeto.message);
    process.exit(1);
  }

  const { data: job, error: erroJob } = await supabase
    .from("estudio_anuncios_jobs")
    .insert({
      projeto_id: projeto.id,
      etapa: "ping",
      status: "pendente",
      provedor: "fake",
    })
    .select("id")
    .single();

  if (erroJob) {
    console.error("ERRO ao criar job de teste:", erroJob.message);
    process.exit(1);
  }

  console.log("Projeto de teste criado:", projeto.id);
  console.log("Job de teste criado:", job.id);
  console.log("\nPróximo passo: com `npm run dev` já rodando, execute:");
  console.log("  node scripts/estudio-anuncios-worker.mjs");
}

main();
