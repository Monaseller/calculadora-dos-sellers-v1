-- =====================================================================
-- CDS-STABILIZATION S2-D1 — FUNDACAO CANONICA SHOPEE (FOUNDATION)
--
-- S2-D2.2: esta e a migration de FUNDACAO, segura para coexistir com o
-- sync Shopee legado (feature flag ENABLE_ASYNC_SYNC_JOBS OFF): so cria a
-- tabela nova e adiciona colunas NULAS sem default; nenhuma constraint ou
-- indice unico novo em tabela existente. A chave unica de item por loja
-- (pedidos_shopee_item_por_loja_unico) foi para a migration de CUTOVER
-- (supabase/cutover/), que so se aplica quando o motor novo for o writer
-- oficial — o legado gera ids sem loja e ignora erro de gravacao.
--   1. public.shopee_pedidos  (grao: loja + order_sn), nasce FECHADA
--   2. public.pedidos          + componentes de escrow POR ITEM
--   3. public.sync_jobs        + checkpoint/progresso + janela de cobertura
-- =====================================================================
--
-- POR QUE
-- ---------------------------------------------------------------------
-- A regra "Produto Pago" da Shopee foi provada 12/12 contra o Seller
-- Center (S2-B, 01-03/10/2026). Ela precisa de valores em DOIS graos:
--   - por ITEM:   preco × quantidade, voucher do vendedor, voucher Shopee,
--                 moedas (escrow.items.*);
--   - por PEDIDO: pay_time real, status, subsidio Shopee
--                 (original_shopee_discount) e desconto Pix.
-- `pedidos` e por ITEM (id = <user>_SHOPEE_<order_sn>_<item>_<model>):
-- gravar valor de pedido nele repetiria o valor por item e o duplicaria
-- na soma. Dai a tabela de PEDIDO, e os campos de item em `pedidos`.
-- Nenhum resultado calculado e armazenado: o servico canonico
-- (lib/vendas/canonico/shopee.ts) calcula a partir dos componentes.
--
-- SEGURANCA
-- ---------------------------------------------------------------------
-- O default privilege de tabelas criadas por `postgres` em public ja da
-- acesso so a postgres/service_role; mesmo assim o REVOKE de PUBLIC, anon e
-- authenticated e explicito e a RLS nasce ligada SEM policy (padrao
-- SEC-3-C): so o servidor, via service_role (BYPASSRLS), acessa.
-- `pedidos` e `sync_jobs` (tabelas SEC-3) recebem apenas ADD COLUMN:
-- grants, RLS e policies delas nao mudam.
--
-- NULL x 0 (escrow por item)
-- ---------------------------------------------------------------------
-- NULL = escrow ainda nao obtido; 0 = obtido e o desconto nao existe.
-- Por isso SEM DEFAULT: um default 0 apagaria essa diferenca e faria um
-- pedido sem escrow parecer "sem desconto".
--
-- COBERTURA (sync_jobs)
-- ---------------------------------------------------------------------
-- Decisao aprovada: estender sync_jobs. Uma job = uma janela de listagem
-- (`campo_tempo` + [janela_inicio, janela_fim)); `listagem_completa`
-- (NULL enquanto roda) so vira true quando a listagem inteira da janela
-- terminou sem erro. Jobs nunca sao apagados. COMPLETE(loja, periodo) =
-- janelas completas cobrindo o periodo + detail/escrow presentes por
-- pedido (shopee_pedidos). Ver lib/vendas/canonico/shopee.ts.
--
-- ROLLBACK (MANUAL — NAO EXECUTADO AQUI)
-- ---------------------------------------------------------------------
--     BEGIN;
--     DROP TABLE public.shopee_pedidos;
--     ALTER TABLE public.pedidos DROP COLUMN escrow_voucher_seller,
--       DROP COLUMN escrow_voucher_shopee, DROP COLUMN escrow_coin;
--     DROP INDEX public.idx_sync_jobs_cobertura;
--     ALTER TABLE public.sync_jobs DROP CONSTRAINT sync_jobs_janela_check,
--       DROP CONSTRAINT sync_jobs_campo_tempo_check,
--       DROP COLUMN checkpoint, DROP COLUMN progresso,
--       DROP COLUMN janela_inicio, DROP COLUMN janela_fim,
--       DROP COLUMN campo_tempo, DROP COLUMN listagem_completa;
--     COMMIT;
-- =====================================================================

BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE TABLE public.shopee_pedidos (
  user_id                  text        NOT NULL,
  loja_id                  uuid        NOT NULL,
  order_sn                 text        NOT NULL,
  create_time              timestamptz NOT NULL,
  update_time              timestamptz NOT NULL,
  pay_time                 timestamptz NULL,
  order_status             text        NULL,
  cancel_by                text        NULL,
  cancel_reason            text        NULL,
  total_amount             numeric     NULL,
  original_shopee_discount numeric     NULL,
  pix_discount             numeric     NULL,
  detail_fetched_at        timestamptz NULL,
  escrow_fetched_at        timestamptz NULL,
  escrow_update_time       timestamptz NULL,
  -- S2-D2.1: fila de catch-up de escrow. Comparar duas colunas nao e
  -- expressavel em filtro do PostgREST; a coluna gerada torna a condicao
  -- consultavel e indexavel. Mesma semantica de "escrow atual" do servico
  -- canonico e do motor (S2-D3-A.1): atual quando escrow_update_time >=
  -- update_time; pendente so se nunca lido ou lido num update_time ANTERIOR.
  -- ">" nunca e pendente (evita refetch repetitivo).
  escrow_pendente          boolean     GENERATED ALWAYS AS (
    pay_time IS NOT NULL AND (escrow_fetched_at IS NULL OR escrow_update_time IS NULL OR escrow_update_time < update_time)
  ) STORED,
  CONSTRAINT shopee_pedidos_pkey PRIMARY KEY (loja_id, order_sn),
  CONSTRAINT shopee_pedidos_loja_do_mesmo_dono FOREIGN KEY (loja_id, user_id) REFERENCES public.lojas (id, user_id)
);

-- consulta canonica: pedidos pagos de um dono/loja num intervalo
CREATE INDEX idx_shopee_pedidos_dono_loja_pay_time ON public.shopee_pedidos (user_id, loja_id, pay_time);
-- sync incremental por update_time
CREATE INDEX idx_shopee_pedidos_loja_update_time ON public.shopee_pedidos (loja_id, update_time);
-- fila de escrow (catch-up por loja, em ordem de order_sn): pedidos pagos
-- sem escrow, ou com escrow lido antes da ultima mudanca
CREATE INDEX idx_shopee_pedidos_escrow_pendente ON public.shopee_pedidos (user_id, loja_id, order_sn)
  WHERE escrow_pendente;

REVOKE ALL PRIVILEGES ON TABLE public.shopee_pedidos FROM PUBLIC, anon, authenticated;
ALTER TABLE public.shopee_pedidos ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.pedidos
  ADD COLUMN escrow_voucher_seller numeric NULL,
  ADD COLUMN escrow_voucher_shopee numeric NULL,
  ADD COLUMN escrow_coin           numeric NULL;

ALTER TABLE public.sync_jobs
  ADD COLUMN checkpoint        jsonb       NULL,
  ADD COLUMN progresso         jsonb       NULL,
  ADD COLUMN janela_inicio     timestamptz NULL,
  ADD COLUMN janela_fim        timestamptz NULL,
  ADD COLUMN campo_tempo       text        NULL,
  ADD COLUMN listagem_completa boolean     NULL,
  ADD CONSTRAINT sync_jobs_campo_tempo_check CHECK (campo_tempo IS NULL OR campo_tempo IN ('update_time', 'create_time')),
  ADD CONSTRAINT sync_jobs_janela_check CHECK (janela_inicio IS NULL OR janela_fim IS NULL OR janela_fim > janela_inicio);

-- prova de cobertura: janelas de listagem concluidas sem erro, por loja
CREATE INDEX idx_sync_jobs_cobertura ON public.sync_jobs (loja_id, campo_tempo, janela_inicio)
  WHERE listagem_completa;

COMMIT;
