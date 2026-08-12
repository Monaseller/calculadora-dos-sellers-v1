-- ────────────────────────────────────────────────────────────────────
-- Migration: Pipeline Orchestrator — Fase 1 (schema)
--
-- Especificação oficial: ESTUDIO_ANUNCIOS_PIPELINE_ARQUITETURA.md
-- (Revisão 2, 2026-08-04) + decisões congeladas da tarefa de
-- implementação (2026-08-05).
--
-- 3 tabelas novas:
--   1) estudio_anuncios_pipeline            — 1 linha por projeto, estado do orquestrador
--   2) estudio_anuncios_pipeline_catalogo   — catálogo de ETAPAS AMPLAS (única fonte de
--      verdade — TypeScript e as RPCs leem daqui, sem duplicar IF/CASE em duas linguagens)
--   3) estudio_anuncios_pipeline_catalogo_jobs — ADIÇÃO NÃO PEDIDA EXPLICITAMENTE na
--      primeira rodada, sinalizada no chat antes da 1ª execução: a tabela de catálogo
--      pedida não tinha como representar "quais valores de estudio_anuncios_jobs.etapa,
--      em que ordem, compõem uma etapa ampla" (ex.: GERAR_CONTEUDO = geracao_conteudo →
--      revisao_claude → adaptacao_marketplace). Sem isso, a RPC de avanço não tem como
--      decidir o próximo job dentro da mesma etapa. Companion table, mesmo princípio de
--      "fonte única no banco" da tabela principal. Nome ajustado nesta revisão (era
--      "..._subetapas", renomeada para "..._jobs" por pedido explícito — mais
--      representativo do que a tabela guarda: o mapeamento etapa → jobs).
--
-- AJUSTE DESTA REVISÃO: estudio_anuncios_pipeline ganhou a coluna versao_pipeline,
-- distinta de versao_catalogo — ver comentário na própria coluna abaixo.
--
-- Nenhuma tabela existente alterada. Nenhum dado fora do catálogo (seed
-- estático, não é dado de projeto real) inserido.
-- ────────────────────────────────────────────────────────────────────


