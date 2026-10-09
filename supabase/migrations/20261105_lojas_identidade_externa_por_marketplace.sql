-- LOJAS — IDENTIDADE EXTERNA POR MARKETPLACE (CDS V2 Fase 1A.2) = PASSO A.
--
-- Contrato: (user_id, marketplace, seller_id) identifica no maximo UMA loja. seller_id e o id
-- externo da conta NAQUELE marketplace (Shopee: = shop_id) — ids de marketplaces diferentes sao
-- namespaces diferentes e podem coincidir. A UNIQUE legada (seller_id, user_id) NAO e removida
-- aqui: sai so no PASSO C (20261106), depois deste aplicado. Nenhum codigo usa nenhuma das duas
-- como alvo de upsert/ON CONFLICT (o registro e SELECT escopado por marketplace + UPDATE/INSERT;
-- 23505 de qualquer das duas e tratado como corrida, fail-closed).
--
-- Fail-closed: se houver duplicata na identidade nova, ou loja Shopee com seller_id <> shop_id,
-- ABORTA inteira — nada e criado e nenhum vencedor e escolhido.

do $$
declare n int;
begin
  select count(*) into n from (
    select 1 from public.lojas
     where seller_id is not null
     group by user_id, marketplace, seller_id
    having count(*) > 1
  ) d;
  if n > 0 then
    raise exception 'LOJAS IDENTIDADE: % grupo(s) duplicado(s) em (user_id, marketplace, seller_id) — resolver manualmente antes', n;
  end if;
  select count(*) into n from public.lojas
   where marketplace = 'Shopee' and shop_id is not null and seller_id is distinct from shop_id;
  if n > 0 then
    raise exception 'LOJAS IDENTIDADE: % loja(s) Shopee com seller_id diferente de shop_id — resolver antes', n;
  end if;
end $$;

-- Identidade externa escopada por marketplace (a mesma conta em OUTRO marketplace e outra loja).
create unique index if not exists lojas_identidade_externa_uq
  on public.lojas (user_id, marketplace, seller_id);

-- Coerencia Shopee no modelo atual: seller_id e o shop_id.
alter table public.lojas
  add constraint lojas_shopee_seller_e_shop check (marketplace <> 'Shopee' or shop_id is null or seller_id = shop_id) not valid;
alter table public.lojas validate constraint lojas_shopee_seller_e_shop;
