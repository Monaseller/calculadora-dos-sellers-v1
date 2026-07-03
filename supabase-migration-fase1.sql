-- ============================================================
-- MIGRATION FASE 1: Camada financeira oficial (income_distribution)
-- Execute no Supabase → SQL Editor
-- ============================================================

-- P1: campos income_distribution (valores oficiais Shopee)
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS item_subtotal        NUMERIC DEFAULT 0;
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS buyer_paid_amount    NUMERIC DEFAULT 0;
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS escrow_amount        NUMERIC DEFAULT 0;
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS commission_fee       NUMERIC DEFAULT 0;
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS service_fee          NUMERIC DEFAULT 0;
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS transaction_fee      NUMERIC DEFAULT 0;
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS campaign_fee         NUMERIC DEFAULT 0;
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS voucher_from_shopee  NUMERIC DEFAULT 0;
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS voucher_from_seller  NUMERIC DEFAULT 0;
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS seller_income        NUMERIC DEFAULT 0;
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS has_income_data      BOOLEAN DEFAULT FALSE;

-- P5: campos de status e auditoria
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS cancel_reason    TEXT;
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS cancel_by        TEXT;
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS fulfillment_flag TEXT;
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS split_up         BOOLEAN DEFAULT FALSE;

-- Índice para consultas por has_income_data (útil para auditoria)
CREATE INDEX IF NOT EXISTS idx_pedidos_has_income_data
  ON pedidos (user_id, marketplace, has_income_data)
  WHERE marketplace = 'Shopee';

-- Verificação: listar colunas novas
SELECT column_name, data_type, column_default
FROM information_schema.columns
WHERE table_name = 'pedidos'
  AND column_name IN (
    'item_subtotal', 'buyer_paid_amount', 'escrow_amount',
    'commission_fee', 'service_fee', 'transaction_fee',
    'campaign_fee', 'voucher_from_shopee', 'voucher_from_seller',
    'seller_income', 'has_income_data', 'cancel_reason',
    'cancel_by', 'fulfillment_flag', 'split_up'
  )
ORDER BY column_name;
