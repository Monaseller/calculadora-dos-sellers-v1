-- ============================================================
-- Migração: Central de IA + Estúdio de Anúncios (schema completo, Fase 0)
-- Gerado em: 2026-08-03 · Revisado em: 2026-08-03 (2ª versão, pós-revisão)
--
-- Contexto: novo módulo, planejado em 3 documentos (nenhum reescrito,
-- cada um é um adendo ao anterior):
--   - ESTUDIO_ANUNCIOS_IA_PLANEJAMENTO.md            (documento 1)
--   - ESTUDIO_ANUNCIOS_IA_REVISAO_UX.md              (documento 2)
--   - ESTUDIO_ANUNCIOS_IA_CONSOLIDACAO_ARQUITETURA.md (documento 3)
--
-- NÃO EXECUTADO AINDA. Aguardando revisão e aprovação explícita do
-- usuário antes de rodar no Supabase SQL Editor — mesmo processo já
-- usado em `loja_id_pedidos`, `dashboard_resumos_diarios` e `sync_jobs`.
--
-- ============================================================
-- CORREÇÕES APLICADAS NESTA REVISÃO (2ª versão), em relação à 1ª:
--   1. Unicidade de job ativo agora inclui projeto_marketplace_id —
--      corrige colisão entre adaptacao_marketplace de marketplaces
--      diferentes (referencia_id era NULL para todos, então a versão
--      anterior bloqueava indevidamente ML/Shopee/Amazon/TikTok de
--      terem jobs simultâneos na mesma etapa).
--   2. Etapa sintética 'ping' adicionada ao CHECK de
--      estudio_anuncios_jobs.etapa — exclusiva para testar fila/claim/
--      worker/conclusão sem IA real, não é etapa comercial.
--   3. estudio_anuncios_jobs.provedor agora aceita 'fake' e 'internal',
--      além de 'openai'/'anthropic'/'google', e é NULLABLE enquanto o
--      job está pendente — preenchido quando a execução é definida
--      (CHECK garante que não fica nulo fora do status 'pendente').
--   4. Unicidade de vídeo gerado agora inclui projeto_marketplace_id
--      (via índice com COALESCE, não UNIQUE simples) — vídeo vertical
--      v1 da Shopee não colide mais com vídeo vertical v1 do TikTok.
--   5. estudio_anuncios_projetos_marketplace.status ganhou CHECK com
--      lista fechada (aguardando, processando, gerando_conteudo,
--      gerando_imagens, gerando_video, aguardando_pendencias,
--      concluido, erro_parcial, cancelado) — reaproveita vocabulário já
--      usado em estudio_anuncios_projetos.status onde fizer sentido.
--   6. estudio_anuncios_entradas_produto ganhou UNIQUE (projeto_id) —
--      1 ficha atual por projeto nesta fase, sem versionamento.
--   7. claim_next_estudio_anuncios_job() reescrita: só reivindica jobs
--      com tentativas < max_tentativas, incrementa tentativas de forma
--      atômica no próprio claim, e só depois marca 'rodando'.
--   8. loja_id mantido — CONFIRMADO (não inferido) via
--      supabase/migrations/20260711_loja_id_pedidos.sql, comentário de
--      origem: "lojas.id (uuid) já existe, é permanente e nunca muda",
--      migração já EXECUTADA e validada (350.298 pedidos com loja_id
--      preenchido, 0 sem correspondência).
--   9. CHECKs de integridade adicionados em praticamente todo campo
--      numérico (ver lista completa na resposta de revisão fora deste
--      arquivo) — nenhum campo de quantidade/tamanho/custo/token aceita
--      valor negativo; score em escala 0-100; nota de prompt em 1-5.
--  10. Índice único parcial adicionado: no máximo 1 imagem GERADA
--      (não só de origem) com e_principal=true por projeto.
--  11. estudio_anuncios_score ganhou numero_versao + UNIQUE
--      (projeto_marketplace_id, numero_versao) — histórico de score,
--      nunca sobrescreve versão anterior.
--  12. atualizado_em adicionado em estudio_anuncios_entradas_produto,
--      estudio_anuncios_pendencias e
--      estudio_anuncios_projetos_marketplace. Sem trigger genérico —
--      atualização é responsabilidade da aplicação (documentado em
--      cada COMMENT ON TABLE relevante).
--  13. gen_random_uuid() mantido sem CREATE EXTENSION — decisão
--      registrada, não assumida (ver nota antes da criação da 1ª
--      tabela).
--  14. Todo ON DELETE revisado e tornado explícito (CASCADE, SET NULL
--      ou RESTRICT), com justificativa por FK.
-- ============================================================
--
-- ESCOPO DESTA MIGRATION (Fase 0 — só infraestrutura): cria o schema
-- completo aprovado, inclusive tabelas usadas só em fases futuras
-- (ex.: estudio_anuncios_score só é calculada de fato na Fase 3).
-- Schema existir ≠ funcionalidade ativa.
--
-- O QUE ESTA MIGRATION NÃO FAZ:
--   - Não altera pedidos, lojas, dashboard_resumos_diarios, sync_jobs
--     ou qualquer tabela/regra existente — 100% aditiva.
--   - Não cria buckets de Storage, AI Gateway, worker ou geração real
--     de IA — isso é código, fica para as próximas tarefas da Fase 0.
--   - Não usa pgvector/embeddings (decisão explícita — item 9 do pedido
--     original; similaridade da Biblioteca de Produtos é textual).
--   - Não cria policy de RLS (mesma justificativa de sync_jobs, ao
--     final deste arquivo).
--
-- CONVENÇÃO: PK UUID DEFAULT gen_random_uuid(), user_id TEXT (não há
-- Supabase Auth), timestamps em português.
--
-- NOTA SOBRE gen_random_uuid() (ponto 13 da revisão): não incluí
-- `CREATE EXTENSION IF NOT EXISTS pgcrypto;` porque já existe evidência
-- direta, neste mesmo repositório, de que a função funciona sem
-- declaração de extensão — `sync_jobs` e `loja_id_pedidos` (este último
-- marcado como EXECUTADO e validado) já usam gen_random_uuid() sem
-- nenhuma CREATE EXTENSION anterior em nenhuma migration do projeto.
-- Se isso mudar (ex.: banco novo/resetado), a extensão precisaria ser
-- adicionada separadamente — não assumido aqui por falta de sinal de
-- que seja necessário.
--
-- DECISÕES FECHADAS NESTA 3ª REVISÃO (2026-08-03), ajustes finais do
-- usuário sobre a 2ª versão:
--   - central_ia_prompts.nota: escala 1-5 confirmada, é avaliação
--     manual do PROMPT (não do desempenho comercial do anúncio) —
--     comentário da coluna atualizado para deixar isso explícito.
--   - estudio_anuncios_score.conversao_estimada: escala 0-100
--     REJEITADA. Coluna mantida NUMERIC nullable, sem CHECK de escala,
--     reservada para fase futura com dados reais de venda da CDS —
--     não deve ser preenchida pela IA a partir só do conteúdo do
--     anúncio. As demais notas (seo/titulo/descricao/imagens/video/
--     geral) permanecem em 0-100, representando qualidade estrutural,
--     nunca promessa de vendas.
--   - estudio_anuncios_projetos_marketplace.status: lista final de 9
--     valores confirmada pelo usuário — ver CREATE TABLE abaixo.
--   - Ambiguidade da Decisão 7 (busca externa) FECHADA:
--     permitir_busca_externa=true é a única condição habilitante;
--     "necessária para completar informação" não é exceção ao
--     consentimento, só restringe quais campos pendentes são
--     pesquisados depois de já autorizado.
--   - central_ia_consumo/central_ia_creditos_lancamentos: acoplamento
--     ao Estúdio de Anúncios ACEITO TEMPORARIAMENTE para esta 1ª
--     versão — não é mais um ponto de decisão em aberto, é uma dívida
--     técnica registrada, a ser revisada antes da criação do 2º módulo
--     real da Central de IA. Nenhuma tabela polimórfica/arquitetura
--     multi-módulo adicional foi antecipada nesta migration.
--
-- PONTOS AINDA EM ABERTO (não resolvidos por esta migration):
--   1. Onde roda o worker persistente (herdado de sync_jobs).
--   2. central_ia_eventos (Histórico consolidado) era só recomendação
--      no documento 3, nunca decisão fechada — por isso NÃO está
--      incluída; decisão adiada para fase futura.
-- ============================================================


