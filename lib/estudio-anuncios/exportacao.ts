/**
 * Exportação do conteúdo APROVADO (2026-08-21).
 *
 * REGRA CENTRAL, sem exceção: a única fonte é a **versão aprovada** de
 * cada canal. Um canal sem versão aprovada entra no pacote marcado como
 * NÃO exportável — jamais há fallback silencioso para a última versão,
 * para a base da IA ou para qualquer outra coisa. Um teste dedicado
 * garante isso; outro garante que este arquivo não lê `versaoAtual`.
 *
 * NÃO PUBLICA E NÃO ENVIA ARQUIVO. Gerar um pacote é congelar dados
 * estruturados no banco. Nenhuma chamada externa, nenhum upload,
 * nenhuma integração de marketplace.
 *
 * NÃO TOCA NA FASE 1 NEM NA CAMADA EDITORIAL. Só lê. Nenhuma função
 * daqui escreve em `resultados_pipeline`, `jobs`, Pipeline, score,
 * imagens ou `conteudo_versoes`.
 *
 * IDENTIDADE POR CONTEÚDO, NÃO POR INSTANTE: `hash_conteudo` resume o
 * CONJUNTO de versões aprovadas + imagens congeladas. Regerar sem
 * mudança reencontra o mesmo pacote; trocar a aprovação gera um novo e
 * preserva o anterior. Ver a migration 20260821 para as garantias de
 * banco (unique por hash, numeração sob lock, INSERT puro).
 */
import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ConteudoEditorial } from "./conteudo-editorial";

export const SCHEMA_VERSAO_PACOTE_EXPORTACAO = 1;

// ────────────────────────────────────────────────────────────────────
// Contrato do pacote
// ────────────────────────────────────────────────────────────────────

/** Um canal exportável: conteúdo aprovado congelado + referência à versão. */
export interface CanalExportado {
  marketplace: string;
  exportavel: true;
  /** Referência exata à versão aprovada usada — auditável sem heurística. */
  versaoAprovadaId: string;
  numeroVersao: number;
  aprovadoEm: string | null;
  aprovadoPor: string | null;
  /** Snapshot POR VALOR: o pacote continua legível mesmo que algo mude depois. */
  conteudo: ConteudoEditorial;
}

/** Um canal sem versão aprovada — declarado, nunca preenchido por fallback. */
export interface CanalNaoExportado {
  marketplace: string;
  exportavel: false;
  motivo: string;
}

export interface ImagemReferenciada {
  imagemGeradaId: string;
  ordem: number | null;
  finalidade: string;
  principal: boolean;
  largura: number | null;
  altura: number | null;
  mimeType: string | null;
}

export interface ItensIncluidos {
  schemaVersao: number;
  projetoId: string;
  nomeProduto: string;
  geradoEm: string;
  canais: (CanalExportado | CanalNaoExportado)[];
  /**
   * Imagens da Fase 1 referenciadas por id — nunca bytes, nunca URL
   * assinada (que expira). NOTA: imagem ainda não tem conceito de
   * "aprovada" no sistema; estas são as imagens geradas do projeto, e o
   * campo `observacoes` do pacote diz isso explicitamente.
   */
  imagens: ImagemReferenciada[];
  observacoes: string[];
}

/**
 * Metadados do ZIP materializado (2026-08-22). `null` enquanto o pacote
 * existe apenas como dado estruturado. `bucket`/`storagePath` são
 * INTERNOS — ver `paraDTOPublico()`.
 */
export interface ArquivoDoPacote {
  bucket: string | null;
  mimeType: string | null;
  tamanhoBytes: number | null;
  checksumSha256: string | null;
  materializadoEm: string | null;
}

export interface PacoteExportacaoUI {
  id: string;
  numeroPacote: number | null;
  status: "gerado" | "parcial";
  hashConteudo: string | null;
  criadoEm: string;
  geradoPor: string | null;
  /** Caminho no Storage — INTERNO. Nunca vai para o cliente HTTP. */
  storagePath: string | null;
  itens: ItensIncluidos;
  arquivo: ArquivoDoPacote | null;
}

/** O que a UI recebe: tudo menos o caminho interno do Storage. */
export type PacoteExportacaoDTO = Omit<PacoteExportacaoUI, "storagePath" | "arquivo"> & {
  materializado: boolean;
  arquivo: Omit<ArquivoDoPacote, "bucket"> | null;
};

/**
 * Remove `storagePath` e `bucket` antes de a resposta HTTP sair. Não é
 * cosmético: expor o caminho do objeto entregaria a estrutura interna do
 * bucket privado, e o download é sempre por URL assinada gerada na hora.
 */
export function paraDTOPublico(p: PacoteExportacaoUI): PacoteExportacaoDTO {
  const { storagePath, arquivo, ...resto } = p;
  return {
    ...resto,
    materializado: storagePath !== null,
    arquivo: arquivo
      ? {
          mimeType: arquivo.mimeType,
          tamanhoBytes: arquivo.tamanhoBytes,
          checksumSha256: arquivo.checksumSha256,
          materializadoEm: arquivo.materializadoEm,
        }
      : null,
  };
}

