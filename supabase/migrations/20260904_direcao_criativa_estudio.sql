-- ────────────────────────────────────────────────────────────────────
-- 20260904_direcao_criativa_estudio.sql
--
-- DIRECAO CRIATIVA do ensaio + INSTRUCAO POR IMAGEM. Nenhum anuncio e
-- criado, nenhuma imagem e gerada, nenhuma chamada de IA acontece aqui.
--
-- ── Por que isto existe ─────────────────────────────────────────────
-- No primeiro E2E real com IA, as imagens sairam com "cara de IA" e sem
-- estrategia comercial distinta entre elas. A auditoria de 2026-09-04
-- mostrou que o usuario nao tinha ONDE dizer o que queria: a etapa
-- `geracao_prompts_imagem` recebia apenas `analise_visual` e a
-- configuracao do projeto (quantidade/estilo/modo). Nao havia campo
-- para direcao criativa geral nem para instrucao por imagem.
--
-- Mesma classe de defeito ja corrigida em 2026-09-04 nos atributos do
-- Mercado Livre: o servidor sabia receber, a tela nao sabia pedir.
--
-- ── Por que colunas NOVAS, e nao reuso de `estilo` ──────────────────
-- `estilo` e um enum curto de aparencia (CHECK no banco), aplicado
-- igualmente a TODAS as imagens. Direcao criativa e texto livre do
-- usuario sobre o ensaio inteiro, e a instrucao por imagem e texto
-- livre sobre UMA imagem. Sao tres coisas diferentes:
--   * estilo            -> vocabulario fechado, uniforme
--   * direcao_criativa  -> texto livre, uniforme
--   * direcoes_imagens  -> texto livre, POR IMAGEM
-- Espremer as duas novas dentro de `estilo` quebraria o CHECK e
-- misturaria vocabulario fechado com texto livre.
--
-- ── Por que JSONB para as instrucoes por imagem ─────────────────────
-- A quantidade e do projeto (`quantidade_imagens_solicitada`, hoje 4, 6,
-- 8 ou 10) e pode mudar. Colunas fixas (`instrucao_1`..`instrucao_10`)
-- amarrariam o schema a um teto arbitrario e obrigariam migration a cada
-- ajuste. O JSONB guarda um ARRAY de strings, indexado por posicao:
-- posicao 0 = imagem 1. Posicao vazia ("") significa "a IA decide" —
-- e um valor legitimo, nao ausencia de dado.
--
-- ── O que este arquivo deliberadamente NAO faz ──────────────────────
-- * Nao cria tabela nova: sao dois atributos do projeto, nao entidade.
-- * Nao altera a RPC `criar_projeto_estudio_anuncios`: os dois campos
--   sao preenchidos por EDICAO do projeto (UPDATE ja existente), depois
--   de criado. Mexer na assinatura da RPC de criacao para dois campos
--   opcionais seria risco sem ganho.
-- * Nao define default nao-nulo: projeto sem direcao criativa e o caso
--   NORMAL, e significa exatamente "a IA decide tudo".
-- * Nao apaga nem reescreve nada de projetos existentes.
--
-- IDEMPOTENTE: pode rodar mais de uma vez sem efeito colateral.
-- ────────────────────────────────────────────────────────────────────

ALTER TABLE public.estudio_anuncios_projetos
  ADD COLUMN IF NOT EXISTS direcao_criativa TEXT,
  ADD COLUMN IF NOT EXISTS direcoes_imagens JSONB;

-- Texto livre, mas nao ilimitado: um campo gigante viraria prompt
-- gigante, e prompt gigante degrada a geracao alem de encarecer a
-- chamada. 2000 caracteres cobrem folgadamente um briefing de ensaio.
-- NULL continua valido (= sem direcao).
ALTER TABLE public.estudio_anuncios_projetos
  DROP CONSTRAINT IF EXISTS estudio_anuncios_projetos_direcao_criativa_tamanho;
ALTER TABLE public.estudio_anuncios_projetos
  ADD CONSTRAINT estudio_anuncios_projetos_direcao_criativa_tamanho
  CHECK (direcao_criativa IS NULL OR char_length(direcao_criativa) <= 2000);

-- `direcoes_imagens` precisa ser um ARRAY de STRINGS, ou NULL. Sem esta
-- checagem, um objeto ou um array de numeros passaria e so estouraria
-- na etapa de prompts — longe da causa.
--
-- O tamanho do array NAO e amarrado aqui a
-- `quantidade_imagens_solicitada`: a pessoa pode reduzir a quantidade
-- depois de escrever as instrucoes, e apagar texto que ela escreveu
-- seria perda silenciosa de trabalho. A etapa de prompts le apenas as
-- N primeiras posicoes; o excedente fica guardado e volta a aparecer se
-- a quantidade subir de novo. O teto de 12 acompanha
-- LIMITE_MAXIMO_PROMPTS_IMAGEM em geracao-prompts-imagem-tipos.ts.
-- A validacao por ELEMENTO precisa de funcao: o Postgres recusa
-- subquery dentro de CHECK ("cannot use subquery in check constraint"),
-- e verificar cada item exige percorrer o array. A funcao e IMMUTABLE e
-- so le o proprio argumento, que e o que torna seu uso em CHECK valido.
CREATE OR REPLACE FUNCTION public.estudio_anuncios_direcoes_imagens_validas(p_valor JSONB)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT p_valor IS NULL
     OR (
       jsonb_typeof(p_valor) = 'array'
       AND jsonb_array_length(p_valor) <= 12
       AND NOT EXISTS (
         SELECT 1
         FROM jsonb_array_elements(p_valor) AS elemento
         WHERE jsonb_typeof(elemento) <> 'string'
            OR char_length(elemento #>> '{}') > 500
       )
     );
$$;

COMMENT ON FUNCTION public.estudio_anuncios_direcoes_imagens_validas(JSONB) IS
  'Valida direcoes_imagens: NULL, ou array JSON de ate 12 strings de ate 500 caracteres cada. Existe porque CHECK nao aceita subquery diretamente.';

ALTER TABLE public.estudio_anuncios_projetos
  DROP CONSTRAINT IF EXISTS estudio_anuncios_projetos_direcoes_imagens_formato;
ALTER TABLE public.estudio_anuncios_projetos
  ADD CONSTRAINT estudio_anuncios_projetos_direcoes_imagens_formato
  CHECK (public.estudio_anuncios_direcoes_imagens_validas(direcoes_imagens));

COMMENT ON COLUMN public.estudio_anuncios_projetos.direcao_criativa IS
  'Direcao criativa do ensaio inteiro, escrita pelo usuario. Texto livre, opcional, ate 2000 caracteres. NULL = a IA decide a estrategia. NUNCA e enviada como prompt bruto ao gerador de imagem: a etapa geracao_prompts_imagem a interpreta junto da verdade visual confirmada.';

COMMENT ON COLUMN public.estudio_anuncios_projetos.direcoes_imagens IS
  'Array JSON de instrucoes por imagem, indexado por posicao (posicao 0 = imagem 1). Cada item e string de ate 500 caracteres; string vazia significa "a IA decide esta imagem". NULL = nenhuma instrucao individual. O array pode ser maior que quantidade_imagens_solicitada (a etapa le so as N primeiras) para nao apagar texto do usuario quando a quantidade diminui. Assim como direcao_criativa, NUNCA vai como prompt bruto ao gerador.';
