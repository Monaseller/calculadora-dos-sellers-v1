-- Migração: adicionar SKU, lucro líquido e margem de contribuição
-- Execute isso no SQL Editor do Supabase (https://supabase.com/dashboard)

ALTER TABLE anuncios
  ADD COLUMN IF NOT EXISTS sku TEXT,
  ADD COLUMN IF NOT EXISTS lucro_liquido NUMERIC,
  ADD COLUMN IF NOT EXISTS margem_contribuicao NUMERIC;
