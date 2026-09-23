-- ============================================================
-- `agente_perguntas_ml` — prova de COMPORTAMENTO (R1).
--
-- NAO EXECUTADO. Exige a migration 20261009 aplicada, e aplicar exige
-- autorizacao explicita.
--
-- ── Por que SQL, e nao TypeScript ───────────────────────────────────
--
-- O que se prova aqui e semantica de upsert, constraint, rollback e
-- privilegio — tudo do Postgres. Uma suite TypeScript so observaria o
-- efeito de longe, por um duplo que ELA define, e duplo proprio nao
-- prova comportamento de banco de verdade.
--
-- ── Zero residuo ────────────────────────────────────────────────────
--
-- Tudo roda em UMA transacao que termina em ROLLBACK. A loja e os donos
-- sao sinteticos e nascem aqui. Nada sobrevive, nem em caso de sucesso.
--
-- Rodar:  psql "<conexao>" -v ON_ERROR_STOP=1 -f scripts/testar-agentes-perguntas-inbox-banco.sql
-- ============================================================

\set ON_ERROR_STOP on

begin;

-- `lojas.user_id` tem CHECK de formato uuid.
\set DONO   'aaaaaaaa-0000-4000-8000-0000000000d1'
\set OUTRO  'bbbbbbbb-0000-4000-8000-0000000000d2'
\set LOJA   'cccccccc-0000-4000-8000-0000000000e1'
\set ALHEIA 'dddddddd-0000-4000-8000-0000000000e2'
\set SHOPEE 'eeeeeeee-0000-4000-8000-0000000000e3'

insert into public.lojas (id, nome, marketplace, user_id, ativo) values
  (:'LOJA'::uuid,   'ML SINTETICA',     'ML',     :'DONO',  true),
  (:'ALHEIA'::uuid, 'ML DE OUTRO',      'ML',     :'OUTRO', true),
  -- Mesmo dono, outro marketplace: e o caso 10.
  (:'SHOPEE'::uuid, 'SHOPEE SINTETICA', 'Shopee', :'DONO',  true);

create or replace function pg_temp.exigir(p_cond boolean, p_nome text)
returns void language plpgsql as $$
begin
  if p_cond then raise notice 'PASS  %', p_nome;
  else raise exception 'FAIL  %', p_nome; end if;
end $$;

create or replace function pg_temp.q(
  p_id text, p_anuncio text, p_texto text, p_status text, p_data text
) returns jsonb language sql immutable as $$
  select jsonb_build_object(
    'id_externo', p_id, 'anuncio_id_externo', p_anuncio, 'texto', p_texto,
    'provider_status', p_status, 'criada_em_provider', p_data);
$$;

/* Executa a RPC e devolve o SQLSTATE, ou null se passou. */
create or replace function pg_temp.erro_de(p_user text, p_loja uuid, p_lote jsonb)
returns text language plpgsql as $$
begin
  perform public.agente_perguntas_ml_upsert_lote(p_user, p_loja, p_lote);
  return null;
exception when others then return SQLSTATE;
end $$;

-- ══ SECAO R · REENTRANCIA (DEF1-INBOX-REENTRANCIA) ═══════════════════
--
-- A RPC criava QUATRO relacoes temporarias com `on commit drop`. Elas so
-- somem no COMMIT, nao na saida da funcao — entao a segunda chamada na
-- MESMA transacao esbarrava na relacao que a primeira havia deixado:
--
--   ERROR: relation "_entrada" already exists
--
-- Toda esta suite roda em UMA transacao, entao o defeito a bloqueava
-- inteira a partir do segundo caso. Estes tres casos existem para que
-- uma regressao volte a aparecer AQUI, e nao vinte casos adiante.
--
-- R1 e R2 usam perguntas DIFERENTES de proposito. Replay identico
-- provaria idempotencia, que e outro invariante; reentrancia e poder
-- chamar de novo, com entrada nova, sem carregar estado da chamada
-- anterior.

