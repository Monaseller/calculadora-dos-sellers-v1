-- ══════════════════════════════════════════════════════════════════════
-- APPROVAL-DECISION-RESUME-D1 — de quem, exatamente, esta tarefa espera.
--
-- Uma tarefa em `aguardando_aprovacao` nao diz hoje o que esta
-- esperando. A unica ligacao duravel e o caminho inverso —
-- `agente_funcao_aprovacoes.tarefa_id` — e ele NAO identifica: o unico
-- indice unico sobre estado ativo e `(user_id, fingerprint)`, e o
-- fingerprint cobre uma ACAO (funcao, revisao, loja, argumentos), nao
-- uma tarefa. Duas aprovacoes ativas para a mesma tarefa sao possiveis
-- sempre que a acao difere.
--
-- O `aprovacaoId` existe no momento da pausa — `executarFuncao` o
-- devolve, o handler o carrega em `PausaPorAprovacao` e o executor o tem
-- no `catch`. Ele e descartado ali, de proposito, porque nao havia onde
-- guarda-lo. Esta migration cria esse lugar.
--
-- ── Por que um ponteiro, e nao um indice unico por tarefa ────────────
--
-- A alternativa era proibir, por constraint, mais de uma aprovacao ativa
-- por tarefa, e deduzir a causalidade da unicidade. Funciona hoje, mas a
-- conclusao passa a depender de um argumento sobre o sistema inteiro —
-- "nada mais consegue criar aprovacao ativa enquanto a tarefa esta
-- parada" — que precisaria ser refeito a cada handler, rota ou entrada
-- nova. O ponteiro troca esse argumento por uma igualdade entre dois
-- valores gravados.
--
-- ── O que o ponteiro significa, e o que NAO significa ────────────────
--
--     "esta tarefa esta AGORA estacionada aguardando ESTA aprovacao"
--
-- Nao significa "esta tarefa foi retomada a partir desta aprovacao".
-- Assim que a posse passa a um executor, o fato deixa de ser verdadeiro
-- e a coluna volta a NULL. Por isso o CHECK abaixo proibe ponteiro fora
-- de `aguardando_aprovacao`: quem esta `rodando` tem dono, e o dono e
-- identificado pela tentativa, nao por um ponteiro residual.
--
-- ── Esta fase e ADITIVA, e o caller continua o antigo ────────────────
--
-- A RPC de pausa ganha um OVERLOAD de tres argumentos. A de dois
-- continua viva, concedida e em uso: producao so passa a enviar o
-- terceiro parametro num gate proprio, depois deste ser publicado. E a
-- ordem que o rollout do fencing por tentativa ja provou duas vezes —
-- aditiva, cutover, limpeza —, e a unica em que producao e banco nunca
-- discordam no meio do caminho.
--
-- Sem DEFAULT no parametro novo, pelo mesmo motivo de la: o PostgREST
-- resolve overload pelo CONJUNTO DE CHAVES do corpo, e um DEFAULT faria
-- o payload de duas chaves casar as duas assinaturas.
--
-- ── Compatibilidade com o que ja esta parado ─────────────────────────
--
-- Existem tarefas em `aguardando_aprovacao` criadas antes desta coluna.
-- Elas ficam com ponteiro NULL e NAO sao corrigidas aqui: nao ha
-- backfill, porque derivar o ponteiro por `tarefa_id` seria justamente a
-- inferencia ambigua que esta migration existe para eliminar. O CHECK e
-- meio-lado de proposito — proibe ponteiro fora da espera, mas nao exige
-- ponteiro na espera. Consequencia declarada: essas tarefas legadas
-- falham FECHADO em todo caminho futuro (nunca retomadas, nunca
-- canceladas por aprovacao inferida), nunca erram de alvo.
--
-- ── Estritamente aditiva, e APPLY UNICO ─────────────────────────────
--
-- Nenhum statement remove nada: nem funcao, nem tabela, nem coluna, nem
-- indice, nem CONSTRAINT. E nenhum statement REUTILIZA nem SUBSTITUI
-- objeto que ja exista: a coluna entra por `add column` sem `if not
-- exists`, a funcao por `create function` sem `or replace`, e as tres
-- constraints por `add constraint` sem `drop` antes.
--
-- As tres formas evitadas — `drop ... if exists`, `if not exists` e `or
-- replace` — parecem cuidados de reexecucao e sao, na verdade, a mesma
-- decisao tomada as cegas: diante de um objeto inesperado, uma apaga,
-- outra adota e a terceira sobrescreve. Este arquivo NAO consulta o
-- catalogo; ele nao tem como saber o que encontraria. Entao a unica
-- resposta honesta a uma colisao e ABORTAR e alguem olhar.
--
-- O contrato, portanto: migration de APPLY UNICO, colisao inesperada e
-- falha de precondicao, e a conferencia dos nomes no catalogo vivo
-- pertence ao gate de apply — nao a uma afirmacao feita aqui.
--
-- DDL no PostgreSQL e transacional. Com a migration aplicada numa
-- transacao, uma colisao em qualquer statement reverte o arquivo
-- inteiro; e mesmo sem isso, os REVOKE/GRANT do fim nunca alcancam uma
-- funcao preexistente, porque o `create function` que os precede ja
-- teria abortado.
--
-- Nenhum DML. Nenhum backfill. Nenhuma RPC existente alterada.
-- ══════════════════════════════════════════════════════════════════════


