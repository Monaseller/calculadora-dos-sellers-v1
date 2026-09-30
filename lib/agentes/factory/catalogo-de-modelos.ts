/**
 * O catalogo de CEREBROS — AGENT-FACTORY-F7b.4.
 *
 * ── Para que serve, e para que NAO serve ────────────────────────────
 *
 * Serve para escolher o cerebro de UM agente. Nao e vitrine do catalogo
 * comercial dos provedores: entra aqui o que a CDS de fato configura e
 * de fato exercita.
 *
 * ── Capacidade e MEDIDA, nunca prometida ────────────────────────────
 *
 * Cada entrada declara o que foi provado contra a API real, com a suite
 * que provou. A tela le este catalogo e NAO pode oferecer um nivel que a
 * entrada nao declare — §36. Um seletor que mostra "Maximo" para um
 * modelo sem controle de raciocinio nao e otimismo: e mentira que o
 * usuario descobre depois.
 *
 * ── O nivel de trabalho e rotulo da CDS ─────────────────────────────
 *
 * "Rapido", "Equilibrado", "Avancado", "Maximo" sao palavras nossas. O
 * backend traduz para o parametro real do provedor, e o rotulo NUNCA vai
 * para a API. Hoje nenhum dos dois provedores configurados expoe controle
 * de esforco por onde a CDS chama — entao o catalogo declara UM nivel e a
 * tela nao mostra seletor. Quando um provedor expuser, a traducao entra
 * aqui e a tela passa a oferecer sem mudar de forma.
 *
 * ── Disponibilidade vem do AMBIENTE ─────────────────────────────────
 *
 * `modelosDisponiveis()` le env e nada mais: sem chave, o provedor
 * simplesmente nao aparece. Isso e o que faz o Preview mostrar o que o
 * Preview tem, e nao o que o `.env.local` do desenvolvedor tem.
 */

// ─── Niveis de trabalho ───────────────────────────────────────────────

export const NIVEIS_DE_TRABALHO = Object.freeze([
  "rapido", "equilibrado", "avancado", "maximo",
] as const);
export type NivelDeTrabalho = (typeof NIVEIS_DE_TRABALHO)[number];

export const ROTULO_DO_NIVEL: Readonly<Record<NivelDeTrabalho, string>> = Object.freeze({
  rapido: "Rápido",
  equilibrado: "Equilibrado",
  avancado: "Avançado",
  maximo: "Máximo",
});

export const AJUDA_DO_NIVEL: Readonly<Record<NivelDeTrabalho, string>> = Object.freeze({
  rapido: "Responde mais rápido, pensa menos.",
  equilibrado: "O equilíbrio entre velocidade e cuidado.",
  avancado: "Pensa mais antes de responder.",
  maximo: "O máximo de raciocínio que este modelo permite.",
});

/**
 * O rotulo de um nivel que chegou como STRING solta.
 *
 * A tela recebe os niveis pelo transporte, onde eles sao `string[]` — e
 * indexar o mapa tipado com string crua nao compila, com razao: um nivel
 * desconhecido nao tem rotulo. Aqui a falta de rotulo devolve o proprio
 * valor, que e feio e honesto, em vez de `undefined` na interface.
 */
export function rotuloDoNivel(valor: string): string {
  return (NIVEIS_DE_TRABALHO as readonly string[]).includes(valor)
    ? ROTULO_DO_NIVEL[valor as NivelDeTrabalho]
    : valor;
}

// ─── Provedores ───────────────────────────────────────────────────────

export const PROVEDORES = Object.freeze(["anthropic", "google", "openai"] as const);
export type ProvedorDeModelo = (typeof PROVEDORES)[number];

export const ROTULO_DO_PROVEDOR: Readonly<Record<ProvedorDeModelo, string>> = Object.freeze({
  anthropic: "Claude",
  google: "Gemini",
  openai: "OpenAI",
});

// ─── Uma entrada do catalogo ───────────────────────────────────────────

export interface ModeloDoCatalogo {
  readonly provedor: ProvedorDeModelo;
  /**
   * Nome da variavel de ambiente que carrega o id do modelo.
   *
   * O id NAO e hardcoded aqui de proposito: quem escolhe a versao exata
   * e o ambiente, e o codigo nao deve ter opiniao sobre qual geracao do
   * modelo esta em uso.
   */
  readonly envDoModelo: string;
  /** Variavel que precisa existir para o provedor responder. */
  readonly envDaChave: string;
  readonly nomeVisivel: string;
  readonly descricao: string;
  readonly chat: boolean;
  /** Ida-e-volta de ferramenta COMPLETO, medido. */
  readonly ferramentas: boolean;
  readonly visao: boolean;
  /**
   * Os niveis que este modelo REALMENTE suporta pelo caminho da CDS.
   *
   * Um unico item significa "nao ha controle a oferecer" — e a tela
   * esconde o seletor em vez de mostrar uma escolha sem efeito.
   */
  readonly niveis: readonly NivelDeTrabalho[];
  /** Onde a capacidade foi provada. Obriga a afirmacao a ter endereco. */
  readonly provadoEm: string;
}

