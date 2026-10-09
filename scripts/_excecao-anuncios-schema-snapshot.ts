/**
 * ANUNCIOS SCHEMA SNAPSHOT C1 — excecao EXATA do guard cron #23 para
 * sincronizar o snapshot de public.anuncios com PRODUCAO (fase 1 aplicada:
 * anuncios.loja_id uuid, nulo, sem default, coluna 25).
 *
 * Camada SOBRE scripts/_excecao-anuncios-multi-store.ts: cada arquivo abaixo
 * so passa se, revertendo EXATAMENTE os hunks aprovados (gerados do diff
 * contra 0115870), o resultado for BYTE-IDENTICO ao blob de 0115870 — e se o
 * arquivo na base do guard for um blob aprovado (pinado abaixo). Sem curinga:
 *   - docs/schema/anuncios.colunas.json: + loja_id (ultima entrada);
 *   - lib/anuncios/colunas.ts: + "loja_id" em DB_ANUNCIO_COLUMNS e a projecao
 *     da tela exclui user_id E loja_id (payload da tela inalterado).
 * Este helper e auto-pinado (sha256 com o proprio literal zerado).
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const BASE_ANUNCIOS_SCHEMA_SNAPSHOT = "0115870";
export const HELPER_ANUNCIOS_SCHEMA_SNAPSHOT = "scripts/_excecao-anuncios-schema-snapshot.ts";

const SHA256_HELPER_ANUNCIOS_SCHEMA_SNAPSHOT = "090d838e9cff37fbe9f03a36a6c7010bf827abf39bccf120186b25a03db283a6";
const BLOBS_BASE_APROVADOS: Record<string, string[]> = {
  "docs/schema/anuncios.colunas.json": [
    "282a63d80b1254d19625bd30f5f58e334a426745"
  ],
  "lib/anuncios/colunas.ts": [
    "768edbd1263b54456a4e4068d864add2aa7908e7"
  ]
};
const PATCH: Record<string, { base: string; novo: string }[]> = {
  "docs/schema/anuncios.colunas.json": [
    {
      "base": "    { \"nome\": \"logistic_type\", \"tipo\": \"text\", \"nulo\": true, \"default\": false },\n    { \"nome\": \"user_id\", \"tipo\": \"text\", \"nulo\": true, \"default\": false }\n  ]",
      "novo": "    { \"nome\": \"logistic_type\", \"tipo\": \"text\", \"nulo\": true, \"default\": false },\n    { \"nome\": \"user_id\", \"tipo\": \"text\", \"nulo\": true, \"default\": false },\n    { \"nome\": \"loja_id\", \"tipo\": \"uuid\", \"nulo\": true, \"default\": false }\n  ]"
    }
  ],
  "lib/anuncios/colunas.ts": [
    {
      "base": "  \"peso_kg\", \"variation_id\", \"logistic_type\", \"user_id\",\n] as const;",
      "novo": "  \"peso_kg\", \"variation_id\", \"logistic_type\", \"user_id\",\n  // ANUNCIOS MULTI-LOJA (fase 1 aplicada em producao): loja Shopee do anuncio\n  \"loja_id\",\n] as const;"
    },
    {
      "base": "\n/** Meus Produtos (lista + edição): todas as colunas físicas, menos o dono. */\nexport const COLUNAS_ANUNCIO_TELA: string = DB_ANUNCIO_COLUMNS\n  .filter((c) => c !== \"user_id\")\n  .join(\", \");",
      "novo": "\n/**\n * Meus Produtos (lista + edição): todas as colunas físicas, menos o dono e a\n * loja (`loja_id` não vai ao browser sem decisão própria — payload inalterado).\n */\nexport const COLUNAS_ANUNCIO_TELA: string = DB_ANUNCIO_COLUMNS\n  .filter((c) => c !== \"user_id\" && c !== \"loja_id\")\n  .join(\", \");"
    }
  ]
};

const lf = (s: string) => s.replace(/\r\n/g, "\n");
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
function blob(raiz: string, rev: string, arquivo: string): string | null {
  try { return lf(execFileSync("git", ["show", `${rev}:${arquivo}`], { cwd: raiz, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })); }
  catch { return null; }
}
function idBlob(raiz: string, rev: string, arquivo: string): string | null {
  try { return execFileSync("git", ["rev-parse", `${rev}:${arquivo}`], { cwd: raiz, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); }
  catch { return null; }
}
function ler(raiz: string, arquivo: string): string | null {
  try { return lf(readFileSync(join(raiz, arquivo), "utf8")); } catch { return null; }
}

/** Arquivo atual − hunks aprovados = 0115870, byte a byte (cada hunk exatamente uma vez). */
export function arquivoExatoAnunciosSchemaSnapshot(raiz: string, arquivo: string): boolean {
  const hunks = PATCH[arquivo];
  let s = hunks ? ler(raiz, arquivo) : null;
  if (s === null) return false;
  for (const h of hunks) {
    if (s.split(h.novo).length !== 2) return false;
    s = s.replace(h.novo, () => h.base);
  }
  const base = blob(raiz, BASE_ANUNCIOS_SCHEMA_SNAPSHOT, arquivo);
  return base !== null && s === base;
}

export function helperExatoAnunciosSchemaSnapshot(raiz: string): boolean {
  const s = ler(raiz, HELPER_ANUNCIOS_SCHEMA_SNAPSHOT);
  return s !== null && sha(s.replace(/const SHA256_HELPER_ANUNCIOS_SCHEMA_SNAPSHOT = "[0-9a-f]{64}";/, `const SHA256_HELPER_ANUNCIOS_SCHEMA_SNAPSHOT = "${"0".repeat(64)}";`)) === SHA256_HELPER_ANUNCIOS_SCHEMA_SNAPSHOT;
}

/** Remove da lista SO o que esta excecao cobre (os 2 arquivos exatos com base aprovada; o helper exato ausente na base). */
export function filtrarExcecaoAnunciosSchemaSnapshot(raiz: string, base: string, alterados: string[]): string[] {
  return alterados.filter((f) => {
    if (f in PATCH) { const b = idBlob(raiz, base, f); return !(b !== null && BLOBS_BASE_APROVADOS[f].includes(b) && arquivoExatoAnunciosSchemaSnapshot(raiz, f)); }
    if (f === HELPER_ANUNCIOS_SCHEMA_SNAPSHOT && blob(raiz, base, f) === null) return !helperExatoAnunciosSchemaSnapshot(raiz);
    return true;
  });
}
