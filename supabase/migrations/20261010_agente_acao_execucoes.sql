-- ============================================================
-- M2-I1-A8B — `agente_acao_execucoes`: o ciclo de vida de uma ACAO
--
-- NAO APLICADA AINDA. Aplicar ao banco exige autorizacao explicita,
-- separada da criacao deste arquivo.
--
-- ── A PERGUNTA QUE ESTA TABELA RESPONDE ─────────────────────────────
--
-- "aquela varredura das 15:30 chegou a comecar? terminou? terminou
--  inteira, ou parou no teto com backlog?"
--
-- Hoje ninguem responde isso. Uma varredura de duas paginas produz DUAS
-- aberturas de Funcao em `agente_funcao_chamadas` e ZERO registro da
-- ACAO. Se o processo morre entre as paginas, o que fica sao dois
-- fragmentos de Funcao e nenhuma evidencia de que uma varredura existiu.
--
-- ── POR QUE TABELA NOVA, E NAO `agente_funcao_chamadas` ────────────
--
-- Nao foi escolha de gosto. Aquela tabela recusa uma linha de ACAO em
-- QUATRO pontos independentes, e cada um sozinho ja bastaria:
--
--  1. `agente_funcao_chamadas_acesso_so_com_funcao_resolvida` e um
--     bicondicional: toda linha que nao seja `funcao_inexistente` TEM
--     de trazer `acesso in ('leitura','escrita')`. Uma acao nao tem
--     `acesso` — `leitura` seria falso porque ela grava na inbox, e
--     `escrita` seria falso porque ela nao e Funcao. Nao existe valor
--     verdadeiro.
--
--  2. `agente_funcao_chamadas_funcao_id_so_nula_em_inexistente` reserva
--     o NULL para a tentativa malformada. Usa-lo aqui obrigaria a
--     declarar `status='negado'` e `codigo='funcao_inexistente'`. E, no
--     indice unico parcial, NULLs sao distintos entre si — a mesma
--     tentativa poderia abrir a acao N vezes.
--
--  3. `agente_funcao_chamadas_funcao_id_formato` usa o MESMO regex de
--     `agente_permissoes_funcao_id_formato`, e o comentario de la diz
--     por que: "o id que uma Skill escreve e o id que o registry
--     resolve e o id que a permissao chaveia. Uma quarta forma aqui
--     obrigaria traducao." Um `acao.sincronizar_perguntas` seria essa
--     quarta forma.
--
--  4. `agente_funcao_chamadas_codigo_por_status` fecha o vocabulario:
--     `sucesso` exige codigo NULL, e `erro` aceita cinco codigos, todos
--     de Funcao. Nao ha onde escrever `backlog_truncado`. Grava-lo como
--     sucesso seria exatamente a mentira que `CAP_EXHAUSTED_IS_SUCCESS
--     = NO` existe para impedir.
--
-- Havia ainda um custo do lado de quem LE: `observabilidade-stale.ts`
-- agrega por `funcao_id`, e `stale.ts` trata abertura sem desfecho como
-- chamada de Funcao travada. Uma acao orfa apareceria ali como Funcao.
--
-- ── O QUE ESTA MIGRATION NAO FAZ ────────────────────────────────────
--
-- Nao toca `agente_funcao_chamadas`, nao toca a inbox, nao cria RPC,
-- nao registra acao nenhuma, nao expoe rota e nao aplica a 20261008.
-- So a fundacao do registro.
-- ============================================================

