-- ============================================================================
-- 20260819_rpc_selecao_status_shopee.sql
--
-- RPC de SELECAO da fila do sync de status Shopee.
--
-- POR QUE ESTA FUNCAO EXISTE
-- --------------------------
-- O criterio de selecao precisa calcular um BUCKET por `order_id` a partir do
-- md5 do proprio id. PostgREST nao computa expressao em filtro, entao pela
-- API REST so haveria duas saidas ruins: trazer a populacao inteira para a
-- aplicacao e filtrar em memoria (dezenas de requisicoes por execucao, que
-- cresce com a base), ou abrir conexao Postgres direta na aplicacao (`pg` em
-- producao + string de conexao no ambiente — infraestrutura nova). Uma funcao
-- resolve em UMA chamada e mantem o criterio dentro do banco, onde ele e
-- verificavel.
--
-- O QUE ELA NAO FAZ
-- -----------------
-- NAO tem LIMIT e NAO tem OFFSET. Isso e o coracao da garantia de cobertura:
--   - `LIMIT` dentro do bucket reintroduziria starvation silenciosa — os
--     mesmos N pedidos voltariam em toda execucao e o excedente jamais;
--   - `OFFSET` sobre conjunto mutavel PULA linhas, porque pedidos saem do
--     conjunto entre uma pagina e outra.
-- O tamanho do bucket nao participa da prova de cobertura: ele afeta so a
-- duracao, controlada pelo K da aplicacao e barrada pelo TETO_POR_EXECUCAO
-- ANTES de qualquer chamada a Shopee.
--
-- NAO escreve nada. E somente leitura.
--
-- DATA DE REFERENCIA EXPLICITA
-- ----------------------------
-- `current_date` NAO e usado. A data vem por parametro, calculada em BRT pela
-- aplicacao. Sem isso a regra de idade dependeria silenciosamente do timezone
-- da conexao Postgres e o teste nao seria reproduzivel.
--
-- BUCKET
-- ------
-- (get_byte(decode(md5(order_id),'hex'),0) * 256
--  + get_byte(decode(md5(order_id),'hex'),1)) % 1024
--
-- `md5` e funcao padrao e estavel entre versoes; `hashtext` e interna e sem
-- garantia. `get_byte` devolve 0..255, sempre nao-negativo — o que evita a
-- armadilha de `abs(('x'||md5(id))::bit(32)::int)`, que lanca
-- "integer out of range" quando os 8 primeiros hex sao exatamente 80000000.
--
-- O 1024 esta FIXO no corpo de proposito. Ele e o espaco de buckets congelado
-- da arquitetura: mudar esse numero reembaralha a atribuicao de TODOS os
-- pedidos e invalida a cobertura durante a transicao. Nao vira parametro para
-- que ninguem possa alterar por engano em tempo de chamada.
--
-- SEGURANCA
-- ---------
-- SECURITY INVOKER, nao DEFINER: a funcao nao precisa de privilegio alem do
-- que o chamador ja tem, e DEFINER so seria escolhido "para funcionar".
-- Chamador previsto: a rota interna com a chave service_role.
--
-- REVOKE de PUBLIC, anon e authenticated e obrigatorio: este projeto Supabase
-- tem ALTER DEFAULT PRIVILEGES concedendo EXECUTE a anon/authenticated em TODA
-- funcao nova, e `REVOKE FROM PUBLIC` nao cobre isso — PUBLIC e pseudo-role
-- distinto. Foi o que causou o bug SEC1.
--
-- `p_user_id` e revalidado pela funcao como qualquer parametro cru: ela nao tem
-- sessao para confiar. Quem garante que o valor veio da sessao autenticada e a
-- rota, que nunca aceita user_id do cliente.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.selecionar_pedidos_status_shopee(
  p_user_id              TEXT,   -- pedidos.user_id e TEXT, nao UUID (verificado no schema)
  p_status_nao_terminais TEXT[],
  p_data_referencia      DATE,
  p_idade_faixa_a        INT,
  p_buckets_a            INT[],
  p_buckets_b            INT[]
)
RETURNS TABLE (order_id TEXT, faixa TEXT)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT DISTINCT
         p.order_id,
         CASE
           WHEN (p_data_referencia - COALESCE(p.data_pagamento, p.data_criacao::date)) <= p_idade_faixa_a
           THEN 'A' ELSE 'B'
         END AS faixa
    FROM public.pedidos p
   WHERE p.user_id = p_user_id
     AND p.marketplace = 'Shopee'
     AND p.status_shopee_raw = ANY(p_status_nao_terminais)
     AND p.order_id IS NOT NULL
     AND COALESCE(p.data_pagamento, p.data_criacao::date) IS NOT NULL
     AND (
       -- FAIXA A: recentes. Consultados a cada execucao quando K_A = 1024.
       (
             (p_data_referencia - COALESCE(p.data_pagamento, p.data_criacao::date)) <= p_idade_faixa_a
         AND (
               ( get_byte(decode(md5(p.order_id), 'hex'), 0) * 256
               + get_byte(decode(md5(p.order_id), 'hex'), 1) ) % 1024
             ) = ANY(p_buckets_a)
       )
       OR
       -- FAIXA B: o restante, em rotacao pelo relogio.
       (
             (p_data_referencia - COALESCE(p.data_pagamento, p.data_criacao::date)) > p_idade_faixa_a
         AND (
               ( get_byte(decode(md5(p.order_id), 'hex'), 0) * 256
               + get_byte(decode(md5(p.order_id), 'hex'), 1) ) % 1024
             ) = ANY(p_buckets_b)
       )
     );
