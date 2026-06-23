-- Migração: adiciona suporte a variações de anúncios ML
-- Execute no Supabase: Dashboard → SQL Editor → New Query → Cole e clique Run

ALTER TABLE anuncios ADD COLUMN IF NOT EXISTS variation_id TEXT NULL;

-- Comentário: este campo armazena o ID da variação específica (cor, tamanho, etc.)
-- Exemplo: 175706413780 (número longo retornado pela API do ML em data.variations[].id)
