-- =====================================================================
-- CDS-STABILIZATION S2 — CUTOVER: CHAVE UNICA DE ITEM SHOPEE POR LOJA
--
-- *** NAO APLICAR AINDA. ***
-- Este arquivo fica FORA de supabase/migrations de proposito: nenhuma
-- ferramenta de migration o aplica sozinha. No gate de cutover ele sera
-- movido para supabase/migrations com um timestamp MAIOR que o da ultima
-- migration aplicada naquele momento (nunca reaproveitar timestamp antigo
-- — a ordem de aplicacao tem que ficar correta).
-- =====================================================================
--
-- O QUE FAZ
-- ---------------------------------------------------------------------
-- Garante no banco que (loja, pedido, item, variacao) Shopee e UMA linha
-- em public.pedidos. O `pedidos.id` legado
-- (<user>_SHOPEE_<order_sn>_<item>_<model|nv>) nao contem a loja; o motor
-- novo ja resolve o id pela chave da loja (normalizar.resolverIdsDeItens),
-- e este indice passa a ser a garantia do banco. Parcial (so Shopee): o ML
-- nao e afetado. NULLS NOT DISTINCT: item sem variacao (variation_id NULL)
-- tambem e unico. Sem reescrita de tabela (so construcao de indice).
--
-- POR QUE NAO VAI NA FUNDACAO
-- ---------------------------------------------------------------------
-- O sync Shopee legado continua ativo com ENABLE_ASYNC_SYNC_JOBS OFF e:
--   - gera pedidos.id sem loja (sem o resolver por loja do motor novo);
--   - cobre so uma loja por usuario em alguns caminhos;
--   - nao propaga erro de gravacao ao usuario: lib/sync-shopee.ts conta
--     `upsertErrors` (so impede o cursor de avancar), e
--     app/api/shopee/vendas/route.ts e app/api/sync/route.ts nao leem esse
--     contador. Uma gravacao rejeitada por este indice falharia de novo a
--     cada execucao, sem sinal visivel.
--
-- STORE_SCOPED_UNIQUE_INDEX_APPLY_CONDITION — so aplicar quando TODAS valem:
--   1. o motor novo (lib/shopee/ingestao) for o writer oficial de pedidos
--      Shopee;
--   2. o caminho Shopee legado incompativel (lib/sync-shopee.ts upsert por
--      id sem loja, chamado por app/api/shopee/vendas e app/api/sync)
--      estiver desabilitado ou atualizado para a chave por loja;
--   3. a auditoria IMEDIATAMENTE anterior mostrar 0 duplicatas da chave:
--        SELECT count(*) FROM (
--          SELECT loja_id, order_id, ml_item_id, variation_id
--          FROM public.pedidos WHERE marketplace = 'Shopee'
--          GROUP BY 1, 2, 3, 4 HAVING count(*) > 1) d;      -- tem que ser 0
--      (GROUP BY trata NULL como igual, como o NULLS NOT DISTINCT);
--   4. nenhum writer de pedidos Shopee ignore erro de gravacao (o erro tem
--      que falhar a fatia/job, nunca virar "sync ok").
-- Medido em 2026-10-05: 0 duplicatas em 290.558 linhas Shopee — vale so
-- como referencia; a condicao 3 exige auditoria nova no dia do cutover.
--
-- ROLLBACK (MANUAL)
-- ---------------------------------------------------------------------
--     DROP INDEX public.pedidos_shopee_item_por_loja_unico;
-- =====================================================================

BEGIN;

CREATE UNIQUE INDEX pedidos_shopee_item_por_loja_unico
  ON public.pedidos (loja_id, order_id, ml_item_id, variation_id) NULLS NOT DISTINCT
  WHERE marketplace = 'Shopee';

COMMIT;
