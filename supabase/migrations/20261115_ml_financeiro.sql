-- =====================================================================
-- CDS V2 VENDAS A3.2-B — FINANCEIRO REAL DO MERCADO LIVRE (PEDIDO + ENVIO)
--
-- NAO APLICADA neste gate. Aditiva: 2 tabelas NOVAS + 1 coluna NULA em
-- `pedidos`. Nenhum UPDATE/DELETE/INSERT, nenhum backfill, nenhum DROP.
--   1. public.ml_financeiro_pedidos  (grao: loja + order_id)
--   2. public.ml_financeiro_envios   (grao: loja + shipment_id)
--   3. public.pedidos.tarifa_origem  (proveniencia da tarifa das linhas NOVAS)
-- =====================================================================
--
-- POR QUE (venda golden 2000018971279352, pack 2000015516685373, auditada)
-- ---------------------------------------------------------------------
-- Liquido do painel = Σ unit_price×qtd − Σ sale_fee×qtd − senders[].cost
--                   = 41,24 − 4,19 − 6,95 = 30,10.
-- `sale_fee` ja e LIQUIDO (o rebate de campanha de 0,76 ja esta dentro;
-- conferido no billing: 4,16 + 0,03); o desconto do vendedor (0,52) ja
-- esta no unit_price. O frete e do ENVIO (shipment), nao do pedido: um
-- pack com 2+ pedidos tem UM envio e a API NAO rateia o custo entre os
-- pedidos — por isso o envio tem tabela propria (gravado UMA vez) e a
-- lista de pedidos que o compartilham; liquido por pedido so quando o
-- envio tem exatamente aquele pedido (sem rateio inventado).
--
-- `pedidos.tarifa_origem`: o sync passava a gravar no MESMO campo a
-- sale_fee real e uma estimativa por categoria, sem marca. Linhas novas:
-- 'PROVIDER' | 'ESTIMATE'; linhas antigas ficam NULL (legado, sem chute).
--
-- SEGURANCA: privilegios revogados de PUBLIC, anon e authenticated +
-- RLS ligada SEM policy. So o servidor (service_role). FK (loja_id, user_id)
-- → lojas(id, user_id): a linha so existe na loja do proprio dono.
--
-- ORDEM DE RELEASE: esta migration ANTES do codigo que grava
-- `tarifa_origem` (o upsert do sync falharia sem a coluna).
--
-- LOCK: ADD COLUMN nula sem default = so catalogo (sem rewrite). O CHECK
-- e NOT VALID: nao varre as ~585 mil linhas historicas sob ACCESS
-- EXCLUSIVE (todas NULL de qualquer forma); linhas NOVAS e UPDATEs ja sao
-- verificados. VALIDATE CONSTRAINT fica para operacao SEPARADA, depois do
-- deploy estabilizado (divida registrada) — nao faz parte deste arquivo.
--
-- ROLLBACK (MANUAL — NAO EXECUTADO AQUI)
-- ---------------------------------------------------------------------
--     BEGIN;
--     DROP TABLE public.ml_financeiro_pedidos;
--     DROP TABLE public.ml_financeiro_envios;
--     ALTER TABLE public.pedidos DROP COLUMN tarifa_origem;
--     COMMIT;
--   (so com o codigo que grava `tarifa_origem` revertido antes)
-- =====================================================================

BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE TABLE public.ml_financeiro_pedidos (
  user_id            text        NOT NULL,
  loja_id            uuid        NOT NULL,
  order_id           text        NOT NULL,
  pack_id            text        NULL,
  shipment_id        text        NULL,
  itens              integer     NOT NULL,
  receita_produto    numeric     NOT NULL,
  tarifa_venda       numeric     NULL,
  tarifa_origem      text        NOT NULL,
  desconto_vendedor  numeric     NULL,
  desconto_meli      numeric     NULL,
  descontos_status   text        NOT NULL,
  billing_status     text        NOT NULL,
  billing_tarifa     numeric     NULL,
  fonte_versao       integer     NOT NULL,
  buscado_em         timestamptz NOT NULL,
  CONSTRAINT ml_financeiro_pedidos_pkey PRIMARY KEY (loja_id, order_id),
  CONSTRAINT ml_financeiro_pedidos_loja_do_mesmo_dono FOREIGN KEY (loja_id, user_id) REFERENCES public.lojas (id, user_id),
  CONSTRAINT ml_financeiro_pedidos_tarifa_origem_check CHECK (tarifa_origem IN ('PROVIDER', 'AUSENTE')),
  CONSTRAINT ml_financeiro_pedidos_descontos_status_check CHECK (descontos_status IN ('OK', 'INDISPONIVEL')),
  CONSTRAINT ml_financeiro_pedidos_billing_status_check CHECK (billing_status IN ('CONFERIDO', 'DIVERGENTE', 'PENDENTE', 'SEM_PERMISSAO'))
);

CREATE TABLE public.ml_financeiro_envios (
  user_id                 text        NOT NULL,
  loja_id                 uuid        NOT NULL,
  shipment_id             text        NOT NULL,
  pack_id                 text        NULL,
  pedidos                 text[]      NULL,
  frete_comprador         numeric     NULL,
  frete_vendedor          numeric     NULL,
  frete_bruto_referencia  numeric     NULL,
  fonte_versao            integer     NOT NULL,
  buscado_em              timestamptz NOT NULL,
  CONSTRAINT ml_financeiro_envios_pkey PRIMARY KEY (loja_id, shipment_id),
  CONSTRAINT ml_financeiro_envios_loja_do_mesmo_dono FOREIGN KEY (loja_id, user_id) REFERENCES public.lojas (id, user_id)
);

REVOKE ALL PRIVILEGES ON TABLE public.ml_financeiro_pedidos FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE public.ml_financeiro_envios FROM PUBLIC, anon, authenticated;
ALTER TABLE public.ml_financeiro_pedidos ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ml_financeiro_envios ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.pedidos ADD COLUMN tarifa_origem text NULL;
ALTER TABLE public.pedidos ADD CONSTRAINT pedidos_tarifa_origem_check CHECK (tarifa_origem IS NULL OR tarifa_origem IN ('PROVIDER', 'ESTIMATE')) NOT VALID;

COMMIT;
