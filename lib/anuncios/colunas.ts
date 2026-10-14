/**
 * Colunas FÍSICAS de `public.anuncios` vs campos só de interface (SEC-3-B3.3).
 *
 * ── Por que existe ──────────────────────────────────────────────────
 * O SEC-3-B2 montou a projeção da API a partir da interface TypeScript
 * `Anuncio` (lib/supabase.ts). Essa interface tem campos que NÃO existem
 * na tabela (`lucro_liquido`, `margem_contribuicao`), o PostgREST recusou
 * o SELECT e GET /api/anuncios passou a responder 500 — a tela ficou vazia.
 *
 * Regra a partir daqui: SELECT de `anuncios` só com colunas desta lista.
 * A interface pode continuar tendo campos derivados; eles não viram SQL.
 *
 * Fonte versionada: docs/schema/anuncios.colunas.json (snapshot do
 * information_schema). `scripts/testar-anuncios-esquema.ts` falha se esta
 * lista, as projeções ou qualquer `.from("anuncios").select("...")` do
 * código divergirem do snapshot.
 */

/** As colunas que existem de fato na tabela, na ordem do banco. */
export const DB_ANUNCIO_COLUMNS = [
  "id", "created_at", "nome", "marketplace", "categoria", "tipo_anuncio", "tipo_conta_shopee",
  "custo_produto", "insumos", "custo_frete", "frete_gratis", "imposto", "margem_desejada",
  "preco_ideal", "ativo", "ml_item_id", "sku", "preco_anuncio", "thumbnail", "permalink",
  "peso_kg", "variation_id", "logistic_type", "user_id",
  // ANUNCIOS MULTI-LOJA (fase 1 aplicada em producao): loja Shopee do anuncio
  "loja_id",
  // CDS V2 Fase 2H-B (aplicada em producao): observacao do marketplace. Gravada SO pelo helper de
  // observacao (I9); aqui so entra na leitura da tela (I11) — nunca em CAMPOS_GRAVAVEIS.
  "status_marketplace", "visto_em",
] as const;

export type ColunaAnuncio = (typeof DB_ANUNCIO_COLUMNS)[number];

/**
 * Campos da interface `Anuncio` que NÃO são colunas — calculados/derivados
 * na interface. Nunca entram em SELECT, INSERT ou UPDATE.
 */
export const DERIVED_UI_FIELDS = ["lucro_liquido", "margem_contribuicao"] as const;

/**
 * Meus Produtos (lista + edição): todas as colunas físicas, menos o dono.
 * CDS V2 Fase 2D: `loja_id` vai ao browser como identidade TÉCNICA da loja (sem hash paralelo):
 * a tela agrupa ML por marketplace|loja_id|ml_item_id para nunca fundir lojas. Não é exibido e
 * não é autoridade — toda escrita revalida loja no servidor.
 * CDS V2 Fase 2H-E: a observação do marketplace também vai, SÓ para exibição (somente leitura).
 */
export const COLUNAS_ANUNCIO_TELA: string = DB_ANUNCIO_COLUMNS
  .filter((c) => c !== "user_id")
  .join(", ");

/**
 * Dashboard: as colunas que ele pedia, menos `margem_contribuicao` (não
 * existe — essa consulta já falhava em Production desde antes do SEC-3).
 */
export const COLUNAS_ANUNCIO_DASHBOARD: string = ([
  "ml_item_id", "thumbnail", "nome", "sku", "marketplace", "custo_produto", "preco_anuncio",
] satisfies ColunaAnuncio[]).join(", ");
