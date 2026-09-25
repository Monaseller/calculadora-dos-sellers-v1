-- ============================================================
-- M2-I1-A8B-I4P5 (OBS-1) — `agente_ingestao_estado_esperado`: a fonte
-- INDEPENDENTE de verdade sobre se o agendador DEVERIA estar rodando.
--
-- NAO APLICADA AINDA. Aplicar ao banco exige autorizacao explicita,
-- separada da criacao deste arquivo.
--
-- ── A PERGUNTA QUE ESTA TABELA RESPONDE ─────────────────────────────
--
-- "a ausencia de uma varredura nos ultimos quinze minutos e um defeito,
--  ou e o estado normal de um agendador que ninguem ligou ainda?"
--
-- Sem esta resposta, um vigia so pode escolher entre dois erros: alertar
-- desde o primeiro minuto, e ser desligado por barulho; ou nao alertar
-- nunca, e nao servir para nada. A diferenca entre "parou" e "nunca
-- comecou" nao esta em nenhum sinal de execucao — ela e uma INTENCAO, e
-- intencao precisa ser declarada.
--
-- ── POR QUE NAO PERGUNTAR AO n8n ───────────────────────────────────
--
-- A API do n8n sabe dizer se o workflow esta `active`. Isso responde
-- "esta ligado?", que e justamente o que o vigia existe para descobrir
-- por conta propria. Um vigia que pergunta ao vigiado se ele deveria
-- estar vivo nao detecta o caso em que o vigiado sumiu — e ainda traria
-- a `N8N_API_KEY` para dentro do runtime do CDS, uma credencial nova
-- numa superficie nova, para responder a pergunta errada.
--
-- ── POR QUE NAO NO CURSOR ──────────────────────────────────────────
--
-- `agente_perguntas_continuacao` esta no caminho quente da paginacao e
-- toda escrita dela e comparacao-e-troca sobre `versao`. Pendurar
-- configuracao operacional ali faria uma mudanca de intencao do operador
-- disputar a mesma linha que a travessia disputa, e um CAS perdido por
-- causa de config seria um salto de perguntas em silencio. Controle de
-- concorrencia e configuracao nao dividem tabela.
--
-- ── LINHA AUSENTE NAO E "DESLIGADO" ────────────────────────────────
--
-- Esta e a decisao mais importante do arquivo, e ela e sobre o que NAO
-- fazer. E tentador ler "sem linha" como `esperado_ativo = false` e
-- seguir em frente. Isso criaria exatamente o acidente que esta frente
-- passou seis gates evitando: alguem ativa o agendador em producao, a
-- configuracao nunca foi criada, o vigia le "nao esperado" e fica quieto
-- — e a operacao roda desatendida sem watchdog, acreditando ter um.
--
-- Entao a camada de dominio devolve TRES estados, nao um booleano:
-- ativo, inativo e AUSENTE. Ausente e uma condicao propria, que antes do
-- go-live vira pre-condicao explicita. O banco nao pode impor isso
-- sozinho — nenhuma constraint exige que uma linha exista — mas pode
-- deixar de mentir: por isso nao ha `default` que fabrique uma linha nem
-- semente que finja intencao.
-- ============================================================

