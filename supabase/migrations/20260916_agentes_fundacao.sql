-- =====================================================================
-- AGENTES-FASE1B — FUNDACAO UNIVERSAL DE AGENTES (2 TABELAS)
-- =====================================================================
--
-- 1. O QUE ESTA MIGRATION E, E O QUE ELA DELIBERADAMENTE NAO E
-- ---------------------------------------------------------------------
-- Cria a persistencia minima do CDS AI Office: a IDENTIDADE do agente
-- (`agentes`) e o REGISTRO DE TRABALHO dele (`agente_tarefas`).
--
-- Nao ha worker, nao ha RPC de claim, nao ha IA, nao ha integracao de
-- mensagens, nao ha n8n, nao ha tabela de memoria/chat/tools. Nenhuma
-- rota e nenhum componente consome estas tabelas ainda. Elas nascem
-- vazias e sem consumidor — que e exatamente por que esta fase vem
-- ANTES de qualquer dado existir: enquanto as tabelas estao vazias, o
-- rollback e um `DROP TABLE` e a correcao de um CHECK apertado demais e
-- um `ALTER ... DROP CONSTRAINT`. Depois do primeiro dado real, nao e
-- mais nenhuma das duas coisas.
--
-- 2. POR QUE `agentes` NAO TEM COLUNA `status`
-- ---------------------------------------------------------------------
-- Persistir `status` ao lado de `ativo` criaria DUAS fontes de verdade
-- para a mesma pergunta — `ativo = false` e `status = 'desativado'`
-- podendo divergir, sem que o banco possa impedir. Nesta fase o agente e
-- CONFIGURACAO/IDENTIDADE; `ativo` e a unica persistencia de
-- ativacao/desativacao.
--
-- O estado operacional (`idle`, `ocupado`, `erro`,
-- `aguardando_aprovacao`) e DERIVADO das tarefas, por funcao pura, em
-- `lib/agentes/tipos.ts::derivarStatusAgente`. Derivado nunca diverge.
--
-- `thinking` / `using_tool` nao existem aqui nem como coluna nem como
-- estado: sao apresentacao, derivados de `progresso` na UI. Persistir
-- apresentacao obrigaria o worker a escrever a cada passo, sem ganho.
--
-- 3. A FK COMPOSTA — ISOLAMENTO DE TENANT NO PROPRIO BANCO
-- ---------------------------------------------------------------------
-- `agente_tarefas` carrega `agente_id` E `user_id`. A capability filtra
-- por `user_id`, mas filtro e disciplina de aplicacao. A FK composta
-- torna ESTRUTURALMENTE impossivel a combinacao:
--
--     agente_id pertencente ao usuario A
--   + user_id   pertencente ao usuario B
--
-- O par (agente_id, user_id) precisa existir em `agentes`. Isso vale
-- inclusive para SQL direto com service_role — nao depende de nenhuma
-- linha de TypeScript estar correta.
--
-- ── VALIDADO NO POSTGRES, NAO PRESUMIDO ─────────────────────────────
-- A constraint alvo e `UNIQUE (user_id, id)`, com as colunas em ordem
-- INVERSA em relacao ao `REFERENCES agentes (id, user_id)`. Isso e
-- valido: o Postgres casa as colunas referenciadas por CONJUNTO, nao por
-- ordem. Nao foi presumido — foi provado em `pg_temp` (PostgreSQL
-- 17.6.1.127, sessao `postgres`, nada tocando `public`), com 6 casos:
--
--   1. a DDL e aceita; `pg_get_constraintdef` devolve
--      "FOREIGN KEY (agente_id, user_id) REFERENCES ...(id, user_id)
--       ON UPDATE RESTRICT ON DELETE RESTRICT"
--   2. tarefa cross-tenant (agente de A + user_id de B) .... 23503
--   3. CONTROLE NEGATIVO: par coerente (A + A) ............. ACEITO
--   4. UPDATE do dono do agente com tarefa existente ....... 23503
--   5. DELETE do agente com tarefa existente ............... 23503
--   6. user_id NULL na tarefa ............................. 23502
--
-- O caso 3 e o que impede a sonda de "passar" por estar rejeitando tudo.
--
-- ── A ORDEM (user_id, id) NAO E ESTETICA ────────────────────────────
-- Uma constraint UNIQUE cria um indice B-tree. Com `user_id` a ESQUERDA,
-- esse mesmo indice atende `listarAgentesDoDono`. Se a ordem fosse
-- (id, user_id), `id` ficaria na frente, o indice seria inutil para
-- filtrar por dono, e seria preciso criar um segundo indice so para isso.
-- Uma constraint, dois usos.
--
-- ── A ARMADILHA DO MATCH SIMPLE ─────────────────────────────────────
-- O modo default de FK composta e MATCH SIMPLE: se QUALQUER coluna da
-- chave for NULL, a FK inteira NAO E VERIFICADA e a linha entra sem que
-- o par exista em `agentes`. Aqui o caso e inalcancavel porque
-- `agente_id` e `user_id` sao ambas NOT NULL (caso 6 da sonda).
--
-- A garantia de tenant depende, portanto, dos NOT NULL — nao da FK
-- sozinha. Afrouxar um deles "so para um caso" derruba a protecao em
-- silencio. Esta e a razao de o comentario existir.
--
-- 4. RESTRICT EM VEZ DE CASCADE — DECISAO EXPLICITA
-- ---------------------------------------------------------------------
-- `ON DELETE RESTRICT`: historico operacional nao e apagavel por efeito
-- colateral. Retirar um agente de operacao e `ativo = false`, nunca
-- DELETE. Nao ha CASCADE em lugar nenhum deste arquivo.
--
-- `ON UPDATE RESTRICT`: impede transferir um agente de dono enquanto ele
-- tiver tarefas. Sem isso, `UPDATE agentes SET user_id = 'B'` produziria
-- exatamente a inconsistencia que a FK existe para proibir, so que pela
-- outra ponta — as tarefas continuariam com o dono antigo.
--
-- Efeito colateral aceito e conhecido: em desenvolvimento, apagar um
-- agente de teste passa a exigir apagar as tarefas ANTES. E o
-- comportamento pedido, nao um defeito.
--
-- 5. UM UNICO CREATE INDEX EXPLICITO
-- ---------------------------------------------------------------------
-- Regra aplicada: so entra indice que uma das 7 operacoes da capability
-- realmente usa. O que ficou de fora, e por que:
--
--   (user_id) em agentes ......... o UNIQUE (user_id, id) ja atende
--                                  `listarAgentesDoDono`. Cria-lo seria
--                                  indice redundante.
--   (user_id, criado_em) em tarefas  nenhuma das 7 operacoes filtra por
--                                  `user_id` isolado —
--                                  `listarTarefasDoAgente` sempre tem
--                                  `agente_id`. Indice sem consumidor.
--   fila (status, criado_em) ..... pertence ao `claim` da FASE 1C.
--   heartbeat (status, heartbeat_em)  idem.
--
-- Os dois ultimos viajam junto com `claim_next_agente_tarefa()` na 1C.
-- A COLUNA `heartbeat_em` fica desde ja — acrescenta-la depois obrigaria
-- a alterar o claim atomico ja em uso, que e justamente o que nao pode
-- mudar sob concorrencia.
--
-- O unico indice criado, `idx_agente_tarefas_agente`, tem DOIS usos:
-- serve `listarTarefasDoAgente` e serve a verificacao do RESTRICT. O
-- Postgres NAO indexa o lado referenciante de uma FK; sem ele, todo
-- DELETE/UPDATE em `agentes` faria seq scan em `agente_tarefas`.
--
-- 6. PRIVILEGIOS — POR QUE NAO HA UM UNICO GRANT AQUI
-- ---------------------------------------------------------------------
-- Nao ha GRANT, REVOKE, ALTER DEFAULT PRIVILEGES, RLS nem policy neste
-- arquivo. Isso e deliberado e foi CONFERIDO por SELECT antes de
-- escreve-lo:
--
--   - as migrations aplicam como `postgres` (`current_user` = postgres,
--     `session_user` = postgres) e todas as 33 tabelas de `public` sao
--     dele;
--   - o default ACL de `postgres` para tabelas e, hoje,
--     `{postgres=arwdDxtm/postgres, service_role=arwdDxtm/postgres}` —
--     SEM `anon` e SEM `authenticated`, resultado da SEC-1a.
--
-- Logo, estas duas tabelas NASCEM com anon = 0 e authenticated = 0, e
-- service_role integro, sem nenhum comando de privilegio. Um GRANT aqui
-- seria ruido; um REVOKE seria no-op teatral. A suite pos-migration
-- prova o resultado em vez de afirma-lo.
--
-- ATENCAO PARA O FUTURO: o default ACL de `supabase_admin` para tabelas
-- AINDA concede anon/authenticated. Se algum dia uma migration for
-- aplicada por aquele papel, tabela nova volta a nascer exposta. E o
-- ponto ainda aberto da SEC-1d, e nao e resolvido aqui.
--
-- SEM RLS: o padrao de autorizacao vigente e capability + filtro
-- explicito, e e o que as tabelas atuais seguem. Ligar RLS em duas
-- tabelas criaria dois modelos convivendo — pior do que qualquer um dos
-- dois isolado. (Ha 2 tabelas com RLS ligada e ZERO policy no schema:
-- `estudio_anuncios_pictures_marketplace` e
-- `estudio_anuncios_publicacoes`. Divergencia preexistente, fora do
-- escopo desta migration, registrada como achado.)
--
-- 7. IDEMPOTENCIA
-- ---------------------------------------------------------------------
-- `CREATE TABLE IF NOT EXISTS` e `CREATE INDEX IF NOT EXISTS`. Reaplicar
-- e seguro. LIMITE DECLARADO: se uma tabela ja existir com forma
-- DIFERENTE, o `IF NOT EXISTS` a mantem como esta, em silencio — nao ha
-- reconciliacao automatica. Baseline medida imediatamente antes:
-- `agentes` e `agente_tarefas` NAO existiam (0 de 2).
--
-- 8. BASELINE (medida READ-ONLY imediatamente antes desta migration)
-- ---------------------------------------------------------------------
--   tabelas em public ............ 33          -> esperado 35
--   grants de anon ............... 48          -> esperado 48 (inalterado)
--   tabelas com anon ............. 16          -> esperado 16 (inalterado)
--   grants de authenticated ...... 0           -> esperado 0
--   agentes/agente_tarefas ....... 0 de 2 existem
--   md5 ACL das tabelas .......... dd52115d5be086d47bd064ceebcf22de
--   md5 default privileges ....... 61a56dbbee1ebc2a9f1269050311ee83
--
-- O md5 dos default privileges deve permanecer IDENTICO. O md5 do ACL
-- MUDA (duas tabelas novas entram no agregado) — o que precisa continuar
-- igual e o ACL das 33 preexistentes, verificado em separado.
--
-- 9. ROLLBACK (MANUAL — COMENTARIO, NAO COMANDO)
-- ---------------------------------------------------------------------
-- A ORDEM IMPORTA: com ON DELETE RESTRICT, a tabela filha sai primeiro.
--
--     DROP TABLE IF EXISTS public.agente_tarefas;
--     DROP TABLE IF EXISTS public.agentes;
--
-- Trivial enquanto estiverem vazias — e e por isso que esta fase vem
-- antes de existir qualquer dado.
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.agentes (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- text, nao uuid: e o tipo predominante do schema (8 tabelas) e o que
  -- `agente_tarefas` vai cruzar com `pedidos`/`anuncios` sem cast. A
  -- divergencia com `lojas.user_id` (uuid) e divida CONHECIDA, de uma
  -- frente propria — nao se corrige de passagem aqui.
  user_id        text NOT NULL,
  nome           text NOT NULL,
  tipo           text NOT NULL,
  instrucoes     text,
  -- UNICA persistencia de ativacao/desativacao. Ver secao 2.
  ativo          boolean NOT NULL DEFAULT true,
  criado_em      timestamptz NOT NULL DEFAULT now(),
  -- Mantido pela capability, nao por trigger: esta fase nao cria trigger.
  atualizado_em  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT agentes_nome_nao_vazio CHECK (length(btrim(nome)) > 0),
  CONSTRAINT agentes_tipo_valido CHECK (
    tipo IN ('mensagens','ads','fotos','anuncios','financeiro','gerente')
  ),
  -- Alvo da FK composta de `agente_tarefas`. Ordem (user_id, id)
  -- deliberada — ver secao 3.
  CONSTRAINT agentes_id_por_dono UNIQUE (user_id, id)
);

