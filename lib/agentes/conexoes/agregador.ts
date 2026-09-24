/**
 * Requisito -> selecao -> conexao — SKILL-1D.e-B2.
 *
 * ── A pergunta que este modulo responde ─────────────────────────────
 *
 *   "das conexoes que este agente exige, quais estao resolvidas, quais
 *    ainda nao tem loja escolhida, e qual loja atende cada uma?"
 *
 * Cada peca ja existia e nenhuma se falava. `resolverSkillsDoAgente`
 * sabe QUAIS Skills o agente usa; o manifesto delas declara o que exigem;
 * `resolverFatosPermissoes` sabe QUAIS Funcoes o dono habilitou, e o
 * catalogo declara o que cada uma exige; `resolverSelecoesDoAgente` sabe
 * QUAL loja o dono escolheu para cada requisito; `resolverFatosConexao`
 * sabe se aquela loja SERVE. Este modulo e a costura — e so a costura.
 *
 * ── Duas fontes de requisito, um funil so ───────────────────────────
 *
 * Skills e Funcoes habilitadas sao unidas ANTES da deduplicacao, e o
 * resultado nao carrega proveniencia: o mesmo par declarado pelos dois
 * lados vira UM requisito. Nenhum consumidor publicado pergunta "de onde
 * veio", e proveniencia sem leitor e autoridade sem uso.
 *
 * ── O que ele NAO faz ───────────────────────────────────────────────
 *
 * Nao abre banco: nao importa `getSupabaseServidor`, nao ha `.from(`,
 * `.select(` nem `.eq(` aqui — as tres leituras sao feitas pelas camadas
 * donas de cada tabela. Nao le credencial: `FatoConexao` chega pronto e
 * seguro da camada que e dona do segredo. Nao diagnostica:
 * `diagnosticarSkill` continua sendo o motor, e recebe FATOS. Nao
 * escreve e nao decide permissao — le o nivel que o dono ja gravou.
 *
 * E, acima de tudo, nao ESCOLHE loja. Requisito sem selecao persistida
 * sai em `semSelecao` — nunca vira "a primeira loja compativel". Selecao
 * que aponta para loja de OUTRO provedor nao vira binding, e o requisito
 * simplesmente fica sem fato: ver `bindingsValidados`.
 *
 * ── Por que UMA chamada em lote, e nao um laco ──────────────────────
 *
 * `resolverFatoConexao` custa uma leitura de `lojas` por requisito, e
 * cada leitura projeta credencial. A auditoria da 1D.e-A2 mediu que nao
 * existe teto estrutural de requisitos: `requer.conexoes` escapa do
 * limite de lista do parser, um agente pode ter quantas Skills quiser e
 * `recurso` e slug aberto. Por isso o join inteiro acontece ANTES, e a
 * camada de conexao e chamada exatamente uma vez.
 *
 * ── Tudo ou nada ────────────────────────────────────────────────────
 *
 * Falha em qualquer das QUATRO leituras devolve as quatro colecoes
 * VAZIAS. Uma resposta parcial apresentada como completa faria o
 * diagnostico afirmar "esta conexao falta" sobre algo que ninguem chegou
 * a apurar — e o mesmo vale para `permissoes`: vazio com `coleta` de
 * falha significa "nao li", jamais "o dono nao habilitou nada".
 */
import "server-only";
import { resolverSkillsDoAgente } from "@/lib/agentes/skills/fatos";
import { resolverSelecoesDoAgente } from "@/lib/agentes/conexoes/selecao-fatos";
import { resolverFatosConexao, type PedidoConexao } from "@/lib/agentes/conexoes/fatos";
import { resolverFatosPermissoes } from "@/lib/agentes/permissoes/fatos";
import { FUNCOES, listarFuncoesRegistradas } from "@/lib/agentes/funcoes/registry";
import type { FatoConexao, FatoPermissao } from "@/lib/ia/skills/diagnostico";
import type { RequisitoConexao } from "@/lib/ia/skills/contrato";

