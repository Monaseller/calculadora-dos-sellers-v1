-- ============================================================
-- AGENTES-FASE1E-e — observabilidade de chamadas de IA dos agentes
-- Gerado em: 2026-08-26
--
-- NAO APLICADA AINDA. Este arquivo e o artefato do gate pre-migration;
-- a aplicacao depende de autorizacao explicita.
--
-- ── POR QUE UMA TABELA NOVA, E NAO central_ia_consumo ───────────────
--
-- `central_ia_consumo` NAO e "consumo de IA do CDS": e consumo do
-- ESTUDIO DE ANUNCIOS. Decidido pela estrutura, nao pelo nome:
--
--   1. FK `projeto_id` -> estudio_anuncios_projetos(id)
--      FK `job_id`     -> estudio_anuncios_jobs(id)
--      Uma tarefa de agente nao tem linha em nenhuma das duas; as duas
--      colunas ficariam NULL para sempre.
--
--   2. A deduplicacao dela e `idx_central_ia_consumo_job_unico`, um
--      indice unico PARCIAL em `job_id WHERE job_id IS NOT NULL`. Com
--      `job_id` nulo ele nao protege absolutamente nada — a garantia de
--      "um consumo por job" desaparece justamente para agentes.
--
--   3. NAO existe coluna `user_id`. Custo de IA ali nao e atribuivel por
--      dono. Isso ja era achado registrado na 1D-e, e e fatal para
--      observabilidade multi-tenant.
--
-- O `modulo text NOT NULL DEFAULT 'estudio_anuncios'` sugere uma
-- intencao de generalidade que as duas FKs contradizem. Reaproveitar a
-- tabela exigiria inventar um `job_id` falso — corrompendo a FK e a
-- dedup do Estudio para resolver um problema que nao e dele.
--
-- ── GRANULARIDADE: UMA LINHA = UMA CHAMADA AO MODELO ────────────────
--
-- Nao uma tarefa, nao um agente, nao uma execucao. Validado contra o
-- codigo: `criarAdaptadorAnthropic()` faz exatamente um `chamar` por
-- invocacao, e o cliente Anthropic usa `maxRetries: 0` — entao um evento
-- registrado aqui corresponde a UMA requisicao HTTP ao provedor, sem
-- retry oculto do SDK somando chamadas invisiveis.
--
-- Hoje uma tarefa faz uma chamada. O dia em que um handler fizer tres,
-- serao tres linhas, e a contabilidade continua certa sem migration.
--
-- ── IDENTIDADE VEM DO CLAIM, NUNCA DO INPUT ────────────────────────
--
-- `user_id`, `agente_id`, `tarefa_id`, `tipo_tarefa` e `tentativa` sao
-- montados a partir de `ContextoTarefa`, que o executor preenche da
-- linha REIVINDICADA pelo claim. Nada aqui vem de `agente_tarefas.entrada`
-- — a mesma regra provada na 1D-e, agora estendida a contabilidade: quem
-- enfileira uma tarefa nao consegue mentir sobre de quem e o custo.
--
-- ── POR QUE (tarefa_id, tentativa, sequencia) ──────────────────────
--
-- `tarefa_id` sozinho NAO identifica uma chamada. A semantica do motor e
-- AT-LEAST-ONCE e `max_tentativas` e 3: a mesma tarefa pode rodar de
-- novo depois de falhar, e cada execucao gasta dinheiro de verdade.
--
--   `tentativa` incrementa NO CLAIM (ver 20260917_agentes_execucao.sql,
--   RPC claim_next_agente_tarefa) — entao ele ja distingue execucoes
--   sem precisarmos inventar nada.
--
--   `sequencia` distingue chamadas DENTRO da mesma execucao.
--
-- Com isso: retry de tarefa vira linha nova (correto, houve custo novo);
-- reprocessar o mesmo evento viola o UNIQUE e e tratado como
-- "ja registrado" (23505); e retry do SDK nao existe para confundir.
--
-- ── custo_usd e NULLABLE, DE PROPOSITO ─────────────────────────────
--
-- `estimarCustoUsd()` devolve 0 para modelo sem preco cadastrado, com um
-- `console.warn`. Persistir esse 0 seria registrar "nao sei o preco"
-- como se fosse "custou zero" — e um relatorio de custo somando esses
-- zeros mentiria para baixo sem nenhum sinal.
--
-- Aqui: preco conhecido => valor; preco desconhecido => NULL + warn.
-- ZERO passa a significar zero de verdade. A aplicacao consulta
-- `modeloTemPrecoCadastrado()` ANTES de calcular, justamente para nao
-- depender do 0 ambiguo.
--
-- ── O QUE ESTA TABELA NAO PODE VIRAR ───────────────────────────────
--
-- Nao e log de prompt. Nao ha, e nao deve haver, coluna para prompt,
-- instrucao, dados enviados, resposta bruta, resumo/destaques/alertas,
-- pedido cru, order_sn, anuncio, SQL, segredo, API key, Authorization,
-- header ou stack com payload. Ela guarda CONTABILIDADE: quem, quando,
-- qual modelo, quantos tokens, quanto tempo, quanto custou.
--
-- ── RLS E GRANTS: seguindo a convencao MEDIDA do projeto ───────────
--
-- Medido antes de decidir: `agentes`, `agente_tarefas` e
-- `central_ia_consumo` estao todas com RLS OFF e grants apenas para
-- `service_role`. Nenhuma tabela deste projeto usa RLS — autorizacao e
-- 100% em codigo de aplicacao.
--
-- O REVOKE explicito de PUBLIC/anon/authenticated NAO e redundante:
-- este projeto tem `ALTER DEFAULT PRIVILEGES` concedendo privilegios a
-- anon/authenticated, e `PUBLIC` e pseudo-role distinto de `anon`. Foi
-- exatamente o que causou o bug SEC1.
--
-- Cliente nao escreve contabilidade. Nao ha RPC publica porque nao ha
-- caminho publico: quem insere e a rota interna, com service_role.
-- ============================================================

