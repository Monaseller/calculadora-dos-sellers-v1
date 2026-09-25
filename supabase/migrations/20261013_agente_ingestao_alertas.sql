-- ============================================================
-- M2-I1-A8B-I4P8 (OBS-4) — `agente_ingestao_alertas`: os incidentes
-- que o vigia da ingestao abre, escala e resolve.
--
-- NAO APLICADA AINDA. Aplicar ao banco exige autorizacao explicita,
-- separada da criacao deste arquivo.
--
-- ── UMA LINHA POR INCIDENTE, NAO POR CONDICAO ──────────────────────
--
-- Um alerta que voltasse a abrir na MESMA linha apagaria quando o
-- anterior comecou, quanto durou e ate onde escalou. O historico de
-- incidentes e a unica forma de responder "isso ja aconteceu antes?", e
-- essa pergunta e a primeira que alguem faz as tres da manha.
--
-- Entao: a condicao voltar depois de resolvida cria uma linha NOVA. O
-- indice unico PARCIAL abaixo e que garante o invariante que importa —
-- no maximo UM incidente ABERTO por (dono, agente, recurso, tipo) — sem
-- impedir quantos resolvidos houver no historico. O projeto ja usa esse
-- padrao em `agente_acao_execucoes` (33 indices parciais no schema).
--
-- ── O LIFECYCLE NAO MORA AQUI ──────────────────────────────────────
--
-- Nenhuma regra de abrir, escalar ou resolver esta neste arquivo. Elas
-- vivem em `lib/agentes/observabilidade/alerta.ts`, puras e testadas sem
-- banco. O schema guarda o ESTADO e impede o impossivel; quem decide e
-- o reducer. Sem trigger, sem regra de negocio em CHECK.
--
-- ── DUAS NOCOES DE SEVERIDADE ──────────────────────────────────────
--
-- `severidade_atual` responde "como esta agora" e pode CAIR. Guardar so
-- ela perderia o pico: um incidente que foi critical por vinte minutos e
-- depois virou alert seria lido como se nunca tivesse sido grave.
-- `severidade_maxima` e monotonica dentro do incidente, e e ela que
-- conta a historia.
--
-- ── DADO COMERCIAL NAO ENTRA ───────────────────────────────────────
--
-- `detalhes` e diagnostico: bucket, sequencia, deslocamento, certeza.
-- Nunca texto de pergunta, comprador, token, credencial, header ou corpo
-- HTTP. A allowlist e aplicada por `sanitizarDetalhesDoAlerta` ANTES da
-- escrita; o CHECK aqui so garante que o valor e um objeto.
-- ============================================================

-- Sem `if not exists`, pela mesma razao de `20261010`, `20261011` e
-- `20261012`: um objeto de mesmo nome com OUTRA forma seria aceito em
-- silencio e o vigia passaria a gravar contra um contrato que ninguem
-- conferiu.
create table public.agente_ingestao_alertas (
  id          uuid        not null default gen_random_uuid(),

  -- ── Escopo, na mesma forma das tabelas vizinhas ──────────────────
  user_id     text        not null,
  agente_id   uuid        not null,
  plataforma  text        not null,
  recurso     text        not null,

  tipo        text        not null,
  estado      text        not null,

  severidade_atual  text  not null,
  -- Monotonica DENTRO do incidente. O reducer nunca a reduz; o CHECK
  -- abaixo impede que uma escrita distraida o faca.
  severidade_maxima text  not null,

  -- A causa dentro do tipo — `missing`, `incomplete`, `failed`. Um unico
  -- incidente operacional pode evoluir entre elas sem virar tres
  -- incidentes independentes, entao a distincao e COLUNA, nao tipo.
  causa_atual text        null,

  aberto_em          timestamptz not null default now(),
  -- Quando a condicao foi vista ativa pela ultima vez. NAO avanca em
  -- reavaliacao da mesma evidencia: releitura nao e observacao.
  ultimo_visto_em    timestamptz not null default now(),
  -- Quando o vigia passou por aqui pela ultima vez, tendo ou nao
  -- novidade. Serve para saber que o monitor esta vivo.
  ultima_avaliacao_em timestamptz not null default now(),
  resolvido_em       timestamptz null,

  -- Quantas EVIDENCIAS distintas sustentaram este incidente. Nunca o
  -- numero de vezes que o monitor rodou.
  ocorrencias integer     not null default 1,

  -- A ultima evidencia processada, saudavel ou nao. E ela que separa
  -- "novidade" de "releitura" — sem esta coluna, um monitor de um minuto
  -- resolveria qualquer incidente em dois minutos sem o agendador ter
  -- produzido bucket nenhum.
  ultima_evidencia_chave text null,

  evidencias_saudaveis_consecutivas integer not null default 0,

  detalhes    jsonb       not null default '{}'::jsonb,

  constraint agente_ingestao_alertas_pk primary key (id),

  -- Mesma cerca composta do cursor e do estado esperado.
  constraint agente_ingestao_alertas_agente_do_mesmo_dono
    foreign key (agente_id, user_id)
    references public.agentes (id, user_id)
    on update restrict on delete restrict,

  constraint agente_ingestao_alertas_tipo_valido
    check (tipo in (
      'scheduler_gap',
      'cursor_stuck',
      'backlog_pressure',
      'budget_pressure',
      'cursor_regression',
      'monitor_configuration_missing',
      'observability_data_incomplete'
    )),

  constraint agente_ingestao_alertas_estado_valido
    check (estado in ('aberto', 'resolvido')),

  constraint agente_ingestao_alertas_severidade_valida
    check (severidade_atual in ('warning', 'alert', 'critical')
       and severidade_maxima in ('warning', 'alert', 'critical')),

  -- A maxima nunca pode ser MENOR que a atual. Ordem explicita porque
  -- comparar texto daria `alert > critical`.
  constraint agente_ingestao_alertas_maxima_nao_menor
    check (
      case severidade_maxima when 'warning' then 1 when 'alert' then 2 else 3 end
      >=
      case severidade_atual when 'warning' then 1 when 'alert' then 2 else 3 end
    ),

  -- Resolvido EXIGE quando; aberto PROIBE. Os dois sentidos, porque uma
  -- linha `aberto` com `resolvido_em` preenchido seria lida como fechada
  -- por qualquer consulta que olhasse so a data.
  constraint agente_ingestao_alertas_resolucao_coerente
    check (
      (estado = 'resolvido' and resolvido_em is not null)
      or (estado = 'aberto' and resolvido_em is null)
    ),

  constraint agente_ingestao_alertas_ocorrencias_positivas
    check (ocorrencias >= 1),

  constraint agente_ingestao_alertas_saudaveis_nao_negativas
    check (evidencias_saudaveis_consecutivas >= 0),

  constraint agente_ingestao_alertas_detalhes_objeto
    check (jsonb_typeof(detalhes) = 'object'),

  constraint agente_ingestao_alertas_tempos_coerentes
    check (ultimo_visto_em >= aberto_em and ultima_avaliacao_em >= aberto_em),

  -- O par canonico, igual ao do cursor e ao do estado esperado.
  constraint agente_ingestao_alertas_requisito_conhecido
    check (plataforma = 'mercado_livre' and recurso = 'perguntas')
);