// ────────────────────────────────────────────────────────────────────
// Hash canônico — funções puras
// ────────────────────────────────────────────────────────────────────

/**
 * Resumo do que o pacote congela. Deliberadamente NÃO inclui `geradoEm`
 * nem qualquer campo variável: o hash identifica o CONTEÚDO APROVADO, e
 * se incluísse o instante, regerar sem mudança sempre criaria pacote
 * novo — quebrando a regra de idempotência.
 *
 * Ordenação explícita (canais por marketplace, imagens por id) porque a
 * ordem de retorno do banco não é garantida: sem isso o mesmo conteúdo
 * poderia produzir hashes diferentes.
 */
export function calcularHashConteudo(itens: ItensIncluidos): string {
  const canonico = {
    schemaVersao: itens.schemaVersao,
    projetoId: itens.projetoId,
    canais: itens.canais
      .map(c =>
        c.exportavel
          ? { marketplace: c.marketplace, exportavel: true, versaoAprovadaId: c.versaoAprovadaId, numeroVersao: c.numeroVersao }
          : { marketplace: c.marketplace, exportavel: false }
      )
      .sort((a, b) => a.marketplace.localeCompare(b.marketplace)),
    imagens: itens.imagens.map(i => i.imagemGeradaId).sort(),
  };
  return createHash("sha256").update(JSON.stringify(canonico)).digest("hex");
}

// ────────────────────────────────────────────────────────────────────
// Montagem — leitura apenas
// ────────────────────────────────────────────────────────────────────
interface LinhaVersaoAprovada {
  id: string;
  projeto_marketplace_id: string;
  numero_versao: number;
  conteudo: unknown;
  aprovado_em: string | null;
  aprovado_por: string | null;
}

/**
 * Monta o snapshot a partir do estado aprovado ATUAL do projeto.
 *
 * A consulta de versões filtra `.eq("aprovado", true)` — é o único
 * caminho de leitura, então não existe código capaz de escolher uma
 * versão não aprovada nem por engano.
 */
export async function montarItensIncluidos(
  supabase: SupabaseClient,
  projetoId: string,
  nomeProduto: string
): Promise<ItensIncluidos> {
  const { data: canaisBrutos, error: erroCanais } = await supabase
    .from("estudio_anuncios_projetos_marketplace")
    .select("id, marketplace")
    .eq("projeto_id", projetoId);
  if (erroCanais) throw new Error(`Falha ao ler canais do projeto: ${erroCanais.message}`);
  const canaisProjeto = (canaisBrutos ?? []) as { id: string; marketplace: string }[];

  const aprovadasPorCanal = new Map<string, LinhaVersaoAprovada>();
  if (canaisProjeto.length > 0) {
    const { data: versoes, error: erroV } = await supabase
      .from("estudio_anuncios_conteudo_versoes")
      .select("id, projeto_marketplace_id, numero_versao, conteudo, aprovado_em, aprovado_por")
      .in("projeto_marketplace_id", canaisProjeto.map(c => c.id))
      .eq("aprovado", true);
    if (erroV) throw new Error(`Falha ao ler versões aprovadas: ${erroV.message}`);
    for (const v of (versoes ?? []) as LinhaVersaoAprovada[]) {
      aprovadasPorCanal.set(v.projeto_marketplace_id, v);
    }
  }

  const { data: imgs, error: erroImg } = await supabase
    .from("estudio_anuncios_imagens_geradas")
    .select("id, prompt_ordem, finalidade, e_principal, largura_px, altura_px, mime_type")
    .eq("projeto_id", projetoId);
  if (erroImg) throw new Error(`Falha ao ler imagens do projeto: ${erroImg.message}`);

  const imagens: ImagemReferenciada[] = ((imgs ?? []) as any[])
    .map(i => ({
      imagemGeradaId: i.id,
      ordem: i.prompt_ordem,
      finalidade: i.finalidade,
      principal: i.e_principal,
      largura: i.largura_px,
      altura: i.altura_px,
      mimeType: i.mime_type,
    }))
    .sort((a, b) => (a.principal === b.principal ? (a.ordem ?? 0) - (b.ordem ?? 0) : a.principal ? -1 : 1));

  const canais: (CanalExportado | CanalNaoExportado)[] = canaisProjeto
    .sort((a, b) => a.marketplace.localeCompare(b.marketplace))
    .map(canal => {
      const aprovada = aprovadasPorCanal.get(canal.id);
      if (!aprovada) {
        // NUNCA cai para a última versão nem para a base da IA.
        return {
          marketplace: canal.marketplace,
          exportavel: false as const,
          motivo: "Nenhuma versão aprovada para este canal.",
        };
      }
      return {
        marketplace: canal.marketplace,
        exportavel: true as const,
        versaoAprovadaId: aprovada.id,
        numeroVersao: aprovada.numero_versao,
        aprovadoEm: aprovada.aprovado_em,
        aprovadoPor: aprovada.aprovado_por,
        conteudo: aprovada.conteudo as ConteudoEditorial,
      };
    });

  const observacoes = [
    "Somente versões aprovadas foram exportadas. Canais sem aprovação aparecem como não exportáveis.",
  ];
  if (imagens.length > 0) {
    observacoes.push(
      "As imagens são os artefatos gerados na Fase 1 — não existe aprovação de imagem no sistema nesta versão."
    );
  }

  return {
    schemaVersao: SCHEMA_VERSAO_PACOTE_EXPORTACAO,
    projetoId,
    nomeProduto,
    geradoEm: new Date().toISOString(),
    canais,
    imagens,
    observacoes,
  };
}