-- ── 1. A UNIQUE que torna a FK composta possivel ──────────────────────
--
-- `agente_funcao_aprovacoes` so tem `PRIMARY KEY (id)`, e FK composta
-- exige UNIQUE sobre o par. Como `id` ja e unico, a constraint e
-- trivialmente satisfeita e custa um indice — mesmo movimento que a
-- 20260927 fez em `agente_tarefas` para poder apontar tenant-safe.
--
-- Sem ela o ponteiro so poderia ter FK SIMPLES, e uma tarefa poderia
-- apontar para a aprovacao de OUTRO dono sem o banco reclamar.
--
-- Sem pre-drop: colisao de nome aborta o apply, e e isso que queremos.
alter table public.agente_funcao_aprovacoes
  add constraint agente_funcao_aprovacoes_id_por_dono unique (id, user_id);


-- ── 2. A coluna ───────────────────────────────────────────────────────
--
-- `NULL` e o estado de quase toda linha: so tarefa parada aponta. Sem
-- DEFAULT — um default aqui inventaria espera onde nao ha. E sem `if
-- not exists`: uma coluna com este nome que ja estivesse la seria de
-- outra pessoa, com outro tipo e outro significado, e adota-la em
-- silencio e pior que parar.
alter table public.agente_tarefas
  add column aprovacao_aguardada_id uuid null;


-- ── 3. A FK composta, RESTRICT nos dois lados ─────────────────────────
--
-- `(ponteiro, user_id)` contra `(id, user_id)`: aponta para aprovacao do
-- MESMO dono, provado pelo banco e nao pela aplicacao.
--
-- Sem CASCADE, e sem `SET NULL`. Apagar uma aprovacao apontada tem de
-- falhar fechado e nomear quem aponta; limpar o ponteiro e decisao de
-- ciclo de vida da aplicacao — reject, expiracao e claim de retomada
-- fazem isso explicitamente, cada um com o proprio fence. Um `SET NULL`
-- automatico desestacionaria uma tarefa sem que ninguem tivesse decidido
-- nada.
--
-- Isto cria um ciclo de FK com `agente_funcao_aprovacoes.tarefa_id`, e
-- ele e seguro porque os dois lados sao NULLABLE: a tarefa nasce
-- primeiro, a aprovacao depois, e o ponteiro e gravado por UPDATE. O
-- ciclo nunca e percorrido numa insercao. O efeito pratico e na ordem de
-- remocao — limpar ponteiro, remover aprovacoes, remover tarefa — e sob
-- este desenho isso so alcanca tarefas PARADAS, porque tarefa terminal
-- sempre tem ponteiro NULL.
alter table public.agente_tarefas
  add constraint agente_tarefas_aprovacao_do_mesmo_dono
  foreign key (aprovacao_aguardada_id, user_id)
  references public.agente_funcao_aprovacoes (id, user_id)
  on update restrict on delete restrict;