/**
 * Dois campos, e a lista curta e a defesa: nao ha `lojaId`, `plataforma`,
 * `recurso` nem selecao na entrada. Descobrir a loja a partir da escolha
 * PERSISTIDA e justamente a razao de existir deste modulo — aceita-la de
 * fora devolveria ao chamador a decisao que a 1D.g tirou dele.
 *
 * `agoraMs` entra por parametro, como em `resolverFatosConexao`: a
 * avaliacao de expiracao depende do tempo, e o determinismo e do
 * pipeline inteiro.
 */
export interface EntradaConexoesDoAgente {
  userId: string;
  agenteId: string;
  agoraMs: number;
  /**
   * OPCIONAL. O sinal RIGIDO da acao, repassado INTACTO aos dois
   * resolvedores que esta composicao usa. Ausente, nada muda.
   */
  signal?: AbortSignal;
}

/**
 * Como a composicao terminou.
 *
 * Nao ha `ausente`: ausencia aqui nao e da colecao, e de cada item —
 * requisito sem loja escolhida vai para `semSelecao`, e requisito cuja
 * loja nao serve simplesmente nao produz fato.
 */
export type ColetaConexoesDoAgente = "ok" | "falha_leitura" | "entrada_invalida";

/**
 * As duas colecoes, e a diferenca entre elas e o ponto do modulo.
 *
 * `conexoes` entra SEM ADAPTADOR em `EntradaDiagnostico.conexoes`: fato
 * ausente da lista ja significa "nao ha conexao" para `avaliarConexao`.
 *
 * `semSelecao` guarda o que o diagnostico de hoje nao consegue
 * distinguir. "Voce nao escolheu a loja" e "a conta escolhida nao cobre
 * o recurso" pedem acoes diferentes do dono, e as duas colapsariam em
 * `FALTA_CONEXAO`. Preservar a informacao aqui custa nada e nao inventa
 * estado novo no vocabulario publicado.
 *
 * Um requisito nunca aparece nas duas: ou tem selecao, ou nao tem.
 */
export interface ResultadoConexoesDoAgente {
  conexoes: readonly FatoConexao[];
  semSelecao: readonly RequisitoConexao[];
  bindings: readonly BindingConexao[];
  /**
   * Os fatos de permissao do CATALOGO INTEIRO — exatamente os ids de
   * `listarFuncoesRegistradas()`, sempre, sem recorte.
   *
   * ── Por que ele e publicado ─────────────────────────────────────
   *
   * Este modulo precisa do conjunto completo para saber quais Funcoes o
   * dono habilitou, e o compositor precisa de um subconjunto dele para o
   * motor. Dois leitores da MESMA tabela, na mesma requisicao, seriam uma
   * leitura duplicada — e a que chegasse segunda nao acrescentaria fato
   * nenhum. Quem ja leu publica; quem precisa, filtra.
   *
   * ── Por que a direcao e esta, e nao a inversa ───────────────────
   *
   * A alternativa era o caller ENTREGAR os fatos por parametro. Os dois
   * consumidores de producao carregam recortes — o compositor tem o
   * subconjunto declarado pelas Skills, o executor tem SO a Funcao em
   * execucao —, e entregar qualquer um deles encolheria o feed sem erro
   * de tipo e sem sintoma. Publicando em vez de receber, passar um
   * subconjunto deixa de ser um erro possivel: nao ha por onde.
   *
   * ── Ausencia nao e materializada ────────────────────────────────
   *
   * Funcao registrada SEM linha em `agente_permissoes` simplesmente nao
   * tem fato aqui, e ausencia significa `bloqueado` — a mesma regra do
   * guard. Inventar `{ nivel: "bloqueado" }` criaria uma linha que o dono
   * nunca escreveu e que ninguem saberia distinguir de uma escolha.
   *
   * ── Vazio com `coleta !== "ok"` NAO e resposta ──────────────────
   *
   * Quando a coleta falha esta lista sai vazia por representacao, nunca
   * por apuracao. Consumidor que a lesse sem conferir `coleta` afirmaria
   * "nenhuma Funcao habilitada" sobre algo que ninguem chegou a ler.
   */
  permissoes: readonly FatoPermissao[];
  /**
   * TODO requisito real do agente, um por entrada, com o que ja se sabe
   * da escolha feita para ele.
   *
   * ── Por que esta colecao precisou existir ───────────────────────
   *
   * As outras tres dispersam os requisitos em tres destinos: sem selecao
   * vai para `semSelecao`; com selecao compativel vira `conexoes` +
   * `bindings`; e com selecao apontando para loja de OUTRO provedor nao
   * aparece em nenhum dos dois — o fato nao nasce e o binding e
   * descartado. Um consumidor que reconstruisse a lista como
   * `semSelecao UNION bindings` perderia exatamente o caso que o dono
   * mais precisa ver e corrigir.
   *
   * Aqui o terceiro caso e visivel: `lojaIdSelecionada` preenchido com
   * `utilizavel: false` significa "voce escolheu uma conta, e ela nao
   * serve para este requisito".
   *
   * ── Custo ───────────────────────────────────────────────────────
   *
   * ZERO leitura. Tudo sai de `requisitos`, `selecaoPorPar` e dos
   * bindings ja calculados neste mesmo escopo.
   *
   * ── Para quem ela e ─────────────────────────────────────────────
   *
   * Para superficies de CONFIGURACAO, que precisam mostrar o que esta
   * escolhido e o que falta. Quem EXECUTA continua usando `bindings`:
   * `lojaIdSelecionada` e a escolha CRUA, e agir contra ela seria agir
   * contra a conta que a camada de fatos recusou.
   */
  requisitos: readonly RequisitoResolvido[];
  coleta: ColetaConexoesDoAgente;
}

