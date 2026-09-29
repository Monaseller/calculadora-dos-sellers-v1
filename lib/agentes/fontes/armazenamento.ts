/**
 * Storage das fontes de agente — AGENT-FACTORY-F5.
 *
 * ── Bucket proprio, e nao os do Estudio ─────────────────────────────
 *
 * `lib/estudio-anuncios/storage.ts` ja resolve bem o problema — bucket
 * privado, service_role, MIME por assinatura de bytes, nome seguro — e
 * o PADRAO dele esta sendo seguido aqui linha por linha. O que nao da
 * para reusar e o CODIGO: aquelas funcoes tem
 * `BUCKET_FOTOS_ORIGINAIS` fixo no corpo e aceitam so MIME de imagem.
 * Alargar aquele modulo para caber planilha misturaria dois dominios
 * que nao tem nada a ver um com o outro.
 *
 * ── O caminho NAO e escolhido por ninguem de fora ───────────────────
 *
 * `<user_id>/<escopo>/<vinculo>/<id>/<nome_seguro>` — os quatro
 * primeiros segmentos vem da SESSAO e do banco, nunca do pedido. O nome
 * enviado so aparece no ultimo, ja sanitizado, e mesmo que escapasse a
 * sanitizacao nao conseguiria sair do prefixo do dono.
 *
 * ── O bucket e PRIVADO e o modelo nunca ve credencial ───────────────
 *
 * Nao ha URL publica, nao ha URL assinada nesta camada e nenhum token
 * de storage entra em prompt. Quem le bytes e o resolvedor, no
 * servidor, com a service_role — e o que volta para o modelo e o
 * RESULTADO da Tool, nunca o arquivo nem o endereco dele.
 */
import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

import type { EscopoDeFonte, TipoDeFonte } from "@/lib/agentes/fontes/tipos";
import { MIME_POR_TIPO, nomeSeguroDaFonte } from "@/lib/agentes/fontes/tipos";

/**
 * Bucket PRIVADO das fontes.
 *
 * Criado fora desta migration, como os do Estudio: este modulo nunca
 * cria nem reconfigura bucket — se ele nao existir, o upload falha alto
 * em vez de um `createBucket` silencioso mudar a infraestrutura.
 */
export const BUCKET_FONTES = "agente-fontes";

export function montarCaminhoDaFonte(entrada: {
  readonly userId: string;
  readonly escopo: EscopoDeFonte;
  readonly vinculoId: string;
  readonly fonteId: string;
  readonly nomeOriginal: string;
  readonly tipo: TipoDeFonte;
}): string {
  const nome = nomeSeguroDaFonte(entrada.nomeOriginal, entrada.tipo);
  return `${entrada.userId}/${entrada.escopo}/${entrada.vinculoId}/${entrada.fonteId}/${nome}`;
}

export async function enviarObjetoDaFonte(
  supabaseServico: SupabaseClient,
  caminho: string,
  bytes: Uint8Array,
  tipo: TipoDeFonte
): Promise<void> {
  const { error } = await supabaseServico.storage
    .from(BUCKET_FONTES)
    // `upsert: false`: o caminho carrega o id da fonte, que e novo a
    // cada envio. Colisao aqui significa bug, e sobrescrever esconderia.
    .upload(caminho, bytes, { contentType: MIME_POR_TIPO[tipo], upsert: false });
  if (error) throw new Error(`Falha ao enviar fonte ao Storage: ${error.message}`);
}

export async function baixarObjetoDaFonte(
  supabaseServico: SupabaseClient,
  caminho: string
): Promise<Uint8Array> {
  const { data, error } = await supabaseServico.storage.from(BUCKET_FONTES).download(caminho);
  if (error || !data) {
    throw new Error(`Falha ao baixar fonte: ${error?.message ?? "sem dados"}`);
  }
  return new Uint8Array(await data.arrayBuffer());
}

export async function excluirObjetoDaFonte(
  supabaseServico: SupabaseClient,
  caminho: string
): Promise<{ ok: boolean; erro?: string }> {
  const { error } = await supabaseServico.storage.from(BUCKET_FONTES).remove([caminho]);
  return error ? { ok: false, erro: error.message } : { ok: true };
}
