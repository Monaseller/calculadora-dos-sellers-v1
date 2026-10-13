-- ANUNCIOS ML — LOJA (CDS V2 Fase 2E) = 20261108, FASE 2 do catalogo ML por loja. Estado 3 -> 4.
--
-- O que faz (UMA transacao; qualquer RAISE desfaz tudo):
--   1. PRECHECK fail-closed (A-J) ANTES de qualquer DDL: estado 3 integro e esperado.
--   2. UNIQUE de identidade ML (provider-backed): dono + loja + marketplace + item + variacao, so para
--      rows ML COM ml_item_id. Rows ML manuais (sem ml_item_id) ficam FORA do indice: nunca colidem
--      entre si (nada de coalesce no item).
--   3. CHECK final: TODA row ML pertence a uma loja (marketplace <> 'ML' OR loja_id IS NOT NULL) —
--      com ou sem identidade do provider. NOT VALID + VALIDATE na mesma transacao.
--   4. Funcao anuncios_loja_do_dono SEM a ponte transitoria da 20261107: nao conta lojas, nao
--      escolhe loja, nao preenche loja_id. Fica so a validacao permanente: loja explicita existe, e do
--      MESMO dono e do MESMO marketplace (loja inativa continua identidade valida). Row ML sem loja ->
--      o CHECK recusa. O trigger (INSERT OR UPDATE OF loja_id, user_id, marketplace) nao muda.
--   5. Validacao final (V1-V11). Nenhum dado de anuncio e alterado (sem backfill).
--
-- Shopee: anuncios_shopee_identidade_uq e anuncios_shopee_exige_loja sao conferidos (definicao exata)
-- antes e depois e NAO sao tocados.
--
-- Locks: SET LOCAL lock_timeout/statement_timeout; anuncios em ACCESS EXCLUSIVE desde o inicio
-- (ALTER TABLE ADD CONSTRAINT exige esse modo de qualquer forma — pega-lo ja no inicio evita upgrade de
-- lock no meio da transacao; a tabela e pequena); lojas em SHARE (nenhuma loja muda durante a validacao
-- de dono/marketplace). Sem o lock em 5s, falha inteira e pode ser tentada de novo.
--
-- Aplicacao: SO por gate explicito e por um caminho COMPROVADAMENTE transacional (divida aberta: a
-- 20261107 no SQL Editor nao foi atomica). Nunca apply_migration / db push; nao registrar em
-- supabase_migrations.schema_migrations (divida de historico conhecida).
--
-- ROLLBACK CONTROLADO (documentado; NAO executar sem autorizacao explicita; nao ha script automatico):
--   a) drop index public.anuncios_ml_identidade_uq;
--   b) alter table public.anuncios drop constraint anuncios_ml_exige_loja;
--   c) reinstalar a funcao do estado 3 (ponte transitoria) exatamente como em
--      supabase/migrations/20261107_anuncios_ml_loja_fase1.sql (create or replace function ...).
--   Nenhum dado precisa ser revertido: esta migration nao escreve em anuncios.

begin;

-- Limites LOCAIS (so esta transacao): nunca esperar lock indefinidamente em producao.
set local lock_timeout = '5s';
set local statement_timeout = '60s';

lock table public.anuncios in access exclusive mode;
lock table public.lojas in share mode;

