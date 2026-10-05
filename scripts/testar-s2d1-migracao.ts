/**
 * Guard offline da migration S2-D1 (fundacao canonica Shopee) + guard
 * permanente "tabela nova nasce fechada".
 *
 *  1. shopee_pedidos: colunas, tipos, nulidade, PK (loja_id, order_sn),
 *     FK de dono (loja_id, user_id) -> lojas, os 3 indices do blueprint;
 *  2. nasce FECHADA: REVOKE anon/authenticated, ENABLE RLS, zero policy,
 *     sem FORCE, sem GRANT;
 *  3. pedidos: 3 colunas numeric NULL SEM default (NULL != 0);
 *  4. sync_jobs: checkpoint/progresso + janela de cobertura;
 *  5. as 15 tabelas SEC-3 so recebem ADD COLUMN (nada de grant/RLS/policy);
 *  6. transacional; nenhum resultado calculado armazenado;
 *  7. GUARD PERMANENTE: toda migration >= SEC-3-C que crie tabela em public
 *     tem de fechá-la no mesmo arquivo (REVOKE anon+authenticated e RLS).
 * Validadores puros + auto-teste com SQL ruim.
 *
 * Uso: npx tsx scripts/testar-s2d1-migracao.ts
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

let passou = 0, falhou = 0;
function t(nome: string, fn: () => void) {
  try { fn(); passou++; console.log(`  PASS  ${nome}`); }
  catch (e: any) { falhou++; console.log(`  FALHA ${nome} -> ${e?.message ?? e}`); }
}
function assert(c: unknown, m: string): asserts c { if (!c) throw new Error(m); }

const RAIZ = join(__dirname, "..");
const DIR = join(RAIZ, "supabase/migrations");
const ARQ = "20261027_s2d1_shopee_pedidos_canonico.sql";
const semComentarios = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--[^\n]*/g, "");
const norm = (s: string) => semComentarios(s).replace(/\s+/g, " ").trim();
const SQL = readFileSync(join(DIR, ARQ), "utf8");
const N = norm(SQL);

const SEC3 = ["pedidos", "anuncios", "sync_jobs", "vendas_dia", "dashboard_resumos_diarios",
  "estudio_anuncios_conteudo_versoes", "estudio_anuncios_imagens_origem", "estudio_anuncios_jobs",
  "estudio_anuncios_pipeline", "estudio_anuncios_pipeline_catalogo", "estudio_anuncios_pipeline_catalogo_jobs",
  "estudio_anuncios_projetos", "estudio_anuncios_projetos_marketplace", "estudio_anuncios_resultados_pipeline",
  "estudio_anuncios_validacoes_publicacao"];

/** Tabelas criadas no arquivo que NAO nascem fechadas no mesmo arquivo. */
function tabelasAbertas(sqlBruto: string): string[] {
  const s = norm(sqlBruto);
  const criadas = [...s.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?(?:public\.)?(\w+)/gi)].map((m) => m[1].toLowerCase());
  return criadas.filter((tab) => {
    const revoga = [...s.matchAll(/REVOKE ALL(?: PRIVILEGES)? ON (?:TABLE )?([^;]+?) FROM ([^;]+?);/gi)]
      .some((m) => m[1].split(",").map((x) => x.trim().replace(/^public\./i, "").toLowerCase()).includes(tab)
        // S2-D1.1: fail-closed explicito — PUBLIC, anon E authenticated.
        && /\bPUBLIC\b/i.test(m[2]) && /\banon\b/i.test(m[2]) && /\bauthenticated\b/i.test(m[2]));
    const rls = new RegExp(`ALTER TABLE (?:public\\.)?${tab} ENABLE ROW LEVEL SECURITY`, "i").test(s);
    return !(revoga && rls);
  });
}