/** Um requisito real, com o estado da escolha feita para ele. */
export interface RequisitoResolvido {
  readonly plataforma: string;
  readonly recurso: string;
  readonly obrigatoria: boolean;
  /** A escolha PERSISTIDA, mesmo quando ela nao serve. `null` = nenhuma. */
  readonly lojaIdSelecionada: string | null;
  /** Houve binding validado para este par? */
  readonly utilizavel: boolean;
}

/**
 * O vinculo VALIDADO entre um requisito e a loja que o atende.
 *
 * ── Por que ele nao e simplesmente a selecao ────────────────────────
 *
 * `agente_conexoes` nao tem — e nao pode ter hoje — invariante de banco
 * amarrando `plataforma` ao marketplace da loja: a FK composta
 * `(loja_id, user_id) -> lojas(id, user_id)` prova DONO, nao PROVEDOR.
 * Entao existe estruturalmente uma linha `(mercado_livre, perguntas,
 * <loja Shopee do mesmo dono>)`, e `resolverSelecoesDoAgente` a devolve
 * como selecao valida — `confirmarLojas` so confere propriedade.
 *
 * Quem confronta `lojas.marketplace` com a plataforma esperada e
 * `fatoDaLinha`, la em `fatos.ts`, e ela responde com AUSENCIA de fato.
 * Por isso o binding e derivado da INTERSECAO com os fatos, nunca dos
 * pedidos crus: publicar `pedidos` entregaria um `lojaId` de outro
 * provedor a quem fosse usa-lo para agir.
 *
 * ── E por que ele nao mora em `FatoConexao` ─────────────────────────
 *
 * `FatoConexao` tem quatro campos por contrato publicado, e `lojaId` foi
 * deliberadamente deixado de fora dele. Alarga-lo para carregar o
 * vinculo mudaria um contrato que outros consumidores ja leem. A lista
 * paralela custa nada e nao mexe em contrato alheio.
 */
export interface BindingConexao {
  readonly plataforma: string;
  readonly recurso: string;
  readonly lojaId: string;
}

const VAZIO = Object.freeze({
  conexoes: Object.freeze([]) as readonly FatoConexao[],
  semSelecao: Object.freeze([]) as readonly RequisitoConexao[],
  bindings: Object.freeze([]) as readonly BindingConexao[],
  permissoes: Object.freeze([]) as readonly FatoPermissao[],
  requisitos: Object.freeze([]) as readonly RequisitoResolvido[],
});

const ENTRADA_INVALIDA: ResultadoConexoesDoAgente = Object.freeze({
  ...VAZIO,
  coleta: "entrada_invalida" as const,
});

const FALHA: ResultadoConexoesDoAgente = Object.freeze({
  ...VAZIO,
  coleta: "falha_leitura" as const,
});

