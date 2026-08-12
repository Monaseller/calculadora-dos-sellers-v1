-- ============================================================
-- Migração: índices (data_pagamento, loja_id) e (data_criacao, loja_id)
-- Gerado em: 2026-07-28
-- Contexto: Fase 3 da validação estatística de dashboard_resumos_diarios
-- (ver docs/DECISIONS.md "Estratégia A"). Backfill scoped de 30 dias
-- encontrou timeout real e reproduzível em 2026-07-15 na rota
-- /api/admin/backfill-resumos-diarios — a query de descoberta de lojas
-- filtrava só por user_id e fazia OR entre data_pagamento/data_criacao,
-- sem nenhum índice com a data como coluna líder, forçando o Postgres a
-- varrer boa parte dos ~375 mil pedidos do usuário pra achar 1 dia. Mesma
-- classe de bug da auditoria original do filtro manual de datas.
--
-- EXECUTADA manualmente em 2026-07-28 via CREATE INDEX CONCURRENTLY, cada
-- uma em execução separada no SQL Editor do Supabase (CONCURRENTLY não
-- pode rodar dentro de bloco de transação — enviar as duas juntas nessa
-- mesma submissão falha com "25001: CREATE INDEX CONCURRENTLY não pode
-- ser executado dentro de um bloco de transação", confirmado na prática).
-- Este arquivo documenta o que já rodou; usa IF NOT EXISTS, seguro
-- re-executar (mas CONCURRENTLY continua exigindo execução isolada).
--
-- Índices são parciais (WHERE loja_id IS NOT NULL) porque só interessam
-- pedidos já identificados por loja — mantém o índice menor e mais rápido
-- de manter. Coluna de data líder (não loja_id líder) de propósito: serve
-- à query "qual loja tem pedido nesta data", direção oposta ao índice
-- (loja_id, data) que já existe (idx_pedidos_loja_data) e serve "quais
-- pedidos desta loja nesta data" — os dois padrões de leitura coexistem,
-- não são redundantes entre si.
--
-- O QUE ESTA MIGRATION NÃO FAZ:
--   - Não altera nenhum dado de `pedidos`.
--   - Não substitui nenhum índice existente.
-- ============================================================

-- Rodar CADA bloco abaixo SEPARADAMENTE no SQL Editor do Supabase — nunca
-- os dois juntos na mesma submissão, e nunca dentro de BEGIN/COMMIT.

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_pedidos_data_pagamento_loja
  ON pedidos (data_pagamento, loja_id)
  WHERE loja_id IS NOT NULL AND data_pagamento IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_pedidos_data_criacao_loja
  ON pedidos (data_criacao, loja_id)
  WHERE loja_id IS NOT NULL AND data_criacao IS NOT NULL;
