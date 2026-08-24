/**
 * GET /api/ml/vendas
 * Lê da tabela `pedidos` (cache). Se não houver dados ou estiver stale, faz sync on-demand.
 * O cron /api/sync mantém os últimos 7 dias sempre frescos.
 */
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { autenticarRequisicao } from "@/lib/autenticacao";
import { syncMLForUser } from "@/lib/sync-ml";
import { lerIdLojaMLAtivaMaisRecenteDoDono } from "@/lib/marketplace/credenciais";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

function getToken(request: Request): string | null {
  const cookieHeader = request.headers.get("cookie") || "";
  const entry = cookieHeader.split("; ").find(c => c.startsWith("ml_access_token="));
  return entry ? entry.slice("ml_access_token=".length) : null;
}

function hojeISO() {
  return new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString().split("T")[0];
}

// Etapa 1 (ajuste pós-aprovação — ver docs/BUGS.md): classifica a mensagem
// crua de erro de página num código estável, pra o front nunca precisar
// comparar texto de erro. Novos padrões podem ser acrescentados aqui sem
// mudar o formato da resposta.
function classificarErroPagina(mensagem: string | null | undefined): string {
  const msg = (mensagem ?? "").toLowerCase();
  if (msg.includes("statement timeout")) return "statement_timeout";
  if (msg.includes("econnreset") || msg.includes("connection") || msg.includes("network")) return "connection_error";
  if (msg.includes("rate limit") || msg.includes("too many requests")) return "rate_limit";
  return "erro_desconhecido";
}

function pedidoToRow(p: any) {
  return {
    orderId:        p.order_id,
    data:           p.data,
    anuncio:        p.anuncio,
    mlItemId:       p.ml_item_id,
    conta:          p.conta,
    marketplace:    p.marketplace,
    sku:            p.sku,
    status:         p.status,
    frete:          p.frete,
    logistica:      p.logistica,
    valorUnit:      Number(p.valor_unit),
    qtd:            Number(p.qtd),
    faturamento:    Number(p.faturamento),
    custo:          Number(p.custo),
    imposto:        Number(p.imposto),
    tarifaVenda:    Number(p.tarifa_venda),
    freteComprador: Number(p.frete_comprador),
    freteVendedor:  Number(p.frete_vendedor),
    margemContrib:  Number(p.margem_contrib),
    mcPercent:      Number(p.mc_percent),
    cadastrado:     p.cadastrado,
  };
}

