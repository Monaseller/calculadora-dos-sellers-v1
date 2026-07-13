-- ============================================================
-- Migração: separação de data_criacao / data_pagamento / data_atualizacao
-- Gerado em: 2026-07-06
-- Decisão de arquitetura: docs/DECISIONS.md ("Decisão de arquitetura —
-- separação de três datas (2026-07-06)"). Regra de negócio completa em
-- docs/BUSINESS_RULES.md.
--
-- NÃO EXECUTADO AINDA. Revisar e rodar manualmente no SQL Editor do
-- Supabase quando aprovado. Todos os comandos usam IF NOT EXISTS —
-- seguro re-executar.
--
-- Escopo desta migration = só schema (Fase A). NÃO inclui:
--   - mudança no código de sync (Fase B, lib/sync-shopee.ts / lib/sync-ml.ts)
--   - mudança nas rotas de API (Fase C)
--   - mudança no frontend / seletor de dashboard (Fase D)
--   - backfill de pedidos antigos (explicitamente adiado por decisão do
--     usuário — ponto 5 da aprovação de 2026-07-06: "não quero backfill
--     agressivo agora")
--
-- O QUE ESTA MIGRATION NÃO FAZ:
--   - Não remove, renomeia nem altera a coluna `data` existente. Ela
--     continua sendo o fallback para pedidos sincronizados antes desta
--     migration (ponto 5 da aprovação: "manter data atual como fallback").
--   - Não popula data_criacao/data_pagamento para linhas já existentes.
--     Essas colunas nascem NULL em todo pedido já sincronizado e só
--     passam a ser preenchidas em novos syncs/resyncs (Fase B, ainda não
--     implementada).
-- ============================================================

-- ── Novas colunas de data ────────────────────────────────────────────────────
-- data_criacao: quando o pedido foi criado no marketplace (nunca usar como
--   referência financeira — só auditoria/histórico/comparação com Seller Center).
-- data_pagamento: quando o pedido foi pago de fato. NULL quando o pedido nunca
--   foi pago (cancelado antes de pagar, ou ainda pendente) — ver regra de
--   negócio: visão financeira exclui pedidos com data_pagamento NULL; visão
--   operacional usa data_criacao como alternativa nesse caso. A aplicação
--   decide isso na query/exibição, não este schema.
ALTER TABLE pedidos
  ADD COLUMN IF NOT EXISTS data_criacao    DATE,
  ADD COLUMN IF NOT EXISTS data_pagamento  DATE;

-- ── Rastreamento opcional de atualização do marketplace ─────────────────────
-- Timestamp bruto de quando o MARKETPLACE alterou o pedido pela última vez
-- (ex.: update_time da Shopee). Distinto de `synced_at`, que é quando A CDS
-- sincronizou pela última vez — os dois juntos permitem, no futuro, detectar
-- pedidos "desatualizados" (marketplace mudou depois do nosso último sync).
-- Relevante para o bug de status obsoleto já registrado em BUGS.md (ponto 4
-- da decisão: tratado separadamente, esta coluna só prepara o terreno).
-- Nullable e não populada nesta migration — só schema.
ALTER TABLE pedidos
  ADD COLUMN IF NOT EXISTS data_atualizacao_marketplace TIMESTAMPTZ;

-- ── Índices de performance para os dois campos de filtro do dashboard ───────
-- O seletor "Data de Pagamento / Data de Criação" no dashboard (Fase D) vai
-- filtrar por um desses dois campos conforme a escolha do usuário — cada um
-- precisa do mesmo tipo de índice composto que `data` já tem hoje.
CREATE INDEX IF NOT EXISTS pedidos_user_marketplace_data_criacao_idx
  ON pedidos (user_id, marketplace, data_criacao DESC);

CREATE INDEX IF NOT EXISTS pedidos_user_marketplace_data_pagamento_idx
  ON pedidos (user_id, marketplace, data_pagamento DESC);

-- ── Comentários de documentação no próprio schema (visível no Supabase) ─────
COMMENT ON COLUMN pedidos.data IS
  'LEGADO/fallback. Data derivada por regra antiga (create_time no sync histórico, pay_time no cron) — mantida sem alteração para pedidos sincronizados antes de 2026-07-06. Novo código deve preferir data_criacao/data_pagamento; usar `data` só como fallback quando ambos forem NULL.';

COMMENT ON COLUMN pedidos.data_criacao IS
  'Quando o pedido foi criado no marketplace. Nunca usar como referência financeira. NULL em pedidos sincronizados antes de 2026-07-06 (sem backfill agressivo — ver DECISIONS.md).';

COMMENT ON COLUMN pedidos.data_pagamento IS
  'Quando o pedido foi pago de fato. NULL se o pedido nunca foi pago. Regra oficial da CDS para toda métrica financeira (dashboard, faturamento, DRE, KPIs). NULL também em pedidos sincronizados antes de 2026-07-06.';

COMMENT ON COLUMN pedidos.data_atualizacao_marketplace IS
  'Timestamp bruto da última alteração do pedido no marketplace de origem (ex.: update_time da Shopee). Uso interno de sincronização/reconciliação — nunca exibir em relatório. Preparação para a correção do bug de status obsoleto (ver BUGS.md); não populada por esta migration.';
