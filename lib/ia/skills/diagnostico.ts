/**
 * CDS Skill Format v1 — motor de diagnostico de pre-requisitos. SKILL-1C.
 *
 * ── O que este motor e, e o que ele nunca faz ───────────────────────
 *
 * Ele cruza DOIS lados que nunca podem se misturar:
 *
 *   a Skill diz    "eu preciso destas Funcoes e Conexoes"
 *   a CDS diz      "estas Funcoes existem, estas permissoes estao
 *                   configuradas, estas conexoes existem e valem"
 *
 * A Skill e dado importado de fora. Ela declara NECESSIDADE; ela nunca
 * declara que a Funcao existe, que a conexao vale, nem qual e o nivel de
 * autonomia. Todo fato entra por parametro, ja resolvido por quem tem
 * autoridade para resolve-lo.
 *
 * Por isso a funcao e PURA: sem banco, sem rede, sem marketplace, sem
 * IA, sem `Date.now()`, sem `Math.random()`. Mesma entrada, mesma saida.
 * Nao ha caminho pelo qual uma Skill maliciosa alcance algo — nao porque
 * o codigo se defende dela, e sim porque ela nao entrega nada executavel:
 * as unicas coisas que ela contribui sao ids e um booleano `obrigatoria`.
 *
 * ── O que ele NAO decide ────────────────────────────────────────────
 *
 * Nao executa Funcao, nao concede permissao, nao altera autonomia, nao
 * resolve Ficha por id, nao le arquivo, nao compoe varias Skills (uma
 * por chamada) e nao escreve frase para humano. Estado + alvo sao
 * legiveis por maquina; traduzir para conversa e da camada de cima.
 */
import type { ManifestoSkill, RequisitoConexao } from "@/lib/ia/skills/contrato";
// `import type` de proposito: em tempo de execucao este modulo NAO
// depende de `conceitos.ts`, que se declara "tipos de APRESENTACAO" e
// carrega rotulos, icones e vocabulario de tela. O que e reusado sao
// apenas os DOMINIOS — o eixo unico de autonomia e o estado de conexao,
// ambos derivados de colunas reais. Copia-los para ca criaria a segunda
// fonte de verdade que `conceitos.ts` existe para ter evitado.
import type { EstadoConexao, NivelAutonomia } from "@/lib/ia/conceitos";

// ─── Estados ──────────────────────────────────────────────────────────

/**
 * Os oito estados do diagnostico.
 *
 * `CONHECIMENTO_DESATUALIZADO` NAO esta aqui, e a ausencia e decidida:
 * frescor documental e propriedade da Ficha (idade de `verificacao.em`),
 * nao de prontidao. Misturar faria uma Skill perfeitamente executavel
 * parecer bloqueada porque a documentacao envelheceu.
 */
export const ESTADOS_DIAGNOSTICO = [
  "PRONTO",
  "FALTA_FUNCAO",
  "BLOQUEADO_POR_PERMISSAO",
  "FALTA_CONEXAO",
  "CONEXAO_INVALIDA",
  "FALTA_CONFIGURACAO",
  "NAO_VERIFICAVEL",
  "REQUER_APROVACAO",
] as const;
export type EstadoDiagnostico = (typeof ESTADOS_DIAGNOSTICO)[number];

/**
 * Precedencia do `estadoGeral` — do mais grave ao menos.
 *
 * ── Por que FALTA_FUNCAO vem antes de BLOQUEADO_POR_PERMISSAO ───────
 *
 * A ordem sugerida no pedido comecava por BLOQUEADO. Trocada, com
 * motivo: `FALTA_FUNCAO` e o unico estado que NENHUMA acao do dono
 * resolve — falta codigo, nao configuracao. Resumir como "bloqueado por
 * permissao" mandaria a pessoa mexer num interruptor que nao muda nada.
 * Entre dois problemas simultaneos, o resumo honesto e o que nao pode
 * ser desfeito na tela.
 *
 * `REQUER_APROVACAO` fica em penultimo e isso tambem e deliberado: nao
 * e falha, e politica de execucao. So vira `estadoGeral` quando nada
 * mais pendura — senao esconderia uma conexao ausente atras de um
 * "so falta aprovar".
 *
 * Precedencia decide APENAS o resumo. A lista completa de pendencias
 * nunca e podada por ela — ver `Diagnostico`.
 */
