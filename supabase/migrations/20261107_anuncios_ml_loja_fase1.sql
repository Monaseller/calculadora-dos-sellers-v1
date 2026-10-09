-- ANUNCIOS ML — LOJA (CDS V2 Fase 2B) = 20261107, FASE 1 do catalogo ML por loja. Estado alvo: 3.
--
-- O que faz (UMA transacao; qualquer RAISE desfaz tudo):
--   1. PRECHECK fail-closed (A-G) ANTES de qualquer escrita. Dado inesperado NAO e corrigido aqui.
--   2. anuncios_loja_do_dono passa a validar DONO + MARKETPLACE (antes: so dono) e o trigger
--      passa a disparar tambem em UPDATE OF marketplace.
--   3. Backfill de anuncios.loja_id SO das rows ML sem loja, por CARDINALIDADE (decisao D1):
--      dono com EXATAMENTE 1 loja ML recebe essa loja. Nenhum outro campo e tocado.
--   4. Validacao final (V1-V7): qualquer divergencia aborta a transacao.
--
-- Valores reais (auditados no banco e no codigo): anuncios.marketplace e lojas.marketplace usam a
-- MESMA representacao — 'ML' e 'Shopee' — entao a comparacao direta l.marketplace = new.marketplace
-- e correta. (Nao existe 'MercadoLivre' em nenhuma das duas tabelas.)
--
-- TRANSITIONAL_COMPATIBILITY_ONLY — ponte ML sem loja_id:
--   O runtime publicado (d570ff8) ainda tem caminhos de catalogo de UMA conta ML que inserem row ML
--   sem loja_id. Sem a ponte, um import posterior recriaria ML_WITHOUT_LOJA_ID > 0 e o estado 3 nao
--   seria estavel. Enquanto a Fase 2D nao estiver publicada, o trigger resolve uma row ML sem
--   loja_id SO por cardinalidade exata: dono com exatamente 1 loja ML -> essa loja; 0 ou 2+ -> RAISE.
--   Nunca por created_at, "mais recente", primeira, LIMIT ou seller arbitrario.
--   A 20261108 (depois do deploy da 2D, quando todo writer ML grava loja_id explicito) REMOVE este
--   autofill: no estado final o runtime fornece loja_id, o banco VALIDA e nunca escolhe a loja.
--
-- NAO faz (fica para a 20261108): UNIQUE de identidade ML, CHECK rigido de loja ML. Shopee: nenhuma
-- row e tocada; anuncios_shopee_identidade_uq e anuncios_shopee_exige_loja ficam como estao.
--
-- Aplicacao: SO por gate explicito, via SQL direto (nunca apply_migration / db push); nao registrar
-- em supabase_migrations.schema_migrations (divida de historico conhecida).
--
-- ROLLBACK CONTROLADO (documentado; NAO executar sem autorizacao explicita; nao ha script automatico):
--   a) restaurar a funcao anterior (20261103, valida so dono):
--        create or replace function public.anuncios_loja_do_dono() returns trigger
--        language plpgsql security definer set search_path = public as $$
--        begin
--          if new.loja_id is not null and not exists (
--            select 1 from public.lojas l where l.id = new.loja_id and l.user_id = new.user_id
--          ) then
--            raise exception 'anuncios.loja_id nao pertence ao dono do anuncio' using errcode = '23514';
--          end if;
--          return new;
--        end $$;
--   b) restaurar o trigger anterior (sem marketplace na lista de colunas):
--        drop trigger anuncios_loja_do_dono on public.anuncios;
--        create trigger anuncios_loja_do_dono before insert or update of loja_id, user_id on public.anuncios
--          for each row execute function public.anuncios_loja_do_dono();
--   c) SO se explicitamente autorizado: limpar os loja_id ML. O PRECHECK G exige 0 rows ML com loja
--      antes desta migration, e entre ela e a 20261108 toda loja_id ML vem desta fase (backfill ou
--      ponte), entao o escopo exato e:
--        update public.anuncios set loja_id = null where marketplace = 'ML';
--      Nunca tocar rows Shopee.

begin;

-- Nada escreve em anuncios/lojas durante a migration (o backfill e o snapshot ficam consistentes).
lock table public.anuncios in share row exclusive mode;
lock table public.lojas in share mode;

