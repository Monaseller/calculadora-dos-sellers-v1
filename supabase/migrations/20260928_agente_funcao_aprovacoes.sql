-- ════════════════════════════════════════════════════════════════════
-- APPROVAL-B1B — a fundacao persistente de aprovacao de Funcao.
--
-- ── A pergunta que esta tabela responde ─────────────────────────────
--
--   "Um humano autorizou ESTA acao concreta, e essa autorizacao ainda
--    vale, e ela ja foi usada?"
--
-- Ate aqui `aguardando_aprovacao` existia em tres lugares e nao era
-- aprovacao em nenhum: `agente_permissoes.nivel='aprovacao'` e
-- CONFIGURACAO permanente ("esta Funcao exige aprovacao");
-- `agente_funcao_chamadas.status='aguardando_aprovacao'` e o registro
-- IMUTAVEL de uma tentativa que parou; e `agente_tarefas.status` tem o
-- valor no CHECK desde a fundacao sem nenhum produtor. Nenhum dos tres
-- e uma decisao humana sobre uma tentativa especifica, consumivel uma
-- vez so. Esta tabela e.
--
-- ── Por que entidade propria, e nao uma das que ja existem ──────────
--
-- `agente_funcao_chamadas` e append-only por GRANT: transformar a linha
-- em maquina de estados destruiria a unica propriedade que ela existe
-- para ter. `agente_tarefas` e fila at-least-once com `tentativas` /
-- `max_tentativas` — o oposto exato do que uma aprovacao de escrita
-- precisa —, e `tarefa_id` e opcional numa chamada de Funcao, entao
-- amarrar aprovacao a tarefa deixaria Funcao-sem-tarefa de fora.
--
-- ── O que o BANCO garante, e o que ele NAO garante ──────────────────
--
-- Garante, e esta escrito assim de proposito para ninguem supor mais:
--
--   campos congelados   privilegio por COLUNA (nao ha UPDATE neles)
--   forma da linha      19 CHECKs
--   unicidade da ativa  indice unico parcial sobre `fingerprint`
--   TTL e estado inicial INSERT por coluna + DEFAULT + CHECK `ttl_24h`
--
-- NAO garante: a matriz de TRANSICAO. Um `CHECK` enxerga so `NEW`,
-- nunca `OLD`, e privilegio de coluna restringe QUAIS colunas, nunca
-- quais valores. `consumida -> pendente` por UPDATE direto passa por
-- todos os CHECKs — foi medido. As transicoes sao impostas pelas RPCs
-- abaixo e por tripwire de fonte, e isso e limitacao declarada, nao
-- descuido. Nao ha trigger porque este dominio nao tem nenhum, e porque
-- hoje o pior caso de uma transicao ilegal e repetir uma LEITURA
-- idempotente: escrita continua fail-closed no executor. No gate que
-- habilitar Tool de escrita, o trigger de transicao volta obrigatoria-
-- mente a mesa — ali uma transicao ilegal passa a poder duplicar efeito
-- externo.
--
-- Nenhuma RPC e SECURITY DEFINER. Este repositorio nao tem nenhuma, e
-- introduzir a primeira para contornar privilegio seria trocar um
-- problema declarado por um contorno silencioso.
-- ════════════════════════════════════════════════════════════════════

