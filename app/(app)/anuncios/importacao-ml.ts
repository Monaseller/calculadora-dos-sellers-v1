/**
 * Importação Mercado Livre em FATIAS, lado da tela (CDS V2 Fase 2D — ML import V2; Fase 2F — multi-ML).
 *
 * POST /api/ml/importar-anuncios processa uma fatia da loja ML resolvida no servidor e devolve
 * `{ parcial, cursor, loja_id, ... }`. Enquanto `parcial: true`, chamamos de novo com EXATAMENTE o
 * `loja_id` e o `cursor` que o servidor devolveu — a posição e a loja nunca são inferidas aqui, e o
 * cursor carrega a loja (o servidor recusa cursor de outra loja). Um cursor que não avança encerra com
 * erro (nunca laço infinito); erro numa fatia encerra mostrando o erro, e o que já foi gravado fica no
 * servidor.
 *
 * Multi-ML (Fase 2F): a ação leva o `loja_id` escolhido. Sem escolha e com 2+ contas ML, o servidor
 * responde 409 ML_STORE_SELECTION_REQUIRED com as contas do dono → `escolher_loja` (a tela pergunta).
 *
 * Puro (sem React, sem fetch direto): quem chama injeta o POST e a CLASSIFICAÇÃO de cada fatia (a tela
 * classifica a resposta do ML — corpo cru, timeout nosso ≠ erro do marketplace).
 */
import type { classificarRespostaImportacao } from "./paginacao";

export const MAX_FATIAS_IMPORTACAO_ML = 500;

export interface ProgressoImportacaoML { importados: number; atualizados: number; ignorados: number; itensProcessados: number; total: number; fatias: number }
export type LojaParaEscolherML = { id: string; rotulo: string };
export type ResultadoImportacaoML =
  | { tipo: "escolher_loja"; lojas: LojaParaEscolherML[] }
  | { tipo: "erro"; mensagem: string; progresso: ProgressoImportacaoML }
  | { tipo: "ok"; progresso: ProgressoImportacaoML };

/** 409 ML_STORE_SELECTION_REQUIRED → contas do dono para escolher; qualquer outra resposta → null. */
export function lojasParaEscolherML(status: number, texto: string): LojaParaEscolherML[] | null {
  if (status !== 409) return null;
  try {
    const d = JSON.parse(texto);
    if (d?.codigo !== "ML_STORE_SELECTION_REQUIRED" || !Array.isArray(d.lojas)) return null;
    const lojas = d.lojas.filter((l: { id?: unknown }) => typeof l?.id === "string" && l.id)
      .map((l: { id: string; rotulo?: unknown }) => ({ id: l.id, rotulo: String(l.rotulo || "Conta do Mercado Livre") }));
    return lojas.length ? lojas : null;
  } catch { return null; }
}

export async function importarMLEmFatias(
  postar: (corpo: Record<string, unknown>) => Promise<{ status: number; texto: string }>,
  classificar: (status: number, texto: string) => ReturnType<typeof classificarRespostaImportacao>,
  aoProgredir: (p: ProgressoImportacaoML) => void = () => {},
  lojaId?: string,
): Promise<ResultadoImportacaoML> {
  const p: ProgressoImportacaoML = { importados: 0, atualizados: 0, ignorados: 0, itensProcessados: 0, total: 0, fatias: 0 };
  let corpo: Record<string, unknown> = lojaId ? { loja_id: lojaId } : {};
  let loja: string | null = lojaId ?? null;
  const vistos = new Set<string>();
  for (let n = 0; n < MAX_FATIAS_IMPORTACAO_ML; n++) {
    const { status, texto } = await postar(corpo);
    if (n === 0) {
      const lojas = lojasParaEscolherML(status, texto);
      if (lojas) return { tipo: "escolher_loja", lojas };
    }
    const r = classificar(status, texto);
    if (r.classe !== "SUCESSO") return { tipo: "erro", mensagem: r.mensagem, progresso: p };
    const d = r.dados;
    p.importados += Number(d.importados ?? 0);
    p.atualizados += Number(d.atualizados ?? 0);
    p.ignorados += Number(d.ignorados ?? 0);
    p.itensProcessados += Number(d.itens_processados ?? 0);
    p.total = Number(d.total ?? p.total);
    p.fatias = n + 1;
    if (d.parcial !== true) return { tipo: "ok", progresso: p };
    // a loja não pode mudar no meio da importação (o servidor resolveu outra loja → para)
    if (typeof d.loja_id !== "string" || (loja !== null && d.loja_id !== loja)) {
      return { tipo: "erro", mensagem: "A loja do Mercado Livre mudou durante a importação. O que já foi importado foi mantido; tente novamente.", progresso: p };
    }
    loja = d.loja_id;
    if (typeof d.cursor !== "string" || !d.cursor || vistos.has(d.cursor)) {
      return { tipo: "erro", mensagem: "A importação parou de avançar. O que já foi importado foi mantido; tente novamente.", progresso: p };
    }
    vistos.add(d.cursor);
    aoProgredir({ ...p });
    corpo = { loja_id: d.loja_id, cursor: d.cursor };
  }
  return { tipo: "erro", mensagem: "A importação excedeu o número máximo de etapas. O que já foi importado foi mantido.", progresso: p };
}