-- ── Sem `if not exists`, e isto e deliberado ─────────────────────────
--
-- A convencao do projeto favorece `if not exists` para que reaplicar
-- seja inofensivo. Aqui ela seria nociva: a tabela e nova e as
-- constraints sao apertadas de proposito. Se um objeto de mesmo nome ja
-- existir com OUTRA forma, `if not exists` o aceitaria em silencio e a
-- auditoria passaria a gravar contra um contrato que ninguem conferiu.
-- Falhar alto e a resposta honesta; a migration roda em transacao
-- unica, entao nao ha meio-termo para reaplicar.
create table public.agente_acao_execucoes (
  id uuid primary key default gen_random_uuid(),

  -- Dono. `text` como em todo o resto do schema.
  user_id text not null,

  -- Quem agiu. A acao sempre nasce de um agente ja resolvido: sem
  -- agente nao ha o que registrar, e a FK abaixo torna isso estrutural.
  agente_id uuid not null,

  -- ── A conta, e por que ela e OPCIONAL ─────────────────────────────
  --
  -- A abertura acontece ANTES da primeira pagina, e a conta autoritativa
  -- so existe depois que uma execucao de Funcao devolve `autoridade`.
  -- Exigir `loja_id` na abertura obrigaria a resolver o binding so para
  -- preencher auditoria — uma SEGUNDA resolucao, e e justamente a
  -- segunda resolucao que o I2 eliminou para fechar o TOCTOU entre
  -- buscar e gravar.
  --
  -- Entao: NULL na abertura, e no desfecho a conta REAL da varredura,
  -- se ela chegou a existir. Falha antes disso mantem NULL — que e a
  -- verdade, nao uma lacuna.
  loja_id uuid null,

  -- ── A identidade da ACAO ──────────────────────────────────────────
  --
  -- Vocabulario de PRODUTO, e o regex e deliberadamente INCOMPATIVEL
  -- com o de Funcao: aquele EXIGE ponto (`^[a-z0-9]+(\.[a-z0-9_]+)+$`),
  -- este o PROIBE. Os dois conjuntos sao disjuntos, entao nenhum id de
  -- Funcao cabe aqui e nenhum id de acao cabe la. A confusao entre os
  -- dois niveis deixa de depender de disciplina.
  acao_id text not null,

  -- Identidade desta execucao da acao. Gerada no SERVIDOR, nunca
  -- recebida: a abertura e o desfecho compartilham este valor, e e por
  -- ele que os dois se encontram.
  request_id text not null,

  fase text not null,
  status text not null,
  codigo_desfecho text null,
  mensagem_desfecho text null,

  -- A chave da TENTATIVA. `n8n:<attempt>:<acao>:<agenteId>` — a mesma
  -- que prefixa as chaves de pagina (`...:p0`, `...:p1`), o que liga a
  -- acao as execucoes de Funcao sem guardar identificador de negocio.
  idempotency_key text null,

  -- Somente ESCALAR. Metricas da varredura: paginas, contagens do
  -- provider, o que foi descartado e por que camada, e o que a RPC
  -- gravou. Nunca texto de pergunta, id externo, payload bruto ou
  -- credencial.
  entrada_resumo jsonb not null default '{}'::jsonb,

  latencia_ms integer null,
  criado_em timestamptz not null default now(),

  -- ── Cerca de dono ─────────────────────────────────────────────────
  --
  -- Mesma forma das FKs compostas que o schema ja usa. Linha com agente
  -- de outro dono e ESTRUTURALMENTE impossivel.
  constraint agente_acao_execucoes_agente_do_mesmo_dono
    foreign key (agente_id, user_id)
    references public.agentes (id, user_id)
    on update restrict on delete restrict,

  -- `match simple` e o padrao, e aqui ele importa: com `loja_id` NULL a
  -- composta NAO e verificada, que e exatamente o que a abertura
  -- precisa. `match full` recusaria a abertura. Quando `loja_id` vem
  -- preenchido, a cerca de dono volta a valer inteira.
  constraint agente_acao_execucoes_loja_do_mesmo_dono
    foreign key (loja_id, user_id)
    references public.lojas (id, user_id)
    on update restrict on delete restrict,

  constraint agente_acao_execucoes_acao_id_formato
    check (acao_id ~ '^[a-z][a-z0-9_]{2,63}$'),

  constraint agente_acao_execucoes_request_id_nao_vazio
    check (length(btrim(request_id)) > 0),

  constraint agente_acao_execucoes_fase_valida
    check (fase in ('abertura', 'desfecho')),

  -- ── O vocabulario de status ───────────────────────────────────────
  --
  -- SEIS estados, e cada um diz uma coisa que os outros nao dizem.
  -- `parcial` existe para que varredura incompleta nunca precise se
  -- passar por `sucesso`.
  --
  -- ── Por que `aguardando_aprovacao` e status, e nao codigo de erro ──
  --
  -- `agente_permissoes.nivel` aceita `aprovacao` para QUALQUER Funcao —
  -- o CHECK e `nivel in ('bloqueado','aprovacao','automatico')`, sem
  -- recorte por acesso, e o guard pausa em `nivel === "aprovacao"` antes
  -- mesmo de olhar conexao. Entao o dono PODE exigir aprovacao para
  -- `mercadolivre.perguntas.listar`, e a varredura para esperando
  -- alguem. Isso nao e erro (nada quebrou), nao e negacao (a decisao
  -- ainda pode vir) e nao e parcial (nada foi ingerido). Enfia-lo em
  -- `erro/erro_interno` so para caber no schema seria a mentira que este
  -- vocabulario existe para impedir.
  --
  -- A palavra e a MESMA de `agente_tarefas.status` e de `ESTADOS_RECUSA`
  -- no guard. Nenhum enum paralelo foi inventado.
  --
  -- ── A regra que da sentido ao conjunto ────────────────────────────
  --
  -- `negado` e `aguardando_aprovacao` implicam que o PROVIDER NUNCA FOI
  -- CHAMADO: os dois nascem do guard, antes de qualquer ida ao
  -- marketplace. Recusa que acontece DEPOIS de trabalho externo — a
  -- inbox recusando a gravacao, por exemplo — e `erro`, com codigo
  -- proprio. Sem essa regra os dois estados perderiam o unico conteudo
  -- que os distingue de um erro qualquer.
  constraint agente_acao_execucoes_status_valido
    check (status in (
      'executando',
      'sucesso',
      'parcial',
      'aguardando_aprovacao',
      'negado',
      'erro')),

  -- Abertura e desfecho sao LINHAS distintas, nunca um UPDATE. O
  -- bicondicional garante que `executando` so exista na abertura e que
  -- a abertura nunca carregue desfecho.
  constraint agente_acao_execucoes_fase_casa_status
    check ((fase = 'abertura') = (status = 'executando')),

  -- ── O vocabulario de desfecho ─────────────────────────────────────
  --
  -- FECHADO, e derivado do union REAL que `sincronizarPerguntas`
  -- devolve — nao de uma lista imaginada. Cada codigo abaixo tem um
  -- caminho de retorno concreto no servico, e cada caminho de retorno do
  -- servico tem exatamente um codigo aqui. Nao ha codigo generico de
  -- reserva: um "outro" viraria o lugar onde todo desfecho mal entendido
  -- acabaria.
  --
  -- ── Por que os codigos sao em portugues ───────────────────────────
  --
  -- `agente_funcao_chamadas.erro_codigo` — o ledger irmao — ja usa
  -- `permissao_ausente`, `conexao_ausente`, `executor_falhou`,
  -- `saida_invalida`, `erro_interno`. Dois ledgers do mesmo sistema
  -- falando idiomas diferentes obrigariam a traduzir para cruzar, e
  -- traducao entre autoridades e onde erro de escopo se esconde. A
  -- versao anterior deste arquivo tinha `permission_denied` e
  -- `provider_error`; como a migration nunca foi aplicada, a correcao e
  -- aqui mesmo, sem 20261011.
  --
  -- ── `negado`: os codigos sao os do GUARD, adotados inteiros ───────
  --
  -- Exatamente `CodigoNegacaoTerminal` = `CodigoNegacao` menos
  -- `aprovacao_necessaria`, que virou status proprio. A lista nao e
  -- reescrita por gosto: o docblock de `CODIGOS_NEGACAO` diz que
  -- renomear um deles e mudanca de contrato. Uma quinta forma aqui seria
  -- a traducao que nao queremos.
  --
  -- ── `erro`: um codigo por causa, e a causa e distinguivel ─────────
  --
  --   provedor_falhou          o marketplace falhou ou recusou
  --   contrato_violado         a Funcao rompeu o proprio contrato de saida
  --   autoridade_divergente    duas paginas vieram de contas diferentes
  --   autoridade_indisponivel  agente/tarefa deixou de ser resolvivel
  --   persistencia_negada      a RPC da inbox recusou a LOJA (42501)
  --   persistencia_recusada    a RPC recusou o LOTE (22023 / 25000)
  --   persistencia_falhou      a chamada da RPC nao concluiu
  --   auditoria_funcao_falhou  a Funcao rodou e o ledger dela nao gravou
  --   orcamento_esgotado       o RELOGIO da propria acao cortou antes de
  --                            a primeira pagina comecar
  --   erro_interno             defeito nosso, fail-closed
  --
  -- `orcamento_esgotado` NAO e `provedor_falhou`: culpar o Mercado Livre
  -- por um corte que o CDS impos mandaria investigar o lugar errado. E
  -- tambem nao e `backlog_truncado`, porque nenhuma pagina chegou a
  -- provar que havia backlog. Quando o corte acontece DEPOIS de uma
  -- pagina durável, ai sim o desfecho e `parcial/backlog_truncado`, e o
  -- escalar `orcamento_esgotado` no resumo diz por que.
  --
  -- `persistencia_negada` e separada das outras duas porque pede uma
  -- acao diferente do dono: religar a conta. Colapsa-la em
  -- `persistencia_recusada` mandaria procurar bug de dados onde o que ha
  -- e vinculo desfeito.
  --
  -- ── Por que `auditoria_funcao_incompleta` e PARCIAL ───────────────
  --
  -- Leitura idempotente cujo desfecho de Funcao nao gravou devolve
  -- `sucesso` com `auditoria: "incompleta"` (`executar.ts`, ramo de
  -- sucesso). O dado do provider e verdadeiro e a inbox recebe tudo: o
  -- NEGOCIO terminou. O REGISTRO e que ficou pela metade — a abertura
  -- de Funcao permanece orfa em `executando`.
  --
  -- Gravar isso como `sucesso` limpo esconderia a orfa: quem filtra
  -- `status='sucesso'` nao teria como saber que ha um rastro quebrado.
  -- E um `erro` seria pior ainda, porque afirmaria que a varredura
  -- falhou quando ela nao falhou. `parcial` e o unico dos tres que diz
  -- a verdade — e a linha da acao passa a ser a explicacao de POR QUE
  -- existe uma abertura de Funcao sem desfecho.
  --
  -- E o de MENOR precedencia entre os parciais: backlog e descartes
  -- falam do que o negocio deixou de fazer, e isso vem antes do que a
  -- auditoria deixou de registrar. Quando um deles vence, o fato
  -- continua no `entrada_resumo` como escalar.
  --
  -- ── O que NAO esta aqui, e por que ────────────────────────────────
  --
  -- `agente_indisponivel`: a abertura exige `agente_id` com FK e
  -- `user_id` lido DO agente, entao os tres motivos (inexistente,
  -- inativo, falha de leitura) acontecem ANTES de existir linha. Nao ha
  -- o que registrar quando nada comecou. A ordem de abertura que o
  -- servico precisa adotar — resolver e conferir o agente, so entao
  -- abrir — e o que torna isso invariante, e nao acaso.
  --
  -- `ja_processado`: exige que a chave de pagina (`<tentativa>:pN`) ja
  -- exista em `agente_funcao_chamadas`. Como a chave de pagina e
  -- derivada da chave da TENTATIVA e a abertura da acao vem ANTES da
  -- pagina 1, uma repeticao da mesma tentativa colide primeiro no indice
  -- `idx_agente_acao_execucoes_tentativa` — e sem chave de tentativa
  -- nao ha chave de pagina, entao a colisao de Funcao nem pode nascer.
  -- Se ainda assim aparecer, o invariante quebrou: `erro_interno`, que e
  -- fail-closed, e nunca silencio.
  --
  -- `aprovacao_indisponivel`: so nasce em `retomarAprovacao`, e este
  -- servico chama `executarFuncao`. O ramo existe no `switch` por
  -- exaustividade de tipo, nao por alcance.
  -- ── `is not null and` NAO e redundancia ───────────────────────────
  --
  -- CHECK aceita TRUE **e NULL**. `codigo_desfecho in ('a','b')` com a
  -- coluna nula avalia NULL, entao um `erro` sem codigo passaria em
  -- silencio — exatamente a linha que nao explica nada. O `is not null`
  -- explicito e o que torna o codigo OBRIGATORIO onde ele deve existir.
  -- Provado em runtime: secao V do teste de banco.
  constraint agente_acao_execucoes_codigo_por_status
    check (
      case status
        when 'executando' then codigo_desfecho is null
        when 'sucesso'    then codigo_desfecho is null
        when 'parcial'    then codigo_desfecho is not null
                              and codigo_desfecho in (
                                 'backlog_truncado',
                                 'descartes_na_varredura',
                                 'auditoria_funcao_incompleta')
        when 'aguardando_aprovacao' then codigo_desfecho is not null
                              and codigo_desfecho = 'aprovacao_necessaria'
        when 'negado'     then codigo_desfecho is not null
                              and codigo_desfecho in (
                                 'funcao_inexistente',
                                 'permissao_ausente',
                                 'permissao_bloqueada',
                                 'conexao_ausente')
        when 'erro'       then codigo_desfecho is not null
                              and codigo_desfecho in (
                                 'provedor_falhou',
                                 'contrato_violado',
                                 'autoridade_divergente',
                                 'autoridade_indisponivel',
                                 'persistencia_negada',
                                 'persistencia_recusada',
                                 'persistencia_falhou',
                                 'auditoria_funcao_falhou',
                                 'orcamento_esgotado',
                                 'erro_interno')
      end
    ),

  -- Mensagem so onde ela explica algo. Sucesso limpo nao tem o que
  -- explicar, e abertura ainda nao sabe de nada.
  constraint agente_acao_execucoes_mensagem_so_em_desfecho_explicado
    check (mensagem_desfecho is null
           or status not in ('executando', 'sucesso')),
  -- Mesmo teto de `agente_funcao_chamadas`: mensagem e resumo, nao
  -- transcricao. 300 e o suficiente para dizer o que houve sem virar
  -- deposito de corpo de resposta alheia.
  constraint agente_acao_execucoes_mensagem_truncada
    check (mensagem_desfecho is null or length(mensagem_desfecho) <= 300),

  -- Abertura nao tem latencia porque nada terminou.
  constraint agente_acao_execucoes_latencia_coerente
    check (
      (fase = 'abertura' and latencia_ms is null)
      or (fase = 'desfecho' and (latencia_ms is null or latencia_ms >= 0))
    ),

  -- ── A chave da tentativa e OBRIGATORIA na abertura ────────────────
  --
  -- Sem ela o indice unico parcial nao cobriria a linha, e a mesma
  -- tentativa poderia abrir a varredura duas vezes. Fail-closed: uma
  -- acao sem identidade de tentativa nao entra.
  constraint agente_acao_execucoes_abertura_exige_chave
    check (fase = 'desfecho' or idempotency_key is not null),

  -- Escalares apenas. O `jsonb_typeof` e a mesma guarda que
  -- `estudio_anuncios_resultados_pipeline` e `compliance_marketplace`
  -- ja usam: array ou string aqui seria payload disfarcado de resumo.
  constraint agente_acao_execucoes_resumo_objeto
    check (jsonb_typeof(entrada_resumo) = 'object')
);