/** Violacoes da S2-D1 (vazio = valida). */
function validarS2D1(sqlBruto: string): string[] {
  const e: string[] = [];
  const s = norm(sqlBruto);
  if (!/^BEGIN;/.test(s) || !/COMMIT;$/.test(s)) e.push("nao transacional");
  const ct = s.match(/CREATE TABLE public\.shopee_pedidos \((.+?)\);/i);
  if (!ct) e.push("sem CREATE TABLE public.shopee_pedidos");
  else {
    const corpo = ct[1];
    const colunas: [string, string, boolean][] = [
      ["user_id", "text", false], ["loja_id", "uuid", false], ["order_sn", "text", false],
      ["create_time", "timestamptz", false], ["update_time", "timestamptz", false], ["pay_time", "timestamptz", true],
      ["order_status", "text", true], ["cancel_by", "text", true], ["cancel_reason", "text", true],
      ["total_amount", "numeric", true], ["original_shopee_discount", "numeric", true], ["pix_discount", "numeric", true],
      ["detail_fetched_at", "timestamptz", true], ["escrow_fetched_at", "timestamptz", true], ["escrow_update_time", "timestamptz", true],
    ];
    for (const [nome, tipo, nulo] of colunas) {
      const m = corpo.match(new RegExp(`\\b${nome} (\\w+) (NOT NULL|NULL)`, "i"));
      if (!m) { e.push(`coluna ${nome} ausente`); continue; }
      if (m[1].toLowerCase() !== tipo) e.push(`${nome}: tipo ${m[1]} != ${tipo}`);
      if ((m[2].toUpperCase() === "NULL") !== nulo) e.push(`${nome}: nulidade errada`);
    }
    const declaradas = [...corpo.matchAll(/(?:^|, )(\w+) (?:text|uuid|timestamptz|numeric|jsonb|boolean|integer)\b/gi)].map((m) => m[1].toLowerCase());
    for (const proib of ["vendas", "vendas_sem_desconto", "vendas_sem_descontos", "faturamento"]) if (declaradas.includes(proib)) e.push(`resultado calculado armazenado: ${proib}`);
    if (!/CONSTRAINT shopee_pedidos_pkey PRIMARY KEY \(loja_id, order_sn\)/i.test(corpo)) e.push("PK (loja_id, order_sn) ausente");
    if (!/FOREIGN KEY \(loja_id, user_id\) REFERENCES public\.lojas \(id, user_id\)/i.test(corpo)) e.push("FK de dono ausente");
    if (/\bDEFAULT\b/i.test(corpo)) e.push("DEFAULT em shopee_pedidos");
  }
  const idx = [...s.matchAll(/CREATE INDEX (\w+) ON public\.shopee_pedidos \(([^)]+)\)( WHERE [^;]+)?;/gi)].map((m) => `${m[2].replace(/\s/g, "")}${m[3] ? "|parcial" : ""}`);
  // S2-D2.1: fila de escrow por loja em ordem de order_sn, sobre a coluna gerada
  for (const esperado of ["user_id,loja_id,pay_time", "loja_id,update_time", "user_id,loja_id,order_sn|parcial"]) if (!idx.includes(esperado)) e.push(`indice ${esperado} ausente`);
  if (!/CREATE INDEX idx_shopee_pedidos_escrow_pendente ON public\.shopee_pedidos \(user_id, loja_id, order_sn\) WHERE escrow_pendente;/i.test(s)) e.push("indice de escrow pendente nao usa a coluna gerada");
  // coluna gerada: mesma semantica de "escrow atual" do servico canonico (igualdade)
  if (!/escrow_pendente boolean GENERATED ALWAYS AS \( pay_time IS NOT NULL AND \(escrow_fetched_at IS NULL OR escrow_update_time IS DISTINCT FROM update_time\) \) STORED/i.test(s)) {
    e.push("coluna gerada escrow_pendente ausente ou com regra diferente");
  }
  // S2-D2.1: chave de ITEM por loja — indice unico parcial Shopee, NULLS NOT DISTINCT
  if (!/CREATE UNIQUE INDEX pedidos_shopee_item_por_loja_unico ON public\.pedidos \(loja_id, order_id, ml_item_id, variation_id\) NULLS NOT DISTINCT WHERE marketplace = 'Shopee';/i.test(s)) {
    e.push("chave unica de item por loja ausente/diferente");
  }
  if (idx.length !== 3) e.push(`indices em shopee_pedidos: ${idx.length} (esperado 3)`);
  if (tabelasAbertas(sqlBruto).length) e.push(`tabela nao nasce fechada: ${tabelasAbertas(sqlBruto)}`);
  if (/\bCREATE POLICY\b|\bALTER POLICY\b/i.test(s)) e.push("policy presente");
  if (/\bFORCE ROW LEVEL SECURITY\b/i.test(s)) e.push("FORCE RLS");
  if (/\bDISABLE ROW LEVEL SECURITY\b/i.test(s)) e.push("DISABLE RLS");
  if (/\bGRANT\b/i.test(s)) e.push("GRANT presente");
  // pedidos: 3 colunas numeric NULL sem default
  const ped = s.match(/ALTER TABLE public\.pedidos (ADD COLUMN [^;]+);/i);
  if (!ped) e.push("ALTER TABLE public.pedidos ausente");
  else {
    for (const c of ["escrow_voucher_seller", "escrow_voucher_shopee", "escrow_coin"]) {
      if (!new RegExp(`ADD COLUMN ${c} numeric NULL(,|$)`, "i").test(ped[1])) e.push(`pedidos.${c} nao e numeric NULL`);
    }
    if (/DEFAULT/i.test(ped[1])) e.push("DEFAULT em pedidos (destroi NULL x 0)");
  }
  const sj = s.match(/ALTER TABLE public\.sync_jobs ([^;]+);/i);
  if (!sj) e.push("ALTER TABLE public.sync_jobs ausente");
  else for (const [c, tp] of [["checkpoint", "jsonb"], ["progresso", "jsonb"], ["janela_inicio", "timestamptz"], ["janela_fim", "timestamptz"], ["campo_tempo", "text"], ["listagem_completa", "boolean"]]) {
    if (!new RegExp(`ADD COLUMN ${c} +${tp} +NULL`, "i").test(sj[1])) e.push(`sync_jobs.${c} ${tp} NULL ausente`);
  }
  // SEC-3: so ADD COLUMN / ADD CONSTRAINT / indice novo
  for (const tab of SEC3) {
    for (const m of s.matchAll(new RegExp(`ALTER TABLE (?:public\\.)?${tab} ([^;]+);`, "gi"))) {
      const partes = m[1].split(/,(?![^()]*\))/).map((x) => x.trim());
      for (const p of partes) if (!/^ADD (COLUMN|CONSTRAINT) /i.test(p)) e.push(`${tab}: alteracao nao permitida "${p.slice(0, 50)}"`);
    }
    if (new RegExp(`(REVOKE|GRANT)[^;]*\\b(public\\.)?${tab}\\b`, "i").test(s)) e.push(`${tab}: grant/revoke`);
    if (new RegExp(`(DROP|TRUNCATE)[^;]*\\b(public\\.)?${tab}\\b`, "i").test(s)) e.push(`${tab}: drop/truncate`);
  }
  return e;
}

