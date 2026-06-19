-- ══════════════════════════════════════════
--  CDS — Migração ERP
--  Adiciona colunas para integração com ML API
-- ══════════════════════════════════════════

alter table anuncios
  add column if not exists ml_item_id   text,
  add column if not exists sku          text,
  add column if not exists preco_anuncio numeric,
  add column if not exists thumbnail    text,
  add column if not exists permalink    text;

-- Índice para buscar anúncio pelo ID do ML
create index if not exists idx_anuncios_ml_item_id on anuncios(ml_item_id);
