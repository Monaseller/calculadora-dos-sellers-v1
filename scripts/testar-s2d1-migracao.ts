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
const ARQ = "20261027_s2d1_shopee_foundation.sql";
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
  // coluna gerada: mesma semantica de "escrow atual" do servico canonico e do motor (S2-D3-A.1: so < e pendente)
  if (!/escrow_pendente boolean GENERATED ALWAYS AS \( pay_time IS NOT NULL AND \(escrow_fetched_at IS NULL OR escrow_update_time IS NULL OR escrow_update_time < update_time\) \) STORED/i.test(s)) {
    e.push("coluna gerada escrow_pendente ausente ou com regra diferente");
  }
  // S2-D2.2: a FUNDACAO coexiste com o sync legado — a chave unica de item
  // por loja e de CUTOVER (supabase/cutover/), nunca da fundacao.
  if (/pedidos_shopee_item_por_loja_unico/i.test(s)) e.push("chave unica de item por loja na FUNDACAO (e de cutover)");
  // so a tabela nova recebe a coluna gerada
  for (const m of s.matchAll(/ALTER TABLE (?:public\.)?(\w+) [^;]*GENERATED/gi)) e.push(`coluna gerada em tabela existente: ${m[1]}`);
  // FOUNDATION_BREAKS_LEGACY_WRITE = NO: em tabela EXISTENTE so mudanca aditiva
  // que nao rejeita nenhuma escrita antes aceita.
  for (const m of s.matchAll(/CREATE (UNIQUE )?INDEX (\w+) ON (?:public\.)?(\w+)/gi)) {
    if (m[3].toLowerCase() !== "shopee_pedidos" && m[1]) e.push(`indice UNICO em tabela existente: ${m[3]}.${m[2]}`);
  }
  if (/\bCREATE (OR REPLACE )?TRIGGER\b/i.test(s)) e.push("trigger na fundacao");
  for (const m of s.matchAll(/ALTER TABLE (?:public\.)?(pedidos|sync_jobs) ([^;]+);/gi)) {
    const partes = m[2].split(/,(?![^()]*\))/).map((x) => x.trim());
    const novas = partes.filter((x) => /^ADD COLUMN /i.test(x)).map((x) => x.split(/\s+/)[2].toLowerCase());
    for (const parte of partes) {
      if (/^ADD COLUMN /i.test(parte)) {
        if (/\bNOT NULL\b|\bDEFAULT\b|\bUNIQUE\b|\bPRIMARY KEY\b|\bREFERENCES\b/i.test(parte)) e.push(`${m[1]}: coluna nova restritiva "${parte.slice(0, 60)}"`);
      } else if (/^ADD CONSTRAINT \w+ CHECK /i.test(parte)) {
        // CHECK so pode olhar colunas NOVAS (nulas) — nunca colunas que o legado grava
        const ids = (parte.replace(/^ADD CONSTRAINT \w+ CHECK /i, "").replace(/'[^']*'/g, "").match(/[a-z_][a-z0-9_]*/gi) ?? [])
          .map((x) => x.toLowerCase()).filter((x) => !["is", "null", "not", "or", "and", "in"].includes(x));
        const velhas = ids.filter((x) => !novas.includes(x));
        if (velhas.length) e.push(`${m[1]}: CHECK em coluna existente (${velhas.join(",")})`);
      } else if (/^ADD CONSTRAINT /i.test(parte)) e.push(`${m[1]}: constraint nao-CHECK em tabela existente "${parte.slice(0, 60)}"`);
    }
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
const UNICA = "CREATE UNIQUE INDEX pedidos_shopee_item_por_loja_unico ON public.pedidos (loja_id, order_id, ml_item_id, variation_id) NULLS NOT DISTINCT WHERE marketplace = 'Shopee';";
t("8l. chave unica de item na FUNDACAO → pega (ela e de cutover)", () => assert(pega(variante(/^COMMIT;$/m, `${UNICA}\nCOMMIT;`), /FUNDACAO \(e de cutover\)/), "nao pegou"));
t("8m. qualquer indice UNICO novo em tabela existente → pega", () => assert(pega(variante(/^COMMIT;$/m, "CREATE UNIQUE INDEX x ON public.sync_jobs (loja_id, criado_em);\nCOMMIT;"), /indice UNICO em tabela existente/), "nao pegou"));
t("8m2. coluna nova NOT NULL / DEFAULT / UNIQUE em tabela existente → pega (rejeitaria escrita do legado)", () => {
  for (const sub of ["escrow_coin           numeric NOT NULL", "escrow_coin           numeric NULL DEFAULT 0", "escrow_coin           numeric NULL UNIQUE"]) {
    assert(pega(variante("escrow_coin           numeric NULL", sub), /coluna nova restritiva/), `nao pegou: ${sub}`);
  }
});
t("8m3. CHECK que olha coluna que o legado grava → pega", () => assert(pega(variante(/(ADD CONSTRAINT sync_jobs_janela_check CHECK \()/, "ADD CONSTRAINT x CHECK (status <> 'erro'),\n  $1"), /CHECK em coluna existente \(status\)/), "nao pegou"));
t("8m4. trigger ou coluna gerada em tabela existente → pega", () => {
  assert(pega(variante(/^COMMIT;$/m, "CREATE TRIGGER t BEFORE INSERT ON public.pedidos FOR EACH ROW EXECUTE FUNCTION f();\nCOMMIT;"), /trigger/), "trigger");
  assert(pega(variante("ADD COLUMN escrow_coin           numeric NULL", "ADD COLUMN escrow_coin numeric GENERATED ALWAYS AS (0) STORED"), /coluna gerada em tabela existente|restritiva/), "gerada");
});
t("8n. escrow_pendente com regra antiga (DISTINCT FROM: '>' viraria pendente → refetch repetitivo) → pega", () => assert(pega(variante(/escrow_update_time IS NULL OR escrow_update_time < update_time(\)\r?\n\s*\) STORED)/, "escrow_update_time IS DISTINCT FROM update_time$1"), /escrow_pendente/), "nao pegou"));
t("8n2. escrow_pendente com <= ('==' viraria pendente) → pega", () => assert(pega(variante(/escrow_update_time < update_time(\)\r?\n\s*\) STORED)/, "escrow_update_time <= update_time$1"), /escrow_pendente/), "nao pegou"));
t("8n3. escrow_pendente sem o caso escrow_update_time IS NULL → pega", () => assert(pega(variante(/escrow_update_time IS NULL OR (escrow_update_time < update_time\)\r?\n\s*\) STORED)/, "$1"), /escrow_pendente/), "nao pegou"));
t("8o. as variantes dos auto-testes de fato alteram o SQL (nenhum auto-teste e vazio)", () => {
  assert(variante("escrow_coin           numeric NULL", "escrow_coin           numeric NOT NULL") !== SQL, "8m2 nao mudou nada");
  assert(variante(/(ADD CONSTRAINT sync_jobs_janela_check CHECK \()/, "X$1") !== SQL, "8m3 nao mudou nada");
  assert(variante(/escrow_update_time IS NULL OR escrow_update_time < update_time(\)\r?\n\s*\) STORED)/, "escrow_update_time IS DISTINCT FROM update_time$1") !== SQL, "8n nao mudou nada");
  assert(variante(/escrow_update_time < update_time(\)\r?\n\s*\) STORED)/, "escrow_update_time <= update_time$1") !== SQL, "8n2 nao mudou nada");
  assert(variante(/escrow_update_time IS NULL OR (escrow_update_time < update_time\)\r?\n\s*\) STORED)/, "$1") !== SQL, "8n3 nao mudou nada");
});
t("8p. A-F: a expressao REAL do arquivo, avaliada caso a caso (so '<' ou nunca lido e pendente)", () => {
  const m = SQL.match(/escrow_pendente\s+boolean\s+GENERATED ALWAYS AS \(([\s\S]*?)\)\s*STORED/i);
  assert(m, "expressao nao encontrada");
  // traducao fechada: qualquer token fora deste vocabulario derruba o teste
  let js = m[1].replace(/\s+/g, " ").trim()
    .replace(/(\w+) IS NOT NULL/g, "(r.$1 !== null)")
    .replace(/(\w+) IS NULL/g, "(r.$1 === null)")
    .replace(/(\w+) < (\w+)/g, "(r.$1 !== null && r.$2 !== null && r.$1 < r.$2)")
    .replace(/ AND /g, " && ").replace(/ OR /g, " || ");
  assert(/^[\sa-z_.()!=&|<null]+$/.test(js) && !/[A-Z]/.test(js), `token SQL nao traduzido: ${js}`);
  const f = new Function("r", `return ${js};`) as (r: Record<string, number | null>) => boolean;
  const U = 1000;
  for (const [caso, r, esperado] of [
    ["A pay_time NULL", { pay_time: null, escrow_fetched_at: null, escrow_update_time: null, update_time: U }, false],
    ["B escrow_fetched_at NULL", { pay_time: 1, escrow_fetched_at: null, escrow_update_time: null, update_time: U }, true],
    ["C escrow_update_time NULL", { pay_time: 1, escrow_fetched_at: 5, escrow_update_time: null, update_time: U }, true],
    ["D <", { pay_time: 1, escrow_fetched_at: 5, escrow_update_time: U - 1, update_time: U }, true],
    ["E ==", { pay_time: 1, escrow_fetched_at: 5, escrow_update_time: U, update_time: U }, false],
    ["F >", { pay_time: 1, escrow_fetched_at: 5, escrow_update_time: U + 1, update_time: U }, false],
  ] as const) assert(f(r) === esperado, `${caso}: ${f(r)}`);
});
t("9. FOUNDATION_BREAKS_LEGACY_WRITE = NO: nenhum writer legado de pedidos/sync_jobs grava as colunas novas", () => {
  const legados = ["lib/sync-shopee.ts", "lib/sync-ml.ts", "lib/shopee-status.ts", "lib/shopee-financeiro.ts",
    "app/api/admin/shopee/backfill-pedidos-0707/route.ts", "app/api/admin/shopee/reconciliar-financeiro/route.ts",
    "app/api/admin/shopee/status/route.ts", "app/api/sync/iniciar/route.ts"];
  for (const f of legados) {
    const fonte = readFileSync(join(RAIZ, f), "utf8");
    assert(!/escrow_voucher_seller|escrow_voucher_shopee|escrow_coin|shopee_pedidos|escrow_pendente/.test(fonte), `${f} toca coluna/tabela nova de pedidos`);
    // colunas novas de sync_jobs: so importam em quem escreve sync_jobs
    if (/from\(\s*["']sync_jobs["']\s*\)/.test(fonte)) {
      assert(!/\b(checkpoint|progresso|janela_inicio|janela_fim|campo_tempo|listagem_completa)\b\s*:/.test(fonte), `${f} grava coluna nova de sync_jobs`);
    }
  }
});
t("8k. guard permanente pega tabela nova aberta em migration futura", () => {
  assert(tabelasAbertas("BEGIN; CREATE TABLE public.nova (id int); COMMIT;").join() === "nova", "nao pegou");
  assert(tabelasAbertas("CREATE TABLE public.ok (id int); REVOKE ALL ON TABLE public.ok FROM PUBLIC, anon, authenticated; ALTER TABLE public.ok ENABLE ROW LEVEL SECURITY;").length === 0, "falso positivo");
  assert(tabelasAbertas("CREATE TABLE public.sem_public (id int); REVOKE ALL ON TABLE public.sem_public FROM anon, authenticated; ALTER TABLE public.sem_public ENABLE ROW LEVEL SECURITY;").join() === "sem_public", "nao exigiu PUBLIC");
});

console.log(`\n${falhou === 0 ? "✓" : "✗"} S2-D1-MIGRACAO — ${passou} passaram, ${falhou} falharam`);
process.exit(falhou === 0 ? 0 : 1);
