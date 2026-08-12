/**
 * Estimativa de custo por tokens — neutra em relação a provedor.
 *
 * CORREÇÃO ESTRUTURAL (2026-08-14, Constituição §37.2). Até aqui a
 * tabela de preços e `estimarCustoUsd()` viviam dentro de
 * `provedores/google.ts`, com apenas modelos Gemini cadastrados.
 * Qualquer modelo fora dessa tabela — inclusive todo modelo Anthropic —
 * devolvia `custoEstimado = 0` com um `console.warn`, nunca um erro.
 * Ou seja: introduzir a Anthropic sem esta correção significaria custo
 * silenciosamente contabilizado como zero na etapa nova. É exatamente o
 * tipo de defeito que a Seção 37.2 manda corrigir ANTES de construir em
 * cima.
 *
 * A assinatura `(modelo, tokensEntrada, tokensSaida)` foi preservada de
 * propósito: nomes de modelo são globalmente únicos entre os provedores
 * (`gemini-*` vs `claude-*`), então uma única tabela indexada por modelo
 * resolve os dois sem mudar nenhum dos 3 handlers já estabilizados.
 * `provedores/google.ts` reexporta esta função, então nada quebrou.
 *
 * Continua sendo CUSTO ESTIMADO a partir de tabela mantida à mão — as
 * APIs devolvem contagem de tokens, não dinheiro. Nunca chamar de
 * "custo real".
 */

interface PrecoPorMilhaoTokens {
  entradaPorMilhao: number;
  saidaPorMilhao: number;
  /**
   * Preço da saída de IMAGEM, quando o modelo cobra a saída em duas
   * taxas distintas por modalidade. Ausente = o modelo tem uma taxa de
   * saída só (todos os modelos de texto).
   *
   * CORREÇÃO ESTRUTURAL (2026-08-18, §37.2): até aqui a tabela assumia
   * UMA taxa de saída por modelo, o que é verdade para todo modelo de
   * texto e FALSO para o modelo de imagem em uso. Sem este campo, o
   * custo da imagem seria calculado à taxa de texto — errado por ~20x,
   * e errado em silêncio.
   */
  saidaImagemPorMilhao?: number;
}

/**
 * Preços em USD por 1M de tokens. As chaves NÃO escolhem modelo — só
 * localizam o preço do modelo que o ambiente já escolheu.
 *
 * Anthropic (referência: tabela oficial de modelos, 2026-06-24):
 *   claude-opus-5   $5 entrada / $25 saída
 *   claude-sonnet-5 $3 / $15
 *   claude-haiku-4-5 $1 / $5
 *
 * Google — modelo de IMAGEM (referência: ai.google.dev/gemini-api/docs/
 * pricing, consultada em 2026-08-18, tier Standard/pago — NÃO o tier
 * Batch, que é metade e não é o que este código usa):
 *   gemini-3.1-flash-image  $0.50 entrada / $3 saída de texto+thinking /
 *                           $60 saída de IMAGEM
 * A própria documentação diz que uma imagem 1K (1024x1024) consome 1120
 * tokens, "equivalente a $0.067 por imagem" — e a API confirmou esse
 * número exato em `usage.output_tokens_by_modality` numa chamada real
 * (2026-08-18). Ou seja: a cobrança é POR TOKEN, e a conta por imagem é
 * consequência, não a unidade. Por isso o cálculo aqui é por token, com
 * a contagem real vinda da API — nunca `unidades x 0.067`, que quebraria
 * em qualquer resolução diferente de 1K.
 *
 * NÃO cadastrados de propósito: `gemini-3.1-flash-lite-image` (preço
 * verificado, mas nunca exercitado aqui) e `gemini-2.5-flash-image`
 * (cobra **por imagem**, $0.039 — unidade que esta tabela não
 * representa). Ambos caem no caminho seguro de custo 0 + warn até serem
 * verificados na prática.
 */
const TABELA_PRECOS_USD_POR_MILHAO_TOKENS: Record<string, PrecoPorMilhaoTokens> = {
  // Google / Gemini — texto
  "gemini-3.6-flash": { entradaPorMilhao: 1.5, saidaPorMilhao: 7.5 },
  // Google / Gemini — imagem (duas taxas de saída, ver acima)
  "gemini-3.1-flash-image": { entradaPorMilhao: 0.5, saidaPorMilhao: 3, saidaImagemPorMilhao: 60 },
  // Anthropic / Claude
  "claude-opus-5": { entradaPorMilhao: 5, saidaPorMilhao: 25 },
  "claude-sonnet-5": { entradaPorMilhao: 3, saidaPorMilhao: 15 },
  "claude-haiku-4-5": { entradaPorMilhao: 1, saidaPorMilhao: 5 },
};

/** Modelos com preço cadastrado — usado por teste e por checagem de pré-voo. */
export function modeloTemPrecoCadastrado(modelo: string): boolean {
  return modelo in TABELA_PRECOS_USD_POR_MILHAO_TOKENS;
}

/**
 * Recebe o modelo já resolvido/configurado (mesmo valor enviado ao SDK e
 * persistido no banco — nunca relido de env aqui). Modelo fora da tabela
 * devolve 0 explicitamente (nunca inventa preço) e registra aviso — só
 * com o nome do modelo, nunca com prompt ou dado sensível.
 */
export function estimarCustoUsd(
  modelo: string,
  tokensEntrada: number,
  tokensSaida: number,
  tokensSaidaImagem = 0
): number {
  const preco = TABELA_PRECOS_USD_POR_MILHAO_TOKENS[modelo];
  if (!preco) {
    console.warn(`[ai-gateway/custos] Sem preço cadastrado para o modelo "${modelo}" — custoEstimado registrado como 0.`);
    return 0;
  }

  // `tokensSaida` é o TOTAL de saída (é o que a API reporta e o que o
  // banco persiste); `tokensSaidaImagem` é o subconjunto de modalidade
  // imagem. O clamp impede que um relato inconsistente do provedor
  // produza contagem de texto negativa — e, portanto, custo negativo.
  const imagem = Math.max(0, Math.min(tokensSaidaImagem, tokensSaida));
  const texto = tokensSaida - imagem;

  // Se o modelo não tem taxa de imagem cadastrada, tudo é cobrado à taxa
  // de saída única — comportamento idêntico ao de antes desta mudança
  // para os 4 modelos de texto já cadastrados.
  const taxaImagem = preco.saidaImagemPorMilhao ?? preco.saidaPorMilhao;

  const custo =
    (tokensEntrada / 1_000_000) * preco.entradaPorMilhao +
    (texto / 1_000_000) * preco.saidaPorMilhao +
    (imagem / 1_000_000) * taxaImagem;

  return Number.isFinite(custo) ? Math.max(0, custo) : 0;
}
