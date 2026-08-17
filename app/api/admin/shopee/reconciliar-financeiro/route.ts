/**
 * GET /api/admin/shopee/reconciliar-financeiro
 *
 * Rotina de reconciliacao financeira via Shopee Payment API (get_escrow_detail).
 * Endpoint separado do sync principal (lib/sync-shopee.ts) — nao roda automaticamente,
 * disparado manualmente. Motivo: dados financeiros podem chegar com atraso na Shopee
 * e nao devem travar a sincronizacao normal de pedidos.
 *
 * NAO exposto em nenhuma tela/menu — rota operacional, gated apenas pela sessao
 * (autenticarRequisicao), igual aos outros endpoints do projeto. So processa pedidos do
 * proprio usuario logado.
 *
 * Query params:
 *   order_id  - testa UM pedido especifico (order_sn). Ignora `limit`.
 *   limit     - quantos pedidos processar quando `order_id` nao for passado. Default 5, max 100.
 *   dry_run   - "0" grava de fato no banco. QUALQUER outro valor (ou ausencia do param)
 *               = dry-run (nao grava). Default seguro: dry-run.
 *   force     - "1" reprocessa e sobrescreve pedidos que ja tem has_income_data=true.
 *               Sem esse param, esses pedidos sao ignorados (idempotencia).
 *
 * Selecao: apenas pedidos Shopee com status_shopee_raw='COMPLETED'. Sem `force`,
 * so pedidos com has_income_data=false E escrow_amount=0 (ainda nao reconciliados).
 *
 * O que grava (quando dry_run=0): SOMENTE as colunas brutas de income —
 * escrow_amount, buyer_paid_amount, voucher_from_seller, voucher_from_shopee,
 * commission_fee, service_fee, transaction_fee, campaign_fee, has_income_data.
 * NAO recalcula margem_contrib, mc_percent, lucro_liquido, seller_income ou
 * commissao/tarifa_venda — essas colunas alimentam Dashboard/Vendas hoje e ficam
 * fora do escopo desta etapa (aprovado: nao alterar regra de Dashboard/Vendas).
 *
 * Distribuicao entre itens: pedidos com mais de 1 item tem o valor de escrow
 * distribuido proporcionalmente por item_subtotal (mesmo criterio `ratioItem`
 * ja usado em lib/sync-shopee.ts), para nao introduzir uma segunda logica de
 * rateio divergente da que o sync principal usa.
 *
 * IMPORTANTE (ponto pendente de validacao ao vivo): nao foi possivel confirmar
 * via documentacao oficial se /api/v2/payment/get_escrow_detail esta disponivel
 * para contas Open Platform Brasil — so ha evidencia indireta via SDKs de
 * terceiros. A PRIMEIRA chamada real (dry_run=1&order_id=<um pedido>) E o teste
 * dessa hipotese. Se `resp.error` vier preenchido com algo que indique endpoint
 * inexistente ou permissao negada, pare e nao rode em lote.
 */
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { autenticarRequisicao } from "@/lib/autenticacao";
import { getShopeeLojaAtiva } from "@/lib/shopee-auth";
import { shopeeGet } from "@/lib/shopee-api";
import { atualizarResumosDosDias } from "@/lib/resumos-diarios";

export const maxDuration = 60;

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

interface PedidoRow {
  id: string;
  order_id: string;
  item_subtotal: number;
  has_income_data: boolean;
  escrow_amount: number;
  data_pagamento: string | null;
  data_criacao: string | null;
}

