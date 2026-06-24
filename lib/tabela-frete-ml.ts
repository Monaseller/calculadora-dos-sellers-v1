/**
 * Tabela oficial de custos de envio Mercado Livre (Mercado Envios)
 * Válida para MercadoLíder, reputação verde ou sem reputação.
 * Fonte: mercadolivre.com.br/knowledge-hub/40538
 * Inclui desconto de até 50% por reputação verde (já embutido nos valores).
 */

// Faixas de preço do anúncio (limite superior, Infinity = sem limite)
const FAIXAS_PRECO = [18.99, 48.99, 78.99, 99.99, 119.99, 149.99, 199.99, Infinity];

// Peso máximo de cada faixa (kg). A última é Infinity = "Mais de 150 kg"
const FAIXAS_PESO = [0.3, 0.5, 1, 1.5, 2, 3, 4, 5, 6, 7, 8, 9, 11, 13, 15, 17, 20, 25, 30, 40, 50, 60, 70, 80, 90, 100, 125, 150, Infinity];

// Tabela principal: cada linha = faixa de peso, cada coluna = faixa de preço
// Ordem das colunas: [0-18,99 | 19-48,99 | 49-78,99 | 79-99,99 | 100-119,99 | 120-149,99 | 150-199,99 | 200+]
const TABELA: number[][] = [
  // peso                 0-18,99  19-48,99  49-78,99  79-99,99  100-119,99  120-149,99  150-199,99  200+
  /* até 0,3 kg    */  [ 5.65,    6.55,     7.75,     12.35,    14.35,      16.45,      18.45,      20.95 ],
  /* 0,3-0,5 kg    */  [ 5.95,    6.65,     7.85,     13.25,    15.45,      17.65,      19.85,      22.55 ],
  /* 0,5-1 kg      */  [ 6.05,    6.75,     7.95,     13.85,    16.15,      18.45,      20.75,      23.65 ],
  /* 1-1,5 kg      */  [ 6.15,    6.85,     8.05,     14.15,    16.45,      18.85,      21.15,      24.65 ],
  /* 1,5-2 kg      */  [ 6.25,    6.95,     8.15,     14.45,    16.85,      19.25,      21.65,      24.65 ],
  /* 2-3 kg        */  [ 6.35,    7.95,     8.55,     15.75,    18.35,      21.05,      23.65,      26.25 ],
  /* 3-4 kg        */  [ 6.45,    8.15,     8.95,     17.05,    19.85,      22.65,      25.55,      28.35 ],
  /* 4-5 kg        */  [ 6.55,    8.35,     9.75,     18.45,    21.55,      24.65,      27.75,      30.75 ],
  /* 5-6 kg        */  [ 6.65,    8.55,     9.95,     25.45,    28.55,      32.65,      35.75,      39.75 ],
  /* 6-7 kg        */  [ 6.75,    8.75,     10.15,    27.05,    31.05,      36.05,      40.05,      44.05 ],
  /* 7-8 kg        */  [ 6.85,    8.95,     10.35,    28.85,    33.65,      38.45,      43.25,      48.05 ],
  /* 8-9 kg        */  [ 6.95,    9.15,     10.55,    29.65,    34.55,      39.55,      44.45,      49.35 ],
  /* 9-11 kg       */  [ 7.05,    9.55,     10.95,    41.25,    48.05,      54.95,      61.75,      68.65 ],
  /* 11-13 kg      */  [ 7.15,    9.95,     11.35,    42.15,    49.25,      56.25,      63.25,      70.25 ],
  /* 13-15 kg      */  [ 7.25,    10.15,    11.55,    45.05,    52.45,      59.95,      67.45,      74.95 ],
  /* 15-17 kg      */  [ 7.35,    10.35,    11.75,    48.55,    56.05,      63.55,      70.75,      78.65 ],
  /* 17-20 kg      */  [ 7.45,    10.55,    11.95,    54.75,    63.85,      72.95,      82.05,      91.15 ],
  /* 20-25 kg      */  [ 7.65,    10.95,    12.15,    64.05,    75.05,      84.75,      95.35,      105.95],
  /* 25-30 kg      */  [ 7.75,    11.15,    12.35,    65.95,    75.45,      85.55,      96.25,      106.95],
  /* 30-40 kg      */  [ 7.85,    11.35,    12.55,    67.75,    78.95,      88.95,      99.15,      107.05],
  /* 40-50 kg      */  [ 7.95,    11.55,    12.75,    70.25,    81.05,      92.05,      102.55,     110.75],
  /* 50-60 kg      */  [ 8.05,    11.75,    12.95,    74.95,    86.45,      98.15,      109.35,     118.15],
  /* 60-70 kg      */  [ 8.15,    11.95,    13.15,    80.25,    92.95,      105.05,     117.15,     126.55],
  /* 70-80 kg      */  [ 8.25,    12.15,    13.35,    83.95,    97.05,      109.85,     122.45,     132.25],
  /* 80-90 kg      */  [ 8.35,    12.35,    13.55,    93.25,    107.45,     122.05,     136.05,     146.95],
  /* 90-100 kg     */  [ 8.45,    12.55,    13.75,    106.55,   123.95,     139.55,     155.55,     167.95],
  /* 100-125 kg    */  [ 8.55,    12.75,    13.95,    119.25,   138.05,     156.05,     173.95,     187.95],
  /* 125-150 kg    */  [ 8.65,    12.75,    14.15,    126.55,   146.15,     165.65,     184.65,     199.45],
  /* +150 kg       */  [ 8.75,    12.95,    14.35,    166.15,   192.45,     217.55,     242.55,     261.95],
];