-- ── 1. PRECHECK (fail-closed; nenhuma escrita antes daqui) ───────────────────────────────────────
do $$
declare n int;
begin
  -- A. dono com row ML sem loja e ZERO lojas ML
  select count(*) into n from (
    select distinct a.user_id from public.anuncios a
     where a.marketplace = 'ML' and a.loja_id is null
       and (select count(*) from public.lojas l where l.user_id = a.user_id and l.marketplace = 'ML') = 0
  ) x;
  if n > 0 then raise exception 'PRECHECK A: % dono(s) com anuncio ML e nenhuma loja ML — resolver antes', n; end if;

  -- B. dono com row ML sem loja e 2+ lojas ML (ambiguo: nenhuma loja e escolhida)
  select count(*) into n from (
    select distinct a.user_id from public.anuncios a
     where a.marketplace = 'ML' and a.loja_id is null
       and (select count(*) from public.lojas l where l.user_id = a.user_id and l.marketplace = 'ML') > 1
  ) x;
  if n > 0 then raise exception 'PRECHECK B: % dono(s) com anuncio ML e 2+ lojas ML — resolver antes', n; end if;

  -- C. duplicata real de identidade ML (dono + item + variacao)
  select count(*) into n from (
    select 1 from public.anuncios
     where marketplace = 'ML' and ml_item_id is not null
     group by user_id, ml_item_id, coalesce(variation_id, '')
    having count(*) > 1
  ) x;
  if n > 0 then raise exception 'PRECHECK C: % identidade(s) ML duplicada(s) — resolver antes (sem DELETE automatico)', n; end if;

  -- D. loja_id existente que nao existe ou e de outro dono
  select count(*) into n from public.anuncios a
   where a.loja_id is not null
     and not exists (select 1 from public.lojas l where l.id = a.loja_id and l.user_id = a.user_id);
  if n > 0 then raise exception 'PRECHECK D: % anuncio(s) com loja_id de outro dono ou inexistente', n; end if;

  -- E. loja_id existente com marketplace incompativel
  select count(*) into n from public.anuncios a
   join public.lojas l on l.id = a.loja_id
   where l.marketplace is distinct from a.marketplace;
  if n > 0 then raise exception 'PRECHECK E: % anuncio(s) com loja de outro marketplace', n; end if;

  -- F. Shopee inconsistente com a identidade atual (sem loja, ou identidade duplicada)
  select count(*) into n from public.anuncios where marketplace = 'Shopee' and loja_id is null;
  if n > 0 then raise exception 'PRECHECK F: % anuncio(s) Shopee sem loja_id', n; end if;
  select count(*) into n from (
    select 1 from public.anuncios
     where marketplace = 'Shopee' and ml_item_id is not null
     group by user_id, loja_id, marketplace, ml_item_id, coalesce(variation_id, '')
    having count(*) > 1
  ) x;
  if n > 0 then raise exception 'PRECHECK F: % identidade(s) Shopee duplicada(s)', n; end if;

  -- G. nenhuma row ML com loja ainda (estado 2): o rollback (c) fica exato
  select count(*) into n from public.anuncios where marketplace = 'ML' and loja_id is not null;
  if n > 0 then raise exception 'PRECHECK G: % anuncio(s) ML ja com loja_id — estado diferente do auditado', n; end if;

  -- o trigger a evoluir existe (nao recriar as cegas)
  if not exists (select 1 from pg_trigger where tgrelid = 'public.anuncios'::regclass and tgname = 'anuncios_loja_do_dono' and not tgisinternal) then
    raise exception 'PRECHECK: trigger anuncios_loja_do_dono ausente — estado diferente do auditado';
  end if;
end $$;

-- Snapshot de TODAS as rows sem loja_id (para provar que so loja_id muda e que Shopee nao muda).
create temp table _anuncios_antes_20261107 on commit drop as
  select a.id, a.marketplace, a.loja_id, md5((to_jsonb(a) - 'loja_id')::text) as h
    from public.anuncios a;

-- ── 2. Dono + marketplace (permanente) e ponte ML sem loja (transitoria) ─────────────────────────
create or replace function public.anuncios_loja_do_dono() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_lojas int;
  v_loja uuid;
