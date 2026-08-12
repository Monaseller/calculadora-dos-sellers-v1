/**
 * lib/resumos-diarios.ts
 *
 * Recálculo incremental da tabela `dashboard_resumos_diarios` (aprovado
 * 2026-07-10). Ver supabase/migrations/20260710_dashboard_resumos_diarios.sql
 * e docs/ROADMAP.md "Fase 4 — Arquitetura de performance".
 *
 * Regras que este arquivo obedece (aprovadas 2026-07-10, não renegociar
 * silenciosamente):
 *   - `dashboard_resumos_diarios` NUNCA é fonte de verdade — todo valor
 *     gravado aqui é 100% derivável de `pedidos`. Este arquivo só lê
 *     `pedidos` e agrega; nunca inventa dado que não exista lá.
 *   - Recálculo é sempre do dia INTEIRO, do zero (nunca incremental / soma
 *     em cima do valor existente). UPSERT substitui a linha completamente.
 *   - Nunca recalcular período inteiro sem necessidade — quem decide quais
 *     dias foram afetados é o chamador (sync, reconciliação); esta função
 *     só recalcula os dias que recebe.
 *   - Fórmulas idênticas às já usadas em app/(app)/dashboard/page.tsx (KPIs
 *     de faturamento/lucro/margem/ticket médio) — nenhuma fórmula nova.
 *
 * Fase 1 (2026-07-24, ver docs/DECISIONS.md "Estratégia A — dashboard por
 * agregações"): chave de identidade passa a ser `loja_id` (estável), não
 * mais `marketplace+conta` (conta/nickname pode ser renomeada no
 * marketplace). marketplace/conta continuam recebidos e gravados na linha
 * como campos de exibição, só não são mais usados para filtrar `pedidos`.
 * `unidades` = soma de `qtd`; `tarifa_venda` = soma direta da coluna já
 * resolvida em `pedidos` (mesmo valor que o Dashboard soma hoje como
 * Σ r.tarifaVenda) — não reconstruir a partir de commission_fee/service_fee/
 * transaction_fee/campaign_fee, que subestimam pedidos não reconciliados.
 */
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

export type TipoData = "pagamento" | "criacao";

