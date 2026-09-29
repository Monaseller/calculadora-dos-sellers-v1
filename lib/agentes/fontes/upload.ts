/**
 * Receber uma fonte — AGENT-FACTORY-F5.
 *
 * ── A ordem das validacoes nao e estetica ───────────────────────────
 *
 *   1. metadados        (nome, extensao, tamanho, escopo, vinculo)
 *   2. tamanho REAL     dos bytes, nao o declarado
 *   3. MIME por ASSINATURA de bytes
 *   4. hash
 *   5. banco + storage
 *
 * O tamanho declarado e afirmacao de quem envia; o dos bytes e fato, e
 * os dois sao conferidos porque um pedido pode mentir no primeiro para
 * passar pelo limite. O MIME vem da assinatura e nunca de `file.type`
 * do cliente — a mesma regra que o Estudio ja segue, escrita depois de
 * um bug real.
 *
 * O hash entra ANTES da escrita para que o registro nasca com ele: um
 * total calculado ontem so continua explicavel se der para dizer QUAL
 * arquivo foi lido.
 *
 * ── Quem valida NAO e quem autoriza ─────────────────────────────────
 *
 * Este modulo assume que `userId` ja veio de sessao autenticada e que o
 * agente ja foi conferido como sendo do dono. Ele nao autentica nada, e
 * a FK composta da migration e a rede embaixo dele.
 */
import "server-only";
import { createHash } from "node:crypto";
import { fileTypeFromBuffer } from "file-type";

import type { NovaFonte, PortaDeFontes } from "@/lib/agentes/fontes/repositorio";
import type { EscopoDeFonte, Fonte } from "@/lib/agentes/fontes/tipos";
import {
  MAX_BYTES_DA_FONTE,
  MIME_POR_TIPO,
  conferirMimeReal,
  tipoPelaExtensao,
  validarMetadados,
} from "@/lib/agentes/fontes/tipos";

export interface PedidoDeUpload {
  readonly userId: string;
  readonly escopo: EscopoDeFonte;
  readonly agenteId?: string | null;
  readonly conversaId?: string | null;
  readonly nome: string;
  readonly descricao?: string | null;
  readonly papel?: string | null;
  readonly bytes: Uint8Array;
  /** Id da fonte que esta substitui. Ver secao 5 da migration. */
  readonly substituiId?: string | null;
}

export type ResultadoUpload =
  | { readonly ok: true; readonly fonte: Fonte }
  | { readonly ok: false; readonly codigo: string; readonly mensagem: string };

/** Detecta o MIME real pela assinatura. `null` quando nao ha assinatura. */
export async function detectarMimePorAssinatura(bytes: Uint8Array): Promise<string | null> {
  const t = await fileTypeFromBuffer(bytes);
  return t?.mime ?? null;
}

export function calcularHash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function receberFonte(
  porta: PortaDeFontes,
  pedido: PedidoDeUpload
): Promise<ResultadoUpload> {
  const meta = validarMetadados({
    nome: pedido.nome,
    descricao: pedido.descricao,
    papel: pedido.papel,
    tamanhoBytes: pedido.bytes.length,
    escopo: pedido.escopo,
    agenteId: pedido.agenteId ?? undefined,
    conversaId: pedido.conversaId ?? undefined,
  });
  if (!meta.ok) return { ok: false, codigo: meta.codigo, mensagem: meta.mensagem };

  // Conferido DE NOVO sobre os bytes: `validarMetadados` recebeu o
  // comprimento real, mas repetir aqui deixa a regra visivel no ponto
  // em que os bytes existem, e custa nada.
  if (pedido.bytes.length > MAX_BYTES_DA_FONTE) {
    return { ok: false, codigo: "tamanho_acima_do_limite", mensagem: "Arquivo acima do limite." };
  }

  const tipo = tipoPelaExtensao(pedido.nome);
  if (tipo === null) {
    return { ok: false, codigo: "extensao_nao_suportada", mensagem: "Tipo nao suportado." };
  }

  const mimeReal = await detectarMimePorAssinatura(pedido.bytes);
  const conferencia = conferirMimeReal(tipo, mimeReal);
  if (!conferencia.ok) {
    return { ok: false, codigo: conferencia.codigo, mensagem: conferencia.mensagem };
  }

  const nova: NovaFonte = {
    userId: pedido.userId,
    escopo: pedido.escopo,
    agenteId: pedido.escopo === "agente" ? (pedido.agenteId as string) : null,
    conversaId: pedido.escopo === "conversa" ? (pedido.conversaId as string) : null,
    nome: pedido.nome.trim(),
    descricao: pedido.descricao?.trim() ?? null,
    papel: pedido.papel?.trim() ?? null,
    tipo,
    // O MIME GRAVADO e o canonico do tipo, nao o detectado: a assinatura
    // de um .xlsx e `application/zip`, e guardar isso faria o CHECK do
    // banco recusar e a UI mostrar "zip" para uma planilha.
    mime: MIME_POR_TIPO[tipo],
    bytes: pedido.bytes,
    hashSha256: calcularHash(pedido.bytes),
    substituiId: pedido.substituiId ?? null,
  };

  try {
    return { ok: true, fonte: await porta.criar(nova) };
  } catch (e) {
    return {
      ok: false,
      codigo: "falha_ao_persistir",
      // Mensagem do banco NAO sobe: ela pode citar constraint, coluna e
      // valor. Quem precisa do detalhe le o log do servidor.
      mensagem: "Nao foi possivel guardar a fonte.",
    };
  }
}
