-- ============================================================
-- Migração: dashboard_resumos_diarios (camada de agregação/cache)
-- Gerado em: 2026-07-10
-- Atualizado em: 2026-07-11 — chave passa a usar loja_id (ver docs/DECISIONS.md
-- "loja_id como referência principal"). Como esta tabela ainda não foi
-- executada no banco, a mudança entra direto na definição original, sem
-- precisar de um ALTER TABLE separado depois.
-- Contexto: Dashboard e Vendas carregam milhares de linhas de `pedidos` a
-- cada acesso. Esta tabela guarda resumos diários pré-agregados, pra
-- Dashboard parar de somar linha por linha toda vez. Ver docs/ROADMAP.md
-- "Fase 4 — Arquitetura de performance" e docs/DECISIONS.md.
--
-- NÃO EXECUTADO AINDA. Rodar manualmente no SQL Editor do Supabase quando
-- aprovado. Usa IF NOT EXISTS — seguro re-executar.
--
-- O QUE ESTA MIGRATION NÃO FAZ:
--   - Não altera, remove nem duplica nenhum dado de `pedidos`.
--   - Não vira fonte de verdade (ver regra abaixo).
--   - Não faz backfill (script separado, ainda não escrito — não é
--     necessário para ESTA tabela porque ela ainda não existe no banco;
--     nasce já com loja_id. O backfill é só para `pedidos`, tabela
--     existente — ver scripts/backfill-loja-id.sql).
-- ============================================================

-- ── Regra de evolução do schema (aprovada 2026-07-10) ───────────────────────
-- Antes de criar qualquer coluna nova nesta tabela, no futuro:
--   1. verificar se já existe coluna equivalente em `pedidos`;
--   2. evitar duplicação de conceitos;
--   3. manter a nomenclatura igual sempre que possível (mesmo nome de coluna
--      que já existe em `pedidos`, quando o conceito for o mesmo).

CREATE TABLE IF NOT EXISTS dashboard_resumos_diarios (
  id                    BIGSERIAL PRIMARY KEY,
  user_id               TEXT NOT NULL,
  loja_id               UUID NOT NULL REFERENCES lojas(id),
  marketplace           TEXT NOT NULL,   -- denormalizado, só exibição — não é mais chave de identidade
  conta                 TEXT NOT NULL DEFAULT '',  -- denormalizado (nickname na hora do recálculo), idem
  tipo_data             TEXT NOT NULL CHECK (tipo_data IN ('pagamento','criacao')),
  data_referencia       DATE NOT NULL,

  pedidos_total         INTEGER NOT NULL DEFAULT 0,
  pedidos_pagos         INTEGER NOT NULL DEFAULT 0,
  pedidos_cancelados    INTEGER NOT NULL DEFAULT 0,
  pedidos_devolvidos    INTEGER NOT NULL DEFAULT 0,

  faturamento           NUMERIC NOT NULL DEFAULT 0,
  faturamento_bruto     NUMERIC NOT NULL DEFAULT 0,
  buyer_paid_amount     NUMERIC NOT NULL DEFAULT 0,
  escrow_amount         NUMERIC NOT NULL DEFAULT 0,
  commission_fee        NUMERIC NOT NULL DEFAULT 0,
  service_fee           NUMERIC NOT NULL DEFAULT 0,
  transaction_fee       NUMERIC NOT NULL DEFAULT 0,
  campaign_fee          NUMERIC NOT NULL DEFAULT 0,
  voucher_from_seller   NUMERIC NOT NULL DEFAULT 0,
  voucher_from_shopee   NUMERIC NOT NULL DEFAULT 0,
  custo                 NUMERIC NOT NULL DEFAULT 0,
  imposto               NUMERIC NOT NULL DEFAULT 0,
  frete                 NUMERIC NOT NULL DEFAULT 0,
  lucro                 NUMERIC NOT NULL DEFAULT 0,
  margem_contribuicao   NUMERIC NOT NULL DEFAULT 0,   -- % já ponderado (lucro/faturamento), nunca média de %
  ticket_medio          NUMERIC NOT NULL DEFAULT 0,
  unidades              INTEGER NOT NULL DEFAULT 0,   -- soma de pedidos.qtd dos pedidos pagos do dia
  tarifa_venda          NUMERIC NOT NULL DEFAULT 0,   -- soma de pedidos.tarifa_venda dos pedidos pagos (mesmo campo usado pelo Dashboard hoje: Σ r.tarifaVenda; oficial via income_distribution ou estimado, já resolvido em pedidos)

  -- created_at em inglês por convenção com lojas.created_at (tabela da FK
  -- acima) e com o próprio updated_at desta tabela — fora do payload do
  -- upsert em lib/resumos-diarios.ts de propósito: só o DEFAULT preenche no
  -- INSERT, nunca é sobrescrito num upsert seguinte (Fase 2, 2026-07-24).
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Chave única por loja_id (2026-07-11), não mais por marketplace+conta —
  -- conta(nickname) não é estável (pode mudar se o vendedor renomear a loja
  -- no marketplace); loja_id nunca muda. Ver docs/DECISIONS.md.
  UNIQUE (user_id, loja_id, tipo_data, data_referencia)
);

-- ── IMPORTANTE (aprovado 2026-07-10, restrição permanente) ──────────────────
-- A tabela dashboard_resumos_diarios é APENAS uma camada de agregação.
-- Ela NUNCA será considerada fonte de verdade.
-- Todos os valores aqui devem sempre poder ser reconstruídos INTEGRALMENTE
-- a partir da tabela `pedidos` (recálculo do zero, nunca incremental).
-- NÃO criar nenhuma informação que exista SOMENTE nesta tabela — se um
-- campo não pode ser derivado 100% de `pedidos`, ele não pertence aqui.

CREATE INDEX IF NOT EXISTS idx_resumos_user_loja_tipo_data
  ON dashboard_resumos_diarios (user_id, loja_id, tipo_data, data_referencia DESC);

CREATE INDEX IF NOT EXISTS idx_resumos_user_mkt_tipo_data
  ON dashboard_resumos_diarios (user_id, marketplace, tipo_data, data_referencia DESC);

COMMENT ON TABLE dashboard_resumos_diarios IS
  'Camada de agregação/cache — NÃO é fonte de verdade. Todo valor deve ser reconstruível a partir de `pedidos`. Chave por loja_id (2026-07-11), marketplace/conta ficam só como exibição. Recalculada dia a dia (nunca período inteiro) via lib/resumos-diarios.ts. Ver docs/DECISIONS.md e docs/ROADMAP.md Fase 4/5.';