-- ── Uma tentativa abre UMA vez ───────────────────────────────────────
--
-- Parcial nos dois eixos: so aberturas, so com chave. E a garantia do
-- BANCO, nao um `select` antes do `insert` — duas sessoes simultaneas
-- com a mesma tentativa produzem uma vencedora e uma violacao de
-- unicidade, nunca duas varreduras.
create unique index idx_agente_acao_execucoes_tentativa
  on public.agente_acao_execucoes (user_id, acao_id, idempotency_key)
  where fase = 'abertura' and idempotency_key is not null;

-- ── Uma execucao tem UM desfecho, e UMA abertura ─────────────────────
--
-- Dois desfechos para o mesmo `request_id` seriam duas verdades sobre o
-- mesmo fato. Os dois indices tambem sao o que torna barata a busca por
-- ORFAS: abertura sem desfecho correspondente e um anti-join por
-- (user_id, request_id), e os dois lados estao indexados.
create unique index idx_agente_acao_execucoes_abertura_unica
  on public.agente_acao_execucoes (user_id, request_id)
  where fase = 'abertura';

create unique index idx_agente_acao_execucoes_desfecho_unico
  on public.agente_acao_execucoes (user_id, request_id)
  where fase = 'desfecho';

-- Leitura por dono e por agente, sempre do mais recente para o mais
-- antigo — a unica ordem em que alguem olha auditoria.
create index idx_agente_acao_execucoes_user_data
  on public.agente_acao_execucoes (user_id, criado_em desc);

