-- ============================================================
-- TOOL-CALL-B — persistencia de chamadas de Funcao (Tool Call)
--
-- NAO APLICADA. Aplicar ao banco exige autorizacao explicita, separada
-- da criacao deste arquivo.
--
-- ── O PROBLEMA QUE ESTA TABELA EXISTE PARA RESOLVER ─────────────────
--
-- Uma Funcao pode produzir efeito FORA da CDS. Quando o executor for o
-- n8n, ele nao guarda nada: as probes da frente anterior provaram que
-- `saveDataSuccessExecution="none"` e `saveDataErrorExecution="none"`
-- sao obrigatorios (com "all", o header de autenticacao fica persistido
-- na execution), e a consequencia e que NEM sucesso NEM erro deixam
-- registro do lado de la.
--
-- Entao a CDS e a unica autoridade de auditoria, e a janela e esta:
--
--     registrar depois de executar
--       → processo morre entre as duas coisas
--       → o efeito aconteceu e ninguem sabe
--
-- Por isso a linha de ABERTURA nasce ANTES do executor.
--
-- ── APPEND-ONLY EM DUAS FASES, E POR QUE NAO MUTAVEL ────────────────
--
-- O desenho obvio seria uma linha mutavel: nasce `executando` e depois
-- e finalizada. Foi o primeiro desenho, e ele foi descartado depois de
-- medir o schema real.
--
-- Este projeto tem exatamente DOIS mecanismos de enforcement:
--
--   grants        `agentes_ia_chamadas` so tem SELECT/INSERT para
--                 service_role. Isso o banco IMPOE.
--   RPC + CHECK   `agente_tarefas` tem `concluir_tarefa` com
--                 `WHERE status='rodando'` e RAISE fora de ordem — mas
--                 `service_role` mantem UPDATE, e a RPC e
--                 `SECURITY INVOKER`. Ela DOCUMENTA a transicao; nao a
--                 impede.
--
-- E nao ha terceiro: o schema inteiro tem ZERO funcoes
-- `SECURITY DEFINER` e ZERO triggers. Criar o primeiro de qualquer um
-- dos dois para estrear uma tabela seria inventar padrao — e o
-- `CLAUDE.md` exige `SECURITY INVOKER` em toda RPC nova.
--
-- Entao esta tabela usa o unico mecanismo que realmente enforca:
--
--     fase='abertura'  status='executando'          antes do executor
--     fase='desfecho'  status=sucesso|erro|negado|  depois, ou sozinho
--                             aguardando_aprovacao
--
-- Nenhum UPDATE, nenhum DELETE, nenhuma RPC, nenhum trigger. Estado
-- terminal fica impossivel de reabrir por PRIVILEGIO, nao por convencao.
-- `UNIQUE (user_id, request_id, fase)` garante no maximo uma abertura e
-- um desfecho por tentativa: finalizacao concorrente colide em 23505,
-- que e evento semantico e nao "ja estava assim".
--
-- Custo aceito: o estado corrente de uma tentativa e a linha mais
-- recente daquele `request_id` — no maximo duas. Limite honesto: um
-- desfecho de execucao SEM abertura correspondente nao e impedivel por
-- constraint (exigiria FK auto-referencial); e invariante de aplicacao,
-- detectavel por consulta, e cobrado na suite.
--
-- ── DESFECHO SOZINHO NAO E OMISSAO ──────────────────────────────────
--
-- `negado`, `aguardando_aprovacao` e o `erro/entrada_invalida` nascem
-- SEM abertura, e isso e a afirmacao honesta: sem abertura, o executor
-- nunca foi engajado. Nenhuma linha desta tabela diz que uma Funcao
-- rodou quando ela nao rodou.
--
-- ── O QUE NAO ENTRA NESTA MIGRATION ─────────────────────────────────
--
-- `saida`/`resultado`, qualquer coluna `n8n_*`, `modo_execucao`,
-- `tentativa`, `origem_request_id` e `finalizado_em`. Os quatro
-- primeiros nao tem produtor: o executor externo nao existe, e coluna
-- sem produtor e espelho que envelhece sozinho. `finalizado_em` nao
-- existe porque o `criado_em` da linha de desfecho JA e a hora da
-- finalizacao — duas colunas para o mesmo instante divergem.
-- ============================================================

