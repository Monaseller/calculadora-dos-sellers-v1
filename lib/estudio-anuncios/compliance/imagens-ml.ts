/**
 * IMAGENS para o Mercado Livre — seleção determinística, identidade
 * estável e URL de transporte efêmera (2026-08-29).
 *
 * ── O ponto central, e é ele que organiza o arquivo inteiro ──────────
 * Uma imagem tem DUAS representações, e confundi-las é o erro que este
 * módulo existe para impedir:
 *
 *   IDENTIDADE (estável, entra no hash, é persistida):
 *     { imagemGeradaId, checksum, ordem, principal }
 *
 *   TRANSPORTE (efêmero, NUNCA persistido, NUNCA hasheado):
 *     { source: "<URL assinada recém-gerada>" }
 *
 * A URL assinada carrega um token e uma expiração: incluí-la no hash
 * faria a validação oficial nascer desatualizada a cada execução, porque
 * duas URLs diferentes do MESMO objeto produziriam hashes diferentes.
 * Isso não afrouxa a garantia de "validar A e publicar A" — o que define
 * A é o `checksum` dos bytes, e o checksum é conferido nos dois momentos.
 * A URL é só a credencial de download daquele instante.
 *
 * ── O que NUNCA acontece aqui ───────────────────────────────────────
 * Bucket nunca vira público. `storage_path` nunca sai desta camada nem
 * chega ao Mercado Livre. Nenhuma imagem é regenerada, copiada para
 * bucket público ou lida de outro projeto — a consulta é sempre filtrada
 * por `projeto_id`. Nenhum `picture id` é inventado.
 */
import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { baixarImagemGerada, gerarUrlAssinadaImagemGerada } from "../storage";
import {
  MIMES_IMAGEM_ML,
  RESOLUCAO_MINIMA_IMAGEM_ML,
  TAMANHO_MAXIMO_IMAGEM_ML_BYTES,
} from "./regras-mercado-livre";
import type { ImagemCompliance } from "./tipos";

/**
 * TTL da URL de transporte.
 *
 * Não é número escolhido no olho: o Mercado Livre baixa a imagem
 * DURANTE a requisição, e a documentação oficial ([B], seção "HTTP
 * response code references") lista `Connect timed out`, `Slow_domain` e
 * `Slow_domain_to_many_posts` entre os erros possíveis — ou seja, o
 * download pode demorar e pode ser repetido do lado deles. 300 s cobre
 * uma requisição lenta com folga larga e continua sendo uma janela
 * curta: depois disso a URL morre sozinha e o objeto volta a ser
 * inalcançável sem service role.
 *
 * Permanente está fora de questão — seria transformar um bucket privado
 * em público por outro nome.
 */
export const TTL_URL_TRANSPORTE_ML_SEGUNDOS = 300;

/** Identidade ESTÁVEL de uma imagem. É isto que é hasheado e persistido. */
export interface ImagemCanonicaML {
  imagemGeradaId: string;
  /** sha256 dos bytes reais do objeto. Muda se a imagem mudar. */
  checksum: string | null;
  ordem: number | null;
  principal: boolean;
}

export interface SelecaoImagensML {
  /** Na ordem exata em que vão ao Mercado Livre. */
  selecionadas: ImagemCanonicaML[];
  /** Válidas que ficaram de fora só por causa do limite da categoria. */
  excedentes: ImagemCanonicaML[];
  /** Reprovadas nos requisitos técnicos, com o motivo. */
  invalidas: { imagemGeradaId: string; motivo: string }[];
}

function canonica(i: ImagemCompliance): ImagemCanonicaML {
  return {
    imagemGeradaId: i.imagemGeradaId,
    checksum: i.checksum ?? null,
    ordem: i.ordem,
    principal: i.principal,
  };
}

/**
 * Motivo técnico que impede ENVIAR a imagem, ou `null` se ela serve.
 *
 * Só entram aqui os critérios que o Mercado Livre trata como erro. Estar
 * acima de 1920 px não entra: a fonte [B] diz que o ML **redimensiona**
 * nesse caso, então a imagem é enviável — vira alerta em outro lugar,
 * nunca exclusão silenciosa.
 */
function motivoInvalidez(i: ImagemCompliance): string | null {
  if (!i.temArquivo) return "sem arquivo no Storage";
  if (!i.mimeType || !(MIMES_IMAGEM_ML as readonly string[]).includes(i.mimeType)) {
    return `formato ${i.mimeType ?? "desconhecido"} fora de JPG/JPEG/PNG`;
  }
  if ((i.tamanhoBytes ?? 0) > TAMANHO_MAXIMO_IMAGEM_ML_BYTES) return "acima de 10 MB";
  if (i.largura != null && i.altura != null
      && (i.largura < RESOLUCAO_MINIMA_IMAGEM_ML || i.altura < RESOLUCAO_MINIMA_IMAGEM_ML)) {
    return `abaixo de ${RESOLUCAO_MINIMA_IMAGEM_ML}x${RESOLUCAO_MINIMA_IMAGEM_ML} px`;
  }
  return null;
}

/**
 * Escolhe QUAIS imagens vão, e em que ordem.
 *
 * Determinístico do começo ao fim: principal primeiro, depois `ordem`
 * ascendente, e o `imagemGeradaId` como último critério de desempate —
 * sem ele, duas imagens com a mesma ordem poderiam trocar de lugar entre
 * duas execuções e mudar o hash sem nada ter mudado.
 *
 * Quando há mais imagens do que a categoria aceita, o corte é pelo fim
 * dessa mesma ordem. **Nunca aleatório, nunca "as primeiras que
 * vieram do banco".**
 *
 * `maxPicturesPerItem` vem da categoria (`settings`), nunca de um número
 * fixo. `null` = limite desconhecido → não corta, e quem avisa que a
 * quantidade não foi verificada é a camada de regras.
 */