create table if not exists public.agentes_ia_chamadas (
  id            uuid primary key default gen_random_uuid(),

  -- Identidade, toda vinda do claim (ContextoTarefa), nunca do input.
  user_id       text        not null,
  agente_id     uuid        not null references public.agentes(id)        on delete cascade,
  tarefa_id     uuid        not null references public.agente_tarefas(id) on delete cascade,
  tipo_tarefa   text        not null,

  -- CASCADE, e nao SET NULL como no Estudio: sem `tarefa_id` a linha
  -- perde a identidade unica e vira registro orfao nao deduplicavel.

  tentativa     integer     not null,
  sequencia     integer     not null,

  provedor      text        not null,
  modelo        text        not null,

  status        text        not null,
  tipo_erro     text        null,

  tokens_entrada integer    not null,
  tokens_saida   integer    not null,
  tempo_ms       integer    not null,

  -- NULL = modelo sem preco cadastrado. Ver docblock acima.
  custo_usd     numeric(12, 6) null,

  criado_em     timestamptz not null default now(),

  constraint agentes_ia_chamadas_tentativa_valida  check (tentativa >= 1),
  constraint agentes_ia_chamadas_sequencia_valida  check (sequencia >= 1),
  constraint agentes_ia_chamadas_tokens_entrada_ok check (tokens_entrada >= 0),
  constraint agentes_ia_chamadas_tokens_saida_ok   check (tokens_saida >= 0),
  constraint agentes_ia_chamadas_tempo_ok          check (tempo_ms >= 0),
  constraint agentes_ia_chamadas_custo_ok          check (custo_usd is null or custo_usd >= 0),

  -- Os valores vem de `ProvedorIA` em lib/ai-gateway/tipos.ts. Nao e
  -- enum novo: e a MESMA lista, copiada de proposito para que o banco
  -- recuse uma string que o TypeScript nao produziria.
  constraint agentes_ia_chamadas_provedor_valido
    check (provedor in ('openai', 'anthropic', 'google', 'fake', 'internal')),

  constraint agentes_ia_chamadas_status_valido
    check (status in ('sucesso', 'erro')),

  -- Os seis valores de `TipoErroIA`. Mesma regra do CHECK do Estudio:
  -- categoria nova nao entra por acidente.
  constraint agentes_ia_chamadas_tipo_erro_valido
    check (tipo_erro is null or tipo_erro in
           ('transient', 'auth', 'rate_limit', 'conteudo_rejeitado', 'validation', 'unknown')),

  -- Erro SEMPRE explicado, sucesso NUNCA com erro. Bicondicional, nao
  -- duas checagens soltas: impede tanto `erro` sem causa quanto
  -- `sucesso` carregando um tipo_erro esquecido de uma tentativa
  -- anterior.
  constraint agentes_ia_chamadas_erro_explicado
    check ((status = 'erro') = (tipo_erro is not null)),

  -- A identidade de UMA chamada. Ver docblock.
  constraint agentes_ia_chamadas_chamada_unica
    unique (tarefa_id, tentativa, sequencia)
);

-- Dashboards por dono: "custo do tenant X nos ultimos 30 dias".
create index if not exists idx_agentes_ia_chamadas_user_data
  on public.agentes_ia_chamadas (user_id, criado_em desc);

