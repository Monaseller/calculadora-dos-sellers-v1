/**
 * GET /api/shopee/vendas
 * Lê da tabela `pedidos` (cache Supabase).
 * Sync on-demand limitado a HOJE apenas (Vercel Hobby: 10s timeout).
 * Sync de histórico via /api/sync ou botão Histórico.
 */
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { autenticarRequisicao } from "@/lib/autenticacao";
import { getShopeeLojaAtiva } from "@/lib/shopee-auth";
import { syncShopeeForUserV2 } from "@/lib/sync-shopee";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

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
  // P-FAT: faturamento Shopee = item_subtotal (preço puro dos itens, sem frete do comprador).
  // Equivale ao campo "Vendas" do painel Shopee Seller Center.
  // Fallback para p.faturamento (total_amount) em pedidos pré-Fase1 onde item_subtotal=0.
  const fatExibido = Number(p.item_subtotal) > 0
    ? Number(p.item_subtotal)
    : Number(p.faturamento);

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
    faturamento:    fatExibido,  // item_subtotal (sem frete comprador)
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
  const auth = await autenticarRequisicao(request);
  const userId = auth.autenticado ? auth.uid : null;
  if (!userId) return NextResponse.json({ erro: true, mensagem: "Sessão inválida." }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const dateFrom   = searchParams.get("date_from") ?? hojeISO();
  const dateTo     = searchParams.get("date_to")   ?? dateFrom;
  const skuParam   = searchParams.get("sku") ?? "";
  const skuFilters = skuParam.split(",").map(s => s.toLowerCase().trim()).filter(Boolean);

  // Fase C (2026-07-06): date_field decide se o relatório é filtrado por
  // data_pagamento (visão financeira, padrão) ou data_criacao (visão operacional).
  // Ver docs/BUSINESS_RULES.md "Fase C - date_field nas APIs de vendas".
  const dateField: "pagamento" | "criacao" =
    searchParams.get("date_field") === "criacao" ? "criacao" : "pagamento";

  // Verifica conexão Shopee
  const loja = await getShopeeLojaAtiva(userId);
  if (!loja) {
    return NextResponse.json({ erro: true, semConexao: true, mensagem: "Conta Shopee não conectada." });
  }

  const forceSync = searchParams.get("sync") === "1";
  const hoje = hojeISO();
  const _reqid = searchParams.get("_reqid") ?? "(sem reqid)";
  const _inicioMs = Date.now();

  // [DIAG-DATAS] temporário — remover após a auditoria
  console.log(`[DIAG-DATAS][shopee/vendas] req #${_reqid} recebida`, {
    querystringCompleta: request.url,
    dateFrom, dateTo, dateField, forceSync, hoje,
    rangeInvalido: dateFrom > dateTo,
  });

  // RESTAURADO em 2026-07-13 (ver docs/DECISIONS.md, feature flag
  // ENABLE_ASYNC_SYNC_JOBS): tinha sido removido em 2026-07-11 assumindo que
  // o novo fluxo (sync_jobs + worker) substituiria este sync inline. Como a
  // ativação em produção do fluxo novo ficou condicionada a existir um
  // processador permanente de jobs (ainda não existe), o botão Sincronizar
  // em produção precisa continuar usando exatamente este caminho enquanto
  // ENABLE_ASYNC_SYNC_JOBS=false. O front só envia ?sync=1 quando a flag
  // está desligada (ver app/(app)/vendas/page.tsx, lerMarketplace).
  // Etapa 4.3 (2026-07-29, proteção imediata do recálculo inline) — nunca
  // pular o recálculo do resumo em silêncio: quando o sync ocorre, o
  // resultado (resumo atualizado ou adiado) é sempre exposto na resposta
  // desta rota via os campos abaixo. null = nenhum sync foi disparado nesta
  // leitura (cache já estava fresco, ou fora do range de hoje).
  let resumoSyncInfo: {
    sync_concluido: boolean;
    resumo_atualizado: boolean;
    resumo_pendente: boolean;
    dias_afetados: number;
    resumo_motivo: string | null;
  } | null = null;

  try {
    if (forceSync) {
      // Botão Sincronizar (fluxo antigo): sincroniza ontem + hoje (máx 2 dias, cabe em 55s)
      const ontem = new Date(Date.now() - 3 * 60 * 60 * 1000);
      ontem.setDate(ontem.getDate() - 1);
      const ontemISO = ontem.toISOString().split("T")[0];
      const syncFrom = dateFrom > ontemISO ? dateFrom : ontemISO;
      const r = await syncShopeeForUserV2(userId, syncFrom, hoje, true); // noBuffer=true → create_time
      resumoSyncInfo = {
        sync_concluido: true,
        resumo_atualizado: r.resumoAtualizado,
        resumo_pendente: r.resumoPendente,
        dias_afetados: r.diasAfetados,
        resumo_motivo: r.motivoResumoPendente,
      };
    } else if (dateFrom <= hoje && hoje <= dateTo) {
      // Auto: só sincroniza hoje se stale.
      // 2026-08-18: a sonda usava a coluna legada `data`, que não é nenhuma das
      // duas dimensões oficiais (ver BUSINESS_RULES.md, "Arquitetura de três
      // datas"). Passa a perguntar pelas duas dimensões reais: "quando gravamos
      // pela última vez uma linha que pertence a hoje", seja por criação, seja
      // por pagamento. Sem linha de hoje ainda → lastSync=0 → sincroniza.
      const { data: probeHoje } = await supabase
        .from("pedidos").select("synced_at")
        .eq("user_id", userId).eq("marketplace", "Shopee")
        .or(`data_criacao.eq.${hoje},data_pagamento.eq.${hoje}`)
        .order("synced_at", { ascending: false }).limit(1);

      const lastSyncHoje = probeHoje?.[0]?.synced_at
        ? new Date(probeHoje[0].synced_at).getTime() : 0;

      const staleMinutos = (Date.now() - lastSyncHoje) / 60000;
      console.log(`[DIAG-DATAS][shopee/vendas] req #${_reqid} range inclui hoje — checando staleness`, {
        lastSyncHoje: lastSyncHoje ? new Date(lastSyncHoje).toISOString() : null, staleMinutos,
        vaiSincronizar: Date.now() - lastSyncHoje > 30 * 60 * 1000,
      });
      if (Date.now() - lastSyncHoje > 30 * 60 * 1000) {
        console.log(`[DIAG-DATAS][shopee/vendas] req #${_reqid} disparando auto-sync de hoje (stale)`);
        // 2026-08-18: noBuffer=false -> janela de BUSCA por update_time.
        // Antes era noBuffer=true (create_time), e por isso um pedido criado
        // ontem e pago hoje NÃO era buscado — o Dashboard filtra por
        // data_pagamento, então ele simplesmente não aparecia em "Hoje".
        // Pagamento altera update_time, então update_time captura os dois casos
        // (criado hoje e criado antes/pago hoje). A CLASSIFICAÇÃO da linha
        // continua vindo do pay_time do próprio pedido (data_pagamento), nunca
        // da janela de busca — busca e exibição são dimensões separadas.
        const r = await syncShopeeForUserV2(userId, hoje, hoje, false); // noBuffer=false -> update_time
        resumoSyncInfo = {
          sync_concluido: true,
          resumo_atualizado: r.resumoAtualizado,
          resumo_pendente: r.resumoPendente,
          dias_afetados: r.diasAfetados,
          resumo_motivo: r.motivoResumoPendente,
        };
        console.log(`[DIAG-DATAS][shopee/vendas] req #${_reqid} auto-sync de hoje concluido`);
      }
    }
  } catch (syncErr) {
    console.error("[shopee/vendas] sync error:", syncErr instanceof Error ? syncErr.message : syncErr);
    console.log(`[DIAG-DATAS][shopee/vendas] req #${_reqid} SYNC FALHOU (capturado, segue lendo cache)`, {
      erro: syncErr instanceof Error ? syncErr.message : String(syncErr),
    });
    resumoSyncInfo = {
      sync_concluido: false,
      resumo_atualizado: false,
      resumo_pendente: false,
      dias_afetados: 0,
      resumo_motivo: "SYNC_FALHOU",
    };
    // Não retorna erro - lê do cache mesmo que sync falhe
  }

  // Lê do banco (range completo - pode ser cache do cron ou Histórico)
  // Fase C (2026-07-06): filtro por date_field.
  // - "pagamento" (padrão, visão financeira): filtra por data_pagamento. Pedidos
  //   com data_pagamento NULL só entram via fallback legado (coluna `data`) se
  //   TAMBÉM tiverem data_criacao NULL - isso restringe o fallback a pedidos
  //   sincronizados antes da Fase B (nunca tocados pelo código novo). Pedidos
  //   pós-Fase-B genuinamente não pagos (data_criacao preenchido, data_pagamento
  //   NULL por não terem pagamento) NÃO caem no fallback e ficam de fora da
  //   visão financeira - por decisão explícita de arquitetura, sem exceção.
  // - "criacao" (visão operacional): filtra por data_criacao, com fallback para
  //   `data` legada quando data_criacao é NULL (pedido pré-Fase-B).
  //
  // Fase E (2026-07-07): CORREÇÃO DE TRUNCAMENTO - confirmado matematicamente
  // (debug rows_length_from_select_star=1000 vs db_row_count_exact=7136) que o
  // Supabase/PostgREST corta silenciosamente qualquer .select() sem .range() no
  // limite padrão de linhas do projeto (db-max-rows). A query abaixo agora busca
  // em páginas de PAGE_SIZE via .range(), até uma página vir incompleta - mesmos
  // filtros de sempre, só que sem depender do limite implícito do PostgREST.
  function buildPedidosQuery(selectArg: string, opts?: { count?: "exact"; head?: boolean }) {
    let q = supabase
      .from("pedidos")
      .select(selectArg, opts as any)
      .eq("user_id", userId)
      .eq("marketplace", "Shopee");

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
  const MAX_PAGES = 50; // guarda de seguranca: ate 50.000 linhas
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
    const to = from + PAGE_SIZE - 1;
    // Desempate por "id" (2026-07-13, ver docs/BUGS.md): "data" tem milhares
    // de linhas empatadas, e sem uma chave única de desempate o Postgres/
    // PostgREST não garante ordem estável entre chamadas de paginação
    // sucessivas — confirmado que id é único e NOT NULL em toda a tabela.
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
      console.log(`[DIAG-DATAS][shopee/vendas] req #${_reqid} pagina ${page} tentativa ${tentativa}`, {
        marketplace: "Shopee", from, to,
        linhasRetornadas: pageData?.length ?? 0,
        totalAcumuladoAntes: pedidos.length,
        erro: pageErr?.message ?? null,
        tempoMsDaPagina: Date.now() - _pagMs,
      });

      if (!pageErr) break; // sucesso nesta tentativa — sai do loop de retry

      console.error(`[shopee/vendas] erro na pagina ${page} (tentativa ${tentativa}/3)`, pageErr.message);
      if (tentativa < 3) {
        const espera = RETRY_BACKOFF_MS[tentativa - 1];
        console.log(`[DIAG-DATAS][shopee/vendas] req #${_reqid} pagina ${page} nova tentativa em ${espera}ms`, {
          marketplace: "Shopee", proximaTentativa: tentativa + 1,
        });
        await new Promise(resolve => setTimeout(resolve, espera));
      }
    }

    if (pageErr) {
      // Persistiu erro após as 3 tentativas — não é fim normal da paginação.
      paginacaoFalhou = true;
      paginaQueFalhou = page;
      erroResumido = pageErr.message ?? String(pageErr);
      console.log(`[DIAG-DATAS][shopee/vendas] req #${_reqid} PAGINACAO FALHOU DEFINITIVAMENTE na pagina ${page} apos 3 tentativas`, {
        marketplace: "Shopee", totalAcumulado: pedidos.length, erro: erroResumido,
      });
      break;
    }
    if (!pageData || pageData.length === 0) {
      console.log(`[DIAG-DATAS][shopee/vendas] req #${_reqid} SAIU DO LOOP por pagina vazia (${page})`, {
        totalAcumulado: pedidos.length,
      });
      break;
    }
    pedidos = pedidos.concat(pageData);
    if (pageData.length < PAGE_SIZE) {
      console.log(`[DIAG-DATAS][shopee/vendas] req #${_reqid} SAIU DO LOOP por pagina curta (${page}, ${pageData.length} < ${PAGE_SIZE})`, {
        totalAcumulado: pedidos.length,
      });
      break; // ultima pagina (veio incompleta)
    }
    if (page === MAX_PAGES - 1) {
      console.log(`[DIAG-DATAS][shopee/vendas] req #${_reqid} ATINGIU MAX_PAGES (${MAX_PAGES}) — pode haver mais dados nao lidos`, {
        totalAcumulado: pedidos.length,
      });
    }
  }
  console.log(`[DIAG-DATAS][shopee/vendas] req #${_reqid} paginacao concluida`, {
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
    console.log(`[DIAG-DATAS][shopee/vendas] req #${_reqid} RESPOSTA (incompleto)`, {
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
      lojaId: loja.lojaId,
      conta: loja.nickname ?? "Shopee",
      ...(resumoSyncInfo ?? {}),
    });
  }

  if (!pedidos || pedidos.length === 0) {
    // [DIAG-DATAS] temporário — remover após a auditoria
    console.log(`[DIAG-DATAS][shopee/vendas] req #${_reqid} RESPOSTA (semDados)`, {
      dateFrom, dateTo, dateField, totalPedidos: 0, rows: 0,
      tempoMs: Date.now() - _inicioMs,
    });
    return NextResponse.json({
      semDados: true,
      conta: loja.nickname ?? "Shopee",
      lojaId: loja.lojaId,
      dateFrom,
      dateTo,
      dateField,
      totalPedidos: 0,
      rows: [],
      ...(resumoSyncInfo ?? {}),
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

  const conta       = pedidos[0]?.conta ?? loja.nickname ?? "Shopee";
  // P5 FIX: contar apenas pedidos pagos (igual ao pedidosUnicos da página vendas)
  const totalOrders = new Set(rows.filter(r => r.status === 'paid').map(r => r.orderId)).size;

  // [DIAG-DATAS] temporário — remover após a auditoria
  console.log(`[DIAG-DATAS][shopee/vendas] req #${_reqid} RESPOSTA`, {
    dateFrom, dateTo, dateField, totalPedidos: totalOrders, rows: rows.length,
    tempoMs: Date.now() - _inicioMs,
  });

  return NextResponse.json({
    dateFrom,
    dateTo,
    dateField,
    conta,
    lojaId: loja.lojaId,
    totalPedidos: totalOrders,
    rows,
    ...(resumoSyncInfo ?? {}),
  });
}
