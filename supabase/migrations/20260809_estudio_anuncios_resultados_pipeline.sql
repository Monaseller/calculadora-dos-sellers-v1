-- supabase/migrations/20260809_estudio_anuncios_resultados_pipeline.sql
-- Resultado estruturado real de qualquer etapa do Pipeline — genérica
-- de propósito, para não precisar de tabela nova a cada etapa que
-- passar a ter saída estruturada real. Nesta tarefa, só analise_visual
-- grava aqui de fato; as outras etapas continuam fake, sem gravar
-- nesta tabela só porque ela existe.

CREATE TABLE IF NOT EXISTS estudio_anuncios_resultados_pipeline (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  projeto_id     UUID NOT NULL REFERENCES estudio_anuncios_projetos(id) ON DELETE CASCADE,
  job_id         UUID NOT NULL REFERENCES estudio_anuncios_jobs(id) ON DELETE CASCADE,

  -- Domínio derivado de estudio_anuncios_jobs.etapa, com UMA exclusão
  -- intencional: 'ping'. Decisão (2026-08-05): ping é etapa exclusiva
  -- de teste de infraestrutura, não representa resultado de negócio,
  -- não produz saída estruturada útil ao usuário, e não deve aparecer
  -- em consultas futuras de conteúdo/análise/imagens/vídeos/agentes —
  -- seus registros de teste, quando necessários, continuam vivendo em
  -- central_ia_prompts/central_ia_consumo, nunca aqui. Novas etapas
  -- FUNCIONAIS (ex.: vídeo, agentes futuros) exigem nova migration
  -- para entrar neste CHECK — etapas técnicas/infra nunca devem ser
  -- adicionadas aqui automaticamente.
  etapa          TEXT NOT NULL CHECK (etapa IN (
                    'analise_visual', 'busca_externa', 'geracao_conteudo',
                    'revisao_claude', 'adaptacao_marketplace',
                    'geracao_prompts_imagem', 'geracao_imagem',
                    'geracao_roteiro_video', 'geracao_video',
                    'atualizacao_pos_pendencia', 'calculo_score'
                  )),

  provedor       TEXT NOT NULL CHECK (provedor IN ('openai', 'anthropic', 'google', 'fake', 'internal')),
  modelo         TEXT NOT NULL,

  schema_versao  INTEGER NOT NULL DEFAULT 1 CHECK (schema_versao > 0),

  resultado      JSONB NOT NULL CHECK (jsonb_typeof(resultado) = 'object'),

  criado_em      TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (job_id)
);

CREATE INDEX IF NOT EXISTS idx_resultados_pipeline_projeto_etapa
  ON public.estudio_anuncios_resultados_pipeline (projeto_id, etapa, criado_em DESC);

COMMENT ON TABLE estudio_anuncios_resultados_pipeline IS
  'Resultado estruturado real de qualquer etapa do Pipeline, 1 por job (UNIQUE job_id), nunca UPDATE. Genérica por propósito — evita 1 tabela nova por etapa. Domínio de "etapa" derivado de estudio_anuncios_jobs.etapa, com exclusão intencional de "ping" (etapa de teste de infraestrutura, sem resultado de domínio — ver comentário da coluna etapa). Novas etapas funcionais exigem migration; etapas técnicas nunca são adicionadas automaticamente. provedor aceita fake/internal para evitar migration futura quando um teste controlado ou saída interna precisar ser persistida aqui, mas nesta tarefa só google (analise_visual) grava de fato. schema_versao permite evoluir o contrato JSON de cada etapa sem quebrar leitura de registros antigos. Distinta de estudio_anuncios_entradas_produto (ficha editável pelo usuário) e estudio_anuncios_conteudo_versoes (conteúdo de anúncio por marketplace, etapa posterior).';

COMMENT ON COLUMN estudio_anuncios_resultados_pipeline.etapa IS
  'Mesmo domínio de estudio_anuncios_jobs.etapa, EXCETO "ping" — exclusão intencional (2026-08-05): ping é etapa exclusiva de teste de infraestrutura, não representa resultado de negócio, não produz saída estruturada útil ao usuário, e não deve poluir consultas futuras de conteúdo/análise/imagens/vídeos/agentes. Testes de ping, quando necessários, continuam registrados em central_ia_prompts/central_ia_consumo, nunca aqui. Novas etapas FUNCIONAIS exigem nova migration para entrar neste CHECK; etapas técnicas/infra nunca são adicionadas automaticamente.';

COMMENT ON COLUMN estudio_anuncios_resultados_pipeline.schema_versao IS
  'Versão do contrato JSON de "resultado" para esta etapa, definida exclusivamente pelo servidor (nunca pelo modelo de IA). Começa em 1.';

COMMENT ON COLUMN estudio_anuncios_resultados_pipeline.provedor IS
  'Mesmo domínio de estudio_anuncios_jobs.provedor. fake/internal aceitos por flexibilidade futura, mas não usados por analise_visual nesta tarefa.';
