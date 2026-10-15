/**
 * Vendas A3.4 — a loja ML de uma requisição da tela de Vendas, com a MESMA regra do GET /api/ml/vendas (Vendas A5):
 * `?loja_id` validado no servidor (dono + ML); sem `loja_id` SÓ a loja única; 2+ lojas → 409 de seleção; loja
 * inválida → 404. Credencial vencida (PRECISA_RECONECTAR) ainda identifica a loja (o corpus canônico é dela).
 * O token resolvido aqui NUNCA sai desta função.
 */
import "server-only";
import { resolverContaML } from "@/lib/ml-conexao";
import { LOJA_ML_INVALIDA, ML_STORE_SELECTION_REQUIRED, respostaSelecaoLojaML } from "@/lib/ml-loja-catalogo";

export type LojaDaRequisicaoML =
  | { ok: true; lojaId: string; credencialUtilizavel: boolean }
  | { ok: false; status: number; corpo: unknown };

export async function lojaMLDaRequisicao(userId: string, lojaPedida: string | null): Promise<LojaDaRequisicaoML> {
  const conta = lojaPedida ? await resolverContaML(userId, lojaPedida) : await resolverContaML(userId, null, { permitirUnica: true });
  if (conta.ok) return { ok: true, lojaId: conta.lojaId, credencialUtilizavel: true };
  if (conta.motivo === "PRECISA_RECONECTAR") return { ok: true, lojaId: conta.loja.id, credencialUtilizavel: false };
  if (conta.motivo === "LOJA_NAO_DEFINIDA") {
    const { status, corpo } = respostaSelecaoLojaML({ ok: false, motivo: ML_STORE_SELECTION_REQUIRED,
      lojas: conta.lojas.map((l) => ({ id: l.id, rotulo: l.nickname || "Conta do Mercado Livre" })) });
    return { ok: false, status, corpo };
  }
  if (conta.motivo === "LOJA_INVALIDA") {
    const { status, corpo } = respostaSelecaoLojaML({ ok: false, motivo: LOJA_ML_INVALIDA });
    return { ok: false, status, corpo };
  }
  return { ok: false, status: 200, corpo: { erro: true, semConexao: true, mensagem: "Conta do Mercado Livre não conectada." } };
}
