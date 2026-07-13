-- ============================================================
-- Migração: status bruto original da Shopee (status_shopee_raw)
-- Gerado em: 2026-07-07
-- Contexto: auditoria de income_distribution (ver docs/DECISIONS.md
-- "income_distribution não populado de verdade") precisa saber o
-- order_status real da Shopee (COMPLETED, SHIPPED, READY_TO_SHIP etc.)
-- para correlacionar com a presença de dados financeiros oficiais.
-- Hoje só existe `status`, que já é o valor REMAPEADO pelo mapStatus()
-- (paid/cancelled/devolucao/...) — o valor bruto da Shopee é perdido.
--
-- NÃO EXECUTADO AINDA. Rodar manualmente no SQL Editor do Supabase.
-- Usa IF NOT EXISTS — seguro re-executar.
--
-- O QUE ESTA MIGRATION NÃO FAZ:
--   - Não altera a coluna `status` existente (continua sendo o valor
--     remapeado, usado por toda a regra de negócio atual).
--   - Não faz backfill em pedidos já sincronizados. `status_shopee_raw`
--     nasce NULL em pedidos antigos e só é preenchida em novos
--     syncs/resyncs (mesmo padrão adotado em `data_criacao`/`data_pagamento`,
--     ver `20260706_separacao_datas.sql`).
-- ============================================================

ALTER TABLE pedidos
  ADD COLUMN IF NOT EXISTS status_shopee_raw TEXT;

COMMENT ON COLUMN pedidos.status_shopee_raw IS
  'Status bruto original retornado pela Shopee (order_status: UNPAID, READY_TO_SHIP, SHIPPED, COMPLETED, CANCELLED, etc.), antes do remapeamento feito por mapStatus() em lib/sync-shopee.ts. Uso: auditoria/diagnóstico (ex.: correlacionar presença de income_distribution real com o ciclo de vida do pedido). NULL em pedidos sincronizados antes de 2026-07-07 (sem backfill agressivo, mesmo critério das colunas de data). Nunca usar para regra de negócio financeira — use `status` para isso.';
