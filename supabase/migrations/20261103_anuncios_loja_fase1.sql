-- ANUNCIOS MULTI-LOJA — FASE 1 (aditiva, compativel com o codigo anterior)
--
-- Cada anuncio Shopee passa a pertencer a UMA loja (lojas.id). Esta fase:
--   1. adiciona anuncios.loja_id (uuid, NULL permitido: ML e linhas antigas);
--   2. FK para lojas(id) ON DELETE RESTRICT — remover uma loja NUNCA apaga
--      nem desassocia anuncios em silencio (desconectar e soft: ativo=false);
--   3. indice de leitura (user_id, loja_id, marketplace);
--   4. trigger: loja_id, quando presente, tem de ser loja do MESMO dono;
--   5. backfill GENERICO e fail-closed das linhas Shopee historicas.
--
-- SEQUENCIA DE RELEASE (obrigatoria):
--   A. aplicar ESTA migration (fase 1) em producao;
--   B. validar: anuncios Shopee historicos associados a loja certa e 0 anuncios
--      Shopee sem loja inesperados (o NOTICE no fim informa o restante);
--   C. publicar o codigo que le/grava loja_id (importador, mapa de custos,
--      PATCH com identidade do banco, preco em reais);
--   D. so com o codigo de C em READY: resolver a duplicata exata, com
--      autorizacao separada;
--   E. aplicar a FASE 2 (20261104: UNIQUE de identidade + CHECK "Shopee exige loja").
-- Por que nessa ordem: o codigo ANTERIOR nao conhece a coluna e continua
-- funcionando depois de A (insert sem loja_id → NULL; nada aqui o recusa). Ja a
-- fase 2 recusaria esses inserts — nunca aplica-la antes de C. E o codigo de C
-- le loja_id: publica-lo antes de A deixa a importacao parada (fail-closed, 503).

alter table public.anuncios add column if not exists loja_id uuid;

alter table public.anuncios
  add constraint anuncios_loja_id_fkey foreign key (loja_id) references public.lojas(id) on delete restrict not valid;
alter table public.anuncios validate constraint anuncios_loja_id_fkey;

create index if not exists idx_anuncios_user_loja_marketplace on public.anuncios (user_id, loja_id, marketplace);

-- loja_id so pode apontar para loja do proprio dono do anuncio.
create or replace function public.anuncios_loja_do_dono() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.loja_id is not null and not exists (
    select 1 from public.lojas l where l.id = new.loja_id and l.user_id = new.user_id
  ) then
    raise exception 'anuncios.loja_id nao pertence ao dono do anuncio' using errcode = '23514';
  end if;
  return new;
end $$;
-- (funcao `returns trigger`: so executa como trigger — nao e chamavel por RPC; nenhuma permissao nova)

drop trigger if exists anuncios_loja_do_dono on public.anuncios;
create trigger anuncios_loja_do_dono before insert or update of loja_id, user_id on public.anuncios
  for each row execute function public.anuncios_loja_do_dono();

-- ── Backfill fail-closed ─────────────────────────────────────────────────
-- Um anuncio Shopee historico (loja_id NULL) recebe loja SO quando a origem e
-- inequivoca:
--   a) exatamente UMA loja Shopee do dono existia quando o anuncio foi criado
--      (lojas.created_at <= anuncios.created_at; ativa ou nao — a importacao
--      daquela epoca so podia vir dela);
--   b) o dono NAO tem pedido Shopee de loja que nao existe mais em `lojas`
--      (indicio de loja historica apagada → origem nao provavel);
--   c) nenhuma venda daquele item foi feita por OUTRA loja Shopee do dono.
-- Qualquer outro caso fica NULL e e reportado — nunca por created_at "mais
-- recente", nunca pela loja ativa, nunca por loja fixa.
-- (Consultas a `pedidos` so pelos indices de loja_id: distinct loja_id e as
--  vendas das OUTRAS lojas do dono — nunca um scan por item.)
with donos_com_loja_sumida as (
  select distinct p.user_id
  from (select distinct loja_id from public.pedidos where loja_id is not null) x
  join lateral (select user_id from public.pedidos where loja_id = x.loja_id limit 1) p on true
  where not exists (select 1 from public.lojas l where l.id = x.loja_id)
),
candidatas as (
  select a.id as anuncio_id, a.user_id, a.ml_item_id, min(l.id::text)::uuid as loja_id, count(l.id) as n
  from public.anuncios a
  join public.lojas l on l.user_id = a.user_id and l.marketplace = 'Shopee' and l.created_at <= a.created_at
  where a.marketplace = 'Shopee' and a.loja_id is null
    and not exists (select 1 from donos_com_loja_sumida d where d.user_id = a.user_id)
  group by a.id, a.user_id, a.ml_item_id
),
vendas_de_outras_lojas as (
  select distinct c.user_id, c.loja_id as loja_candidata, p.ml_item_id
  from (select distinct user_id, loja_id from candidatas where n = 1) c
  join public.lojas o on o.user_id = c.user_id and o.marketplace = 'Shopee' and o.id <> c.loja_id
  join public.pedidos p on p.loja_id = o.id
)
update public.anuncios a
   set loja_id = c.loja_id
  from candidatas c
 where a.id = c.anuncio_id
   and c.n = 1
   and not exists (
     select 1 from vendas_de_outras_lojas v
      where v.user_id = c.user_id and v.loja_candidata = c.loja_id and v.ml_item_id = c.ml_item_id
   );

do $$
declare restantes integer;
begin
  select count(*) into restantes from public.anuncios where marketplace = 'Shopee' and loja_id is null;
  raise notice 'ANUNCIOS MULTI-LOJA fase 1: anuncios Shopee sem loja apos backfill (ambiguos) = %', restantes;
end $$;