-- ────────────────────────────────────────────────────────────────────
-- 1) central_ia_biblioteca_produtos
-- ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS central_ia_biblioteca_produtos (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  escopo         TEXT NOT NULL CHECK (escopo IN ('global', 'usuario')),
  user_id        TEXT,

  produto        TEXT NOT NULL,
  marca          TEXT,
  categoria      TEXT,

  criado_em      TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Sem trigger (ponto 12 da revisão) — a aplicação grava atualizado_em
  -- explicitamente em todo UPDATE desta tabela.
  atualizado_em  TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT chk_biblioteca_produtos_escopo_user_id CHECK (
    (escopo = 'global'  AND user_id IS NULL) OR
    (escopo = 'usuario' AND user_id IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_biblioteca_produtos_usuario
  ON central_ia_biblioteca_produtos (user_id)
  WHERE escopo = 'usuario';

CREATE INDEX IF NOT EXISTS idx_biblioteca_produtos_produto
  ON central_ia_biblioteca_produtos (escopo, produto);

COMMENT ON TABLE central_ia_biblioteca_produtos IS
  'Biblioteca de Produtos — escopo global (curada) ou usuario (privada). atualizado_em mantido pela aplicação, sem trigger.';


-- ────────────────────────────────────────────────────────────────────
-- 2) estudio_anuncios_projetos ("Projeto Mestre")
-- ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS estudio_anuncios_projetos (
  id                            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                       TEXT NOT NULL,

  -- Confirmado (não inferido) — ver nota do ponto 8 no cabeçalho.
  -- ON DELETE SET NULL: excluir uma loja nunca deve arrastar o
  -- projeto de anúncio junto; o projeto só perde a referência.
  loja_id                       UUID REFERENCES lojas(id) ON DELETE SET NULL,

  nome_produto                  TEXT NOT NULL,

  marketplace                   TEXT CHECK (marketplace IS NULL OR marketplace IN ('ML', 'Shopee', 'Amazon', 'TikTok Shop', 'outro')),

  modo                          TEXT NOT NULL DEFAULT 'rapido'
                                  CHECK (modo IN ('rapido', 'profissional')),

  quantidade_imagens_solicitada INTEGER NOT NULL DEFAULT 8
                                  CHECK (quantidade_imagens_solicitada > 0),

  estilo                        TEXT CHECK (estilo IS NULL OR estilo IN
                                  ('minimalista', 'premium', 'tecnologico', 'luxo', 'clean', 'infantil', 'marketplace')),

  -- Ambiguidade da Decisão 7 (documento 3) FECHADA pelo usuário:
  -- permitir_busca_externa=true é a ÚNICA condição que autoriza busca
  -- externa. "Necessária para completar informação específica" NÃO é
  -- uma exceção ao consentimento — só restringe QUAIS campos pendentes
  -- são pesquisados depois que o consentimento já foi dado. Sem
  -- permitir_busca_externa=true, nenhuma busca externa deve ocorrer,
  -- independente de quão "necessária" pareça. Regra de aplicação (não
  -- imposta por CHECK aqui), mas documentada para não ser reaberta.
  permitir_busca_externa        BOOLEAN NOT NULL DEFAULT false,

  -- ON DELETE SET NULL: remover o item da biblioteca não deve apagar
  -- o projeto que um dia reaproveitou sua estrutura.
  biblioteca_produto_id         UUID REFERENCES central_ia_biblioteca_produtos(id) ON DELETE SET NULL,

  status                        TEXT NOT NULL DEFAULT 'rascunho' CHECK (status IN (
                                    'rascunho', 'aguardando_analise', 'analisando_produto',
                                    'gerando_conteudo', 'revisando_conteudo',
                                    'aguardando_aprovacao_conteudo', 'gerando_imagens',
                                    'aguardando_aprovacao_imagens', 'gerando_video',
                                    'aguardando_aprovacao_video', 'concluido',
                                    'erro_parcial', 'cancelado'
                                  )),

  criado_em                     TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  concluido_em                  TIMESTAMPTZ,
  cancelado_em                  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_estudio_anuncios_projetos_user_criado
  ON estudio_anuncios_projetos (user_id, criado_em DESC);

CREATE INDEX IF NOT EXISTS idx_estudio_anuncios_projetos_status
  ON estudio_anuncios_projetos (status);

COMMENT ON TABLE estudio_anuncios_projetos IS
  '"Projeto Mestre" — 1 produto, N adaptações por marketplace. atualizado_em mantido pela aplicação (sem trigger).';


-- ────────────────────────────────────────────────────────────────────
-- 3) estudio_anuncios_projetos_marketplace
--    status agora com CHECK fechado (ponto 5 da revisão, lista final
--    confirmada pelo usuário) — reaproveita vocabulário de
--    estudio_anuncios_projetos.status onde o conceito é o mesmo
--    (gerando_conteudo/imagens/video, concluido, erro_parcial,
--    cancelado), com 'aguardando' e 'analisando' como estados próprios
--    do início da adaptação e 'aguardando_pendencias' para o momento
--    em que a adaptação já tem resultado mas depende de confirmação.
-- ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS estudio_anuncios_projetos_marketplace (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- ON DELETE CASCADE: adaptação não existe sem o Projeto Mestre.
  projeto_id     UUID NOT NULL REFERENCES estudio_anuncios_projetos(id) ON DELETE CASCADE,

  marketplace    TEXT NOT NULL CHECK (marketplace IN ('ML', 'Shopee', 'Amazon', 'TikTok Shop')),

  status         TEXT NOT NULL DEFAULT 'aguardando' CHECK (status IN (
                    'aguardando', 'analisando', 'gerando_conteudo',
                    'gerando_imagens', 'gerando_video', 'aguardando_pendencias',
                    'concluido', 'erro_parcial', 'cancelado'
                  )),

  criado_em      TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em  TIMESTAMPTZ NOT NULL DEFAULT now(),
  concluido_em   TIMESTAMPTZ,

  UNIQUE (projeto_id, marketplace)
);

CREATE INDEX IF NOT EXISTS idx_estudio_anuncios_projetos_mkt_projeto
  ON estudio_anuncios_projetos_marketplace (projeto_id);

COMMENT ON TABLE estudio_anuncios_projetos_marketplace IS
  'Adaptação por marketplace de 1 Projeto Mestre. status com lista fechada de 9 valores (aguardando, analisando, gerando_conteudo, gerando_imagens, gerando_video, aguardando_pendencias, concluido, erro_parcial, cancelado). atualizado_em mantido pela aplicação, sem trigger.';


-- ────────────────────────────────────────────────────────────────────
-- 4) estudio_anuncios_entradas_produto
--    Ponto 6 da revisão: UNIQUE (projeto_id) — 1 ficha atual por
--    projeto nesta fase, sem versionamento (edição é UPDATE, não
--    INSERT de nova linha).
-- ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS estudio_anuncios_entradas_produto (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- ON DELETE CASCADE: dado bruto não sobrevive sem o projeto.
  projeto_id           UUID NOT NULL REFERENCES estudio_anuncios_projetos(id) ON DELETE CASCADE,

  marca                TEXT,
  categoria            TEXT,
  modelo               TEXT,
  cor                  TEXT,
  material             TEXT,
  medidas              JSONB,

  peso                 NUMERIC CHECK (peso IS NULL OR peso >= 0),
  unidade_peso         TEXT CHECK (unidade_peso IS NULL OR unidade_peso IN ('g', 'kg')),
  quantidade           INTEGER CHECK (quantidade IS NULL OR quantidade > 0),
  conteudo_embalagem   TEXT,
  diferenciais         TEXT,
  observacoes          TEXT,

  criado_em            TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em        TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (projeto_id)
);

COMMENT ON TABLE estudio_anuncios_entradas_produto IS
  '1 ficha atual por projeto (UNIQUE projeto_id) — sem versionamento nesta fase. atualizado_em mantido pela aplicação, sem trigger.';


-- ────────────────────────────────────────────────────────────────────
-- 5) estudio_anuncios_imagens_origem
-- ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS estudio_anuncios_imagens_origem (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- ON DELETE CASCADE: fotos de origem não têm sentido sem o projeto
  -- (exclusão do objeto no Storage continua sendo responsabilidade da
  -- aplicação, feita antes do DELETE da linha — documento 1, seção 18).
  projeto_id      UUID NOT NULL REFERENCES estudio_anuncios_projetos(id) ON DELETE CASCADE,

  storage_path    TEXT NOT NULL,
  ordem           INTEGER NOT NULL CHECK (ordem > 0),
  e_principal     BOOLEAN NOT NULL DEFAULT false,

  largura_px      INTEGER CHECK (largura_px IS NULL OR largura_px >= 0),
  altura_px       INTEGER CHECK (altura_px IS NULL OR altura_px >= 0),
  tamanho_bytes   INTEGER CHECK (tamanho_bytes IS NULL OR tamanho_bytes >= 0),

  criado_em       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_imagens_origem_principal
  ON estudio_anuncios_imagens_origem (projeto_id)
  WHERE e_principal = true;

CREATE INDEX IF NOT EXISTS idx_imagens_origem_projeto
  ON estudio_anuncios_imagens_origem (projeto_id);

COMMENT ON TABLE estudio_anuncios_imagens_origem IS
  'Fotos reais enviadas pelo usuário. No máximo 1 e_principal=true por projeto.';


-- ────────────────────────────────────────────────────────────────────
-- 6) estudio_anuncios_jobs
--    Correções desta revisão: unicidade de job ativo agora inclui
--    projeto_marketplace_id (ponto 1); etapa 'ping' adicionada
--    (ponto 2); provedor aceita fake/internal e é nullable enquanto
--    pendente (ponto 3); tentativas/max_tentativas com CHECK (ponto 9);
--    ON DELETE explícito em ambas as FKs (ponto 14).
-- ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS estudio_anuncios_jobs (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- ON DELETE RESTRICT: projetos são soft-delete (cancelado_em), nunca
  -- DELETE físico (documento 1, seção 13.1) — bloquear a exclusão
  -- física enquanto existir job é a rede de segurança que torna esse
  -- soft-delete o único caminho possível na prática, não um acidente.
  projeto_id               UUID NOT NULL REFERENCES estudio_anuncios_projetos(id) ON DELETE RESTRICT,

  -- ON DELETE CASCADE: se a adaptação por marketplace for removida, os
  -- jobs específicos dela deixam de fazer sentido — mesmo ciclo de
  -- vida da linha em estudio_anuncios_projetos_marketplace.
  projeto_marketplace_id   UUID REFERENCES estudio_anuncios_projetos_marketplace(id) ON DELETE CASCADE,

  etapa                    TEXT NOT NULL CHECK (etapa IN (
                              'analise_visual', 'busca_externa', 'geracao_conteudo',
                              'revisao_claude', 'adaptacao_marketplace',
                              'geracao_prompts_imagem', 'geracao_imagem',
                              'geracao_roteiro_video', 'geracao_video',
                              'atualizacao_pos_pendencia', 'calculo_score',
                              -- 'ping': exclusivo para validar fila/claim/worker/
                              -- conclusão nesta fase (Fase 0). NÃO é uma etapa
                              -- comercial do pipeline e não deveria aparecer em
                              -- nenhuma tela voltada ao usuário final.
                              'ping'
                            )),

  referencia_id            UUID,

  status                   TEXT NOT NULL DEFAULT 'pendente'
                              CHECK (status IN ('pendente', 'rodando', 'concluido', 'erro')),

  tentativas               INT NOT NULL DEFAULT 0 CHECK (tentativas >= 0),
  max_tentativas           INT NOT NULL DEFAULT 3 CHECK (max_tentativas > 0),

  erro_tipo                TEXT CHECK (erro_tipo IS NULL OR erro_tipo IN
                              ('transient', 'auth', 'rate_limit', 'conteudo_rejeitado', 'validation', 'unknown')),
  erro_mensagem            TEXT,

  -- Nullable enquanto pendente; passa a ser exigido a partir do
  -- momento em que a execução é definida (CHECK de tabela abaixo).
  -- 'fake' e 'internal' cobrem o provedor de teste da Fase 0 — nunca
  -- valor livre fora desta lista.
  provedor                 TEXT CHECK (provedor IS NULL OR provedor IN ('openai', 'anthropic', 'google', 'fake', 'internal')),

  criado_em                TIMESTAMPTZ NOT NULL DEFAULT now(),
  iniciado_em              TIMESTAMPTZ,
  concluido_em             TIMESTAMPTZ,
  heartbeat_em             TIMESTAMPTZ,

  CONSTRAINT chk_jobs_tentativas_max CHECK (tentativas <= max_tentativas),
  -- provedor só pode ser NULL enquanto o job ainda não foi definido
  -- para execução (status='pendente'). A partir de 'rodando', deve
  -- estar preenchido.
  CONSTRAINT chk_jobs_provedor_definido CHECK (status = 'pendente' OR provedor IS NOT NULL)
);