-- ─── R1. Duas chamadas validas na MESMA transacao ─────────────────────
do $$
declare m1 jsonb; m2 jsonb;
begin
  m1 := public.agente_perguntas_ml_upsert_lote(
    'aaaaaaaa-0000-4000-8000-0000000000d1', 'cccccccc-0000-4000-8000-0000000000e1'::uuid,
    jsonb_build_array(pg_temp.q('R-Q1','MLB-R1','Primeira pergunta.','UNANSWERED','2026-09-21T09:00:00Z')));
  m2 := public.agente_perguntas_ml_upsert_lote(
    'aaaaaaaa-0000-4000-8000-0000000000d1', 'cccccccc-0000-4000-8000-0000000000e1'::uuid,
    jsonb_build_array(pg_temp.q('R-Q2','MLB-R2','Segunda pergunta, outra.','UNANSWERED','2026-09-21T09:05:00Z')));
  perform pg_temp.exigir((m1->>'novas')::int = 1, 'R1 1a chamada insere');
  perform pg_temp.exigir((m2->>'novas')::int = 1, 'R1 2a chamada insere');
  perform pg_temp.exigir(
    (select count(*) from public.agente_perguntas_ml where id_externo in ('R-Q1','R-Q2')) = 2,
    'R1 as duas linhas existem');
end $$;

-- ─── R2. Tres chamadas validas na MESMA transacao ─────────────────────
do $$
declare m jsonb; v_novas int := 0; i int;
begin
  for i in 3..5 loop
    m := public.agente_perguntas_ml_upsert_lote(
      'aaaaaaaa-0000-4000-8000-0000000000d1', 'cccccccc-0000-4000-8000-0000000000e1'::uuid,
      jsonb_build_array(pg_temp.q('R-Q' || i, 'MLB-R' || i,
        'Pergunta numero ' || i || '.', 'UNANSWERED', '2026-09-21T10:0' || i || ':00Z')));
    v_novas := v_novas + (m->>'novas')::int;
  end loop;
  perform pg_temp.exigir(v_novas = 3, 'R2 tres chamadas, tres insercoes');
  perform pg_temp.exigir(
    (select count(*) from public.agente_perguntas_ml where id_externo in ('R-Q3','R-Q4','R-Q5')) = 3,
    'R2 as tres linhas existem');
end $$;

-- ─── R3. Erro recuperado por SAVEPOINT nao trava a proxima chamada ────
--
-- O ponto e o `on commit drop`: numa implementacao com relacao
-- temporaria, a chamada que FALHOU podia ter criado a relacao antes de
-- estourar. `rollback to savepoint` desfaz a criacao, mas basta a ordem
-- inversa — criar, falhar depois — para a proxima chamada colidir. Aqui
-- a recuperacao tem de ser total.
savepoint sp1;
do $$
declare e text;
begin
  -- Texto vazio: recusa estrutural conhecida, 22023.
  e := pg_temp.erro_de('aaaaaaaa-0000-4000-8000-0000000000d1', 'cccccccc-0000-4000-8000-0000000000e1'::uuid,
    jsonb_build_array(pg_temp.q('R-Q6','MLB-R6','   ','UNANSWERED','2026-09-21T11:00:00Z')));
  perform pg_temp.exigir(e = '22023', 'R3 chamada invalida recusada com 22023');
end $$;
rollback to savepoint sp1;

do $$
declare m jsonb;
begin
  m := public.agente_perguntas_ml_upsert_lote(
    'aaaaaaaa-0000-4000-8000-0000000000d1', 'cccccccc-0000-4000-8000-0000000000e1'::uuid,
    jsonb_build_array(pg_temp.q('R-Q7','MLB-R7','Depois do rollback to savepoint.','UNANSWERED','2026-09-21T11:05:00Z')));
  perform pg_temp.exigir((m->>'novas')::int = 1, 'R3 chamada valida apos rollback to savepoint');
  perform pg_temp.exigir(
    (select count(*) from public.agente_perguntas_ml where id_externo = 'R-Q6') = 0,
    'R3 a chamada recusada nao deixou linha');
end $$;

-- Os casos 1-24 contam a partir de uma inbox vazia. A secao R nasceu
-- depois deles e nao pode mover o placar de ninguem.
delete from public.agente_perguntas_ml where id_externo like 'R-Q%';

-- FIM DA SECAO R

-- ══ SECAO V · SEMANTICA TEMPORAL (F2 e F3) ═══════════════════════════
--
-- `now()` e o instante da TRANSACAO. Duas chamadas validas dentro da
-- mesma transacao recebiam o MESMO valor, entao `ultimo_visto_em` nao
-- avancava (F2) e `alterado_em` nao avancava em mudanca material (F3).
-- A RPC passou a capturar UM `clock_timestamp()` por chamada.
--
-- Estes casos nao dependem de sorte de microssegundo: ha `pg_sleep`
-- explicito entre observacoes. Ele so existe aqui, no banco LOCAL
-- descartavel.