export function selecionarImagensML(
  imagens: ImagemCompliance[],
  maxPicturesPerItem: number | null
): SelecaoImagensML {
  const invalidas: { imagemGeradaId: string; motivo: string }[] = [];
  const validas: ImagemCompliance[] = [];
  for (const i of imagens) {
    const motivo = motivoInvalidez(i);
    if (motivo) invalidas.push({ imagemGeradaId: i.imagemGeradaId, motivo });
    else validas.push(i);
  }

  const ordenadas = [...validas].sort((a, b) => {
    if (a.principal !== b.principal) return a.principal ? -1 : 1;
    const oa = a.ordem ?? Number.MAX_SAFE_INTEGER;
    const ob = b.ordem ?? Number.MAX_SAFE_INTEGER;
    if (oa !== ob) return oa - ob;
    return a.imagemGeradaId.localeCompare(b.imagemGeradaId);
  });

  const limite = maxPicturesPerItem != null && maxPicturesPerItem > 0
    ? maxPicturesPerItem
    : ordenadas.length;

  return {
    selecionadas: ordenadas.slice(0, limite).map(canonica),
    excedentes: ordenadas.slice(limite).map(canonica),
    invalidas,
  };
}

/**
 * Bytes + checksum de uma imagem gerada, lidos com service role.
 *
 * Ler o objeto direto é de propósito: nenhuma URL (pública ou assinada)
 * é criada para calcular checksum. O `projetoId` entra na consulta para
 * que seja impossível, por construção, ler imagem de outro projeto.
 */
export async function lerImagemGeradaDoProjeto(
  supabaseServico: SupabaseClient,
  projetoId: string,
  imagemGeradaId: string
): Promise<{ bytes: Uint8Array; checksum: string; caminho: string } | null> {
  const { data, error } = await supabaseServico
    .from("estudio_anuncios_imagens_geradas")
    .select("id, storage_path")
    .eq("id", imagemGeradaId)
    .eq("projeto_id", projetoId)
    .maybeSingle();
  if (error) throw new Error(`Falha ao ler imagem do projeto: ${error.message}`);
  const caminho = (data as any)?.storage_path as string | undefined;
  if (!caminho) return null;

  const bytes = await baixarImagemGerada(supabaseServico, caminho);
  return { bytes, checksum: createHash("sha256").update(bytes).digest("hex"), caminho };
}

/**
 * Checksums de todas as imagens de um projeto, para compor a identidade
 * estável. Falha de leitura vira `null` — a imagem continua listada,
 * porque some-la esconderia um problema em vez de mostrá-lo.
 */
export async function calcularChecksumsDoProjeto(
  supabaseServico: SupabaseClient,
  projetoId: string,
  imagemGeradaIds: string[]
): Promise<Map<string, string | null>> {
  const mapa = new Map<string, string | null>();
  for (const id of imagemGeradaIds) {
    try {
      const lida = await lerImagemGeradaDoProjeto(supabaseServico, projetoId, id);
      mapa.set(id, lida?.checksum ?? null);
    } catch {
      mapa.set(id, null);
    }
  }
  return mapa;
}

export interface UrlTransporteML {
  imagemGeradaId: string;
  /** Efêmera. NUNCA persistir, NUNCA logar, NUNCA hashear. */
  url: string;
  /** Confirmação de que a URL aponta para os bytes esperados. */
  checksumConferido: boolean;
}

/**
 * Gera as URLs de transporte imediatamente antes da chamada externa e
 * confere, para cada uma, que os bytes baixados batem com o checksum da
 * identidade canônica.
 *
 * Essa conferência é o que sustenta a separação identidade/transporte:
 * sem ela, "a URL aponta para a imagem que foi validada" seria só uma
 * suposição. O download é feito pelo servidor, com service role — não é
 * a URL assinada que está sendo testada como atalho, é o objeto.
 *
 * A URL nunca é devolvida em log nem em erro: só o resultado da
 * conferência.
 */
export async function gerarUrlsTransporteML(
  supabaseServico: SupabaseClient,
  projetoId: string,
  canonicas: ImagemCanonicaML[],
  ttlSegundos = TTL_URL_TRANSPORTE_ML_SEGUNDOS
): Promise<{ urls: UrlTransporteML[]; falhas: { imagemGeradaId: string; motivo: string }[] }> {
  const urls: UrlTransporteML[] = [];
  const falhas: { imagemGeradaId: string; motivo: string }[] = [];

  for (const c of canonicas) {
    const lida = await lerImagemGeradaDoProjeto(supabaseServico, projetoId, c.imagemGeradaId);
    if (!lida) {
      falhas.push({ imagemGeradaId: c.imagemGeradaId, motivo: "objeto não encontrado no Storage" });
      continue;
    }
    // Bytes diferentes do que o parecer validou = outra imagem. Recusa,
    // em vez de publicar algo que ninguém aprovou.
    if (c.checksum != null && lida.checksum !== c.checksum) {
      falhas.push({ imagemGeradaId: c.imagemGeradaId, motivo: "o conteúdo da imagem mudou desde a validação" });
      continue;
    }
    const url = await gerarUrlAssinadaImagemGerada(supabaseServico, lida.caminho, ttlSegundos);
    if (!url) {
      falhas.push({ imagemGeradaId: c.imagemGeradaId, motivo: "não foi possível gerar a URL temporária" });
      continue;
    }
    urls.push({ imagemGeradaId: c.imagemGeradaId, url, checksumConferido: c.checksum != null });
  }
  return { urls, falhas };
}