const PRECEDENCIA: readonly EstadoDiagnostico[] = [
  "FALTA_FUNCAO",
  "BLOQUEADO_POR_PERMISSAO",
  "FALTA_CONEXAO",
  "CONEXAO_INVALIDA",
  "FALTA_CONFIGURACAO",
  "NAO_VERIFICAVEL",
  "REQUER_APROVACAO",
  "PRONTO",
];

const peso = (estado: EstadoDiagnostico): number => PRECEDENCIA.indexOf(estado);

// ─── Fatos de entrada ─────────────────────────────────────────────────

/**
 * "Esta Funcao existe no sistema?"
 *
 * Somente id e existencia. `acesso`, `rotulo`, `risco` e `procedencia`
 * vivem em `FuncaoUI` e NAO entram aqui: o diagnostico nao ramifica por
 * nenhum deles, e um campo sem consumidor so cria duas fontes para o
 * mesmo dado. Funcao ausente da lista conta como inexistente — o padrao
 * seguro e "o sistema nao sabe fazer", nunca "deve saber".
 */
export interface FatoFuncao {
  id: string;
  existe: boolean;
}

/**
 * "Que nivel o dono configurou para esta Funcao?"
 *
 * `nivel` e o EIXO UNICO, reusado de `conceitos.ts`. Nao existe
 * `concedida` nem `permitida` persistida ao lado — sao derivaveis, e
 * dois campos que precisam concordar para sempre acabam discordando.
 *
 * Permissao AUSENTE e tratada como `bloqueado`: e o padrao seguro ja
 * vigente no catalogo publicado ("ausente = bloqueado: o padrao seguro
 * e 'nao pode', nunca 'pode'").
 */
export interface FatoPermissao {
  funcaoId: string;
  nivel: NivelAutonomia;
}

/**
 * Ate onde a CDS consegue afirmar que a conexao cobre o recurso.
 *
 *   confirmada       ha evidencia de que cobre
 *   ausente          ha evidencia de que NAO cobre
 *   nao_verificavel  a CDS nao tem como saber
 *
 * O terceiro valor e o coracao desta fase. Hoje `lojas` guarda token e
 * validade, e NAO guarda recurso autorizado — entao "Shopee conectada"
 * jamais prova "Shopee Chat autorizado". Sem este valor, o motor teria
 * de escolher entre otimismo (PRONTO) e pessimismo (FALTA_CONEXAO), e
 * as duas seriam invencao.
 */
export const COBERTURAS_RECURSO = ["confirmada", "ausente", "nao_verificavel"] as const;
export type CoberturaRecurso = (typeof COBERTURAS_RECURSO)[number];

/**
 * "Existe conexao para esta plataforma/recurso, e em que estado?"
 *
 * NAO reusa `ConexaoUI`: aquele contrato carrega `rotulo`, `conta`,
 * `atribuida`, `ultimaSincronizacao` e `procedencia` — apresentacao, que
 * o motor nao consulta e nao deve exigir de quem o chama. `estado` SIM e
 * reusado, porque `EstadoConexao` deriva de colunas reais de `lojas`.
 *
 * Nao ha, e nao pode haver, `seller_id`, `shop_id`, `partner_id` nem
 * token: o diagnostico nunca precisou de identificador externo, e um
 * campo desses so serviria para vazar.
 *
 * Fato AUSENTE da lista significa "nao ha conexao" — a ausencia e o
 * dado, nao um estado a mais.
 */
export interface FatoConexao {
  plataforma: string;
  recurso: string;
  estado: EstadoConexao;
  cobertura: CoberturaRecurso;
}

/**
 * Requisito configuravel conhecido de uma conexao ja valida.
 *
 * Generico de proposito: o motor nao sabe o que e webhook, callback ou
 * canal de aviso. Ele recebe uma chave opaca e a situacao dela. Nenhum
 * exemplo de plataforma vira regra fixa aqui dentro.
 *
 * So e avaliado para pares plataforma/recurso que a Skill realmente
 * declarou — configuracao de coisa nao pedida nao vira pendencia.
 */
