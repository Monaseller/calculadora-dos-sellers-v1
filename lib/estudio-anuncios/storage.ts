/**
 * Storage do Estúdio de Anúncios — upload real da foto do produto.
 *
 * ETAPA (2026-08-08 — Upload real da foto do produto). Primeiro uso de
 * Supabase Storage em todo o repositório (grep prévio confirmou zero
 * ocorrências de `storage.from(`/`createSignedUrl` fora deste
 * arquivo). Bucket já existe e já está configurado (privado, 10MB/
 * arquivo, MIME jpeg/png/webp) — este módulo NUNCA cria/reconfigura o
 * bucket, só usa.
 *
 * Bibliotecas novas instaladas nesta tarefa (aprovadas pelo usuário,
 * compatibilidade confirmada antes da instalação — Node v24.16.0 no
 * ambiente do usuário):
 * - file-type@^22 — detecta o MIME real por assinatura de bytes
 *   (magic bytes), nunca confia em `file.type` do cliente.
 * - image-size@^2 — extrai largura/altura a partir do buffer real.
 * Sharp NÃO foi instalado (fora de escopo desta etapa — será usado no
 * futuro para imagem mestre/redimensionamento/exportação 1200x1200).
 *
 * Regras de segurança (não violar):
 * - O caminho do objeto é montado exclusivamente aqui, no servidor,
 *   nunca a partir de valor vindo do cliente.
 * - Nome original nunca é usado cru no caminho — é sanitizado, e a
 *   extensão final vem do MIME real detectado (nunca da extensão
 *   declarada do arquivo).
 * - Upload/delete/URL assinada sempre via cliente service role
 *   (getSupabaseServidor()) — a rota chamadora só usa isso DEPOIS de
 *   confirmar a propriedade do projeto com o cliente anon comum.
 * - Nunca gera URL pública. Nunca retorna a chave/caminho bruto do
 *   Storage para o cliente HTTP (a rota expõe só urlAssinada).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { fileTypeFromBuffer } from "file-type";
import { imageSize } from "image-size";

/** Bucket das fotos ORIGINAIS enviadas pelo usuário — já existe, privado, aprovado. */
export const BUCKET_FOTOS_ORIGINAIS = "estudio-anuncios-originais";

/**
 * Bucket das imagens GERADAS pela IA (etapa `geracao_imagem`,
 * 2026-08-16). **Já existia** no projeto Supabase antes desta tarefa —
 * privado, 200MB por arquivo, MIME jpeg/png/webp/mp4 (verificado em
 * `storage.buckets`). Nenhum bucket foi criado nem reconfigurado: o
 * `NEXT_TASK.md` afirmava "buckets de saída nunca criados", e a
 * auditoria de 2026-08-16 mostrou que a afirmação estava desatualizada.
 */
export const BUCKET_IMAGENS_GERADAS = "estudio-anuncios-gerado";

/**
 * Bucket dos PACOTES de exportação materializados (2026-08-22).
 * **Já existia** no projeto Supabase antes desta tarefa — privado, 300MB
 * por arquivo, MIME `application/zip` apenas (verificado em
 * `storage.buckets` na auditoria de 2026-08-22). Nenhum bucket foi criado
 * nem reconfigurado nesta etapa.
 */
export const BUCKET_PACOTES_EXPORTACAO = "estudio-anuncios-exportacoes";

/** O bucket só aceita este MIME — declarado aqui para não divergir dele. */
export const MIME_PACOTE_EXPORTACAO = "application/zip";

/** Mesmo conjunto aprovado para o bucket e para a coluna mime_type (CHECK no banco). */
export const MIME_TYPES_ACEITOS = ["image/jpeg", "image/png", "image/webp"] as const;
export type MimeAceito = (typeof MIME_TYPES_ACEITOS)[number];

export const TAMANHO_MAXIMO_BYTES = 10 * 1024 * 1024; // 10 MB, igual à config do bucket
export const MAX_FOTOS_POR_PROJETO = 10;

const EXTENSAO_POR_MIME: Record<MimeAceito, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

function ehMimeAceito(mime: string | undefined): mime is MimeAceito {
  return !!mime && (MIME_TYPES_ACEITOS as readonly string[]).includes(mime);
}

/**
 * Detecta o MIME real do arquivo pela assinatura de bytes (magic
 * bytes) — nunca pelo `file.type` declarado pelo browser. Devolve
 * `null` quando o formato não é reconhecido ou não está entre os
 * aceitos (mesmo que file-type reconheça outro formato de imagem,
 * por exemplo GIF ou TIFF — este bucket só aceita jpeg/png/webp).
 */
export async function detectarMimeReal(buffer: Uint8Array): Promise<MimeAceito | null> {
  const resultado = await fileTypeFromBuffer(buffer);
  if (!resultado) return null;
  return ehMimeAceito(resultado.mime) ? resultado.mime : null;
}