-- ─── V1. `ultimo_visto_em` avanca entre duas chamadas na transacao ────
do $$
declare m jsonb; v_antes timestamptz; v_depois timestamptz; v_primeiro timestamptz;
begin
  m := public.agente_perguntas_ml_upsert_lote(
    'aaaaaaaa-0000-4000-8000-0000000000d1', 'cccccccc-0000-4000-8000-0000000000e1',
    jsonb_build_array(pg_temp.q('V-Q1','MLB-V1','Observacao um.','UNANSWERED','2026-09-22T08:00:00Z')));
  select ultimo_visto_em, primeiro_visto_em into v_antes, v_primeiro
    from public.agente_perguntas_ml where id_externo = 'V-Q1';
  perform pg_temp.exigir(v_antes = v_primeiro,
    'V1 na insercao, primeiro_visto_em = ultimo_visto_em');

  perform pg_sleep(0.05);

  m := public.agente_perguntas_ml_upsert_lote(
    'aaaaaaaa-0000-4000-8000-0000000000d1', 'cccccccc-0000-4000-8000-0000000000e1',
    jsonb_build_array(pg_temp.q('V-Q1','MLB-V1','Observacao um.','UNANSWERED','2026-09-22T08:00:00Z')));
  select ultimo_visto_em into v_depois
    from public.agente_perguntas_ml where id_externo = 'V-Q1';

  perform pg_temp.exigir(v_depois > v_antes, 'V1 ultimo_visto_em avanca na MESMA transacao');
  perform pg_temp.exigir(
    (select primeiro_visto_em from public.agente_perguntas_ml where id_externo = 'V-Q1') = v_primeiro,
    'V1 primeiro_visto_em nao se move');
end $$;

-- ─── V2. Mudanca material na MESMA transacao ──────────────────────────
do $$
declare m jsonb; v_alt0 timestamptz; v_alt1 timestamptz; v_visto0 timestamptz; v_visto1 timestamptz;
begin
  m := public.agente_perguntas_ml_upsert_lote(
    'aaaaaaaa-0000-4000-8000-0000000000d1', 'cccccccc-0000-4000-8000-0000000000e1',
    jsonb_build_array(pg_temp.q('V-Q2','MLB-V2','Texto A.','UNANSWERED','2026-09-22T08:10:00Z')));
  select alterado_em, ultimo_visto_em into v_alt0, v_visto0
    from public.agente_perguntas_ml where id_externo = 'V-Q2';

  perform pg_sleep(0.05);

  m := public.agente_perguntas_ml_upsert_lote(
    'aaaaaaaa-0000-4000-8000-0000000000d1', 'cccccccc-0000-4000-8000-0000000000e1',
    jsonb_build_array(pg_temp.q('V-Q2','MLB-V2','Texto B.','UNANSWERED','2026-09-22T08:10:00Z')));
  select alterado_em, ultimo_visto_em into v_alt1, v_visto1
    from public.agente_perguntas_ml where id_externo = 'V-Q2';

  perform pg_temp.exigir(
    (select texto from public.agente_perguntas_ml where id_externo = 'V-Q2') = 'Texto B.',
    'V2 texto mutavel foi atualizado');
  perform pg_temp.exigir(v_alt1 > v_alt0, 'V2 alterado_em avanca em mudanca material');
  perform pg_temp.exigir(v_visto1 > v_visto0, 'V2 ultimo_visto_em tambem avanca');
  perform pg_temp.exigir((m->>'atualizadas')::int = 1, 'V2 contada como atualizada');
end $$;

