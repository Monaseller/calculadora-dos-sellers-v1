-- PEDIDOS — IDENTIDADE DA LINHA DE VENDA ML NO BANCO (CDS V2 Vendas A4-C) = 20261110. Hardening, aditiva.
--
-- O que faz (UMA transacao; qualquer RAISE desfaz tudo):
--   1. PRECHECK fail-closed (A-E) ANTES de qualquer DDL.
--   2. Cria SO um indice UNIQUE parcial — a identidade SEMANTICA da linha ML:
--        (loja_id, order_id, ml_item_id, coalesce(variation_id, ''))
--        WHERE marketplace = 'ML' AND loja_id IS NOT NULL AND ml_item_id IS NOT NULL
--      `pedidos.id` continua sendo o PK tecnico (legado `<user>_ML_<order>_<item>` e novo
--      `<user>_ML_<loja>_<order>_<item>_<variacao|nv>` coexistem); o indice NAO depende do formato do id:
--      dois PKs diferentes com a MESMA identidade sao recusados.
--   3. SEM backfill, SEM UPDATE/DELETE, SEM mudanca de nulabilidade: nenhuma row muda.
--   4. Validacao (V1-V2): indice criado, unico, valido e pronto.
--
-- Por que este predicado: o marketplace persistido das rows ML e exatamente 'ML' (auditado). Sem loja
-- ou sem item a identidade esta INCOMPLETA — o indice nao finge protege-la (sao excluidas pelo WHERE,
-- explicito, em vez de "protegidas" por NULL distinto). Producao (auditoria read-only de 2026-10-14):
-- 211145 rows ML, 0 com loja/order/item NULL, 0 duplicatas semanticas.
--
-- Sentinel de variacao: coalesce(variation_id, '') — NULL (item sem variacao, ou historico em que a
-- variacao nao foi conhecida) e UMA identidade deterministica. Seguro porque '' nunca e uma variacao
-- real: o writer (lib/sync-ml.ts variacaoDoItemML) grava NULL para variacao ausente/vazia, as variacoes
-- do provider sao numericas, e o PRECHECK D exige 0 rows ML com variation_id = ''. Mesmo padrao da
-- identidade ML de anuncios (anuncios_ml_identidade_uq).
--
-- Modo: CREATE UNIQUE INDEX comum (nao CONCURRENTLY) — o caminho oficial de aplicacao e o arquivo
-- inteiro numa unica chamada transacional, e CONCURRENTLY nao roda dentro de transacao. Toma lock
-- SHARE em pedidos (bloqueia ESCRITA durante a construcao, leitura segue); ~211k rows ML, construcao
-- curta. lock_timeout 5s: sem o lock, falha inteira (nada muda) e pode ser tentada de novo.
--
-- Aplicacao: SO por gate explicito, pelo caminho comprovadamente atomico (MCP execute_sql, arquivo
-- inteiro numa unica chamada). Nunca apply_migration / db push; nao registrar em
-- supabase_migrations.schema_migrations (divida de historico conhecida).
--
-- ROLLBACK CONTROLADO (documentado; NAO executar sem autorizacao explicita):
--   drop index public.pedidos_ml_identidade_uq;
--   (sem perda de dado: o indice nao guarda nada alem da garantia.)

begin;

-- Limites LOCAIS (so esta transacao): nunca esperar lock indefinidamente em producao.
set local lock_timeout = '5s';
set local statement_timeout = '120s';

lock table public.pedidos in share mode;

-- ── 1. PRECHECK (fail-closed; nenhum DDL antes daqui) ────────────────────────────────────────────
do $$
declare n int;
begin
  -- A. o indice NAO existe (mesmo nome com outra definicao exige investigacao — nunca substituir)
  select count(*) into n from pg_indexes
   where schemaname = 'public' and tablename = 'pedidos' and indexname = 'pedidos_ml_identidade_uq';
  if n <> 0 then raise exception 'PRECHECK A: pedidos_ml_identidade_uq ja existe — investigar antes de qualquer acao'; end if;

  -- B. colunas da identidade com os tipos auditados
  select count(*) into n from information_schema.columns
   where table_schema = 'public' and table_name = 'pedidos'
     and ((column_name = 'loja_id' and data_type = 'uuid')
       or (column_name = 'order_id' and data_type = 'text' and is_nullable = 'NO')
       or (column_name = 'ml_item_id' and data_type = 'text')
       or (column_name = 'variation_id' and data_type = 'text')
       or (column_name = 'marketplace' and data_type = 'text' and is_nullable = 'NO'));
  if n <> 5 then raise exception 'PRECHECK B: colunas da identidade ausentes ou com tipo diferente do auditado'; end if;

  -- C. ZERO duplicatas semanticas no conjunto que o indice vai cobrir
  select count(*) into n from (
    select loja_id from public.pedidos
     where marketplace = 'ML' and loja_id is not null and ml_item_id is not null
     group by loja_id, order_id, ml_item_id, coalesce(variation_id, '')
    having count(*) > 1) d;
  if n <> 0 then raise exception 'PRECHECK C: % identidade(s) ML duplicada(s) — nao deduplicar aqui; investigar', n; end if;

  -- D. o sentinel '' nao e usado como variacao real
  select count(*) into n from public.pedidos where marketplace = 'ML' and variation_id = '';
  if n <> 0 then raise exception 'PRECHECK D: % row(s) ML com variation_id vazio — sentinel inseguro', n; end if;

  -- E. existem rows ML (o indice cobre o marketplace auditado, nao um nome errado)
  select count(*) into n from public.pedidos where marketplace = 'ML';
  if n = 0 then raise exception 'PRECHECK E: nenhuma row ML — marketplace diferente do auditado'; end if;
end $$;

-- ── 2. INDICE (unica mudanca) ────────────────────────────────────────────────────────────────────
create unique index pedidos_ml_identidade_uq on public.pedidos (loja_id, order_id, ml_item_id, coalesce(variation_id, ''))
  where marketplace = 'ML' and loja_id is not null and ml_item_id is not null;

-- ── 3. VALIDACAO ─────────────────────────────────────────────────────────────────────────────────
do $$
declare n int;
begin
  -- V1. indice presente, unico, valido e pronto
  select count(*) into n from pg_index i
   join pg_class c on c.oid = i.indexrelid
   where c.relname = 'pedidos_ml_identidade_uq' and i.indrelid = 'public.pedidos'::regclass
     and i.indisunique and i.indisvalid and i.indisready;
  if n <> 1 then raise exception 'V1: pedidos_ml_identidade_uq ausente, invalido ou nao pronto'; end if;

  -- V2. nenhuma duplicata semantica sobreviveu (o indice existe e o conjunto continua limpo)
  select count(*) into n from (
    select loja_id from public.pedidos
     where marketplace = 'ML' and loja_id is not null and ml_item_id is not null
     group by loja_id, order_id, ml_item_id, coalesce(variation_id, '')
    having count(*) > 1) d;
  if n <> 0 then raise exception 'V2: identidade ML duplicada apos o indice'; end if;
end $$;

commit;