create table if not exists public.agente_funcao_aprovacoes (
  id uuid not null default gen_random_uuid(),

  -- `text` porque TODO `user_id` deste projeto e text, inclusive em
  -- `lojas`. Um uuid aqui obrigaria cast em cada FK composta.
  user_id text not null,
  agente_id uuid not null,

  -- Opcional de proposito: `executarFuncao` aceita `tarefaId` ausente, e
  -- uma aprovacao que dependesse de tarefa deixaria Funcao-sem-tarefa
  -- sem caminho.
  tarefa_id uuid null,

  funcao_id text not null,

  -- Congelada na criacao. No consumo, revisao diferente da atual =
  -- aprovacao desatualizada: executar a definicao nova sob a autorizacao
  -- antiga seria executar outra acao.
  revisao_funcao text not null,
  acesso text not null,

  -- ── O alvo da conexao, congelado ──────────────────────────────────
  --
  -- `plataforma` e `recurso` descrevem o REQUISITO, e o requisito e
  -- versionado por `revisao_funcao`. `conexao_loja_id` e outra coisa: e
  -- o ALVO vivo, e `agente_conexoes` tem PK `(agente_id, plataforma,
  -- recurso)` — `loja_id` esta FORA dela. Ou seja, a mesma conexao pode
  -- passar a apontar para outra loja sem que requisito nem revisao
  -- mudem. Sem congelar a loja, aprovar para a loja A e consumir contra
  -- a loja B seria possivel; com ela congelada e reconferida no
  -- consumo, nao e.
  --
  -- Nenhum dos tres carrega credencial: token e `seller_id` morrem em
  -- `conexoes/fatos.ts` e nao atravessam para ca.
  conexao_plataforma text null,
  conexao_recurso text null,
  conexao_loja_id uuid null,

  -- ── O que o humano aprovou ────────────────────────────────────────
  --
  -- Argumentos INTEGRAIS, ja aprovados por `validarEntrada`. E a unica
  -- forma de retomada duravel: `agente_funcao_chamadas.entrada_resumo` e
  -- `{}` de proposito, e reconstruir o input pela tarefa nao funciona
  -- para Funcao sem tarefa.
  argumentos jsonb not null,
  argumentos_hash text not null,
  fingerprint text not null,

  estado text not null default 'pendente',

  criado_em timestamptz not null default now(),
  expira_em timestamptz not null default (now() + interval '24 hours'),

  -- A tentativa que PAROU pedindo aprovacao. Sem produtor nesta fase: o
  -- executor ainda nao cria aprovacoes, e por isso a coluna tambem nao
  -- recebe privilegio de INSERT abaixo. O gate de integracao amplia o
  -- grant nominalmente, e a mudanca aparece no diff.
  request_id_solicitacao text null,

  -- ── Decisao e cancelamento sao PARES DISTINTOS ────────────────────
  --
  -- `aprovada -> cancelada` e transicao legal. Reusar `decidido_*` para
  -- o cancelamento obrigaria a escolher entre apagar quem aprovou ou
  -- ficar sem quem cancelou — as duas perdem a trilha. Sao quatro
  -- campos, e uma linha cancelada que veio de aprovada carrega os
  -- quatro.
  decidido_por text null,
  decidido_em timestamptz null,
  motivo_recusa text null,
  cancelado_por text null,
  cancelado_em timestamptz null,

  consumida_em timestamptz null,
  request_id_consumo text null,

  constraint agente_funcao_aprovacoes_pk primary key (id),

  -- ── Invariantes de vocabulario e formato ──────────────────────────

  constraint agente_funcao_aprovacoes_estado_valido
    check (estado in ('pendente', 'aprovada', 'rejeitada', 'consumida', 'expirada', 'cancelada')),

  -- A MESMA forma canonica de `agente_permissoes_funcao_id_formato` e do
  -- CHECK da Tool Call. Uma quarta forma obrigaria traducao, e traducao
  -- entre autoridades e onde erro de escopo se esconde.
  constraint agente_funcao_aprovacoes_funcao_id_formato
    check (funcao_id ~ '^[a-z0-9]+(\.[a-z0-9_]+)+$'),

  constraint agente_funcao_aprovacoes_revisao_nao_vazia
    check (length(btrim(revisao_funcao)) > 0),

  constraint agente_funcao_aprovacoes_acesso_valido
    check (acesso in ('leitura', 'escrita')),

  -- ── TTL: 24 h, e o banco e quem diz ───────────────────────────────
  --
  -- A igualdade estrita, e nao `expira_em > criado_em`, e o que impede
  -- uma janela de 1 hora ou de 1 ano. Os dois DEFAULTs usam `now()`, que
  -- e o timestamp da TRANSACAO — identico nos dois no mesmo INSERT, o
  -- que faz a igualdade valer exatamente. `clock_timestamp()` quebraria
  -- por microssegundos.
  --
  -- Duracao absoluta, NAO "mesmo horario do dia seguinte": em transicao
  -- de horario de verao as duas divergem, e a decisao de produto foi 24
  -- horas.
  --
  -- Sozinho este CHECK prenderia so a DURACAO — `criado_em` no futuro
  -- com `expira_em = criado_em + 24h` passaria. Quem fecha o inicio da
  -- janela e a ausencia de privilegio de INSERT em `criado_em`.
  constraint agente_funcao_aprovacoes_ttl_24h
    check (expira_em = criado_em + interval '24 hours'),

  constraint agente_funcao_aprovacoes_argumentos_objeto
    check (jsonb_typeof(argumentos) = 'object'),

  -- Hash truncado, em maiusculas ou vazio quebraria o dedupe em
  -- silencio; aqui vira erro de gravacao.
  constraint agente_funcao_aprovacoes_argumentos_hash_sha256
    check (argumentos_hash ~ '^[0-9a-f]{64}$'),

  constraint agente_funcao_aprovacoes_fingerprint_sha256
    check (fingerprint ~ '^[0-9a-f]{64}$'),

  -- ── Segredo: recursivo e sem distincao de maiusculas ──────────────
  --
  -- `$.**.token` sozinho seria CASE-SENSITIVE e deixaria `{"Token":...}`
  -- passar — foi medido. `keyvalue()` so pode ser aplicado a objeto,
  -- entao o filtro `@.type() == "object"` vem ANTES, senao qualquer
  -- escalar no caminho estoura 2203C.
  --
  -- GARANTIA HONESTA: isto proibe NOMES DE CHAVE conhecidos, em qualquer
  -- profundidade, inclusive dentro de arrays, sem distincao de caixa.
  -- Nao detecta um segredo guardado sob nome inocente (`{"x":"eyJ..."}`)
  -- — nenhum CHECK detectaria. A defesa primaria continua sendo o
  -- contrato de Funcao e a Connection resolvendo credencial no momento
  -- da execucao.
  constraint agente_funcao_aprovacoes_sem_segredo
    check (not jsonb_path_exists(
      argumentos,
      '$.** ? (@.type() == "object").keyvalue() ? (@.key like_regex "^(token|access_token|refresh_token|secret|client_secret|authorization|cookie|credential|senha|password)$" flag "i")'
    )),

  -- ── Pares: nenhuma metade de metadata ─────────────────────────────
  --
  -- Independentes do estado, porque um par pela metade e incoerente em
  -- qualquer estado, e os CHECKs por estado abaixo nao pegariam isso.

  constraint agente_funcao_aprovacoes_par_decisao
    check ((decidido_por is null) = (decidido_em is null)),

  constraint agente_funcao_aprovacoes_par_cancelamento
    check ((cancelado_por is null) = (cancelado_em is null)),

  constraint agente_funcao_aprovacoes_par_consumo
    check ((consumida_em is null) = (request_id_consumo is null)),

  -- Requisito de conexao e tudo-ou-nada: meio requisito descreveria um
  -- alvo que nao existe.
  constraint agente_funcao_aprovacoes_par_requisito_conexao
    check (
      (conexao_plataforma is null) = (conexao_recurso is null)
      and (conexao_plataforma is null) = (conexao_loja_id is null)
    ),

  constraint agente_funcao_aprovacoes_requisito_nao_vazio
    check (
      conexao_plataforma is null
      or (length(btrim(conexao_plataforma)) > 0 and length(btrim(conexao_recurso)) > 0)
    ),

  -- ── Shape por estado ──────────────────────────────────────────────
  --
  -- `consumida` exige decisao porque so nasce de `aprovada`.
  constraint agente_funcao_aprovacoes_decisao_obrigatoria
    check (
      estado not in ('aprovada', 'rejeitada', 'consumida')
      or (decidido_por is not null and decidido_em is not null)
    ),

  constraint agente_funcao_aprovacoes_cancelamento_bidirecional
    check ((estado = 'cancelada') = (cancelado_por is not null)),

  constraint agente_funcao_aprovacoes_consumo_bidirecional
    check ((estado = 'consumida') = (request_id_consumo is not null)),

  constraint agente_funcao_aprovacoes_motivo_so_em_rejeitada
    check (
      motivo_recusa is null
      or (estado = 'rejeitada' and length(btrim(motivo_recusa)) > 0)
    ),

  -- `pendente` e o estado zero: nada aconteceu ainda.
  constraint agente_funcao_aprovacoes_pendente_sem_decisao
    check (
      estado <> 'pendente'
      or (decidido_por is null and cancelado_por is null
          and consumida_em is null and motivo_recusa is null)
    ),

  -- ── FKs compostas: tenant cruzado impossivel por estrutura ────────
  --
  -- Apoiadas em `agentes_id_por_dono UNIQUE (user_id, id)`,
  -- `agente_tarefas_id_por_dono UNIQUE (id, user_id)` e
  -- `lojas_id_user_id_unico UNIQUE (id, user_id)`. RESTRICT nos dois
  -- lados: uma aprovacao e registro de decisao humana e nao desaparece
  -- em cascata.
  constraint agente_funcao_aprovacoes_agente_do_mesmo_dono
    foreign key (agente_id, user_id) references public.agentes (id, user_id)
    on update restrict on delete restrict,

  constraint agente_funcao_aprovacoes_tarefa_do_mesmo_dono
    foreign key (tarefa_id, user_id) references public.agente_tarefas (id, user_id)
    on update restrict on delete restrict,

  constraint agente_funcao_aprovacoes_loja_do_mesmo_dono
    foreign key (conexao_loja_id, user_id) references public.lojas (id, user_id)
    on update restrict on delete restrict
);