-- Unicidade de job ativo (ponto 1 da revisão): projeto + marketplace
-- (quando aplicável) + etapa + referência (quando aplicável). Usa
-- COALESCE com sentinela para tratar NULL de forma segura — sem isso,
-- 2 jobs de 'adaptacao_marketplace' com projeto_marketplace_id NULL
-- (bug da versão anterior) ou 2 jobs com referencia_id NULL nunca
-- colidiriam entre si (NULL <> NULL em índice único), permitindo
-- duplicidade indevida.
CREATE UNIQUE INDEX IF NOT EXISTS idx_estudio_anuncios_jobs_ativo
  ON estudio_anuncios_jobs (
    projeto_id,
    etapa,
    COALESCE(projeto_marketplace_id, '00000000-0000-0000-0000-000000000000'),
    COALESCE(referencia_id, '00000000-0000-0000-0000-000000000000')
  )
  WHERE status IN ('pendente', 'rodando');

CREATE INDEX IF NOT EXISTS idx_estudio_anuncios_jobs_status_criado
  ON estudio_anuncios_jobs (status, criado_em);

CREATE INDEX IF NOT EXISTS idx_estudio_anuncios_jobs_heartbeat
  ON estudio_anuncios_jobs (status, heartbeat_em);

CREATE INDEX IF NOT EXISTS idx_estudio_anuncios_jobs_projeto
  ON estudio_anuncios_jobs (projeto_id);

