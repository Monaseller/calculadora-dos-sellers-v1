-- APPROVAL-DECISION-RESUME-D5-C3-I2-P0 — fila e reconciliacao da retomada.
--
-- ════════════════════════════════════════════════════════════════════
-- O BURACO QUE ESTA MIGRATION FECHA
-- ════════════════════════════════════════════════════════════════════
--
-- O executor de retomada ja existe e esta publicado, mas dormente: nada
-- em producao o alcanca. Para liga-lo falta um orquestrador, e o
-- orquestrador precisa de DUAS coisas que o repositorio nao tem.
--
-- ── 1. Uma fila que nao possa ser monopolizada ──────────────────────
--
-- A fila de candidatas e ordenada por `decidido_em` e lida com LIMIT.
-- Se a elegibilidade fosse resolvida DEPOIS do LIMIT — em TypeScript,
-- sobre linhas ja lidas —, um punhado de aprovacoes inelegiveis no topo
-- esconderia para sempre a aprovacao valida na posicao seguinte. Nao e
-- hipotese: com dois slots de retomada por rodada, bastam DUAS linhas
-- presas no topo para que a terceira nunca seja alcancada.
--
-- A correcao e estrutural, nao de tamanho de lote: tudo que e ESTADO DE
-- BANCO e reversivel — permissao revogada, agente desativado, tarefa que
-- saiu da espera — e filtrado AQUI, antes do LIMIT. Linha filtrada nao
-- ocupa vaga, logo nao precisa de progresso: quando a condicao reverter,
-- ela volta a aparecer sozinha, sem que nada tenha sido escrito.
--
-- ── 2. Uma saida duravel para o que nunca mais vai executar ─────────
--
-- Nem toda incompatibilidade e estado de banco. Revisao de catalogo,
-- funcao removida, acesso divergente e argumento que o validador atual
-- recusa sao decisoes do TypeScript, e nenhuma delas e expressavel em
-- SQL sem copiar o registry para ca — a segunda fonte de verdade que
-- este repositorio ja pagou caro para evitar.
--
-- Essas linhas PRECISAM continuar aparecendo na fila: e o orquestrador
-- que as reconhece. O que faltava era o que fazer depois. Sem uma saida
-- duravel elas ficam `aprovada` para sempre, porque o proprio pre-read
-- as recusa ANTES do inicio — e sem inicio nem o TTL e materializado.
--
-- Dai a segunda funcao: cancelamento TECNICO, distinto da decisao
-- humana, que tira a linha da fila de vez.
--
-- ════════════════════════════════════════════════════════════════════
-- O QUE ESTA MIGRATION NAO FAZ
-- ════════════════════════════════════════════════════════════════════
--
-- Nao cria tabela, coluna, indice, view, trigger, rule, FK nem CHECK.
-- Nao altera nenhuma funcao existente — em particular
-- `aprovacao_decidir`, que continua sendo a UNICA porta da decisao
-- humana e cuja assinatura, corpo e privilegios ficam intactos.
-- Nao executa DML no momento do apply: aplicar esta migration nao muda
-- uma linha de dado sequer.
-- Nao tem chamador. As duas funcoes nascem DORMENTES.

-- ─── 1. A fila de candidatas ─────────────────────────────────────────
--
-- ── Por que ela e READ-ONLY, e por que isso basta ───────────────────
--
-- Sem lock, sem lease, sem `SKIP LOCKED`, sem marcar nada. Dois workers
-- podem receber a MESMA candidata, e isso e seguro: quem decide e o
-- `retomar_aprovacao_iniciar`, que trava a aprovacao e so consome se ela
-- ainda estiver `aprovada`. O segundo recebe `ja_consumida`, e a Funcao
-- roda no maximo uma vez. Resolver concorrencia aqui seria reimplementar
-- pior o que a RPC transacional ja garante.
--
-- ── O que ela deliberadamente NAO filtra ────────────────────────────
--
--   expira_em       o TTL e materializado pela RPC de inicio, sob lock,
--                   com o relogio do banco. Filtrar aqui esconderia a
--                   vencida da tentativa que a materializaria — e ela
--                   ficaria `aprovada` sem nunca expirar de fato.
--
--   tipo da tarefa  o registry de contratos vive em TypeScript.
--   funcao          Esta funcao nao sabe qual revisao esta publicada,
--   revisao         nao sabe rodar `validarEntrada` e nao conhece o
--   acesso          catalogo. Filtrar por isso exigiria receber o
--   conexao         registry como parametro e mante-lo em concordancia
--   argumentos      para sempre.
--
-- E ha um motivo mais forte que a duplicacao: essas linhas PRECISAM
-- chegar ao orquestrador. Sao elas que o cancelamento tecnico existe
-- para remover. Filtra-las aqui deixaria a fila limpa e a tabela suja.