-- ── Indices ───────────────────────────────────────────────────────────
--
-- O predicado do indice de ativa NAO pode conter `now()`: o Postgres
-- exige funcao IMMUTABLE em predicado, e `now()` nao e. Por isso a
-- unicidade olha so o ESTADO, e a expiracao e MATERIALIZADA como estado
-- pelas RPCs antes de qualquer decisao. E o que torna o desenho
-- independente de scheduler.
--
-- A chave e `(user_id, fingerprint)`, e nao `fingerprint` sozinho. O
-- `user_id` ja participa do digest do fingerprint legitimo, entao o
-- comportamento normal e identico; o que muda e o caso do parametro
-- MALFORMADO. `p_fingerprint` chega cru na RPC, e o Postgres nao tem
-- como provar que ele e o sha256 correto dos demais parametros — isso e
-- derivado em `aprovacoes/identidade.ts`. Sem o `user_id` na chave, um
-- fingerprint arbitrario poderia colidir com a aprovacao ativa de outro
-- dono e interferir no dedupe dele.
create unique index if not exists agente_funcao_aprovacoes_ativa_por_acao
  on public.agente_funcao_aprovacoes (user_id, fingerprint)
  where estado in ('pendente', 'aprovada');

-- Uma execucao nunca pode ser reivindicada por duas aprovacoes.
create unique index if not exists agente_funcao_aprovacoes_consumo_unico
  on public.agente_funcao_aprovacoes (user_id, request_id_consumo)
  where request_id_consumo is not null;