COMMENT ON TABLE estudio_anuncios_jobs IS
  'Fila persistente de jobs. Dono do retry (tentativas/max_tentativas) — Gateway nunca reintenta por conta própria. provedor nullable até a execução ser definida. Etapa ping é só para teste de infraestrutura (Fase 0).';


-- ────────────────────────────────────────────────────────────────────
-- 7) estudio_anuncios_conteudo_versoes
-- ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS estudio_anuncios_conteudo_versoes (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- ON DELETE CASCADE: versão de conteúdo não existe sem a adaptação.
  projeto_marketplace_id   UUID NOT NULL REFERENCES estudio_anuncios_projetos_marketplace(id) ON DELETE CASCADE,

  numero_versao            INTEGER NOT NULL CHECK (numero_versao > 0),
  origem                   TEXT NOT NULL CHECK (origem IN ('ia_openai', 'revisao_claude', 'edicao_manual')),

  titulo_principal         TEXT,
  palavras_chave           TEXT[],
  conteudo                 JSONB NOT NULL DEFAULT '{}'::jsonb,

  aprovado                 BOOLEAN NOT NULL DEFAULT false,
  aprovado_em              TIMESTAMPTZ,

  criado_em                TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (projeto_marketplace_id, numero_versao)
);

CREATE INDEX IF NOT EXISTS idx_conteudo_versoes_projeto_mkt
  ON estudio_anuncios_conteudo_versoes (projeto_marketplace_id);