-- ─── V3. Reobservacao PURA ────────────────────────────────────────────
do $$
declare m jsonb; v_alt0 timestamptz; v_alt1 timestamptz; v_visto0 timestamptz; v_visto1 timestamptz;
begin
  m := public.agente_perguntas_ml_upsert_lote(
    'aaaaaaaa-0000-4000-8000-0000000000d1', 'cccccccc-0000-4000-8000-0000000000e1',
    jsonb_build_array(pg_temp.q('V-Q3','MLB-V3','Texto imutado.','UNANSWERED','2026-09-22T08:20:00Z')));
  select alterado_em, ultimo_visto_em into v_alt0, v_visto0
    from public.agente_perguntas_ml where id_externo = 'V-Q3';

  perform pg_sleep(0.05);

  m := public.agente_perguntas_ml_upsert_lote(
    'aaaaaaaa-0000-4000-8000-0000000000d1', 'cccccccc-0000-4000-8000-0000000000e1',
    jsonb_build_array(pg_temp.q('V-Q3','MLB-V3','Texto imutado.','UNANSWERED','2026-09-22T08:20:00Z')));
  select alterado_em, ultimo_visto_em into v_alt1, v_visto1
    from public.agente_perguntas_ml where id_externo = 'V-Q3';

  perform pg_temp.exigir(v_visto1 > v_visto0, 'V3 reobservacao pura avanca ultimo_visto_em');
  perform pg_temp.exigir(v_alt1 = v_alt0, 'V3 reobservacao pura NAO move alterado_em');
  perform pg_temp.exigir((m->>'reobservadas')::int = 1, 'V3 contada como reobservada');
end $$;

-- ─── V4. Chamada RECUSADA nao carimba nada ────────────────────────────
do $$
declare m jsonb;
begin
  m := public.agente_perguntas_ml_upsert_lote(
    'aaaaaaaa-0000-4000-8000-0000000000d1', 'cccccccc-0000-4000-8000-0000000000e1',
    jsonb_build_array(pg_temp.q('V-Q4','MLB-V4','Antes da recusa.','UNANSWERED','2026-09-22T08:30:00Z')));
end $$;

-- Guardar os tres timestamps FORA do escopo do savepoint. Variavel de
-- plpgsql nao sobrevive ao bloco, e o `rollback to savepoint` nao pode
-- apagar a referencia contra a qual vamos comparar.
create temporary table _v4_antes (visto timestamptz, alterado timestamptz, primeiro timestamptz);
insert into _v4_antes
  select ultimo_visto_em, alterado_em, primeiro_visto_em
    from public.agente_perguntas_ml where id_externo = 'V-Q4';

savepoint sp_v4;
do $$
declare e text;
begin
  perform pg_sleep(0.05);
  e := pg_temp.erro_de('aaaaaaaa-0000-4000-8000-0000000000d1', 'cccccccc-0000-4000-8000-0000000000e1',
    jsonb_build_array(pg_temp.q('V-Q5','MLB-V5','   ','UNANSWERED','2026-09-22T08:35:00Z')));
  perform pg_temp.exigir(e = '22023', 'V4 chamada invalida recusada com 22023');
end $$;
rollback to savepoint sp_v4;

do $$
declare m jsonb; v_visto timestamptz; v_alt timestamptz; v_pri timestamptz;
begin
  select ultimo_visto_em, alterado_em, primeiro_visto_em into v_visto, v_alt, v_pri
    from public.agente_perguntas_ml where id_externo = 'V-Q4';
  perform pg_temp.exigir(
    (select count(*) from _v4_antes where visto = v_visto and alterado = v_alt and primeiro = v_pri) = 1,
    'V4 a chamada recusada nao moveu timestamp algum');
  perform pg_temp.exigir(
    (select count(*) from public.agente_perguntas_ml where id_externo = 'V-Q5') = 0,
    'V4 a chamada recusada nao deixou linha');

  perform pg_sleep(0.05);

  m := public.agente_perguntas_ml_upsert_lote(
    'aaaaaaaa-0000-4000-8000-0000000000d1', 'cccccccc-0000-4000-8000-0000000000e1',
    jsonb_build_array(pg_temp.q('V-Q4','MLB-V4','Antes da recusa.','UNANSWERED','2026-09-22T08:30:00Z')));
  perform pg_temp.exigir(
    (select ultimo_visto_em from public.agente_perguntas_ml where id_externo = 'V-Q4') > v_visto,
    'V4 observacao valida seguinte volta a avancar');
end $$;

drop table _v4_antes;

-- Os casos 1-24 contam a partir de uma inbox vazia.
delete from public.agente_perguntas_ml where id_externo like 'V-Q%';

-- FIM DA SECAO V


