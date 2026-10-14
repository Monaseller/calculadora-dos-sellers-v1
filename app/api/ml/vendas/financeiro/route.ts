/**
 * POST /api/ml/vendas/financeiro — nova tentativa do financeiro REAL do ML ao recarregar Vendas (CDS V2
 * Vendas A3.2-C). Fallback do sync (que já coleta o financeiro): a tela chama UMA vez por carga, com os
 * pedidos que o GET marcou como pendentes. Aqui:
 *   - loja do MESMO contrato do GET: `loja_id` explícita validada no servidor (dono + ML + ativa) ou a única;
 *     credencial dessa loja (vencida → nada é feito; o refresh é de outro fluxo);
 *   - só ORDER ids; o servidor revalida no banco (dono + loja) e tenta SÓ os pendentes elegíveis — pedido
 *     completo (ACTUAL) não é consultado; no máximo LIMITE_RETRY_FINANCEIRO_ML por chamada;
 *   - só GET no provider; resultado gravado; resposta = resumo (a tela relê GET /api/ml/vendas).
 * Body: { loja_id?: string, order_ids: string[] }
 */
import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { autenticarRequisicao } from "@/lib/autenticacao";
import { getSupabaseServidor } from "@/lib/estudio-anuncios/supabase-servidor";
import { resolverContaML } from "@/lib/ml-conexao";
import { LOJA_ML_INVALIDA, ML_STORE_SELECTION_REQUIRED, respostaSelecaoLojaML } from "@/lib/ml-loja-catalogo";
import { LIMITE_RETRY_FINANCEIRO_ML, pedidosComFinanceiroPendente } from "@/lib/vendas/ml-financeiro";
import { coletarFinanceiroML, ORCAMENTO_RETRY } from "@/lib/vendas/ml-financeiro-coleta";
import { lerFinanceiroRealML } from "@/lib/vendas/ml-financeiro-leitura";

export const maxDuration = 60;

let clienteServidor: SupabaseClient | null = null;
function supabase(): SupabaseClient {
  return (clienteServidor ??= getSupabaseServidor());
}

export async function POST(request: Request) {
  const auth = await autenticarRequisicao(request);
  const userId = auth.autenticado ? auth.uid : null;
  if (!userId) return NextResponse.json({ erro: true, mensagem: "Sessão inválida." }, { status: 401 });

  const body = (await request.json().catch(() => ({}))) as { loja_id?: unknown; order_ids?: unknown };
  const lojaPedida = typeof body.loja_id === "string" && body.loja_id ? body.loja_id : null;
  const pedidos = Array.isArray(body.order_ids) ? body.order_ids.filter((x): x is string => typeof x === "string" && /^\d{6,20}$/.test(x)) : [];
  if (pedidos.length === 0) return NextResponse.json({ ok: true, tentados: 0 });

  const contaML = lojaPedida
    ? await resolverContaML(userId, lojaPedida)
    : await resolverContaML(userId, null, { permitirUnica: true });
  if (!contaML.ok && contaML.motivo === "LOJA_NAO_DEFINIDA") {
    const { status, corpo } = respostaSelecaoLojaML({ ok: false, motivo: ML_STORE_SELECTION_REQUIRED,
      lojas: contaML.lojas.map((l) => ({ id: l.id, rotulo: l.nickname || "Conta do Mercado Livre" })) });
    return NextResponse.json(corpo, { status });
  }
  if (!contaML.ok && contaML.motivo === "LOJA_INVALIDA") {
    const { status, corpo } = respostaSelecaoLojaML({ ok: false, motivo: LOJA_ML_INVALIDA });
    return NextResponse.json(corpo, { status });
  }
  if (!contaML.ok) return NextResponse.json({ ok: false, tentados: 0, motivo: contaML.motivo });

  // revalida no banco: só pedidos DESTE dono + loja, só os pendentes elegíveis, até o limite
  const existentes = await lerFinanceiroRealML(supabase(), userId, contaML.lojaId, pedidos.slice(0, LIMITE_RETRY_FINANCEIRO_ML * 2));
  const alvo = pedidosComFinanceiroPendente(pedidos, existentes, LIMITE_RETRY_FINANCEIRO_ML);
  if (alvo.length === 0) return NextResponse.json({ ok: true, tentados: 0 });

  const lojaId = contaML.lojaId;
  const r = await coletarFinanceiroML({ userId, lojaId, accessToken: contaML.accessToken }, alvo, {
    fetch: (...a) => fetch(...a),
    esperar: (ms) => new Promise((ok) => setTimeout(ok, ms)),
    gravarEnvios: async (linhas) => {
      const { error } = await supabase().from("ml_financeiro_envios").upsert(linhas, { onConflict: "loja_id,shipment_id" });
      if (error) throw new Error(`gravação de ml_financeiro_envios falhou: ${error.message}`);
    },
    gravarPedidos: async (linhas) => {
      const { error } = await supabase().from("ml_financeiro_pedidos").upsert(linhas, { onConflict: "loja_id,order_id" });
      if (error) throw new Error(`gravação de ml_financeiro_pedidos falhou: ${error.message}`);
    },
    lerExistentes: async () => existentes,
  }, ORCAMENTO_RETRY).catch((e: any) => {
    console.error(`[ml-financeiro] ERRO retry loja=${lojaId}: ${e?.message ?? e}`);
    return null;
  });
  if (!r) return NextResponse.json({ ok: false, tentados: alvo.length });
  return NextResponse.json({ ok: true, tentados: alvo.length, actual: r.actual, pendentes: r.pendentes, integracao: r.integracao });
}