/** `parcial` quando algum canal ficou de fora por não ter aprovação. */
export function statusDoPacote(itens: ItensIncluidos): "gerado" | "parcial" {
  return itens.canais.every(c => c.exportavel) ? "gerado" : "parcial";
}

export function temAlgumCanalExportavel(itens: ItensIncluidos): boolean {
  return itens.canais.some(c => c.exportavel);
}

// ────────────────────────────────────────────────────────────────────
// Persistência — sempre via RPC atômica
// ────────────────────────────────────────────────────────────────────
interface LinhaPacote {
  id: string;
  numero_pacote: number | null;
  status: string;
  hash_conteudo: string | null;
  criado_em: string;
  gerado_por: string | null;
  storage_path: string | null;
  itens_incluidos: unknown;
  bucket?: string | null;
  mime_type?: string | null;
  tamanho_bytes?: number | string | null;
  checksum_sha256?: string | null;
  materializado_em?: string | null;
}

/** Colunas lidas em todo lugar — uma lista só, para não divergirem. */
const COLUNAS_PACOTE =
  "id, numero_pacote, status, hash_conteudo, criado_em, gerado_por, storage_path, itens_incluidos, " +
  "bucket, mime_type, tamanho_bytes, checksum_sha256, materializado_em";

export function paraUI(l: LinhaPacote): PacoteExportacaoUI {
  return {
    id: l.id,
    numeroPacote: l.numero_pacote,
    status: l.status as "gerado" | "parcial",
    hashConteudo: l.hash_conteudo,
    criadoEm: l.criado_em,
    geradoPor: l.gerado_por,
    storagePath: l.storage_path,
    itens: l.itens_incluidos as ItensIncluidos,
    arquivo: l.storage_path
      ? {
          bucket: l.bucket ?? null,
          mimeType: l.mime_type ?? null,
          tamanhoBytes: l.tamanho_bytes == null ? null : Number(l.tamanho_bytes),
          checksumSha256: l.checksum_sha256 ?? null,
          materializadoEm: l.materializado_em ?? null,
        }
      : null,
  };
}

/**
 * Gera (ou reencontra) o pacote. Idempotência, numeração sob
 * concorrência e ausência de UPDATE vivem na RPC — ver a migration.
 */
export async function gerarPacoteExportacao(
  supabaseServico: SupabaseClient,
  params: { projetoId: string; itens: ItensIncluidos; hashConteudo: string; status: string; geradoPor: string }
): Promise<PacoteExportacaoUI> {
  const { data, error } = await supabaseServico.rpc("estudio_anuncios_gerar_pacote_exportacao", {
    p_projeto_id: params.projetoId,
    p_itens_incluidos: params.itens,
    p_hash_conteudo: params.hashConteudo,
    p_status: params.status,
    p_gerado_por: params.geradoPor,
  });
  if (error) throw new Error(`Falha ao gerar pacote de exportação: ${error.message}`);
  return paraUI(data as LinhaPacote);
}

/** Histórico de pacotes do projeto — do mais recente para o mais antigo. */
export async function listarPacotesDoProjeto(
  supabase: SupabaseClient,
  projetoId: string
): Promise<PacoteExportacaoUI[]> {
  const { data, error } = await supabase
    .from("estudio_anuncios_pacotes_exportacao")
    .select(COLUNAS_PACOTE)
    .eq("projeto_id", projetoId);
  if (error) throw new Error(`Falha ao listar pacotes: ${error.message}`);
  return ((data ?? []) as unknown as LinhaPacote[])
    .map(paraUI)
    .sort((a, b) => (b.numeroPacote ?? 0) - (a.numeroPacote ?? 0));
}

/**
 * Um pacote específico do projeto. Sempre filtra por `projeto_id` junto
 * com o id: um pacote de outro projeto simplesmente não é encontrado, e
 * a rota responde 404 — nunca 403, que diria que o pacote existe.
 */
export async function buscarPacoteDoProjeto(
  supabase: SupabaseClient,
  projetoId: string,
  pacoteId: string
): Promise<PacoteExportacaoUI | null> {
  const { data, error } = await supabase
    .from("estudio_anuncios_pacotes_exportacao")
    .select(COLUNAS_PACOTE)
    .eq("projeto_id", projetoId)
    .eq("id", pacoteId)
    .maybeSingle();
  if (error) throw new Error(`Falha ao buscar pacote: ${error.message}`);
  return data ? paraUI(data as unknown as LinhaPacote) : null;
}