$$;

COMMENT ON FUNCTION public.selecionar_pedidos_status_shopee(TEXT, TEXT[], DATE, INT, INT[], INT[]) IS
  'Fila do sync de status Shopee. Somente leitura. Sem LIMIT e sem OFFSET — a '
  'cobertura da rotacao por bucket depende de a selecao NUNCA ser truncada. '
  'Faixa A (idade <= p_idade_faixa_a) e Faixa B sao mutuamente exclusivas pela '
  'idade, entao cada order_id volta com uma unica faixa. Data de referencia e '
  'parametro: current_date nao e usado, para nao depender do timezone da conexao.';

-- Colunas qualificadas (p.order_id) no corpo: nomes de saida de RETURNS TABLE
-- colidem com colunas e ja causaram "column reference is ambiguous" neste
-- projeto.

REVOKE ALL ON FUNCTION public.selecionar_pedidos_status_shopee(TEXT, TEXT[], DATE, INT, INT[], INT[])
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.selecionar_pedidos_status_shopee(TEXT, TEXT[], DATE, INT, INT[], INT[])
  TO service_role;

-- ============================================================================
-- INDICE: NAO E CRIADO AQUI, E NAO E NECESSARIO.
--
-- Uma versao anterior desta migration criava
-- `idx_pedidos_status_shopee_fila (user_id, marketplace, status_shopee_raw)`.
-- A auditoria de indices de 18/08/2026 mostrou que isso seria um DUPLICADO
-- PIOR de um indice que ja existe:
--
--   idx_pedidos_status_shopee_raw
--     btree (user_id, marketplace, status_shopee_raw)
--     WHERE (marketplace = 'Shopee')          <- PARCIAL, 7 MB
--
-- O indice existente cobre exatamente o WHERE desta funcao, e por ser parcial
-- ocupa menos e e mais rapido de manter. EXPLAIN (ANALYZE, BUFFERS) confirmou
-- que o planejador JA o escolhe: Index Scan, 100-129 ms, shared read 0.
--
-- Criar o duplicado so adicionaria peso a cada INSERT/UPDATE de `pedidos` —
-- uma tabela de 424 mil linhas que ja carrega 14 indices e 328 MB — sem ganho
-- nenhum de leitura. Esta migration nao toca a estrutura da tabela: nao ha
-- CREATE INDEX, ALTER TABLE, DROP, INSERT, UPDATE nem DELETE, e portanto ela
-- nao bloqueia escrita em producao.
-- ============================================================================