-- ─── 21. Lote VAZIO e valido ──────────────────────────────────────────
do $$
declare m jsonb;
begin
  m := public.agente_perguntas_ml_upsert_lote(
    'aaaaaaaa-0000-4000-8000-0000000000d1', 'cccccccc-0000-4000-8000-0000000000e1',
    '[]'::jsonb);
  perform pg_temp.exigir((m->>'recebidas')::int = 0, '21 lote vazio: recebidas 0');
  perform pg_temp.exigir((m->>'novas')::int = 0, '21 lote vazio: novas 0');
  perform pg_temp.exigir((m->>'reobservadas')::int = 0, '21 lote vazio: reobservadas 0');
  perform pg_temp.exigir(
    (select count(*) from public.agente_perguntas_ml) = 0, '21 lote vazio nao escreve');
end $$;

-- ─── 1. Insert novo ───────────────────────────────────────────────────
do $$
declare m jsonb;
begin
  m := public.agente_perguntas_ml_upsert_lote(
    'aaaaaaaa-0000-4000-8000-0000000000d1', 'cccccccc-0000-4000-8000-0000000000e1',
    jsonb_build_array(pg_temp.q('Q1','MLB1','Acompanha manual?','UNANSWERED','2026-09-20T10:00:00Z')));
  perform pg_temp.exigir((m->>'novas')::int = 1, '1  insert novo');
  perform pg_temp.exigir((m->>'recebidas')::int = 1 and (m->>'unicas')::int = 1, '1  metricas de entrada');
  perform pg_temp.exigir((m->>'atualizadas')::int = 0, '1  nada atualizado');
  perform pg_temp.exigir((select count(*) from public.agente_perguntas_ml) = 1, '1  uma linha');
  perform pg_temp.exigir(
    (select estado_interno from public.agente_perguntas_ml) = 'nova', '1  estado_interno = nova');
end $$;

-- ─── 2. Replay · 3. ultimo_visto muda · 8. primeiro_visto preservado ──
-- ─── 24. alterado_em NAO muda em reobservacao pura ────────────────────
do $$
declare m jsonb; v_visto timestamptz; v_primeiro timestamptz; v_alterado timestamptz;
begin
  select ultimo_visto_em, primeiro_visto_em, alterado_em
    into v_visto, v_primeiro, v_alterado
  from public.agente_perguntas_ml;
  perform pg_sleep(0.05);

  m := public.agente_perguntas_ml_upsert_lote(
    'aaaaaaaa-0000-4000-8000-0000000000d1', 'cccccccc-0000-4000-8000-0000000000e1',
    jsonb_build_array(pg_temp.q('Q1','MLB1','Acompanha manual?','UNANSWERED','2026-09-20T10:00:00Z')));

  perform pg_temp.exigir((select count(*) from public.agente_perguntas_ml) = 1, '2  zero duplicata');
  perform pg_temp.exigir((m->>'novas')::int = 0 and (m->>'reobservadas')::int = 1,
    '2  contada como reobservada');
  perform pg_temp.exigir(
    (select ultimo_visto_em from public.agente_perguntas_ml) > v_visto, '3  ultimo_visto_em avancou');
  perform pg_temp.exigir(
    (select primeiro_visto_em from public.agente_perguntas_ml) = v_primeiro,
    '8  primeiro_visto_em preservado');
  perform pg_temp.exigir(
    (select alterado_em from public.agente_perguntas_ml) = v_alterado,
    '24 alterado_em NAO muda em reobservacao pura');
end $$;

-- ─── 4. provider_status muda ──────────────────────────────────────────
do $$
declare m jsonb; v_alterado timestamptz;
begin
  select alterado_em into v_alterado from public.agente_perguntas_ml;
  perform pg_sleep(0.05);
  m := public.agente_perguntas_ml_upsert_lote(
    'aaaaaaaa-0000-4000-8000-0000000000d1', 'cccccccc-0000-4000-8000-0000000000e1',
    jsonb_build_array(pg_temp.q('Q1','MLB1','Acompanha manual?','UNDER_REVIEW','2026-09-20T10:00:00Z')));
  perform pg_temp.exigir((m->>'atualizadas')::int = 1, '4  contada como atualizada');
  perform pg_temp.exigir(
    (select provider_status from public.agente_perguntas_ml) = 'UNDER_REVIEW',
    '4  status observado gravado, sem CHECK de vocabulario');
  perform pg_temp.exigir(
    (select alterado_em from public.agente_perguntas_ml) > v_alterado,
    '7  alterado_em avanca em mudanca material');