create index if not exists idx_agente_funcao_aprovacoes_dono_data
  on public.agente_funcao_aprovacoes (user_id, criado_em desc);

-- ── Privilegios ───────────────────────────────────────────────────────
--
-- ── Por que o REVOKE de service_role e OBRIGATORIO ──────────────────
--
-- `pg_default_acl` deste projeto concede `arwdDxtm` — INSERT, SELECT,
-- UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER — a `service_role` em
-- TODA tabela nova, e `supabase_admin` concede o mesmo a `anon` e
-- `authenticated`. `REVOKE FROM PUBLIC` nao cobre nenhum deles: PUBLIC
-- e pseudo-role distinto. Foi a causa do bug SEC1.
--
-- E o REVOKE de `service_role` especificamente: sem ele, o `GRANT
-- UPDATE (colunas)` abaixo seria DECORATIVO, porque o UPDATE table-wide
-- herdado continuaria valendo e os campos congelados nao estariam
-- congelados coisa nenhuma.
revoke all on table public.agente_funcao_aprovacoes from public;
revoke all on table public.agente_funcao_aprovacoes from anon;
revoke all on table public.agente_funcao_aprovacoes from authenticated;
revoke all on table public.agente_funcao_aprovacoes from service_role;

grant select on table public.agente_funcao_aprovacoes to service_role;

-- ── INSERT por COLUNA — 12, e so estas ────────────────────────────────
--
-- O que fica de FORA e o ponto: sem privilegio de INSERT em `estado`,
-- `criado_em`, `expira_em` e nos campos de lifecycle, uma linha so pode
-- nascer `pendente`, com a janela de 24 h comecando no timestamp da
-- transacao. Criar direto uma aprovacao ja `aprovada`, ou com TTL de um
-- ano, deixa de ser possivel — nao por disciplina, por privilegio.
--
-- `request_id_solicitacao` fica fora ate existir produtor.
grant insert (
  user_id,
  agente_id,
  tarefa_id,
  funcao_id,
  revisao_funcao,
  acesso,
  conexao_plataforma,
  conexao_recurso,
  conexao_loja_id,
  argumentos,
  argumentos_hash,
  fingerprint
) on table public.agente_funcao_aprovacoes to service_role;

-- ── UPDATE por COLUNA — 8 de lifecycle ────────────────────────────────
--
-- Os 16 campos congelados nao aparecem aqui, e por isso um `UPDATE ...
-- SET argumentos = ...` falha com permission denied venha de onde vier.
grant update (
  estado,
  decidido_por,
  decidido_em,
  motivo_recusa,
  cancelado_por,
  cancelado_em,
  consumida_em,
  request_id_consumo
) on table public.agente_funcao_aprovacoes to service_role;

comment on table public.agente_funcao_aprovacoes is
  'APPROVAL-B1B. Decisao humana sobre UMA tentativa concreta de Funcao, consumivel exatamente uma vez. Campos congelados sao imutaveis por privilegio de coluna; forma por CHECK; unicidade da ativa por indice parcial; TTL de 24h e estado inicial por INSERT-por-coluna + DEFAULT + CHECK. As TRANSICOES nao sao DB-enforced: sao impostas pelas 3 RPCs e por tripwire de fonte. Nao guarda credencial, token nem header.';

comment on column public.agente_funcao_aprovacoes.conexao_loja_id is
  'Loja EFETIVAMENTE selecionada quando a aprovacao foi criada. Congelada porque loja_id esta FORA da PK de agente_conexoes: a mesma conexao pode passar a apontar para outra loja sem mudar requisito nem revisao. Reconferida no consumo, o que fecha troca de alvo durante a espera.';

comment on column public.agente_funcao_aprovacoes.argumentos is
  'Argumentos INTEGRAIS ja aprovados por validarEntrada. Nunca token, secret, cookie, credential ou senha — proibido por CHECK recursivo case-insensitive sobre nomes de chave. Credencial e resolvida pela Connection no momento da execucao.';

comment on column public.agente_funcao_aprovacoes.expira_em is
  'criado_em + 24 horas, imposto por CHECK. Duracao ABSOLUTA, nao "mesmo horario do dia seguinte" — em transicao de horario de verao as duas divergem.';

-- ════════════════════════════════════════════════════════════════════
-- RPC 1 — criar o pedido
--
-- Criacao e RPC, e nao INSERT na camada de aplicacao, porque
-- materializar expiracao, checar duplicata e inserir precisam ser UMA
-- transacao: entre um SELECT previo e o INSERT caberia uma corrida.
-- A autoridade do dedupe e o INDICE, nunca a consulta.
-- ════════════════════════════════════════════════════════════════════
create or replace function public.aprovacao_criar(
  p_user_id text,
  p_agente_id uuid,
  p_tarefa_id uuid,
  p_funcao_id text,
  p_revisao_funcao text,
  p_acesso text,
  p_conexao_plataforma text,
  p_conexao_recurso text,
  p_conexao_loja_id uuid,
  p_argumentos jsonb,
  p_argumentos_hash text,
  p_fingerprint text
)
returns table (id uuid, resultado text)
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_id uuid;
  v_nivel text;