/**
 * "Nenhum requisito" — resposta COMPLETA, com o snapshot que a produziu.
 *
 * Nao e mais constante: `permissoes` foi de fato apurado para chegar
 * aqui, e devolver a lista vazia faria o compositor concluir que o dono
 * nao habilitou nada quando a verdade pode ser "habilitou, e nenhuma
 * dessas Funcoes exige conexao".
 */
const semRequisitos = (
  permissoes: readonly FatoPermissao[]
): ResultadoConexoesDoAgente =>
  Object.freeze({ ...VAZIO, permissoes, coleta: "ok" as const });

/**
 * Compoe `requisitos` a partir do que ja esta em memoria.
 *
 * A ordem e a deduplicacao vem de `requisitos` — que `requisitosDeduplicados`
 * ja entregou ordenado por plataforma e recurso e sem repeticao. Esta
 * funcao NAO reordena e NAO filtra: ela anota.
 */
function requisitosResolvidos(
  requisitos: readonly RequisitoConexao[],
  selecaoPorPar: ReadonlyMap<string, ReadonlyMap<string, string>>,
  bindings: readonly BindingConexao[]
): readonly RequisitoResolvido[] {
  const utilizaveis = new Map<string, Set<string>>();
  for (const b of bindings) {
    let recursos = utilizaveis.get(b.plataforma);
    if (recursos === undefined) {
      recursos = new Set<string>();
      utilizaveis.set(b.plataforma, recursos);
    }
    recursos.add(b.recurso);
  }

  return Object.freeze(
    requisitos.map((r) => ({
      plataforma: r.plataforma,
      recurso: r.recurso,
      obrigatoria: r.obrigatoria,
      lojaIdSelecionada: selecaoPorPar.get(r.plataforma)?.get(r.recurso) ?? null,
      utilizavel: utilizaveis.get(r.plataforma)?.has(r.recurso) === true,
    }))
  );
}

/**
 * Os requisitos das DUAS fontes, deduplicados e ordenados.
 *
 * Skills declaram conexao no manifesto; Funcoes habilitadas declaram em
 * `conexaoNecessaria`. A uniao acontece AQUI, num funil so, e nao em dois
 * caminhos paralelos que precisariam concordar para sempre.
 *
 * ── Identidade ──────────────────────────────────────────────────────
 *
 * `(plataforma, recurso)`, e nada alem. `obrigatoria` NAO entra na
 * identidade — ela e atributo do requisito, nao parte dele —, e por isso
 * duas declaracoes do mesmo par com exigencias diferentes viram UMA, com
 * `obrigatoria` combinada por OR: se qualquer Skill a exige, ela e
 * exigida. Mesma regra que `diagnosticarSkill` ja aplica dentro de uma
 * Skill; aqui ela vale ENTRE Skills.
 *
 * `skill_id`, slug e versao ficam de fora: nenhum consumidor publicado
 * os le, e proveniencia sem leitor e autoridade sem uso.
 *
 * ── Mapa aninhado, nao chave de texto ───────────────────────────────
 *
 * `Map<plataforma, Map<recurso, ...>>` em vez de `${p}/${r}`: os dois
 * campos sao slugs livres, e concatenar com separador cria a chance de
 * colisao que a estrutura simplesmente nao tem. `chaveConexao` existe em
 * `diagnostico.ts`, mas nao e exportada — e exporta-la exigiria editar um
 * arquivo fora desta frente.
 *
 * ── Ordem ───────────────────────────────────────────────────────────
 *
 * plataforma, depois recurso — a MESMA de `ordenarSelecoes`. Ela dirige
 * o join, os pedidos e as duas colecoes de saida; sem ela, a ordem das
 * Skills (ou a do banco) decidiria a da resposta.
 */
