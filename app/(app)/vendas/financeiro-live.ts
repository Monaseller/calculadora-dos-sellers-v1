/**
 * Vendas — exibição do financeiro AO VIVO (Vendas A3). Puro (sem React): a tela e os testes usam as
 * mesmas funções.
 *
 * A tela mostra custo, imposto, lucro e margem SÓ de `financeiro` (LIVE_CALCULATED, custo de Meus
 * Produtos). Os campos legados da linha (`custo`, `margemContrib`, `cadastrado`, frete do anúncio) não
 * são exibidos. Venda sem custo continua na lista e nos totais de receita; o que depende de custo ou de
 * frete fica PENDENTE — nunca vira 0.
 */
import type { FinanceiroVendaLive } from "@/lib/vendas/custo-produto-tipos";

export const TEXTO_STATUS_CUSTO = {
  PRODUCT_FOUND_WITHOUT_COST: "Custo não cadastrado",
  PRODUCT_NOT_FOUND: "Produto não vinculado",
  PRODUCT_IDENTITY_INCOMPLETE: "Identificação da variação pendente",
} as const;

/** Rota de Meus Produtos (a tela ainda não abre um produto por parâmetro — a referência exata vai em `financeiro.produto`). */
export const ROTA_MEUS_PRODUTOS = "/anuncios";

export const custoCadastradoLive = (f: FinanceiroVendaLive | null | undefined): boolean =>
  f?.custoStatus === "PRODUCT_FOUND_WITH_COST";

/** Aviso da linha: o que falta para o cálculo e para onde levar o usuário. `null` = nada a avisar. */
export function avisoCustoLive(f: FinanceiroVendaLive | null | undefined): { texto: string; href: string | null } | null {
  if (!f) return { texto: "Custo indisponível", href: null };
  if (f.custoStatus === "PRODUCT_FOUND_WITH_COST") return null;
  const texto = TEXTO_STATUS_CUSTO[f.custoStatus];
  // Só leva a Meus Produtos quando há produto (exato) ou ao menos o item; sem vínculo não há para onde levar.
  return { texto, href: f.produto ? ROTA_MEUS_PRODUTOS : null };
}

export interface TotaisLive {
  custo: number;              // soma só do custo CONHECIDO
  imposto: number;
  lucro: number;              // soma só das linhas com lucro calculável
  faturamentoCalculado: number;
  margemPct: number | null;   // lucro / faturamento das linhas calculáveis
  pendentes: number;          // linhas cujo lucro está pendente (custo do produto e/ou base financeira)
  estimados: number;          // linhas com lucro ESTIMADO (não real) dentro do total
  tarifa: number;             // tarifa da linha (ML: por unidade × qtd)
}

export function totaisLive(linhas: ReadonlyArray<{ faturamento: number; financeiro?: FinanceiroVendaLive | null }>): TotaisLive {
  const t: TotaisLive = { custo: 0, imposto: 0, lucro: 0, faturamentoCalculado: 0, margemPct: null, pendentes: 0, estimados: 0, tarifa: 0 };
  for (const r of linhas) {
    const f = r.financeiro;
    if (f?.custoProduto != null) t.custo += f.custoProduto;
    if (f?.imposto != null) t.imposto += f.imposto;
    if (f) t.tarifa += f.tarifa;
    if (f?.lucro != null) { t.lucro += f.lucro; t.faturamentoCalculado += r.faturamento; if (f.qualidadeFinanceira !== "ACTUAL") t.estimados++; }
    else t.pendentes++;
  }
  t.margemPct = t.faturamentoCalculado > 0 ? (t.lucro / t.faturamentoCalculado) * 100 : null;
  return t;
}

export const textoFreteLive = (f: FinanceiroVendaLive | null | undefined): string =>
  !f ? "—" : f.freteStatus === "incluso_no_repasse" ? "no repasse" : f.freteStatus === "nao_incluido" ? "não incluído" : f.freteStatus === "no_liquido_ml" ? "no líquido" : "pendente";

/** Vendas A3.2-B: de onde saiu o Líquido ML (tooltip) — informativo; nada aqui entra de novo na conta. */
export function detalheLiquidoML(f: FinanceiroVendaLive | null | undefined): string | null {
  const d = f?.detalheML;
  if (!f || !d) return null;
  const m = (v: number | null | undefined) => (v == null ? "—" : v.toFixed(2).replace(".", ","));
  const linhas = [
    `Tarifa ML (líquida): ${m(f.tarifa)}`,
    `Frete vendedor: ${m(f.freteVendedor)}`,
    `Frete pago pelo comprador: ${m(d.freteComprador)} (não é custo do vendedor)`,
    `Desconto do vendedor: ${m(d.descontoVendedor)} (já no preço)`,
    `Rebate ML na tarifa: ${m(d.descontoMeli)} (já na tarifa)`,
    `Billing: ${d.billing === "CONFERIDO" ? "conferido" : d.billing === "PENDENTE" ? "pendente" : d.billing === "SEM_PERMISSAO" ? "sem permissão" : "divergente"}`,
  ];
  if (d.motivo === "frete_compartilhado") linhas.push("Envio compartilhado por vários pedidos: sem rateio do Mercado Livre");
  return linhas.join("\n");
}

/** Selo do lucro: "real" (repasse reconciliado) ou "estimado"; `null` quando o lucro está pendente. */
/**
 * A3.2-F — a carga da página dispara a recuperação financeira (POST /api/ml/vendas/financeiro)? Só se: a leitura deu
 * certo, há pendentes, esta carga ainda não usou sua rodada E a resposta NÃO veio de um sync que já tentou o financeiro
 * (sync + retry em seguida dobrava as chamadas de billing e o ML respondia 429). Uma fonte por carga: SYNC ou RETRY.
 */
export function deveRecuperarFinanceiroML(r: { falhou: boolean; rodadaUsada: boolean; financeiroPendente: unknown; financeiroTentadoNoSync?: unknown }): boolean {
  return !r.falhou && !r.rodadaUsada && r.financeiroTentadoNoSync !== true && typeof r.financeiroPendente === "number" && r.financeiroPendente > 0;
}

export const seloLucroLive = (f: FinanceiroVendaLive | null | undefined): "real" | "estimado" | null =>
  f?.lucro == null ? null : f.qualidadeFinanceira === "ACTUAL" ? "real" : "estimado";