begin
  -- ── O que esta RPC consegue garantir, e o que nao consegue ────────
  --
  -- Ela nao tem sessao para confiar, entao revalida no banco tudo que e
  -- VERIFICAVEL no banco: posse do agente, posse e vinculo da tarefa,
  -- nivel de permissao, existencia do alvo de conexao, formato dos
  -- hashes (CHECK) e isolamento por tenant.
  --
  -- Ela NAO consegue provar que `p_fingerprint` e `p_argumentos_hash`
  -- sao mesmo o sha256 canonico dos parametros: isso e derivado em
  -- `lib/agentes/aprovacoes/identidade.ts`, e recalcular a
  -- canonicalizacao em SQL criaria uma segunda autoridade que teria de
  -- concordar para sempre com a primeira. O que fecha essa ponta e
  -- arquitetura, nao privilegio: `persistencia.ts` e a unica chamadora,
  -- provado por tripwire de fonte. Por isso o escopo por `user_id`
  -- abaixo importa — ele limita o estrago de um parametro errado ao
  -- proprio dono.
  if p_user_id is null or btrim(p_user_id) = '' or p_agente_id is null then
    return query select null::uuid, 'entrada_invalida'::text;
    return;
  end if;

  -- 1. Posse do agente. Inexistente e de-outro-dono sao indistinguiveis
  --    de proposito: distinguir seria um oraculo de existencia alheia.
  if not exists (
    select 1 from public.agentes a
    where a.id = p_agente_id and a.user_id = p_user_id
  ) then
    return query select null::uuid, 'agente_indisponivel'::text;
    return;
  end if;

  -- 2. Posse da tarefa E mesmo agente. A FK composta garante o dono; ela
  --    NAO garante que a tarefa e deste agente, e uma tarefa de outro
  --    agente do mesmo usuario seria escopo errado.
  if p_tarefa_id is not null then
    if not exists (
      select 1 from public.agente_tarefas t
      where t.id = p_tarefa_id and t.user_id = p_user_id and t.agente_id = p_agente_id
    ) then
      return query select null::uuid, 'tarefa_indisponivel'::text;
      return;
    end if;
  end if;

  -- 3. Pedir aprovacao so faz sentido quando o dono configurou
  --    `aprovacao`. Em `automatico` nao ha o que aprovar; em
  --    `bloqueado` ou ausente, nao ha o que autorizar.
  select p.nivel into v_nivel
  from public.agente_permissoes p
  where p.agente_id = p_agente_id and p.funcao_id = p_funcao_id;

  if v_nivel is null then
    return query select null::uuid, 'permissao_ausente'::text;
    return;
  end if;

  if v_nivel <> 'aprovacao' then
    return query select null::uuid, 'permissao_nao_exige_aprovacao'::text;
    return;
  end if;

  -- 4. O alvo de conexao precisa existir AGORA, exatamente como o
  --    snapshot afirma. Isso fecha a janela entre resolver a Connection
  --    em TypeScript e persistir o congelamento.
  if p_conexao_plataforma is not null then
    if not exists (
      select 1 from public.agente_conexoes c
      where c.agente_id = p_agente_id
        and c.user_id = p_user_id
        and c.plataforma = p_conexao_plataforma
        and c.recurso = p_conexao_recurso
        and c.loja_id = p_conexao_loja_id
    ) then
      return query select null::uuid, 'conexao_indisponivel'::text;
      return;
    end if;
  end if;

  -- 5. Materializar expiracao ANTES do INSERT, e FORA de qualquer bloco
  --    com EXCEPTION.
  --
  --    Isto nao e estilo: um bloco `EXCEPTION` abre subtransacao, e o
  --    rollback dela apagaria este UPDATE junto com o erro do INSERT.
  --    Foi medido — o UPDATE marcava uma linha e, apos a excecao, zero
  --    linhas ficavam expiradas. Por isso o passo 6 usa ON CONFLICT, e
  --    nao `unique_violation`, para o fluxo normal.
  --    O escopo inclui `user_id` junto com `fingerprint`, e nao apenas
  --    o fingerprint. As outras duas RPCs ja escopam por `user_id`, e a
  --    assimetria aqui era um furo real: `p_fingerprint` e parametro
  --    cru, entao um valor arbitrario faria esta mutacao alcancar a
  --    linha de OUTRO dono. As linhas atingidas ja estariam vencidas, o
  --    que limita o estrago, mas mutacao cross-tenant nao se justifica
  --    por ser inofensiva.
  update public.agente_funcao_aprovacoes
     set estado = 'expirada'
   where user_id = p_user_id
     and fingerprint = p_fingerprint
     and estado in ('pendente', 'aprovada')
     and expira_em <= now();

  -- 6. O indice unico parcial e a autoridade. Duas transacoes
  --    concorrentes chegam aqui; uma insere, a outra recebe DO NOTHING e
  --    le a ativa no passo 8.
  --
  --    Nenhuma coluna de estado, timestamp ou lifecycle aparece nesta
  --    lista: `id`, `estado`, `criado_em` e `expira_em` vem do DEFAULT, e
  --    o privilegio de INSERT por coluna torna isso obrigatorio, nao
  --    apenas convencionado.
  insert into public.agente_funcao_aprovacoes (
    user_id, agente_id, tarefa_id, funcao_id, revisao_funcao, acesso,
    conexao_plataforma, conexao_recurso, conexao_loja_id,
    argumentos, argumentos_hash, fingerprint
  )
  values (
    p_user_id, p_agente_id, p_tarefa_id, p_funcao_id, p_revisao_funcao, p_acesso,
    p_conexao_plataforma, p_conexao_recurso, p_conexao_loja_id,
    p_argumentos, p_argumentos_hash, p_fingerprint
  )
  on conflict (user_id, fingerprint) where estado in ('pendente', 'aprovada')
  do nothing
  returning agente_funcao_aprovacoes.id into v_id;

  if v_id is not null then
    return query select v_id, 'criada'::text;
    return;
  end if;

  -- 8. Ja existia ativa equivalente. Devolver a existente EXPLICITAMENTE
  --    rotulada, em vez de fingir criacao — mesmo precedente de
  --    `registrarAbertura`, que devolve `duplicada` como estado proprio.
  select a.id into v_id
  from public.agente_funcao_aprovacoes a
  where a.user_id = p_user_id
    and a.fingerprint = p_fingerprint
    and a.estado in ('pendente', 'aprovada')
    and a.expira_em > now()
  limit 1;

  if v_id is null then
    return query select null::uuid, 'conflito_nao_resolvido'::text;
    return;
  end if;

  return query select v_id, 'reutilizada'::text;