create function public.retomada_listar_candidatas(
  p_limite integer default 5
)
returns table (
  user_id text,
  aprovacao_id uuid
)
language plpgsql
security invoker
set search_path = public
as $$
begin
  return query
  select a.user_id, a.id
  from public.agente_funcao_aprovacoes a
  -- A tarefa causal, com as MESMAS cercas que o bloco de retomada de
  -- `aprovacao_consumir_abrir_e_retomar` aplica sob lock. Aqui elas sao
  -- heuristica: o que vale e o recheck transacional. Mas mante-las
  -- identicas evita oferecer candidata que o inicio ja sabe recusar.
  join public.agente_tarefas t
    on  t.id                     = a.tarefa_id
    and t.user_id                = a.user_id
    and t.agente_id              = a.agente_id
    and t.status                 = 'aguardando_aprovacao'
    and t.aprovacao_aguardada_id = a.id
    and t.retomada_request_id is null
    -- `<=`, nunca `<`: a tarefa que pausou na ultima tentativa foi
    -- aprovada por um humano e tem de poder retomar a MESMA tentativa.
    and t.tentativas            <= t.max_tentativas
  join public.agentes ag
    on  ag.id      = a.agente_id
    and ag.user_id = a.user_id
    and ag.ativo
  -- Permissao ATUAL, nao a do instante da aprovacao. `automatico` segue,
  -- pela mesma razao do inicio: a autoridade so ficou mais permissiva.
  -- `bloqueado` e ausente somem da fila sem que nada seja escrito — se o
  -- dono devolver a permissao, a linha reaparece sozinha.
  join public.agente_permissoes p
    on  p.agente_id = a.agente_id
    and p.funcao_id = a.funcao_id
    and p.nivel in ('aprovacao', 'automatico')
  where a.estado    = 'aprovada'
    and a.tarefa_id is not null
  -- Ordem de chegada da DECISAO, nao da criacao: quem foi aprovado
  -- primeiro retoma primeiro. `id` desempata para que duas leituras do
  -- mesmo instante nao alternem a ordem.
  order by a.decidido_em asc, a.id asc
  -- O teto vive AQUI, e nao no chamador. Um caller futuro pedindo 500
  -- recebe 5; `null` vira 5; zero e negativo viram 1. `integer` nao
  -- aceita NaN nem Infinity, entao a faixa e sempre 1..5.
  limit least(greatest(coalesce(p_limite, 5), 1), 5);
end;
$$;

comment on function public.retomada_listar_candidatas(integer) is
  'Fila READ-ONLY de aprovacoes candidatas a retomada, mais antigas primeiro por decidido_em/id, com teto de 5 imposto no proprio SQL. Filtra SOMENTE estado de banco reversivel — aprovacao aprovada com tarefa, tarefa causal esperando com ponteiro certo e sem marcador, tentativa dentro do limite, agente ativo e permissao atual em aprovacao/automatico — para que nenhuma dessas condicoes ocupe vaga na fila e todas voltem sozinhas quando reverterem. NAO filtra TTL nem nada do registry TypeScript (tipo, funcao, revisao, acesso, conexao, argumentos): essas candidatas PRECISAM ser devolvidas para que o orquestrador as classifique e, quando forem incompativeis de forma permanente, as reconcilie. Nao trava, nao reserva e nao escreve; candidata duplicada entre workers e segura porque o inicio e atomico.';

revoke all on function public.retomada_listar_candidatas(integer) from public;
revoke all on function public.retomada_listar_candidatas(integer) from anon;
revoke all on function public.retomada_listar_candidatas(integer) from authenticated;
revoke all on function public.retomada_listar_candidatas(integer) from service_role;
grant execute on function public.retomada_listar_candidatas(integer) to service_role;