CREATE TABLE IF NOT EXISTS public.agente_tarefas (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- NOT NULL nas duas colunas da chave composta nao e formalidade: e o
  -- que fecha o furo do MATCH SIMPLE descrito na secao 3.
  agente_id       uuid NOT NULL,
  user_id         text NOT NULL,
  tipo            text NOT NULL,
  entrada         jsonb NOT NULL DEFAULT '{}'::jsonb,
  status          text NOT NULL DEFAULT 'pendente',
  progresso       smallint NOT NULL DEFAULT 0,
  resultado       jsonb,
  erro_tipo       text,
  erro_mensagem   text,
  -- Retry e decisao do job, nunca do provedor — mesma regra do AI
  -- Gateway. Estas duas colunas sao onde essa decisao mora.
  tentativas      integer NOT NULL DEFAULT 0,
  max_tentativas  integer NOT NULL DEFAULT 3,
  criado_em       timestamptz NOT NULL DEFAULT now(),
  iniciado_em     timestamptz,
  concluido_em    timestamptz,
  -- Sem consumidor nesta fase. Existe desde ja porque acrescenta-la
  -- depois obrigaria a alterar o claim atomico da 1C. Ver secao 5.
  heartbeat_em    timestamptz,

  -- ISOLAMENTO DE TENANT NO BANCO — ver secao 3 para a prova em pg_temp.
  CONSTRAINT agente_tarefas_agente_do_mesmo_dono
    FOREIGN KEY (agente_id, user_id)
    REFERENCES public.agentes (id, user_id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,

  CONSTRAINT agente_tarefas_tipo_nao_vazio CHECK (length(btrim(tipo)) > 0),
  CONSTRAINT agente_tarefas_status_valido CHECK (
    status IN ('pendente','rodando','aguardando_aprovacao',
               'concluido','erro','cancelado')
  ),
  CONSTRAINT agente_tarefas_progresso_valido CHECK (progresso BETWEEN 0 AND 100),
  -- Estado terminal exige explicacao — mesmo padrao do CHECK condicional
  -- de `estudio_anuncios_jobs` ("concluido implica provedor NOT NULL"),
  -- que existe para impedir job terminal sem como auditar o que houve.
  CONSTRAINT agente_tarefas_erro_explicado
    CHECK (status <> 'erro' OR erro_tipo IS NOT NULL),
  CONSTRAINT agente_tarefas_concluido_completo
    CHECK (status <> 'concluido' OR progresso = 100)
);

-- UNICO indice explicito desta migration. Dois usos — ver secao 5.
CREATE INDEX IF NOT EXISTS idx_agente_tarefas_agente
  ON public.agente_tarefas (agente_id, criado_em DESC);