end;
$$;

-- ════════════════════════════════════════════════════════════════════
-- RPC 2 — decidir
--
-- `decidido_por` NAO e parametro: deriva sempre de `p_user_id`. Nao
-- existe assinatura capaz de registrar um decisor diferente do dono
-- autenticado.
--
-- Um predicado unico nao serve para as tres decisoes: `cancelar` aceita
-- duas origens (`pendente` e `aprovada`), aprovar e rejeitar aceitam
-- apenas `pendente`.
-- ════════════════════════════════════════════════════════════════════
create or replace function public.aprovacao_decidir(
  p_user_id text,
  p_aprovacao_id uuid,
  p_decisao text,
  p_motivo text
)
returns text
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_estado text;
  v_motivo text;
  v_afetadas int;
begin
  if p_user_id is null or btrim(p_user_id) = '' or p_aprovacao_id is null then
    return 'entrada_invalida';
  end if;

  if p_decisao not in ('aprovar', 'rejeitar', 'cancelar') then
    return 'decisao_invalida';
  end if;

  -- Expiracao materializada primeiro, e ela altera SOMENTE `estado`:
  -- uma `aprovada` que vence continua carregando quem aprovou e quando.
  update public.agente_funcao_aprovacoes
     set estado = 'expirada'
   where id = p_aprovacao_id
     and user_id = p_user_id
     and estado in ('pendente', 'aprovada')
     and expira_em <= now();

  if p_decisao = 'aprovar' then
    update public.agente_funcao_aprovacoes
       set estado = 'aprovada',
           decidido_por = p_user_id,
           decidido_em = now()
     where id = p_aprovacao_id
       and user_id = p_user_id
       and estado = 'pendente'
       and expira_em > now();

  elsif p_decisao = 'rejeitar' then
    -- Motivo em branco vira NULL: o CHECK recusa texto so de espacos, e
    -- normalizar aqui evita transformar um campo opcional em erro.
    v_motivo := nullif(btrim(coalesce(p_motivo, '')), '');

    update public.agente_funcao_aprovacoes
       set estado = 'rejeitada',
           decidido_por = p_user_id,
           decidido_em = now(),
           motivo_recusa = v_motivo
     where id = p_aprovacao_id
       and user_id = p_user_id
       and estado = 'pendente'
       and expira_em > now();

  else
    -- Cancelar aceita as duas origens, e NAO toca `decidido_*`: quando
    -- vem de `aprovada`, quem aprovou continua registrado ao lado de
    -- quem cancelou.
    update public.agente_funcao_aprovacoes
       set estado = 'cancelada',
           cancelado_por = p_user_id,
           cancelado_em = now()
     where id = p_aprovacao_id
       and user_id = p_user_id
       and estado in ('pendente', 'aprovada');
  end if;

  get diagnostics v_afetadas = row_count;

  if v_afetadas = 1 then
    if p_decisao = 'aprovar' then return 'aprovada'; end if;
    if p_decisao = 'rejeitar' then return 'rejeitada'; end if;
    return 'cancelada';
  end if;

  -- Nada mudou. O motivo esta no estado atual — e um id desconhecido e
  -- um id de outro dono devolvem a MESMA coisa.
  select a.estado into v_estado
  from public.agente_funcao_aprovacoes a
  where a.id = p_aprovacao_id and a.user_id = p_user_id;

  if v_estado is null then return 'aprovacao_inexistente'; end if;
  if v_estado = 'aprovada' then return 'ja_aprovada'; end if;
  if v_estado = 'rejeitada' then return 'ja_rejeitada'; end if;
  if v_estado = 'cancelada' then return 'ja_cancelada'; end if;
  if v_estado = 'consumida' then return 'ja_consumida'; end if;
  return 'expirada';