console.log("\n[1-6. migration S2-D1]");
t("1-6. a migration S2-D1 e valida (tabela, chaves, indices, fechada, colunas, SEC-3 intocadas)", () => {
  const e = validarS2D1(SQL);
  assert(e.length === 0, e.join(" | "));
});
t("6b. rollback documentado (comentario) cobre tabela, colunas e constraints", () => {
  const coment = SQL.split("\n").filter((l) => /^--/.test(l)).join("\n");
  for (const x of ["DROP TABLE public.shopee_pedidos", "DROP COLUMN escrow_voucher_seller", "DROP COLUMN listagem_completa", "DROP INDEX public.idx_sync_jobs_cobertura"]) assert(coment.includes(x), x);
});

console.log("\n[7. guard permanente: tabela nova nasce fechada]");
t("7. toda migration a partir da SEC-3-C que cria tabela em public a fecha no mesmo arquivo", () => {
  const arqs = readdirSync(DIR).filter((f) => f.endsWith(".sql") && f >= "20261026");
  assert(arqs.includes(ARQ), "migration S2-D1 fora da varredura");
  const ruins = arqs.flatMap((f) => tabelasAbertas(readFileSync(join(DIR, f), "utf8")).map((x) => `${f}:${x}`));
  assert(ruins.length === 0, ruins.join(", "));
});