/**
 * O catalogo.
 *
 * ── A OpenAI entrou, e a ordem importou ────────────────────────────
 *
 * Ela ficou FORA do catalogo por um gate inteiro, com a chave ja
 * existindo: a conta nao tinha saldo, toda inferencia respondia 429
 * `credit_balance_exhausted`, e uma entrada aqui faria a tela OFERECER um
 * provedor cuja primeira mensagem falharia.
 *
 * Com o saldo regularizado, a ordem foi a do gate: provar primeiro,
 * catalogar depois. O roundtrip de 46719.65 passou pelo laco e pelo
 * guard, o multi-turno levou o resultado adiante, e o fail-closed fechou
 * o turno sem improviso — `scripts/testar-openai-runtime-live.ts`.
 *
 * `provadoEm` existe para isto: nenhuma promessa de capacidade entra aqui
 * sem endereco, e o teste confere que o endereco existe.
 */
const CATALOGO: readonly ModeloDoCatalogo[] = Object.freeze([
  Object.freeze({
    provedor: "anthropic" as const,
    envDoModelo: "ANTHROPIC_MODEL_AGENTE",
    envDaChave: "ANTHROPIC_API_KEY",
    nomeVisivel: "Claude",
    descricao: "Compatível com todas as ferramentas. É o padrão da Fábrica.",
    chat: true,
    ferramentas: true,
    visao: false,
    /**
     * UM nivel — e agora com medicao, nao com suposicao — F7b.4.3 §21.
     *
     * MEDIDO em `scripts/medir-niveis-de-trabalho.ts` contra
     * `claude-haiku-4-5`, com ferramenta declarada:
     *
     *   sem `thinking`                       -> 200
     *   `thinking` enabled budget 1024/4096  -> 200, blocos [thinking, tool_use]
     *   `thinking` disabled                  -> 200
     *
     * Ou seja: a Anthropic TEM controle real de esforco, e ele NAO quebra o
     * pedido de ferramenta. O parametro existe e e testavel.
     *
     * Mesmo assim o nivel continua UM so, de proposito. Ligar `thinking`
     * obriga a PRESERVAR o bloco de pensamento (com a assinatura dele) no
     * turno do assistente ao devolver o resultado da ferramenta — e a mesma
     * classe de defeito da assinatura do Gemini no F7b.4, que custou um
     * gate inteiro e uma conclusao errada.
     *
     * Expor antes de provar o ida-e-volta em cada nivel seria prometer
     * capacidade nao provada, e a Anthropic e o provedor padrao: quebra-la
     * quebra o caminho critico. Quando a preservacao do bloco estiver
     * provada, os niveis entram aqui — nao antes.
     */
    niveis: Object.freeze(["equilibrado"] as const),
    provadoEm: "scripts/testar-agentes-live-tool-call.ts",
  }),
  Object.freeze({
    provedor: "google" as const,
    envDoModelo: "GOOGLE_AI_MODEL_AGENTE",
    envDaChave: "GOOGLE_AI_API_KEY",
    nomeVisivel: "Gemini",
    descricao: "Compatível com ferramentas desde o F7b.4, sem reter dados.",
    chat: true,
    // PROVADO no F7b.4: `store: false` + assinatura preservada.
    ferramentas: true,
    visao: false,
    /**
     * UM nivel, e aqui por AUSENCIA de parametro — F7b.4.3 §21.
     *
     * MEDIDO em `scripts/medir-niveis-de-trabalho.ts`, pelo MESMO caminho
     * do adaptador (`interactions.create`, `store: false`), com o caso base
     * passando (`steps=2`) para a medicao nao ser vacua:
     *
     *   sem parametro          -> 200
     *   `thinking_level`       -> 400 "Unknown parameter 'thinking_level'"
     *   `thinking_config`      -> 400 "Unknown parameter 'thinking_config'"
     *   `reasoning`            -> 400 "Unknown parameter 'reasoning'"
     *
     * A Interactions API simplesmente nao aceita controle de raciocinio.
     * Nivel unico fixo nao e escolha conservadora aqui — e o unico fato.
     */
    niveis: Object.freeze(["equilibrado"] as const),
    provadoEm: "scripts/testar-gemini-stateless-live.ts",
  }),
  Object.freeze({
    provedor: "openai" as const,
    envDoModelo: "OPENAI_MODEL_AGENTE",
    envDaChave: "OPENAI_API_KEY",
    nomeVisivel: "OpenAI",
    descricao: "Compatível com ferramentas. É o único que permite escolher o nível de trabalho.",
    chat: true,
    ferramentas: true,
    visao: false,
    /**
     * QUATRO niveis, e os quatro foram medidos um por um em gpt-5.2:
     *
     *   none -> 200    low -> 200    medium -> 200    high -> 200
     *   minimal -> 400 "Unsupported value ... with the 'gpt-5.2' model"
     *
     * Por isso `minimal` nao aparece em `ESFORCO_POR_NIVEL`, e por isso
     * este e o unico provedor do catalogo em que a tela mostra o seletor:
     * `ofereceEscolhaDeNivel` fica true quando ha mais de um.
     */
    niveis: Object.freeze(["rapido", "equilibrado", "avancado", "maximo"] as const),
    provadoEm: "scripts/testar-openai-runtime-live.ts",
  }),
]);