create index idx_agente_acao_execucoes_agente_data
  on public.agente_acao_execucoes (agente_id, criado_em desc);

comment on table public.agente_acao_execucoes is
  'Ciclo de vida DURAVEL de uma ACAO de dominio, append-only, em duas linhas: abertura (fase=abertura, status=executando) e desfecho (fase=desfecho). NAO e auditoria de Funcao — `agente_funcao_chamadas` continua registrando cada execucao de Funcao, e uma acao de N paginas produz 1 abertura de acao + N aberturas de Funcao. `acao_id` e vocabulario de produto e seu formato PROIBE ponto, enquanto o de Funcao o EXIGE: os dois conjuntos sao disjuntos. `loja_id` e NULL na abertura porque a conta autoritativa so existe depois da primeira execucao de Funcao; exigi-la antes obrigaria a uma segunda resolucao de binding. `idempotency_key` e a chave da TENTATIVA e prefixa as chaves de pagina, ligando a acao as Funcoes sem guardar identificador de negocio. `entrada_resumo` guarda SOMENTE escalares.';

comment on column public.agente_acao_execucoes.loja_id is
  'NULL ate a primeira execucao de Funcao estabelecer a conta autoritativa da varredura. Nunca resolvido por conta propria.';

comment on column public.agente_acao_execucoes.status is
  'Vocabulario FECHADO de seis estados. `executando` so na abertura (bicondicional com `fase`). `negado` e `aguardando_aprovacao` implicam que o provider NUNCA foi chamado: os dois nascem do guard de permissao, antes de qualquer ida ao marketplace. Recusa posterior a trabalho externo — a inbox recusando a gravacao, por exemplo — e `erro` com codigo proprio. `parcial` existe para que varredura incompleta nunca precise se passar por `sucesso`.';

