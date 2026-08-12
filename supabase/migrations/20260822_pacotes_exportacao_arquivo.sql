-- ────────────────────────────────────────────────────────────────────
-- 20260822_pacotes_exportacao_arquivo.sql
--
-- MATERIALIZACAO do pacote de exportacao em arquivo (ZIP).
--
-- PRINCIPIO QUE ESTA MIGRATION PRECISA PROTEGER: o arquivo NAO e a fonte
-- de verdade. A fonte continua sendo a linha de
-- `estudio_anuncios_pacotes_exportacao` -- em especial `itens_incluidos`
-- e `hash_conteudo`, congelados quando o pacote foi gerado. O ZIP e uma
-- MATERIALIZACAO daquele snapshot, e por isso materializar **nao pode
-- alterar** hash_conteudo, itens_incluidos, numero_pacote nem status.
--
-- Isso e garantido ESTRUTURALMENTE, nao por convencao: a RPC abaixo tem
-- uma lista de SET fixa que simplesmente nao inclui essas quatro
-- colunas. Nao existe caminho de codigo capaz de altera-las ao
-- materializar.
--
-- COLUNAS NOVAS (todas aditivas, todas nulas ate a materializacao):
--   `bucket`           -- qual bucket guarda o objeto. Explicito para o
--                         registro nao depender de constante da aplicacao.
--   `mime_type`        -- application/zip (o bucket so aceita esse).
--   `tamanho_bytes`    -- tamanho real do objeto enviado.
--   `checksum_sha256`  -- sha256 dos BYTES DO ARQUIVO. E diferente de
--                         `hash_conteudo` (que resume o CONJUNTO APROVADO):
--                         um responde "o arquivo esta integro", o outro
--                         "o conteudo aprovado e este". Nao confundir.
--   `materializado_em` / `materializado_por`
--
-- `storage_path` ja existia (reservado desde 20260803) e passa a ser
-- preenchido. O COMMENT anterior, que dizia "NULL nesta fase", e
-- substituido.
--
-- Aditiva: nenhuma coluna removida, nenhuma constraint derrubada, nenhum
-- dado alterado. Nada da Fase 1, da camada editorial ou da geracao de
-- pacote e tocado.
-- ────────────────────────────────────────────────────────────────────

ALTER TABLE public.estudio_anuncios_pacotes_exportacao
  ADD COLUMN IF NOT EXISTS bucket            TEXT,
  ADD COLUMN IF NOT EXISTS mime_type         TEXT,
  ADD COLUMN IF NOT EXISTS tamanho_bytes     BIGINT,
  ADD COLUMN IF NOT EXISTS checksum_sha256   TEXT,
  ADD COLUMN IF NOT EXISTS materializado_em  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS materializado_por TEXT;

-- Um pacote esta materializado por inteiro ou nao esta: nunca com
-- caminho gravado e metadado faltando (que produziria download de
-- arquivo cujo tamanho/integridade ninguem consegue conferir).
ALTER TABLE public.estudio_anuncios_pacotes_exportacao
  DROP CONSTRAINT IF EXISTS chk_pacotes_exportacao_materializacao;
ALTER TABLE public.estudio_anuncios_pacotes_exportacao
  ADD CONSTRAINT chk_pacotes_exportacao_materializacao
  CHECK (
    storage_path IS NULL
    OR (bucket IS NOT NULL AND mime_type IS NOT NULL
        AND tamanho_bytes IS NOT NULL AND tamanho_bytes > 0
        AND checksum_sha256 IS NOT NULL AND materializado_em IS NOT NULL)
  );

-- Um objeto do Storage pertence a no maximo um pacote. Sem isso, dois
-- pacotes poderiam apontar para o mesmo arquivo e apagar um deixaria o
-- outro quebrado sem sintoma.
CREATE UNIQUE INDEX IF NOT EXISTS idx_pacotes_exportacao_storage_path
  ON public.estudio_anuncios_pacotes_exportacao (storage_path)
  WHERE storage_path IS NOT NULL;

COMMENT ON COLUMN public.estudio_anuncios_pacotes_exportacao.storage_path IS
  'Caminho do ZIP materializado no bucket privado estudio-anuncios-exportacoes. NULL enquanto o pacote existe apenas como dado estruturado. NUNCA e exposto ao cliente HTTP: o download passa por URL assinada curta gerada na hora.';
COMMENT ON COLUMN public.estudio_anuncios_pacotes_exportacao.checksum_sha256 IS
  'sha256 dos BYTES do arquivo ZIP -- integridade do objeto. Nao confundir com hash_conteudo, que identifica o CONJUNTO de versoes aprovadas congeladas no pacote.';
