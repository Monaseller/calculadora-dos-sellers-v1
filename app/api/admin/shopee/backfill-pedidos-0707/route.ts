/**
 * GET /api/admin/shopee/backfill-pedidos-0707
 *
 * Backfill PONTUAL dos 189 pedidos Shopee confirmados ausentes da tabela
 * `pedidos` para 07/07/2026 (~20:43–23:17 BRT) — ver docs/BUGS.md,
 * docs/DECISIONS.md. Investigação da causa raiz do evento original está
 * ENCERRADA (2026-07-14): confirmado que o filtro `filtrarCompleted` não
 * explica a maioria dos casos, e a causa exata não pôde ser fechada por
 * falta de logs históricos do cron. Esta rota NÃO depende de saber a causa —
 * só busca, na Shopee, os `order_sn` conhecidos como ausentes, e grava
 * usando exatamente a mesma lógica oficial do sync (`montarLinhasDoPedido`).
 *
 * Escopo estritamente limitado: só consulta na Shopee (`get_order_detail`)
 * os `order_sn` da lista-alvo — nunca roda `get_order_list`, então é
 * estruturalmente impossível esta rota tocar em qualquer pedido fora da
 * lista. Pedidos da lista que já existem em `pedidos` são identificados e
 * IGNORADOS (nunca re-buscados na Shopee, nunca gravados de novo) — só os
 * genuinamente ausentes são processados.
 *
 * dry_run (default true, mesma convenção de reconciliar-financeiro): não
 * grava nada, só relata o que seria feito — pedidos recuperáveis, ignorados
 * (já existentes), não encontrados na Shopee, linhas geradas, faturamento.
 * dry_run=0: grava de verdade (upsert onConflict:"id", mesmo padrão do sync).
 *
 * order_ids (opcional, query string, separado por vírgula): lista customizada
 * de order_sn. Sem parâmetro, usa DEFAULT_ORDER_IDS_0707 (os 189 confirmados
 * — ver lib/backfill-0707-order-ids.ts).
 *
 * Gated só por sessão (getUserId), mesmo padrão dos outros endpoints admin.
 * Não aparece em nenhum menu.
 *
 * NÃO altera: cron (/api/sync), paginação de shopee/vendas ou ml/vendas,
 * filtros de leitura, arquitetura de datas, ou qualquer regra de negócio.
 */
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getUserId } from "@/lib/session";
import { getShopeeLojaAtiva } from "@/lib/shopee-auth";
import { shopeeGet } from "@/lib/shopee-api";
import {
  DETAIL_FIELDS,
  DETAIL_BATCH,
  DETAIL_CONCURRENCY,
  withRetry,
  montarLinhasDoPedido,
  carregarMapaAnuncios,
} from "@/lib/sync-shopee";
import { DEFAULT_ORDER_IDS_0707 } from "@/lib/backfill-0707-order-ids";

export const maxDuration = 60;

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

// Janela usada só para o filtro de data dentro de `montarLinhasDoPedido`
// (dataBrt precisa cair neste intervalo pra linha não ser descartada). Os 189
// têm create_time/pay_time confirmados em 07/07 — a margem de 1 dia de cada
// lado é só segurança contra arredondamento de fuso, não afeta o escopo (o
// escopo real é a lista de order_sn, buscada via get_order_detail).
const DATE_FROM = "2026-07-06";
const DATE_TO   = "2026-07-08";