/**
 * Extrai largura/altura reais do buffer. "Melhor esforço" — nunca
 * lança, nunca bloqueia o upload: se o parsing falhar, devolve
 * `null` para largura/altura (a tarefa permite gravar dimensões nulas
 * quando não obtidas com segurança).
 */
export function obterDimensoes(buffer: Uint8Array): { largura: number; altura: number } | null {
  try {
    const info = imageSize(buffer);
    if (!info || !info.width || !info.height) return null;
    return { largura: info.width, altura: info.height };
  } catch {
    return null;
  }
}

/**
 * Sanitiza o nome original do arquivo para uso no caminho do Storage.
 * Nunca confia no nome original para segurança (path traversal,
 * caracteres de controle, etc.) — só o usa para legibilidade humana
 * do caminho final. A extensão final é SEMPRE derivada do MIME real
 * detectado (mimeReal), nunca da extensão que o arquivo já tinha.
 */
export function sanitizarNomeArquivo(nomeOriginal: string, mimeReal: MimeAceito): string {
  // Remove qualquer componente de diretório (../, caminhos absolutos, etc.)
  const baseOriginal = nomeOriginal.split(/[/\\]/).pop() || "";
  // Remove a extensão original — a extensão final vem do MIME real.
  const semExtensao = baseOriginal.replace(/\.[^.]+$/, "");
  // Só [a-zA-Z0-9._-], colapsa underscores repetidos, corta tamanho.
  let seguro = semExtensao
    .normalize("NFKD")
    .replace(/[^\w.-]+/g, "_")
    .replace(/_{2,}/g, "_")
    .replace(/^[._-]+|[._-]+$/g, "")
    .slice(0, 60);
  if (!seguro) seguro = "foto";
  return `${seguro}.${EXTENSAO_POR_MIME[mimeReal]}`;
}

/**
 * Monta o caminho determinístico e isolado do objeto no bucket:
 * {user_id}/{projeto_id}/{imagem_id}/{nome_seguro}. `imagemId` deve
 * ser gerado pelo chamador via crypto.randomUUID() ANTES do upload —
 * garante que cada foto tem um diretório próprio (nunca sobrescreve
 * outra, mesmo com nomes de arquivo repetidos).
 */
export function montarCaminhoObjeto(
  userId: string,
  projetoId: string,
  imagemId: string,
  nomeSeguro: string
): string {
  return `${userId}/${projetoId}/${imagemId}/${nomeSeguro}`;
}

/**
 * Faz upload do objeto para o bucket privado. Lança em caso de erro
 * (o chamador decide a resposta ao cliente — nenhuma linha de banco
 * deve ser inserida antes deste upload ter sucesso).
 */
export async function uploadObjeto(
  supabaseServico: SupabaseClient,
  caminho: string,
  buffer: Uint8Array,
  mimeType: MimeAceito
): Promise<void> {
  const { error } = await supabaseServico.storage
    .from(BUCKET_FOTOS_ORIGINAIS)
    .upload(caminho, buffer, { contentType: mimeType, upsert: false });
  if (error) {
    throw new Error(`Falha ao enviar arquivo ao Storage: ${error.message}`);
  }
}

/**
 * Exclui um objeto do bucket — usado exclusivamente como ação
 * compensatória quando o upload teve sucesso mas o INSERT no banco
 * falhou. Nunca lança: devolve {ok:false} para o chamador decidir como
 * logar (nunca mascarar um arquivo órfão).
 */
export async function excluirObjeto(
  supabaseServico: SupabaseClient,
  caminho: string
): Promise<{ ok: boolean; erro?: string }> {
  const { error } = await supabaseServico.storage.from(BUCKET_FOTOS_ORIGINAIS).remove([caminho]);
  if (error) return { ok: false, erro: error.message };
  return { ok: true };
}

/**
 * Baixa os bytes reais de um objeto do bucket privado — exclusivo do
 * servidor (service role), usado pela análise visual (Gemini) para
 * ler o conteúdo real da foto sem nunca gerar URL pública nem expor o
 * caminho do Storage a nenhum cliente HTTP.
 *
 * ETAPA (2026-08-09 — Primeira API real: Gemini para análise visual).
 */
export async function baixarObjeto(
  supabaseServico: SupabaseClient,
  caminho: string
): Promise<Uint8Array> {
  const { data, error } = await supabaseServico.storage.from(BUCKET_FOTOS_ORIGINAIS).download(caminho);
  if (error || !data) {
    throw new Error(`Falha ao baixar objeto do Storage: ${error?.message ?? "sem dados retornados"}`);
  }
  const arrayBuffer = await data.arrayBuffer();
  return new Uint8Array(arrayBuffer);
}