end;
$$;

-- ════════════════════════════════════════════════════════════════════
-- RPC 3 — consumir e abrir, atomicamente
--
-- ── Por que as duas coisas na MESMA transacao ───────────────────────
--
-- Consumir e abrir precisam acontecer juntos ou nenhum dos dois. Se o
-- consumo commitasse e a abertura falhasse depois, a aprovacao estaria
-- gasta sem registro do que a gastou; se a abertura viesse primeiro, o
-- claim — que PODE recusar — aconteceria depois de uma linha que
-- significa "o executor vai ser chamado AGORA", contradizendo o contrato
-- publicado da Tool Call.
--
-- O custo, declarado: esta funcao e o SEGUNDO lugar que insere uma
-- abertura, alem de `lib/agentes/chamadas/registro.ts`. A duplicacao e
-- de LISTA DE COLUNAS, nao de invariante — a forma da linha continua
-- imposta pelos 23 CHECKs da propria Tool Call —, e a suite compara as
-- duas listas nominalmente, nos dois sentidos.
--
-- Esta funcao NAO executa a Funcao. Ela consome e abre; quem executa e
-- gate posterior.
-- ════════════════════════════════════════════════════════════════════
create or replace function public.aprovacao_consumir_e_abrir(
  p_user_id text,
  p_aprovacao_id uuid,
  p_request_id text,
  p_revisao_atual text
)
returns text
language plpgsql
security invoker
set search_path = public
as $$
declare
  ap public.agente_funcao_aprovacoes%rowtype;
  v_nivel text;
  v_afetadas int;
begin
  if p_user_id is null or btrim(p_user_id) = '' or p_aprovacao_id is null
     or p_request_id is null or btrim(p_request_id) = '' then
    return 'entrada_invalida';
  end if;

  -- 1. Expiracao materializada antes de qualquer prova.
  update public.agente_funcao_aprovacoes
     set estado = 'expirada'
   where id = p_aprovacao_id
     and user_id = p_user_id
     and estado in ('pendente', 'aprovada')
     and expira_em <= now();

  -- 2. Trava a linha. Sem isto, duas transacoes leriam `aprovada` e as
  --    duas tentariam consumir — o mesmo cuidado de
  --    `claim_next_agente_tarefa`.
  select * into ap
  from public.agente_funcao_aprovacoes a
  where a.id = p_aprovacao_id and a.user_id = p_user_id
  for update;

  if not found then return 'aprovacao_inexistente'; end if;

  -- 3. Posse do agente revalidada AQUI dentro, e nao so em TypeScript:
  --    entre a checagem da aplicacao e o COMMIT cabe uma mudanca.
  if not exists (
    select 1 from public.agentes a
    where a.id = ap.agente_id and a.user_id = p_user_id
  ) then
    return 'agente_indisponivel';
  end if;

  -- 4. Tarefa: mesmo dono E mesmo agente.
  if ap.tarefa_id is not null then
    if not exists (
      select 1 from public.agente_tarefas t
      where t.id = ap.tarefa_id and t.user_id = p_user_id and t.agente_id = ap.agente_id
    ) then
      return 'tarefa_indisponivel';
    end if;
  end if;

  -- 5. So `aprovada` e nao vencida.
  if ap.estado <> 'aprovada' then
    if ap.estado = 'pendente' then return 'aprovacao_pendente'; end if;
    if ap.estado = 'consumida' then return 'ja_consumida'; end if;
    if ap.estado = 'rejeitada' then return 'ja_rejeitada'; end if;
    if ap.estado = 'cancelada' then return 'ja_cancelada'; end if;
    return 'expirada';
  end if;

  if ap.expira_em <= now() then return 'expirada'; end if;

  -- 6. A definicao precisa ser a MESMA que o humano aprovou.
  if ap.revisao_funcao is distinct from p_revisao_atual then
    return 'aprovacao_desatualizada';
  end if;

  -- 7. Escrita continua fail-closed, e a recusa vem ANTES do consumo.
  --    Deixar seguir estouraria no CHECK de `idempotency_key` da Tool
  --    Call, com a aprovacao ja gasta e um 23514 generico no lugar de
  --    uma resposta nomeada.
  if ap.acesso = 'escrita' then
    return 'escrita_nao_suportada';
  end if;

  -- 8. Permissao ATUAL. `automatico` segue — a autoridade so ficou mais
  --    permissiva, e exigir nova aprovacao por isso seria punir o dono
  --    por relaxar a propria regra. `bloqueado` e ausente param: uma
  --    aprovacao nao revive autoridade revogada.
  select p.nivel into v_nivel
  from public.agente_permissoes p
  where p.agente_id = ap.agente_id and p.funcao_id = ap.funcao_id;

  if v_nivel is null then return 'permissao_ausente'; end if;
  if v_nivel not in ('aprovacao', 'automatico') then return 'permissao_bloqueada'; end if;

  -- 9. O alvo congelado precisa continuar sendo o alvo atual — mesma
  --    plataforma, mesmo recurso e MESMA LOJA. E aqui que a troca de
  --    loja durante a espera e barrada.
  if ap.conexao_plataforma is not null then
    if not exists (
      select 1 from public.agente_conexoes c
      where c.agente_id = ap.agente_id
        and c.user_id = p_user_id
        and c.plataforma = ap.conexao_plataforma
        and c.recurso = ap.conexao_recurso
        and c.loja_id = ap.conexao_loja_id
    ) then
      return 'conexao_indisponivel';
    end if;
  end if;

  -- 10. O claim. `rowCount = 0` significa que outra transacao venceu.
  update public.agente_funcao_aprovacoes
     set estado = 'consumida',
         consumida_em = now(),
         request_id_consumo = p_request_id
   where id = ap.id
     and estado = 'aprovada';

  get diagnostics v_afetadas = row_count;
  if v_afetadas <> 1 then return 'ja_consumida'; end if;

  -- 11. A abertura. Mesmas 17 colunas de `registrarAbertura`, com os
  --     valores vindos da LINHA TRAVADA — nunca de parametro do
  --     chamador. `acesso` sai de `ap.acesso` e nao e escrito como
  --     'leitura' na mao: cravar a constante mascararia uma aprovacao de
  --     escrita se o passo 7 algum dia deixasse de existir.
  insert into public.agente_funcao_chamadas (
    user_id, agente_id, request_id, funcao_id, tarefa_id, acesso,
    nivel_no_momento, plataforma, recurso, loja_id, entrada_resumo,
    fase, status, codigo_desfecho, mensagem_desfecho, idempotency_key, latencia_ms
  )
  values (
    p_user_id, ap.agente_id, p_request_id, ap.funcao_id, ap.tarefa_id, ap.acesso,
    v_nivel, ap.conexao_plataforma, ap.conexao_recurso, ap.conexao_loja_id, '{}'::jsonb,
    'abertura', 'executando', null, null, null, null
  );

  return 'consumida';