-- Custo global por periodo, sem passar por user_id.
create index if not exists idx_agentes_ia_chamadas_data
  on public.agentes_ia_chamadas (criado_em desc);

comment on table public.agentes_ia_chamadas is
  'AGENTES-FASE1E-e. Contabilidade de chamadas de IA dos AGENTES — uma linha por chamada ao modelo. Distinta de central_ia_consumo, que e do Estudio de Anuncios (FKs para estudio_anuncios_*, sem user_id). Identidade vem do claim, nunca do input da tarefa. NAO e log de prompt: nenhuma coluna guarda prompt, resposta, dado de pedido ou segredo. custo_usd NULL significa modelo sem preco cadastrado — 0 significa custo zero de verdade.';

comment on column public.agentes_ia_chamadas.custo_usd is
  'NULL = modelo sem preco em TABELA_PRECOS_USD_POR_MILHAO_TOKENS. Nunca use 0 para "desconhecido".';

comment on column public.agentes_ia_chamadas.sequencia is
  'Ordem da chamada DENTRO de uma execucao (tentativa). Comeca em 1.';

comment on column public.agentes_ia_chamadas.tentativa is
  'Copia de agente_tarefas.tentativas no momento do claim. Incrementa a cada claim, entao distingue reexecucoes pagas.';

-- ── Privilegios ────────────────────────────────────────────────────
--
-- REVOKE de PUBLIC nao cobre anon/authenticated: sao roles distintos, e
-- este projeto concede a eles por ALTER DEFAULT PRIVILEGES. Bug SEC1.
revoke all on public.agentes_ia_chamadas from public;
revoke all on public.agentes_ia_chamadas from anon;
revoke all on public.agentes_ia_chamadas from authenticated;

grant select, insert on public.agentes_ia_chamadas to service_role;

-- Contabilidade e registro APPEND-ONLY: corrigir um numero de custo
-- depois do fato seria reescrever historico financeiro, e um registro
-- reescrevivel deixa de servir como evidencia. DELETE so acontece por
-- CASCADE, quando a tarefa dona deixa de existir.
--
-- ── ESTA LINHA FALTAVA, E A FALTA FOI CORRIGIDA A PARTE ────────────
--
-- O `grant select, insert` acima NAO restringe: `GRANT` e aditivo, e
-- este projeto tem `ALTER DEFAULT PRIVILEGES` dando TUDO (`arwdDxtm`)
-- a `service_role` em toda tabela nova. Quando o grant rodou,
-- `service_role` ja tinha UPDATE, DELETE e TRUNCATE.
--
-- Neste projeto, privilegio de tabela nova precisa ser REVOGADO, nunca
-- apenas "nao concedido".
revoke update, delete, truncate on public.agentes_ia_chamadas from service_role;

-- ── HISTORICO REAL DESTE ARQUIVO ───────────────────────────────────
--
-- Este arquivo descreve o ESTADO DESEJADO, para instalacoes futuras.
-- Ele NAO e, byte a byte, o artefato que foi aplicado:
--
--   1. A criacao da tabela foi aplicada em 2026-08-26 e registrada em
--      `supabase_migrations.schema_migrations` sob a versao
--      20260826193452 (o runner carimba a propria versao pelo horario
--      da aplicacao; o nome deste arquivo, 20260919, NAO coincide).
--      Naquele momento a linha `revoke update, delete, truncate` acima
--      ainda NAO existia.
--
--   2. A inspecao pos-migration flagrou `service_role` com o conjunto
--      completo de privilegios, contrariando o append-only pretendido.
--
--   3. A correcao foi aplicada por migration SEPARADA —
--      `20260826_agentes_ia_chamadas_append_only.sql`, registrada como
--      versao 20260826193859 — contendo exatamente o mesmo `revoke`
--      acrescentado acima.
--
-- Num banco novo, aplicar este arquivo sozinho ja produz o estado
-- correto, e a corretiva vira no-op idempotente. Num banco que ja tem a
-- tabela, quem vale e a corretiva. As duas convergem para o mesmo lugar,
-- e por isso ambas ficam versionadas — apagar uma delas apagaria a
-- historia de um defeito que vale ser lembrado.

-- ── O QUE ESTA MIGRATION NAO FAZ ───────────────────────────────────
--   - Nao habilita RLS (nenhuma tabela do projeto usa).
--   - Nao cria RPC (nao ha caminho publico de escrita).
--   - Nao altera central_ia_consumo, agentes, agente_tarefas ou pedidos.
--   - Nao move nem copia dado nenhum.
--   - Nao toca no Estudio de Anuncios.
