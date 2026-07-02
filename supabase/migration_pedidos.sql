-- Tabela de cache de pedidos (ML + Shopee)
-- Execute no Supabase SQL Editor

CREATE TABLE IF NOT EXISTS pedidos (
  id              TEXT PRIMARY KEY,           -- userId_MKTPLACE_orderId_itemId_variationId
  user_id         TEXT NOT NULL,
  marketplace     TEXT NOT NULL,              -- 'ML' | 'Shopee'
  order_id        TEXT NOT NULL,
  data            DATE NOT NULL,
  anuncio         TEXT,
  ml_item_id      TEXT,
  variation_id    TEXT,
  conta           TEXT,
  sku             TEXT,
  status          TEXT,
  frete           TEXT,
  logistica       TEXT,
  valor_unit      NUMERIC DEFAULT 0,
  qtd             INTEGER DEFAULT 1,
  faturamento     NUMERIC DEFAULT 0,
  custo           NUMERIC DEFAULT 0,
  imposto         NUMERIC DEFAULT 0,
  tarifa_venda    NUMERIC DEFAULT 0,
  frete_comprador NUMERIC DEFAULT 0,
  frete_vendedor  NUMERIC DEFAULT 0,
  margem_contrib  NUMERIC DEFAULT 0,
  mc_percent      NUMERIC DEFAULT 0,
  cadastrado      BOOLEAN DEFAULT FALSE,
  synced_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pedidos_user_data
  ON pedidos(user_id, data DESC);

CREATE INDEX IF NOT EXISTS idx_pedidos_user_mkt_data
  ON pedidos(user_id, marketplace, data DESC);
