-- ============================================================
-- M2-I1-A8B — `agente_perguntas_ml`: a inbox de perguntas do ML
--
-- NAO APLICADA AINDA. Aplicar ao banco exige autorizacao explicita,
-- separada da criacao deste arquivo.
--
-- ── A PERGUNTA QUE ESTA TABELA RESPONDE ─────────────────────────────
--
-- "quais perguntas desta conta estao pendentes de atendimento, e em que
--  pe esta o nosso trabalho sobre cada uma?"
--
-- Hoje ninguem responde isso. O polling ja funciona ponta a ponta —
-- Schedule, admissao, ponte, cobertura, guard, Funcao, GET no Mercado
-- Livre e auditoria —, mas o `resultado` e DESCARTADO pelo no
-- `Sanitizar` do n8n. Tres janelas verdes provaram o cano; nenhuma
-- delas deixou uma pergunta em lugar nenhum.
--
-- ── POR QUE UMA TABELA NOVA, E NAO `agente_tarefas` ─────────────────
--
-- `agente_tarefas.resultado` e `jsonb` e ja carregaria as perguntas pelo
-- caminho legado de tarefa. Mas ele e resultado de uma EXECUCAO, nao
-- estado de um DOMINIO: nao tem chave por pergunta, nao tem estado por
-- pergunta, nao tem como deduplicar atomicamente e enterraria o status
-- do provider dentro de um blob. A mesma pergunta pendente apareceria
-- num `resultado` novo a cada 5 minutos, para sempre.
--
-- As 43 tabelas do schema foram inspecionadas: nenhuma representa
-- mensagem, pergunta ou inbox. Esta e a primeira.
--
-- ── POR QUE A CHAVE NATURAL E (loja_id, id_externo) ─────────────────
--
-- `id_externo` e `PerguntaRecebida.id`, o id da pergunta no Mercado
-- Livre — a unica identidade que o provider garante. `loja_id` entra
-- porque o mesmo id pertence a UMA conta: sem ele, duas contas do mesmo
-- dono colidiriam.
--
-- `user_id` NAO entra na chave, e isso e deliberado. Com
-- `(user_id, loja_id, id_externo)` seria possivel gravar DUAS linhas
-- para a mesma pergunta com donos diferentes — troca um defeito por um
-- pior. A cerca de dono e a FK composta, mais a guarda da RPC.
--
-- O `operationId` do bucket do scheduler NAO aparece aqui. Ele
-- identifica a tentativa de leitura, nunca a pergunta.
--
-- ── O QUE ESTA MIGRATION NAO FAZ ────────────────────────────────────
--
-- Nao cria a Funcao `sincronizar_perguntas`, nao pagina, nao toca a
-- ponte, nao toca o n8n, nao responde pergunta, nao cria RPC de
-- transicao de estado e nao aplica a 20261008. So a fundacao da
-- ingestao.
-- ============================================================

