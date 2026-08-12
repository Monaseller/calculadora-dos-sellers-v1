/**
 * MATERIALIZAÇÃO do pacote de exportação em arquivo ZIP (2026-08-22).
 *
 * PRINCÍPIO CENTRAL, do qual todo o resto deste arquivo decorre:
 * **o arquivo não é a fonte de verdade.** A fonte é a linha congelada de
 * `estudio_anuncios_pacotes_exportacao` — em especial `itens_incluidos`.
 * Por isso o ZIP é montado EXCLUSIVAMENTE a partir do pacote: nenhuma
 * função aqui lê `conteudo_versoes`, `resultados_pipeline`, adaptações ou
 * qualquer estado atual do projeto. Um pacote gerado ontem materializa
 * hoje exatamente o que foi aprovado ontem, mesmo que tudo tenha mudado.
 *
 * A ÚNICA leitura fora do pacote é a resolução das IMAGENS: o snapshot
 * guarda `imagemGeradaId` (nunca bytes, nunca URL), então o `storage_path`
 * precisa ser resolvido por id. É resolução de referência, não
 * re-derivação de conteúdo — e mesmo assim é validada contra o projeto do
 * pacote, e a ausência de uma imagem referenciada é ERRO EXPLÍCITO, nunca
 * um ZIP silenciosamente incompleto.
 *
 * NÃO PUBLICA, NÃO CHAMA IA, NÃO REGENERA NADA. Zero custo de IA: as
 * imagens são copiadas byte a byte do bucket.
 *
 * DETERMINISMO: o ZIP é montado com o `criado_em` do pacote como
 * timestamp de todas as entradas e nível de compressão fixo. Materializar
 * o mesmo pacote duas vezes produz bytes idênticos — o que é usado como
 * verificação de integridade na rematerialização.
 */
import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { montarZip, type EntradaZip } from "./zip";
import { paraUI } from "./exportacao";
import type { CanalExportado, ItensIncluidos, PacoteExportacaoUI } from "./exportacao";
import {
  BUCKET_PACOTES_EXPORTACAO,
  MIME_PACOTE_EXPORTACAO,
  baixarImagemGerada,
  gerarUrlAssinadaPacoteExportacao,
  montarCaminhoPacoteExportacao,
  pacoteExportacaoExiste,
  uploadPacoteExportacao,
} from "./storage";

export const SCHEMA_VERSAO_ARQUIVO_PACOTE = 1;

/** Separador `;`: o CSV é lido por humanos em Excel pt-BR, onde `,` quebra. */
const SEP_CSV = ";";
/** BOM: sem ele o Excel pt-BR exibe acento quebrado num arquivo UTF-8 válido. */
const BOM = "﻿";

const EXTENSAO_POR_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

/** Erro dedicado: o ZIP reconstruído divergiu do que foi materializado. */
export class ErroChecksumDivergente extends Error {
  constructor(public readonly pacoteId: string) {
    super(
      `O ZIP reconstruído do pacote ${pacoteId} não bate com o checksum registrado. ` +
        `Nada foi enviado ao Storage — investigar antes de rematerializar.`
    );
    this.name = "ErroChecksumDivergente";
  }
}

// ────────────────────────────────────────────────────────────────────
// Nomes — todos determinísticos, nenhum GUID aleatório
// ────────────────────────────────────────────────────────────────────

/** `pacote-0001` — a raiz do ZIP, legível e ordenável. */
export function nomeDiretorioPacote(numeroPacote: number | null): string {
  const n = numeroPacote && numeroPacote > 0 ? numeroPacote : 1;
  return `pacote-${String(n).padStart(4, "0")}`;
}

/**
 * Segmento de caminho seguro: minúsculas, só `[a-z0-9_-]`. Vale tanto
 * para "TikTok Shop" → `tiktok-shop` quanto para qualquer valor
 * inesperado de `finalidade` — nunca cria `../`, espaço ou acento no
 * caminho interno do ZIP.
 */
export function sanitizarSegmento(valor: string): string {
  const seguro = valor
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return seguro || "sem-nome";
}

/** `01-capa_principal.jpg` — posição fixa + finalidade, nunca id aleatório. */
export function nomeArquivoImagem(indice: number, finalidade: string, mimeType: string | null): string {
  const ext = EXTENSAO_POR_MIME[mimeType ?? ""] ?? "bin";
  return `${String(indice).padStart(2, "0")}-${sanitizarSegmento(finalidade)}.${ext}`;
}

