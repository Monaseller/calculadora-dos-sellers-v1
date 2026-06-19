/**
 * Comissões e taxas da Shopee Brasil — 2026
 * Vigência: a partir de 1º de março de 2026
 * Fonte: Comunicado Oficial Shopee + irroba.com.br + vendedorlucrativo.com.br
 *
 * Estrutura de cobrança por venda:
 *   1. Comissão percentual (por faixa de preço)
 *   2. Taxa fixa por item (por faixa de preço)
 *   3. Taxa de campanha: 2,5% (obrigatória em todos os produtos)
 *
 * CPF com mais de 450 pedidos em 90 dias paga R$ 3,00 a mais na taxa fixa.
 */

export type TipoContaShopee = "CNPJ" | "CPF";

export interface FaixaShopee {
  label: string;      // descrição da faixa
  min: number;        // preço mínimo inclusive
  max: number;        // preço máximo exclusive (Infinity = sem limite)
  comissao: number;   // percentual decimal (ex: 0.20 = 20%)
  taxaFixaCnpj: number; // R$ por item — CNPJ
  taxaFixaCpf: number;  // R$ por item — CPF (CNPJ + R$ 3,00)
}

export const FAIXAS_SHOPEE: FaixaShopee[] = [
  { label: "Até R$ 79,99",        min: 0,   max: 80,       comissao: 0.20, taxaFixaCnpj: 4,  taxaFixaCpf: 7  },
  { label: "R$ 80 a R$ 99,99",    min: 80,  max: 100,      comissao: 0.14, taxaFixaCnpj: 16, taxaFixaCpf: 19 },
  { label: "R$ 100 a R$ 199,99",  min: 100, max: 200,      comissao: 0.14, taxaFixaCnpj: 20, taxaFixaCpf: 23 },
  { label: "R$ 200 a R$ 499,99",  min: 200, max: 500,      comissao: 0.14, taxaFixaCnpj: 26, taxaFixaCpf: 29 },
  { label: "Acima de R$ 500",     min: 500, max: Infinity,  comissao: 0.14, taxaFixaCnpj: 28, taxaFixaCpf: 31 },
];

/** Taxa de campanha obrigatória em todos os produtos (2,5%) */
export const TAXA_CAMPANHA_SHOPEE = 0.025;

/** Retorna a faixa de comissão para um dado preço de venda */
export function obterFaixaShopee(preco: number): FaixaShopee {
  return FAIXAS_SHOPEE.find((f) => preco >= f.min && preco < f.max) ?? FAIXAS_SHOPEE[0];
}

export type ResultadoShopee = {
  valido: true;
  precoIdeal: number;
  comissaoPercentual: number;
  comissaoValor: number;
  taxaFixaValor: number;
  taxaCampanhaValor: number;
  impostoValor: number;
  lucroValor: number;
  faixa: FaixaShopee;
  cp: number;
  ins: number;
  cf: number;
} | {
  valido: false;
  motivo: string;
};

/**
 * Calcula o preço ideal de venda na Shopee a partir dos custos.
 *
 * Fórmula (por faixa):
 *   P = (custoProduto + insumos + custoFrete + taxaFixa) /
 *       (1 - comissao - taxaCampanha - imposto - margem)
 *
 * Como a taxaFixa e a comissão dependem da faixa, que depende de P,
 * testamos cada faixa e verificamos se P resultante pertence à faixa.
 */
export function calcularPrecoIdealShopee(params: {
  custoProduto: number;
  insumos: number;
  custoFrete: number;
  impostoPercentual: number;
  margemDesejadaPercentual: number;
  tipoConta: TipoContaShopee;
}): ResultadoShopee {
  const { custoProduto, insumos, custoFrete, impostoPercentual, margemDesejadaPercentual, tipoConta } = params;
  const imp = impostoPercentual / 100;
  const mg = margemDesejadaPercentual / 100;
  const totalCustoVariavel = custoProduto + insumos + custoFrete;

  for (const faixa of FAIXAS_SHOPEE) {
    const tf = tipoConta === "CPF" ? faixa.taxaFixaCpf : faixa.taxaFixaCnpj;
    const denom = 1 - faixa.comissao - TAXA_CAMPANHA_SHOPEE - imp - mg;

    if (denom <= 0) continue; // inviável nessa faixa

    const precoIdeal = (totalCustoVariavel + tf) / denom;

    // Verifica se o preço calculado pertence de fato a esta faixa
    if (precoIdeal >= faixa.min && precoIdeal < faixa.max) {
      const comissaoValor      = precoIdeal * faixa.comissao;
      const taxaCampanhaValor  = precoIdeal * TAXA_CAMPANHA_SHOPEE;
      const impostoValor       = precoIdeal * imp;
      const lucroValor         = precoIdeal * mg;

      return {
        valido: true,
        precoIdeal,
        comissaoPercentual: faixa.comissao,
        comissaoValor,
        taxaFixaValor: tf,
        taxaCampanhaValor,
        impostoValor,
        lucroValor,
        faixa,
        cp: custoProduto,
        ins: insumos,
        cf: custoFrete,
      };
    }
  }

  return {
    valido: false,
    motivo: "Nenhuma faixa de preço consistente. Verifique se imposto + margem não ultrapassam o limite.",
  };
}
