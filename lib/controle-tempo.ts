/**
 * Os dois relogios de uma acao — I4B3.
 *
 * ── Por que DOIS, e nao um ──────────────────────────────────────────
 *
 * Um sinal so cancelaria tudo junto: ao estourar o tempo do marketplace,
 * a gravacao na inbox e o registro do desfecho morreriam com ele — e a
 * acao terminaria sem deixar rastro justamente no caso em que mais
 * precisa deixar. Entao sao dois.
 *
 *   LIMITE DO PROVIDER   corta o que fala com o Mercado Livre.
 *   LIMITE RIGIDO        corta a acao INTEIRA, banco incluido.
 *
 * Entre um e outro existe a RESERVA DE FINALIZACAO: o provider ja
 * silenciou, e ainda ha tempo para persistir o que foi coletado, mover o
 * cursor e fechar a auditoria.
 *
 * ── O rigido implica o do provider ─────────────────────────────────
 *
 * Nao ha caso em que a acao inteira acabou e uma chamada ao marketplace
 * deva continuar. Por isso o sinal rigido tambem aborta o do provider —
 * a implicacao e explicita, nao um efeito colateral de ordem de timers.
 *
 * ── Relogio MONOTONICO ──────────────────────────────────────────────
 *
 * `performance.now()` nao volta atras. `Date.now()` volta num acerto de
 * NTP, e um orcamento que dependesse dele poderia concluir que sobram
 * 30 s quando ja se passaram 30.
 *
 * ── Quem cria, e quem NUNCA cria ────────────────────────────────────
 *
 * Quem orquestra a acao cria. Nunca a rota, nunca o n8n, nunca os
 * argumentos de uma Funcao, nunca o payload do provider. O tipo e
 * interno e nao atravessa nenhuma fronteira serializada: um `AbortSignal`
 * nao vira JSON, e um instante de relogio deste processo nao significa
 * nada em outro.
 */

/** O que uma chamada EXTERNA precisa saber. Nada alem disto. */
export interface LimiteExterno {
  /** Aborta quando o tempo do provider — ou o da acao — acaba. */
  readonly signal: AbortSignal;
  /** Quanto ainda cabe, em ms. Zero ou negativo significa "nao comece". */
  readonly restanteMs: () => number;
}

/** O controle completo. So a camada de acao o manipula. */
export interface ControleDeTempo {
  /** O limite da acao INTEIRA, em tempo monotonico absoluto. */
  readonly limiteRigidoEm: number;
  /** O limite do trabalho com o marketplace, idem. */
  readonly limiteDoProviderEm: number;
  /** Cancela banco e rede. Use nas operacoes de persistencia. */
  readonly sinalRigido: AbortSignal;
  /** Cancela SO o que fala com o marketplace. */
  readonly limiteDoProvider: LimiteExterno;
}

/**
 * O prazo da ACAO venceu?
 *
 * ── Por que `signal.aborted`, e nao a mensagem do erro ─────────────
 *
 * Um `AbortError` chega ate quem chama embrulhado de formas diferentes
 * conforme a camada — o driver do PostgREST devolve `{ error }` com
 * texto, o `fetch` lanca um `DOMException`, e um `catch` intermediario
 * pode ter trocado os dois por um codigo de dominio. Casar texto seria
 * adivinhar.
 *
 * O sinal nao mente: ele so e abortado pelo relogio que NOS criamos.
 * Se ele esta abortado no instante em que uma chamada volta com falha,
 * a falha aconteceu dentro do nosso prazo vencido — e a causa e nossa,
 * nao do banco nem do marketplace.
 */
export function prazoVenceu(controle: ControleDeTempo): boolean {
  return controle.sinalRigido.aborted;
}

/** Quanto sobra do orcamento RIGIDO. Negativo quando ja estourou. */
export function restanteRigidoMs(controle: ControleDeTempo): number {
  return controle.limiteRigidoEm - performance.now();
}

/** Quanto sobra do orcamento do PROVIDER. */
export function restanteDoProviderMs(controle: ControleDeTempo): number {
  return controle.limiteDoProviderEm - performance.now();
}

/**
 * O teto efetivo de UMA chamada externa.
 *
 * ── Por que `min`, e nao o limite local sozinho ────────────────────
 *
 * Tres chamadas com 20 s proprios somam 60 s, e 60 s nao cabe num
 * orcamento de 30 s. O `min` com o restante COMPARTILHADO e o que impede
 * a soma de estourar: cada chamada pode usar ate o seu maximo, mas nunca
 * mais do que ainda existe.
 *
 * Zero ou negativo significa que a chamada nao deve nem comecar.
 */
export function tetoEfetivoMs(limiteLocalMs: number, limite: LimiteExterno): number {
  return Math.min(limiteLocalMs, limite.restanteMs());
}

/**
 * Cria os dois relogios a partir de AGORA.
 *
 * Devolve tambem `encerrar`, e ele NAO e opcional na pratica: sem ele os
 * dois `setTimeout` seguram o event loop do processo ate o fim do
 * orcamento, mesmo quando a acao terminou em 200 ms. Quem cria, encerra
 * — num `finally`.
 */
export function criarControleDeTempo(entrada: {
  readonly orcamentoRigidoMs: number;
  readonly orcamentoDoProviderMs: number;
}): { readonly controle: ControleDeTempo; readonly encerrar: () => void } {
  const inicio = performance.now();
  const limiteRigidoEm = inicio + entrada.orcamentoRigidoMs;
  const limiteDoProviderEm = inicio + entrada.orcamentoDoProviderMs;

  const rigido = new AbortController();
  const provider = new AbortController();

  const relogioProvider = setTimeout(
    () => provider.abort(), Math.max(0, entrada.orcamentoDoProviderMs));
  const relogioRigido = setTimeout(() => {
    rigido.abort();
    // O rigido IMPLICA o do provider. Explicito, para nao depender da
    // ordem em que dois timers vizinhos disparam.
    provider.abort();
  }, Math.max(0, entrada.orcamentoRigidoMs));

  // `unref` existe no Node e nao no browser. Sem ele, um processo que
  // termine cedo ficaria vivo ate o timer disparar.
  (relogioProvider as unknown as { unref?: () => void }).unref?.();
  (relogioRigido as unknown as { unref?: () => void }).unref?.();

  const controle: ControleDeTempo = {
    limiteRigidoEm,
    limiteDoProviderEm,
    sinalRigido: rigido.signal,
    limiteDoProvider: {
      signal: provider.signal,
      restanteMs: () => limiteDoProviderEm - performance.now(),
    },
  };

  return {
    controle,
    encerrar: () => {
      clearTimeout(relogioProvider);
      clearTimeout(relogioRigido);
    },
  };
}