function requisitosDeduplicados(
  skills: readonly { manifesto: { requer?: { conexoes?: readonly RequisitoConexao[] } } }[],
  deFuncoes: readonly RequisitoConexao[] = []
): readonly RequisitoConexao[] {
  const porPlataforma = new Map<string, Map<string, RequisitoConexao>>();

  const declaracoes: RequisitoConexao[] = [];
  for (const s of skills) for (const r of s.manifesto.requer?.conexoes ?? []) declaracoes.push(r);
  // As Funcoes entram DEPOIS das Skills e passam pelo MESMO funil. Nao ha
  // ramo proprio, nao ha precedencia e nao ha proveniencia no resultado:
  // quem consome um requisito age igual, tenha ele vindo de um manifesto
  // ou do catalogo.
  for (const r of deFuncoes) declaracoes.push(r);

  for (const r of declaracoes) {
    let porRecurso = porPlataforma.get(r.plataforma);
    if (porRecurso === undefined) {
      porRecurso = new Map<string, RequisitoConexao>();
      porPlataforma.set(r.plataforma, porRecurso);
    }
    const antes = porRecurso.get(r.recurso);
    porRecurso.set(
      r.recurso,
      antes === undefined
        ? { plataforma: r.plataforma, recurso: r.recurso, obrigatoria: r.obrigatoria }
        : { ...antes, obrigatoria: antes.obrigatoria || r.obrigatoria }
    );
  }

  const saida: RequisitoConexao[] = [];
  for (const porRecurso of porPlataforma.values()) for (const r of porRecurso.values()) saida.push(r);

  return saida.sort((a, b) =>
    a.plataforma === b.plataforma
      ? a.recurso.localeCompare(b.recurso)
      : a.plataforma.localeCompare(b.plataforma)
  );
}

/**
 * Os requisitos das Funcoes HABILITADAS para este agente.
 *
 * ── Habilitada = o dono nao proibiu ─────────────────────────────────
 *
 * `aprovacao` e `automatico` habilitam; `bloqueado` nao. Linha AUSENTE
 * tambem nao: o padrao seguro deste sistema inteiro e "nao pode", e
 * `resolverFatosPermissoes` simplesmente nao produz fato para o que o
 * dono nunca configurou — entao a ausencia cai neste filtro sozinha, sem
 * ramo proprio que pudesse divergir do guard.
 *
 * ── Por que NAO se percorre o catalogo inteiro ──────────────────────
 *
 * O registry diz quais Funcoes EXISTEM, nunca quais este agente pode
 * usar. Derivar requisito de toda Funcao registrada faria um agente sem
 * permissao nenhuma exigir conta de marketplace — e a tela de Conexoes
 * passaria a cobrar do dono uma ligacao que nada usaria. O catalogo aqui
 * so fornece os IDS a consultar e, depois, a DEFINICAO de quem passou.
 *
 * ── `obrigatoria: true`, sempre ─────────────────────────────────────
 *
 * Uma Skill pode declarar conexao opcional porque degrada de propria
 * vontade. Funcao nao degrada: `conexaoNecessaria` e o requisito de
 * execucao, e sem ele o guard nega `conexao_ausente`. Emitir
 * `obrigatoria: false` descreveria como preferencia o que e condicao.
 */
function requisitosDeFuncoesHabilitadas(
  permissoes: readonly FatoPermissao[]
): readonly RequisitoConexao[] {
  const saida: RequisitoConexao[] = [];

  for (const p of permissoes) {
    if (p.nivel !== "aprovacao" && p.nivel !== "automatico") continue;
    // `hasOwnProperty`, nunca `in`: `constructor` e `toString` nao sao
    // Funcoes registradas, e a mesma recusa ja vale em `classificarFuncaoId`.
    if (!Object.prototype.hasOwnProperty.call(FUNCOES, p.funcaoId)) continue;

    const requisito = FUNCOES[p.funcaoId].conexaoNecessaria;
    if (requisito === null) continue;

    saida.push({
      plataforma: requisito.plataforma,
      recurso: requisito.recurso,
      obrigatoria: true,
    });
  }

  return saida;
}

