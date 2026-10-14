/**
 * POST /api/ml/vendas/financeiro — RECUPERAÇÃO financeira do ML ao recarregar Vendas (CDS V2 Vendas A3.2-C/C.2).
 * Fallback do sync (que já coleta o financeiro das vendas novas): a tela chama UMA vez por carga, mandando só o
 * CONTEXTO da janela — nunca a lista de pedidos. Aqui:
 *   - loja do MESMO contrato do GET: `loja_id` explícita validada no servidor (dono + ML + ativa) ou a única;
 *     credencial dessa loja (vencida → nada é feito; o refresh é de outro fluxo);
 *   - o SERVIDOR seleciona no banco as vendas ML PAGAS desta loja/dono na janela (mesma regra de datas do GET)
 *     SEM linha financeira ou com linha pendente elegível — mais recentes primeiro; completo (ACTUAL) fica fora;
 *   - tenta todas até o prazo de execução (concorrência 2 + prazo; sem teto por quantidade) — o que não couber
 *     continua elegível no próximo refresh. Não é backfill geral: só a janela/loja que o dono está vendo;
 *   - só GET no provider; resultado gravado por MERGE monotônico (A3.2-E: só as etapas que faltam, billing por
 *     micro-lote, nada confirmado é rebaixado); resposta = resumo (a tela relê GET /api/ml/vendas).
 * Body: { loja_id?: string, date_from: "AAAA-MM-DD", date_to: "AAAA-MM-DD", date_field?: "pagamento" | "criacao" }
 */
import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { autenticarRequisicao } from "@/lib/autenticacao";
import { getSupabaseServidor } from "@/lib/estudio-anuncios/supabase-servidor";
import { resolverContaML } from "@/lib/ml-conexao";
import { LOJA_ML_INVALIDA, ML_STORE_SELECTION_REQUIRED, respostaSelecaoLojaML } from "@/lib/ml-loja-catalogo";
import { candidatosRecuperacaoFinanceiraML } from "@/lib/vendas/ml-financeiro";
import { coletarFinanceiroML, JANELA_PROVIDER_MS } from "@/lib/vendas/ml-financeiro-coleta";
import { lerFinanceiroRealML } from "@/lib/vendas/ml-financeiro-leitura";

export const maxDuration = 60;

/** Leitura dos candidatos no banco: páginas de 1.000 enquanto houver e por no máximo 10 s (técnico, não de negócio). */
const PAGINA_CANDIDATOS = 1000;
const PRAZO_LEITURA_CANDIDATOS_MS = 10_000;
const DATA = /^\d{4}-\d{2}-\d{2}$/;

let clienteServidor: SupabaseClient | null = null;
function supabase(): SupabaseClient {
  return (clienteServidor ??= getSupabaseServidor());
}

export async function POST(request: Request) {
  const inicio = Date.now();   // prazo do provider conta do início da requisição (função de 60 s)
  const auth = await autenticarRequisicao(request);
  const userId = auth.autenticado ? auth.uid : null;
  if (!userId) return NextResponse.json({ erro: true, mensagem: "Sessão inválida." }, { status: 401 });

  const body = (await request.json().catch(() => ({}))) as { loja_id?: unknown; date_from?: unknown; date_to?: unknown; date_field?: unknown };
  const lojaPedida = typeof body.loja_id === "string" && body.loja_id ? body.loja_id : null;
  const de = typeof body.date_from === "string" && DATA.test(body.date_from) ? body.date_from : null;
  const ate = typeof body.date_to === "string" && DATA.test(body.date_to) ? body.date_to : null;
  const campo: "pagamento" | "criacao" = body.date_field === "criacao" ? "criacao" : "pagamento";
  if (!de || !ate || de > ate) return NextResponse.json({ erro: true, mensagem: "Janela inválida." }, { status: 400 });

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
  const lojaId = contaML.lojaId;

  // vendas ML PAGAS deste dono + loja na janela (mesma regra de datas do GET), mais recentes primeiro
  const vendas: Array<{ order_id: string; status: string | null; data: string | null; data_pagamento: string | null; data_criacao: string | null }> = [];
  const filtroJanela = campo === "pagamento"
    ? `and(data_pagamento.gte.${de},data_pagamento.lte.${ate}),and(data_pagamento.is.null,data_criacao.is.null,data.gte.${de},data.lte.${ate})`
    : `and(data_criacao.gte.${de},data_criacao.lte.${ate}),and(data_criacao.is.null,data.gte.${de},data.lte.${ate})`;
  for (let pagina = 0; Date.now() - inicio < PRAZO_LEITURA_CANDIDATOS_MS; pagina++) {
    const { data, error } = await supabase()
      .from("pedidos")
      .select("order_id, status, data, data_pagamento, data_criacao")
      .eq("user_id", userId).eq("marketplace", "ML").eq("loja_id", lojaId).eq("status", "paid")
      .or(filtroJanela)
      .order("data", { ascending: false }).order("order_id", { ascending: false })
      .range(pagina * PAGINA_CANDIDATOS, (pagina + 1) * PAGINA_CANDIDATOS - 1);
    if (error) { console.error(`[ml-financeiro] ERRO leitura de candidatos loja=${lojaId}: ${error.message}`); break; }
    vendas.push(...((data ?? []) as any[]).map((v) => ({ ...v, order_id: String(v.order_id) })));
    if ((data ?? []).length < PAGINA_CANDIDATOS) break;
  }
  // A3.2-E: estado existente é a base do merge monotônico — leitura falhou → nada é consultado nem gravado
  const existentes = await lerFinanceiroRealML(supabase(), userId, lojaId, [...new Set(vendas.map((v) => v.order_id))], { estrito: true }).catch(() => null);
  if (!existentes) return NextResponse.json({ ok: false, tentados: 0 });
  const alvo = candidatosRecuperacaoFinanceiraML(vendas, existentes, { de, ate, campo });
  if (alvo.length === 0) return NextResponse.json({ ok: true, tentados: 0 });

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
  }, { ate: inicio + JANELA_PROVIDER_MS }).catch((e: any) => {
    console.error(`[ml-financeiro] ERRO retry loja=${lojaId}: ${e?.message ?? e}`);
    return null;
  });
  if (!r) return NextResponse.json({ ok: false, tentados: alvo.length });
  return NextResponse.json({ ok: true, candidatos: alvo.length, tentados: alvo.length - r.adiados, actual: r.actual, pendentes: r.pendentes, integracao: r.integracao, adiados: r.adiados, limitados: r.limitados });
}