COMMENT ON TABLE estudio_anuncios_conteudo_versoes IS
  'Histórico de versões de conteúdo por adaptação de marketplace. Nunca UPDATE destrutivo.';


-- ────────────────────────────────────────────────────────────────────
-- 8) estudio_anuncios_auditoria
-- ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS estudio_anuncios_auditoria (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- ON DELETE CASCADE: classificação não tem sentido sem a versão de
  -- conteúdo que ela audita.
  conteudo_versao_id     UUID NOT NULL REFERENCES estudio_anuncios_conteudo_versoes(id) ON DELETE CASCADE,

  campo                  TEXT NOT NULL,
  valor                  TEXT,

  classificacao          TEXT NOT NULL CHECK (classificacao IN (
                            'confirmada_visualmente', 'informada_pelo_usuario',
                            'encontrada_em_fonte_externa', 'inferida_pela_ia',
                            'pendente_confirmacao', 'rejeitada_por_inconsistencia'
                          )),
  justificativa          TEXT,

  criado_em              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_auditoria_conteudo_versao
  ON estudio_anuncios_auditoria (conteudo_versao_id);

COMMENT ON TABLE estudio_anuncios_auditoria IS
  'Classificação por campo individual (6 categorias). Só confirmada_visualmente/informada_pelo_usuario podem ser exibidas como fato — regra de aplicação.';


-- ────────────────────────────────────────────────────────────────────
-- 9) estudio_anuncios_imagens_geradas
--    Ponto 10 da revisão: índice único parcial garantindo no máximo 1
--    imagem GERADA principal por projeto (além da já existente para
--    imagem de ORIGEM).
-- ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS estudio_anuncios_imagens_geradas (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- ON DELETE CASCADE: imagem gerada não sobrevive sem o projeto
  -- (Storage é limpo pela aplicação antes do DELETE da linha).
  projeto_id         UUID NOT NULL REFERENCES estudio_anuncios_projetos(id) ON DELETE CASCADE,

  finalidade         TEXT NOT NULL CHECK (finalidade IN (
                        'capa_principal', 'perspectiva', 'beneficios', 'medidas',
                        'detalhes', 'uso', 'embalagem', 'promocional_secundaria'
                      )),
  numero_versao      INTEGER NOT NULL CHECK (numero_versao > 0),

  storage_path       TEXT,
  prompt_utilizado   TEXT,

  status             TEXT NOT NULL DEFAULT 'pendente' CHECK (status IN (
                        'pendente', 'gerando', 'pronta', 'aprovada',
                        'rejeitada_pelo_usuario', 'rejeitada_pela_auditoria'
                      )),
  e_principal        BOOLEAN NOT NULL DEFAULT false,

  criado_em          TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (projeto_id, finalidade, numero_versao)
);

CREATE INDEX IF NOT EXISTS idx_imagens_geradas_projeto
  ON estudio_anuncios_imagens_geradas (projeto_id);

-- Ponto 10: no máximo 1 imagem GERADA com e_principal=true por
-- projeto — distinta do índice equivalente em imagens_origem (tabela
-- diferente, mesmo princípio).
CREATE UNIQUE INDEX IF NOT EXISTS idx_imagens_geradas_principal
  ON estudio_anuncios_imagens_geradas (projeto_id)
  WHERE e_principal = true;

COMMENT ON TABLE estudio_anuncios_imagens_geradas IS
  'Imagens geradas — pool por projeto (não por marketplace). No máximo 1 e_principal=true por projeto.';