/**
 * Os vinculos que sobreviveram a validacao de provedor.
 *
 * ── A regra, em uma frase ───────────────────────────────────────────
 *
 * Um pedido vira binding se, e somente se, aquele par produziu FATO.
 *
 * E produzir fato e, hoje e sempre, ter passado pelo confronto entre
 * `lojas.marketplace` e a plataforma esperada, dentro de `fatoDaLinha`.
 * O binding nao repete essa comparacao: ele a HERDA. Reimplementa-la
 * aqui criaria uma segunda autoridade sobre a mesma pergunta, que e
 * exatamente o modo de falha que este repositorio ja pagou para aprender.
 *
 * ── Zero leitura ────────────────────────────────────────────────────
 *
 * `pedidos` e `fatos` ja estao em memoria neste escopo. A derivacao e
 * uma intersecao, nao uma consulta.
 *
 * ── Mapa aninhado, nao chave concatenada ────────────────────────────
 *
 * Mesma razao de `requisitosDeduplicados`: `plataforma` e `recurso` sao
 * slugs livres, e `${p}/${r}` cria a chance de colisao que a estrutura
 * aninhada simplesmente nao tem.
 */
function bindingsValidados(
  pedidos: readonly PedidoConexao[],
  fatos: readonly FatoConexao[]
): readonly BindingConexao[] {
  const paresComFato = new Map<string, Set<string>>();
  for (const f of fatos) {
    let recursos = paresComFato.get(f.plataforma);
    if (recursos === undefined) {
      recursos = new Set<string>();
      paresComFato.set(f.plataforma, recursos);
    }
    recursos.add(f.recurso);
  }

  const saida: BindingConexao[] = [];
  for (const p of pedidos) {
    if (paresComFato.get(p.plataforma)?.has(p.recurso) !== true) continue;
    saida.push({ plataforma: p.plataforma, recurso: p.recurso, lojaId: p.lojaId });
  }

  return Object.freeze(saida);
}

/**
 * Compoe as conexoes de UM agente.
 *
 * ── A ordem das leituras, e por que ela e essa ──────────────────────
 *
 * Skills primeiro, porque sem requisito nao ha o que perguntar: agente
 * sem Skill, ou com Skills que nao exigem conexao, custa UMA ou DUAS
 * leituras e nenhuma a mais. Selecoes depois, uma vez so. Conexoes por
 * ultimo, tambem uma vez so, com o join inteiro ja resolvido.
 *
 * ── O join e dirigido pelos REQUISITOS ──────────────────────────────
 *
 * Percorre-se requisito a requisito procurando a selecao EXATA do par —
 * nunca o contrario. E isso que faz selecao obsoleta ser simplesmente
 * ignorada: se `(shopee, pedidos)` esta persistida mas nenhuma Skill a
 * exige mais, ela nao aparece em lugar nenhum e nao vai ao lote.
 *
 * O match e pelos DOIS campos. Casar so por plataforma faria
 * `(shopee, chat)` herdar a loja escolhida para `(shopee, pedidos)` —
 * agir na conta errada por conta de um requisito que ninguem configurou.
 */
