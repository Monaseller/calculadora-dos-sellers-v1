-- ────────────────────────────────────────────────────────────────────
-- Migration: criar_projeto_estudio_anuncios() — RPC de criação atômica
-- do Projeto Mestre (Central de IA / Estúdio de Anúncios).
--
-- Contexto: POST /api/estudio-anuncios/projetos precisa inserir 1 linha
-- em estudio_anuncios_projetos + N linhas em
-- estudio_anuncios_projetos_marketplace de forma atômica. O cliente
-- Supabase JS (PostgREST) não oferece transação entre dois .insert()
-- separados — só uma função Postgres roda dentro de uma transação
-- implícita única. Ver decisão completa no chat (2026-08-04).
--
-- DIFERENÇA DELIBERADA em relação à primeira proposta desta mesma
-- tarefa: esta função é restrita a service_role (REVOKE explícito de
-- PUBLIC/anon/authenticated abaixo) — NÃO é chamável pelo cliente anon
-- da rota. p_user_id vem de um parâmetro de função, então uma chamada
-- direta com a chave anon poderia informar um user_id arbitrário; sem
-- Supabase Auth/RLS neste projeto, não há como a própria função
-- verificar "de quem" é a chamada. A defesa fica inteiramente em
-- app/api/estudio-anuncios/projetos/route.ts: getUserId(request) decide
-- o user_id, e só depois disso a rota chama esta RPC usando um cliente
-- server-only com service_role (nunca com a chave anon). Mesmo padrão
-- de isolamento de service_role já usado por
-- app/api/internal/estudio-anuncios/executar e scripts/*-worker.mjs.
--
-- SECURITY INVOKER (não DEFINER): a única chamadora prevista é
-- service_role, que já tem privilégio total sobre as duas tabelas —
-- não há necessidade de elevar privilégio via DEFINER, e INVOKER evita
-- o risco clássico de DEFINER (função rodando com dono do objeto,
-- mesmo que o chamador tivesse menos acesso). search_path fixado em
-- 'public' e todas as tabelas qualificadas com public. — mitiga
-- sequestro de search_path mesmo sendo INVOKER.
--
-- Validações replicadas aqui (mesmas de lib/estudio-anuncios/validacao.ts,
-- que roda antes, na rota, para devolver 400 com mensagem clara) —
-- esta função não confia só na validação de TypeScript.
--
-- Nenhuma tabela alterada, nenhum dado inserido por esta migration.
-- ────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.criar_projeto_estudio_anuncios(
  p_user_id                TEXT,
  p_nome_produto           TEXT,
  p_marketplaces           TEXT[],
  p_quantidade_imagens     INTEGER,
  p_modo                   TEXT,
  p_permitir_busca_externa BOOLEAN,
  p_estilo                 TEXT
)
RETURNS public.estudio_anuncios_projetos
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_projeto                    public.estudio_anuncios_projetos;
  v_marketplace                TEXT;
  v_marketplaces_normalizados  TEXT[];
  v_nome_normalizado           TEXT;
  v_user_id_normalizado        TEXT;
BEGIN
  -- p_user_id
  IF p_user_id IS NULL OR btrim(p_user_id) = '' THEN
    RAISE EXCEPTION 'p_user_id não pode ser nulo ou vazio';
  END IF;
  v_user_id_normalizado := btrim(p_user_id);

  -- p_nome_produto
  IF p_nome_produto IS NULL OR btrim(p_nome_produto) = '' THEN
    RAISE EXCEPTION 'p_nome_produto não pode ser nulo ou vazio';
  END IF;
  v_nome_normalizado := btrim(p_nome_produto);

  -- p_marketplaces: obrigatório, ao menos 1, sem elementos nulos, só
  -- valores permitidos. Rejeita NULL explicitamente ANTES de
  -- normalizar — não depende de estourar o NOT NULL/CHECK do INSERT
  -- para detectar um marketplace nulo.
  IF p_marketplaces IS NULL OR array_length(p_marketplaces, 1) IS NULL THEN
    RAISE EXCEPTION 'p_marketplaces não pode ser nulo ou vazio';
  END IF;

  IF array_position(p_marketplaces, NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'p_marketplaces não pode conter valores nulos';
  END IF;

  -- Normalizado para distintos aqui (ponto 5 da revisão) — a aplicação
  -- também deduplica antes de chamar, mas a função não confia nisso.
  SELECT array_agg(DISTINCT m) INTO v_marketplaces_normalizados
  FROM unnest(p_marketplaces) AS m;

  FOREACH v_marketplace IN ARRAY v_marketplaces_normalizados LOOP
    IF v_marketplace NOT IN ('ML', 'Shopee', 'Amazon', 'TikTok Shop') THEN
      RAISE EXCEPTION 'marketplace inválido: %', v_marketplace;
    END IF;
  END LOOP;

  -- p_modo
  IF p_modo IS NULL OR p_modo NOT IN ('rapido', 'profissional') THEN
    RAISE EXCEPTION 'p_modo deve ser "rapido" ou "profissional"';
  END IF;

  -- p_quantidade_imagens
  IF p_quantidade_imagens IS NULL OR p_quantidade_imagens <= 0 THEN
    RAISE EXCEPTION 'p_quantidade_imagens deve ser um inteiro positivo';
  END IF;

  IF p_modo = 'rapido' AND p_quantidade_imagens NOT IN (4, 6, 8, 10) THEN
    RAISE EXCEPTION 'no modo rapido, p_quantidade_imagens deve ser 4, 6, 8 ou 10';
  END IF;

  -- p_estilo: opcional, mas se enviado precisa bater com o CHECK do banco.
  IF p_estilo IS NOT NULL AND p_estilo NOT IN
    ('minimalista', 'premium', 'tecnologico', 'luxo', 'clean', 'infantil', 'marketplace')
  THEN
    RAISE EXCEPTION 'estilo inválido: %', p_estilo;
  END IF;

  -- p_permitir_busca_externa
  IF p_permitir_busca_externa IS NULL THEN
    RAISE EXCEPTION 'p_permitir_busca_externa não pode ser nulo';
  END IF;

  INSERT INTO public.estudio_anuncios_projetos (
    user_id, nome_produto, modo, quantidade_imagens_solicitada,
    permitir_busca_externa, estilo
  ) VALUES (
    v_user_id_normalizado, v_nome_normalizado, p_modo, p_quantidade_imagens,
    p_permitir_busca_externa, p_estilo
  )
  RETURNING * INTO v_projeto;

  FOREACH v_marketplace IN ARRAY v_marketplaces_normalizados LOOP
    INSERT INTO public.estudio_anuncios_projetos_marketplace (projeto_id, marketplace)
    VALUES (v_projeto.id, v_marketplace);
  END LOOP;

  RETURN v_projeto;
END;
$$;

COMMENT ON FUNCTION public.criar_projeto_estudio_anuncios(
  TEXT, TEXT, TEXT[], INTEGER, TEXT, BOOLEAN, TEXT
) IS
  'Cria 1 Projeto Mestre (estudio_anuncios_projetos) + 1 linha de adaptação por marketplace (estudio_anuncios_projetos_marketplace), atomicamente (uma função = uma transação implícita — qualquer INSERT que falhe reverte tudo). Valida internamente (não confia só em TypeScript). Restrita a service_role — ver REVOKE/GRANT abaixo. Chamada exclusivamente por um cliente Supabase server-only, depois que a rota já validou a sessão via getUserId(request) e todo o payload — nunca pelo cliente anon.';

-- Restrição de permissão — ao contrário do padrão default do Supabase
-- (ALTER DEFAULT PRIVILEGES concede EXECUTE a anon/authenticated/
-- service_role automaticamente em toda função nova), esta função exige
-- REVOKE explícito porque recebe p_user_id como parâmetro cru, sem
-- nenhuma verificação de sessão possível dentro da própria função.
REVOKE EXECUTE ON FUNCTION public.criar_projeto_estudio_anuncios(
  TEXT, TEXT, TEXT[], INTEGER, TEXT, BOOLEAN, TEXT
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.criar_projeto_estudio_anuncios(
  TEXT, TEXT, TEXT[], INTEGER, TEXT, BOOLEAN, TEXT
) TO service_role;
