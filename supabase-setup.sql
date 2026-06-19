-- ══════════════════════════════════════════
--  CDS — Calculadora dos Sellers
--  Setup do banco de dados
-- ══════════════════════════════════════════

-- Tabela de anúncios cadastrados pelo seller
create table if not exists anuncios (
  id               uuid primary key default gen_random_uuid(),
  created_at       timestamptz default now(),
  nome             text not null,
  marketplace      text not null check (marketplace in ('ML', 'Shopee')),
  categoria        text,
  tipo_anuncio     text,         -- ML: 'Clássico' | 'Premium'
  tipo_conta_shopee text,        -- Shopee: 'CNPJ' | 'CPF'
  custo_produto    numeric not null default 0,
  insumos          numeric not null default 0,
  custo_frete      numeric not null default 0,
  frete_gratis     boolean not null default false,
  imposto          numeric not null default 8,
  margem_desejada  numeric not null default 20,
  preco_ideal      numeric,
  ativo            boolean not null default true
);

-- Tabela de vendas por dia por anúncio
create table if not exists vendas_dia (
  id                uuid primary key default gen_random_uuid(),
  created_at        timestamptz default now(),
  anuncio_id        uuid not null references anuncios(id) on delete cascade,
  data              date not null default current_date,
  unidades_vendidas integer not null default 0,
  faturamento       numeric not null default 0,
  lucro             numeric not null default 0,
  unique (anuncio_id, data)   -- uma entrada por anúncio por dia
);

-- Índices úteis
create index if not exists idx_vendas_anuncio on vendas_dia(anuncio_id);
create index if not exists idx_vendas_data    on vendas_dia(data);
