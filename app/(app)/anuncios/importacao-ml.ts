/**
 * Importação Mercado Livre em FATIAS, lado da tela (CDS V2 Fase 2D — ML import V2).
 *
 * POST /api/ml/importar-anuncios processa uma fatia da loja ML resolvida no servidor e devolve
 * `{ parcial, cursor, loja_id, ... }`. Enquanto `parcial: true`, chamamos de novo com EXATAMENTE o
 * `cursor` que o servidor devolveu — a posição nunca é inferida aqui, e o cursor carrega a loja
 * (o servidor recusa cursor de outra loja). Um cursor que não avança encerra com erro (nunca laço
 * infinito); erro numa fatia encerra mostrando o erro, e o que já foi gravado fica no servidor.
 *
 * Puro (sem React, sem fetch direto): quem chama injeta o POST e a CLASSIFICAÇÃO de cada fatia (a tela
 * classifica a resposta do ML — corpo cru, timeout nosso ≠ erro do marketplace).
 */
import type { classificarRespostaImportacao } from "./paginacao";

export const MAX_FATIAS_IMPORTACAO_ML = 500;

export interface ProgressoImportacaoML { importados: number; atualizados: number; ignorados: number; itensProcessados: number; total: number; fatias: number }
export type ResultadoImportacaoML =
  | { tipo: "erro"; mensagem: string; progresso: ProgressoImportacaoML }
  | { tipo: "ok"; progresso: ProgressoImportacaoML };

export async function importarMLEmFatias(
  postar: (corpo: Record<string, unknown>) => Promise<{ status: number; texto: string }>,
  classificar: (status: number, texto: string) => ReturnType<typeof classificarRespostaImportacao>,
  aoProgredir: (p: ProgressoImportacaoML) => void = () => {},
): Promise<ResultadoImportacaoML> {
  const p: ProgressoImportacaoML = { importados: 0, atualizados: 0, ignorados: 0, itensProcessados: 0, total: 0, fatias: 0 };
  let corpo: Record<string, unknown> = {};
  let loja: string | null = null;
  const vistos = new Set<string>();
  for (let n = 0; n < MAX_FATIAS_IMPORTACAO_ML; n++) {
    const { status, texto } = await postar(corpo);
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
    corpo = { cursor: d.cursor };
  }
  return { tipo: "erro", mensagem: "A importação excedeu o número máximo de etapas. O que já foi importado foi mantido.", progresso: p };
}