-- ─── 2. Reconciliacao tecnica ────────────────────────────────────────
--
-- ── Por que NAO e `aprovacao_decidir` ───────────────────────────────
--
-- Aquela funcao ja sabe cancelar uma aprovacao aprovada e encerrar a
-- tarefa causal, e seria tentador reusa-la. Mas ela grava
-- `cancelado_por = p_user_id`, e `cancelado_por` significa QUEM
-- CANCELOU — o proprio schema diz isso ao separar o par do
-- `decidido_*`. Chamar de la com o dono registraria que o DONO cancelou
-- uma acao que ele nunca tocou. Log de aplicacao nao corrige dado
-- persistido.
--
-- Aqui `p_user_id` e CERCA DE POSSE e nada mais. O ator e constante
-- desta funcao, e nenhum chamador pode forja-lo: nao existe parametro
-- para isso.
--
-- ── O que ela NAO decide ────────────────────────────────────────────
--
-- Ela nao sabe POR QUE a aprovacao e incompativel. Revisao divergente,
-- funcao removida, argumento invalido — tudo isso e classificado em
-- TypeScript, contra o registry. Esta funcao recebe a conclusao e a
-- materializa; dar-lhe o julgamento seria copiar o catalogo para o SQL.
--
-- ── O que ela NAO faz ───────────────────────────────────────────────
--
-- Nao abre nem fecha Tool Call: a reconciliacao acontece ANTES de
-- qualquer inicio, entao nao ha chamada para registrar. Nao toca
-- `tentativas` nem `progresso` — a tarefa cancelada preserva o que ja
-- havia andado. Nao reexecuta nada.

create function public.retomada_cancelar_aprovacao_incompativel(
  p_user_id text,
  p_aprovacao_id uuid
)
returns text
language plpgsql
security invoker
set search_path = public
as $$
declare
  -- O ator tecnico. Constante, e nao parametro: quem chama nao escolhe
  -- em nome de quem a linha e cancelada. O prefixo `sistema:` marca a
  -- origem de maquina e nao se confunde com id de usuario nem e-mail.
  v_ator_tecnico constant text := 'sistema:reconciliador-retomada';
  ap public.agente_funcao_aprovacoes%rowtype;
  v_tarefa_id uuid;
  v_afetadas int;
