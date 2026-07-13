-- ============================================================
-- Migração: loja_id em `pedidos` (referência estável à loja)
-- Gerado em: 2026-07-11
-- Contexto: docs/DECISIONS.md "Decisão de arquitetura — loja_id como
-- referência principal (2026-07-11)". Substitui a dependência de `conta`
-- (nickname, capturado no momento do sync e não estável — pode mudar se o
-- vendedor renomear a loja no marketplace) como forma de identificar a
-- qual loja um pedido pertence. `lojas.id` (uuid) já existe, é permanente
-- e nunca muda.
--
-- EXECUTADA em 2026-07-11. Backfill correspondente (scripts/backfill-loja-id.sql)
-- também executado e validado: 350.298 de 350.298 pedidos com loja_id, 0 sem
-- correspondência, 0 colisão de nickname. Ver docs/CHANGELOG.md 2026-07-11.
-- Usa IF NOT EXISTS — seguro re-executar caso precise.
--
-- O QUE ESTA MIGRATION FAZ:
--   - Adiciona a coluna `loja_id` (nullable) em `pedidos`.
--   - Cria índice para consultas por loja_id.
--
-- O QUE ESTA MIGRATION NÃO FAZ:
--   - Não preenche `loja_id` nos pedidos já existentes — isso é o
--     backfill, um script separado (scripts/backfill-loja-id.sql), com
--     validação antes e depois, rodado manualmente DEPOIS desta migration.
--   - Não apaga nem altera `conta` ou `marketplace` — continuam existindo,
--     agora como campos de exibição/denormalizados, não mais como chave
--     de identidade da loja.
--   - Não torna `loja_id` obrigatório (NOT NULL) — pedidos sincronizados
--     antes da atualização de sync-shopee.ts/sync-ml.ts (que passarão a
--     gravar loja_id em pedidos novos) ficam com loja_id NULL até o
--     backfill rodar. Forçar NOT NULL agora quebraria o insert desses
--     syncs ainda não atualizados.
--   - Não altera nenhuma regra financeira (faturamento, lucro, margem,
--     comissão) nem nenhuma query existente — é uma adição pura, nada
--     que já funciona hoje passa a exigir loja_id preenchido.
-- ============================================================

ALTER TABLE pedidos
  ADD COLUMN IF NOT EXISTS loja_id UUID REFERENCES lojas(id);

CREATE INDEX IF NOT EXISTS idx_pedidos_loja_id
  ON pedidos (loja_id);

-- Índice composto para o padrão de leitura mais comum depois da migração
-- (Dashboard/Vendas filtrando por um conjunto de lojas + intervalo de data).
CREATE INDEX IF NOT EXISTS idx_pedidos_loja_data
  ON pedidos (loja_id, data);

COMMENT ON COLUMN pedidos.loja_id IS
  'Referência estável à loja (lojas.id). Substitui `conta` (nickname) como identificador de qual loja o pedido pertence — nickname pode mudar, loja_id nunca muda. NULL em pedidos sincronizados antes de 2026-07-11 até o backfill rodar (scripts/backfill-loja-id.sql). sync-shopee.ts/sync-ml.ts gravam este campo diretamente em pedidos novos a partir desta data (mudança de código ainda pendente de aprovação separada — ver docs/DECISIONS.md).';