-- ── Pre-requisito: a UNIQUE que torna a FK de tarefa tenant-safe ─────
--
-- `agente_tarefas` so tinha `PRIMARY KEY (id)`, e FK composta exige uma
-- UNIQUE sobre o par. Nao e reforma: `id` ja e unico, entao a constraint
-- e trivialmente satisfeita e custa um indice. E e exatamente o padrao
-- que a fundacao criou para este fim — `agentes_id_por_dono` existe
-- desde a 20260916 e ja sustenta as FKs compostas de `agente_tarefas`,
-- `agente_permissoes` e `agente_conexoes`.
--
-- Sem ela, `tarefa_id` so poderia ter FK SIMPLES, e uma Tool Call
-- poderia apontar para a tarefa de OUTRO dono sem o banco reclamar.
alter table public.agente_tarefas
  drop constraint if exists agente_tarefas_id_por_dono;

alter table public.agente_tarefas
  add constraint agente_tarefas_id_por_dono unique (id, user_id);

-- ── A tabela ─────────────────────────────────────────────────────────

create table if not exists public.agente_funcao_chamadas (
  id                uuid primary key default gen_random_uuid(),

  -- Identidade, sempre do contexto autenticado do servidor. Nunca do
  -- argumento, nunca do modelo, nunca do corpo da requisicao.
  user_id           text        not null,
  agente_id         uuid        not null,

  -- NULL SOMENTE para tentativa malformada. Ver o CHECK
  -- `funcao_id_so_nula_em_inexistente` e o docblock de `acesso`.
  funcao_id         text        null,

  -- Funcao e executavel FORA da fila: `registry.ts` diz isso, e
  -- `vendas.consultar` nao le, nao escreve e nao consulta
  -- `agente_tarefas`. Por isso nullable.
  tarefa_id         uuid        null,

  -- UMA TENTATIVA de invocar uma Funcao. Nasce antes do guard e
  -- acompanha as duas linhas. NAO significa "uma passagem pelo
  -- executor": negado e aguardando_aprovacao tambem tem request_id, e
  -- nao chegam ao executor.
  request_id        text        not null,

  fase              text        not null,
  status            text        not null,

  -- Uma coluna para decisao E para falha. `erro_codigo` seria nome
  -- errado: `aprovacao_necessaria` nao e erro, e os cinco codigos de
  -- negacao sao DECISOES. Com o nome neutro, `aguardando_aprovacao`
  -- registra por que parou em vez de ficar sem explicacao.
  codigo_desfecho   text        null,
  mensagem_desfecho text        null,

  -- Deduplicacao da INTENCAO de executar. Distinta de
  -- `DefinicaoFuncao.idempotente`, que e propriedade semantica da
  -- Funcao e vive no catalogo em codigo. Existe so na ABERTURA: negacao
  -- e espera de aprovacao nao produzem efeito, entao nao ha o que
  -- deduplicar.
  idempotency_key   text        null,

  -- ── Snapshots historicos ──────────────────────────────────────────
  --
  -- NENHUM destes tres blocos e autoridade. Eles registram o que era
  -- verdade no instante da decisao, para que a auditoria continue
  -- legivel depois que `agente_permissoes` e `agente_conexoes` mudarem
  -- — as duas sao mutaveis. Ler qualquer um deles para autorizar uma
  -- execucao futura seria criar uma segunda autoridade, escondida e sem
  -- dono.
  acesso            text        null,
  nivel_no_momento  text        null,
  plataforma        text        null,
  recurso           text        null,
  loja_id           uuid        null,

  -- Projecao por allowlist, nunca argumento cru. Ver `sanitizar.ts`:
  -- so escalares atravessam, e o objeto de saida comeca vazio.
  entrada_resumo    jsonb       not null default '{}'::jsonb,

  latencia_ms       integer     null,
  criado_em         timestamptz not null default now(),

  -- ── Tenant, imposto pelo banco ──────────────────────────────────
  --
  -- As tres FKs sao COMPOSTAS com `user_id`. Uma Tool Call apontando
  -- para agente, tarefa ou loja de outro dono deixa de ser improvavel e
  -- passa a ser impossivel. Mesmo padrao de
  -- `agente_conexoes_loja_do_mesmo_dono`.
  --
  -- RESTRICT nos tres, e nao CASCADE: esta tabela e historico de acao
  -- que pode ter tido efeito EXTERNO. Apagar o agente, a tarefa ou a
  -- loja nao pode apagar a prova de que algo foi feito em nome do dono.
  --
  -- Nao ha conflito com fluxo existente: nao ha hard-delete de agente
  -- em lugar nenhum do repositorio, e `agente_tarefas` ja referencia
  -- `agentes` com RESTRICT desde a fundacao — deletar agente com tarefa
  -- ja era impedido. `agentes_ia_chamadas` usa CASCADE, e a diferenca e
  -- deliberada: la a linha e contabilidade de consumo; aqui e o unico
  -- registro de um efeito.
  constraint agente_funcao_chamadas_agente_do_mesmo_dono
    foreign key (agente_id, user_id) references public.agentes (id, user_id)
    on update restrict on delete restrict,

  constraint agente_funcao_chamadas_tarefa_do_mesmo_dono
    foreign key (tarefa_id, user_id) references public.agente_tarefas (id, user_id)
    on update restrict on delete restrict,

  constraint agente_funcao_chamadas_loja_do_mesmo_dono
    foreign key (loja_id, user_id) references public.lojas (id, user_id)
    on update restrict on delete restrict,

  -- ── Fase e status sao a MESMA afirmacao, vista de dois lados ─────
  --
  -- Bicondicional, nao duas checagens soltas: impede tanto um
  -- `executando` marcado como desfecho quanto um `sucesso` marcado como
  -- abertura.
  constraint agente_funcao_chamadas_fase_valida
    check (fase in ('abertura', 'desfecho')),
  constraint agente_funcao_chamadas_status_valido
    check (status in ('executando', 'sucesso', 'erro', 'negado', 'aguardando_aprovacao')),
  constraint agente_funcao_chamadas_fase_casa_status
    check ((fase = 'abertura') = (status = 'executando')),

  -- ── O codigo pertence ao status, nao "a qualquer desfecho" ───────
  --
  -- Um CHECK generico ("nao nulo em desfecho") deixaria passar
  -- `negado` com `timeout` e `erro` com `permissao_bloqueada`. O CASE
  -- amarra cada status ao seu conjunto:
  --
  --   os cinco de negacao vem de `CODIGOS_NEGACAO`, em `guard.ts`, sem
  --   renomear nada — a mesma lista, copiada de proposito para que o
  --   banco recuse uma string que o TypeScript nao produziria;
  --   `aprovacao_necessaria` e EXCLUSIVO de `aguardando_aprovacao`, e
  --   por isso sai da lista de `negado`.
  constraint agente_funcao_chamadas_codigo_por_status
    check (
      case status
        when 'executando'           then codigo_desfecho is null
        when 'sucesso'              then codigo_desfecho is null
        when 'aguardando_aprovacao' then codigo_desfecho = 'aprovacao_necessaria'
        when 'negado'               then codigo_desfecho in (
                                           'funcao_inexistente',
                                           'permissao_ausente',
                                           'permissao_bloqueada',
                                           'conexao_ausente')
        when 'erro'                 then codigo_desfecho in (
                                           'entrada_invalida',
                                           'executor_falhou',
                                           'saida_invalida',
                                           'timeout',
                                           'erro_interno')
      end
    ),

  -- Explicacao existe para o que precisa ser explicado. Sucesso e
  -- abertura nao precisam, e uma mensagem esquecida ali descreveria
  -- outra coisa.
  constraint agente_funcao_chamadas_mensagem_so_em_desfecho_explicado
    check (mensagem_desfecho is null or status not in ('executando', 'sucesso')),
  constraint agente_funcao_chamadas_mensagem_truncada
    check (mensagem_desfecho is null or length(mensagem_desfecho) <= 300),

  -- ── funcao_id ────────────────────────────────────────────────────
  --
  -- Mesmo regex de `agente_permissoes_funcao_id_formato`: o id que uma
  -- Skill escreve e o id que o registry resolve e o id que a permissao
  -- chaveia. Uma quarta forma aqui obrigaria traducao.
  --
  -- NULL e reservado a tentativa MALFORMADA (id vazio, com forma
  -- invalida, ou que nem era string). Um id bem-formado porem
  -- desconhecido — `vendas.inexistente` — e PRESERVADO: saber o que
  -- alguem tentou invocar e o sinal de seguranca mais interessante que
  -- esta tabela captura.
  constraint agente_funcao_chamadas_funcao_id_formato
    check (funcao_id is null or funcao_id ~ '^[a-z0-9]+(\.[a-z0-9_]+)+$'),
  constraint agente_funcao_chamadas_funcao_id_so_nula_em_inexistente
    check (
      funcao_id is not null
      or (status = 'negado' and codigo_desfecho = 'funcao_inexistente')
    ),

  -- ── acesso ───────────────────────────────────────────────────────
  --
  -- Copiado de `DefinicaoFuncao` quando a Funcao FOI resolvida. NULL
  -- significa exatamente "nao houve Funcao a resolver".
  --
  -- O bicondicional e com a NAO-RESOLUCAO, nao com a nulidade de
  -- `funcao_id`. A diferenca importa: `vendas.inexistente` tem
  -- `funcao_id` preenchido e `acesso` NULL — id bem-formado que o
  -- registry nao conhece. Amarrar `acesso` a `funcao_id IS NULL` seria
  -- falso justamente nesse caso.
  constraint agente_funcao_chamadas_acesso_valido
    check (acesso is null or acesso in ('leitura', 'escrita')),
  constraint agente_funcao_chamadas_acesso_so_com_funcao_resolvida
    check (
      (acesso is null)
      = (status = 'negado' and codigo_desfecho = 'funcao_inexistente')
    ),

  -- Os tres niveis de `agente_permissoes_nivel_valido`. NULL = nenhum
  -- nivel foi resolvido naquele instante (guard parou antes, ou o dono
  -- nunca configurou).
  constraint agente_funcao_chamadas_nivel_valido
    check (nivel_no_momento is null
           or nivel_no_momento in ('automatico', 'aprovacao', 'bloqueado')),

  -- ── Conexao ──────────────────────────────────────────────────────
  --
  -- `(plataforma, recurso)` e a forma de `RequisitoConexaoFuncao` e a PK
  -- de `agente_conexoes`: os dois juntos ou nenhum.
  --
  -- `loja_id` pode faltar mesmo com requisito presente — e o caso de
  -- `conexao_ausente`, onde o requisito existe e nenhuma loja o
  -- atendeu. Inventar uma loja ali seria afirmar o contrario do que
  -- aconteceu. O inverso e proibido: loja sem requisito nao significa
  -- nada.
  constraint agente_funcao_chamadas_requisito_completo
    check ((plataforma is null) = (recurso is null)),
  constraint agente_funcao_chamadas_loja_exige_requisito
    check (loja_id is null or plataforma is not null),

  -- ── request_id ───────────────────────────────────────────────────
  constraint agente_funcao_chamadas_request_id_nao_vazio
    check (length(btrim(request_id)) > 0),

  -- ── idempotency_key ──────────────────────────────────────────────
  --
  -- So na ABERTURA: ela e a autoridade de deduplicacao, e o desfecho e
  -- localizado pelo mesmo `(user_id, request_id)`. Duplicar a chave nas
  -- duas linhas criaria dois lugares que precisariam concordar para
  -- sempre.
  --
  -- Obrigatoria quando a Funcao ESCREVE. Sob semantica at-least-once,
  -- repetir uma escrita sem chave e a diferenca entre uma mensagem
  -- respondida e duas.
  constraint agente_funcao_chamadas_idem_so_na_abertura
    check (fase = 'abertura' or idempotency_key is null),
  constraint agente_funcao_chamadas_idem_obrigatoria_em_escrita
    check (fase <> 'abertura' or acesso <> 'escrita' or idempotency_key is not null),

  -- ── Latencia ─────────────────────────────────────────────────────
  --
  -- A abertura nao mediu nada ainda. E o desfecho NAO e obrigado a ter
  -- numero: nao ha produtor confiavel de latencia neste gate, e um zero
  -- inventado para satisfazer constraint seria pior que a ausencia.
  constraint agente_funcao_chamadas_latencia_valida
    check (latencia_ms is null or latencia_ms >= 0),
  constraint agente_funcao_chamadas_abertura_sem_latencia
    check (fase <> 'abertura' or latencia_ms is null),

  -- No maximo UMA abertura e UM desfecho por tentativa. Finalizacao
  -- concorrente colide em 23505 — evento semantico, tratado por quem
  -- chama, nunca engolido.
  constraint agente_funcao_chamadas_fase_unica_por_tentativa
    unique (user_id, request_id, fase)
);