end;
$$;

-- ── EXECUTE: neutralizar defaults e conceder o minimo ────────────────
--
-- `pg_default_acl` concede EXECUTE a `anon`, `authenticated` e
-- `service_role` em toda funcao nova, dos dois concedentes. Os quatro
-- REVOKE deixam a concessao final explicita em vez de herdada.
revoke all on function public.aprovacao_criar(text, uuid, uuid, text, text, text, text, text, uuid, jsonb, text, text) from public;
revoke all on function public.aprovacao_criar(text, uuid, uuid, text, text, text, text, text, uuid, jsonb, text, text) from anon;
revoke all on function public.aprovacao_criar(text, uuid, uuid, text, text, text, text, text, uuid, jsonb, text, text) from authenticated;
revoke all on function public.aprovacao_criar(text, uuid, uuid, text, text, text, text, text, uuid, jsonb, text, text) from service_role;
grant execute on function public.aprovacao_criar(text, uuid, uuid, text, text, text, text, text, uuid, jsonb, text, text) to service_role;

revoke all on function public.aprovacao_decidir(text, uuid, text, text) from public;
revoke all on function public.aprovacao_decidir(text, uuid, text, text) from anon;
revoke all on function public.aprovacao_decidir(text, uuid, text, text) from authenticated;
revoke all on function public.aprovacao_decidir(text, uuid, text, text) from service_role;
grant execute on function public.aprovacao_decidir(text, uuid, text, text) to service_role;

revoke all on function public.aprovacao_consumir_e_abrir(text, uuid, text, text) from public;
revoke all on function public.aprovacao_consumir_e_abrir(text, uuid, text, text) from anon;
revoke all on function public.aprovacao_consumir_e_abrir(text, uuid, text, text) from authenticated;
revoke all on function public.aprovacao_consumir_e_abrir(text, uuid, text, text) from service_role;
grant execute on function public.aprovacao_consumir_e_abrir(text, uuid, text, text) to service_role;

comment on function public.aprovacao_criar(text, uuid, uuid, text, text, text, text, text, uuid, jsonb, text, text) is
  'Cria pedido de aprovacao. Revalida posse do agente, posse+mesmo-agente da tarefa, nivel=aprovacao e alvo de conexao completo. Materializa expiracao FORA de bloco EXCEPTION e deduplica pelo indice unico parcial via ON CONFLICT DO NOTHING. Devolve criada|reutilizada.';

comment on function public.aprovacao_decidir(text, uuid, text, text) is
  'Aprovar/rejeitar (somente de pendente) ou cancelar (de pendente ou aprovada). decidido_por deriva de p_user_id. Cancelar preserva decidido_por/em. Duplo clique: primeiro vence, segundo recebe o estado terminal.';

comment on function public.aprovacao_consumir_e_abrir(text, uuid, text, text) is
  'Consome uma aprovacao e grava a abertura da Tool Call na MESMA transacao. Revalida posse, revisao, permissao atual (aprovacao|automatico) e alvo de conexao completo incluindo loja. Recusa escrita antes de consumir. NAO executa a Funcao.';
