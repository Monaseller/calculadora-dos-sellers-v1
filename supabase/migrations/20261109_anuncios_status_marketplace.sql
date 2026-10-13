-- ANUNCIOS — STATUS DO MARKETPLACE (CDS V2 Fase 2H-B) = 20261109. Estado 4 -> 4 + observacao (aditiva).
--
-- O que faz (UMA transacao; qualquer RAISE desfaz tudo):
--   1. PRECHECK fail-closed (A-J) ANTES de qualquer DDL: estado 4 integro e as duas colunas ausentes.
--   2. Adiciona SO duas colunas, nulas, sem default, sem CHECK, sem indice, sem trigger:
--        status_marketplace text         — valor RAW observado diretamente no provider;
--        visto_em           timestamptz  — ultima vez em que a identidade voltou numa resposta valida.
--   3. SEM backfill: as 2375 rows terminam com as duas colunas NULL. NULL = nada observado ainda por
--      um writer 2H (nunca inferir ML = active / Shopee = NORMAL pelo tipo de import).
--   4. Validacao final (V1-V12) com snapshot: nenhum valor existente muda.
--
-- Contrato (2H-C em diante, NAO implementado aqui):
--   • `ativo` e do USUARIO; o provider NUNCA escreve `ativo` (nem esta migration toca `ativo`);
--   • status_marketplace so com o valor RAW de uma resposta valida que o contenha (nunca inventado);
--     visto_em pode avancar numa observacao positiva mesmo sem status provado;
--   • AUSENCIA nao altera ativo, status_marketplace nem visto_em (cobertura insuficiente em ML e Shopee).
--
-- Locks: SET LOCAL lock_timeout/statement_timeout; anuncios em ACCESS EXCLUSIVE desde o inicio (o
-- ADD COLUMN exige esse modo — pega-lo antes evita upgrade de lock no meio). Sem o lock em 5s, a
-- transacao falha inteira (nada muda) e pode ser tentada de novo.
--
-- Aplicacao: SO por gate explicito, pelo caminho comprovadamente atomico (MCP execute_sql, arquivo
-- inteiro numa unica chamada). Nunca apply_migration / db push; nao registrar em
-- supabase_migrations.schema_migrations (divida de historico conhecida).
--
-- ROLLBACK CONTROLADO (documentado; NAO executar sem autorizacao explicita):
--   alter table public.anuncios drop column status_marketplace, drop column visto_em;
--   (seguro so enquanto nenhum writer 2H-C gravou nelas — depois disso, o drop perde observacoes.)

begin;

-- Limites LOCAIS (so esta transacao): nunca esperar lock indefinidamente em producao.
set local lock_timeout = '5s';
set local statement_timeout = '60s';

lock table public.anuncios in access exclusive mode;

