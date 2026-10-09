/**
 * Importacao Shopee em FATIAS, lado da tela (Shopee product import V2).
 *
 * POST /api/shopee/importar-anuncios processa uma fatia e devolve
 * `{ parcial, cursor, loja_id, ... }`. Enquanto `parcial: true`, chamamos de
 * novo com EXATAMENTE o `cursor` e o `loja_id` que o servidor devolveu — a
 * posicao nunca e inferida aqui. Um cursor que nao avanca encerra com erro
 * (nunca laco infinito); erro numa fatia encerra mostrando o erro, e o que ja
 * foi gravado fica no servidor.
 *
 * Puro (sem React, sem fetch direto): quem chama injeta o POST.
 */
import { classificarRespostaImportacao } from "./paginacao";

export const MAX_FATIAS_IMPORTACAO = 500;

export interface ProgressoImportacaoShopee { importados: number; atualizados: number; ignorados: number; itensProcessados: number; total: number; fatias: number }
export type ResultadoImportacaoShopee =
  | { tipo: "escolher_loja"; lojas: { id: string; rotulo: string }[] }
  | { tipo: "erro"; mensagem: string; progresso: ProgressoImportacaoShopee }
  | { tipo: "ok"; progresso: ProgressoImportacaoShopee };

export async function importarShopeeEmFatias(
  postar: (corpo: Record<string, unknown>) => Promise<{ status: number; texto: string }>,
  lojaId: string | undefined,
  aoProgredir: (p: ProgressoImportacaoShopee) => void = () => {},
): Promise<ResultadoImportacaoShopee> {
  const p: ProgressoImportacaoShopee = { importados: 0, atualizados: 0, ignorados: 0, itensProcessados: 0, total: 0, fatias: 0 };
  let corpo: Record<string, unknown> = lojaId ? { loja_id: lojaId } : {};
  const vistos = new Set<string>();
  for (let n = 0; n < MAX_FATIAS_IMPORTACAO; n++) {
    const { status, texto } = await postar(corpo);
    if (status === 409 && n === 0) {
      try {
        const d = JSON.parse(texto);
        if (d?.codigo === "STORE_SELECTION_REQUIRED" && Array.isArray(d.lojas)) {
          const lojas = d.lojas.filter((l: { id?: unknown }) => typeof l?.id === "string")
            .map((l: { id: string; rotulo?: unknown }) => ({ id: l.id, rotulo: String(l.rotulo ?? "Shopee") }));
          if (lojas.length) return { tipo: "escolher_loja", lojas };
        }
      } catch { /* corpo nao-JSON: classificacao padrao abaixo */ }
    }
    const r = classificarRespostaImportacao(status, texto, "Shopee");
    if (r.classe !== "SUCESSO") return { tipo: "erro", mensagem: r.mensagem, progresso: p };
    const d = r.dados;
    p.importados += Number(d.importados ?? 0);
    p.atualizados += Number(d.atualizados ?? 0);
    p.ignorados += Number(d.ignorados ?? 0);
    p.itensProcessados += Number(d.itens_processados ?? 0);
    p.total = Number(d.total ?? p.total);
    p.fatias = n + 1;
    if (d.parcial !== true) return { tipo: "ok", progresso: p };
    if (typeof d.cursor !== "string" || !d.cursor || typeof d.loja_id !== "string" || vistos.has(d.cursor)) {
      return { tipo: "erro", mensagem: "A importação parou de avançar. O que já foi importado foi mantido; tente novamente.", progresso: p };
    }
    vistos.add(d.cursor);
    aoProgredir({ ...p });
    corpo = { loja_id: d.loja_id, cursor: d.cursor };
  }
  return { tipo: "erro", mensagem: "A importação excedeu o número máximo de etapas. O que já foi importado foi mantido.", progresso: p };
}