COMMENT ON COLUMN public.estudio_anuncios_pacotes_exportacao.materializado_em IS
  'Quando o ZIP deste pacote foi gerado pela primeira vez. Rematerializar (objeto apagado do Storage) reescreve o MESMO caminho com bytes identicos e NAO altera esta linha -- nao cria pacote novo, nao mexe em hash_conteudo/itens_incluidos/numero_pacote/status.';

-- ────────────────────────────────────────────────────────────────────
-- RPC: registrar o arquivo materializado
--
-- POR QUE EXISTE (a tarefa pedia para avaliar se era necessaria): nao e
-- por ser um UPDATE -- e pelas tres invariantes que so o banco consegue
-- garantir na mesma transacao:
--   a) o pacote e travado com FOR UPDATE, entao duas materializacoes
--      concorrentes do mesmo pacote serializam em vez de disputar;
--   b) se o pacote JA tem storage_path diferente do que esta sendo
--      registrado, a funcao LANCA -- nunca reaponta o pacote para outro
--      arquivo em silencio (isso orfanaria o objeto anterior);
--   c) o SET nao inclui hash_conteudo, itens_incluidos, numero_pacote
--      nem status: materializar e estruturalmente incapaz de mexer no
--      snapshot congelado.
-- Revalida `p_projeto_id` porque recebe parametro cru e nao tem sessao
-- para confiar (Constituicao 27.3).
-- ────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.estudio_anuncios_registrar_arquivo_pacote(
  p_pacote_id       UUID,
  p_projeto_id      UUID,
  p_bucket          TEXT,
  p_storage_path    TEXT,
  p_mime_type       TEXT,
  p_tamanho_bytes   BIGINT,
  p_checksum        TEXT,
  p_materializado_por TEXT
)
RETURNS public.estudio_anuncios_pacotes_exportacao
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_pacote public.estudio_anuncios_pacotes_exportacao;
BEGIN
  IF p_storage_path IS NULL OR p_bucket IS NULL OR p_checksum IS NULL
     OR p_tamanho_bytes IS NULL OR p_tamanho_bytes <= 0 THEN
    RAISE EXCEPTION 'PARAMETROS_INVALIDOS: arquivo materializado exige bucket, caminho, checksum e tamanho > 0';
  END IF;

  SELECT * INTO v_pacote
  FROM public.estudio_anuncios_pacotes_exportacao
  WHERE id = p_pacote_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'PACOTE_NAO_ENCONTRADO: %', p_pacote_id;
  END IF;

  -- O pacote precisa ser do projeto informado: a RPC nao confia no
  -- chamador so porque ele mandou os dois ids.
  IF v_pacote.projeto_id <> p_projeto_id THEN
    RAISE EXCEPTION 'PACOTE_DE_OUTRO_PROJETO: %', p_pacote_id;
  END IF;

  -- Ja materializado no MESMO caminho: idempotente, devolve como esta.
  IF v_pacote.storage_path IS NOT NULL AND v_pacote.storage_path = p_storage_path THEN
    RETURN v_pacote;
  END IF;

  -- Ja materializado em OUTRO caminho: erro explicito, nunca reaponta.
  IF v_pacote.storage_path IS NOT NULL THEN
    RAISE EXCEPTION 'PACOTE_JA_MATERIALIZADO_EM_OUTRO_CAMINHO: %', p_pacote_id;
  END IF;

  UPDATE public.estudio_anuncios_pacotes_exportacao
     SET bucket            = p_bucket,
         storage_path      = p_storage_path,
         mime_type         = p_mime_type,
         tamanho_bytes     = p_tamanho_bytes,
         checksum_sha256   = p_checksum,
         materializado_em  = now(),
         materializado_por = p_materializado_por
   WHERE id = p_pacote_id
  RETURNING * INTO v_pacote;

  RETURN v_pacote;
END;
$$;

COMMENT ON FUNCTION public.estudio_anuncios_registrar_arquivo_pacote IS
  'Registra o ZIP materializado de um pacote, sob FOR UPDATE. Idempotente para o mesmo caminho; lanca se o pacote ja aponta para outro arquivo. NUNCA altera hash_conteudo, itens_incluidos, numero_pacote nem status -- materializar nao muda o snapshot congelado.';

REVOKE EXECUTE ON FUNCTION public.estudio_anuncios_registrar_arquivo_pacote(UUID, UUID, TEXT, TEXT, TEXT, BIGINT, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.estudio_anuncios_registrar_arquivo_pacote(UUID, UUID, TEXT, TEXT, TEXT, BIGINT, TEXT, TEXT)
  TO service_role;