-- ── 4. O CHECK meio-lado ──────────────────────────────────────────────
--
-- Proibe ponteiro fora de `aguardando_aprovacao`. NAO exige ponteiro
-- dentro dela — ver a nota sobre tarefas legadas no cabecalho.
--
-- A promocao para bicondicional
--
--     (status = 'aguardando_aprovacao') = (aprovacao_aguardada_id IS NOT NULL)
--
-- depende de tres coisas, nesta ordem: o caller novo publicado e provado
-- em runtime; o overload de dois argumentos removido, de modo que
-- nenhuma espera nova possa nascer sem ponteiro; e disposicao explicita
-- das esperas legadas. Nao e deste gate.
alter table public.agente_tarefas
  add constraint agente_tarefas_ponteiro_so_na_espera
  check (status = 'aguardando_aprovacao' or aprovacao_aguardada_id is null);


-- ── 5. A pausa, com a aprovacao revalidada ────────────────────────────
--
-- OVERLOAD. A versao de dois argumentos continua existindo, concedida e
-- chamada por producao; esta migration nao a dropa, nao a altera e nao
-- mexe nos privilegios dela.
--
-- ── Por que EXISTS, e por que SEM `FOR UPDATE` ───────────────────────
--
-- A aprovacao e revalidada aqui, nao confiada: quem chama passa um id, e
-- o banco confere que ele pertence ao mesmo dono, ao mesmo agente e A
-- ESTA TAREFA, e que ainda esta ativo. Mas a leitura e MVCC pura.
--
-- Isso e regra, nao preferencia. As primitivas de aprovacao ja
-- publicadas travam a APROVACAO primeiro e so depois leem a tarefa
-- (`aprovacao_decidir`, `aprovacao_consumir_e_abrir`). Esta RPC comeca
-- pela TAREFA. Se ela tambem travasse a aprovacao, a ordem seria
-- Tarefa -> Aprovacao e teriamos inversao de lock contra as que ja estao
-- em producao. Por isso: nenhum `FOR UPDATE`, `FOR SHARE`,
-- `FOR NO KEY UPDATE` ou `FOR KEY SHARE` na subconsulta.
--
-- O preco da leitura sem lock e uma corrida estreita: entre o EXISTS e o
-- COMMIT, um humano pode recusar a aprovacao, e a tarefa estaciona
-- apontando para uma linha ja decidida. Ela nao fica perdida — o
-- lifecycle de expiracao/invalidacao reconhece ponteiro em estado
-- terminal e encerra a tarefa. Pagar esse preco e mais barato que
-- inverter a ordem de lock do sistema inteiro.
--
-- `create function`, e nao `create or replace`: a assinatura de tres
-- argumentos nao existe hoje. Se existisse, seria de outra pessoa, com
-- outro corpo, e sobrescreve-la sem ler seria trocar comportamento que
-- ninguem inspecionou. Colisao aqui e falha de precondicao.
create function public.aguardar_aprovacao_tarefa(
  p_tarefa_id          uuid,
  p_tentativa_esperada integer,
  p_aprovacao_id       uuid
)
returns public.agente_tarefas
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_tarefa public.agente_tarefas;
begin
  if p_tarefa_id is null then
    raise exception 'aguardar_aprovacao_tarefa: p_tarefa_id e obrigatorio'
      using errcode = '22023';
  end if;
  if p_tentativa_esperada is null then
    raise exception 'aguardar_aprovacao_tarefa: p_tentativa_esperada e obrigatorio'
      using errcode = '22023';
  end if;
  if p_aprovacao_id is null then
    raise exception 'aguardar_aprovacao_tarefa: p_aprovacao_id e obrigatorio'
      using errcode = '22023';
  end if;

  -- Status, tentativa e ponteiro num UPDATE so. O ponteiro NAO pode ser
  -- gravado antes nem depois: se nascesse antes, existiria um instante
  -- com tarefa `rodando` apontando para aprovacao — exatamente o que o
  -- CHECK proibe; se nascesse depois, haveria espera sem ponteiro, que e
  -- o estado legado que estamos deixando de produzir.
  update public.agente_tarefas t
  set status                 = 'aguardando_aprovacao',
      heartbeat_em           = null,
      resultado              = null,
      erro_tipo              = null,
      erro_mensagem          = null,
      concluido_em           = null,
      aprovacao_aguardada_id = p_aprovacao_id
  where t.id         = p_tarefa_id
    and t.status     = 'rodando'
    and t.tentativas = p_tentativa_esperada
    and exists (
      select 1
      from public.agente_funcao_aprovacoes a
      where a.id        = p_aprovacao_id
        and a.user_id   = t.user_id
        and a.agente_id = t.agente_id
        and a.tarefa_id = t.id
        and a.estado in ('pendente', 'aprovada')
        and a.expira_em > now()
    )
  returning t.* into v_tarefa;

  if not found then
    -- Diagnostico que separa as duas recusas. Sem isto, uma aprovacao de
    -- outra tarefa e uma tentativa defasada devolveriam a mesma frase, e
    -- quem investiga nao saberia onde olhar. Somente ids viajam na
    -- mensagem.
    if not exists (
      select 1 from public.agente_tarefas t
      where t.id = p_tarefa_id
        and t.status = 'rodando'
        and t.tentativas = p_tentativa_esperada
    ) then
      raise exception
        'aguardar_aprovacao_tarefa: tarefa % nao esta em rodando na tentativa %',
        p_tarefa_id, p_tentativa_esperada
        using errcode = '55000';
    end if;

    raise exception
      'aguardar_aprovacao_tarefa: aprovacao % nao pertence a tarefa % ou nao esta ativa',
      p_aprovacao_id, p_tarefa_id
      using errcode = '55000';
  end if;

  return v_tarefa;
