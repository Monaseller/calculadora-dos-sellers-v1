-- ANUNCIOS MULTI-LOJA — FASE 2 (identidade) = passo E da sequencia de release
-- documentada em 20261103_anuncios_loja_fase1.sql. Aplicar SO depois de:
--   1. FASE 1 aplicada e o codigo store-aware publicado (READY) — o codigo
--      anterior ainda grava anuncio Shopee sem loja_id e seria recusado aqui;
--   2. nenhum anuncio Shopee sem loja_id (backfill ambiguo resolvido);
--   3. duplicata historica resolvida com autorizacao explicita
--      (hoje: 48665805309 / 326508902947 — proposta: manter a linha MAIS ANTIGA).
-- Se qualquer pre-condicao falhar, a migration ABORTA inteira (nada e criado).

do $$
begin
  if exists (select 1 from public.anuncios where marketplace = 'Shopee' and loja_id is null) then
    raise exception 'ANUNCIOS FASE 2: existem anuncios Shopee sem loja_id — resolver antes';
  end if;
  if exists (
    select 1 from public.anuncios
     where marketplace = 'Shopee' and ml_item_id is not null
     group by user_id, loja_id, marketplace, ml_item_id, coalesce(variation_id, '')
    having count(*) > 1
  ) then
    raise exception 'ANUNCIOS FASE 2: identidade Shopee duplicada — resolver a duplicata antes (sem DELETE automatico)';
  end if;
end $$;

-- Identidade Shopee: dono + loja + marketplace + item + model. O mesmo item/model
-- em OUTRA loja e outro anuncio (permitido). Mercado Livre fica fora deste gate.
create unique index if not exists anuncios_shopee_identidade_uq
  on public.anuncios (user_id, loja_id, marketplace, ml_item_id, coalesce(variation_id, ''))
  where marketplace = 'Shopee' and ml_item_id is not null;

-- Nenhum anuncio Shopee sem loja daqui em diante.
alter table public.anuncios
  add constraint anuncios_shopee_exige_loja check (marketplace <> 'Shopee' or loja_id is not null) not valid;
alter table public.anuncios validate constraint anuncios_shopee_exige_loja;
