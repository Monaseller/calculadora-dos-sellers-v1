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
 * ── Por que `openai` continua AUSENTE, mesmo com chave ──────────────
 *
 * Desde o F7b.4.2 existe `OPENAI_API_KEY`, e ela e valida: `GET
 * /v1/models` responde 200 com 127 modelos, incluindo a familia `gpt-5`,
 * que tem function calling.
 *
 * E toda chamada de INFERENCIA responde 429
 * `credit_balance_exhausted` — a conta nao tem saldo. Medido em
 * `scripts/testar-openai-disponibilidade-live.ts`, que classifica isso
 * como `billing_necessario` e nao como "nao configurado".
 *
 * Uma entrada aqui faria a etapa IA / Modelo OFERECER a OpenAI, e a
 * primeira mensagem do agente falharia. Entrada no catalogo e promessa de
 * capacidade, e `provadoEm` existe justamente para que nenhuma promessa
 * entre sem endereco. O dia em que houver saldo, a ordem e: rodar o
 * roundtrip de 46719.65, e so depois acrescentar a entrada.
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
    // Um nivel so: o caminho da CDS nao expoe controle de esforco hoje.
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
    niveis: Object.freeze(["equilibrado"] as const),
    provadoEm: "scripts/testar-gemini-stateless-live.ts",
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