export async function GET(request: Request) {
  const inicioMs = Date.now();

  const userId = getUserId(request);
  if (!userId) {
    return NextResponse.json({ ok: false, erro: "Sessão inválida." }, { status: 401 });
  }

  const loja = await getShopeeLojaAtiva(userId);
  if (!loja) {
    return NextResponse.json({ ok: false, erro: "Shopee não conectada ou token inválido." }, { status: 400 });
  }

  const url = new URL(request.url);
  const orderIdsParam = (url.searchParams.get("order_ids") ?? "")
    .split(",").map(s => s.trim()).filter(Boolean);
  const targetOrderIds = orderIdsParam.length > 0 ? orderIdsParam : DEFAULT_ORDER_IDS_0707;
  const dryRun = url.searchParams.get("dry_run") !== "0";

  // ── 1) Separar já-existentes de novos ───────────────────────────────────
  // Pedidos já existentes NUNCA são buscados na Shopee nem gravados de novo
  // por esta rota — ficam só reportados, para o relatório e como trava extra
  // de segurança (mesma checagem que já tinha sido rodada manualmente antes,
  // repetida aqui como parte do fluxo em vez de depender de memória).
  const { data: existentesRows, error: existentesErr } = await supabase
    .from("pedidos")
    .select("order_id")
    .eq("user_id", userId)
    .eq("marketplace", "Shopee")
    .in("order_id", targetOrderIds);

  if (existentesErr) {
    return NextResponse.json({ ok: false, erro: "Erro ao checar pedidos existentes: " + existentesErr.message }, { status: 500 });
  }

  const existentesSet = new Set((existentesRows ?? []).map(r => r.order_id));
  const jaExistentes  = targetOrderIds.filter(id => existentesSet.has(id));
  const novos         = targetOrderIds.filter(id => !existentesSet.has(id));

  if (novos.length === 0) {
    return NextResponse.json({
      ok: true,
      tempo_execucao_ms: Date.now() - inicioMs,
      dry_run: dryRun,
      solicitados: targetOrderIds.length,
      ja_existentes: jaExistentes.length,
      ja_existentes_ids: jaExistentes,
      novos: 0,
      aviso: "Todos os order_ids solicitados já existem em `pedidos` — nada a recuperar.",
    });
  }

  // ── 2) get_order_detail só para os novos (nunca get_order_list) ─────────
  const mapaAnuncios = await carregarMapaAnuncios(userId);

  const batches: string[][] = [];
  for (let i = 0; i < novos.length; i += DETAIL_BATCH) {
    batches.push(novos.slice(i, i + DETAIL_BATCH));
  }

  const detalhesPorOrderSn = new Map<string, any>();
  for (let i = 0; i < batches.length; i += DETAIL_CONCURRENCY) {
    const grupo = batches.slice(i, i + DETAIL_CONCURRENCY);
    const results = await Promise.all(
      grupo.map(batch =>
        withRetry(() =>
          shopeeGet("/api/v2/order/get_order_detail", loja.partnerId, loja.partnerKey, loja.accessToken, loja.shopId, {
            order_sn_list:            batch.join(","),
            response_optional_fields: DETAIL_FIELDS,
          })
        )
      )
    );
    for (const r of results) {
      for (const o of (r?.response?.order_list ?? [])) {
        detalhesPorOrderSn.set(o.order_sn, o);
      }
    }
  }

  const naoEncontradosNaShopee = novos.filter(id => !detalhesPorOrderSn.has(id));

  // ── 3) Montar linhas (mesma função oficial do sync) ─────────────────────
  const todasAsLinhas: any[] = [];
  const rejeitadosForaDoPeriodo: string[] = [];

  for (const orderSn of novos) {
    const order = detalhesPorOrderSn.get(orderSn);
    if (!order) continue; // já contado em naoEncontradosNaShopee

    const linhas = montarLinhasDoPedido(order, {
      userId,
      lojaId:   loja.lojaId,
      nickname: loja.nickname,
      noBuffer: false, // mesmo modo do cron (update_time) — pedidos já sabidamente pagos
      dateFrom: DATE_FROM,
      dateTo:   DATE_TO,
      mapaAnuncios,
    });

    if (linhas.length === 0) {
      rejeitadosForaDoPeriodo.push(orderSn);
      continue;
    }
    todasAsLinhas.push(...linhas);
  }

  // ── 4) Relatório (faturamento por pedido, distintos, etc.) ──────────────
  const faturamentoPorPedido = new Map<string, number>();
  for (const linha of todasAsLinhas) {
    const atual = faturamentoPorPedido.get(linha.order_id) ?? 0;
    faturamentoPorPedido.set(linha.order_id, atual + Number(linha.item_subtotal || 0));
  }
  const faturamentoTotal = Array.from(faturamentoPorPedido.values()).reduce((a, b) => a + b, 0);
  const pedidosDistintosRecuperados = faturamentoPorPedido.size;

  const respostaBase = {
    ok: true,
    tempo_execucao_ms: Date.now() - inicioMs,
    dry_run: dryRun,
    conta: loja.nickname,
    solicitados: targetOrderIds.length,
    ja_existentes: jaExistentes.length,
    ja_existentes_ids: jaExistentes,
    novos: novos.length,
    nao_encontrados_na_shopee: naoEncontradosNaShopee.length,
    nao_encontrados_na_shopee_ids: naoEncontradosNaShopee,
    rejeitados_fora_do_periodo: rejeitadosForaDoPeriodo.length,
    rejeitados_fora_do_periodo_ids: rejeitadosForaDoPeriodo,
    linhas_geradas: todasAsLinhas.length,
    pedidos_distintos_recuperaveis: pedidosDistintosRecuperados,
    faturamento_total_recuperavel: Math.round(faturamentoTotal * 100) / 100,
    faturamento_por_pedido: Object.fromEntries(
      Array.from(faturamentoPorPedido.entries()).map(([k, v]) => [k, Math.round(v * 100) / 100])
    ),
  };

  // ── 5) dry_run: para aqui, sem gravar nada ───────────────────────────────
  if (dryRun) {
    return NextResponse.json(respostaBase);
  }

  // ── 6) Escrita real — upsert idempotente, mesmo padrão do sync ──────────
  const UPSERT_BATCH = 250;
  let gravados = 0;
  let errosGravacao = 0;
  const detalheErros: string[] = [];

  for (let i = 0; i < todasAsLinhas.length; i += UPSERT_BATCH) {
    const lote = todasAsLinhas.slice(i, i + UPSERT_BATCH);
    const { error } = await supabase.from("pedidos").upsert(lote, { onConflict: "id" });
    if (error) {
      errosGravacao++;
      detalheErros.push(`lote ${i / UPSERT_BATCH + 1}: ${error.message}`);
    } else {
      gravados += lote.length;
    }
  }

  return NextResponse.json({
    ...respostaBase,
    gravados,
    erros_gravacao: errosGravacao,
    detalhe_erros_gravacao: detalheErros,
  });
}