export async function GET(request: Request) {
  const token  = getToken(request);
  const auth = await autenticarRequisicao(request);
  const userId = auth.autenticado ? auth.uid : null;

  if (!userId) {
    return NextResponse.json({ erro: true, semConexao: true, mensagem: "Sessão inválida." }, { status: 401 });
  }

  const url        = new URL(request.url);
  const dateFrom   = url.searchParams.get("date_from") || hojeISO();
  const dateTo     = url.searchParams.get("date_to")   || hojeISO();
  const skuParam   = url.searchParams.get("sku") || "";
  const skuFilters = skuParam.split(",").map(s => s.toLowerCase().trim()).filter(Boolean);

  // Id da loja ML ativa — leitura simples, sem side-effect de refresh de
  // token (diferente de getMLLojaAtiva). Exposto na resposta para o
  // frontend disparar POST /api/sync/iniciar com o loja_id correto (ver
  // docs/DECISIONS.md, redesenho do botão Sincronizar, 2026-07-11).
  // LOJAS-ANON-SELECT: era leitura com o cliente ANON. So o `id` sai do
  // banco — a rota nunca usou token aqui.
  const { lojaId: lojaIdAtiva } = await lerIdLojaMLAtivaMaisRecenteDoDono(userId);
  const lojaRow = lojaIdAtiva ? { id: lojaIdAtiva } : null;
  const lojaId = lojaRow?.id ?? null;

  // Fase C (2026-07-06): date_field decide se o relatório é filtrado por
  // data_pagamento (visão financeira, padrão) ou data_criacao (visão operacional).
  // Ver docs/BUSINESS_RULES.md "Fase C — date_field nas APIs de vendas".
  const dateField: "pagamento" | "criacao" =
    url.searchParams.get("date_field") === "criacao" ? "criacao" : "pagamento";

  const forceSync = url.searchParams.get("sync") === "1";
  const _reqid = url.searchParams.get("_reqid") ?? "(sem reqid)";
  const _inicioMs = Date.now();

  // [DIAG-DATAS] temporário — remover após a auditoria
  console.log(`[DIAG-DATAS][ml/vendas] req #${_reqid} recebida`, {
    querystringCompleta: request.url,
    dateFrom, dateTo, dateField, forceSync,
    rangeInvalido: dateFrom > dateTo,
  });

  // Checa cache
  const { data: probe } = await supabase
    .from("pedidos")
    .select("synced_at")
    .eq("user_id", userId)
    .eq("marketplace", "ML")
    .gte("data", dateFrom)
    .lte("data", dateTo)
    .order("synced_at", { ascending: false })
    .limit(1);

  const hasData = probe && probe.length > 0;
  const hoje    = hojeISO();

  // Sem token de cookie E sem cache → ML não conectada
  if (!token && !hasData) {
    // [DIAG-DATAS] temporário — remover após a auditoria
    console.log(`[DIAG-DATAS][ml/vendas] req #${_reqid} RESPOSTA (semConexao)`, {
      dateFrom, dateTo, dateField, tempoMs: Date.now() - _inicioMs,
    });
    return NextResponse.json({ erro: true, semConexao: true, mensagem: "Conta do Mercado Livre não conectada." });
  }

  // RESTAURADO em 2026-07-13 (ver docs/DECISIONS.md, feature flag
  // ENABLE_ASYNC_SYNC_JOBS): tinha sido removido em 2026-07-11 assumindo que
  // o novo fluxo (sync_jobs + worker) substituiria este sync inline. Como a
  // ativação em produção do fluxo novo ficou condicionada a existir um
  // processador permanente de jobs (ainda não existe), o botão Sincronizar
  // em produção precisa continuar usando exatamente este caminho enquanto
  // ENABLE_ASYNC_SYNC_JOBS=false. O front só envia ?sync=1 quando a flag
  // está desligada (ver app/(app)/vendas/page.tsx, lerMarketplace).
  // Corrigido 2026-07-13 (auditoria de segurança pré-deploy): as chamadas de
  // sync abaixo não tinham try/catch — diferente de app/api/shopee/vendas
  // (que sempre teve). syncMLForUser → syncMLForUserV2 pode lançar
  // LojaIdIntegrityError (regra de integridade de loja_id, aprovada
  // 2026-07-11) se a resolução por seller_id encontrar 0 ou 2+ lojas em vez
  // de exatamente 1 — sem este try/catch, isso derrubaria a rota inteira
  // com 500 em vez de servir o cache já existente. Nada disto depende da
  // flag ENABLE_ASYNC_SYNC_JOBS; é uma correção de segurança independente.
  try {
    if (forceSync) {
      // Botão Sincronizar (fluxo antigo): re-sincroniza o range inteiro
      await syncMLForUser(userId, dateFrom, dateTo, token ?? undefined);
    } else if (!hasData) {
      // Sem cache: sync completo (primeira vez)
      await syncMLForUser(userId, dateFrom, dateTo, token ?? undefined);
    } else {
      // Tem cache: só atualiza hoje se o range inclui hoje (barato, 1 dia)
      const rangeIncludeHoje = dateFrom <= hoje && hoje <= dateTo;
      if (rangeIncludeHoje) {
        const { data: probeHoje } = await supabase
          .from("pedidos").select("synced_at")
          .eq("user_id", userId).eq("marketplace", "ML")
          .eq("data", hoje)
          .order("synced_at", { ascending: false }).limit(1);
        const lastSyncHoje = probeHoje?.[0]?.synced_at
          ? new Date(probeHoje[0].synced_at).getTime() : 0;
        const staleMinutos = (Date.now() - lastSyncHoje) / 60000;
        console.log(`[DIAG-DATAS][ml/vendas] req #${_reqid} range inclui hoje — checando staleness`, {
          lastSyncHoje: lastSyncHoje ? new Date(lastSyncHoje).toISOString() : null, staleMinutos,
          vaiSincronizar: Date.now() - lastSyncHoje > 30 * 60 * 1000,
        });
        if (Date.now() - lastSyncHoje > 30 * 60 * 1000) { // stale > 30 min
          console.log(`[DIAG-DATAS][ml/vendas] req #${_reqid} disparando auto-sync de hoje (stale)`);
          await syncMLForUser(userId, hoje, hoje, token ?? undefined);
          console.log(`[DIAG-DATAS][ml/vendas] req #${_reqid} auto-sync de hoje concluido`);
        }
      }
    }
  } catch (syncErr) {
    console.error("[ml/vendas] sync error:", syncErr instanceof Error ? syncErr.message : syncErr);
    console.log(`[DIAG-DATAS][ml/vendas] req #${_reqid} SYNC FALHOU (capturado, segue lendo cache)`, {
      erro: syncErr instanceof Error ? syncErr.message : String(syncErr),
    });
    // Não retorna erro - lê do cache mesmo que sync falhe (mesmo padrão de shopee/vendas).
  }

  // Lê do banco
  // Fase C (2026-07-06): filtro por date_field — mesma regra do shopee/vendas.
  // "pagamento" (padrão): filtra por data_pagamento; fallback pra `data` legada
  // só quando data_criacao TAMBÉM é NULL (pedido pré-Fase-B). Pedido pós-Fase-B
  // genuinamente não pago (data_criacao preenchido, data_pagamento NULL) fica
  // de fora da visão financeira, sem exceção.
  // "criacao": filtra por data_criacao, com fallback pra `data` legada quando
  // data_criacao é NULL.
  //
  // Fase E (2026-07-07): mesma correção de truncamento aplicada em
  // shopee/vendas — o Supabase/PostgREST corta silenciosamente qualquer
  // .select() sem .range() no limite implícito do projeto (confirmado em
  // 1000 linhas na auditoria da Shopee). Aqui também passamos a buscar em
  // páginas via .range(), mesmos filtros de sempre.
  function buildPedidosQuery(
    selectArg: string,
    opts?: { count?: "exact"; head?: boolean }
  ) {
    let q = supabase
      .from("pedidos")
      .select(selectArg, opts as any)
      .eq("user_id", userId)
      .eq("marketplace", "ML");

    if (dateField === "pagamento") {
      q = q.or(
        `and(data_pagamento.gte.${dateFrom},data_pagamento.lte.${dateTo}),` +
        `and(data_pagamento.is.null,data_criacao.is.null,data.gte.${dateFrom},data.lte.${dateTo})`
      );
    } else {
      q = q.or(
        `and(data_criacao.gte.${dateFrom},data_criacao.lte.${dateTo}),` +
        `and(data_criacao.is.null,data.gte.${dateFrom},data.lte.${dateTo})`
      );
    }
    return q;
  }

  const PAGE_SIZE = 1000;
  const MAX_PAGES = 50; // guarda de segurança: até 50.000 linhas
  // Etapa 1 (correção de integridade — ver docs/BUGS.md, "timeout silencioso
  // na paginação"): até 3 tentativas por página, backoff curto e crescente.
  // Um erro persistente NUNCA é tratado como fim normal da paginação — só
  // página vazia ou página menor que PAGE_SIZE encerram normalmente.
  const RETRY_BACKOFF_MS = [400, 900, 1500];
  let pedidos: any[] = [];
  let paginacaoFalhou = false;
  let paginaQueFalhou: number | null = null;
  let erroResumido: string | null = null;
  const _paginaInicioMs = Date.now();
  for (let page = 0; page < MAX_PAGES; page++) {
    const from = page * PAGE_SIZE;
    const to   = from + PAGE_SIZE - 1;
    // Desempate por "id" (2026-07-13, ver docs/BUGS.md) — mesmo fix aplicado
    // em shopee/vendas: id é único e NOT NULL em toda a tabela (confirmado).
    let pageData: any[] | null = null;
    let pageErr: any = null;

    for (let tentativa = 1; tentativa <= 3; tentativa++) {
      const _pagMs = Date.now();
      const pageResult = await buildPedidosQuery("*")
        .order("data", { ascending: false })
        .order("id",   { ascending: true })
        .range(from, to);
      pageData = pageResult.data;
      pageErr = pageResult.error;

      // [DIAG-DATAS] temporário — remover após a auditoria
      console.log(`[DIAG-DATAS][ml/vendas] req #${_reqid} pagina ${page} tentativa ${tentativa}`, {
        marketplace: "ML", from, to,
        linhasRetornadas: pageData?.length ?? 0,
        totalAcumuladoAntes: pedidos.length,
        erro: pageErr?.message ?? null,
        tempoMsDaPagina: Date.now() - _pagMs,
      });

      if (!pageErr) break; // sucesso nesta tentativa — sai do loop de retry

      console.error(`[ml/vendas] erro na página ${page} (tentativa ${tentativa}/3)`, pageErr.message);
      if (tentativa < 3) {
        const espera = RETRY_BACKOFF_MS[tentativa - 1];
        console.log(`[DIAG-DATAS][ml/vendas] req #${_reqid} pagina ${page} nova tentativa em ${espera}ms`, {
          marketplace: "ML", proximaTentativa: tentativa + 1,
        });
        await new Promise(resolve => setTimeout(resolve, espera));
      }
    }

    if (pageErr) {
      // Persistiu erro após as 3 tentativas — não é fim normal da paginação.
      paginacaoFalhou = true;
      paginaQueFalhou = page;
      erroResumido = pageErr.message ?? String(pageErr);
      console.log(`[DIAG-DATAS][ml/vendas] req #${_reqid} PAGINACAO FALHOU DEFINITIVAMENTE na pagina ${page} apos 3 tentativas`, {
        marketplace: "ML", totalAcumulado: pedidos.length, erro: erroResumido,
      });
      break;
    }
    if (!pageData || pageData.length === 0) {
      console.log(`[DIAG-DATAS][ml/vendas] req #${_reqid} SAIU DO LOOP por pagina vazia (${page})`, {
        totalAcumulado: pedidos.length,
      });
      break;
    }
    pedidos = pedidos.concat(pageData);
    if (pageData.length < PAGE_SIZE) {
      console.log(`[DIAG-DATAS][ml/vendas] req #${_reqid} SAIU DO LOOP por pagina curta (${page}, ${pageData.length} < ${PAGE_SIZE})`, {
        totalAcumulado: pedidos.length,
      });
      break; // última página (veio incompleta)
    }
    if (page === MAX_PAGES - 1) {
      console.log(`[DIAG-DATAS][ml/vendas] req #${_reqid} ATINGIU MAX_PAGES (${MAX_PAGES}) — pode haver mais dados nao lidos`, {
        totalAcumulado: pedidos.length,
      });
    }
  }
  console.log(`[DIAG-DATAS][ml/vendas] req #${_reqid} paginacao concluida`, {
    totalPaginas: Math.ceil(pedidos.length / PAGE_SIZE) || 0,
    totalLinhas: pedidos.length,
    paginacaoFalhou, paginaQueFalhou, erroResumido,
    tempoMsTotalPaginacao: Date.now() - _paginaInicioMs,
  });

  if (paginacaoFalhou) {
    // Etapa 1: nunca devolver linhas parciais nem totais como se fossem
    // definitivos. O front (Etapa 2) decide o que fazer com "incompleto".
    // "motivo" é a categoria ampla de por que veio incompleto (hoje só existe
    // "paginacao_falhou" — deixa espaço pra futuras causas sem quebrar o
    // formato). "erro" é um código estável específico da falha de leitura;
    // "erro_detalhe" é a mensagem crua, só pra log/debug.
    const erroCodigo = classificarErroPagina(erroResumido);
    console.log(`[DIAG-DATAS][ml/vendas] req #${_reqid} RESPOSTA (incompleto)`, {
      dateFrom, dateTo, dateField, linhasLidas: pedidos.length, paginaQueFalhou,
      erro: erroCodigo, erro_detalhe: erroResumido,
      tempoMs: Date.now() - _inicioMs,
    });
    return NextResponse.json({
      incompleto: true,
      motivo: "paginacao_falhou",
      linhas_lidas: pedidos.length,
      pagina_falhou: paginaQueFalhou,
      erro: erroCodigo,
      erro_detalhe: erroResumido,
      dateFrom,
      dateTo,
      dateField,
      lojaId,
      conta: "ML",
    });
  }

  let rows = (pedidos ?? []).map(pedidoToRow);

  if (skuFilters.length > 0) {
    rows = rows.filter(r => {
      const a = (r.sku ?? "").toLowerCase();
      const b = (r.anuncio ?? "").toLowerCase();
      return skuFilters.some(f => a.includes(f) || b.includes(f));
    });
  }

  const conta       = pedidos?.[0]?.conta ?? "ML";
  // P5 FIX: contar apenas pedidos pagos (igual ao pedidosUnicos da página vendas)
  const totalOrders = new Set(rows.filter(r => r.status === 'paid').map(r => r.orderId)).size;

  // [DIAG-DATAS] temporário — remover após a auditoria
  console.log(`[DIAG-DATAS][ml/vendas] req #${_reqid} RESPOSTA`, {
    dateFrom, dateTo, dateField, totalPedidos: totalOrders, rows: rows.length,
    tempoMs: Date.now() - _inicioMs,
  });

  return NextResponse.json({
    dateFrom,
    dateTo,
    dateField,
    conta,
    lojaId,
    totalPedidos: totalOrders,
    rows,
  });
}