-- ── 1. PRECHECK (fail-closed; nenhum DDL antes daqui) ────────────────────────────────────────────
do $$
declare n int;
begin
  -- A. nenhuma row ML sem loja
  select count(*) into n from public.anuncios where marketplace = 'ML' and loja_id is null;
  if n > 0 then raise exception 'PRECHECK A: % anuncio(s) ML sem loja_id', n; end if;

  -- B. nenhuma loja_id inexistente
  select count(*) into n from public.anuncios a
   where a.loja_id is not null
     and not exists (select 1 from public.lojas l where l.id = a.loja_id);
  if n > 0 then raise exception 'PRECHECK B: % anuncio(s) com loja_id inexistente', n; end if;

  -- C. nenhuma loja de outro dono
  select count(*) into n from public.anuncios a
   join public.lojas l on l.id = a.loja_id
   where l.user_id is distinct from a.user_id;
  if n > 0 then raise exception 'PRECHECK C: % anuncio(s) com loja de outro dono', n; end if;

  -- D. nenhuma loja de outro marketplace
  select count(*) into n from public.anuncios a
   join public.lojas l on l.id = a.loja_id
   where l.marketplace is distinct from a.marketplace;
  if n > 0 then raise exception 'PRECHECK D: % anuncio(s) com loja de outro marketplace', n; end if;

  -- E. nenhuma duplicata da identidade ML final (o mesmo predicado do UNIQUE)
  select count(*) into n from (
    select 1 from public.anuncios
     where marketplace = 'ML' and ml_item_id is not null
     group by user_id, loja_id, marketplace, ml_item_id, coalesce(variation_id, '')
    having count(*) > 1
  ) x;
  if n > 0 then raise exception 'PRECHECK E: % identidade(s) ML duplicada(s) — resolver antes (sem DELETE automatico)', n; end if;

  -- F. Shopee valida e com os contratos do jeito auditado
  select count(*) into n from public.anuncios where marketplace = 'Shopee' and loja_id is null;
  if n > 0 then raise exception 'PRECHECK F: % anuncio(s) Shopee sem loja_id', n; end if;
  select count(*) into n from pg_indexes
   where schemaname = 'public' and tablename = 'anuncios' and indexname = 'anuncios_shopee_identidade_uq'
     and indexdef = 'CREATE UNIQUE INDEX anuncios_shopee_identidade_uq ON public.anuncios USING btree (user_id, loja_id, marketplace, ml_item_id, COALESCE(variation_id, ''''::text)) WHERE ((marketplace = ''Shopee''::text) AND (ml_item_id IS NOT NULL))';
  if n <> 1 then raise exception 'PRECHECK F: anuncios_shopee_identidade_uq ausente ou diferente do auditado'; end if;
  select count(*) into n from pg_constraint c
   where c.conrelid = 'public.anuncios'::regclass and c.conname = 'anuncios_shopee_exige_loja' and c.convalidated
     and pg_get_constraintdef(c.oid) = 'CHECK (((marketplace <> ''Shopee''::text) OR (loja_id IS NOT NULL)))';
  if n <> 1 then raise exception 'PRECHECK F: anuncios_shopee_exige_loja ausente ou diferente do auditado'; end if;

  -- G. estado 3: a funcao instalada e a da 20261107 (com a ponte por loja ML ativa)
  select count(*) into n from pg_proc p
   where p.oid = 'public.anuncios_loja_do_dono()'::regprocedure
     and p.prosrc like '%l.ativo = true%' and p.prosrc like '%l.marketplace = new.marketplace%';
  if n <> 1 then raise exception 'PRECHECK G: funcao anuncios_loja_do_dono nao e a do estado 3'; end if;

  -- H. UNIQUE ML final ainda nao existe
  select count(*) into n from pg_class where relname = 'anuncios_ml_identidade_uq';
  if n > 0 then raise exception 'PRECHECK H: anuncios_ml_identidade_uq ja existe — estado diferente do auditado'; end if;

  -- I. CHECK ML final ainda nao existe
  select count(*) into n from pg_constraint c
   where c.conrelid = 'public.anuncios'::regclass and c.conname = 'anuncios_ml_exige_loja';
  if n > 0 then raise exception 'PRECHECK I: anuncios_ml_exige_loja ja existe — estado diferente do auditado'; end if;

  -- J. trigger do estado 3 no formato esperado
  select count(*) into n from pg_trigger t
   where t.tgrelid = 'public.anuncios'::regclass and t.tgname = 'anuncios_loja_do_dono' and not t.tgisinternal
     and pg_get_triggerdef(t.oid) = 'CREATE TRIGGER anuncios_loja_do_dono BEFORE INSERT OR UPDATE OF loja_id, user_id, marketplace ON public.anuncios FOR EACH ROW EXECUTE FUNCTION anuncios_loja_do_dono()';
  if n <> 1 then raise exception 'PRECHECK J: trigger anuncios_loja_do_dono ausente ou diferente do auditado'; end if;
end $$;

-- Snapshot de TODAS as rows (linha inteira): esta migration nao pode mudar nenhum dado.
create temp table _anuncios_antes_20261108 on commit drop as
  select a.id, a.marketplace, md5(to_jsonb(a)::text) as h
    from public.anuncios a;

-- ── 2. UNIQUE de identidade ML (provider-backed) ────────────────────────────────────────────────
create unique index anuncios_ml_identidade_uq
  on public.anuncios (user_id, loja_id, marketplace, ml_item_id, coalesce(variation_id, ''))
  where marketplace = 'ML' and ml_item_id is not null;

-- ── 3. CHECK final: toda row ML tem loja ────────────────────────────────────────────────────────
alter table public.anuncios
  add constraint anuncios_ml_exige_loja check (marketplace <> 'ML' or loja_id is not null) not valid;
alter table public.anuncios validate constraint anuncios_ml_exige_loja;

-- ── 4. Funcao final: so validacao permanente (sem ponte transitoria) ───────────────────────────
create or replace function public.anuncios_loja_do_dono() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.loja_id is not null and not exists (
    select 1 from public.lojas l where l.id = new.loja_id and l.user_id = new.user_id and l.marketplace = new.marketplace
  ) then
    raise exception 'anuncios.loja_id nao pertence ao dono e ao marketplace do anuncio' using errcode = '23514';
  end if;
  return new;
end $$;

-- ── 5. Validacao final (qualquer divergencia aborta a transacao) ────────────────────────────────
do $$
declare n int;
begin
  -- V1. nenhuma row criada ou sumida
  select count(*) into n from public.anuncios a
   where not exists (select 1 from _anuncios_antes_20261108 s where s.id = a.id);
  if n > 0 then raise exception 'V1: % row(s) novas durante a migration', n; end if;
  select count(*) into n from _anuncios_antes_20261108 s
   where not exists (select 1 from public.anuncios a where a.id = s.id);
  if n > 0 then raise exception 'V1: % row(s) sumiram durante a migration', n; end if;

  -- V2. nenhuma row ML sem loja
  select count(*) into n from public.anuncios where marketplace = 'ML' and loja_id is null;
  if n > 0 then raise exception 'V2: % row(s) ML sem loja_id', n; end if;

  -- V3. nenhuma loja de outro dono / inexistente
  select count(*) into n from public.anuncios a
   where a.loja_id is not null
     and not exists (select 1 from public.lojas l where l.id = a.loja_id and l.user_id = a.user_id);
  if n > 0 then raise exception 'V3: % anuncio(s) com loja de outro dono ou inexistente', n; end if;

  -- V4. nenhuma loja de outro marketplace
  select count(*) into n from public.anuncios a
   join public.lojas l on l.id = a.loja_id
   where l.marketplace is distinct from a.marketplace;
  if n > 0 then raise exception 'V4: % anuncio(s) com loja de outro marketplace', n; end if;

  -- V5. Shopee intocada (dados e contratos)
  select count(*) into n from _anuncios_antes_20261108 s
   join public.anuncios a on a.id = s.id
   where s.marketplace = 'Shopee' and md5(to_jsonb(a)::text) <> s.h;
  if n > 0 then raise exception 'V5: % row(s) Shopee alteradas', n; end if;
  select count(*) into n from pg_indexes
   where schemaname = 'public' and tablename = 'anuncios' and indexname = 'anuncios_shopee_identidade_uq'
     and indexdef = 'CREATE UNIQUE INDEX anuncios_shopee_identidade_uq ON public.anuncios USING btree (user_id, loja_id, marketplace, ml_item_id, COALESCE(variation_id, ''''::text)) WHERE ((marketplace = ''Shopee''::text) AND (ml_item_id IS NOT NULL))';
  if n <> 1 then raise exception 'V5: anuncios_shopee_identidade_uq mudou'; end if;
  select count(*) into n from pg_constraint c
   where c.conrelid = 'public.anuncios'::regclass and c.conname = 'anuncios_shopee_exige_loja' and c.convalidated
     and pg_get_constraintdef(c.oid) = 'CHECK (((marketplace <> ''Shopee''::text) OR (loja_id IS NOT NULL)))';
  if n <> 1 then raise exception 'V5: anuncios_shopee_exige_loja mudou'; end if;

  -- V6. nenhum dado de anuncio mudou (linha inteira)
  select count(*) into n from _anuncios_antes_20261108 s
   join public.anuncios a on a.id = s.id
   where md5(to_jsonb(a)::text) <> s.h;
  if n > 0 then raise exception 'V6: % row(s) com dado alterado pela migration', n; end if;

  -- V7. nenhuma duplicata da identidade ML final
  select count(*) into n from (
    select 1 from public.anuncios
     where marketplace = 'ML' and ml_item_id is not null
     group by user_id, loja_id, marketplace, ml_item_id, coalesce(variation_id, '')
    having count(*) > 1
  ) x;
  if n > 0 then raise exception 'V7: % identidade(s) ML duplicada(s)', n; end if;

  -- V8. UNIQUE ML existe, e unique, valido e pronto, na tabela certa
  select count(*) into n from pg_index i
   join pg_class c on c.oid = i.indexrelid
   where c.relname = 'anuncios_ml_identidade_uq' and i.indrelid = 'public.anuncios'::regclass
     and i.indisunique and i.indisvalid and i.indisready;
  if n <> 1 then raise exception 'V8: anuncios_ml_identidade_uq ausente, nao unico ou invalido'; end if;

  -- V9. CHECK ML existe e esta VALIDADO
  select count(*) into n from pg_constraint c
   where c.conrelid = 'public.anuncios'::regclass and c.conname = 'anuncios_ml_exige_loja' and c.convalidated;
  if n <> 1 then raise exception 'V9: anuncios_ml_exige_loja ausente ou nao validado'; end if;

  -- V10. funcao final: valida dono + marketplace e NAO tem ponte (atribuicao/contagem/ativo)
  select count(*) into n from pg_proc p
   where p.oid = 'public.anuncios_loja_do_dono()'::regprocedure
     and (p.prosrc like '%:=%' or p.prosrc like '%count(%' or p.prosrc like '%ativo%');
  if n > 0 then raise exception 'V10: funcao final ainda escolhe/preenche loja (ponte transitoria)'; end if;
  select count(*) into n from pg_proc p
   where p.oid = 'public.anuncios_loja_do_dono()'::regprocedure
     and p.prosrc like '%l.user_id = new.user_id%' and p.prosrc like '%l.marketplace = new.marketplace%';
  if n <> 1 then raise exception 'V10: funcao final sem validacao de dono + marketplace'; end if;

  -- V11. trigger final instalado (INSERT OR UPDATE OF loja_id, user_id, marketplace)
  select count(*) into n from pg_trigger t
   where t.tgrelid = 'public.anuncios'::regclass and t.tgname = 'anuncios_loja_do_dono' and not t.tgisinternal
     and pg_get_triggerdef(t.oid) = 'CREATE TRIGGER anuncios_loja_do_dono BEFORE INSERT OR UPDATE OF loja_id, user_id, marketplace ON public.anuncios FOR EACH ROW EXECUTE FUNCTION anuncios_loja_do_dono()';
  if n <> 1 then raise exception 'V11: trigger anuncios_loja_do_dono ausente ou diferente'; end if;
end $$;

commit;