end $$;

-- ─── 5. Texto valido muda ─────────────────────────────────────────────
do $$
declare m jsonb;
begin
  m := public.agente_perguntas_ml_upsert_lote(
    'aaaaaaaa-0000-4000-8000-0000000000d1', 'cccccccc-0000-4000-8000-0000000000e1',
    jsonb_build_array(pg_temp.q('Q1','MLB1','Texto editado','UNDER_REVIEW','2026-09-20T10:00:00Z')));
  perform pg_temp.exigir((m->>'atualizadas')::int = 1, '5  texto novo conta como atualizada');
  perform pg_temp.exigir(
    (select texto from public.agente_perguntas_ml) = 'Texto editado', '5  texto atualizado');
end $$;

-- ─── 6. Texto vazio DERRUBA o lote ────────────────────────────────────
do $$
declare v_erro text;
begin
  v_erro := pg_temp.erro_de(
    'aaaaaaaa-0000-4000-8000-0000000000d1', 'cccccccc-0000-4000-8000-0000000000e1',
    jsonb_build_array(pg_temp.q('Q1','MLB1','   ','UNDER_REVIEW','2026-09-20T10:00:00Z')));
  perform pg_temp.exigir(v_erro = '22023', '6  texto vazio derruba o lote');
  perform pg_temp.exigir(
    (select texto from public.agente_perguntas_ml) = 'Texto editado',
    '6  e nao apagou o texto gravado');
end $$;

-- ─── 7. estado_interno preservado ─────────────────────────────────────
do $$
begin
  update public.agente_perguntas_ml set estado_interno = 'em_processamento';
  perform public.agente_perguntas_ml_upsert_lote(
    'aaaaaaaa-0000-4000-8000-0000000000d1', 'cccccccc-0000-4000-8000-0000000000e1',
    jsonb_build_array(pg_temp.q('Q1','MLB1','Texto editado','UNANSWERED','2026-09-20T10:00:00Z')));
  perform pg_temp.exigir(
    (select estado_interno from public.agente_perguntas_ml) = 'em_processamento',
    '7  estado_interno preservado — o polling nao desfaz trabalho');
end $$;

-- ─── 9. Tenant mismatch · 10. mesmo dono, marketplace errado ──────────
do $$
declare v_antes bigint;
begin
  select count(*) into v_antes from public.agente_perguntas_ml;

  perform pg_temp.exigir(
    pg_temp.erro_de('bbbbbbbb-0000-4000-8000-0000000000d2',
                    'cccccccc-0000-4000-8000-0000000000e1',
                    jsonb_build_array(pg_temp.q('Q1','MLB1','x','UNANSWERED','2026-09-20T10:00:00Z'))) = '42501',
    '9  dono errado para a loja -> 42501');

  perform pg_temp.exigir(
    pg_temp.erro_de('aaaaaaaa-0000-4000-8000-0000000000d1',
                    'dddddddd-0000-4000-8000-0000000000e2',
                    jsonb_build_array(pg_temp.q('Q9','MLB9','x','UNANSWERED','2026-09-20T10:00:00Z'))) = '42501',
    '9  loja de outro dono -> 42501');

  -- O caso que a R1 acrescentou: loja DO DONO, mas Shopee.
  perform pg_temp.exigir(
    pg_temp.erro_de('aaaaaaaa-0000-4000-8000-0000000000d1',
                    'eeeeeeee-0000-4000-8000-0000000000e3',
                    jsonb_build_array(pg_temp.q('Q8','MLB8','x','UNANSWERED','2026-09-20T10:00:00Z'))) = '42501',
    '10 mesmo dono + marketplace errado -> 42501');

  perform pg_temp.exigir(
    (select count(*) from public.agente_perguntas_ml) = v_antes, '10 nenhuma linha gravada');
end $$;

-- ─── 11. Linha invalida derruba o LOTE ────────────────────────────────
do $$
declare v_antes bigint;
begin
  select count(*) into v_antes from public.agente_perguntas_ml;
  perform pg_temp.exigir(
    pg_temp.erro_de('aaaaaaaa-0000-4000-8000-0000000000d1',
                    'cccccccc-0000-4000-8000-0000000000e1',
                    jsonb_build_array(
                      pg_temp.q('Q2','MLB2','valida','UNANSWERED','2026-09-20T10:00:00Z'),
                      pg_temp.q('','MLB3','sem id','UNANSWERED','2026-09-20T10:00:00Z'))) = '22023',
    '11 lote com linha invalida falha');
  perform pg_temp.exigir(
    (select count(*) from public.agente_perguntas_ml) = v_antes,
    '11 a linha VALIDA do mesmo lote tambem nao entrou');