-- ── 1. PRECHECK (fail-closed; nenhum DDL antes daqui) ────────────────────────────────────────────
do $$
declare n int;
begin
  -- A. identidade ML do estado 4: UNIQUE parcial exata, unica, valida e pronta
  select count(*) into n from pg_indexes
   where schemaname = 'public' and tablename = 'anuncios' and indexname = 'anuncios_ml_identidade_uq'
     and indexdef = 'CREATE UNIQUE INDEX anuncios_ml_identidade_uq ON public.anuncios USING btree (user_id, loja_id, marketplace, ml_item_id, COALESCE(variation_id, ''''::text)) WHERE ((marketplace = ''ML''::text) AND (ml_item_id IS NOT NULL))';
  if n <> 1 then raise exception 'PRECHECK A: anuncios_ml_identidade_uq ausente ou diferente do estado 4'; end if;
  select count(*) into n from pg_index i
   join pg_class c on c.oid = i.indexrelid
   where c.relname = 'anuncios_ml_identidade_uq' and i.indrelid = 'public.anuncios'::regclass
     and i.indisunique and i.indisvalid and i.indisready;
  if n <> 1 then raise exception 'PRECHECK A: anuncios_ml_identidade_uq nao unica, invalida ou nao pronta'; end if;

  -- B. CHECK ML final do estado 4, exato e validado
  select count(*) into n from pg_constraint c
   where c.conrelid = 'public.anuncios'::regclass and c.conname = 'anuncios_ml_exige_loja' and c.convalidated
     and pg_get_constraintdef(c.oid) = 'CHECK (((marketplace <> ''ML''::text) OR (loja_id IS NOT NULL)))';
  if n <> 1 then raise exception 'PRECHECK B: anuncios_ml_exige_loja ausente, diferente ou nao validado'; end if;

  -- C. funcao do estado 4 (sem ponte transitoria), fonte EXATA
  select count(*) into n from pg_proc p
   where p.oid = 'public.anuncios_loja_do_dono()'::regprocedure
     and md5(p.prosrc) = '92cc5308242bc7dc540407f84f476f3e';
  if n <> 1 then raise exception 'PRECHECK C: funcao anuncios_loja_do_dono nao e a do estado 4'; end if;

  -- D. trigger do estado 4 (dono + marketplace)
  select count(*) into n from pg_trigger t
   where t.tgrelid = 'public.anuncios'::regclass and t.tgname = 'anuncios_loja_do_dono' and not t.tgisinternal
     and pg_get_triggerdef(t.oid) = 'CREATE TRIGGER anuncios_loja_do_dono BEFORE INSERT OR UPDATE OF loja_id, user_id, marketplace ON public.anuncios FOR EACH ROW EXECUTE FUNCTION anuncios_loja_do_dono()';
  if n <> 1 then raise exception 'PRECHECK D: trigger anuncios_loja_do_dono ausente ou diferente do estado 4'; end if;

  -- E. contratos Shopee exatos
  select count(*) into n from pg_indexes
   where schemaname = 'public' and tablename = 'anuncios' and indexname = 'anuncios_shopee_identidade_uq'
     and indexdef = 'CREATE UNIQUE INDEX anuncios_shopee_identidade_uq ON public.anuncios USING btree (user_id, loja_id, marketplace, ml_item_id, COALESCE(variation_id, ''''::text)) WHERE ((marketplace = ''Shopee''::text) AND (ml_item_id IS NOT NULL))';
  if n <> 1 then raise exception 'PRECHECK E: anuncios_shopee_identidade_uq ausente ou diferente'; end if;
  select count(*) into n from pg_constraint c
   where c.conrelid = 'public.anuncios'::regclass and c.conname = 'anuncios_shopee_exige_loja' and c.convalidated
     and pg_get_constraintdef(c.oid) = 'CHECK (((marketplace <> ''Shopee''::text) OR (loja_id IS NOT NULL)))';
  if n <> 1 then raise exception 'PRECHECK E: anuncios_shopee_exige_loja ausente ou diferente'; end if;

  -- F. status_marketplace ainda nao existe
  select count(*) into n from information_schema.columns
   where table_schema = 'public' and table_name = 'anuncios' and column_name = 'status_marketplace';
  if n > 0 then raise exception 'PRECHECK F: coluna status_marketplace ja existe — estado diferente do auditado'; end if;

  -- G. visto_em ainda nao existe
  select count(*) into n from information_schema.columns
   where table_schema = 'public' and table_name = 'anuncios' and column_name = 'visto_em';
  if n > 0 then raise exception 'PRECHECK G: coluna visto_em ja existe — estado diferente do auditado'; end if;

  -- H. nenhuma row ML sem loja
  select count(*) into n from public.anuncios where marketplace = 'ML' and loja_id is null;
  if n > 0 then raise exception 'PRECHECK H: % anuncio(s) ML sem loja_id', n; end if;

  -- I. nenhuma identidade ML duplicada
  select count(*) into n from (
    select 1 from public.anuncios
     where marketplace = 'ML' and ml_item_id is not null
     group by user_id, loja_id, marketplace, ml_item_id, coalesce(variation_id, '')
    having count(*) > 1
  ) x;
  if n > 0 then raise exception 'PRECHECK I: % identidade(s) ML duplicada(s)', n; end if;

  -- J. nenhuma relacao anuncio/loja invalida (inexistente, de outro dono ou de outro marketplace)
  select count(*) into n from public.anuncios a
   where a.loja_id is not null
     and not exists (select 1 from public.lojas l where l.id = a.loja_id and l.user_id = a.user_id and l.marketplace = a.marketplace);
  if n > 0 then raise exception 'PRECHECK J: % anuncio(s) com loja invalida (inexistente, de outro dono ou marketplace)', n; end if;
end $$;

-- Snapshot de TODAS as rows (linha inteira, ANTES das colunas novas): nenhum valor existente pode mudar.
create temp table _anuncios_antes_20261109 on commit drop as
  select a.id, md5(to_jsonb(a)::text) as h
    from public.anuncios a;
-- Snapshot do CATALOGO de anuncios (todo indice e toda constraint): a migration nao cria, nao remove e
-- nao muda nenhum.
create temp table _anuncios_indices_antes_20261109 on commit drop as
  select i.indexname, i.indexdef
    from pg_indexes i
   where i.schemaname = 'public' and i.tablename = 'anuncios';