create table if not exists public.agente_perguntas_ml (
  id uuid primary key default gen_random_uuid(),

  -- Dono. `text` como em todo o resto do schema — `lojas.user_id`,
  -- `agentes.user_id` e `agente_conexoes.user_id` sao `text`.
  user_id text not null,

  -- A conta do Mercado Livre. `uuid` porque referencia `lojas.id`.
  loja_id uuid not null,

  -- ── Os cinco campos que o dominio publica, e nada alem ────────────
  --
  -- Sao exatamente as chaves de `PerguntaRecebida`
  -- (lib/agentes/dados/perguntas.ts). O payload BRUTO do provider nao
  -- e guardado: ele traz campos que ninguem auditou e que mudam sem
  -- aviso, incluindo `from`, a identidade do comprador, que o dominio
  -- exclui de proposito.
  id_externo text not null,
  anuncio_id_externo text not null,
  texto text not null,

  -- ── `provider_status` NAO e estado atual garantido ────────────────
  --
  -- E o ULTIMO STATUS OBSERVADO. A ingestao filtra `UNANSWERED`, entao
  -- uma pergunta respondida fora do CDS simplesmente some do filtro e
  -- esta coluna congela no ultimo valor visto. Quem for processar
  -- revalida no provider; esta coluna nao autoriza nada sozinha.
  --
  -- Sem CHECK de vocabulario: a documentacao oficial lista sete valores
  -- (ANSWERED, UNANSWERED, BANNED, CLOSED_UNANSWERED, DELETED,
  -- DISABLED, UNDER_REVIEW) e o conjunto e do provider, nao nosso. Um
  -- CHECK aqui transformaria um rotulo novo deles num erro nosso.
  provider_status text not null,

  criada_em_provider timestamptz not null,

  -- ── `estado_interno` e vocabulario NOSSO, e por isso tem CHECK ────
  --
  -- Nunca finge status externo. Pergunta respondida fora do CDS NAO
  -- vira `ignorada` sozinha: isso seria converter ausencia em decisao.
  estado_interno text not null default 'nova',

  -- Telemetria de frescor, nunca prova de estado. `ultimo_visto_em`
  -- responde "quao velho e este dado", e e o que permite a quem for
  -- processar decidir se revalida.
  primeiro_visto_em timestamptz not null default now(),
  ultimo_visto_em timestamptz not null default now(),

  criado_em timestamptz not null default now(),
  alterado_em timestamptz not null default now(),

  -- ── O dedupe ──────────────────────────────────────────────────────
  --
  -- O polling pede `status=UNANSWERED, deslocamento=0` a cada 5 min.
  -- Uma pergunta pendente reaparece em TODO bucket ate mudar de estado
  -- — cerca de 288 vezes por dia. Sem esta constraint, 288 linhas.
  constraint agente_perguntas_ml_pergunta_unica
    unique (loja_id, id_externo),

  -- ── A cerca de dono, no formato que o schema ja usa ───────────────
  --
  -- Mesma forma de `agente_conexoes_loja_do_mesmo_dono` e de
  -- `agente_funcao_chamadas_loja_do_mesmo_dono`, sustentada pelo
  -- `lojas_id_user_id_unico` que ja existe. Linha com loja de outro
  -- dono e ESTRUTURALMENTE impossivel, nao apenas desaconselhada.
  --
  -- `on delete restrict`: apagar uma loja com perguntas na inbox exige
  -- decisao explicita sobre elas. `cascade` apagaria trabalho.
  constraint agente_perguntas_ml_loja_do_mesmo_dono
    foreign key (loja_id, user_id)
    references public.lojas (id, user_id)
    on update restrict on delete restrict,

  constraint agente_perguntas_ml_estado_valido
    check (estado_interno in (
      'nova', 'em_processamento', 'aguardando_aprovacao', 'ignorada', 'erro'
    )),

  constraint agente_perguntas_ml_id_externo_nao_vazio
    check (length(btrim(id_externo)) > 0),

  constraint agente_perguntas_ml_anuncio_nao_vazio
    check (length(btrim(anuncio_id_externo)) > 0),

  constraint agente_perguntas_ml_texto_nao_vazio
    check (length(btrim(texto)) > 0),

  constraint agente_perguntas_ml_provider_status_nao_vazio
    check (length(btrim(provider_status)) > 0),

  -- Nao ha como ser visto antes de existir.
  constraint agente_perguntas_ml_visto_coerente
    check (ultimo_visto_em >= primeiro_visto_em)
);

-- A fila de trabalho: "o que este dono tem pendente nesta conta". O
-- `estado_interno` entra no indice porque toda leitura da fila filtra
-- por ele.
create index if not exists idx_agente_perguntas_ml_fila
  on public.agente_perguntas_ml (user_id, loja_id, estado_interno);

-- Frescor: "o que nao vejo ha muito tempo". Ordem descendente porque a
-- pergunta e sempre pelas mais recentes.
create index if not exists idx_agente_perguntas_ml_frescor
  on public.agente_perguntas_ml (loja_id, ultimo_visto_em desc);

comment on table public.agente_perguntas_ml is
  'Inbox de perguntas do Mercado Livre por conta. Chave natural (loja_id, id_externo). `provider_status` e o ULTIMO STATUS OBSERVADO, nunca estado atual garantido — a ingestao filtra UNANSWERED e uma pergunta respondida fora do CDS some do filtro sem atualizar esta coluna. `estado_interno` e vocabulario do CDS e nunca representa status externo. Ausencia numa varredura NAO e evidencia de nada: a varredura pode terminar truncada.';

