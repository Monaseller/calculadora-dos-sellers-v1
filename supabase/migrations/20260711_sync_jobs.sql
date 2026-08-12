-- ============================================================
-- Migração: sync_jobs (fila persistente de sincronização)
-- Gerado em: 2026-07-11
-- Contexto: redesenho do botão "Sincronizar" da tela Vendas
-- (docs/DECISIONS.md — correção do bug de faturamento caindo por timeout
-- parcial de um marketplace). Substitui o disparo de sync embutido dentro
-- da rota HTTP de leitura (app/api/ml/vendas, app/api/shopee/vendas) por
-- um job assíncrono processado por um worker separado
-- (scripts/sync-worker.mjs), fora do ciclo de vida de qualquer requisição
-- HTTP — decisão explícita do usuário: "NÃO USAR FIRE-AND-FORGET DENTRO
-- DA ROTA HTTP".
--
-- NÃO EXECUTADO AINDA. Aguardando revisão final do usuário antes de rodar
-- no Supabase SQL Editor.
--
-- O QUE ESTA MIGRATION FAZ:
--   - Cria a tabela sync_jobs (fila de jobs de sincronização).
--   - Cria índice único parcial que impede 2 jobs ativos (pendente/rodando)
--     para a mesma loja simultaneamente.
--   - Cria índices de apoio para o polling do worker e do frontend.
--   - Cria a função claim_next_sync_job(), que faz a aquisição atômica de
--     um job pendente via FOR UPDATE SKIP LOCKED — impede que dois
--     workers peguem a mesma linha ao mesmo tempo (problema diferente do
--     índice único acima, que só impede duplicidade por loja).
--
-- O QUE ESTA MIGRATION NÃO FAZ:
--   - Não altera pedidos, lojas, dashboard_resumos_diarios ou qualquer
--     tabela/regra financeira existente.
--   - Não cria policy de RLS baseada em usuário (ver justificativa abaixo).
-- ============================================================

