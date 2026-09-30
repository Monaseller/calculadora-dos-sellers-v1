/**
 * O resumo curto que abre uma conversa NOVA — F7b.4.8 Parte C.
 *
 * ── O problema ──────────────────────────────────────────────────────
 *
 * Clicar "Nova conversa" zera o fio. Memoria, ferramentas, Skills e
 * arquivos continuam — mas a tela fica em branco, e a pessoa que estava
 * no meio de um fechamento financeiro tem de lembrar sozinha onde parou.
 *
 * ── Por que este modulo NAO chama a IA ─────────────────────────────
 *
 * A saida natural seria pedir ao modelo um resumo da conversa anterior.
 * Foi considerado e recusado, por tres razoes que se somam:
 *
 *   §16  "Nao inventar atividade". Parafrasear uma conversa e exatamente
 *        onde a invencao entra: um resumo plausivel e indistinguivel de
 *        um resumo correto para quem le, e quem le e o dono do negocio.
 *
 *   §18  A retomada tem de aparecer NA HORA. Uma chamada de modelo poe
 *        latencia e uma chance de falha entre o clique e a tela.
 *
 *   custo  Abrir conversa deixaria de ser uma operacao local e passaria
 *          a gastar IA atras de um botao que parece gratis — o mesmo
 *          argumento que a rota de conversas ja registra sobre titulo.
 *
 * Entao a retomada CITA em vez de parafrasear. O assunto da conversa
 * anterior e o que a PESSOA escreveu, recortado — nao ha o que inventar
 * num trecho copiado.
 *
 * ── E por que nao e "outra memoria" — §17 ──────────────────────────
 *
 * O assunto mora em `agente_conversas.titulo`, coluna que ja existia, e
 * pertence a conversa: ela morre com a conversa. Nao entra no grafo do
 * Zep, nao vira fato do dono e nao e recuperado em nenhum outro turno.
 * Um fato temporario guardado como memoria eterna e o defeito que o §17
 * nomeia, e a coluna evita exatamente isso.
 *
 * ── PURO ────────────────────────────────────────────────────────────
 *
 * Sem banco, sem rede, sem IA, sem relogio. Recebe texto, devolve texto.
 */

/** O assunto e curto de proposito: ele vira uma linha de saudacao. */
export const LIMITE_ASSUNTO = 80;

/** Teto da frase inteira — §17 pede limite de tamanho, e aqui esta. */
export const LIMITE_RETOMADA = 240;

/**
 * Caracteres que encerram uma ideia.
 *
 * Cortar em ponto, em vez de no caractere 80, e a diferenca entre
 * "vamos fechar o mes de agosto" e "vamos fechar o mes de ago".
 */
const FIM_DE_IDEIA = /[.!?\n]/;

/**
 * O ASSUNTO de uma conversa, tirado da primeira coisa que a pessoa disse.
 *
 * ── Por que a PRIMEIRA mensagem, e nao a ultima ────────────────────
 *
 * A primeira e o pedido; a ultima costuma ser um "obrigado" ou um "e o
 * mes passado?". O assunto de uma conversa e o que a abriu.
 *
 * Devolve `null` quando nao ha nada utilizavel: uma saudacao sem assunto
 * e melhor que uma saudacao sobre nada.
 */
export function assuntoDaMensagem(texto: unknown): string | null {
  if (typeof texto !== "string") return null;

  // Espaco colapsado antes de medir: uma mensagem colada de um e-mail
  // vem cheia de quebras, e elas contariam como conteudo.
  const limpo = texto.replace(/\s+/g, " ").trim();
  if (limpo.length < 3) return null;

  // Uma frase, se ela couber. Senao, o recorte com reticencias — que
  // sinaliza que ha mais, em vez de fingir que a frase acabou ali.
  const corte = limpo.search(FIM_DE_IDEIA);
  const primeira = corte > 0 ? limpo.slice(0, corte).trim() : limpo;
  if (primeira.length === 0) return null;
  if (primeira.length <= LIMITE_ASSUNTO) return primeira;

  const recorte = primeira.slice(0, LIMITE_ASSUNTO);
  const ultimoEspaco = recorte.lastIndexOf(" ");
  // Palavra cortada no meio fica pior que uma palavra a menos.
  const base = ultimoEspaco > LIMITE_ASSUNTO / 2
    ? recorte.slice(0, ultimoEspaco) : recorte;
  return `${base.trim()}...`;
}

export interface EntradaRetomada {
  /** O assunto da conversa ANTERIOR, ou `null` se nao houver. */
  readonly assuntoAnterior: string | null;
  /** O primeiro nome do dono, quando a CDS o conhece. */
  readonly primeiroNome?: string | null;
}

/**
 * A linha de retomada, ou `null` quando nao ha o que retomar.
 *
 * `null` e resposta legitima e frequente: primeira conversa do agente,
 * ou conversa anterior que nunca recebeu mensagem. Uma saudacao genérica
 * no lugar ("Oi! Como posso ajudar?") seria ruido — a tela ja tem um
 * campo de texto dizendo isso.
 */
export function frasesDeRetomada(entrada: EntradaRetomada): string | null {
  const assunto = entrada.assuntoAnterior;
  if (assunto === null || assunto.trim() === "") return null;

  const nome = (entrada.primeiroNome ?? "").trim();
  const saudacao = nome === "" ? "Oi" : `Oi, ${nome}`;

  // As aspas nao sao enfeite: elas marcam que o trecho e da pessoa, e
  // nao uma interpretacao do agente sobre o que ela quis dizer.
  const frase =
    `${saudacao}. Na nossa última conversa você me pediu: «${assunto}». ` +
    `Quer continuar disso ou começar outro assunto?`;

  if (frase.length <= LIMITE_RETOMADA) return frase;

  // Estourou o teto: o assunto encurta, e a frase continua inteira. O
  // contrario — cortar a frase — deixaria a pergunta sem final.
  const sobra = LIMITE_RETOMADA - (frase.length - assunto.length);
  if (sobra < 12) return `${saudacao}. Quer continuar de onde paramos?`;
  const curto = assunto.slice(0, sobra - 3).trim();
  return (
    `${saudacao}. Na nossa última conversa você me pediu: «${curto}...». ` +
    `Quer continuar disso ou começar outro assunto?`
  );
}