comment on column public.agente_perguntas_ml.provider_status is
  'LAST_OBSERVED_PROVIDER_STATUS, not authoritative current state.';

comment on column public.agente_perguntas_ml.ultimo_visto_em is
  'Telemetria de frescor. Atualizada a cada observacao, inclusive quando nada material mudou.';

-- ── Privilegios da TABELA ────────────────────────────────────────────
--
-- Os REVOKE nominais nao sao redundancia de `from public`: `PUBLIC` e
-- pseudo-role distinto de `anon` e `authenticated`, e este projeto tem
-- `ALTER DEFAULT PRIVILEGES` concedendo privilegio a eles em objeto
-- novo. Foi o que causou o bug SEC1.
--
-- `service_role` tambem e revogado antes do grant: GRANT e aditivo, e
-- revogar primeiro torna o conjunto final legivel numa linha so.
revoke all on table public.agente_perguntas_ml from public;
revoke all on table public.agente_perguntas_ml from anon;
revoke all on table public.agente_perguntas_ml from authenticated;
revoke all on table public.agente_perguntas_ml from service_role;

-- SEM `delete`: nenhum caminho da V1 apaga pergunta da inbox. A
-- ingestao insere e atualiza; sair da fila e transicao de
-- `estado_interno`, nunca remocao de linha. Conceder DELETE agora seria
-- dar um poder que ninguem pede e que apagaria historico de trabalho.
grant select, insert, update on table public.agente_perguntas_ml to service_role;

-- ============================================================
-- RPC — upsert em LOTE, atomico
--
-- ── Por que lote atomico, e nao linha a linha ───────────────────────
--
-- Uma resposta traz N perguntas. Gravar uma a uma deixaria falha
-- parcial invisivel: metade na inbox, metade nao, e nenhum lugar
-- registrando a diferenca. E o modo de falha que
-- `estudio_anuncios_resultados_pipeline` e as RPCs do Estudio existem
-- para impedir.
--
-- ── O que ela NUNCA toca em conflito ────────────────────────────────
--
-- `estado_interno`, `primeiro_visto_em`, `criado_em` e `id`. E isso que
-- impede o polling de desfazer, a cada 5 minutos, o trabalho que
-- alguem ja fez sobre a pergunta.
-- ============================================================