CREATE TABLE IF NOT EXISTS sync_jobs (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Dono do job (mesmo formato usado em pedidos.user_id — TEXT, não uuid;
  -- este projeto não usa Supabase Auth, ver lib/session.ts).
  user_id        TEXT NOT NULL,

  -- Loja alvo. Referência estável (ver docs/DECISIONS.md "loja_id como
  -- referência principal"). Todo job é sempre de UMA loja específica —
  -- nunca "todas as lojas do marketplace X", mesmo antes de existir
  -- seleção múltipla de lojas na UI.
  loja_id        UUID NOT NULL REFERENCES lojas(id),

  -- Denormalizado no momento da criação do job (resolvido no servidor a
  -- partir de lojas.marketplace, nunca aceito do cliente) — evita 1 join
  -- extra no worker e na tela de status.
  marketplace    TEXT NOT NULL CHECK (marketplace IN ('ML', 'Shopee')),

  -- 'incremental': refresh cotidiano, período curto, decidido pelo
  --   servidor (ontem..hoje) — é o único tipo que POST /api/sync/iniciar
  --   (tela Vendas) pode criar.
  -- 'backfill': importação histórica de janela larga — uso
  --   interno/administrativo (script separado, não a tela Vendas). Ainda
  --   não implementado nesta fase; a coluna já existe para não exigir
  --   outra migration quando isso for construído.
  tipo           TEXT NOT NULL DEFAULT 'incremental'
                   CHECK (tipo IN ('incremental', 'backfill')),

  date_from      DATE NOT NULL,
  date_to        DATE NOT NULL CHECK (date_to >= date_from),

  status         TEXT NOT NULL DEFAULT 'pendente'
                   CHECK (status IN ('pendente', 'rodando', 'concluido', 'erro')),

  -- Retry (aprovado 2026-07-11): erro transitório incrementa tentativas e
  -- volta para 'pendente'; erro permanente (ex: credencial/loja
  -- inválida) ou tentativas esgotadas vai direto/fica em 'erro'.
  tentativas     INT NOT NULL DEFAULT 0,
  max_tentativas INT NOT NULL DEFAULT 3,

  -- Mensagem resumida, nunca payload bruto da API do marketplace nem
  -- token — ver scripts/sync-worker.mjs.
  erro_mensagem  TEXT,

  -- Classificação do erro (aprovado 2026-07-11) — não obrigatório. Serve
  -- para distinguir falha transitória de erro permanente sem depender só
  -- da mensagem em texto livre, e para futuras telas administrativas.
  -- NULL enquanto o job não falhou. CHECK permite NULL (só restringe o
  -- valor quando preenchido).
  erro_tipo      TEXT CHECK (erro_tipo IS NULL OR erro_tipo IN
                   ('transient', 'auth', 'rate_limit', 'loja', 'validation', 'unknown')),

  criado_em      TIMESTAMPTZ NOT NULL DEFAULT now(),
  iniciado_em    TIMESTAMPTZ,
  concluido_em   TIMESTAMPTZ,

  -- Heartbeat (aprovado 2026-07-11): substitui timeout fixo a partir de
  -- iniciado_em. O worker atualiza este campo a cada ~30s enquanto
  -- processa. Um job só é considerado abandonado quando heartbeat_em
  -- estiver mais velho que SYNC_JOB_STALE_MINUTES (env var, default 10) —
  -- não quando iniciado_em for antigo. Isso permite sincronizações
  -- legitimamente longas sem serem encerradas incorretamente.
  heartbeat_em   TIMESTAMPTZ
);

-- Lock por loja: nunca 2 jobs ativos (pendente OU rodando) para a mesma
-- loja ao mesmo tempo. Mecanismo diferente do claim atômico abaixo — este
-- índice resolve "duplicidade de job por loja", o claim resolve "dois
-- workers pegando o mesmo job".
CREATE UNIQUE INDEX IF NOT EXISTS idx_sync_jobs_loja_ativo
  ON sync_jobs (loja_id)
  WHERE status IN ('pendente', 'rodando');

-- Polling do worker: busca do job pendente mais antigo.
CREATE INDEX IF NOT EXISTS idx_sync_jobs_status_criado
  ON sync_jobs (status, criado_em);

-- Polling do frontend / exibição por loja (GET /api/sync/status?loja_id=).
CREATE INDEX IF NOT EXISTS idx_sync_jobs_user_loja
  ON sync_jobs (user_id, loja_id, criado_em DESC);

-- Detecção de jobs abandonados (aprovado 2026-07-11): o worker consulta
-- jobs 'rodando' com heartbeat_em antigo a cada ciclo — sem este índice,
-- essa consulta seria table scan sobre sync_jobs inteira a cada poucos
-- segundos.
CREATE INDEX IF NOT EXISTS idx_sync_jobs_heartbeat
  ON sync_jobs (status, heartbeat_em);

COMMENT ON TABLE sync_jobs IS
  'Fila persistente de jobs de sincronização (tela Vendas). Substitui sync inline dentro de rota HTTP. Processada por scripts/sync-worker.mjs, um processo separado que precisa estar rodando para os jobs serem executados — ver docs/DECISIONS.md e docs/ROADMAP.md.';

-- ── RLS: decisão explícita de NÃO habilitar, com justificativa ──────────────
-- Nenhuma outra tabela deste projeto tem RLS (pedidos, lojas,
-- dashboard_resumos_diarios — confirmado via grep em supabase/migrations,
-- zero ocorrências de "ROW LEVEL SECURITY"/"CREATE POLICY"). A aplicação
-- não usa Supabase Auth (sessão é um cookie próprio lido por
-- lib/session.ts, sem JWT/auth.uid() disponível para policies). Toda
-- autorização hoje é feita em código, na API, via getUserId() + filtro
-- explícito .eq("user_id", ...) — inclusive para dados financeiros em
-- pedidos, que já são acessíveis via ANON_KEY sem RLS.
--
-- Habilitar RLS só em sync_jobs criaria uma inconsistência sem ganho real
-- de segurança (a ANON_KEY já tem acesso irrestrito a pedidos/lojas). A
-- proteção real deste desenho é outra: a SERVICE_ROLE_KEY (que ignora RLS
-- de qualquer forma) fica exclusivamente no processo do worker
-- (scripts/sync-worker.mjs), nunca no browser/frontend; e o
-- POST /api/sync/iniciar (usando ANON_KEY, como todas as outras rotas)
-- valida loja_id.user_id = sessão ANTES de inserir o job — mesmo padrão
-- de autorização já usado em todo o resto do projeto.
--
-- Se no futuro este projeto migrar para Supabase Auth de verdade, RLS
-- deveria ser reavaliado para TODAS as tabelas de uma vez, não só esta.

-- ── Claim atômico (aprovado 2026-07-11: FOR UPDATE SKIP LOCKED) ────────────
-- Resolve "dois workers pegam o mesmo job pendente ao mesmo tempo" —
-- problema diferente do índice único acima (que resolve "duplicidade de
-- job por loja"). A seleção com FOR UPDATE SKIP LOCKED + o UPDATE que
-- marca 'rodando' rodam dentro da mesma função (mesma transação
-- implícita da chamada RPC) — atômico por construção, sem código de
-- aplicação decidindo "SELECT depois UPDATE" em dois passos separados.
--
-- RETURNS sync_jobs (não SETOF, ajustado 2026-07-11): a função nunca
-- devolve mais de uma linha — SETOF sugeria um resultado em lista sem
-- necessidade. Retorna uma única linha (composite), ou NULL quando não
-- há job pendente.
CREATE OR REPLACE FUNCTION claim_next_sync_job()
RETURNS sync_jobs
LANGUAGE plpgsql
AS $$
DECLARE
  v_job sync_jobs;
BEGIN
  SELECT * INTO v_job
  FROM sync_jobs
  WHERE status = 'pendente'
  ORDER BY criado_em ASC
  FOR UPDATE SKIP LOCKED
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  UPDATE sync_jobs
  SET status       = 'rodando',
      iniciado_em  = now(),
      heartbeat_em = now()
  WHERE id = v_job.id
  RETURNING * INTO v_job;

  RETURN v_job;
END;
$$;

COMMENT ON FUNCTION claim_next_sync_job() IS
  'Aquisição atômica do próximo job pendente (FOR UPDATE SKIP LOCKED). Retorna uma única linha (sync_jobs) ou NULL se não houver job pendente. Chamada exclusivamente pelo worker (scripts/sync-worker.mjs) via service role key.';

-- Só o worker (service role) pode chamar esta função — nunca a API
-- pública (ANON_KEY) nem o frontend.
--
-- CORREÇÃO REGISTRADA EM 2026-08-03 (não reexecute este arquivo — a
-- correção já foi aplicada separadamente no banco, este comentário só
-- mantém o arquivo local fiel ao estado real): validação de leitura
-- durante a Fase 0 da Central de IA encontrou EXECUTE concedido também
-- a anon e authenticated nesta função, mesmo com o REVOKE FROM PUBLIC
-- abaixo — causa: uma regra de ALTER DEFAULT PRIVILEGES no schema
-- public deste projeto Supabase concede EXECUTE automaticamente a
-- anon/authenticated/service_role em toda função nova, no momento da
-- criação, independente do REVOKE FROM PUBLIC (que só afeta o
-- pseudo-role PUBLIC). Corrigido em produção com:
--   REVOKE EXECUTE ON FUNCTION public.claim_next_sync_job()
--   FROM PUBLIC, anon, authenticated;
--   GRANT EXECUTE ON FUNCTION public.claim_next_sync_job()
--   TO service_role;
-- Validado por leitura (information_schema.routine_privileges) e por
-- impersonação transacional (SET LOCAL ROLE anon/authenticated dentro
-- de BEGIN/ROLLBACK, retornando 42501 permission denied nos dois
-- casos). Ver docs/BUGS.md e docs/CHANGELOG.md.
REVOKE EXECUTE ON FUNCTION claim_next_sync_job() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION claim_next_sync_job() TO service_role;