create temp table _anuncios_constraints_antes_20261109 on commit drop as
  select c.conname, pg_get_constraintdef(c.oid) as def, c.convalidated
    from pg_constraint c
   where c.conrelid = 'public.anuncios'::regclass;

-- ── 2. As duas colunas (sem default, sem NOT NULL, sem CHECK, sem indice, sem backfill) ─────────
alter table public.anuncios
  add column status_marketplace text,
  add column visto_em timestamptz;

-- ── 3. Validacao final (qualquer divergencia aborta a transacao) ────────────────────────────────
do $$
declare n int;
begin
  -- V1. quantidade de rows inalterada
  select count(*) into n from public.anuncios;
  if n <> (select count(*) from _anuncios_antes_20261109) then raise exception 'V1: quantidade de rows mudou (% agora)', n; end if;

  -- V2. mesmos ids (nenhuma row nova, nenhuma sumida)
  select count(*) into n from public.anuncios a
   where not exists (select 1 from _anuncios_antes_20261109 s where s.id = a.id);
  if n > 0 then raise exception 'V2: % row(s) novas', n; end if;
  select count(*) into n from _anuncios_antes_20261109 s
   where not exists (select 1 from public.anuncios a where a.id = s.id);
  if n > 0 then raise exception 'V2: % row(s) sumiram', n; end if;

  -- V3. todos os campos anteriores inalterados (as duas chaves novas saem antes de comparar)
  select count(*) into n from _anuncios_antes_20261109 s
   join public.anuncios a on a.id = s.id
   where md5(((to_jsonb(a) - 'status_marketplace') - 'visto_em')::text) <> s.h;
  if n > 0 then raise exception 'V3: % row(s) com campo existente alterado', n; end if;

  -- V4. status_marketplace nasce NULL em todas as rows (sem backfill)
  select count(*) into n from public.anuncios where status_marketplace is not null;
  if n > 0 then raise exception 'V4: % row(s) com status_marketplace preenchido (backfill proibido)', n; end if;

  -- V5. visto_em nasce NULL em todas as rows (sem backfill)
  select count(*) into n from public.anuncios where visto_em is not null;
  if n > 0 then raise exception 'V5: % row(s) com visto_em preenchido (backfill proibido)', n; end if;

  -- V6. status_marketplace: text, nullable, sem default
  select count(*) into n from information_schema.columns
   where table_schema = 'public' and table_name = 'anuncios' and column_name = 'status_marketplace'
     and data_type = 'text' and is_nullable = 'YES' and column_default is null;
  if n <> 1 then raise exception 'V6: status_marketplace nao e text nullable sem default'; end if;

  -- V7. visto_em: timestamptz, nullable, sem default
  select count(*) into n from information_schema.columns
   where table_schema = 'public' and table_name = 'anuncios' and column_name = 'visto_em'
     and data_type = 'timestamp with time zone' and is_nullable = 'YES' and column_default is null;
  if n <> 1 then raise exception 'V7: visto_em nao e timestamptz nullable sem default'; end if;

  -- V8. UNIQUE ML final inalterada (definicao exata + unique/valid/ready)
  select count(*) into n from pg_indexes
   where schemaname = 'public' and tablename = 'anuncios' and indexname = 'anuncios_ml_identidade_uq'
     and indexdef = 'CREATE UNIQUE INDEX anuncios_ml_identidade_uq ON public.anuncios USING btree (user_id, loja_id, marketplace, ml_item_id, COALESCE(variation_id, ''''::text)) WHERE ((marketplace = ''ML''::text) AND (ml_item_id IS NOT NULL))';
  if n <> 1 then raise exception 'V8: anuncios_ml_identidade_uq mudou'; end if;
  select count(*) into n from pg_index i
   join pg_class c on c.oid = i.indexrelid
   where c.relname = 'anuncios_ml_identidade_uq' and i.indrelid = 'public.anuncios'::regclass
     and i.indisunique and i.indisvalid and i.indisready;
  if n <> 1 then raise exception 'V8: anuncios_ml_identidade_uq nao unica, invalida ou nao pronta'; end if;

  -- V9. CHECK ML final inalterado e validado
  select count(*) into n from pg_constraint c
   where c.conrelid = 'public.anuncios'::regclass and c.conname = 'anuncios_ml_exige_loja' and c.convalidated
     and pg_get_constraintdef(c.oid) = 'CHECK (((marketplace <> ''ML''::text) OR (loja_id IS NOT NULL)))';
  if n <> 1 then raise exception 'V9: anuncios_ml_exige_loja mudou ou nao esta validado'; end if;

  -- V10. funcao e trigger do estado 4 inalterados
  select count(*) into n from pg_proc p
   where p.oid = 'public.anuncios_loja_do_dono()'::regprocedure
     and md5(p.prosrc) = '92cc5308242bc7dc540407f84f476f3e';
  if n <> 1 then raise exception 'V10: funcao anuncios_loja_do_dono mudou'; end if;
  select count(*) into n from pg_trigger t
   where t.tgrelid = 'public.anuncios'::regclass and t.tgname = 'anuncios_loja_do_dono' and not t.tgisinternal
     and pg_get_triggerdef(t.oid) = 'CREATE TRIGGER anuncios_loja_do_dono BEFORE INSERT OR UPDATE OF loja_id, user_id, marketplace ON public.anuncios FOR EACH ROW EXECUTE FUNCTION anuncios_loja_do_dono()';
  if n <> 1 then raise exception 'V10: trigger anuncios_loja_do_dono mudou'; end if;

  -- V11. contratos Shopee inalterados
  select count(*) into n from pg_indexes
   where schemaname = 'public' and tablename = 'anuncios' and indexname = 'anuncios_shopee_identidade_uq'
     and indexdef = 'CREATE UNIQUE INDEX anuncios_shopee_identidade_uq ON public.anuncios USING btree (user_id, loja_id, marketplace, ml_item_id, COALESCE(variation_id, ''''::text)) WHERE ((marketplace = ''Shopee''::text) AND (ml_item_id IS NOT NULL))';
  if n <> 1 then raise exception 'V11: anuncios_shopee_identidade_uq mudou'; end if;
  select count(*) into n from pg_constraint c
   where c.conrelid = 'public.anuncios'::regclass and c.conname = 'anuncios_shopee_exige_loja' and c.convalidated
     and pg_get_constraintdef(c.oid) = 'CHECK (((marketplace <> ''Shopee''::text) OR (loja_id IS NOT NULL)))';
  if n <> 1 then raise exception 'V11: anuncios_shopee_exige_loja mudou'; end if;

  -- V12. nenhum indice ou CHECK novo envolvendo as duas colunas
  select count(*) into n from pg_indexes
   where schemaname = 'public' and tablename = 'anuncios'
     and (indexdef like '%status_marketplace%' or indexdef like '%visto_em%');
  if n > 0 then raise exception 'V12: % indice(s) novo(s) sobre status_marketplace/visto_em', n; end if;
  select count(*) into n from pg_constraint c
   where c.conrelid = 'public.anuncios'::regclass
     and (pg_get_constraintdef(c.oid) like '%status_marketplace%' or pg_get_constraintdef(c.oid) like '%visto_em%');
  if n > 0 then raise exception 'V12: % CHECK(s) novo(s) sobre status_marketplace/visto_em', n; end if;
  -- ...e o catalogo inteiro de anuncios e o MESMO de antes (nenhum indice/constraint criado, removido ou alterado)
  select count(*) into n from _anuncios_indices_antes_20261109 s
   where not exists (select 1 from pg_indexes i where i.schemaname = 'public' and i.tablename = 'anuncios'
                       and i.indexname = s.indexname and i.indexdef = s.indexdef);
  if n > 0 then raise exception 'V12: % indice(s) removido(s) ou alterado(s)', n; end if;
  select count(*) into n from pg_indexes i
   where i.schemaname = 'public' and i.tablename = 'anuncios'
     and not exists (select 1 from _anuncios_indices_antes_20261109 s where s.indexname = i.indexname);
  if n > 0 then raise exception 'V12: % indice(s) novo(s) em anuncios', n; end if;
  select count(*) into n from _anuncios_constraints_antes_20261109 s
   where not exists (select 1 from pg_constraint c where c.conrelid = 'public.anuncios'::regclass
                       and c.conname = s.conname and pg_get_constraintdef(c.oid) = s.def and c.convalidated = s.convalidated);
  if n > 0 then raise exception 'V12: % constraint(s) removida(s) ou alterada(s)', n; end if;
  select count(*) into n from pg_constraint c
   where c.conrelid = 'public.anuncios'::regclass
     and not exists (select 1 from _anuncios_constraints_antes_20261109 s where s.conname = c.conname);
  if n > 0 then raise exception 'V12: % constraint(s) nova(s) em anuncios', n; end if;
end $$;

commit;