export const SITUACOES_CONFIGURACAO = ["satisfeita", "ausente", "nao_verificavel"] as const;
export type SituacaoConfiguracao = (typeof SITUACOES_CONFIGURACAO)[number];

export interface FatoConfiguracao {
  plataforma: string;
  recurso: string;
  chave: string;
  situacao: SituacaoConfiguracao;
  obrigatoria: boolean;
}

/**
 * Tudo que o motor recebe. Nada mais entra, e a lista curta e a defesa:
 * nao ha `userId`, `lojaId`, `SupabaseClient`, token nem credencial —
 * autoridade foi resolvida ANTES, por quem tinha como resolve-la.
 */
export interface EntradaDiagnostico {
  skill: Pick<ManifestoSkill, "id" | "requer">;
  funcoes: readonly FatoFuncao[];
  permissoes: readonly FatoPermissao[];
  conexoes: readonly FatoConexao[];
  configuracoes?: readonly FatoConfiguracao[];
}

// ─── Saida ────────────────────────────────────────────────────────────

export const TIPOS_ALVO = ["funcao", "conexao", "configuracao"] as const;
export type TipoAlvo = (typeof TIPOS_ALVO)[number];

/**
 * Um problema, legivel por maquina.
 *
 * `bloqueia` separa BLOQUEADOR de LIMITACAO sem inventar estado novo: a
 * mesma `FALTA_FUNCAO` bloqueia quando a Funcao e obrigatoria e apenas
 * limita quando e opcional. Um par de estados `FALTA_FUNCAO` /
 * `FALTA_FUNCAO_OPCIONAL` dobraria o vocabulario para expressar um
 * booleano.
 *
 * Nao ha campo de texto: a frase para humano e da camada de
 * apresentacao. `estado` + `tipo` + `alvo` sao a chave de mensagem.
 */
export interface Pendencia {
  estado: Exclude<EstadoDiagnostico, "PRONTO">;
  tipo: TipoAlvo;
  /** `mensagens.responder`, `shopee/chat`, `shopee/chat#webhook`. */
  alvo: string;
  bloqueia: boolean;
}

export interface Diagnostico {
  estadoGeral: EstadoDiagnostico;
  /** `true` so quando NENHUMA pendencia bloqueia. Limitacao nao impede. */
  pronto: boolean;
  bloqueios: readonly Pendencia[];
  limitacoes: readonly Pendencia[];
  /**
   * Ids que o agente realmente consegue usar — existem e nao estao
   * bloqueados. Derivado, e o que responde "este agente vai poder o
   * que?" sem que a camada de cima releia os fatos de entrada.
   */
  funcoesUtilizaveis: readonly string[];
}

// ─── Consultas sobre os fatos ─────────────────────────────────────────

const chaveConexao = (plataforma: string, recurso: string) => `${plataforma}/${recurso}`;

/** Ausente = `bloqueado`. Padrao seguro, nunca "pode". */
function nivelDe(funcaoId: string, permissoes: readonly FatoPermissao[]): NivelAutonomia {
  return permissoes.find((p) => p.funcaoId === funcaoId)?.nivel ?? "bloqueado";
}

function existe(funcaoId: string, funcoes: readonly FatoFuncao[]): boolean {
  return funcoes.find((f) => f.id === funcaoId)?.existe === true;
}

function conexaoDe(
  requisito: RequisitoConexao,
  conexoes: readonly FatoConexao[]
): FatoConexao | undefined {
  return conexoes.find(
    (c) => c.plataforma === requisito.plataforma && c.recurso === requisito.recurso
  );
}

// ─── Avaliacao: Funcoes ───────────────────────────────────────────────

/**
 * Existencia ANTES de permissao, e a ordem importa.
 *
 * Um fato pode dizer `nivel: "bloqueado"` para uma Funcao que nem
 * existe. Reportar BLOQUEADO_POR_PERMISSAO ali mandaria o dono liberar
 * uma ferramenta inexistente. Quando nao existe, a permissao e
 * irrelevante e nao vira pendencia.
 */
