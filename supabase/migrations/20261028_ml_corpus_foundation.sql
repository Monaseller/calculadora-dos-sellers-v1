-- =====================================================================
-- CDS-STABILIZATION ML-CORPUS-A — CORPUS CANONICO MERCADO LIVRE (FOUNDATION)
--
-- NAO APLICADA neste gate. Segura para coexistir com o sync ML legado:
-- so cria uma tabela NOVA e AMPLIA um CHECK de sync_jobs (aceita mais um
-- valor; toda linha existente continua valida). Nada em `pedidos`.
--   1. public.ml_pedidos  (grao: loja + order_id), nasce FECHADA
--   2. public.sync_jobs   campo_tempo aceita 'date_closed' (janela de
--                         cobertura da regra canonica ML)
-- =====================================================================
--
-- POR QUE
-- ---------------------------------------------------------------------
-- A regra ML homologada (lib/vendas/canonico/ml.ts) precisa, no grao de
-- PEDIDO: order.date_closed (data comercial), cancel_detail.code (so
-- `pack_splitted` sai), order.total_amount (UMA vez por pedido) e
-- Σ order_items.quantity. `pedidos` e por ITEM (id <user>_ML_<order>_<item>,
-- sem loja e sem variacao; qtd com default 1) — copiar valor de pedido em
-- cada item duplicaria a soma. Dai a tabela de PEDIDO, como shopee_pedidos.
-- `unidades` e guardada no grao do pedido (Σ quantity do proprio pedido):
-- os itens legados nao sao confiaveis para unidades.
--
-- SEGURANCA (licao SEC-3): REVOKE explicito de PUBLIC, anon e
-- authenticated + RLS ligada SEM policy. So o servidor (service_role).
--
-- MULTI-LOJA: PK (loja_id, order_id) — o mesmo order_id em lojas
-- diferentes sao linhas diferentes. FK (loja_id, user_id) → lojas(id,
-- user_id): a linha so existe na loja do proprio dono.
--
-- ROLLBACK (MANUAL — NAO EXECUTADO AQUI; seguro so com ml_pedidos vazia)
-- ---------------------------------------------------------------------
--     BEGIN;
--     DROP TABLE public.ml_pedidos;
--     ALTER TABLE public.sync_jobs DROP CONSTRAINT sync_jobs_campo_tempo_check,
--       ADD CONSTRAINT sync_jobs_campo_tempo_check CHECK (campo_tempo IS NULL OR campo_tempo IN ('update_time', 'create_time'));
--     COMMIT;
--   (o CHECK antigo so volta se nenhuma linha usar 'date_closed')
-- =====================================================================

BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE TABLE public.ml_pedidos (
  user_id            text        NOT NULL,
  loja_id            uuid        NOT NULL,
  order_id           text        NOT NULL,
  date_created       timestamptz NULL,
  date_closed        timestamptz NULL,
  last_updated       timestamptz NULL,
  status             text        NULL,
  cancel_detail_code text        NULL,
  total_amount       numeric     NULL,
  unidades           integer     NULL,
  fetched_at         timestamptz NOT NULL,
  CONSTRAINT ml_pedidos_pkey PRIMARY KEY (loja_id, order_id),
  CONSTRAINT ml_pedidos_loja_do_mesmo_dono FOREIGN KEY (loja_id, user_id) REFERENCES public.lojas (id, user_id)
);

-- consulta canonica: pedidos fechados de um dono/loja num intervalo
CREATE INDEX idx_ml_pedidos_dono_loja_date_closed ON public.ml_pedidos (user_id, loja_id, date_closed);

REVOKE ALL PRIVILEGES ON TABLE public.ml_pedidos FROM PUBLIC, anon, authenticated;
ALTER TABLE public.ml_pedidos ENABLE ROW LEVEL SECURITY;

-- cobertura ML: janela por date_closed (populacao imutavel apos o fechamento)
ALTER TABLE public.sync_jobs
  DROP CONSTRAINT sync_jobs_campo_tempo_check,
  ADD CONSTRAINT sync_jobs_campo_tempo_check CHECK (campo_tempo IS NULL OR campo_tempo IN ('update_time', 'create_time', 'date_closed'));

COMMIT;