begin
  if p_user_id is null or btrim(p_user_id) = '' or p_aprovacao_id is null then
    return 'aprovacao_inexistente';
  end if;

  -- 1. Expiracao materializada antes de qualquer prova, exatamente como
  --    no inicio e na decisao. O TTL e um fato temporal e tem
  --    precedencia: uma aprovacao genuinamente vencida vira `expirada`,
  --    nunca `cancelada`. Nao ha segunda definicao de tempo aqui — o
  --    relogio e o do banco, na mesma transacao.
  update public.agente_funcao_aprovacoes
     set estado = 'expirada'
   where id       = p_aprovacao_id
     and user_id  = p_user_id
     and estado in ('pendente', 'aprovada')
     and expira_em <= now();

  -- 2. Trava a linha. Ordem de lock congelada do D4: aprovacao ANTES da
  --    tarefa, nunca o inverso.
  select * into ap
  from public.agente_funcao_aprovacoes a
  where a.id = p_aprovacao_id and a.user_id = p_user_id
  for update;

  -- Inexistente e de outro dono chegam iguais: o filtro ja escopou por
  -- `user_id`, e distinguir os dois seria um oraculo de existencia de
  -- recurso alheio.
  if not found then return 'aprovacao_inexistente'; end if;

  -- 3. Estados ja resolvidos saem ANTES de olhar a tarefa, para que
  --    `tarefa_incompativel` nunca mascare um estado ja decidido. Mesma
  --    disciplina do D4.
  if ap.estado = 'cancelada' then return 'ja_cancelada';       end if;
  if ap.estado = 'consumida' then return 'ja_consumida';       end if;
  if ap.estado = 'rejeitada' then return 'ja_rejeitada';       end if;
  if ap.estado = 'expirada'  then return 'expirada';           end if;
  if ap.estado = 'pendente'  then return 'aprovacao_pendente'; end if;

  -- 4. So `aprovada` continua. Reconciliacao tecnica nao decide sobre o
  --    estado zero: uma pendente ainda espera um humano.

  --    O `if` abaixo nao cria dominio novo nem codigo de retorno: os
  --    cinco estados conhecidos ja sairam acima, e `aprovada` e o unico
  --    que pode seguir. Ele existe para que um SETIMO estado, aceito por
  --    uma migration futura no CHECK da tabela, PARE aqui em vez de cair
  --    no cancelamento por omissao. Hoje e inalcancavel — `estado` e NOT
  --    NULL e o CHECK fecha em seis valores —, e e por isso que custa
  --    barato deixa-lo: o fail-closed passa a ser local, e nao emprestado
  --    de uma constraint que vive em outro arquivo.
  --
  --    Mensagem sem valor dinamico: nem o estado entra nela. Quem precisa
  --    saber qual estado apareceu tem a linha no banco; o erro so precisa
  --    dizer que o dominio foi violado.
  if ap.estado <> 'aprovada' then
    raise exception
      'retomada_cancelar_aprovacao_incompativel: estado de aprovacao fora do dominio conhecido'
      using errcode = '55000';
  end if;

  -- 5. A tarefa causal, com a causalidade INTEIRA. Cancelar a aprovacao
  --    sem a tarefa — ou a tarefa errada — quebraria o vinculo que a FK
  --    causal existe para sustentar.
  --
  --    `tentativas <= max_tentativas` NAO entra: a tarefa ja esta parada
  --    esperando, e exigir a folga aqui recusaria reconciliar exatamente
  --    a linha que mais precisa sair da fila.
  select t.id into v_tarefa_id
  from public.agente_tarefas t
  where t.id                     = ap.tarefa_id
    and t.user_id                = ap.user_id
    and t.agente_id              = ap.agente_id
    and t.status                 = 'aguardando_aprovacao'
    and t.aprovacao_aguardada_id = ap.id
    and t.retomada_request_id is null
  for update of t;

  -- Sem tarefa casando, NADA e escrito — nem na aprovacao. Uma aprovacao
  -- cancelada sem a tarefa correspondente deixaria a tarefa esperando um
  -- ponteiro morto.
  if not found then return 'tarefa_incompativel'; end if;

  -- 6. Escritas. As duas na MESMA transacao: nao existe meio caminho.
  update public.agente_tarefas
     set status                 = 'cancelado',
         aprovacao_aguardada_id = null,
         heartbeat_em           = null,
         concluido_em           = now(),
         resultado              = null,
         erro_tipo              = null,
         erro_mensagem          = null
   where id = v_tarefa_id;

  get diagnostics v_afetadas = row_count;
  if v_afetadas <> 1 then
    raise exception
      'retomada_cancelar_aprovacao_incompativel: encerrar tarefa % afetou % linhas sob lock',
      v_tarefa_id, v_afetadas using errcode = '55000';
  end if;

  -- `decidido_por` e `decidido_em` NAO sao tocados: quem aprovou
  -- continua registrado, e e por isso que o cancelamento tem par
  -- proprio. `motivo_recusa` segue nulo — o CHECK so o admite em
  -- `rejeitada`, e este cancelamento nao e recusa humana.
  update public.agente_funcao_aprovacoes
     set estado        = 'cancelada',
         cancelado_por = v_ator_tecnico,
         cancelado_em  = now()
   where id = ap.id
     and estado = 'aprovada';

  get diagnostics v_afetadas = row_count;
  if v_afetadas <> 1 then
    raise exception
      'retomada_cancelar_aprovacao_incompativel: cancelar % afetou % linhas sob lock',
      ap.id, v_afetadas using errcode = '55000';
  end if;

  return 'cancelada';
end;
$$;

comment on function public.retomada_cancelar_aprovacao_incompativel(text, uuid) is
  'Reconciliacao TECNICA: encerra uma aprovacao que o software atual nunca mais conseguira executar — revisao divergente, funcao removida, acesso ou contrato de conexao incompativel, argumento que o validador atual recusa — e a tarefa causal junto. NAO e decisao humana: `p_user_id` e apenas cerca de posse, e `cancelado_por` recebe o ator tecnico constante desta funcao, preservando `decidido_por`/`decidido_em` de quem aprovou. Nao julga a incompatibilidade: quem classifica e o TypeScript, contra o registry. TTL tem precedencia e e materializado primeiro, entao aprovacao vencida vira expirada e nunca cancelada. Trava aprovacao e depois tarefa, resolve estados ja decididos antes de olhar a tarefa, e com causalidade divergente devolve tarefa_incompativel SEM escrever nada. Cancela aprovacao e tarefa atomicamente, com ponteiro NULL, heartbeat zerado e concluido_em carimbado, preservando tentativas e progresso. NAO cria, fecha nem le Tool Call, NAO consome aprovacao e NAO executa Funcao.';

revoke all on function public.retomada_cancelar_aprovacao_incompativel(text, uuid) from public;
revoke all on function public.retomada_cancelar_aprovacao_incompativel(text, uuid) from anon;
revoke all on function public.retomada_cancelar_aprovacao_incompativel(text, uuid) from authenticated;
revoke all on function public.retomada_cancelar_aprovacao_incompativel(text, uuid) from service_role;
grant execute on function public.retomada_cancelar_aprovacao_incompativel(text, uuid) to service_role;