-- ── Indices ──────────────────────────────────────────────────────────
--
-- Tres, e cada um tem consulta. Nenhum especulativo: `tarefa_id` ainda
-- nao tem quem o consulte, entao nao ganha indice.

-- Historico do dono.
create index if not exists idx_agente_funcao_chamadas_user_data
  on public.agente_funcao_chamadas (user_id, criado_em desc);

-- Historico de um agente — a tela do agente.
create index if not exists idx_agente_funcao_chamadas_agente_data
  on public.agente_funcao_chamadas (agente_id, criado_em desc);

-- Deduplicacao de intencao. Parcial nos dois eixos: so aberturas, so
-- com chave. Sem isso, o indice cobriria linhas onde a chave e sempre
-- NULL por constraint.
create unique index if not exists idx_agente_funcao_chamadas_idempotencia
  on public.agente_funcao_chamadas (user_id, funcao_id, idempotency_key)
  where fase = 'abertura' and idempotency_key is not null;

-- Recuperacao: abertura sem desfecho e o sinal de "alguem precisa
-- olhar". Parcial porque so `executando` interessa, e ele e a minoria.
create index if not exists idx_agente_funcao_chamadas_abertas
  on public.agente_funcao_chamadas (criado_em)
  where status = 'executando';

-- ── Comentarios ──────────────────────────────────────────────────────