// Tabela de frete grátis RÁPIDO para produtos abaixo de R$79 (opcional)
// Só uma coluna de preço: R$ 0 a R$ 78,99
const TABELA_RAPIDO: number[] = [
  12.35, 13.25, 13.85, 14.15, 14.45, 15.75, 17.05, 18.45,
  25.45, 27.05, 28.85, 29.65, 41.25, 42.15, 45.05, 48.55,
  54.75, 64.05, 65.95, 67.75, 70.25, 74.95, 80.25, 83.95,
  93.25, 106.55, 119.25, 126.55, 166.15,
];

function indicePeso(pesoKg: number): number {
  return FAIXAS_PESO.findIndex(max => pesoKg <= max);
}

function indicePreco(preco: number): number {
  return FAIXAS_PRECO.findIndex(max => preco <= max);
}

/**
 * Calcula o custo de envio que o seller paga ao ML.
 * Aplica-se a todas as vendas, mesmo quando o comprador paga o frete.
 *
 * @param pesoKg   Peso do produto na embalagem final (kg)
 * @param preco    Preço do anúncio (R$)
 * @returns        Custo de frete em R$, ou null se dados insuficientes
 */
export function calcularFreteMl(pesoKg: number | null | undefined, preco: number | null | undefined): number | null {
  if (!pesoKg || !preco || pesoKg <= 0 || preco <= 0) return null;

  const iP = indicePeso(pesoKg);
  const iF = indicePreco(preco);

  if (iP === -1 || iF === -1) return null;

  const custo = TABELA[iP][iF];

  // Regra: produtos < R$19 pagam no máximo metade do preço
  if (preco < 19) return Math.min(custo, preco / 2);

  return custo;
}

/**
 * Custo do frete grátis rápido (opcional, para anúncios abaixo de R$79).
 */
export function calcularFreteRapidoMl(pesoKg: number | null | undefined): number | null {
  if (!pesoKg || pesoKg <= 0) return null;
  const iP = indicePeso(pesoKg);
  if (iP === -1) return null;
  return TABELA_RAPIDO[iP];
}

// ── Envios Full ──────────────────────────────────────────────────────────────
// Tabela oficial ML Full (Fulfillment), custo por unidade vendida com frete grátis.
// Fonte: mercadolivre.com.br/ajuda/tarifas-de-envio-full_2433
// Faixas de preço: até R$79 | R$79-R$150 | acima de R$150
export type TamanhoFull = "P" | "M" | "G" | "XG";

export const TAMANHOS_FULL: Record<TamanhoFull, { label: string; desc: string; pesoKg: number }> = {
  P:  { label: "Pequeno",      desc: "Até 1.200 cm³ (ex: mouse, frasco)",         pesoKg: 0.3  },
  M:  { label: "Médio",        desc: "1.201 a 30.000 cm³ (ex: tênis, cafeteira)", pesoKg: 1.0  },
  G:  { label: "Grande",       desc: "Mais de 30.000 cm³ (ex: micro-ondas)",      pesoKg: 5.0  },
  XG: { label: "Extragrande",  desc: "Mais de 60×60×70 cm ou >18 kg",             pesoKg: 20.0 },
};

// Full usa a mesma tabela ME2/Coleta (validado pelo painel ML):
//   P (0,3 kg) + R$19 → R$6,55  ✓
//   M (1,75 kg) + R$116,90 → R$16,85  ✓
const PESO_PROXY_FULL: Record<TamanhoFull, number> = {
  P:  0.3,   // "Até 0,3 kg"
  M:  1.75,  // "De 1,5 a 2 kg"
  G:  4.5,   // "De 4 a 5 kg"
  XG: 19.0,  // "De 17 a 20 kg"
};

export function calcularFreteFullMl(
  tamanho: TamanhoFull,
  preco: number | null | undefined,
  pesoKgReal?: number | null
): number | null {
  const peso = (pesoKgReal != null && pesoKgReal > 0) ? pesoKgReal : PESO_PROXY_FULL[tamanho];
  return calcularFreteMl(peso, preco);
}

// ── Envios Flex ───────────────────────────────────────────────────────────────
// Produto < R$79: seller paga custo fixo por venda
// Produto ≥ R$79: seller RECEBE tarifa do comprador → custo líquido = 0
export function calcularFreteFlexMl(preco: number | null | undefined): number {
  if (!preco || preco <= 0) return 0;
  if (preco >= 79)   return 0;      // comprador paga; seller recebe de volta
  if (preco <= 12.5) return 6.25;
  if (preco <= 29)   return 6.50;
  if (preco <= 50)   return 6.75;
  return 6.75; // R$50 a R$78,99
}

/**
 * Retorna a descrição da faixa de preço para exibição.
 */

export function descricaoFaixaFrete(preco: number): string {
  if (preco < 19)  return "R$ 0 a R$ 18,99";
  if (preco < 49)  return "R$ 19 a R$ 48,99";
  if (preco < 79)  return "R$ 49 a R$ 78,99";
  if (preco < 100) return "R$ 79 a R$ 99,99";
  if (preco < 120) return "R$ 100 a R$ 119,99";
  if (preco < 150) return "R$ 120 a R$ 149,99";
  if (preco < 200) return "R$ 150 a R$ 199,99";
  return "A partir de R$ 200";
}