-- ────────────────────────────────────────────────────────────────────
-- 10) estudio_anuncios_videos_gerados
--     Ponto 4 da revisão: unicidade agora considera
--     projeto_marketplace_id via índice com COALESCE (não UNIQUE
--     simples) — vídeo vertical v1 da Shopee não colide mais com
--     vídeo vertical v1 do TikTok Shop.
-- ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS estudio_anuncios_videos_gerados (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- ON DELETE CASCADE: vídeo não sobrevive sem o projeto.
  projeto_id               UUID NOT NULL REFERENCES estudio_anuncios_projetos(id) ON DELETE CASCADE,

  -- ON DELETE SET NULL: se a adaptação de marketplace específica for
  -- removida, preferimos manter o vídeo gerado (mídia já paga/gerada)
  -- órfão de marketplace a apagá-lo junto — diferente do tratamento
  -- dado a estudio_anuncios_jobs, onde o job em si perde sentido.
  projeto_marketplace_id   UUID REFERENCES estudio_anuncios_projetos_marketplace(id) ON DELETE SET NULL,

  formato                  TEXT NOT NULL CHECK (formato IN ('vertical', 'marketplace')),
  numero_versao            INTEGER NOT NULL CHECK (numero_versao > 0),

  storage_path             TEXT,
  duracao_segundos         INTEGER CHECK (duracao_segundos IS NULL OR duracao_segundos >= 0),
  roteiro_cenas            JSONB,
  locucao_texto            TEXT,
  textos_tela              JSONB,

  status                   TEXT NOT NULL DEFAULT 'pendente' CHECK (status IN (
                              'pendente', 'gerando', 'pronta', 'aprovada',
                              'rejeitada_pelo_usuario', 'rejeitada_pela_auditoria'
                            )),

  criado_em                TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Substitui o UNIQUE (projeto_id, formato, numero_versao) da 1ª
-- versão — que ignorava projeto_marketplace_id e permitia colisão
-- entre marketplaces diferentes na mesma versão/formato.
CREATE UNIQUE INDEX IF NOT EXISTS idx_videos_gerados_unico
  ON estudio_anuncios_videos_gerados (
    projeto_id,
    COALESCE(projeto_marketplace_id, '00000000-0000-0000-0000-000000000000'),
    formato,
    numero_versao
  );

CREATE INDEX IF NOT EXISTS idx_videos_gerados_projeto
  ON estudio_anuncios_videos_gerados (projeto_id);

COMMENT ON TABLE estudio_anuncios_videos_gerados IS
  'Vídeos gerados. Unicidade considera marketplace quando presente — vídeo v1 da Shopee e v1 do TikTok Shop nunca colidem.';


-- ────────────────────────────────────────────────────────────────────
-- 11) estudio_anuncios_pendencias
-- ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS estudio_anuncios_pendencias (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- ON DELETE CASCADE: pendência não existe sem o projeto.
  projeto_id      UUID NOT NULL REFERENCES estudio_anuncios_projetos(id) ON DELETE CASCADE,

  campo           TEXT NOT NULL,
  pergunta        TEXT NOT NULL,
  resposta        TEXT,
  respondida_em   TIMESTAMPTZ,

  criado_em       TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pendencias_projeto_respondida
  ON estudio_anuncios_pendencias (projeto_id, respondida_em);

COMMENT ON TABLE estudio_anuncios_pendencias IS
  'Perguntas objetivas pendentes de confirmação. atualizado_em mantido pela aplicação (ex.: ao registrar resposta), sem trigger.';


-- ────────────────────────────────────────────────────────────────────
-- 12) estudio_anuncios_pacotes_exportacao
-- ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS estudio_anuncios_pacotes_exportacao (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- ON DELETE CASCADE: pacote de exportação não faz sentido sem o
  -- projeto que ele empacota.
  projeto_id         UUID NOT NULL REFERENCES estudio_anuncios_projetos(id) ON DELETE CASCADE,

  itens_incluidos    JSONB NOT NULL,
  storage_path       TEXT,

  criado_em          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pacotes_exportacao_projeto
  ON estudio_anuncios_pacotes_exportacao (projeto_id);

COMMENT ON TABLE estudio_anuncios_pacotes_exportacao IS
  'Pacote de exportação gerado sob demanda (nunca pré-gerado).';


-- ────────────────────────────────────────────────────────────────────
-- 13) estudio_anuncios_score
--     Ponto 11 da revisão: histórico simples de versões —
--     numero_versao + UNIQUE (projeto_marketplace_id, numero_versao).
--     Nunca sobrescreve score anterior; recalcular insere nova linha.
--     Ponto 9: escala de nota fixada em 0-100 (pedido explícito).
-- ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS estudio_anuncios_score (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- ON DELETE CASCADE: score não existe sem a adaptação que ele avalia.
  projeto_marketplace_id   UUID NOT NULL REFERENCES estudio_anuncios_projetos_marketplace(id) ON DELETE CASCADE,

  numero_versao            INTEGER NOT NULL DEFAULT 1 CHECK (numero_versao > 0),

  nota_seo                 NUMERIC CHECK (nota_seo IS NULL OR (nota_seo >= 0 AND nota_seo <= 100)),
  nota_titulo              NUMERIC CHECK (nota_titulo IS NULL OR (nota_titulo >= 0 AND nota_titulo <= 100)),
  nota_descricao           NUMERIC CHECK (nota_descricao IS NULL OR (nota_descricao >= 0 AND nota_descricao <= 100)),
  nota_imagens             NUMERIC CHECK (nota_imagens IS NULL OR (nota_imagens >= 0 AND nota_imagens <= 100)),
  nota_video               NUMERIC CHECK (nota_video IS NULL OR (nota_video >= 0 AND nota_video <= 100)),
  nota_geral               NUMERIC CHECK (nota_geral IS NULL OR (nota_geral >= 0 AND nota_geral <= 100)),

  -- SEM escala/CHECK, por decisão explícita do usuário (rejeitou a
  -- escala 0-100 proposta na revisão anterior): nesta fase não existem
  -- dados reais suficientes da CDS para calcular conversão de forma
  -- confiável, e atribuir uma escala numérica passaria uma precisão
  -- que o sistema não possui. Coluna reservada para fase futura,
  -- baseada em dados reais de venda/conversão da própria CDS — NÃO
  -- deve ser preenchida pela IA a partir apenas do conteúdo do
  -- anúncio. Nenhum código desta fase lê ou grava este campo.
  conversao_estimada       NUMERIC,

  sugestoes                JSONB,

  criado_em                TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (projeto_marketplace_id, numero_versao)
);

CREATE INDEX IF NOT EXISTS idx_score_projeto_mkt
  ON estudio_anuncios_score (projeto_marketplace_id);