function avaliarFuncao(
  id: string,
  obrigatoria: boolean,
  entrada: EntradaDiagnostico
): Pendencia | null {
  if (!existe(id, entrada.funcoes)) {
    return { estado: "FALTA_FUNCAO", tipo: "funcao", alvo: id, bloqueia: obrigatoria };
  }

  const nivel = nivelDe(id, entrada.permissoes);
  if (nivel === "bloqueado") {
    return { estado: "BLOQUEADO_POR_PERMISSAO", tipo: "funcao", alvo: id, bloqueia: obrigatoria };
  }
  if (nivel === "aprovacao") {
    // Nunca bloqueia: a Funcao esta disponivel, e cada execucao passa
    // pela fila humana. E politica, nao defeito.
    return { estado: "REQUER_APROVACAO", tipo: "funcao", alvo: id, bloqueia: false };
  }
  return null; // automatico
}

// ─── Avaliacao: Conexoes ──────────────────────────────────────────────

function avaliarConexao(
  requisito: RequisitoConexao,
  entrada: EntradaDiagnostico
): Pendencia | null {
  const alvo = chaveConexao(requisito.plataforma, requisito.recurso);
  const bloqueia = requisito.obrigatoria;
  const fato = conexaoDe(requisito, entrada.conexoes);

  if (fato === undefined) {
    return { estado: "FALTA_CONEXAO", tipo: "conexao", alvo, bloqueia };
  }
  if (fato.estado !== "conectada") {
    // `expirada`, `desconectada` e `erro` sao todos "existe, nao serve".
    return { estado: "CONEXAO_INVALIDA", tipo: "conexao", alvo, bloqueia };
  }
  if (fato.cobertura === "nao_verificavel") {
    // O caso que define esta fase: a conta esta conectada e valida, e
    // ainda assim a CDS nao consegue afirmar que ela cobre o recurso.
    // Nao vira PRONTO (otimismo) nem FALTA_CONEXAO (pessimismo).
    return { estado: "NAO_VERIFICAVEL", tipo: "conexao", alvo, bloqueia };
  }
  if (fato.cobertura === "ausente") {
    // Ha evidencia de que a autorizacao NAO cobre o recurso. Conexao da
    // plataforma existe; conexao que sirva para este recurso, nao.
    return { estado: "FALTA_CONEXAO", tipo: "conexao", alvo, bloqueia };
  }
  return null;
}

// ─── Avaliacao: Configuracoes ─────────────────────────────────────────

function avaliarConfiguracoes(
  requisitos: readonly RequisitoConexao[],
  entrada: EntradaDiagnostico
): Pendencia[] {
  const pedidas = new Set(requisitos.map((r) => chaveConexao(r.plataforma, r.recurso)));
  const saida: Pendencia[] = [];

  for (const cfg of entrada.configuracoes ?? []) {
    const par = chaveConexao(cfg.plataforma, cfg.recurso);
    if (!pedidas.has(par)) continue; // configuracao de coisa nao pedida
    if (cfg.situacao === "satisfeita") continue;

    saida.push({
      estado: cfg.situacao === "ausente" ? "FALTA_CONFIGURACAO" : "NAO_VERIFICAVEL",
      tipo: "configuracao",
      alvo: `${par}#${cfg.chave}`,
      bloqueia: cfg.obrigatoria,
    });
  }
  return saida;
}

// ─── Ordenacao ────────────────────────────────────────────────────────

/**
 * Ordem determinada pelo CONTEUDO, nunca pela ordem de chegada dos
 * fatos. Dois arrays de entrada embaralhados precisam produzir a mesma
 * saida, senao o diagnostico muda de forma sem nenhum fato ter mudado.
 *
 * Criterio: gravidade, depois tipo, depois alvo — os tres totais, entao
 * nao ha empate residual que o `sort` resolva por instabilidade.
 */
function ordenar(pendencias: readonly Pendencia[]): Pendencia[] {
  return [...pendencias].sort((a, b) => {
    const g = peso(a.estado) - peso(b.estado);
    if (g !== 0) return g;
    const t = TIPOS_ALVO.indexOf(a.tipo) - TIPOS_ALVO.indexOf(b.tipo);
    if (t !== 0) return t;
    return a.alvo.localeCompare(b.alvo);
  });
}