interface PedidoRowParaResumo {
  order_id:            string;
  status:              string;
  qtd:                  number | null;
  item_subtotal:        number | null;
  faturamento:          number | null;
  buyer_paid_amount:    number | null;
  escrow_amount:        number | null;
  commission_fee:       number | null;
  service_fee:          number | null;
  transaction_fee:      number | null;
  campaign_fee:         number | null;
  voucher_from_seller:  number | null;
  voucher_from_shopee:  number | null;
  custo:                number | null;
  imposto:              number | null;
  frete_comprador:      number | null;
  frete_vendedor:       number | null;
  margem_contrib:       number | null;
  tarifa_venda:         number | null;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Busca todos os pedidos (linhas por item) de um dia exato, paginando via
 * .range() — mesmo padrão já usado em app/api/shopee/vendas/route.ts, pra
 * não repetir o truncamento silencioso do PostgREST em selects grandes
 * (bug real já corrigido nessa rota, ver docs/CHANGELOG.md 2026-07-07 a 09).
 *
 * Filtro por loja_id (Fase 1, 2026-07-24) — não mais marketplace+conta.
 * loja_id é a chave de identidade estável (conta/nickname pode ser
 * renomeada no marketplace, loja_id nunca muda; ver docs/DECISIONS.md
 * "loja_id como referência principal"). marketplace/conta continuam sendo
 * gravados no resumo como campos de exibição, só não são mais usados como
 * filtro aqui — quem sabe marketplace/conta é o chamador.
 */
async function buscarPedidosDoDia(
  userId: string, lojaId: string,
  tipoData: TipoData, dataReferencia: string
): Promise<PedidoRowParaResumo[]> {
  const campoData = tipoData === "pagamento" ? "data_pagamento" : "data_criacao";
  const PAGE_SIZE = 1000;
  const MAX_PAGES = 50; // guarda de seguranca: ate 50.000 linhas no dia
  let linhas: PedidoRowParaResumo[] = [];

  for (let page = 0; page < MAX_PAGES; page++) {
    const from = page * PAGE_SIZE;
    const to = from + PAGE_SIZE - 1;
    const { data, error } = await supabase
      .from("pedidos")
      .select(
        "order_id, status, qtd, item_subtotal, faturamento, buyer_paid_amount, escrow_amount, " +
        "commission_fee, service_fee, transaction_fee, campaign_fee, voucher_from_seller, " +
        "voucher_from_shopee, custo, imposto, frete_comprador, frete_vendedor, margem_contrib, tarifa_venda"
      )
      .eq("user_id", userId)
      .eq("loja_id", lojaId)
      .eq(campoData, dataReferencia)
      .range(from, to);

    if (error) {
      throw new Error(`[resumos-diarios] erro ao buscar pedidos de ${dataReferencia} (${tipoData}): ${error.message}`);
    }
    if (!data || data.length === 0) break;
    linhas = linhas.concat(data as unknown as PedidoRowParaResumo[]);
    if (data.length < PAGE_SIZE) break;
  }
  return linhas;
}

/**
 * Recalcula do zero o resumo de UM dia — nunca incremental, sempre
 * substitui o dia inteiro (regra aprovada 2026-07-10). Fórmulas idênticas
 * às já usadas em app/(app)/dashboard/page.tsx.
 */
export async function atualizarResumoDia(
  userId: string, lojaId: string, marketplace: string, conta: string,
  tipoData: TipoData, dataReferencia: string
): Promise<void> {
  const linhas = await buscarPedidosDoDia(userId, lojaId, tipoData, dataReferencia);

  const pedidosTotal      = new Set(linhas.map(r => r.order_id)).size;
  const pagos             = linhas.filter(r => r.status === "paid");
  const pedidosPagos      = new Set(pagos.map(r => r.order_id)).size;
  const pedidosCancelados = new Set(linhas.filter(r => r.status === "cancelled").map(r => r.order_id)).size;
  const pedidosDevolvidos = new Set(linhas.filter(r => r.status === "devolucao").map(r => r.order_id)).size;

  // Regra P-FAT (já vigente em app/api/shopee/vendas/route.ts): faturamento
  // exibido = item_subtotal quando > 0, senão fallback para faturamento
  // (total_amount) — nenhuma fórmula nova.
  const somaFaturamento = pagos.reduce((s, r) => {
    const itemSubtotal = Number(r.item_subtotal) || 0;
    const fat = itemSubtotal > 0 ? itemSubtotal : (Number(r.faturamento) || 0);
    return s + fat;
  }, 0);
  const somaFaturamentoBruto = pagos.reduce((s, r) => s + (Number(r.faturamento) || 0), 0);
  const somaBuyerPaid        = pagos.reduce((s, r) => s + (Number(r.buyer_paid_amount) || 0), 0);
  const somaEscrow           = pagos.reduce((s, r) => s + (Number(r.escrow_amount) || 0), 0);
  const somaCommission       = pagos.reduce((s, r) => s + (Number(r.commission_fee) || 0), 0);
  const somaService          = pagos.reduce((s, r) => s + (Number(r.service_fee) || 0), 0);
  const somaTransaction      = pagos.reduce((s, r) => s + (Number(r.transaction_fee) || 0), 0);
  const somaCampaign         = pagos.reduce((s, r) => s + (Number(r.campaign_fee) || 0), 0);
  const somaVoucherSeller    = pagos.reduce((s, r) => s + (Number(r.voucher_from_seller) || 0), 0);
  const somaVoucherShopee    = pagos.reduce((s, r) => s + (Number(r.voucher_from_shopee) || 0), 0);
  const somaCusto            = pagos.reduce((s, r) => s + (Number(r.custo) || 0), 0);
  const somaImposto          = pagos.reduce((s, r) => s + (Number(r.imposto) || 0), 0);
  const somaFrete            = pagos.reduce((s, r) => s + (Number(r.frete_comprador) || 0) + (Number(r.frete_vendedor) || 0), 0);
  const somaLucro            = pagos.reduce((s, r) => s + (Number(r.margem_contrib) || 0), 0);
  // Fase 1 (2026-07-24): unidades = soma de qtd; tarifa_venda = soma direta
  // da coluna já resolvida em pedidos (oficial ou estimada) — mesmo campo
  // que o Dashboard hoje soma como Σ r.tarifaVenda. Nenhuma fórmula nova.
  const somaUnidades         = pagos.reduce((s, r) => s + (Number(r.qtd) || 0), 0);
  const somaTarifaVenda      = pagos.reduce((s, r) => s + (Number(r.tarifa_venda) || 0), 0);

  // Razão de somas, não média de percentuais — mesma regra do Dashboard hoje.
  const margemContribuicao = somaFaturamento > 0 ? (somaLucro / somaFaturamento) * 100 : 0;
  const ticketMedio        = pedidosPagos > 0 ? somaFaturamento / pedidosPagos : 0;

  const { error: upsertErr } = await supabase
    .from("dashboard_resumos_diarios")
    .upsert({
      user_id:              userId,
      loja_id:              lojaId,
      marketplace,
      conta,
      tipo_data:            tipoData,
      data_referencia:      dataReferencia,
      pedidos_total:        pedidosTotal,
      pedidos_pagos:        pedidosPagos,
      pedidos_cancelados:   pedidosCancelados,
      pedidos_devolvidos:   pedidosDevolvidos,
      faturamento:          round2(somaFaturamento),
      faturamento_bruto:    round2(somaFaturamentoBruto),
      buyer_paid_amount:    round2(somaBuyerPaid),
      escrow_amount:        round2(somaEscrow),
      commission_fee:       round2(somaCommission),
      service_fee:          round2(somaService),
      transaction_fee:      round2(somaTransaction),
      campaign_fee:         round2(somaCampaign),
      voucher_from_seller:  round2(somaVoucherSeller),
      voucher_from_shopee:  round2(somaVoucherShopee),
      custo:                round2(somaCusto),
      imposto:              round2(somaImposto),
      frete:                round2(somaFrete),
      lucro:                round2(somaLucro),
      margem_contribuicao:  round2(margemContribuicao),
      ticket_medio:         round2(ticketMedio),
      unidades:             somaUnidades,
      tarifa_venda:         round2(somaTarifaVenda),
      updated_at:           new Date().toISOString(),
    }, { onConflict: "user_id,loja_id,tipo_data,data_referencia" });

  if (upsertErr) {
    throw new Error(
      `[resumos-diarios] erro ao gravar resumo (loja_id=${lojaId}, ${marketplace}/${conta}/${tipoData}/${dataReferencia}): ${upsertErr.message}`
    );
  }
}

/**
 * Conveniência: recalcula vários dias de uma vez, separadamente para
 * data_pagamento e data_criacao. Quem decide "quais dias foram afetados"
 * é o chamador (sync, reconciliação) — esta função nunca varre um período
 * inteiro por conta própria (regra aprovada 2026-07-10).
 */
export async function atualizarResumosDosDias(
  userId: string, lojaId: string, marketplace: string, conta: string,
  datasPagamento: string[], datasCriacao: string[]
): Promise<void> {
  const pagamentoUnicos = Array.from(new Set(datasPagamento.filter(Boolean)));
  const criacaoUnicos   = Array.from(new Set(datasCriacao.filter(Boolean)));

  for (const d of pagamentoUnicos) {
    await atualizarResumoDia(userId, lojaId, marketplace, conta, "pagamento", d);
  }
  for (const d of criacaoUnicos) {
    await atualizarResumoDia(userId, lojaId, marketplace, conta, "criacao", d);
  }
}
