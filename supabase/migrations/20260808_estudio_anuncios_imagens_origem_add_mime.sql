-- supabase/migrations/20260808_estudio_anuncios_imagens_origem_add_mime.sql
-- Adiciona mime_type e nome_original a estudio_anuncios_imagens_origem.
-- Motivo: a rota POST .../fotos precisa devolver mimeType por foto no
-- corpo da resposta (contrato exigido pela tarefa "Upload real da foto
-- do produto"), e nome_original é útil para exibição futura na UI.
-- Nenhuma coluna existente é alterada ou removida. Nullable (não havia
-- linhas existentes na tabela — nenhum upload real tinha sido feito
-- até esta tarefa; grep confirmou zero uso de Storage em todo o
-- repositório antes dela).
--
-- JÁ EXECUTADA E VALIDADA (2026-08-05) — colunas e constraints
-- confirmadas por SQL direto após a execução:
--   information_schema.columns  -> mime_type (text, nullable),
--                                   nome_original (text, nullable)
--   pg_constraint                -> estudio_anuncios_imagens_origem_mime_type_check
--                                   CHECK (mime_type IS NULL OR mime_type = ANY
--                                   (ARRAY['image/jpeg','image/png','image/webp']))
-- Este arquivo documenta, no repositório, o SQL que já rodou no banco
-- — não deve ser executado novamente (IF NOT EXISTS torna reexecução
-- inofensiva de qualquer forma).

ALTER TABLE estudio_anuncios_imagens_origem
  ADD COLUMN IF NOT EXISTS mime_type TEXT
    CHECK (mime_type IS NULL OR mime_type IN ('image/jpeg', 'image/png', 'image/webp')),
  ADD COLUMN IF NOT EXISTS nome_original TEXT;

COMMENT ON COLUMN estudio_anuncios_imagens_origem.mime_type IS
  'MIME real detectado por assinatura de bytes (nunca confiado do client). Restrito ao mesmo conjunto aprovado do bucket estudio-anuncios-originais.';
COMMENT ON COLUMN estudio_anuncios_imagens_origem.nome_original IS
  'Nome do arquivo enviado pelo usuário, só para exibição — nunca usado para montar o caminho no Storage.';