export async function resolverConexoesDoAgente(
  entrada: EntradaConexoesDoAgente
): Promise<ResultadoConexoesDoAgente> {
  const { userId, agenteId, agoraMs } = entrada;

  // Sem autoridade nao ha pergunta a fazer. Zero leitura.
  if (!userId || !agenteId) return ENTRADA_INVALIDA;

  const skills = await resolverSkillsDoAgente({ userId, agenteId });
  if (skills.coleta !== "ok") {
    // "Nao consegui ler os requisitos" NUNCA vira "o agente nao tem
    // requisitos": a segunda afirmacao produziria um diagnostico limpo
    // sobre uma verdade que ninguem apurou.
    return skills.coleta === "entrada_invalida" ? ENTRADA_INVALIDA : FALHA;
  }

  // ── A SEGUNDA fonte de requisitos ─────────────────────────────────
  //
  // UMA leitura, com `.in("funcao_id", ids)` — nunca uma por Funcao. O
  // catalogo e resolvido em memoria depois, e por isso o custo nao cresce
  // com o tamanho dele.
  //
  // Ela acontece mesmo quando o agente nao tem Skill: o curto-circuito de
  // "nenhum requisito" desceu para DEPOIS da uniao, porque antes dela a
  // resposta ainda nao esta apurada. E uma leitura constante a mais no
  // caso vazio, declarada e aceita — nao um N+1.
  const permissoes = await resolverFatosPermissoes({
    signal: entrada.signal,
    userId,
    agenteId,
    funcaoIds: listarFuncoesRegistradas(),
  });
  if (permissoes.coleta !== "ok") {
    // Mesma regra das Skills: "nao consegui ler" nunca vira "nao exige".
    return permissoes.coleta === "entrada_invalida" ? ENTRADA_INVALIDA : FALHA;
  }

  const requisitos = requisitosDeduplicados(
    skills.skills,
    requisitosDeFuncoesHabilitadas(permissoes.fatos)
  );

  // Nenhum requisito e resposta COMPLETA, nao ausencia de resposta. Nada
  // a cruzar, nada a resolver: as duas leituras seguintes nem acontecem.
  if (requisitos.length === 0) return semRequisitos(permissoes.fatos);

  const selecoes = await resolverSelecoesDoAgente({
    signal: entrada.signal, userId, agenteId });
  if (selecoes.coleta !== "ok") {
    return selecoes.coleta === "entrada_invalida" ? ENTRADA_INVALIDA : FALHA;
  }

  // Indexacao pelo par, na mesma forma da deduplicacao — o join e uma
  // busca exata, nunca uma varredura com criterio parcial.
  const selecaoPorPar = new Map<string, Map<string, string>>();
  for (const s of selecoes.selecoes) {
    let porRecurso = selecaoPorPar.get(s.plataforma);
    if (porRecurso === undefined) {
      porRecurso = new Map<string, string>();
      selecaoPorPar.set(s.plataforma, porRecurso);
    }
    porRecurso.set(s.recurso, s.lojaId);
  }

  const semSelecao: RequisitoConexao[] = [];
  const pedidos: PedidoConexao[] = [];

  for (const r of requisitos) {
    const lojaId = selecaoPorPar.get(r.plataforma)?.get(r.recurso);
    if (lojaId === undefined) {
      semSelecao.push(r);
      continue;
    }
    // O pedido carrega o TRIO minimo. `obrigatoria` fica de fora: a
    // camada de conexao responde se a loja serve, nao o quanto ela
    // importa.
    pedidos.push({ plataforma: r.plataforma, recurso: r.recurso, lojaId });
  }

  // Nenhum requisito escolhido: a colecao de fatos e vazia por direito, e
  // o lote nao roda. Uma consulta sem pedido seria round trip para
  // responder o que ja se sabe.
  if (pedidos.length === 0) {
    return {
      conexoes: VAZIO.conexoes,
      semSelecao,
      bindings: VAZIO.bindings,
      permissoes: permissoes.fatos,
      // Sem pedido nenhum, todo requisito esta sem selecao utilizavel.
      requisitos: requisitosResolvidos(requisitos, selecaoPorPar, VAZIO.bindings),
      coleta: "ok",
    };
  }

  const fatos = await resolverFatosConexao({ userId, pedidos, agoraMs });
  if (fatos.coleta !== "ok") {
    // `semSelecao` ja estava calculado — e nao sai assim mesmo. Devolver
    // metade da resposta com aparencia de resposta inteira e o modo de
    // falha que este envelope existe para impedir.
    return FALHA;
  }

  // Os fatos saem exatamente como a camada de conexao os produziu:
  // `estado`, `cobertura`, `ativo`, `marketplace` e validade sao dela, e
  // reinterpretar qualquer um aqui criaria uma segunda autoridade sobre a
  // mesma pergunta. Requisito com selecao cuja loja nao serve nao aparece
  // em `conexoes` NEM em `semSelecao`: a escolha existe, e a ausencia do
  // fato ja e o que `avaliarConexao` le como falta de conexao.
  // Os bindings saem da INTERSECAO com os fatos, nunca de `pedidos`: um
  // pedido cru pode apontar para loja de outro provedor, e publicar esse
  // `lojaId` entregaria a quem for AGIR uma conta que a camada de fatos
  // ja recusou. Ver o docblock de `bindingsValidados`.
  const bindings = bindingsValidados(pedidos, fatos.fatos);

  return {
    conexoes: fatos.fatos,
    semSelecao,
    bindings,
    permissoes: permissoes.fatos,
    requisitos: requisitosResolvidos(requisitos, selecaoPorPar, bindings),
    coleta: "ok",
  };
}
