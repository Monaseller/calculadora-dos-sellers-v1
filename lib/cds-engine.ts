export type HealthStatus = "verde" | "amarelo" | "vermelho";

export type CdsInput = {
  precoAnuncio: number;
  valorLiquidoRecebido: number;
  custoProduto: number;
  impostoPercentual: number;
  margemDesejadaPercentual: number;
};

export function moeda(valor: number): string {
  return valor.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

export function percentual(valor: number): string {
  return `${valor.toFixed(2).replace(".", ",")}%`;
}

export function calcularCds(input: CdsInput) {
  const impostoDecimal = input.impostoPercentual / 100;
  const margemDesejadaDecimal = input.margemDesejadaPercentual / 100;

  const impostoValor = input.precoAnuncio * impostoDecimal;
  const lucroContribuicao = input.valorLiquidoRecebido - impostoValor - input.custoProduto;

  const margemContribuicaoPercentual =
    input.precoAnuncio > 0 ? (lucroContribuicao / input.precoAnuncio) * 100 : 0;

  const fatorLiquidoML = input.precoAnuncio > 0
    ? input.valorLiquidoRecebido / input.precoAnuncio
    : 0;

  const denominador = fatorLiquidoML - impostoDecimal - margemDesejadaDecimal;

  const precoIdeal = denominador > 0
    ? input.custoProduto / denominador
    : 0;

  const diferencaPreco = precoIdeal - input.precoAnuncio;
  const percentualAjuste = input.precoAnuncio > 0
    ? (diferencaPreco / input.precoAnuncio) * 100
    : 0;

  let saude: HealthStatus = "vermelho";
  let mensagem = "Produto em risco. A margem está abaixo de 10%.";

  if (margemContribuicaoPercentual >= 20) {
    saude = "verde";
    mensagem = "Produto saudável. A margem está acima de 20%.";
  } else if (margemContribuicaoPercentual >= 10) {
    saude = "amarelo";
    mensagem = "Atenção. A margem está entre 10% e 20%.";
  }

  return {
    impostoValor,
    lucroContribuicao,
    margemContribuicaoPercentual,
    precoIdeal,
    diferencaPreco,
    percentualAjuste,
    saude,
    mensagem
  };
}