create or replace function public.agente_perguntas_ml_upsert_lote(
  p_user_id text,
  p_loja_id uuid,
  p_perguntas jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_recebidas integer;
  v_unicas integer;
  v_estrutural_invalida boolean;
  v_duplicata_divergente boolean;
  v_identidade_divergente boolean;
  v_gravadas integer;
  v_novas integer;
  v_atualizadas integer;
  v_loja_utilizavel boolean;
  v_identidade_concorrente boolean;
  v_dono_concorrente boolean;
  -- ── UM instante de observacao por chamada ─────────────────────────
  --
  -- `now()` e o instante da TRANSACAO, nao da chamada: duas chamadas
  -- validas na mesma transacao recebiam o MESMO valor, e `ultimo_visto_em`
  -- nao avancava (F2) nem `alterado_em` em mudanca material (F3). Mas
  -- `clock_timestamp()` espalhado pelos CTEs daria instantes diferentes
  -- para perguntas do MESMO lote. Capturado UMA vez aqui, o lote inteiro
  -- compartilha um unico instante, e cada chamada tem o seu.
  v_observado_em timestamptz := clock_timestamp();
begin
  -- ── 1. IDENTIDADE, antes de qualquer escrita ──────────────────────
  --
  -- A FK composta ja torna impossivel INSERIR com par incoerente. Mas
  -- o ramo `do update` de um ON CONFLICT atinge a linha existente sem
  -- reavaliar a FK sobre o `user_id` recebido — entao a constraint
  -- sozinha NAO fecha o caso de atualizacao. Esta guarda fecha.
  if p_user_id is null or btrim(p_user_id) = '' then
    raise exception 'user_id ausente' using errcode = '22023';
  end if;
  if p_loja_id is null then
    raise exception 'loja_id ausente' using errcode = '22023';
  end if;

  -- `marketplace = 'ML'` entra na MESMA condicao, e nao como checagem
  -- separada. Esta inbox e do Mercado Livre; uma loja Shopee do proprio
  -- dono nao a serve, e aceitar a linha criaria pergunta de ML numa
  -- conta que nao e de ML. E o mesmo filtro que `getMLLojaById` ja
  -- aplica antes de devolver credencial.
  select exists (
    select 1 from public.lojas l
    where l.id = p_loja_id
      and l.user_id = p_user_id
      and l.marketplace = 'ML'
  ) into v_loja_utilizavel;

  if not v_loja_utilizavel then
    -- Loja inexistente, alheia e de outro marketplace dao a MESMA
    -- recusa. Distingui-las seria um oraculo de existencia e de
    -- configuracao de recurso de terceiro.
    raise exception 'loja_nao_utilizavel_para_perguntas_ml' using errcode = '42501';
  end if;

  if p_perguntas is null or jsonb_typeof(p_perguntas) <> 'array' then
    raise exception 'perguntas_invalidas' using errcode = '22023';
  end if;

  -- ── 2. Normalizacao, validacao e leitura do estado anterior ───────
  --
  -- Tudo o que antecede a escrita cabe em UM comando. Nao ha relacao
  -- temporaria aqui, e isso nao e estilo: `create temporary table ...
  -- on commit drop` so some no COMMIT, nao na saida da funcao, entao
  -- uma segunda chamada na MESMA transacao colidia com a relacao que a
  -- primeira deixou (DEF1-INBOX-REENTRANCIA). CTE nasce e morre com o
  -- comando, e a funcao volta a poder ser chamada quantas vezes for.
  --
  -- As tres condicoes sao APURADAS juntas e LANCADAS em ordem — a mesma
  -- ordem de antes. Apurar junto nao muda o veredito: nenhuma delas
  -- depende do resultado da outra, e todas leem o mesmo lote imutavel.
  with entrada as (
    select
      nullif(btrim(item->>'id_externo'), '')         as id_externo,
      nullif(btrim(item->>'anuncio_id_externo'), '') as anuncio_id_externo,
      nullif(btrim(item->>'texto'), '')              as texto,
      nullif(btrim(item->>'provider_status'), '')    as provider_status,
      (item->>'criada_em_provider')::timestamptz     as criada_em_provider,
      ordem
    from jsonb_array_elements(p_perguntas) with ordinality as t(item, ordem)
  ),
  -- Deterministico pela menor ordem. Com divergencia recusada logo
  -- abaixo, qual ocorrencia sobrevive e indiferente — o que nao pode e
  -- depender da ordem em que o Postgres resolveu ler.
  unico as (
    select distinct on (id_externo) *
    from entrada
    order by id_externo, ordem
  ),
  prevista as (
    select
      u.id_externo,
      u.anuncio_id_externo,
      u.texto,
      u.provider_status,
      u.criada_em_provider,
      p.id is not null      as existia,
      p.anuncio_id_externo  as anuncio_anterior,
      p.criada_em_provider  as criada_em_anterior
    from unico u
    left join public.agente_perguntas_ml p
      on p.loja_id = p_loja_id and p.id_externo = u.id_externo
  )
  select
    (select count(*) from entrada),
    (select count(*) from unico),
    -- Linha estruturalmente invalida derruba o LOTE INTEIRO. Gravar as
    -- boas e descartar a ruim em silencio seria perder uma pergunta
    -- real sem que ninguem soubesse.
    --
    -- `texto` e OBRIGATORIO, e isto reconcilia com o dominio:
    -- `normalizarPergunta` (lib/agentes/dados/perguntas.ts) ja DESCARTA
    -- item sem texto nao vazio — ele nunca produz `PerguntaRecebida`
    -- com texto ausente. Entao texto vazio chegando aqui nao e "nao
    -- observei desta vez": e defeito de quem chamou, e defeito de
    -- chamador falha fechado. Depender do `not null` da coluna deixaria
    -- a mensagem de erro a cargo do Postgres.
    (select exists (
       select 1 from entrada
       where id_externo is null
          or anuncio_id_externo is null
          or texto is null
          or provider_status is null
          or criada_em_provider is null)),
    -- Duplicata DENTRO do mesmo lote. O Postgres lanca `ON CONFLICT DO
    -- UPDATE command cannot affect row a second time` se a mesma
    -- linha-alvo for atingida duas vezes no mesmo INSERT, entao o lote
    -- precisa chegar unico ao comando. Duplicata EXATA e colapsada;
    -- duplicata DIVERGENTE — mesma chave, conteudo diferente — FALHA:
    -- escolher uma das versoes seria decidir em silencio qual verdade
    -- vale, e quem chama e que sabe.
    (select exists (
       select 1 from entrada
       group by id_externo
       having count(distinct (anuncio_id_externo, texto, provider_status, criada_em_provider)) > 1)),
    -- A identidade do provider NAO muda. `anuncio_id_externo` e
    -- `criada_em_provider` descrevem QUAL pergunta e QUANDO ela nasceu.
    -- Se o provider devolver valores diferentes para a mesma
    -- `(loja_id, id_externo)`, uma das duas premissas quebrou — a chave
    -- natural ou a estabilidade dos campos —, e nenhuma saida
    -- silenciosa serve: atualizar apagaria a origem, manter o antigo
    -- esconderia a divergencia, escolher um lado seria decidir por
    -- conta propria. `provider_status` e `texto` continuam MUTAVEIS:
    -- descrevem o estado da pergunta, nao a identidade dela.
    (select exists (
       select 1 from prevista
       where existia
         and (anuncio_anterior is distinct from anuncio_id_externo
           or criada_em_anterior is distinct from criada_em_provider)))
  into v_recebidas, v_unicas, v_estrutural_invalida,
       v_duplicata_divergente, v_identidade_divergente;

  if v_estrutural_invalida then
    raise exception 'pergunta_estruturalmente_invalida' using errcode = '22023';
  end if;

  if v_duplicata_divergente then
    raise exception 'duplicata_divergente_no_lote' using errcode = '22023';
  end if;

  if v_identidade_divergente then
    raise exception 'identidade_do_provider_divergente' using errcode = '22023';
  end if;

  -- ── 3. O upsert, e as metricas do que ele de fato fez ─────────────
  --
  -- `xmax = 0` no RETURNING distingue INSERT de UPDATE resolvido por
  -- conflito, e distingue do ponto de vista DESTA sessao. E o que torna
  -- a metrica honesta sob concorrencia: se outra sessao criou a linha
  -- antes deste comando, o lado anterior lido aqui vira nulo e `xmax`
  -- dira a verdade. Contar por "existia antes" faria as DUAS sessoes
  -- reportarem `novas = 1` para uma unica linha.
  --
  -- ── De onde vem CADA metrica, e por que ──────────────────────────
  --
  -- `novas` vem de `xmax = 0`: so quem realmente inseriu ve `true`.
  --
  -- `atualizadas` NAO pode vir de leitura previa. O snapshot deste
  -- comando e tirado ANTES de o `on conflict` bloquear, entao a sessao
  -- perdedora de uma disputa nao enxerga a linha que a vencedora criou:
  -- o "antes" dela vem nulo, e `nulo is distinct from <texto>` dava
  -- `atualizada` para um payload IDENTICO (F6). Isso nao era instavel —
  -- era deterministico sob disputa.
  --
  -- A decisao de mudanca material ja e tomada no lugar certo: dentro do
  -- `do update`, `alvo.texto` e `alvo.provider_status` sao os da linha
  -- REAL no instante do update, resolvida depois da espera. O que
  -- faltava era exportar esse veredito. `alterado_em` recebe
  -- `v_observado_em` exatamente quando algo material mudou, entao
  -- compara-lo no RETURNING devolve a decisao ja tomada — nao uma
  -- segunda leitura, que voltaria a correr.
  with entrada as (
    select
      nullif(btrim(item->>'id_externo'), '')         as id_externo,
      nullif(btrim(item->>'anuncio_id_externo'), '') as anuncio_id_externo,
      nullif(btrim(item->>'texto'), '')              as texto,
      nullif(btrim(item->>'provider_status'), '')    as provider_status,
      (item->>'criada_em_provider')::timestamptz     as criada_em_provider,
      ordem
    from jsonb_array_elements(p_perguntas) with ordinality as t(item, ordem)
  ),
  unico as (
    select distinct on (id_externo) *
    from entrada
    order by id_externo, ordem
  ),
  prevista as (
    select
      u.id_externo,
      u.anuncio_id_externo,
      u.texto,
      u.provider_status,
      u.criada_em_provider
    from unico u
  ),
  gravacao as (
    insert into public.agente_perguntas_ml as alvo (
      user_id, loja_id, id_externo, anuncio_id_externo, texto,
      provider_status, criada_em_provider, primeiro_visto_em, ultimo_visto_em
    )
    select p_user_id, p_loja_id, a.id_externo, a.anuncio_id_externo, a.texto,
           a.provider_status, a.criada_em_provider, v_observado_em, v_observado_em
    from prevista a
    on conflict on constraint agente_perguntas_ml_pergunta_unica do update
      set
        -- Toda observacao valida renova o frescor, mesmo sem mudanca
        -- material. `ultimo_visto_em` responde "quando vi pela ultima
        -- vez", nunca "quando mudou".
        ultimo_visto_em = v_observado_em,
        provider_status = excluded.provider_status,
        texto = excluded.texto,
        -- `alterado_em` e o oposto: so anda quando algo MATERIAL mudou.
        -- Reobservacao pura nao o move.
        alterado_em = case
          when alvo.provider_status is distinct from excluded.provider_status
            or alvo.texto is distinct from excluded.texto
          then v_observado_em
          else alvo.alterado_em
        end
      -- ── A cerca, no PROPRIO comando ──────────────────────────────
      --
      -- A validacao la em cima le o snapshot do comando dela, e nao
      -- enxerga linha que uma concorrente criou depois. Aqui `alvo.*` e
      -- a linha REAL no instante do update, ja resolvida depois da
      -- espera — e o unico lugar onde a cerca vale sob disputa.
      --
      -- Sem isto, `texto` e `provider_status` de um payload com
      -- identidade DIVERGENTE eram gravados sobre a linha alheia, que
      -- mantinha o `anuncio_id_externo` da outra: uma linha HIBRIDA,
      -- dizendo ser de um anuncio e carregando o texto de outro.
      where alvo.user_id = p_user_id
        and alvo.anuncio_id_externo
            is not distinct from excluded.anuncio_id_externo
        and alvo.criada_em_provider
            is not distinct from excluded.criada_em_provider
    returning
      alvo.id_externo,
      (xmax = 0) as inserida,
      (alvo.alterado_em = v_observado_em) as mudou_material
  )
  select
    count(*),
    count(*) filter (where g.inserida),
    count(*) filter (where not g.inserida and g.mudou_material)
  into v_gravadas, v_novas, v_atualizadas
  from gravacao g;

  -- ── 4. Nenhuma linha pode sumir em silencio ───────────────────────
  --
  -- O `where` do `do update` pode, em tese, nao casar — e um conflito
  -- nao casado vira NO-OP sem erro. Se isso acontecer, o lote ficou
  -- incompleto e ninguem saberia. Aqui ele vira falha.
  if v_gravadas <> v_unicas then
    -- ── Por que uma consulta NOVA ────────────────────────────────────
    --
    -- Um conflito recusado pelo `where` do `do update` vira NO-OP sem
    -- erro, e a linha some do RETURNING. Descobrir o motivo exige
    -- enxergar o que a concorrente commitou — e o snapshot do comando
    -- anterior, por definicao, nao a enxerga. Este comando e novo,
    -- entao tem snapshot novo. Sem ele, uma divergencia de identidade
    -- nascida em corrida seria reportada como `lote_incompleto`, que e
    -- falha interna, nao recusa de contrato.
    with entrada as (
      select
        nullif(btrim(item->>'id_externo'), '')         as id_externo,
        nullif(btrim(item->>'anuncio_id_externo'), '') as anuncio_id_externo,
        nullif(btrim(item->>'texto'), '')              as texto,
        nullif(btrim(item->>'provider_status'), '')    as provider_status,
        (item->>'criada_em_provider')::timestamptz     as criada_em_provider,
        ordem
      from jsonb_array_elements(p_perguntas) with ordinality as t(item, ordem)
    ),
    unico as (
      select distinct on (id_externo) *
      from entrada
      order by id_externo, ordem
    )
    select
      exists (
        select 1
        from unico u
        join public.agente_perguntas_ml p
          on p.loja_id = p_loja_id and p.id_externo = u.id_externo
        where p.user_id = p_user_id
          and (p.anuncio_id_externo is distinct from u.anuncio_id_externo
            or p.criada_em_provider is distinct from u.criada_em_provider)),
      exists (
        select 1
        from unico u
        join public.agente_perguntas_ml p
          on p.loja_id = p_loja_id and p.id_externo = u.id_externo
        where p.user_id is distinct from p_user_id)
    into v_identidade_concorrente, v_dono_concorrente;

    -- A MESMA recusa da checagem sequencial. Que a divergencia tenha
    -- nascido de uma corrida nao a torna outra coisa.
    if v_identidade_concorrente then
      raise exception 'identidade_do_provider_divergente' using errcode = '22023';
    end if;

    -- Cerca de dono, com a mesma recusa que a guarda de entrada usa.
    if v_dono_concorrente then
      raise exception 'loja_nao_utilizavel_para_perguntas_ml' using errcode = '42501';
    end if;

    -- Sobrou o que nao sabemos explicar. Falha fechada, nunca silencio.
    raise exception 'lote_incompleto' using errcode = '25000';
  end if;

  -- ── 5. Metricas ───────────────────────────────────────────────────

  return jsonb_build_object(
    'recebidas',          v_recebidas,
    'unicas',             v_unicas,
    'duplicadas_no_lote', v_recebidas - v_unicas,
    'novas',              v_novas,
    'atualizadas',        v_atualizadas,
    'reobservadas',       v_unicas - v_novas - v_atualizadas
  );
end;
$$;

comment on function public.agente_perguntas_ml_upsert_lote(text, uuid, jsonb) is
  'Upsert ATOMICO de perguntas do ML na inbox, por (loja_id, id_externo). Valida ANTES de qualquer escrita que a loja existe, pertence ao dono e e marketplace ML, recusando os tres casos com o MESMO 42501 — a FK composta nao cobre o ramo `do update` de um ON CONFLICT. Exige em toda pergunta id_externo, anuncio_id_externo, texto, provider_status e criada_em_provider nao vazios; qualquer linha invalida derruba o lote inteiro. anuncio_id_externo e criada_em_provider sao IMUTAVEIS por chave natural: divergencia contra a linha gravada falha, nunca e absorvida. Duplicata exata dentro do lote colapsa pela menor ordem; duplicata DIVERGENTE falha. Lote vazio e valido e nao escreve nada. Em conflito atualiza ultimo_visto_em SEMPRE, provider_status e texto com o observado, e alterado_em somente quando texto ou provider_status mudaram; NUNCA toca estado_interno, primeiro_visto_em, criado_em nem id. Sob conflito CONCORRENTE a cerca do proprio comando exige dono, anuncio_id_externo e criada_em_provider iguais aos ja gravados; divergencia nascida em corrida falha fechada com a mesma recusa da sequencial. Metricas: recebidas = itens do lote; unicas = o que sobra apos colapsar duplicata exata; duplicadas_no_lote = recebidas - unicas; novas = insercoes reais DESTA sessao, classificadas por `xmax = 0`, entao duas sessoes concorrentes nunca reportam ambas `novas` para a mesma linha; atualizadas = linhas ja existentes cujo texto ou provider_status mudou nesta chamada, veredito exportado pelo proprio ON CONFLICT e nao por leitura previa; reobservadas = unicas - novas - atualizadas. Devolve {recebidas, unicas, duplicadas_no_lote, novas, atualizadas, reobservadas}.';

revoke all on function public.agente_perguntas_ml_upsert_lote(text, uuid, jsonb) from public;
revoke all on function public.agente_perguntas_ml_upsert_lote(text, uuid, jsonb) from anon;
revoke all on function public.agente_perguntas_ml_upsert_lote(text, uuid, jsonb) from authenticated;
revoke all on function public.agente_perguntas_ml_upsert_lote(text, uuid, jsonb) from service_role;

grant execute on function public.agente_perguntas_ml_upsert_lote(text, uuid, jsonb) to service_role;