// ─── Motor ────────────────────────────────────────────────────────────

/**
 * Diagnostica UMA Skill.
 *
 * Compor varias e fase posterior: conflito, precedencia entre Skills e
 * versao de Ficha compartilhada nao sao decididos aqui. O desenho nao
 * impede a composicao — pendencias sao dados, e unir listas e barato —
 * mas resolver isso agora seria inventar regra sem caso de uso.
 */
export function diagnosticarSkill(entrada: EntradaDiagnostico): Diagnostico {
  const requer = entrada.skill.requer;
  const obrigatorias = requer?.funcoes ?? [];
  const opcionais = requer?.funcoes_opcionais ?? [];

  const pendencias: Pendencia[] = [];

  for (const id of obrigatorias) {
    const p = avaliarFuncao(id, true, entrada);
    if (p !== null) pendencias.push(p);
  }
  for (const id of opcionais) {
    // Funcao opcional ausente NUNCA bloqueia: uma Skill de atendimento
    // util sem WhatsApp nao pode ser reprovada por nao ter WhatsApp.
    const p = avaliarFuncao(id, false, entrada);
    if (p !== null) pendencias.push(p);
  }

  // Deduplicacao por par plataforma/recurso, ANTES de avaliar: a mesma
  // conexao pedida duas vezes e um requisito so, e duas pendencias
  // identicas nao informam nada a mais. `obrigatoria` vence por OR —
  // se qualquer declaracao a exige, ela e exigida.
  const porPar = new Map<string, RequisitoConexao>();
  for (const r of requer?.conexoes ?? []) {
    const k = chaveConexao(r.plataforma, r.recurso);
    const antes = porPar.get(k);
    porPar.set(k, antes ? { ...antes, obrigatoria: antes.obrigatoria || r.obrigatoria } : r);
  }
  const requisitosConexao = [...porPar.values()];

  for (const r of requisitosConexao) {
    const p = avaliarConexao(r, entrada);
    if (p !== null) pendencias.push(p);
  }

  pendencias.push(...avaliarConfiguracoes(requisitosConexao, entrada));

  const bloqueios = ordenar(pendencias.filter((p) => p.bloqueia));
  const limitacoes = ordenar(pendencias.filter((p) => !p.bloqueia));

  // ── O resumo, e a unica regra sutil deste arquivo ──────────────────
  //
  // Duas exigencias puxam para lados opostos:
  //
  //   "aprovacao + resto pronto"        -> REQUER_APROVACAO, nao PRONTO
  //   "opcional ausente + nucleo pronto" -> PRONTO, com a limitacao a parte
  //
  // Resumir por "pior entre TODAS as pendencias" atende a primeira e
  // quebra a segunda: um WhatsApp opcional que falta rebaixaria para
  // FALTA_FUNCAO uma Skill cujo nucleo esta inteiro. Resumir so pelos
  // bloqueios atende a segunda e quebra a primeira.
  //
  // A distincao que resolve: REQUER_APROVACAO qualifica COMO o nucleo
  // roda — as proprias Funcoes que a Skill vai usar passam pela fila
  // humana. Uma limitacao opcional descreve algo FORA do nucleo, que a
  // Skill ja declarou dispensavel.
  //
  // Nada e escondido: `limitacoes` continua com a lista inteira, e o
  // resumo nunca substitui a lista.
  const estadoGeral: EstadoDiagnostico =
    bloqueios.length > 0
      ? bloqueios.reduce<EstadoDiagnostico>(
          (pior, p) => (peso(p.estado) < peso(pior) ? p.estado : pior),
          "PRONTO"
        )
      : limitacoes.some((p) => p.estado === "REQUER_APROVACAO")
        ? "REQUER_APROVACAO"
        : "PRONTO";

  const funcoesUtilizaveis = [...obrigatorias, ...opcionais]
    .filter((id) => existe(id, entrada.funcoes) && nivelDe(id, entrada.permissoes) !== "bloqueado")
    .filter((id, i, todos) => todos.indexOf(id) === i)
    .sort();

  return {
    estadoGeral,
    pronto: bloqueios.length === 0,
    bloqueios,
    limitacoes,
    funcoesUtilizaveis,
  };
}