export async function GET(request: Request) {
  // Fase K (2026-07-08): medicao de tempo do lote (aprovado) — so instrumentacao,
  // nao altera nenhuma regra financeira. Usada para calibrar quantos lotes por
  // execucao sao seguros antes de criar o script de orquestracao em lotes.
  const inicioLoteMs = Date.now();

  const auth = await autenticarRequisicao(request);
  const userId = auth.autenticado ? auth.uid : null;
  if (!userId) {
    return NextResponse.json({ erro: true, mensagem: "Sessao invalida." }, { status: 401 });
  }

  // Fase I (2026-07-08): teto elevado de 100 para 500 (aprovado) para reduzir
  // o numero de lotes manuais. Continua reportado explicitamente na resposta
  // (limit_solicitado/limit_aplicado/max_limit_permitido/limit_foi_reduzido).
  const MAX_LIMIT = 500;

  const url          = new URL(request.url);
  const orderIdParam  = url.searchParams.get("order_id");
  // Fase J (2026-07-08): lista especifica de order_ids (aprovado) — para
  // reprocessar um conjunto pontual conhecido (ex.: pedidos sem JSON bruto
  // salvo localmente), sem depender da selecao automatica por limit/data.
  const orderIdsListParam = (url.searchParams.get("order_ids") ?? "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);
  const usandoListaEspecifica = orderIdsListParam.length > 0;
  const limitParamRaw = url.searchParams.get("limit");
  const limitParsed   = limitParamRaw !== null ? Number(limitParamRaw) : null;
  const limitValido    = limitParsed !== null && Number.isFinite(limitParsed) && limitParsed > 0 ? limitParsed : 5;
  const dryRun          = url.searchParams.get("dry_run") !== "0"; // default seguro = dry-run
  const force           = url.searchParams.get("force") === "1";

  // ── MODO PERIODO (F0.c.19) ───────────────────────────────────────────────
  // Antes so era possivel selecionar por `limit` (sem data) ou por order_id.
  // Reconciliar UM dia exigia varias execucoes que escolhiam pedidos
  // arbitrarios — na pratica, impossivel. Aqui entram date_from/date_to +
  // cursor estavel.
  const dateFrom   = url.searchParams.get("date_from");
  const dateTo     = url.searchParams.get("date_to");
  const cursorParam = url.searchParams.get("cursor");
  const modoPeriodo = !orderIdParam && !usandoListaEspecifica
    && (dateFrom !== null || dateTo !== null || cursorParam !== null);

  // ── SO SELECAO (F0.c.19) ─────────────────────────────────────────────────
  // `dry_run` desta rota NAO e livre de chamada externa: ele existe para
  // mostrar o que SERIA gravado, e para isso precisa do dado real da Shopee
  // — 754 chamadas a get_escrow_detail para um unico dia.
  //
  // Para auditar a PAGINACAO isso e custo puro: a selecao e o cursor nao
  // dependem de nenhum dado financeiro. `so_selecao=1` executa selecao,
  // cursor e resposta, e para antes do laco. Zero chamada externa, zero
  // escrita.
  const soSelecao = url.searchParams.get("so_selecao") === "1";

  /** Teto por request no modo periodo. Menor que MAX_LIMIT de proposito. */
  const MAX_LIMIT_PERIODO = 100;
  const MAX_DIAS_JANELA    = 7;
  const ehDataISO = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));
  const erro400 = (mensagem: string) =>
    NextResponse.json({ ok: false, erro: mensagem }, { status: 400 });

  interface Cursor { d: string; o: string }
  let cursor: Cursor | null = null;

  if (soSelecao && !modoPeriodo) {
    return erro400("so_selecao=1 so existe no modo periodo (exige date_from e date_to).");
  }
  // Combinacao contraditoria falha alto em vez de ser ignorada em silencio:
  // quem pede escrita e leitura-pura na mesma chamada esta enganado sobre
  // uma das duas, e adivinhar qual seria pior que recusar.
  if (soSelecao && url.searchParams.get("dry_run") === "0") {
    return erro400("so_selecao=1 e read-only e nao aceita dry_run=0.");
  }

  if (modoPeriodo) {
    if (!dateFrom || !dateTo) {
      return erro400("No modo periodo, date_from e date_to sao obrigatorios.");
    }
    if (!ehDataISO(dateFrom) || !ehDataISO(dateTo)) {
      return erro400("date_from e date_to devem estar em YYYY-MM-DD.");
    }
    if (dateFrom > dateTo) {
      return erro400("date_from nao pode ser maior que date_to.");
    }
    const dias = Math.round(
      (Date.parse(`${dateTo}T00:00:00Z`) - Date.parse(`${dateFrom}T00:00:00Z`)) / 86400000
    ) + 1;
    if (dias > MAX_DIAS_JANELA) {
      return erro400(`Janela maxima de ${MAX_DIAS_JANELA} dias (pedida: ${dias}).`);
    }
    if (cursorParam) {
      // Cursor e opaco para o cliente, mas NUNCA confiavel: decodifica,
      // valida formato e exige que pertenca ao periodo pedido. Sem isso,
      // um cursor forjado leria pedidos fora da janela autorizada.
      try {
        const bruto = JSON.parse(Buffer.from(cursorParam, "base64url").toString("utf8"));
        if (typeof bruto?.d !== "string" || typeof bruto?.o !== "string") throw new Error("forma");
        if (!ehDataISO(bruto.d)) throw new Error("data");
        if (bruto.d < dateFrom || bruto.d > dateTo) throw new Error("fora do periodo");
        cursor = { d: bruto.d, o: bruto.o };
      } catch {
        return erro400("cursor invalido ou fora do periodo solicitado.");
      }
    }
  }

  const tetoLimit      = modoPeriodo ? MAX_LIMIT_PERIODO : MAX_LIMIT;
  const limit          = Math.min(limitValido, tetoLimit);
  const limitFoiReduzido = limitValido > tetoLimit;

  const loja = await getShopeeLojaAtiva(userId);
  if (!loja) {
    return NextResponse.json({ ok: false, erro: "Shopee nao conectada ou token invalido." }, { status: 400 });
  }

  // ── Selecao dos pedidos-alvo ─────────────────────────────────────────────
  // Ordenacao: data_pagamento ASC, depois order_id ASC — reconciliacao sempre
  // retoma dos pedidos mais antigos sem dado financeiro, de forma previsivel
  // e auditavel (aprovado explicitamente, nao mudar sem pedido novo).
  let sel = supabase
    .from("pedidos")
    .select("id, order_id, item_subtotal, has_income_data, escrow_amount, data_pagamento, data_criacao")
    .eq("user_id", userId)
    .eq("marketplace", "Shopee")
    .eq("status_shopee_raw", "COMPLETED")
    .order("data_pagamento", { ascending: true })
    .order("order_id", { ascending: true });

  if (usandoListaEspecifica) {
    sel = sel.in("order_id", orderIdsListParam);
  } else if (orderIdParam) {
    sel = sel.eq("order_id", orderIdParam);
  } else if (!force) {
    sel = sel.eq("has_income_data", false).eq("escrow_amount", 0);
  }

  if (modoPeriodo) {
    sel = sel.gte("data_pagamento", dateFrom!).lte("data_pagamento", dateTo!);
    if (cursor) {
      // Cursor estavel em (data_pagamento, order_id). NAO usar OFFSET: a
      // propria reconciliacao grava has_income_data=true, entao as linhas
      // saem do filtro entre uma pagina e outra e o offset passaria a
      // apontar para o lugar errado, PULANDO pedidos em silencio.
      // `data_pagamento` e `order_id` sao imutaveis — a escrita nunca os
      // toca —, entao a posicao nao se move.
      sel = sel.or(
        `data_pagamento.gt.${cursor.d},and(data_pagamento.eq.${cursor.d},order_id.gt.${cursor.o})`
      );
    }
    // Teto de linhas: um pedido tem varias linhas (maximo observado: 7).
    // 20 por pedido e folga larga; o corte real e por PEDIDO, abaixo.
    sel = sel.range(0, limit * 20 - 1);
  }

  const { data: rowsRaw, error: selErr } = await sel;
  if (selErr) {
    return NextResponse.json({ ok: false, erro: "Erro ao selecionar pedidos: " + selErr.message }, { status: 500 });
  }

  let rows = (rowsRaw ?? []) as PedidoRow[];

  // Agrupa por order_id — pedidos com mais de 1 item tem varias linhas na tabela
  let porPedido = new Map<string, PedidoRow[]>();
  for (const r of rows) {
    const arr = porPedido.get(r.order_id) ?? [];
    arr.push(r);
    porPedido.set(r.order_id, arr);
  }

  let orderIds = Array.from(porPedido.keys());
  let temMais = false;
  let proximoCursor: string | null = null;

  if (modoPeriodo) {
    temMais  = orderIds.length > limit;
    orderIds = orderIds.slice(0, limit);

    // Segunda leitura, restrita aos pedidos desta pagina: garante que TODAS
    // as linhas de cada pedido estao presentes. Sem isto, um pedido cortado
    // na fronteira da janela de linhas teria o escrow rateado sobre parte
    // dos itens — erro financeiro silencioso.
    if (orderIds.length > 0) {
      const { data: completasRaw, error: erroCompletas } = await supabase
        .from("pedidos")
        .select("id, order_id, item_subtotal, has_income_data, escrow_amount, data_pagamento, data_criacao")
        .eq("user_id", userId)
        .eq("marketplace", "Shopee")
        .eq("status_shopee_raw", "COMPLETED")
        .in("order_id", orderIds)
        .order("data_pagamento", { ascending: true })
        .order("order_id", { ascending: true });
      if (erroCompletas) {
        return NextResponse.json({ ok: false, erro: "Erro ao completar itens: " + erroCompletas.message }, { status: 500 });
      }
      rows = (completasRaw ?? []) as PedidoRow[];
      porPedido = new Map<string, PedidoRow[]>();
      for (const r of rows) {
        const arr = porPedido.get(r.order_id) ?? [];
        arr.push(r);
        porPedido.set(r.order_id, arr);
      }

      const ultimo = orderIds[orderIds.length - 1];
      const dataUltimo = porPedido.get(ultimo)?.[0]?.data_pagamento ?? null;
      if (dataUltimo) {
        proximoCursor = Buffer.from(JSON.stringify({ d: dataUltimo, o: ultimo }), "utf8").toString("base64url");
      }
    }
  } else if (!orderIdParam && !usandoListaEspecifica) {
    orderIds = orderIds.slice(0, limit);
  }

  const detalhes: any[] = [];
  let consultados             = 0;
  let comIncome                = 0;
  let semIncome                = 0;
  let gravados                 = 0;
  let ignoradosIdempotencia    = 0;

  // Fase 4 Parte 2 (aprovado 2026-07-10): dias efetivamente escritos nesta
  // reconciliação, para invalidar SÓ esses dias em dashboard_resumos_diarios
  // (nunca o período inteiro). Toda a rota opera numa única loja Shopee por
  // chamada (loja.nickname), então uma única conta para o lote inteiro.
  const diasPagamentoAfetados = new Set<string>();
  const diasCriacaoAfetados   = new Set<string>();

  // `so_selecao` esvazia a lista de trabalho: o laco abaixo — unico lugar
  // que chama a Shopee e unico lugar que grava — simplesmente nao roda.
  const orderIdsParaProcessar = soSelecao ? [] : orderIds;

  for (const orderId of orderIdsParaProcessar) {
    const rowsPedido = porPedido.get(orderId)!;
    consultados++;

    let resp: any;
    try {
      resp = await shopeeGet(
        "/api/v2/payment/get_escrow_detail",
        loja.partnerId, loja.partnerKey, loja.accessToken, loja.shopId,
        { order_sn: orderId }
      );
    } catch (err: any) {
      detalhes.push({
        order_id: orderId,
        sucesso:  false,
        motivo:   "Falha de rede/timeout: " + String(err?.message ?? err),
      });
      continue;
    }

    if (resp?.error) {
      detalhes.push({
        order_id: orderId,
        sucesso:  false,
        motivo:   `Shopee retornou error="${resp.error}" message="${resp.message ?? ""}"`,
        aviso:    "Se este erro indicar endpoint inexistente ou permissao negada, PARE antes de rodar em mais pedidos.",
      });
      continue;
    }

    const income = resp?.response?.order_income ?? null;
    if (!income) {
      detalhes.push({
        order_id: orderId,
        sucesso:  false,
        motivo:   "Resposta sem response.order_income — Shopee aceitou a chamada mas nao devolveu dado financeiro para este pedido.",
      });
      continue;
    }

    // Fase G (2026-07-07): usa escrow_amount_after_adjustment quando disponivel —
    // e o valor final apos ajustes reais da Shopee (DIFAL, debitos fiscais, etc.).
    // escrow_amount sozinho pode ser o valor PRE-ajuste, divergindo do que a
    // Shopee de fato repassa ao vendedor (confirmado com pedido real 2605018U9BKYSA:
    // escrow_amount=8.56 vs escrow_amount_after_adjustment=6.68, diff = order_adjustment -1.88).
    const escrowAmount   = Number(income.escrow_amount_after_adjustment ?? income.escrow_amount ?? 0);
    const buyerTotal      = Number(income.buyer_total_amount ?? 0);
    const voucherSeller   = Number(income.voucher_from_seller ?? 0);
    const voucherShopee   = Number(income.voucher_from_shopee ?? 0);
    const commissionFee   = Number(income.commission_fee ?? 0);
    const serviceFee       = Number(income.service_fee ?? 0);
    const transactionFee   = Number(income.seller_transaction_fee ?? income.transaction_fee ?? 0);
    const campaignFee      = Number(income.campaign_fee ?? 0);

    // Fase H (2026-07-07): CORRECAO DE CRITERIO. Antes: hasRealIncome = escrowAmount > 0,
    // o que tratava devolucao total (escrow=0) e ajuste negativo pos-reembolso
    // (escrow<0) como "sem dado real" — mas os dois sao eventos financeiros REAIS
    // que a Shopee retornou oficialmente (confirmado com pedidos reais
    // 26050194P1A2DW: devolucao total, escrow_amount_after_adjustment=0; e
    // 2605019JG9RJGF: reembolso aprovado apos escrow original, resultando em
    // escrow_amount_after_adjustment=-3.07). Novo criterio: "dado real" = a
    // Shopee retornou um order_income valido (ja garantido pelo `if (!income)`
    // acima) — independente do valor de escrow ser positivo, zero ou negativo.
    const hasRealIncome = true;
    if (hasRealIncome) comIncome++; else semIncome++;

    const jaTemDadoReal            = rowsPedido.some(r => r.has_income_data === true);
    const vaiIgnorarPorIdempotencia = jaTemDadoReal && !force;

    const orderItemsSubtotal = rowsPedido.reduce((acc, r) => acc + (Number(r.item_subtotal) || 0), 0);

    const wouldWriteRows = rowsPedido.map(r => {
      const ratio = orderItemsSubtotal > 0
        ? (Number(r.item_subtotal) || 0) / orderItemsSubtotal
        : 1 / rowsPedido.length;
      return {
        id:                  r.id,
        escrow_amount:       round2(escrowAmount * ratio),
        buyer_paid_amount:   round2(buyerTotal * ratio),
        voucher_from_seller: round2(voucherSeller * ratio),
        voucher_from_shopee: round2(voucherShopee * ratio),
        commission_fee:      round2(commissionFee * ratio),
        service_fee:         round2(serviceFee * ratio),
        transaction_fee:     round2(transactionFee * ratio),
        campaign_fee:        round2(campaignFee * ratio),
        has_income_data:     hasRealIncome,
      };
    });

    let statusGravacao = dryRun ? "dry_run" : "pendente";

    if (!dryRun) {
      if (vaiIgnorarPorIdempotencia) {
        statusGravacao = "ignorado_ja_possui_dado_real";
        ignoradosIdempotencia++;
      } else {
        let erroGravacao: string | null = null;
        for (const w of wouldWriteRows) {
          const { id, ...campos } = w;
          const { error: updErr } = await supabase.from("pedidos").update(campos).eq("id", id);
          if (updErr) erroGravacao = updErr.message;
        }
        if (erroGravacao) {
          statusGravacao = "erro_gravacao: " + erroGravacao;
        } else {
          statusGravacao = "gravado";
          gravados++;
        }
        // Escrita foi tentada (mesmo com erro parcial, algumas linhas podem
        // ter sido gravadas) — marca os dias deste pedido para recálculo.
        for (const r of rowsPedido) {
          if (r.data_pagamento) diasPagamentoAfetados.add(r.data_pagamento);
          if (r.data_criacao)   diasCriacaoAfetados.add(r.data_criacao);
        }
      }
    }

    detalhes.push({
      order_id:              orderId,
      sucesso:               true,
      tem_income_real:       hasRealIncome,
      ja_possuia_dado_real:  jaTemDadoReal,
      status_gravacao:       statusGravacao,
      order_income_bruto:    income,
      seria_gravado:         wouldWriteRows,
    });
  }

  // Fase 4 Parte 2 (aprovado 2026-07-10): recalcula dashboard_resumos_diarios
  // só para os dias efetivamente afetados por esta reconciliação. Falha aqui
  // NUNCA derruba a reconciliação — resumos é cache, não fonte de verdade.
  //
  // F0.c.19: guardado por `!dryRun`. Antes ficava fora de qualquer condicional
  // e, se os Sets fossem preenchidos, `dry_run=1` gravava em
  // `dashboard_resumos_diarios` — um upsert real numa execucao que promete
  // ser leitura pura. "dry-run com uma escrita só" nao e dry-run.
  if (!dryRun && (diasPagamentoAfetados.size > 0 || diasCriacaoAfetados.size > 0)) {
    try {
      await atualizarResumosDosDias(
        userId, loja.lojaId, "Shopee", loja.nickname,
        Array.from(diasPagamentoAfetados), Array.from(diasCriacaoAfetados)
      );
    } catch (err: any) {
      console.error("[reconciliar-financeiro] erro ao atualizar dashboard_resumos_diarios (nao afeta a reconciliacao):", err?.message ?? err);
    }
  }

  return NextResponse.json({
    ok:                       true,
    tempo_lote_ms:            Date.now() - inicioLoteMs,
    dry_run:                  dryRun,
    force,
    // ── modo periodo (F0.c.19) ────────────────────────────────────────────
    modo:                     modoPeriodo ? "periodo" : (orderIdParam || usandoListaEspecifica ? "order_id" : "legado"),
    so_selecao:               modoPeriodo ? soSelecao : null,
    date_from:                modoPeriodo ? dateFrom : null,
    date_to:                  modoPeriodo ? dateTo   : null,
    encontrados:              modoPeriodo ? orderIds.length : null,
    processados:              modoPeriodo ? consultados : null,
    ignorados:                modoPeriodo ? ignoradosIdempotencia : null,
    erros:                    modoPeriodo ? (soSelecao ? 0 : consultados - gravados - ignoradosIdempotencia) : null,
    // Contagem apenas — nenhum dado de comprador, financeiro ou credencial.
    linhas_da_pagina:         modoPeriodo ? rows.length : null,
    proximo_cursor:           modoPeriodo ? proximoCursor : null,
    has_more:                 modoPeriodo ? temMais : null,
    // Em dry_run devolve os order_ids da pagina para auditar a paginacao.
    // Somente identificadores de pedido — nenhum dado financeiro ou pessoal.
    order_ids_da_pagina:      modoPeriodo && dryRun ? orderIds : null,
    limit_solicitado:         (orderIdParam || usandoListaEspecifica) ? null : limitParsed,
    limit_aplicado:           (orderIdParam || usandoListaEspecifica) ? null : limit,
    max_limit_permitido:      MAX_LIMIT,
    limit_foi_reduzido:       (orderIdParam || usandoListaEspecifica) ? false : limitFoiReduzido,
    order_ids_solicitados:    usandoListaEspecifica ? orderIdsListParam.length : null,
    order_ids_encontrados:    usandoListaEspecifica ? orderIds.length : null,
    selecionados:             orderIds.length,
    consultados,
    com_income:               comIncome,
    sem_income:               semIncome,
    gravados,
    ignorados_idempotencia:   ignoradosIdempotencia,
    aviso: orderIds.length === 0
      ? "Nenhum pedido encontrado com os criterios atuais (status_shopee_raw='COMPLETED' + filtros de has_income_data/escrow_amount/order_id/order_ids)."
      : (usandoListaEspecifica && orderIds.length < orderIdsListParam.length)
        ? `Atencao: ${orderIdsListParam.length - orderIds.length} order_id(s) solicitados nao foram encontrados no banco (status_shopee_raw != COMPLETED ou order_id inexistente).`
        : undefined,
    detalhes,
  });
}
