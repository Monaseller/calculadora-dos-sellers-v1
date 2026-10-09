-- LOJAS — REMOVE A UNIQUE LEGADA (seller_id, user_id) (CDS V2 Fase 1A.2) = PASSO C.
--
-- Aplicar SO depois de 20261105 (PASSO A). A UNIQUE legada trata seller_id como identidade
-- GLOBAL entre marketplaces: hoje ela impede o mesmo dono de ter a conta Shopee X e a conta
-- Mercado Livre X (namespaces diferentes). Sem ela, a identidade fica so a de 20261105.
--
-- Fail-closed: aborta inteira se o PASSO A nao estiver aplicado ou se algum objeto depender
-- do indice legado (FK, view etc.). Medido antes deste gate: nenhum FK referencia
-- (seller_id, user_id) — os FKs apontam para lojas(id) ou lojas(id, user_id) — e nenhum
-- codigo usa a constraint como alvo de upsert/ON CONFLICT.

do $$
begin
  if to_regclass('public.lojas_identidade_externa_uq') is null then
    raise exception 'LOJAS IDENTIDADE: PASSO A (20261105) nao aplicado — nada removido';
  end if;
  -- a identidade nova precisa estar VALIDA: unica, valida, pronta, sem predicado e exatamente
  -- (user_id, marketplace, seller_id), nessa ordem, sobre public.lojas.
  if not exists (
    select 1
      from pg_index i
     where i.indexrelid = to_regclass('public.lojas_identidade_externa_uq')
       and i.indrelid = 'public.lojas'::regclass
       and i.indisunique and i.indisvalid and i.indisready
       and i.indpred is null
       and (select array_agg(a.attname::text order by k.ord)
              from unnest(i.indkey) with ordinality as k(attnum, ord)
              join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum)
           = array['user_id', 'marketplace', 'seller_id']
  ) then
    raise exception 'LOJAS IDENTIDADE: lojas_identidade_externa_uq invalida ou diferente de (user_id, marketplace, seller_id) — nada removido';
  end if;
  if exists (
    select 1 from pg_depend
     where refobjid = to_regclass('public.lojas_seller_id_user_id_unique')
       and deptype <> 'i'
  ) then
    raise exception 'LOJAS IDENTIDADE: ha objeto dependendo de lojas_seller_id_user_id_unique — nada removido';
  end if;
end $$;

alter table public.lojas drop constraint if exists lojas_seller_id_user_id_unique;
