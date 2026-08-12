-- ============================================================
-- Migração: índices de performance para /api/admin/shopee/reconciliar-financeiro
-- Gerado em: 2026-07-07
-- Contexto: a rotina de reconciliação financeira (get_escrow_detail) filtra
-- pedidos por order_id e por status_shopee_raw. Nenhum dos dois tinha índice,
-- e a tabela `pedidos` já acumulou histórico suficiente para que essas
-- consultas estourem o statement_timeout do Postgres em produção — erro real
-- observado: "canceling statement due to statement timeout" ao testar
-- ?order_id=260703NQEF2K3W.
--
-- NÃO EXECUTADO AINDA. Rodar manualmente no SQL Editor do Supabase.
-- Usa IF NOT EXISTS — seguro re-executar.
--
-- O QUE ESTA MIGRATION NÃO FAZ:
--   - Não altera nenhum dado existente.
--   - Não altera nenhuma regra de negócio, fórmula ou coluna.
--   - Apenas cria índices para acelerar buscas já existentes.
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_pedidos_order_id_lookup
  ON pedidos (user_id, marketplace, order_id);

CREATE INDEX IF NOT EXISTS idx_pedidos_status_shopee_raw
  ON pedidos (user_id, marketplace, status_shopee_raw)
  WHERE marketplace = 'Shopee';