end $$;

-- ─── 12. Duas chaves distintas ────────────────────────────────────────
do $$
declare m jsonb;
begin
  m := public.agente_perguntas_ml_upsert_lote(
    'aaaaaaaa-0000-4000-8000-0000000000d1', 'cccccccc-0000-4000-8000-0000000000e1',
    jsonb_build_array(
      pg_temp.q('Q2','MLB2','duas','UNANSWERED','2026-09-20T11:00:00Z'),
      pg_temp.q('Q3','MLB3','chaves','UNANSWERED','2026-09-20T12:00:00Z')));
  perform pg_temp.exigir((m->>'novas')::int = 2, '12 duas chaves distintas entram');
  perform pg_temp.exigir((select count(*) from public.agente_perguntas_ml) = 3, '12 total = 3');
end $$;

-- ─── 13. Duplicata EXATA no lote colapsa ──────────────────────────────
do $$
declare m jsonb;
begin
  m := public.agente_perguntas_ml_upsert_lote(
    'aaaaaaaa-0000-4000-8000-0000000000d1', 'cccccccc-0000-4000-8000-0000000000e1',
    jsonb_build_array(
      pg_temp.q('Q4','MLB4','igual','UNANSWERED','2026-09-20T13:00:00Z'),
      pg_temp.q('Q4','MLB4','igual','UNANSWERED','2026-09-20T13:00:00Z')));
  perform pg_temp.exigir((m->>'recebidas')::int = 2, '13 recebeu 2');
  perform pg_temp.exigir((m->>'unicas')::int = 1, '13 unicas 1');
  perform pg_temp.exigir((m->>'duplicadas_no_lote')::int = 1, '13 removeu 1 por duplicidade');
  perform pg_temp.exigir((m->>'novas')::int = 1, '13 gravou 1');
end $$;

-- ─── 14. Duplicata DIVERGENTE no lote falha ───────────────────────────
do $$
declare v_antes bigint;
begin
  select count(*) into v_antes from public.agente_perguntas_ml;
  perform pg_temp.exigir(
    pg_temp.erro_de('aaaaaaaa-0000-4000-8000-0000000000d1',
                    'cccccccc-0000-4000-8000-0000000000e1',
                    jsonb_build_array(
                      pg_temp.q('Q5','MLB5','versao A','UNANSWERED','2026-09-20T14:00:00Z'),
                      pg_temp.q('Q5','MLB5','versao B','UNANSWERED','2026-09-20T14:00:00Z'))) = '22023',
    '14 duplicata divergente falha');
  perform pg_temp.exigir(
    (select count(*) from public.agente_perguntas_ml) = v_antes, '14 nada gravado');
end $$;

-- ─── 22/23. Identidade do provider e IMUTAVEL ─────────────────────────
do $$
declare v_antes bigint;
begin
  select count(*) into v_antes from public.agente_perguntas_ml;

  -- Q2 ja existe com anuncio MLB2 e data 11:00.
  perform pg_temp.exigir(
    pg_temp.erro_de('aaaaaaaa-0000-4000-8000-0000000000d1',
                    'cccccccc-0000-4000-8000-0000000000e1',
                    jsonb_build_array(
                      pg_temp.q('Q2','MLB-OUTRO','duas','UNANSWERED','2026-09-20T11:00:00Z'))) = '22023',
    '22 anuncio_id_externo divergente falha');

  perform pg_temp.exigir(
    pg_temp.erro_de('aaaaaaaa-0000-4000-8000-0000000000d1',
                    'cccccccc-0000-4000-8000-0000000000e1',
                    jsonb_build_array(
                      pg_temp.q('Q2','MLB2','duas','UNANSWERED','2026-09-21T11:00:00Z'))) = '22023',
    '23 criada_em_provider divergente falha');

  perform pg_temp.exigir(
    (select anuncio_id_externo from public.agente_perguntas_ml where id_externo = 'Q2') = 'MLB2',
    '22 a linha gravada nao foi alterada');
  perform pg_temp.exigir(
    (select count(*) from public.agente_perguntas_ml) = v_antes, '23 nenhuma linha nova');
