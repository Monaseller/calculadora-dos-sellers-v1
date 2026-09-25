-- ============================================================
-- M2-I1-A8B-I4P9-R1 — `agente_ingestao_monitor_lease`: o direito
-- temporario de AVALIAR a ingestao de um agente.
--
-- NAO APLICADA AINDA. Aplicar ao banco exige autorizacao explicita,
-- separada da criacao deste arquivo.
--
-- ── O QUE ESTA TABELA NAO E ────────────────────────────────────────
--
-- Nao e incidente: incidente mora em `agente_ingestao_alertas`, tem
-- historico e e lido por gente. Nao e cursor: cursor mora em
-- `agente_perguntas_continuacao` e e dado COMERCIAL da varredura.
-- Isto aqui e coordenacao do vigia consigo mesmo, e some sozinho.
-- Misturar qualquer um dos tres faria a coordenacao aparecer como
-- incidente, ou pior, mover a varredura de verdade.
--
-- ── O DEFEITO QUE ELA CORRIGE ──────────────────────────────────────
--
-- O indice unico parcial de `agente_ingestao_alertas` serializa a
-- ABERTURA do mesmo incidente. Ele nao serializa duas AVALIACOES
-- sobrepostas — e o caso mais perigoso nem toca linha de alerta:
--
--   T2  execucao nova le tudo saudavel  -> NOOP, nenhuma linha escrita
--   T1  execucao velha, atrasada, le um gap antigo -> ABRE incidente
--
-- Nao ha linha contra a qual comparar, entao nenhum CAS por alerta
-- resolve isso. O que falta e impedir que as duas avaliem ao mesmo
-- tempo, e e exatamente isso que o lease faz.
--
-- ── POR QUE LEASE, E NAO FILA OU LOCK DE SESSAO ───────────────────
--
-- Um watchdog idempotente que roda a cada minuto pode PULAR uma
-- rodada sem prejuizo: a proxima reavalia tudo do zero. Entao a
-- resposta certa para sobreposicao e "nao avalie", nao "espere" —
-- esperar so empilharia execucoes dentro do mesmo orcamento de 60 s.
-- E `pg_advisory_lock` morreria com a conexao do pooler, que nao e a
-- mesma coisa que morrer com a execucao.
-- ============================================================

-- Sem `if not exists`, pela mesma razao das vizinhas: um objeto de
-- mesmo nome com OUTRA forma seria aceito em silencio.
create table public.agente_ingestao_monitor_lease (
  -- ── Escopo, na mesma forma das tabelas vizinhas ──────────────────
  --
  -- A PK NAO inclui `user_id`, como em `agente_perguntas_continuacao` e
  -- `agente_ingestao_estado_esperado`: o agente ja determina o dono, e
  -- a FK composta fecha a cerca. E ela NAO e um singleton global — dois
  -- agentes sao coordenados de forma independente, que e o que permite
  -- multiagente no futuro sem trocar o mecanismo.
  user_id     text        not null,
  agente_id   uuid        not null,
  plataforma  text        not null,
  recurso     text        not null,

  -- Quem detem o direito AGORA. Opaco, gerado por execucao, sem
  -- nenhum significado de negocio — e o que impede uma execucao de
  -- liberar o lease que outra adquiriu depois dela.
  portador    text        not null,

  adquirida_em timestamptz not null default now(),
  -- A garantia REAL. Liberacao explicita e melhor esforco; se o
  -- processo morrer no meio, e esta data que devolve o direito.
  expira_em    timestamptz not null,
  -- Preenchida na liberacao normal. `null` com lease vencido significa
  -- que o portador anterior morreu sem liberar.
  liberada_em  timestamptz null,

  -- Esta aquisicao tomou o lugar de um portador que NAO liberou? E o
  -- unico caso que merece ser distinguido na auditoria: aquisicao
  -- depois de liberacao normal e rotina; tomada de vencido e sintoma.
  tomada_de_expirada boolean not null default false,
  -- Quantas vezes o direito trocou de maos nesta linha. Contador, nao
  -- historico: o vigia roda a cada minuto e guardar uma linha por
  -- aquisicao encheria a tabela sem responder nada que o contador nao
  -- responda.
  tomadas     integer     not null default 0,

  constraint agente_ingestao_monitor_lease_pk
    primary key (agente_id, plataforma, recurso),

  -- Mesma cerca composta do cursor, do estado esperado e dos alertas.
  constraint agente_ingestao_monitor_lease_agente_do_mesmo_dono
    foreign key (agente_id, user_id)
    references public.agentes (id, user_id)
    on update restrict on delete restrict,

  constraint agente_ingestao_monitor_lease_portador_nao_vazio
    check (length(btrim(portador)) > 0),

  constraint agente_ingestao_monitor_lease_tempos_coerentes
    check (expira_em >= adquirida_em
       and (liberada_em is null or liberada_em >= adquirida_em)),

  constraint agente_ingestao_monitor_lease_tomadas_nao_negativas
    check (tomadas >= 0),

  -- O par canonico, igual ao das vizinhas.
  constraint agente_ingestao_monitor_lease_requisito_conhecido
    check (plataforma = 'mercado_livre' and recurso = 'perguntas')
);