console.log("\n[8. auto-teste dos validadores]");
const variante = (de: string | RegExp, para: string) => SQL.replace(de, para);
const pega = (sql: string, padrao: RegExp) => validarS2D1(sql).some((x) => padrao.test(x));
t("8a. sem REVOKE → tabela nao nasce fechada", () => assert(pega(variante(/^REVOKE ALL PRIVILEGES ON TABLE public\.shopee_pedidos FROM PUBLIC, anon, authenticated;$/m, ""), /nao nasce fechada/), "nao pegou"));
t("8b. REVOKE so de anon → pego", () => assert(pega(variante("FROM PUBLIC, anon, authenticated;", "FROM anon;"), /nao nasce fechada/), "nao pegou"));
t("8b2. REVOKE sem PUBLIC → pego (fail-closed explicito)", () => assert(pega(variante("FROM PUBLIC, anon, authenticated;", "FROM anon, authenticated;"), /nao nasce fechada/), "nao pegou"));
t("8b3. a migration real revoga explicitamente de PUBLIC, anon e authenticated", () => assert(/^REVOKE ALL PRIVILEGES ON TABLE public\.shopee_pedidos FROM PUBLIC, anon, authenticated;$/m.test(SQL), "linha ausente"));
t("8c. sem ENABLE RLS → pego", () => assert(pega(variante(/^ALTER TABLE public\.shopee_pedidos ENABLE ROW LEVEL SECURITY;$/m, ""), /nao nasce fechada/), "nao pegou"));
t("8d. policy permissiva → pega", () => assert(pega(variante(/^COMMIT;$/m, "CREATE POLICY p ON public.shopee_pedidos USING (true);\nCOMMIT;"), /policy/), "nao pegou"));
t("8e. DEFAULT 0 em pedidos → pego", () => assert(pega(variante("ADD COLUMN escrow_coin           numeric NULL;", "ADD COLUMN escrow_coin numeric NULL DEFAULT 0;"), /DEFAULT|escrow_coin/), "nao pegou"));
t("8f. coluna de resultado calculado → pega", () => assert(pega(variante("  escrow_update_time       timestamptz NULL,", "  escrow_update_time       timestamptz NULL,\n  vendas numeric NULL,"), /resultado calculado/), "nao pegou"));
t("8g. GRANT em tabela SEC-3 → pego", () => assert(pega(variante(/^COMMIT;$/m, "GRANT SELECT ON public.anuncios TO anon;\nCOMMIT;"), /GRANT|anuncios/), "nao pegou"));
t("8h. DISABLE RLS em tabela SEC-3 → pego", () => assert(pega(variante(/^COMMIT;$/m, "ALTER TABLE public.vendas_dia DISABLE ROW LEVEL SECURITY;\nCOMMIT;"), /DISABLE|vendas_dia/), "nao pegou"));
t("8i. pay_time NOT NULL → nulidade errada", () => assert(pega(variante("pay_time                 timestamptz NULL", "pay_time                 timestamptz NOT NULL"), /pay_time: nulidade/), "nao pegou"));
t("8j. PK diferente → pega", () => assert(pega(variante("PRIMARY KEY (loja_id, order_sn)", "PRIMARY KEY (order_sn)"), /PK/), "nao pegou"));
t("8l. sem a chave unica de item por loja → pego", () => assert(pega(variante(/^CREATE UNIQUE INDEX pedidos_shopee_item_por_loja_unico[\s\S]*?WHERE marketplace = 'Shopee';$/m, ""), /chave unica de item por loja/), "nao pegou"));
t("8m. chave de item sem NULLS NOT DISTINCT (variation_id NULL duplicaria) → pega", () => assert(pega(variante(/variation_id\) NULLS NOT DISTINCT(\r?)$/m, "variation_id)$1"), /chave unica de item por loja/), "nao pegou"));
t("8n. escrow_pendente com regra diferente da do servico canonico (< em vez de distinto) → pega", () => assert(pega(variante(/escrow_update_time IS DISTINCT FROM update_time(\)\r?\n\s*\) STORED)/, "escrow_update_time < update_time$1"), /escrow_pendente/), "nao pegou"));
t("8o. as variantes de 8m/8n de fato alteram o SQL (o auto-teste nao e vazio)", () => {
  assert(variante(/variation_id\) NULLS NOT DISTINCT(\r?)$/m, "variation_id)$1") !== SQL, "8m nao mudou nada");
  assert(variante(/escrow_update_time IS DISTINCT FROM update_time(\)\r?\n\s*\) STORED)/, "escrow_update_time < update_time$1") !== SQL, "8n nao mudou nada");
});
t("8k. guard permanente pega tabela nova aberta em migration futura", () => {
  assert(tabelasAbertas("BEGIN; CREATE TABLE public.nova (id int); COMMIT;").join() === "nova", "nao pegou");
  assert(tabelasAbertas("CREATE TABLE public.ok (id int); REVOKE ALL ON TABLE public.ok FROM PUBLIC, anon, authenticated; ALTER TABLE public.ok ENABLE ROW LEVEL SECURITY;").length === 0, "falso positivo");
  assert(tabelasAbertas("CREATE TABLE public.sem_public (id int); REVOKE ALL ON TABLE public.sem_public FROM anon, authenticated; ALTER TABLE public.sem_public ENABLE ROW LEVEL SECURITY;").join() === "sem_public", "nao exigiu PUBLIC");
});

console.log(`\n${falhou === 0 ? "✓" : "✗"} S2-D1-MIGRACAO — ${passou} passaram, ${falhou} falharam`);
process.exit(falhou === 0 ? 0 : 1);