-- ────────────────────────────────────────────────────────────────────
-- 1) estudio_anuncios_pipeline
-- ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS estudio_anuncios_pipeline (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- 1 pipeline por projeto (não 1 por etapa) — representa o estado do
  -- PROJETO, nunca substitui estudio_anuncios_jobs.
  projeto_id        UUID NOT NULL UNIQUE REFERENCES estudio_anuncios_projetos(id) ON DELETE CASCADE,

  -- Valor de EtapaPipeline (etapa AMPLA, ex. 'gerar_conteudo') — NULL
  -- até a 1ª etapa ser decidida. A SUBETAPA em andamento (valor técnico
  -- de estudio_anuncios_jobs.etapa) NUNCA é duplicada aqui — é obtida
  -- via job_atual_id (Decisão 7 da arquitetura).
  etapa_atual       TEXT,

  status            TEXT NOT NULL DEFAULT 'criado' CHECK (status IN (
                      'criado', 'aguardando', 'em_execucao',
                      'aguardando_pendencias', 'concluido', 'erro',
                      'cancelado', 'pausado'
                    )),

  job_atual_id      UUID REFERENCES estudio_anuncios_jobs(id) ON DELETE SET NULL,

  -- Cache da etapa AMPLA seguinte — sempre recalculável a partir do
  -- catálogo, nunca fonte de verdade por si só.
  proxima_etapa     TEXT,

  -- Versão do CATÁLOGO (definição das etapas) com que este pipeline
  -- nasceu — nunca muda depois de setado (Decisão 5). Trava o pipeline
  -- nas regras dessa versão, mesmo que o catálogo evolua depois.
  versao_catalogo   INTEGER NOT NULL DEFAULT 1,

  -- Versão do FLUXO do Pipeline em si — conceito DISTINTO de
  -- versao_catalogo, por pedido explícito (não reutilizar um pelo
  -- outro). versao_catalogo descreve QUAIS etapas existem e em que
  -- ordem (dado); versao_pipeline descreve qual versão da MÁQUINA DE
  -- ESTADOS/COMPORTAMENTO DAS RPCs (lib/estudio-anuncios/pipeline/
  -- maquina-estados.ts + a lógica de estudio_anuncios_pipeline_avancar/
  -- _registrar_falha) processou este pipeline — útil se um dia as
  -- próprias RPCs ganharem uma segunda versão de comportamento
  -- (ex.: suporte a paralelismo real) sem que isso exija recriar o
  -- catálogo. Não usado para nenhuma lógica condicional nesta fase —
  -- só registrado.
  versao_pipeline   INTEGER NOT NULL DEFAULT 1,

  ultima_execucao   TIMESTAMPTZ,
  proxima_execucao  TIMESTAMPTZ,   -- reservado (retry com atraso) — não usado na Fase 1

  erro_tipo         TEXT,
  erro_mensagem     TEXT,

  criado_em         TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em     TIMESTAMPTZ NOT NULL DEFAULT now(),
  concluido_em      TIMESTAMPTZ,
  cancelado_em      TIMESTAMPTZ,

  -- Decisão 5: concluído e cancelado são mutuamente exclusivos —
  -- nunca os dois preenchidos ao mesmo tempo.
  CONSTRAINT chk_pipeline_concluido_xor_cancelado
    CHECK (NOT (concluido_em IS NOT NULL AND cancelado_em IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_estudio_anuncios_pipeline_status
  ON estudio_anuncios_pipeline (status);

COMMENT ON TABLE estudio_anuncios_pipeline IS
  'Estado do orquestrador — 1 linha por projeto. Nunca substitui estudio_anuncios_jobs (a fila de execução real). Toda escrita passa pelas RPCs estudio_anuncios_pipeline_avancar()/estudio_anuncios_pipeline_registrar_falha(), nunca por UPDATE solto da aplicação.';


-- ────────────────────────────────────────────────────────────────────
-- 2) estudio_anuncios_pipeline_catalogo
--    Única fonte de verdade da definição de etapas — TypeScript e as
--    RPCs leem daqui. versao_catalogo permite evoluir o fluxo sem
--    quebrar pipelines antigos (eles continuam presos à versão com que
--    nasceram, via estudio_anuncios_pipeline.versao_catalogo).
-- ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS estudio_anuncios_pipeline_catalogo (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  versao_catalogo     INTEGER NOT NULL DEFAULT 1,

  ordem               INTEGER NOT NULL CHECK (ordem > 0),

  -- Valor de EtapaPipeline — TEXT (não FK/enum) para o catálogo poder
  -- crescer sem migration de tipo. Validado em aplicação/comentário,
  -- não por CHECK fechado — o catálogo é o próprio ponto de extensão.
  etapa               TEXT NOT NULL,

  ativa               BOOLEAN NOT NULL DEFAULT true,

  tipo                TEXT NOT NULL CHECK (tipo IN ('obrigatoria', 'condicional', 'manual')),

  -- Etapas (valores de "etapa" desta mesma tabela, mesma versao_catalogo)
  -- que precisam estar concluídas antes desta rodar. Não é FK (arrays
  -- não suportam FK de elemento no Postgres) — validado por convenção/
  -- revisão manual do catálogo, não pelo banco.
  depende_de          TEXT[] NOT NULL DEFAULT '{}',

  usa_gateway         BOOLEAN NOT NULL DEFAULT false,
  gera_arquivos       BOOLEAN NOT NULL DEFAULT false,
  permite_paralelismo BOOLEAN NOT NULL DEFAULT false,

  -- NULL = sem timeout (usado por 'pendencias', que espera ação humana
  -- por tempo indeterminado).
  timeout_ms          INTEGER CHECK (timeout_ms IS NULL OR timeout_ms > 0),

  max_tentativas      INTEGER NOT NULL DEFAULT 3 CHECK (max_tentativas > 0),

  criado_em           TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em       TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (versao_catalogo, etapa),
  UNIQUE (versao_catalogo, ordem)
);

COMMENT ON TABLE estudio_anuncios_pipeline_catalogo IS
  'Catálogo de etapas AMPLAS do Pipeline — única fonte de verdade (Decisão 3), lida por TypeScript e pelas RPCs. Nunca duplicar esta definição em código.';


-- ────────────────────────────────────────────────────────────────────
-- 3) estudio_anuncios_pipeline_catalogo_jobs
--    Companion table (ver nota no cabeçalho) — mapeia cada etapa AMPLA
--    para os valores reais de estudio_anuncios_jobs.etapa que a
--    compõem, em ordem. 'pendencias' e 'exportacao' (Fase 1) não têm
--    linhas aqui — a primeira é um gate manual sem job, a segunda está
--    inativa no catálogo.
-- ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS estudio_anuncios_pipeline_catalogo_jobs (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  catalogo_id         UUID NOT NULL REFERENCES estudio_anuncios_pipeline_catalogo(id) ON DELETE CASCADE,

  ordem               INTEGER NOT NULL CHECK (ordem > 0),

  -- Precisa bater com um valor aceito pelo CHECK de
  -- estudio_anuncios_jobs.etapa — não validado por FK (jobs.etapa é
  -- TEXT com CHECK, não uma tabela de domínio), só por convenção e
  -- revisão manual do catálogo.
  job_etapa           TEXT NOT NULL,

  obrigatoria         BOOLEAN NOT NULL DEFAULT true,

  -- Reservado — Fase 1 é inteiramente sequencial (Decisão congelada
  -- #1). Nenhuma lógica de repetição por quantidade (N imagens, N
  -- vídeos) é implementada nesta migration nem nas RPCs abaixo.
  permite_multiplos   BOOLEAN NOT NULL DEFAULT false,

  criado_em           TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (catalogo_id, ordem),
  UNIQUE (catalogo_id, job_etapa)
);

COMMENT ON TABLE estudio_anuncios_pipeline_catalogo_jobs IS
  'Mapeamento etapa AMPLA → estudio_anuncios_jobs.etapa, em ordem. Ver nota de adição no cabeçalho desta migration — não fazia parte da lista de colunas originalmente pedida para o catálogo.';


-- ────────────────────────────────────────────────────────────────────
-- Seed — versao_catalogo = 1
--
-- Reflete o mapeamento aprovado na Revisão 2 da arquitetura (seção 4).
-- Fase 1 é sequencial e só "tipo='obrigatoria'" avança automaticamente
-- (ver explicação completa no chat, não só neste comentário) — por
-- isso 'pendencias' (manual) e 'gerar_video'/'exportacao' (condicional)
-- ficam no catálogo (arquitetura pronta para o futuro) mas NÃO são
-- percorridas automaticamente pela RPC nesta fase.
--
-- usa_gateway=true em 'avaliacao': PREMISSA NÃO CONFIRMADA — calculo_score
-- pode ou não precisar do AI Gateway (não decidido em nenhum documento
-- anterior). Sinalizado explicitamente, não é uma decisão silenciosa.
-- ────────────────────────────────────────────────────────────────────
INSERT INTO estudio_anuncios_pipeline_catalogo
  (versao_catalogo, ordem, etapa, ativa, tipo, depende_de, usa_gateway, gera_arquivos, permite_paralelismo, timeout_ms, max_tentativas)
VALUES
  (1, 1, 'analise_produto', true,  'obrigatoria', '{}',                 true,  false, false, 120000, 3),
  (1, 2, 'pendencias',      true,  'manual',      '{analise_produto}',  false, false, false, NULL,   1),
  (1, 3, 'gerar_conteudo',  true,  'obrigatoria', '{analise_produto}',  true,  false, false, 180000, 3),
  (1, 4, 'gerar_imagens',   true,  'obrigatoria', '{gerar_conteudo}',   true,  true,  true,  300000, 3),
  (1, 5, 'gerar_video',     true,  'condicional', '{gerar_conteudo}',   true,  true,  true,  600000, 3),
  (1, 6, 'avaliacao',       true,  'obrigatoria', '{gerar_conteudo}',   true,  false, false, 60000,  3),
  (1, 7, 'exportacao',      false, 'condicional', '{avaliacao}',        false, true,  false, 300000, 3)
ON CONFLICT (versao_catalogo, etapa) DO NOTHING;

INSERT INTO estudio_anuncios_pipeline_catalogo_jobs (catalogo_id, ordem, job_etapa, obrigatoria, permite_multiplos)
SELECT c.id, s.ordem, s.job_etapa, s.obrigatoria, s.permite_multiplos
FROM estudio_anuncios_pipeline_catalogo c
JOIN (VALUES
  ('analise_produto', 1, 'analise_visual', true,  false),
  ('analise_produto', 2, 'busca_externa',  false, false),   -- condicional — nunca disparada automaticamente na Fase 1 (Decisão congelada #4)
  ('gerar_conteudo',  1, 'geracao_conteudo', true, false),
  ('gerar_conteudo',  2, 'revisao_claude',   true, false),
  ('gerar_conteudo',  3, 'adaptacao_marketplace', true, false),
  ('gerar_imagens',   1, 'geracao_prompts_imagem', true, false),
  ('gerar_imagens',   2, 'geracao_imagem',  true,  true),    -- permite_multiplos=true, mas Fase 1 trata como execução única (Decisão congelada #1)
  ('gerar_video',     1, 'geracao_roteiro_video', true, false),
  ('gerar_video',     2, 'geracao_video',   true,  true),
  ('avaliacao',       1, 'calculo_score',   true,  false)
) AS s(etapa, ordem, job_etapa, obrigatoria, permite_multiplos)
  ON s.etapa = c.etapa
WHERE c.versao_catalogo = 1
ON CONFLICT (catalogo_id, ordem) DO NOTHING;

-- 'exportacao' (etapa) fica sem linha em catalogo_jobs — o job
-- 'exportacao' nem existe ainda no CHECK de estudio_anuncios_jobs.etapa
-- (Decisão congelada #4 do documento de arquitetura). Nada a preparar
-- aqui além do lugar reservado na tabela pai.