-- ── O invariante que sustenta a deduplicacao ────────────────────────
--
-- No maximo UM incidente ABERTO por chave logica. E a defesa FINAL
-- contra duas execucoes sobrepostas do monitor abrirem o mesmo incidente
-- duas vezes: a segunda recebe 23505 e vira uma atualizacao, em vez de
-- uma linha duplicada que ninguem notaria.
--
-- Parcial de proposito: resolvidos ficam, quantos forem, e o historico
-- de reincidencia sobrevive.
create unique index agente_ingestao_alertas_um_aberto_por_chave
  on public.agente_ingestao_alertas (user_id, agente_id, plataforma, recurso, tipo)
  where estado = 'aberto';

-- Leitura operacional: "o que esta aberto para este agente?".
create index agente_ingestao_alertas_abertos_por_agente
  on public.agente_ingestao_alertas (agente_id, aberto_em desc)
  where estado = 'aberto';

comment on table public.agente_ingestao_alertas is
  'Incidentes do vigia da ingestao de perguntas. UMA LINHA POR INCIDENTE: resolver nao apaga, e a condicao voltar cria linha nova — o historico de reincidencia e o que responde "ja aconteceu antes?". O indice parcial garante no maximo um ABERTO por (dono, agente, recurso, tipo). O ciclo de vida NAO mora aqui: ele e puro, em `lib/agentes/observabilidade/alerta.ts`.';

comment on column public.agente_ingestao_alertas.ocorrencias is
  'Quantas EVIDENCIAS distintas sustentaram o incidente — tipicamente buckets. Nunca o numero de vezes que o monitor rodou: o vigia roda a cada minuto e o agendador a cada cinco.';

comment on column public.agente_ingestao_alertas.ultima_evidencia_chave is
  'A ultima evidencia processada, saudavel ou nao. Separa novidade de releitura; sem ela a recuperacao contaria reavaliacoes do monitor como recuperacao real.';

comment on column public.agente_ingestao_alertas.severidade_maxima is
  'O pico do incidente. `severidade_atual` pode cair; esta nao. Guardar so a atual perderia que o incidente chegou a ser critical.';

comment on column public.agente_ingestao_alertas.detalhes is
  'Diagnostico sanitizado por allowlist ANTES da escrita. Nunca texto de pergunta, comprador, token, credencial, header ou corpo HTTP.';

-- ── Privilegios ──────────────────────────────────────────────────────
--
-- Os REVOKE nominais nao sao redundancia de `from public`: `PUBLIC` e
-- pseudo-role distinto de `anon` e `authenticated`, e este projeto tem
-- `ALTER DEFAULT PRIVILEGES` concedendo privilegio a eles em objeto
-- novo. Foi o que causou o bug SEC1.
revoke all on table public.agente_ingestao_alertas from public;
revoke all on table public.agente_ingestao_alertas from anon;
revoke all on table public.agente_ingestao_alertas from authenticated;
revoke all on table public.agente_ingestao_alertas from service_role;

grant select, insert, update on table public.agente_ingestao_alertas to service_role;

-- DELETE nao entra: resolver e mudar `estado`, nao remover a linha.
-- Incidente apagado e incidente que nunca existiu, e a proxima pessoa a
-- investigar reincidencia nao teria como saber.
revoke delete, truncate on table public.agente_ingestao_alertas from service_role;