comment on table public.agente_ingestao_monitor_lease is
  'Direito temporario de AVALIAR a ingestao de um agente. Coordenacao do vigia, nao incidente e nao cursor: uma linha por escopo, sobrescrita a cada aquisicao, sem historico. A expiracao e a garantia real — liberacao explicita e melhor esforco.';

comment on column public.agente_ingestao_monitor_lease.portador is
  'Identificador opaco da execucao que detem o direito. Sem significado de negocio. Existe para que uma execucao nao libere o lease que outra adquiriu depois dela.';

comment on column public.agente_ingestao_monitor_lease.expira_em is
  'A garantia real contra morte abrupta. Derivada do `maxDuration` da rota mais margem, no servidor — nunca do relogio de quem chama.';

comment on column public.agente_ingestao_monitor_lease.tomada_de_expirada is
  'A aquisicao atual tomou o lugar de um portador que nao liberou. Aquisicao apos liberacao normal e rotina; esta e sintoma.';

-- ── A aquisicao, ATOMICA ─────────────────────────────────────────────
--
-- Um `select` seguido de `update` deixaria duas execucoes adquirirem
-- juntas: as duas leriam "vencido" antes de qualquer uma escrever. Aqui
-- ha UM comando. O `where` do `do update` e avaliado com a linha ja
-- travada, entao a segunda execucao reavalia depois da primeira ter
-- escrito, ve o lease novo e nao casa — afeta zero linhas, e `found`
-- responde `false`.
--
-- O relogio e o do BANCO (`now()`), nunca o de quem chama: a decisao de
-- expiracao nao pode depender da diferenca entre Vercel e Postgres.
create function public.adquirir_lease_monitor_ingestao(
  p_user_id text,
  p_agente_id uuid,
  p_plataforma text,
  p_recurso text,
  p_portador text,
  p_ttl_segundos integer
)
returns table (
  adquirida boolean,
  expira_em timestamptz,
  tomada_de_expirada boolean
)
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_expira timestamptz;
  v_tomada boolean;
begin
  -- Parametro cru e revalidado: a RPC nao tem sessao para confiar.
  if p_portador is null or length(btrim(p_portador)) = 0 then
    raise exception 'portador obrigatorio';
  end if;
  if p_ttl_segundos is null or p_ttl_segundos <= 0 or p_ttl_segundos > 600 then
    raise exception 'ttl fora da faixa permitida';
  end if;

  insert into public.agente_ingestao_monitor_lease as alvo (
    user_id, agente_id, plataforma, recurso,
    portador, adquirida_em, expira_em, liberada_em, tomada_de_expirada, tomadas
  )
  values (
    p_user_id, p_agente_id, p_plataforma, p_recurso,
    p_portador, now(), now() + make_interval(secs => p_ttl_segundos), null, false, 0
  )
  on conflict (agente_id, plataforma, recurso) do update
    set portador = excluded.portador,
        adquirida_em = now(),
        expira_em = now() + make_interval(secs => p_ttl_segundos),
        liberada_em = null,
        tomada_de_expirada = (alvo.liberada_em is null),
        tomadas = alvo.tomadas + 1
    -- Duas condicoes, e as duas importam. A primeira e o lease em si.
    -- A segunda e cerca de dono: quem trouxer o dono errado nunca
    -- adquire, e falha para o lado de NAO avaliar.
    where alvo.expira_em <= now()
      and alvo.user_id = p_user_id
  returning alvo.expira_em, alvo.tomada_de_expirada
  into v_expira, v_tomada;

  if not found then
    return query select false, null::timestamptz, false;
    return;
  end if;

  return query select true, v_expira, v_tomada;