// ────────────────────────────────────────────────────────────────────
// Imagens GERADAS (etapa geracao_imagem, 2026-08-16)
//
// Funções próprias em vez de parametrizar as de cima por bucket: as
// existentes são chamadas por rotas de upload e pela análise visual, e
// mudar a assinatura delas seria refatoração sem necessidade. Aqui o
// bucket é sempre BUCKET_IMAGENS_GERADAS, nunca um parâmetro — não
// existe caminho de código em que a etapa de geração escreva no bucket
// das fotos originais.
// ────────────────────────────────────────────────────────────────────

/**
 * Caminho determinístico do objeto gerado:
 * `{user_id}/{projeto_id}/geradas/{job_id}/{imagem_id}.{ext}`
 *
 * Propriedades que importam (todas verificadas por teste):
 * - **Nunca** usa nome vindo do modelo nem do cliente — só UUIDs que o
 *   servidor gerou e a extensão derivada do MIME REAL detectado.
 * - Prefixado por `user_id`, então nunca cruza usuário; `projeto_id`
 *   logo em seguida, então nunca cruza projeto.
 * - Segmentado por `job_id`, então um job **nunca** sobrescreve o
 *   arquivo de outro job, nem em retry, nem em regeração.
 */
export function montarCaminhoImagemGerada(
  userId: string,
  projetoId: string,
  jobId: string,
  imagemId: string,
  mimeReal: MimeAceito
): string {
  return `${userId}/${projetoId}/geradas/${jobId}/${imagemId}.${EXTENSAO_POR_MIME[mimeReal]}`;
}

/**
 * Sobe a imagem gerada. `upsert: false` de propósito — se o objeto já
 * existe, o Storage recusa e o chamador trata como inconsistência
 * explícita, nunca sobrescreve em silêncio.
 */
export async function uploadImagemGerada(
  supabaseServico: SupabaseClient,
  caminho: string,
  buffer: Uint8Array,
  mimeType: MimeAceito
): Promise<void> {
  const { error } = await supabaseServico.storage
    .from(BUCKET_IMAGENS_GERADAS)
    .upload(caminho, buffer, { contentType: mimeType, upsert: false });
  if (error) {
    throw new Error(`Falha ao enviar imagem gerada ao Storage: ${error.message}`);
  }
}

/**
 * Verifica se o objeto existe de fato no bucket, sem baixar os bytes —
 * base dos cenários de idempotência (linha no banco com/sem arquivo).
 * Usa `list` no diretório do objeto porque é a única operação do SDK que
 * responde sobre existência sem transferir conteúdo nem gerar URL.
 */
export async function imagemGeradaExiste(
  supabaseServico: SupabaseClient,
  caminho: string
): Promise<boolean> {
  const barra = caminho.lastIndexOf("/");
  const diretorio = barra === -1 ? "" : caminho.slice(0, barra);
  const arquivo = barra === -1 ? caminho : caminho.slice(barra + 1);
  const { data, error } = await supabaseServico.storage
    .from(BUCKET_IMAGENS_GERADAS)
    .list(diretorio, { search: arquivo, limit: 100 });
  if (error) return false;
  return (data ?? []).some(o => o.name === arquivo);
}

/**
 * Exclui um objeto gerado — usado exclusivamente como ação
 * compensatória quando o upload teve sucesso mas o INSERT no banco
 * falhou. Nunca lança: devolve {ok:false} para o chamador nunca
 * mascarar um arquivo órfão.
 */
export async function excluirImagemGerada(
  supabaseServico: SupabaseClient,
  caminho: string
): Promise<{ ok: boolean; erro?: string }> {
  const { error } = await supabaseServico.storage.from(BUCKET_IMAGENS_GERADAS).remove([caminho]);
  if (error) return { ok: false, erro: error.message };
  return { ok: true };
}

/**
 * URL assinada temporária de uma imagem GERADA (2026-08-19, UI de
 * resultado). Função própria em vez de parametrizar `gerarUrlAssinada()`
 * por bucket, pelo mesmo motivo do bloco acima: as existentes já são
 * chamadas por rotas de foto original e mudar a assinatura delas seria
 * refatoração sem necessidade.
 *
 * Duração curta de propósito e **nunca persistida** — é gerada na hora,
 * a cada leitura, só para exibir. O bucket continua privado; nenhuma URL
 * pública é criada em nenhum ponto.
 */
export async function gerarUrlAssinadaImagemGerada(
  supabaseServico: SupabaseClient,
  caminho: string,
  expiresInSegundos = 900
): Promise<string | null> {
  const { data, error } = await supabaseServico.storage
    .from(BUCKET_IMAGENS_GERADAS)
    .createSignedUrl(caminho, expiresInSegundos);
  if (error || !data?.signedUrl) return null;
  return data.signedUrl;
}