end;
$$;

comment on function public.aguardar_aprovacao_tarefa(uuid, integer, uuid) is
  'APPROVAL-DECISION-RESUME-D1: estaciona a tarefa e grava, na mesma transacao, qual aprovacao ela aguarda. A aprovacao e revalidada por leitura MVCC, sem lock, para nao inverter a ordem Aprovacao -> Tarefa.';


-- ── 6. Privilegios da assinatura NOVA ─────────────────────────────────
--
-- `pg_default_acl` deste projeto concede EXECUTE a `anon`,
-- `authenticated` e `service_role` em toda funcao nova. `REVOKE FROM
-- PUBLIC` nao cobre isso — `PUBLIC` e pseudo-role distinto —, e foi
-- assim que o SEC1 aconteceu. Os quatro REVOKE deixam a concessao final
-- explicita em vez de herdada.
--
-- Todos nomeiam a assinatura de TRES argumentos. A de dois nao e tocada.
revoke all on function public.aguardar_aprovacao_tarefa(uuid, integer, uuid) from public;
revoke all on function public.aguardar_aprovacao_tarefa(uuid, integer, uuid) from anon;
revoke all on function public.aguardar_aprovacao_tarefa(uuid, integer, uuid) from authenticated;
revoke all on function public.aguardar_aprovacao_tarefa(uuid, integer, uuid) from service_role;

grant execute on function public.aguardar_aprovacao_tarefa(uuid, integer, uuid) to service_role;