end;
$$;

comment on function public.adquirir_lease_monitor_ingestao(text, uuid, text, text, text, integer) is
  'Adquire, em UM comando, o direito de avaliar a ingestao daquele escopo. Devolve adquirida=false quando outra execucao detem lease valido. Relogio do banco.';

-- ── A liberacao ──────────────────────────────────────────────────────
--
-- Casada com o PORTADOR, e nao so com o escopo. Sem isso, uma execucao
-- lenta que voltasse a vida liberaria o lease que a execucao seguinte
-- ja tinha adquirido — e as duas passariam a avaliar juntas, que e
-- exatamente o que este arquivo existe para impedir.
create function public.liberar_lease_monitor_ingestao(
  p_user_id text,
  p_agente_id uuid,
  p_plataforma text,
  p_recurso text,
  p_portador text
)
returns boolean
language plpgsql
security invoker
set search_path = public
as $$
begin
  update public.agente_ingestao_monitor_lease as alvo
     set expira_em = now(),
         liberada_em = now()
   where alvo.agente_id = p_agente_id
     and alvo.user_id = p_user_id
     and alvo.plataforma = p_plataforma
     and alvo.recurso = p_recurso
     and alvo.portador = p_portador
     and alvo.liberada_em is null;

  return found;
end;
$$;

comment on function public.liberar_lease_monitor_ingestao(text, uuid, text, text, text) is
  'Libera o lease ANTES da expiracao, e somente se o portador for o mesmo que adquiriu. Melhor esforco: a expiracao continua sendo a garantia real.';

-- ── Privilegios ──────────────────────────────────────────────────────
--
-- Os REVOKE nominais nao sao redundancia de `from public`: `PUBLIC` e
-- pseudo-role distinto de `anon` e `authenticated`, e este projeto tem
-- `ALTER DEFAULT PRIVILEGES` concedendo privilegio a eles em objeto
-- novo. Foi o que causou o bug SEC1.
revoke all on table public.agente_ingestao_monitor_lease from public;
revoke all on table public.agente_ingestao_monitor_lease from anon;
revoke all on table public.agente_ingestao_monitor_lease from authenticated;
revoke all on table public.agente_ingestao_monitor_lease from service_role;

-- As RPCs sao `security invoker`: quem executa precisa do privilegio na
-- tabela. SELECT nao entra porque nenhum caminho le a linha direto — a
-- aquisicao devolve o que importa.
grant insert, update on table public.agente_ingestao_monitor_lease to service_role;

-- Cinto e suspensorio. DELETE nao entra: a linha e reaproveitada a cada
-- aquisicao, e apagar perderia `tomadas`, que e o unico sinal de que o
-- vigia anda morrendo no meio.
revoke delete, truncate on table public.agente_ingestao_monitor_lease from service_role;

revoke all on function public.adquirir_lease_monitor_ingestao(text, uuid, text, text, text, integer) from public;
revoke all on function public.adquirir_lease_monitor_ingestao(text, uuid, text, text, text, integer) from anon;
revoke all on function public.adquirir_lease_monitor_ingestao(text, uuid, text, text, text, integer) from authenticated;
grant execute on function public.adquirir_lease_monitor_ingestao(text, uuid, text, text, text, integer) to service_role;

revoke all on function public.liberar_lease_monitor_ingestao(text, uuid, text, text, text) from public;
revoke all on function public.liberar_lease_monitor_ingestao(text, uuid, text, text, text) from anon;
revoke all on function public.liberar_lease_monitor_ingestao(text, uuid, text, text, text) from authenticated;
grant execute on function public.liberar_lease_monitor_ingestao(text, uuid, text, text, text) to service_role;
