/**
 * Qual IA responde por ESTE agente — AGENT-FACTORY-F7b.4.2 §7/§8/§9.
 *
 * Funcao pura. Nao le env, nao le banco, nao faz rede: recebe o que o
 * agente gravou e o que o ambiente oferece, e diz o que vale. Quem le env
 * e `catalogo-de-modelos.ts`; quem le banco e a rota.
 *
 * ── O que pertence ao agente, e o que pertence ao ambiente ──────────
 *
 *   PROVEDOR   do agente. E a escolha do dono: qual cerebro responde.
 *   NIVEL      do agente. Quanto esforco, quando o provedor tem niveis.
 *   MODELO     do AMBIENTE. O id concreto (`gpt-5.2`, `claude-...`) vem
 *              de env, porque quem atualiza a versao do modelo e a
 *              operacao, e nao o dono do agente.
 *
 * `modelo_ia` e gravado de todo modo, como registro do que foi escolhido
 * no dia — e o dia em que um provedor oferecer dois modelos, a coluna ja
 * existe. Quando o gravado difere do que o ambiente serve hoje, isso NAO
 * e escondido: `modeloEscolhidoDivergente` diz, e a tela pode mostrar.
 *
 * ── A regra que este modulo existe para tornar impossivel de furar ──
 *
 * NAO HA FALLBACK SILENCIOSO (§8).
 *
 * Se o dono gravou Gemini e o Gemini nao esta disponivel, a resposta NAO
 * vem da Anthropic. `provedor` continua sendo o escolhido, o desfecho e
 * `escolhida_indisponivel`, e `validarParaAtivacao` bloqueia com
 * `ia_escolhida_indisponivel`. Trocar de cerebro sem avisar mudaria o
 * comportamento de um agente que alguem configurou — instrucoes, nivel e
 * ferramentas foram pensados para um modelo especifico.
 *
 * A UNICA vez em que outro provedor e usado e quando o agente nunca
 * escolheu nenhum (`provedorGravado === null`). Aí nao ha escolha a
 * respeitar, e o default do ambiente e o comportamento que esse agente
 * sempre teve — e o que preserva os agentes criados antes destas colunas.
 */

/** O que o catalogo oferece. Recortado de proposito: so o necessario. */
export interface OpcaoDeIa {
  readonly provedor: string;
  readonly modeloId: string;
  readonly niveis: readonly string[];
}

export const DESFECHOS_DA_IA = Object.freeze([
  /** O dono escolheu, e esta disponivel. */
  "escolhida",
  /** O dono nunca escolheu; vale o default do ambiente. */
  "default_do_ambiente",
  /** O dono escolheu, e NAO esta disponivel. Bloqueia, nao troca. */
  "escolhida_indisponivel",
  /** O ambiente nao tem provedor nenhum configurado. */
  "nenhuma_configurada",
] as const);

export type DesfechoDaIa = (typeof DESFECHOS_DA_IA)[number];

export interface IaDoAgente {
  readonly desfecho: DesfechoDaIa;
  /**
   * O provedor que VAI responder.
   *
   * Em `escolhida_indisponivel` ele e o escolhido, e nao um substituto —
   * e precisamente por isso que a ativacao consegue barrar.
   */
  readonly provedor: string | null;
  /** O id concreto que o ambiente serve hoje. */
  readonly modelo: string | null;
  /** `null` = usar o default do adaptador. */
  readonly nivel: string | null;
  readonly provedorEscolhido: string | null;
  readonly modeloEscolhido: string | null;
  readonly nivelEscolhido: string | null;
  readonly provedoresDisponiveis: readonly string[];
  /** O modelo gravado nao e o que o ambiente serve. Informado, nao corrigido. */
  readonly modeloEscolhidoDivergente: boolean;
  /** O nivel gravado nao existe para este provedor; vale o default dele. */
  readonly nivelEscolhidoDivergente: boolean;
}

/**
 * O default do ambiente.
 *
 * A Anthropic vem primeiro quando disponivel porque e o caminho provado
 * desde o F4 — por ordem de evidencia, nao por preferencia. Nao ha sorteio
 * nem "o mais novo": o default tem de ser o mesmo em toda chamada, senao
 * dois turnos do mesmo agente responderiam de cerebros diferentes.
 */
export function opcaoPreferida(
  disponiveis: readonly OpcaoDeIa[]
): OpcaoDeIa | null {
  if (disponiveis.length === 0) return null;
  return disponiveis.find((m) => m.provedor === "anthropic") ?? disponiveis[0];
}

export function resolverIaDoAgente(entrada: {
  readonly provedorGravado: string | null;
  readonly modeloGravado: string | null;
  readonly nivelGravado: string | null;
  readonly disponiveis: readonly OpcaoDeIa[];
}): IaDoAgente {
  const { disponiveis } = entrada;
  const provedores = Object.freeze(disponiveis.map((m) => m.provedor));

  const escolhido = (entrada.provedorGravado ?? "").trim();
  const modeloEscolhido = (entrada.modeloGravado ?? "").trim() || null;
  const nivelEscolhido = (entrada.nivelGravado ?? "").trim() || null;

  const vazio = {
    provedorEscolhido: escolhido === "" ? null : escolhido,
    modeloEscolhido,
    nivelEscolhido,
    provedoresDisponiveis: provedores,
  };

  // ── Ambiente sem nada configurado ─────────────────────────────────
  //
  // Vem ANTES do caso da escolha indisponivel: sem nenhum provedor no
  // ambiente, o problema nao e a escolha do dono, e dizer a ele para
  // "escolher outra" seria mandar consertar o que nao esta quebrado.
  if (disponiveis.length === 0) {
    return {
      ...vazio,
      desfecho: "nenhuma_configurada",
      provedor: null, modelo: null, nivel: null,
      modeloEscolhidoDivergente: false,
      nivelEscolhidoDivergente: false,
    };
  }

  // ── Agente que nunca escolheu ─────────────────────────────────────
  if (escolhido === "") {
    const preferida = opcaoPreferida(disponiveis);
    return {
      ...vazio,
      desfecho: "default_do_ambiente",
      provedor: preferida?.provedor ?? null,
      modelo: preferida?.modeloId ?? null,
      // Sem escolha de provedor nao ha nivel a aplicar: um rotulo gravado
      // sozinho pertenceria a um provedor que ninguem selecionou.
      nivel: null,
      modeloEscolhidoDivergente: false,
      nivelEscolhidoDivergente: false,
    };
  }

  const opcao = disponiveis.find((m) => m.provedor === escolhido);

  // ── A escolha existe e nao esta disponivel: BLOQUEIA ──────────────
  if (opcao === undefined) {
    return {
      ...vazio,
      desfecho: "escolhida_indisponivel",
      // O escolhido, e nao um substituto.
      provedor: escolhido,
      modelo: modeloEscolhido,
      nivel: nivelEscolhido,
      modeloEscolhidoDivergente: false,
      nivelEscolhidoDivergente: false,
    };
  }

  // ── A escolha vale ────────────────────────────────────────────────
  const nivelVale = nivelEscolhido !== null && opcao.niveis.includes(nivelEscolhido);
  return {
    ...vazio,
    desfecho: "escolhida",
    provedor: opcao.provedor,
    // O ambiente decide o id concreto. Ver o docblock.
    modelo: opcao.modeloId,
    nivel: nivelVale ? nivelEscolhido : null,
    modeloEscolhidoDivergente:
      modeloEscolhido !== null && modeloEscolhido !== opcao.modeloId,
    nivelEscolhidoDivergente: nivelEscolhido !== null && !nivelVale,
  };
}