end $$;

-- ─── 16/17/18. anon e authenticated nao alcancam nada ─────────────────
do $$
declare papel text; e text;
begin
  foreach papel in array array['anon','authenticated'] loop
    execute format('set local role %I', papel);

    begin execute 'select 1 from public.agente_perguntas_ml limit 1'; e := null;
    exception when others then e := SQLSTATE; end;
    perform pg_temp.exigir(e = '42501', format('16/17 %s sem SELECT', papel));

    begin
      execute 'insert into public.agente_perguntas_ml
               (user_id, loja_id, id_externo, anuncio_id_externo, texto,
                provider_status, criada_em_provider)
               values (''x'', gen_random_uuid(), ''X'', ''Y'', ''z'', ''UNANSWERED'', now())';
      e := null;
    exception when others then e := SQLSTATE; end;
    perform pg_temp.exigir(e = '42501', format('16/17 %s sem INSERT', papel));

    begin execute 'update public.agente_perguntas_ml set texto = ''h'''; e := null;
    exception when others then e := SQLSTATE; end;
    perform pg_temp.exigir(e = '42501', format('16/17 %s sem UPDATE', papel));

    begin execute 'delete from public.agente_perguntas_ml'; e := null;
    exception when others then e := SQLSTATE; end;
    perform pg_temp.exigir(e = '42501', format('16/17 %s sem DELETE', papel));

    begin
      execute 'select public.agente_perguntas_ml_upsert_lote(''a'', gen_random_uuid(), ''[]''::jsonb)';
      e := null;
    exception when others then e := SQLSTATE; end;
    perform pg_temp.exigir(e = '42501', format('18 %s sem EXECUTE da RPC', papel));

    reset role;
  end loop;
end $$;

-- ─── 19. service_role usa a RPC; e NAO tem DELETE na tabela ───────────
do $$
declare m jsonb; e text;
begin
  set local role service_role;
  m := public.agente_perguntas_ml_upsert_lote(
    'aaaaaaaa-0000-4000-8000-0000000000d1', 'cccccccc-0000-4000-8000-0000000000e1',
    jsonb_build_array(pg_temp.q('Q6','MLB6','service','UNANSWERED','2026-09-20T15:00:00Z')));
  perform pg_temp.exigir((m->>'novas')::int = 1, '19 service_role executa a RPC');

  begin execute 'delete from public.agente_perguntas_ml where id_externo = ''Q6'''; e := null;
  exception when others then e := SQLSTATE; end;
  perform pg_temp.exigir(e = '42501', '19 service_role NAO tem DELETE');
  reset role;
end $$;

-- ============================================================
-- 15. CONCORRENCIA — NAO cabe nesta transacao.
--
-- Duas sessoes precisam disputar a MESMA chave ao mesmo tempo, e uma
-- transacao nao concorre consigo mesma. Procedimento de duas sessoes:
--
--   A: begin;
--      select agente_perguntas_ml_upsert_lote(<dono>, <loja>, [Q7]);
--      -- NAO commita ainda
--   B: begin;
--      select agente_perguntas_ml_upsert_lote(<dono>, <loja>, [Q7]);
--      -- BLOQUEIA no unique, esperando A
--   A: commit;
--   B: desbloqueia, o ON CONFLICT resolve como UPDATE, commit;
--
-- Verificar depois:
--   linhas com id_externo = 'Q7'  ->  EXATAMENTE 1
--   user_id da linha              ->  o dono correto
--   estado_interno                ->  'nova' (nenhuma sessao o tocou)
--
-- Combinacoes ACEITAVEIS das metricas:
--   A: novas=1   B: novas=0 e (atualizadas=0, reobservadas=1)
--
-- Combinacao INACEITAVEL, e a razao de a R1 trocar a contagem para
-- `xmax`:
--   A: novas=1   B: novas=1     <- duas sessoes alegando ter criado a
--                                  MESMA linha. Contar por "existia",
--                                  lido antes do comando, produzia
--                                  exatamente isso.
--
-- `xmax = 0` e verdade por sessao: so quem realmente inseriu ve `true`.
-- A unicidade da linha e do `unique` e do bloqueio do Postgres; a
-- honestidade da metrica e desta escolha. Sao invariantes distintos.
-- ============================================================

rollback;
