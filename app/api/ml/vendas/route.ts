/**
 * GET /api/ml/vendas
 * Lê da tabela `pedidos` (cache). Se não houver dados ou estiver stale, faz sync on-demand.
 * O cron /api/sync mantém os últimos 7 dias sempre frescos.
 */
import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseServidor } from "@/lib/estudio-anuncios/supabase-servidor";
import { autenticarRequisicao } from "@/lib/autenticacao";
import { syncMLForUser, type LojaMLResolvida } from "@/lib/sync-ml";
import { resolverContaML } from "@/lib/ml-conexao";
import { LOJA_ML_INVALIDA, ML_STORE_SELECTION_REQUIRED, respostaSelecaoLojaML } from "@/lib/ml-loja-catalogo";
import { carregarMapaCustoProduto, financeiroDaVenda, identidadeDaVenda, resolverCustoProduto } from "@/lib/vendas/custo-produto";
import { lerFinanceiroRealML } from "@/lib/vendas/ml-financeiro-leitura";
import { candidatosRecuperacaoFinanceiraML } from "@/lib/vendas/ml-financeiro";
import { metricasBrutasML, type MetricasBrutasML } from "@/lib/vendas/metricas-ml";

// SEC-3-B1: dados sensiveis (SEC-3) so por service_role, server-side.
// O cliente nasce sob demanda — nunca no import — a partir do helper
// oficial; o isolamento por dono e da propria rota, nao do banco.
let clienteServidor: SupabaseClient | null = null;
function supabase(): SupabaseClient {
  return (clienteServidor ??= getSupabaseServidor());
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
  // CDS V2 Vendas A5: a loja vem do PEDIDO (`?loja_id`), validada no servidor (dono + ML + ativa) — sem
  // cookie, sem "a única" e sem outra loja como fallback. Sem `loja_id`: SÓ a loja ML única (opt-in);
  // 2+ lojas → 409 ML_STORE_SELECTION_REQUIRED com as lojas do próprio dono, antes de qualquer leitura
  // de `pedidos` ou chamada ao provider. Loja pedida inválida (de outro dono, Shopee, inativa,
  // malformada) → 404 LOJA_ML_INVALIDA. O cookie `loja_ativa_id` não é identidade desta rota.
  const lojaPedida = url.searchParams.get("loja_id");
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
  const lojaML: LojaMLResolvida | null = contaML.ok
    ? { lojaId: contaML.lojaId, accessToken: contaML.accessToken, sellerId: contaML.sellerId, nickname: contaML.nickname }
    : null;
  const lojaId = lojaML?.lojaId ?? null;
  // CDS V2 Vendas A2: a loja que ESTA leitura representa — toda consulta de `pedidos` abaixo
  // (cache, frescor, página) leva user_id + ML + loja_id. Credencial vencida (PRECISA_RECONECTAR)
  // ainda identifica a loja: o cache dela é servido, sem sync, como antes. Sem loja resolvida
  // (sem conta ML ativa, ou contexto inválido) não existe leitura escopada: falha fechado —
  // nunca o cache do dono inteiro, nunca "a primeira/mais recente".
  const lojaLeitura: string | null = contaML.ok
    ? contaML.lojaId
    : contaML.motivo === "PRECISA_RECONECTAR" ? contaML.loja.id : null;
  if (!lojaLeitura) {
    return NextResponse.json({ erro: true, semConexao: true, mensagem: "Conta do Mercado Livre não conectada." });
  }

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
  const { data: probe } = await supabase()
    .from("pedidos")
    .select("synced_at")
    .eq("user_id", userId)
    .eq("marketplace", "ML")
    .eq("loja_id", lojaLeitura)
    .gte("data", dateFrom)
    .lte("data", dateTo)
    .order("synced_at", { ascending: false })
    .limit(1);

  const hasData = probe && probe.length > 0;
  const hoje    = hojeISO();

  // Sem conta ML resolvida E sem cache → ML não conectada
  if (!lojaML && !hasData) {
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
  // A3.2-F: esta requisição executou um sync ML (que já tentou o financeiro das vendas gravadas)? A tela então NÃO
  // dispara a recuperação financeira em seguida na mesma carga — uma única fonte de trabalho financeiro no provider.
  let financeiroTentadoNoSync = false;
  try {
    if (forceSync) {
      // Botão Sincronizar (fluxo antigo): re-sincroniza o range inteiro
      await (lojaML && syncMLForUser(userId, dateFrom, dateTo, undefined, false, lojaML));
      financeiroTentadoNoSync = !!lojaML;
    } else if (!hasData) {
      // Sem cache: sync completo (primeira vez)
      await (lojaML && syncMLForUser(userId, dateFrom, dateTo, undefined, false, lojaML));
      financeiroTentadoNoSync = !!lojaML;
    } else {
      // Tem cache: só atualiza hoje se o range inclui hoje (barato, 1 dia)
      const rangeIncludeHoje = dateFrom <= hoje && hoje <= dateTo;
      if (rangeIncludeHoje) {
        const { data: probeHoje } = await supabase()
          .from("pedidos").select("synced_at")
          .eq("user_id", userId).eq("marketplace", "ML").eq("loja_id", lojaLeitura)
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
          await (lojaML && syncMLForUser(userId, hoje, hoje, undefined, false, lojaML));
          financeiroTentadoNoSync = !!lojaML;
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
    opts?: { count?: "exact"; head?: boolean },
    campo: typeof dateField = dateField,   // A3.3: as métricas brutas ML usam SEMPRE "criacao"
  ) {
    let q = supabase()
      .from("pedidos")
      .select(selectArg, opts as any)
      .eq("user_id", userId)
      .eq("marketplace", "ML")
      .eq("loja_id", lojaLeitura);

    if (campo === "pagamento") {
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

  // Vendas A3.3: VENDAS BRUTAS ML — SEMPRE pela data de CRIAÇÃO (semântica do painel do ML, auditada), qualquer que seja
  // o date_field da tela; loja inteira (filtros de SKU/status/envio da tela não se aplicam). Com date_field=criacao as
  // linhas já lidas são a janela certa; senão, uma leitura paginada só das colunas da métrica. Falha → null (sem card).
  let metricasML: (MetricasBrutasML & { base: "criacao" }) | null = null;
  try {
    let linhasCriacao: any[] = dateField === "criacao" ? pedidos : [];
    for (let page = 0; dateField !== "criacao" && page < MAX_PAGES; page++) {
      const { data, error } = await buildPedidosQuery("order_id, status, qtd, faturamento", undefined, "criacao")
        .order("id", { ascending: true })
        .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1);
      if (error) throw new Error(error.message);
      linhasCriacao = linhasCriacao.concat(data ?? []);
      if ((data ?? []).length < PAGE_SIZE) break;
    }
    metricasML = { base: "criacao", ...metricasBrutasML(linhasCriacao) };
  } catch (e) {
    console.error(`[ml/vendas] métricas brutas ML indisponíveis: ${e instanceof Error ? e.message : e}`);
  }

  // Vendas A3: custo do produto AO VIVO de Meus Produtos (UMA leitura paginada da loja, sem `ativo`).
  // `financeiro` é LIVE_CALCULATED; `custo`/`imposto`/`margemContrib`/`cadastrado` da linha seguem
  // LEGADOS (persistidos na sync) para quem ainda os lê — a tela de Vendas usa `financeiro`.
  const mapaCusto = await carregarMapaCustoProduto(supabase(), userId, "ML", lojaLeitura);
  // Vendas A3.2-B: financeiro REAL do ML (pedido + envio) — só LEITURA do banco, da mesma loja; o provider é
  // chamado pelo coletor (job), nunca aqui. `packId` vira o código da venda exibido (pack_id ?? order_id).
  const financeiroML = await lerFinanceiroRealML(supabase(), userId, lojaLeitura, (pedidos ?? []).map((p: any) => String(p.order_id)));
  let rows = (pedidos ?? []).map((p: any) => ({
    ...pedidoToRow(p),
    packId: financeiroML.get(String(p.order_id))?.pedido.pack_id ?? null,
    financeiro: mapaCusto.ok ? financeiroDaVenda(p, resolverCustoProduto(mapaCusto.mapa, identidadeDaVenda(p)), financeiroML.get(String(p.order_id)) ?? null) : null,
  }));

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
    custoLiveDisponivel: mapaCusto.ok,
    // Vendas A3.3: VENDAS BRUTAS ML (criação, inclui canceladas, sem pack_splitted) + canceladas — ver lib/vendas/metricas-ml.ts
    metricasML,
    // Vendas A3.2-C.2: QUANTAS vendas pagas desta janela/loja precisam de recuperação financeira (sem linha
    // financeira ou com linha pendente) — só leitura do banco, só a contagem. A tela pede a recuperação em
    // POST /api/ml/vendas/financeiro com o CONTEXTO da janela; o servidor seleciona os pedidos (nunca aqui).
    financeiroTentadoNoSync,
    financeiroPendente: candidatosRecuperacaoFinanceiraML((pedidos ?? []).map((p: any) => ({ order_id: String(p.order_id), status: p.status, data: p.data, data_pagamento: p.data_pagamento, data_criacao: p.data_criacao })), financeiroML, { de: dateFrom, ate: dateTo, campo: dateField }).length,
  });
}