comment on table public.agente_funcao_chamadas is
  'TOOL-CALL-B. Auditoria append-only de chamadas de Funcao, em DUAS FASES: abertura (status=executando, gravada ANTES do executor) e desfecho (sucesso/erro/negado/aguardando_aprovacao). Nenhuma linha e atualizada ou apagada — a imutabilidade e imposta por GRANT, nao por convencao. Negacao e espera de aprovacao nascem sem abertura, porque o executor nunca foi engajado. NAO guarda argumento cru, saida, credencial, token nem header.';

comment on column public.agente_funcao_chamadas.request_id is
  'UMA tentativa de invocar uma Funcao. Nasce antes do guard e acompanha abertura e desfecho. Nao significa "uma passagem pelo executor": negado e aguardando_aprovacao tambem tem request_id.';

comment on column public.agente_funcao_chamadas.acesso is
  'SNAPSHOT historico de DefinicaoFuncao.acesso. NULL = Funcao nao resolvida. NUNCA consultar para autorizar execucao futura: a autoridade e o registry em codigo.';

comment on column public.agente_funcao_chamadas.nivel_no_momento is
  'SNAPSHOT historico de agente_permissoes.nivel no instante da decisao. NUNCA consultar para autorizar execucao futura: agente_permissoes e mutavel e continua sendo a autoridade.';