export function catalogoDeModelos(): readonly ModeloDoCatalogo[] {
  return CATALOGO;
}

// ─── Disponibilidade ──────────────────────────────────────────────────

export interface ModeloDisponivel {
  readonly provedor: ProvedorDeModelo;
  readonly nomeVisivel: string;
  readonly descricao: string;
  /** O id real, lido do ambiente. Exibido em detalhes tecnicos. */
  readonly modeloId: string;
  readonly ferramentas: boolean;
  readonly visao: boolean;
  readonly niveis: readonly NivelDeTrabalho[];
}

function textoDoEnv(nome: string): string | null {
  const v = process.env[nome];
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

/**
 * Os modelos que ESTE ambiente pode usar.
 *
 * Exige as DUAS variaveis. Uma chave sem modelo configurado nao e um
 * provedor meio pronto: o adaptador lanca, e oferecer a opcao na tela
 * produziria um agente que falha no primeiro turno.
 */
export function modelosDisponiveis(): readonly ModeloDisponivel[] {
  const saida: ModeloDisponivel[] = [];
  for (const m of CATALOGO) {
    const chave = textoDoEnv(m.envDaChave);
    const modeloId = textoDoEnv(m.envDoModelo);
    if (chave === null || modeloId === null) continue;
    saida.push({
      provedor: m.provedor,
      nomeVisivel: m.nomeVisivel,
      descricao: m.descricao,
      modeloId,
      ferramentas: m.ferramentas,
      visao: m.visao,
      niveis: m.niveis,
    });
  }
  return saida;
}

/** Nomes de env que faltam para um provedor aparecer. Nunca valores. */
export function envsFaltando(provedor: ProvedorDeModelo): readonly string[] {
  const m = CATALOGO.find((x) => x.provedor === provedor);
  if (m === undefined) return [];
  const faltam: string[] = [];
  if (textoDoEnv(m.envDaChave) === null) faltam.push(m.envDaChave);
  if (textoDoEnv(m.envDoModelo) === null) faltam.push(m.envDoModelo);
  return faltam;
}

/**
 * O nivel efetivo, dado o que o modelo suporta.
 *
 * Um pedido de nivel que o modelo nao tem NAO e erro e NAO e silencio: ele
 * cai no nivel mais proximo que existe, e quem chama recebe `ajustado`
 * para poder dizer isso na tela. Mandar o rotulo cru para a API seria o
 * unico desfecho inaceitavel.
 */
export interface NivelEfetivo {
  readonly nivel: NivelDeTrabalho;
  readonly ajustado: boolean;
}

export function nivelEfetivo(
  pedido: unknown,
  suportados: readonly NivelDeTrabalho[]
): NivelEfetivo {
  const disponiveis = suportados.length > 0 ? suportados : (["equilibrado"] as const);
  const alvo = typeof pedido === "string" &&
    (NIVEIS_DE_TRABALHO as readonly string[]).includes(pedido)
    ? (pedido as NivelDeTrabalho)
    : null;
  if (alvo !== null && disponiveis.includes(alvo)) return { nivel: alvo, ajustado: false };

  // Mais proximo pela ORDEM declarada em `NIVEIS_DE_TRABALHO`, que vai de
  // menos para mais esforco. Sem alvo legivel, o meio do que existe.
  if (alvo === null) return { nivel: disponiveis[0], ajustado: true };
  const iAlvo = NIVEIS_DE_TRABALHO.indexOf(alvo);
  let melhor = disponiveis[0];
  let melhorDist = Math.abs(NIVEIS_DE_TRABALHO.indexOf(melhor) - iAlvo);
  for (const n of disponiveis) {
    const d = Math.abs(NIVEIS_DE_TRABALHO.indexOf(n) - iAlvo);
    if (d < melhorDist) { melhor = n; melhorDist = d; }
  }
  return { nivel: melhor, ajustado: true };
}

/**
 * `true` quando a tela deve mostrar o seletor de nivel.
 *
 * Com um nivel so nao ha escolha a fazer, e um radio de uma opcao pede
 * atencao para nada.
 */
export function ofereceEscolhaDeNivel(suportados: readonly NivelDeTrabalho[]): boolean {
  return suportados.length > 1;
}
