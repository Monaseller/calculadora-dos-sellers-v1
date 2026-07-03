-- ============================================================
-- Migração: novos campos na tabela pedidos
-- Gerado em: 2026-07-03
--
-- Execute este script no SQL Editor do Supabase (uma vez só).
-- Todos os comandos usam IF NOT EXISTS — seguro re-executar.
-- ============================================================

-- ── Campos financeiros novos ─────────────────────────────────────────────────
ALTER TABLE pedidos
  ADD COLUMN IF NOT EXISTS frete_real       NUMERIC DEFAULT 0,
  ADD COLUMN IF NOT EXISTS frete_estimado   NUMERIC DEFAULT 0,
  ADD COLUMN IF NOT EXISTS lucro_liquido    NUMERIC DEFAULT 0,
  ADD COLUMN IF NOT EXISTS roi              NUMERIC DEFAULT 0;

-- ── Campos de pagamento e logística ─────────────────────────────────────────
ALTER TABLE pedidos
  ADD COLUMN IF NOT EXISTS forma_pagamento  TEXT,
  ADD COLUMN IF NOT EXISTS codigo_rastreio  TEXT,
  ADD COLUMN IF NOT EXISTS transportadora   TEXT;

-- ── Campos de produto ────────────────────────────────────────────────────────
ALTER TABLE pedidos
  ADD COLUMN IF NOT EXISTS imagem_url       TEXT;

-- ── Campos do comprador ──────────────────────────────────────────────────────
ALTER TABLE pedidos
  ADD COLUMN IF NOT EXISTS buyer_username   TEXT,
  ADD COLUMN IF NOT EXISTS buyer_cidade     TEXT,
  ADD COLUMN IF NOT EXISTS buyer_estado     TEXT;

-- ── Índices de performance ───────────────────────────────────────────────────
-- Já devem existir, mas IF NOT EXISTS garante idempotência
CREATE INDEX IF NOT EXISTS pedidos_user_data_idx
  ON pedidos (user_id, data DESC);

CREATE INDEX IF NOT EXISTS pedidos_user_marketplace_data_idx
  ON pedidos (user_id, marketplace, data DESC);

CREATE INDEX IF NOT EXISTS pedidos_synced_at_idx
  ON pedidos (synced_at DESC);