/**
 * Baixa os bytes de uma imagem GERADA. Necessário para materializar o
 * pacote de exportação: as imagens entram no ZIP como bytes exatos, e
 * ler o objeto pelo service role é a única forma de fazer isso sem gerar
 * URL (pública ou assinada) para o Storage.
 */
export async function baixarImagemGerada(
  supabaseServico: SupabaseClient,
  caminho: string
): Promise<Uint8Array> {
  const { data, error } = await supabaseServico.storage.from(BUCKET_IMAGENS_GERADAS).download(caminho);
  if (error || !data) {
    throw new Error(`Falha ao baixar imagem gerada do Storage: ${error?.message ?? "sem dados retornados"}`);
  }
  return new Uint8Array(await data.arrayBuffer());
}

// ────────────────────────────────────────────────────────────────────
// Pacotes de exportação materializados (2026-08-22)
//
// Mesmo padrão dos dois blocos acima: funções próprias por bucket, nunca
// um parâmetro `bucket`. Não existe caminho de código em que a exportação
// escreva no bucket das fotos originais ou no das imagens geradas.
// ────────────────────────────────────────────────────────────────────

/**
 * Caminho determinístico do ZIP:
 * `{user_id}/{projeto_id}/exportacoes/{pacote_id}/pacote-0001.zip`
 *
 * - Prefixado por `user_id` e `projeto_id`: nunca cruza usuário nem projeto.
 * - Segmentado por `pacote_id`: um pacote nunca sobrescreve o arquivo de
 *   outro, e rematerializar o MESMO pacote reescreve exatamente o mesmo
 *   caminho — que é o que torna a operação idempotente no Storage.
 * - O último segmento é legível porque é ele que vira o nome do arquivo
 *   baixado.
 */
export function montarCaminhoPacoteExportacao(
  userId: string,
  projetoId: string,
  pacoteId: string,
  numeroPacote: number
): string {
  const nome = `pacote-${String(numeroPacote).padStart(4, "0")}.zip`;
  return `${userId}/${projetoId}/exportacoes/${pacoteId}/${nome}`;
}

/**
 * Sobe o ZIP. `upsert: false` de propósito: se o objeto já existe, o
 * Storage recusa e o chamador trata como "já materializado" — nunca
 * sobrescreve em silêncio.
 */
export async function uploadPacoteExportacao(
  supabaseServico: SupabaseClient,
  caminho: string,
  buffer: Uint8Array
): Promise<{ ok: true } | { ok: false; jaExiste: boolean; erro: string }> {
  const { error } = await supabaseServico.storage
    .from(BUCKET_PACOTES_EXPORTACAO)
    .upload(caminho, buffer, { contentType: MIME_PACOTE_EXPORTACAO, upsert: false });
  if (!error) return { ok: true };
  const msg = error.message ?? "";
  const jaExiste = /exists|duplicate|409/i.test(msg);
  return { ok: false, jaExiste, erro: msg };
}

/** Existência do ZIP sem transferir bytes — base da rematerialização. */
export async function pacoteExportacaoExiste(
  supabaseServico: SupabaseClient,
  caminho: string
): Promise<boolean> {
  const barra = caminho.lastIndexOf("/");
  const diretorio = barra === -1 ? "" : caminho.slice(0, barra);
  const arquivo = barra === -1 ? caminho : caminho.slice(barra + 1);
  const { data, error } = await supabaseServico.storage
    .from(BUCKET_PACOTES_EXPORTACAO)
    .list(diretorio, { search: arquivo, limit: 100 });
  if (error) return false;
  return (data ?? []).some(o => o.name === arquivo);
}

/**
 * URL assinada curta do ZIP, gerada na hora e **nunca persistida**. O
 * bucket continua privado; nenhuma URL pública é criada em ponto algum.
 */
export async function gerarUrlAssinadaPacoteExportacao(
  supabaseServico: SupabaseClient,
  caminho: string,
  expiresInSegundos = 300
): Promise<string | null> {
  const { data, error } = await supabaseServico.storage
    .from(BUCKET_PACOTES_EXPORTACAO)
    .createSignedUrl(caminho, expiresInSegundos);
  if (error || !data?.signedUrl) return null;
  return data.signedUrl;
}

/**
 * Gera uma URL assinada temporária para exibição — nunca uma URL
 * pública. A URL nunca é persistida no banco (é gerada sob demanda a
 * cada leitura). `expiresInSegundos` default de 1h é suficiente para
 * uma sessão de visualização da tela de detalhe.
 */
export async function gerarUrlAssinada(
  supabaseServico: SupabaseClient,
  caminho: string,
  expiresInSegundos = 3600
): Promise<string | null> {
  const { data, error } = await supabaseServico.storage
    .from(BUCKET_FOTOS_ORIGINAIS)
    .createSignedUrl(caminho, expiresInSegundos);
  if (error || !data?.signedUrl) return null;
  return data.signedUrl;
}