COMMENT ON TABLE estudio_anuncios_score IS
  'Score do anúncio por adaptação de marketplace, com histórico de versões (numero_versao) — recalcular nunca sobrescreve, sempre insere nova linha. nota_seo/titulo/descricao/imagens/video/geral em escala 0-100, representam avaliação de QUALIDADE ESTRUTURAL do anúncio (completude, clareza, aderência ao formato do marketplace) — nunca promessa ou previsão de vendas. conversao_estimada é NUMERIC sem escala, reservada para fase futura com dados reais, não preenchida nesta fase. Cálculo real só a partir da Fase 3.';


-- ────────────────────────────────────────────────────────────────────
-- 14) central_ia_biblioteca_produtos_versoes
-- ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS central_ia_biblioteca_produtos_versoes (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- ON DELETE CASCADE: associação não existe sem o produto da
  -- biblioteca que ela associa.
  biblioteca_produto_id    UUID NOT NULL REFERENCES central_ia_biblioteca_produtos(id) ON DELETE CASCADE,

  tipo_referencia          TEXT NOT NULL CHECK (tipo_referencia IN
                              ('conteudo_versao', 'imagem_gerada', 'video_gerado')),
  -- Sem REFERENCES (polimórfico, decisão consciente já registrada na
  -- 1ª versão) — aponta para estudio_anuncios_conteudo_versoes.id,
  -- estudio_anuncios_imagens_geradas.id ou
  -- estudio_anuncios_videos_gerados.id conforme tipo_referencia.
  referencia_id            UUID NOT NULL,

  criado_em                TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_biblioteca_produtos_versoes_produto
  ON central_ia_biblioteca_produtos_versoes (biblioteca_produto_id);

COMMENT ON TABLE central_ia_biblioteca_produtos_versoes IS
  'Associação entre um produto da Biblioteca e conteúdo/imagem/vídeo já aprovados, reaproveitáveis. Reaproveitamento deve se restringir a versões aprovadas (regra de aplicação).';


-- ────────────────────────────────────────────────────────────────────
-- 15) central_ia_prompts
--     Ponto 9: nota em escala 1-5 (avaliação manual de utilidade do
--     prompt), documentada explicitamente por não haver especificação
--     nos 3 documentos.
-- ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS central_ia_prompts (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  modulo             TEXT NOT NULL DEFAULT 'estudio_anuncios',
  -- Sem REFERENCES (multi-módulo, decisão consciente já registrada).
  projeto_id         UUID,

  tipo               TEXT NOT NULL CHECK (tipo IN ('texto', 'imagem', 'video', 'seo', 'revisao', 'auditoria')),
  provedor           TEXT NOT NULL,
  modelo             TEXT NOT NULL,
  versao_modelo      TEXT,
  temperatura        NUMERIC,

  prompt_texto       TEXT NOT NULL,
  resultado_resumo   TEXT,

  tempo_ms           INTEGER CHECK (tempo_ms IS NULL OR tempo_ms >= 0),
  custo              NUMERIC CHECK (custo IS NULL OR custo >= 0),

  -- Escala 1-5 confirmada pelo usuário: avaliação MANUAL da qualidade/
  -- utilidade do prompt em si (1 = resultado muito ruim, 5 = resultado
  -- excelente), atribuída na tela de consulta da Biblioteca de
  -- Prompts. NÃO representa conversão, CTR ou qualquer desempenho
  -- comercial real do anúncio gerado — é uma nota sobre o prompt,
  -- não sobre a venda.
  nota               INTEGER CHECK (nota IS NULL OR nota BETWEEN 1 AND 5),
  reutilizacoes      INTEGER NOT NULL DEFAULT 0 CHECK (reutilizacoes >= 0),

  criado_em          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_prompts_modulo_criado
  ON central_ia_prompts (modulo, criado_em DESC);

CREATE INDEX IF NOT EXISTS idx_prompts_projeto
  ON central_ia_prompts (projeto_id);

COMMENT ON TABLE central_ia_prompts IS
  'Biblioteca de Prompts. nota em escala 1-5 (avaliação manual). projeto_id sem FK rígida — compartilhada entre módulos futuros.';


-- ────────────────────────────────────────────────────────────────────
-- 16) central_ia_consumo
-- ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS central_ia_consumo (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  modulo              TEXT NOT NULL DEFAULT 'estudio_anuncios',

  -- ON DELETE SET NULL (ambas): custo/consumo é registro histórico —
  -- preservado mesmo se o projeto/job de origem deixar de existir
  -- (na prática improvável, já que projetos são soft-delete e jobs
  -- não são removidos, mas explícito em vez de herdar comportamento
  -- padrão).
  projeto_id          UUID REFERENCES estudio_anuncios_projetos(id) ON DELETE SET NULL,
  job_id              UUID REFERENCES estudio_anuncios_jobs(id) ON DELETE SET NULL,

  provedor            TEXT NOT NULL,
  modelo              TEXT NOT NULL,

  tokens_entrada      INTEGER CHECK (tokens_entrada IS NULL OR tokens_entrada >= 0),
  tokens_saida        INTEGER CHECK (tokens_saida IS NULL OR tokens_saida >= 0),
  unidades_geradas    INTEGER CHECK (unidades_geradas IS NULL OR unidades_geradas >= 0),

  custo_estimado      NUMERIC CHECK (custo_estimado IS NULL OR custo_estimado >= 0),
  custo_real          NUMERIC CHECK (custo_real IS NULL OR custo_real >= 0),

  criado_em           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_consumo_projeto ON central_ia_consumo (projeto_id);
CREATE INDEX IF NOT EXISTS idx_consumo_job ON central_ia_consumo (job_id);

COMMENT ON TABLE central_ia_consumo IS
  'Fonte única de custo/consumo por chamada real a provedor de IA. ACEITO TEMPORARIAMENTE (aprovado pelo usuário em 2026-08-03) acoplado só ao Estúdio de Anúncios (FK direta a estudio_anuncios_projetos/estudio_anuncios_jobs), apesar do nome "central_ia". Esta estrutura atende ao 1º módulo; DEVE ser revisada antes da criação do 2º módulo real da Central de IA. Nenhuma tabela polimórfica ou arquitetura multi-módulo adicional foi criada nesta migration — isso fica para quando o 2º módulo existir de fato, não antecipado agora. Registrar também em docs/DECISIONS.md quando a documentação do projeto for sincronizada (fora do escopo desta migration).';


-- ────────────────────────────────────────────────────────────────────
-- 17) central_ia_creditos + central_ia_creditos_lancamentos
-- ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS central_ia_creditos (
  user_id          TEXT PRIMARY KEY,
  saldo_creditos   NUMERIC NOT NULL DEFAULT 0 CHECK (saldo_creditos >= 0),
  limite_diario    NUMERIC CHECK (limite_diario IS NULL OR limite_diario >= 0),
  limite_mensal    NUMERIC CHECK (limite_mensal IS NULL OR limite_mensal >= 0),
  atualizado_em    TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE central_ia_creditos IS
  '1 saldo por usuário, compartilhado entre módulos. saldo_creditos nunca negativo. atualizado_em mantido pela aplicação, sem trigger.';

CREATE TABLE IF NOT EXISTS central_ia_creditos_lancamentos (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      TEXT NOT NULL,

  modulo       TEXT NOT NULL DEFAULT 'estudio_anuncios',
  -- Sem REFERENCES (multi-módulo, decisão consciente já registrada).
  projeto_id   UUID,
  job_id       UUID,

  tipo         TEXT NOT NULL CHECK (tipo IN ('debito', 'estorno', 'recarga')),
  -- valor é sempre a magnitude do lançamento (positivo); a direção é
  -- dada por tipo, nunca pelo sinal de valor.
  valor        NUMERIC NOT NULL CHECK (valor > 0),
  motivo       TEXT,

  criado_em    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_creditos_lancamentos_debito_job
  ON central_ia_creditos_lancamentos (job_id, tipo)
  WHERE tipo = 'debito' AND job_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_creditos_lancamentos_user_criado
  ON central_ia_creditos_lancamentos (user_id, criado_em DESC);

COMMENT ON TABLE central_ia_creditos_lancamentos IS
  'Histórico de débito/estorno/recarga. valor sempre positivo (direção via tipo). Débito idempotente por job_id.';


-- ────────────────────────────────────────────────────────────────────
-- Função: claim_next_estudio_anuncios_job()
-- Ponto 7 da revisão: só reivindica jobs com tentativas < max_tentativas;
-- incrementa tentativas atomicamente dentro do próprio claim (a mesma
-- transação que muda o status para 'rodando'); cada claim representa
-- 1 tentativa real do job. O Gateway continua sem retry próprio.
-- ────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION claim_next_estudio_anuncios_job()
RETURNS estudio_anuncios_jobs
LANGUAGE plpgsql
AS $$
DECLARE
  v_job estudio_anuncios_jobs;
BEGIN
  SELECT * INTO v_job
  FROM estudio_anuncios_jobs
  WHERE status = 'pendente'
    AND tentativas < max_tentativas
  ORDER BY criado_em ASC
  FOR UPDATE SKIP LOCKED
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  UPDATE estudio_anuncios_jobs
  SET status       = 'rodando',
      tentativas   = tentativas + 1,
      iniciado_em  = now(),
      heartbeat_em = now()
  WHERE id = v_job.id
  RETURNING * INTO v_job;

  RETURN v_job;
END;
$$;

COMMENT ON FUNCTION claim_next_estudio_anuncios_job() IS
  'Aquisição atômica do próximo job pendente com tentativas < max_tentativas (FOR UPDATE SKIP LOCKED). Incrementa tentativas no claim — cada claim é 1 tentativa real. Retorna 1 linha ou NULL.';

-- CORREÇÃO PÓS-EXECUÇÃO (2026-08-03): REVOKE FROM PUBLIC sozinho não é
-- suficiente neste projeto Supabase. Validação por leitura após a 1ª
-- execução mostrou EXECUTE concedido também a anon e authenticated,
-- mesmo com o REVOKE FROM PUBLIC abaixo — causa provável: uma regra de
-- ALTER DEFAULT PRIVILEGES no schema public deste projeto concede
-- EXECUTE automaticamente a anon/authenticated/service_role em toda
-- função nova, no momento da criação, independente do REVOKE FROM
-- PUBLIC (que só afeta o pseudo-role PUBLIC, não esses roles
-- específicos). anon/authenticated explícitos nas linhas abaixo
-- existem por isso — sem eles, a função ficaria chamável pela API
-- pública (chave anon), o que contraria "só o worker/service_role
-- pode chamar esta função". Mesmo risco pode existir em
-- claim_next_sync_job() (sync_jobs) — não verificado nesta tarefa.
REVOKE EXECUTE ON FUNCTION claim_next_estudio_anuncios_job() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION claim_next_estudio_anuncios_job() TO service_role;


-- ── RLS: decisão explícita de NÃO habilitar, mesma justificativa de sync_jobs ──
-- Nenhuma tabela deste projeto usa Row Level Security. A aplicação não
-- usa Supabase Auth (sessão é cookie próprio via lib/session.ts, sem
-- auth.uid() disponível). Autorização é 100% em código
-- (getUserId() + .eq("user_id", ...)).
--
-- Sinalizado como PONTO A RECONSIDERAR, não herdado em silêncio: fotos
-- reais de produtos e conteúdo de anúncio de clientes têm perfil de
-- sensibilidade diferente de número financeiro. Introduzir RLS
-- pressuporia migrar para Supabase Auth — mudança estrutural grande,
-- fora do escopo desta migration e desta fase.