comment on column public.agente_funcao_chamadas.idempotency_key is
  'Deduplicacao da INTENCAO de executar, so na linha de abertura. Distinta de DefinicaoFuncao.idempotente, que e propriedade semantica da Funcao. Obrigatoria quando acesso=escrita.';

comment on column public.agente_funcao_chamadas.entrada_resumo is
  'Projecao por allowlist (lib/agentes/funcoes/sanitizar.ts): somente escalares, objeto novo comecando vazio. Nunca argumento cru, request, envelope de webhook ou header.';

-- ── Append-only por privilegio ───────────────────────────────────────
--
-- Os tres REVOKE sao explicitos e nenhum e redundante: este projeto tem
-- `ALTER DEFAULT PRIVILEGES` concedendo EXECUTE/privilegios a
-- `anon`/`authenticated` em objeto novo, e `REVOKE FROM PUBLIC` NAO
-- cobre isso — `PUBLIC` e pseudo-role distinto. Foi a causa do bug SEC1.
revoke all on public.agente_funcao_chamadas from public;
revoke all on public.agente_funcao_chamadas from anon;
revoke all on public.agente_funcao_chamadas from authenticated;

grant select, insert on public.agente_funcao_chamadas to service_role;

-- O coracao do modelo. Sem estes tres, "append-only" seria so uma
-- palavra no comentario.
revoke update, delete, truncate on public.agente_funcao_chamadas from service_role;