comment on column public.agente_acao_execucoes.codigo_desfecho is
  'NULL em `executando` e em `sucesso` limpo. Nos demais, um codigo do conjunto fechado do status. Os de `negado` sao exatamente os de `CodigoNegacaoTerminal` no guard, adotados inteiros e nao traduzidos. Detalhe que nao classifica — SQLSTATE da RPC, codigo do provider — vai em `mensagem_desfecho`, nunca aqui.';

comment on column public.agente_acao_execucoes.idempotency_key is
  'Chave da TENTATIVA. Obrigatoria na abertura; prefixo das chaves de pagina em agente_funcao_chamadas.';

comment on column public.agente_acao_execucoes.entrada_resumo is
  'Metricas escalares da varredura. Nunca texto de pergunta, id externo, payload do provider ou credencial.';

-- ── Privilegios ──────────────────────────────────────────────────────
--
-- Os REVOKE nominais nao sao redundancia de `from public`: `PUBLIC` e
-- pseudo-role distinto de `anon` e `authenticated`, e este projeto tem
-- `ALTER DEFAULT PRIVILEGES` concedendo privilegio a eles em objeto
-- novo. Foi o que causou o bug SEC1.
revoke all on table public.agente_acao_execucoes from public;
revoke all on table public.agente_acao_execucoes from anon;
revoke all on table public.agente_acao_execucoes from authenticated;
revoke all on table public.agente_acao_execucoes from service_role;

-- SELECT e INSERT, nada mais: auditoria que pode ser reescrita nao e
-- auditoria. Corrigir um desfecho e acrescentar linha, nunca apagar.
grant select, insert on table public.agente_acao_execucoes to service_role;

-- Cinto e suspensorio, como em `agentes_ia_chamadas`: se um GRANT
-- futuro reintroduzir escrita por descuido, estes REVOKE a tiram.
revoke update, delete, truncate on table public.agente_acao_execucoes from service_role;