// ────────────────────────────────────────────────────────────────────
// CSV — humano
// ────────────────────────────────────────────────────────────────────

function campoCsv(valor: string): string {
  const precisaAspas = /[";\r\n]/.test(valor);
  const escapado = valor.replace(/"/g, '""');
  return precisaAspas ? `"${escapado}"` : escapado;
}

/**
 * Um CSV por canal, com uma linha de dados. `bullets` e `especificacoes`
 * são achatados para leitura humana — e é exatamente por isso que o
 * `conteudo.json` existe ao lado: lá a estrutura é preservada sem perda.
 * IDs internos ficam de fora, com uma exceção deliberada:
 * `versao_aprovada_id`, que é o que torna a exportação auditável.
 */
export function montarCsvCanal(canal: CanalExportado): string {
  const colunas = [
    "titulo", "descricao", "bullets", "especificacoes", "cta",
    "numero_versao", "versao_aprovada_id", "aprovado_em",
  ];
  const c = canal.conteudo;
  const linha = [
    c.titulo ?? "",
    c.descricao ?? "",
    (c.bullets ?? []).join(" | "),
    (c.especificacoes ?? []).map(e => `${e.nome}=${e.valor}`).join(" | "),
    c.cta ?? "",
    String(canal.numeroVersao),
    canal.versaoAprovadaId,
    canal.aprovadoEm ?? "",
  ];
  return BOM + colunas.join(SEP_CSV) + "\r\n" + linha.map(campoCsv).join(SEP_CSV) + "\r\n";
}

// ────────────────────────────────────────────────────────────────────
// Montagem do ZIP — função pura
// ────────────────────────────────────────────────────────────────────

export interface ManifestPacote {
  schemaVersaoArquivo: number;
  schemaVersaoPacote: number;
  pacote: {
    id: string;
    numeroPacote: number | null;
    status: string;
    hashConteudo: string | null;
    geradoEm: string;
    geradoPor: string | null;
  };
  projeto: { id: string; nomeProduto: string };
  canais: unknown[];
  imagens: unknown[];
  arquivos: string[];
  observacoes: string[];
}

function texto(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

/**
 * Monta as entradas do ZIP a partir do pacote CONGELADO. Pura: recebe os
 * bytes das imagens já resolvidos e não toca em banco nem em rede — é o
 * que permite testar a estrutura inteira sem Supabase.
 *
 * Diretório de marketplace só existe para canal EXPORTÁVEL. Um canal sem
 * versão aprovada não ganha pasta vazia nem CSV em branco (que sugeriria
 * conteúdo inexistente): ele aparece no manifesto com `exportavel: false`
 * e o motivo.
 */
export function montarEntradasZip(
  pacote: PacoteExportacaoUI,
  bytesPorImagem: Map<string, Uint8Array>
): EntradaZip[] {
  const itens = pacote.itens as ItensIncluidos;
  const raiz = nomeDiretorioPacote(pacote.numeroPacote);

  const canaisManifest: unknown[] = [];
  const entradasCanais: EntradaZip[] = [];
  for (const canal of itens.canais ?? []) {
    if (!canal.exportavel) {
      canaisManifest.push({ marketplace: canal.marketplace, exportavel: false, motivo: canal.motivo });
      continue;
    }
    const dir = sanitizarSegmento(canal.marketplace);
    const arquivo = `${dir}/conteudo.csv`;
    entradasCanais.push({ caminho: `${raiz}/${arquivo}`, dados: texto(montarCsvCanal(canal)) });
    canaisManifest.push({
      marketplace: canal.marketplace,
      exportavel: true,
      versaoAprovadaId: canal.versaoAprovadaId,
      numeroVersao: canal.numeroVersao,
      aprovadoEm: canal.aprovadoEm,
      arquivo,
    });
  }

  const imagensManifest: unknown[] = [];
  const entradasImagens: EntradaZip[] = [];
  // A ordem é a do pacote congelado (principal primeiro), não a do banco.
  (itens.imagens ?? []).forEach((img, i) => {
    const dados = bytesPorImagem.get(img.imagemGeradaId);
    if (!dados) {
      // Nunca um ZIP silenciosamente incompleto.
      throw new Error(`Imagem ${img.imagemGeradaId} referenciada pelo pacote não pôde ser lida do Storage.`);
    }
    const arquivo = `imagens/${nomeArquivoImagem(i + 1, img.finalidade, img.mimeType)}`;
    entradasImagens.push({ caminho: `${raiz}/${arquivo}`, dados });
    imagensManifest.push({
      imagemGeradaId: img.imagemGeradaId,
      arquivo,
      finalidade: img.finalidade,
      principal: img.principal,
      ordem: img.ordem,
      mimeType: img.mimeType,
      largura: img.largura,
      altura: img.altura,
    });
  });

  const arquivos = [
    "manifest.json",
    "conteudo.json",
    ...entradasCanais.map(e => e.caminho.slice(raiz.length + 1)),
    ...entradasImagens.map(e => e.caminho.slice(raiz.length + 1)),
  ];

  const manifest: ManifestPacote = {
    schemaVersaoArquivo: SCHEMA_VERSAO_ARQUIVO_PACOTE,
    schemaVersaoPacote: itens.schemaVersao,
    pacote: {
      id: pacote.id,
      numeroPacote: pacote.numeroPacote,
      status: pacote.status,
      hashConteudo: pacote.hashConteudo,
      geradoEm: pacote.criadoEm,
      geradoPor: pacote.geradoPor,
    },
    projeto: { id: itens.projetoId, nomeProduto: itens.nomeProduto },
    canais: canaisManifest,
    imagens: imagensManifest,
    arquivos,
    observacoes: [
      ...(itens.observacoes ?? []),
      "Este arquivo é uma materialização do pacote congelado — a fonte de verdade continua sendo o registro do pacote no sistema.",
      "conteudo.json preserva a estrutura completa; os CSV são a versão achatada para leitura humana.",
    ],
  };

  return [
    { caminho: `${raiz}/manifest.json`, dados: texto(JSON.stringify(manifest, null, 2)) },
    // O JSON técnico é o snapshot congelado, sem transformação alguma.
    { caminho: `${raiz}/conteudo.json`, dados: texto(JSON.stringify(itens, null, 2)) },
    ...entradasCanais,
    ...entradasImagens,
  ];
}

/** Bytes do ZIP + sha256, a partir do pacote congelado. Determinístico. */
export function montarArquivoPacote(
  pacote: PacoteExportacaoUI,
  bytesPorImagem: Map<string, Uint8Array>
): { bytes: Uint8Array; checksum: string } {
  const entradas = montarEntradasZip(pacote, bytesPorImagem);
  // Timestamp congelado do pacote: usar `new Date()` faria o mesmo pacote
  // produzir bytes diferentes a cada materialização.
  const bytes = montarZip(entradas, new Date(pacote.criadoEm));
  return { bytes, checksum: createHash("sha256").update(bytes).digest("hex") };
}

// ────────────────────────────────────────────────────────────────────
// Resolução das imagens — única leitura fora do pacote
// ────────────────────────────────────────────────────────────────────

/**
 * Resolve os bytes das imagens que o pacote referencia POR ID.
 *
 * Duas travas: a consulta filtra pelo `projeto_id` do pacote (uma imagem
 * de outro projeto nunca entra, mesmo que o id fosse forjado no
 * snapshot), e uma imagem referenciada que não exista mais — linha
 * apagada ou objeto sumido — vira ERRO, nunca omissão silenciosa.
 */
export async function resolverImagensDoPacote(
  supabaseServico: SupabaseClient,
  pacote: PacoteExportacaoUI
): Promise<Map<string, Uint8Array>> {
  const itens = pacote.itens as ItensIncluidos;
  const ids = (itens.imagens ?? []).map(i => i.imagemGeradaId);
  const bytes = new Map<string, Uint8Array>();
  if (ids.length === 0) return bytes;

  const { data, error } = await supabaseServico
    .from("estudio_anuncios_imagens_geradas")
    .select("id, storage_path, projeto_id")
    .eq("projeto_id", itens.projetoId)
    .in("id", ids);
  if (error) throw new Error(`Falha ao resolver imagens do pacote: ${error.message}`);

  const caminhos = new Map<string, string>();
  for (const linha of (data ?? []) as { id: string; storage_path: string | null }[]) {
    if (linha.storage_path) caminhos.set(linha.id, linha.storage_path);
  }

  for (const id of ids) {
    const caminho = caminhos.get(id);
    if (!caminho) {
      throw new Error(`Imagem ${id} referenciada pelo pacote não existe mais neste projeto.`);
    }
    bytes.set(id, await baixarImagemGerada(supabaseServico, caminho));
  }
  return bytes;
}

// ────────────────────────────────────────────────────────────────────
// Materialização e download
// ────────────────────────────────────────────────────────────────────

export interface ResultadoMaterializacao {
  pacote: PacoteExportacaoUI;
  /** true quando o arquivo já existia e nada foi enviado ao Storage. */
  reaproveitado: boolean;
  /** true quando o objeto havia sumido e o MESMO ZIP foi reenviado. */
  rematerializado: boolean;
}

/**
 * Materializa o pacote. Idempotente por construção:
 *
 * - já materializado e objeto presente → devolve o existente, sem upload;
 * - já materializado e objeto ausente → **reconstrói o mesmo ZIP** no
 *   mesmo caminho, sem criar pacote novo. Se os bytes reconstruídos não
 *   baterem com o checksum registrado, nada é enviado e o erro é
 *   explícito — um ZIP divergente nunca substitui o original em silêncio;
 * - nunca materializado → monta, envia e registra via RPC.
 *
 * O caminho é determinístico, então duas materializações concorrentes do
 * mesmo pacote disputam o MESMO objeto: a segunda recebe "já existe" do
 * Storage e converge para o mesmo registro, nunca cria um segundo arquivo.
 */
export async function materializarPacote(
  supabaseServico: SupabaseClient,
  params: { pacote: PacoteExportacaoUI; userId: string; projetoId: string }
): Promise<ResultadoMaterializacao> {
  const { pacote, userId, projetoId } = params;

  if (pacote.storagePath) {
    if (await pacoteExportacaoExiste(supabaseServico, pacote.storagePath)) {
      return { pacote, reaproveitado: true, rematerializado: false };
    }
    const imagens = await resolverImagensDoPacote(supabaseServico, pacote);
    const { bytes, checksum } = montarArquivoPacote(pacote, imagens);
    const registrado = pacote.arquivo?.checksumSha256 ?? null;
    if (registrado && registrado !== checksum) throw new ErroChecksumDivergente(pacote.id);
    const envio = await uploadPacoteExportacao(supabaseServico, pacote.storagePath, bytes);
    if (!envio.ok && !envio.jaExiste) {
      throw new Error(`Falha ao reenviar o pacote ao Storage: ${envio.erro}`);
    }
    return { pacote, reaproveitado: false, rematerializado: true };
  }

  const caminho = montarCaminhoPacoteExportacao(userId, projetoId, pacote.id, pacote.numeroPacote ?? 1);
  const imagens = await resolverImagensDoPacote(supabaseServico, pacote);
  const { bytes, checksum } = montarArquivoPacote(pacote, imagens);

  const envio = await uploadPacoteExportacao(supabaseServico, caminho, bytes);
  if (!envio.ok) {
    // "Já existe" só acontece em corrida com outra materialização do
    // mesmo pacote — o caminho é determinístico. Converge.
    const existe = envio.jaExiste && (await pacoteExportacaoExiste(supabaseServico, caminho));
    if (!existe) throw new Error(`Falha ao enviar o pacote ao Storage: ${envio.erro}`);
  }

  const { data, error } = await supabaseServico.rpc("estudio_anuncios_registrar_arquivo_pacote", {
    p_pacote_id: pacote.id,
    p_projeto_id: projetoId,
    p_bucket: BUCKET_PACOTES_EXPORTACAO,
    p_storage_path: caminho,
    p_mime_type: MIME_PACOTE_EXPORTACAO,
    p_tamanho_bytes: bytes.length,
    p_checksum: checksum,
    p_materializado_por: userId,
  });
  if (error) throw new Error(`Falha ao registrar o arquivo do pacote: ${error.message}`);

  return { pacote: paraUI(data as any), reaproveitado: false, rematerializado: false };
}

/**
 * URL assinada curta para download. O `storage_path` nunca sai daqui para
 * o cliente — só a URL temporária.
 */
export async function gerarLinkDownload(
  supabaseServico: SupabaseClient,
  pacote: PacoteExportacaoUI,
  expiresInSegundos = 300
): Promise<{ url: string; expiraEmSegundos: number } | null> {
  if (!pacote.storagePath) return null;
  const url = await gerarUrlAssinadaPacoteExportacao(supabaseServico, pacote.storagePath, expiresInSegundos);
  return url ? { url, expiraEmSegundos: expiresInSegundos } : null;
}

/** Nome sugerido do arquivo baixado — determinístico, sem id aleatório. */
export function nomeDownload(pacote: PacoteExportacaoUI): string {
  return `${nomeDiretorioPacote(pacote.numeroPacote)}.zip`;
}