begin
  -- TRANSITIONAL_COMPATIBILITY_ONLY (20261107 -> deploy 2D; removido pela 20261108):
  -- row ML sem loja_id recebe a loja ML do dono SO se ela for a UNICA. 0 ou 2+ -> RAISE.
  if new.marketplace = 'ML' and new.loja_id is null then
    select count(*) into v_lojas from public.lojas l where l.user_id = new.user_id and l.marketplace = 'ML';
    if v_lojas <> 1 then
      raise exception 'anuncio ML sem loja_id: o dono tem % loja(s) ML — a loja nao pode ser deduzida', v_lojas using errcode = '23514';
    end if;
    select l.id into strict v_loja from public.lojas l where l.user_id = new.user_id and l.marketplace = 'ML';
    new.loja_id := v_loja;
  end if;

  -- Permanente: a loja existe, e do MESMO dono e do MESMO marketplace do anuncio.
  if new.loja_id is not null and not exists (
    select 1 from public.lojas l where l.id = new.loja_id and l.user_id = new.user_id and l.marketplace = new.marketplace
  ) then
    raise exception 'anuncios.loja_id nao pertence ao dono e ao marketplace do anuncio' using errcode = '23514';
  end if;
  return new;
end $$;

drop trigger anuncios_loja_do_dono on public.anuncios;
create trigger anuncios_loja_do_dono before insert or update of loja_id, user_id, marketplace on public.anuncios
  for each row execute function public.anuncios_loja_do_dono();

-- ── 3. Backfill ML por cardinalidade (D1) — SO loja_id, SO rows ML sem loja ──────────────────────
do $$
declare
  esperado int;
  n int;
begin
  select count(*) into esperado from public.anuncios where marketplace = 'ML' and loja_id is null;

  update public.anuncios a
     set loja_id = (select l.id from public.lojas l where l.user_id = a.user_id and l.marketplace = 'ML')
   where a.marketplace = 'ML' and a.loja_id is null
     and (select count(*) from public.lojas l where l.user_id = a.user_id and l.marketplace = 'ML') = 1;
  get diagnostics n = row_count;

  if n <> esperado then
    raise exception 'BACKFILL: % de % rows ML preenchidas — abortado', n, esperado;
  end if;
  raise notice 'ANUNCIOS ML LOJA fase 1: % row(s) ML preenchida(s) por cardinalidade', n;
end $$;

-- ── 4. Validacao final (qualquer divergencia aborta a transacao) ─────────────────────────────────
do $$
declare n int;
begin
  -- V1. total de rows (e de ML) igual ao do inicio
  select count(*) into n from public.anuncios a
   where not exists (select 1 from _anuncios_antes_20261107 s where s.id = a.id);
  if n > 0 then raise exception 'V1: % row(s) novas durante a migration', n; end if;
  select count(*) into n from _anuncios_antes_20261107 s
   where not exists (select 1 from public.anuncios a where a.id = s.id);
  if n > 0 then raise exception 'V1: % row(s) sumiram durante a migration', n; end if;

  -- V2. ML_WITHOUT_LOJA_ID = 0
  select count(*) into n from public.anuncios where marketplace = 'ML' and loja_id is null;
  if n > 0 then raise exception 'V2: % row(s) ML ainda sem loja_id', n; end if;

  -- V3. nenhuma loja de outro dono / inexistente
  select count(*) into n from public.anuncios a
   where a.loja_id is not null
     and not exists (select 1 from public.lojas l where l.id = a.loja_id and l.user_id = a.user_id);
  if n > 0 then raise exception 'V3: % anuncio(s) com loja de outro dono', n; end if;

  -- V4. nenhuma loja de outro marketplace
  select count(*) into n from public.anuncios a
   join public.lojas l on l.id = a.loja_id
   where l.marketplace is distinct from a.marketplace;
  if n > 0 then raise exception 'V4: % anuncio(s) com loja de outro marketplace', n; end if;

  -- V5. Shopee intocada (loja_id e todo o resto)
  select count(*) into n from _anuncios_antes_20261107 s
   join public.anuncios a on a.id = s.id
   where s.marketplace = 'Shopee'
     and (a.loja_id is distinct from s.loja_id or md5((to_jsonb(a) - 'loja_id')::text) <> s.h);
  if n > 0 then raise exception 'V5: % row(s) Shopee alteradas', n; end if;

  -- V6. em NENHUMA row mudou campo alem de loja_id
  select count(*) into n from _anuncios_antes_20261107 s
   join public.anuncios a on a.id = s.id
   where md5((to_jsonb(a) - 'loja_id')::text) <> s.h;
  if n > 0 then raise exception 'V6: % row(s) com campo alterado alem de loja_id', n; end if;

  -- V7. identidade ML continua sem duplicata (agora com loja)
  select count(*) into n from (
    select 1 from public.anuncios
     where marketplace = 'ML' and ml_item_id is not null
     group by user_id, loja_id, ml_item_id, coalesce(variation_id, '')
    having count(*) > 1
  ) x;
  if n > 0 then raise exception 'V7: % identidade(s) ML duplicada(s)', n; end if;
end $$;

commit;