-- Sem `if not exists`, pela mesma razao de `20261010` e `20261011`: um
-- objeto de mesmo nome com OUTRA forma seria aceito em silencio, e o
-- vigia passaria a operar contra um contrato que ninguem conferiu.
create table public.agente_ingestao_estado_esperado (
  -- ── A identidade: a MESMA forma do cursor e de `agente_conexoes` ──
  --
  -- `(agente_id, plataforma, recurso)`. O dominio ja e multi-agente, e
  -- uma chave singleton global tornaria impossivel ter um agente em
  -- observacao e outro nao — que e exatamente o que um primeiro go-live
  -- controlado precisa.
  agente_id   uuid        not null,
  user_id     text        not null,

  plataforma  text        not null,
  recurso     text        not null,

  -- ── A intencao, sem `default`, e isto e deliberado ───────────────
  --
  -- As tabelas vizinhas dao `default` a valores de PROGRESSO
  -- (`proximo_deslocamento default 0`), porque ali existe um comeco
  -- obvio. Aqui nao existe: uma linha sem intencao declarada nao e
  -- "desligado", e um `default false` deixaria um INSERT incompleto
  -- passar parecendo uma decisao. Quem cria a linha diz o que quer.
  esperado_ativo boolean   not null,

  -- ── A FRONTEIRA DE OBSERVACAO, nao um SLA ────────────────────────
  --
  -- O primeiro instante a partir do qual faz sentido cobrar varredura.
  -- Nenhum bucket anterior a ele e avaliado — nem para alertar, nem para
  -- contar como saudavel. E por isso que ligar o agendador nao produz um
  -- alerta retroativo sobre as horas em que ele estava legitimamente
  -- parado.
  --
  -- NAO e latencia prometida a ninguem: `QUESTION_CAPTURE_SLA` continua
  -- deferido como decisao de produto, e confundir os dois faria uma
  -- fronteira tecnica virar compromisso comercial por descuido.
  esperado_desde timestamptz null,

  criado_em   timestamptz not null default now(),
  -- Sem trigger: este projeto nao tem nenhum. Quem escreve atualiza.
  alterado_em timestamptz not null default now(),

  constraint agente_ingestao_estado_esperado_pk
    primary key (agente_id, plataforma, recurso),

  -- ── Cerca de dono ─────────────────────────────────────────────────
  --
  -- A mesma FK composta do cursor, apoiada em `agentes_id_por_dono`. O
  -- `user_id` existe aqui para que a cerca possa existir — nao para ser
  -- aceito de quem chama. A camada de dominio o DERIVA do agente; um
  -- chamador que pudesse informa-lo escolheria a autoridade.
  constraint agente_ingestao_estado_esperado_agente_do_mesmo_dono
    foreign key (agente_id, user_id)
    references public.agentes (id, user_id)
    on update restrict on delete restrict,

  -- ── Esperar execucao EXIGE dizer desde quando ────────────────────
  --
  -- `esperado_ativo` sem `esperado_desde` obrigaria o vigia a inventar
  -- uma fronteira — provavelmente "agora", provavelmente no meio de um
  -- bucket — e a primeira avaliacao cobraria uma varredura que nunca foi
  -- pedida. Fechado no banco porque o defeito seria silencioso.
  constraint agente_ingestao_estado_esperado_ativo_exige_desde
    check (esperado_ativo = false or esperado_desde is not null),

  constraint agente_ingestao_estado_esperado_tempos_coerentes
    check (alterado_em >= criado_em),

  -- O par canonico, igual ao do cursor: uma configuracao de
  -- `(shopee, perguntas)` neste caminho seria um requisito que a Funcao
  -- de perguntas do ML nunca vai atender.
  constraint agente_ingestao_estado_esperado_requisito_conhecido
    check (plataforma = 'mercado_livre' and recurso = 'perguntas')
);

-- ── Por que NAO ha CHECK de alinhamento ao bucket ────────────────────
--
-- Seria facil exigir que `esperado_desde` caia numa fronteira de cinco
-- minutos, e seria o mesmo erro que `20261011` recusou para
-- `PAGE_LIMIT`: cinco minutos e a CADENCIA, uma constante de dominio que
-- vive no cron do orquestrador e muda com ele. Um CHECK amarrado a ela
-- transformaria um ajuste de agendamento numa migration e — pior — um
-- valor legitimo gravado sob a cadencia antiga passaria a ser recusado
-- na leitura seguinte. O alinhamento e regra de quem calcula a janela, e
-- e a camada de dominio que o aplica na escrita.

comment on table public.agente_ingestao_estado_esperado is
  'Se o agendador de ingestao de perguntas DEVERIA estar rodando, por agente. E INTENCAO declarada, nao observacao: `agente_acao_execucoes` diz o que aconteceu, o cursor diz o que fazer em seguida, e esta tabela diz o que era para estar acontecendo. Existe para que um vigia saiba distinguir "parou" de "nunca comecou". Linha AUSENTE nao significa desligado — significa configuracao ausente, e a camada de dominio devolve esse terceiro estado em vez de um booleano.';

comment on column public.agente_ingestao_estado_esperado.esperado_ativo is
  'Intencao declarada do operador. Sem `default` de proposito: uma linha sem intencao nao e uma decisao de desligar.';

comment on column public.agente_ingestao_estado_esperado.esperado_desde is
  'Primeiro instante a partir do qual faz sentido cobrar varredura — a fronteira da observacao, nunca uma latencia prometida. Buckets anteriores nao sao avaliados. Obrigatorio quando `esperado_ativo`.';

-- ── Privilegios ──────────────────────────────────────────────────────
--
-- Os REVOKE nominais nao sao redundancia de `from public`: `PUBLIC` e
-- pseudo-role distinto de `anon` e `authenticated`, e este projeto tem
-- `ALTER DEFAULT PRIVILEGES` concedendo privilegio a eles em objeto
-- novo. Foi o que causou o bug SEC1.
revoke all on table public.agente_ingestao_estado_esperado from public;
revoke all on table public.agente_ingestao_estado_esperado from anon;
revoke all on table public.agente_ingestao_estado_esperado from authenticated;
revoke all on table public.agente_ingestao_estado_esperado from service_role;

-- SELECT para o vigia ler; INSERT e UPDATE para o operador declarar. Nao
-- ha caminho de usuario final para esta tabela: ela e infraestrutura
-- interna, e nenhuma rota publica a alcanca.
grant select, insert, update on table public.agente_ingestao_estado_esperado to service_role;

-- Cinto e suspensorio, como nas tabelas vizinhas. DELETE nao entra:
-- desligar a observacao e `esperado_ativo = false` na MESMA linha, o que
-- preserva `criado_em` e o rastro de `alterado_em`. Apagar perderia os
-- dois e devolveria o estado a "configuracao ausente", que significa
-- outra coisa.
revoke delete, truncate on table public.agente_ingestao_estado_esperado from service_role;
