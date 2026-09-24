/**
 * Catalogo canonico de FUNCOES executaveis — SKILL-1D.b.
 *
 * ── A pergunta que este modulo e a unica fonte para responder ───────
 *
 *   "Esta Funcao existe de verdade na CDS?"
 *
 * E a resposta nao e um campo. E a presenca de um EXECUTOR neste mapa.
 * Nao existe `existe: true` para alguem escrever — se ha entrada, ha
 * codigo que roda; se nao ha entrada, a Funcao nao existe. Uma tabela ou
 * uma lista de strings permitiriam declarar Funcao sem executor, que e
 * exatamente a mentira que este catalogo existe para impedir.
 *
 * ── FUNCAO nao e TIPO DE TAREFA ─────────────────────────────────────
 *
 * `lib/agentes/handlers/registry.ts` mapeia TIPOS DE TAREFA da fila:
 * `analise_vendas`, `teste_fundacao`. Sao coisas diferentes:
 *
 *   tipo de tarefa   unidade enfileiravel, semantica AT-LEAST-ONCE,
 *                    presa a `agente_tarefas` (claim, heartbeat, status)
 *   Funcao           capacidade invocavel, com entrada e saida proprias,
 *                    executavel FORA da maquina de estados
 *
 * Os dois registries sao deliberadamente separados e nenhum deriva do
 * outro. Promover um tipo de tarefa a Funcao por renomeacao seria dar
 * nome de ferramenta a uma linha de fila.
 *
 * ── Quem NAO registra ───────────────────────────────────────────────
 *
 * Skill nao registra: ela REFERENCIA ids e nunca declara existencia.
 * Modelo nao registra: nao ha registro dinamico, nao ha `tools` vindas
 * de fora. Banco nao registra: catalogo e codigo. O mapa e congelado no
 * modulo e nao aceita mutacao em runtime — `FUNCOES[x] = ...` tornaria a
 * existencia dependente da ordem de import, o tipo de bug que nao
 * aparece em teste.
 *
 * ── `import "server-only"` ──────────────────────────────────────────
 *
 * Explicito, e tambem verdadeiro por transitividade: os executores
 * alcancam `lib/agentes/dados/vendas.ts`, que instancia a service_role.
 * Uma UI que precise saber se uma Funcao existe pedira isso ao servidor
 * — nao importando este modulo.
 */
import type { LimiteExterno } from "@/lib/controle-tempo";
import "server-only";
import {
  criarLeiturasDeVendas,
  validarFiltroVendas,
  type FiltroVendas,
  type ResultadoVendas,
} from "@/lib/agentes/dados/vendas";
import {
  CONEXAO_PERGUNTAS_ML,
  executarPerguntasML,
  interpretarSaidaPerguntasML,
  validarEntradaPerguntasML,
} from "@/lib/agentes/funcoes/mercadolivre-perguntas";

// ─── Contexto de autoridade ───────────────────────────────────────────

/**
 * O MINIMO que um executor precisa para saber de quem sao os dados.
 *
 * Um campo, e a lista curta e a defesa. Nao ha `seller_id`, `shop_id`,
 * `partner_id`, token nem credencial: nenhum deles e autoridade — a
 * migration `20260826_lojas_autoridade_dono.sql` fixou que autoridade e
 * `user_id + loja_id`, e `seller_id` e atributo externo que o mesmo
 * seller compartilhado entre donos torna inutil como identidade.
 *
 * O contexto vem da sessao/runtime. NUNCA dos argumentos, e nunca do
 * modelo — e por isso ele e o PRIMEIRO parametro, separado do segundo:
 * a assinatura torna impossivel confundir "quem esta pedindo" com "o que
 * foi pedido".
 */

/**
 * A Connection que o executor pode usar — identidade, nunca credencial.
 *
 * ── Por que `lojaId` passou a existir aqui ──────────────────────────
 *
 * Ate a M2-I1 o contexto era so `userId`, porque a unica Funcao real
 * (`vendas.consultar`) le tabela propria e nao tem requisito de conexao.
 * Uma Funcao CONECTADA precisa saber contra QUAL conta agir, e com varias
 * contas do mesmo marketplace no mesmo dono nao existe "a conta obvia":
 * escolher dentro do executor seria decidir pelo dono qual conta sofre o
 * efeito.
 *
 * ── Os tres campos andam JUNTOS ─────────────────────────────────────
 *
 * `lojaId` solto perderia o invariante de que aquela loja foi escolhida
 * para AQUELE par `(plataforma, recurso)` e aprovada para ele. O
 * sub-objeto amarra os tres num valor so.
 *
 * ── O que NAO entra, e nao por esquecimento ─────────────────────────
 *
 * Sem `access_token`, `refresh_token`, `client_secret`, `partner_key`,
 * `seller_id` ou `shop_id`. A fronteira onde o segredo morre continua
 * sendo `conexoes/fatos.ts`, e nada dela atravessa para ca. `lojaId` e o
 * UUID interno de `lojas` — vinculo, nao credencial: com ele sozinho nao
 * se chama API nenhuma.
 */
export interface ConexaoDoContexto {
  readonly plataforma: string;
  readonly recurso: string;
  readonly lojaId: string;
}

/**
 * ── `conexao` e `| null`, nunca opcional ────────────────────────────
 *
 * `conexao?: ...` deixaria um chamador esquecer o campo e receber
 * `undefined` sem erro de tipo — a Funcao conectada quebraria em runtime
 * em vez de quebrar na compilacao. `| null` obriga a decisao explicita.
 *
 * O invariante e exato: `null` se e somente se a definicao tem
 * `conexaoNecessaria === null`. Quando ha requisito, o valor chega
 * preenchido e JA autorizado pelo guard — o executor nunca re-resolve.
 */
export interface ContextoFuncao {
  readonly userId: string;
  readonly conexao: ConexaoDoContexto | null;
  /**
   * O orcamento COMPARTILHADO do provider — OPCIONAL e INTERNO.
   *
   * Existe para que uma Funcao que fala com o marketplace respeite o
   * relogio de quem a chamou, em vez de abrir um limite proprio. Quem
   * nao o recebe se comporta exatamente como antes, e nenhuma Funcao e
   * obrigada a entende-lo: `vendas.consultar` o ignora.
   *
   * NAO vem dos argumentos, NAO vem da rota, NAO vem do n8n, e NAO e
   * serializado: um `AbortSignal` nao vira JSON e um instante de relogio
   * deste processo nao significa nada em outro. Por isso ele tambem
   * nunca entra em auditoria.
   */
  readonly limiteDoProvider?: LimiteExterno;
}

/**
 * A assinatura de todo executor.
 *
 * `argumentos: unknown` de proposito. Argumento vem de fora — de uma
 * Skill, de uma tarefa, um dia de um modelo — e por isso o executor
 * VALIDA, nunca faz cast confiante. O contrato de saida tambem e
 * `unknown` no nivel do registry: cada Funcao tem o seu, e conhece-lo e
 * responsabilidade de quem a chama.
 */
export type ExecutorFuncao = (
  contexto: ContextoFuncao,
  argumentos: unknown
) => Promise<unknown>;

/**
 * Um requisito de conexao externa.
 *
 * A forma e `(plataforma, recurso)` porque e exatamente como
 * `agente_conexoes` chaveia a atribuicao — PK `(agente_id, plataforma,
 * recurso)` — e como `FatoConexao` ja chega ao diagnostico. Uma terceira
 * forma aqui obrigaria uma traducao, e traducao entre autoridade e
 * requisito e onde erro de escopo se esconde.
 *
 * Nao ha `loja_id`: QUAL loja atende o requisito e decisao de quem
 * resolve a conexao do agente, nunca do catalogo. E nao ha credencial,
 * token nem `seller_id` — a fronteira onde o segredo morre e
 * `conexoes/fatos.ts`, e nada dela atravessa para ca.
 */
export interface RequisitoConexaoFuncao {
  plataforma: string;
  recurso: string;
}

// ─── Entrada e saida: o que cada Funcao sabe sobre si ─────────────────

/**
 * O veredicto sobre os ARGUMENTOS, antes de qualquer execucao.
 *
 * ── Por que o catalogo passou a ter isto ────────────────────────────
 *
 * Ate a TOOL-CALL-B este contrato nao existia, e o docblock abaixo
 * dizia por que: `vendas.consultar` ja validava dentro do proprio
 * executor, entao um campo aqui duplicaria a regra. A condicao que ele
 * mesmo registrou — "quando existir uma Funcao cuja validacao NAO tenha
 * dono" — foi atingida por outro caminho.
 *
 * O executor generico precisa recusar entrada invalida ANTES de abrir a
 * Tool Call, porque abertura significa "o executor vai ser chamado
 * agora". Desse ponto de vista a regra nao tem dono alcancavel: chamar
 * a Funcao para descobrir se o argumento serve seria executa-la.
 *
 * A alternativa era um `switch (funcaoId)` dentro do executor — uma
 * segunda registry de comportamento por Tool, exatamente o que este
 * modulo existe para impedir.
 *
 * ── O que ele NAO faz ───────────────────────────────────────────────
 *
 * Nao normaliza. `validarFiltroVendas` nao normaliza hoje, e devolver
 * argumentos "corrigidos" inventaria comportamento que ninguem pediu —
 * o executor repassa o argumento ORIGINAL. Nao faz I/O, nao lanca por
 * contrato, e nao concede capacidade nenhuma: dizer que uma entrada e
 * valida nao diz que o agente pode usar a Funcao.
 *
 * `codigo` e detalhe de DOMINIO (`janela_excedida`), nunca a categoria
 * de infraestrutura — essa e sempre `entrada_invalida` na Tool Call.
 */
export type ResultadoValidacaoEntrada =
  | { valida: true }
  | { valida: false; codigo: string };

export type ValidadorEntrada = (argumentos: unknown) => ResultadoValidacaoEntrada;

/**
 * O veredicto sobre a SAIDA que o executor devolveu.
 *
 * ── O problema exato que ele resolve ────────────────────────────────
 *
 * `vendas.consultar` devolve `{ linhas, truncado, erro }` e sinaliza
 * falha POR VALOR: `erro: "erro_consulta_vendas"` e uma consulta que
 * falhou, nao um resultado vazio. O executor generico recebe `unknown`
 * e, sem conhecer a forma, chamaria isso de sucesso — gravando na
 * auditoria que a Funcao funcionou quando ela nao funcionou.
 *
 * Quem sabe ler o resultado e a propria Funcao. Por isso o interpretador
 * mora aqui, ao lado do executor que o produz.
 *
 * ── Tres estados, e nao dois ────────────────────────────────────────
 *
 *   sucesso    `data` e o resultado canonico que vai para o envelope.
 *   erro       falha de DOMINIO: a Funcao rodou e reportou problema.
 *   invalida   a saida nao respeita a forma que a Funcao promete.
 *
 * Colapsar `erro` e `invalida` obrigaria o executor generico a adivinhar
 * entre `executor_falhou` e `saida_invalida`, que a Tool Call ja separa.
 *
 * `mensagem` e `retryable` vem daqui porque tambem sao conhecimento da
 * Funcao: so ela sabe se repetir e seguro. `retryable: true` afirma
 * "repetir nao causa dano", NUNCA "repita" — nao existe retry no
 * sistema, e o executor nao reexecuta nada.
 */
export type ResultadoInterpretacaoSaida =
  | { tipo: "sucesso"; data: unknown }
  | { tipo: "erro"; codigo: string; mensagem: string; retryable: boolean }
  | { tipo: "invalida" };

export type InterpretadorSaida = (saida: unknown) => ResultadoInterpretacaoSaida;

/**
 * O que se sabe sobre uma Funcao AQUI.
 *
 * ── O que entrou, e por que ─────────────────────────────────────────
 *
 * `executor` continua sendo a autoridade de EXISTENCIA. Os tres campos
 * novos sao OPERACIONAIS: o runtime ramifica por eles, e nenhum deles
 * tem outra fonte server-side hoje.
 *
 *   acesso            natureza da operacao, nao grau. Ler venda errado
 *                     mostra numero errado; pausar campanha errado gasta
 *                     dinheiro do cliente.
 *   idempotente       repetir tem o mesmo efeito que executar uma vez.
 *                     Sob semantica at-least-once isso decide se repetir
 *                     e seguro — e nenhuma outra camada sabe responder.
 *   conexaoNecessaria `null` quando a Funcao nao depende de conexao
 *                     externa. NAO inventar requisito: uma Funcao que le
 *                     tabela propria da CDS nao precisa de marketplace.
 *
 * ── O que continua fora, e por que ──────────────────────────────────
 *
 * `rotulo`, `descricao`, `icone`, `risco` e `procedencia` NAO entram.
 * Seguem em `FuncaoUI`, que e apresentacao. Nenhuma decisao de
 * autorizacao pode depender deles — o guard nao os recebe e nao os
 * consulta. `nivel` tambem nao entra: vive em `agente_permissoes`, e e
 * por-agente, nao por-Funcao.
 *
 * `workflowId`, `settingsHash` e binding de executor externo tambem nao:
 * sao estado observado de um sistema que muda FORA deste repositorio, e
 * declara-los aqui criaria um espelho que envelhece sozinho.
 *
 * ── Validacao e interpretacao: o campo que faltava ──────────────────
 *
 * Este contrato dizia que `validarEntrada` nao existia "por enquanto",
 * porque `vendas.consultar` ja validava dentro do executor e um campo
 * aqui duplicaria a regra. A condicao que ele mesmo registrou foi
 * atingida na TOOL-EXEC: o executor generico precisa decidir ANTES de
 * abrir a Tool Call, e dali a regra nao tem dono alcancavel.
 *
 * Os dois campos NAO duplicam nada. `validarEntrada` de
 * `vendas.consultar` delega a `validarFiltroVendas`, que continua a
 * unica autoridade das regras; `interpretarSaida` le o
 * `ResultadoVendas` que o proprio executor produz. Os dois sao
 * OBRIGATORIOS: ausencia de validador nao pode significar "aceita
 * qualquer coisa", e ausencia de interpretador nao pode significar
 * "qualquer retorno e sucesso". Uma Funcao nova sem eles nao compila.
 *
 * ── Divida aceita ───────────────────────────────────────────────────
 *
 * `acesso` passa a existir aqui e em `FuncaoUI`. Este mapa e a
 * AUTORIDADE; o de la e rotulo exibido. Enquanto a UI nao derivar o
 * valor do servidor, os dois podem divergir sem que nada acuse.
 */
export interface DefinicaoFuncao {
  // `executor` PRIMEIRO: existencia e a presenca dele, e a ordem e
  // cobrada por assert. Os tres primeiros campos sao as
  // responsabilidades da propria Funcao — validar, executar, interpretar
  // —; `revisao` diz QUAL versao delas; os tres ultimos sao metadados
  // operacionais.
  executor: ExecutorFuncao;
  validarEntrada: ValidadorEntrada;
  interpretarSaida: InterpretadorSaida;
  /**
   * A versao SEMANTICA da acao — o que um humano estaria aprovando.
   * String opaca, comparada so por igualdade: sem semver, sem ordem,
   * sem timestamp, sem hash de arquivo, sem SHA de commit.
   *
   * BUMP OBRIGATORIO ao mudar `validarEntrada`, a semantica da acao, o
   * efeito externo, o escopo, `acesso`, `conexaoNecessaria`, ou a
   * interpretacao que decide sucesso/erro. NAO exige bump: comentario,
   * mensagem interna, refactor equivalente.
   *
   * Ninguem le este campo ainda. Ele existe para que uma aprovacao
   * humana possa congelar a definicao que aprovou — aprovar a revisao
   * "1" e executar a "2" seria executar outra acao sob a mesma
   * autorizacao.
   */
  revisao: string;
  acesso: "leitura" | "escrita";
  idempotente: boolean;
  conexaoNecessaria: RequisitoConexaoFuncao | null;
}

// ─── A primeira Funcao real ───────────────────────────────────────────

/**
 * `vendas.consultar` — leitura das vendas pagas do dono numa janela.
 *
 * ── Por que ESTA operacao passa no criterio, e o handler nao ────────
 *
 * O executor NAO envolve `analise_vendas`. Ele usa
 * `criarLeiturasDeVendas`, que ja e um modulo de dominio proprio
 * (`lib/agentes/dados/vendas.ts`), desenhado como capability
 * independente muito antes desta fase:
 *
 *   - nao le, nao escreve e nao consulta `agente_tarefas`;
 *   - nao depende de status `rodando`, de claim nem de heartbeat;
 *   - nao escreve nada (zero `insert`/`update`/`delete`);
 *   - nao chama API externa (zero `fetch`);
 *   - fecha o `userId` por CLOSURE — a funcao devolvida NAO tem
 *     parametro de dono, entao nao existe assinatura pela qual o
 *     chamador peca dado de outro tenant.
 *
 * `analise_vendas`, por contraste, e o TIPO DE TAREFA que consome essa
 * leitura e ainda agrega, opcionalmente interpreta com IA e formata
 * resultado. Registrar o handler seria embrulho cosmetico; registrar a
 * leitura subjacente e reusar a operacao que ja significa "consultar
 * vendas".
 *
 * ── Idempotencia ────────────────────────────────────────────────────
 *
 * Leitura pura: repetir tem o mesmo efeito que executar uma vez. E o
 * motivo de a primeira Funcao real ser de leitura — escrita sob
 * semantica at-least-once exige contrato proprio de repeticao, que esta
 * fase nao decide.
 *
 * ── Validacao dos argumentos ────────────────────────────────────────
 *
 * Nao ha cast. `lerVendasDoPeriodo` ja chama `validarFiltroVendas`, que
 * e pura e recusa `filtro_ausente`, `data_invalida`, `periodo_invertido`,
 * `janela_excedida` e `marketplace_invalido` com codigos ESTAVEIS. Um
 * argumento arbitrario volta como erro classificado, nunca como consulta
 * ampla.
 */
async function executarVendasConsultar(
  contexto: ContextoFuncao,
  argumentos: unknown
): Promise<ResultadoVendas> {
  const lerVendas = criarLeiturasDeVendas(contexto.userId);
  // O cast e apenas para satisfazer a assinatura; a VALIDACAO acontece
  // dentro, e recusa qualquer coisa que nao seja um filtro valido.
  return lerVendas(argumentos as FiltroVendas);
}

/**
 * `validarEntrada` de `vendas.consultar` — delegacao pura.
 *
 * `validarFiltroVendas` continua sendo a UNICA autoridade das regras:
 * `filtro_ausente`, `data_invalida`, `periodo_invertido`,
 * `janela_excedida` e `marketplace_invalido` nao sao recopiados aqui, e
 * o wrapper so traduz a forma (`erro: string | null`) para a uniao
 * discriminada que o executor generico consome.
 *
 * O cast existe pelo mesmo motivo do executor: `validarFiltroVendas`
 * recusa nao-objeto com `filtro_ausente` antes de tocar qualquer campo,
 * entao ele nunca confia no tipo.
 */
function validarEntradaVendasConsultar(argumentos: unknown): ResultadoValidacaoEntrada {
  const validacao = validarFiltroVendas(argumentos as FiltroVendas);
  return validacao.erro === null ? { valida: true } : { valida: false, codigo: validacao.erro };
}

/**
 * A mensagem que o DONO le quando a consulta falha.
 *
 * Uma so, porque depois da validacao pre-execucao existe exatamente UM
 * codigo alcancavel (`erro_consulta_vendas`, devolvido pelo limite
 * inicial e pela paginacao). Nao e tabela de traducao: e a unica frase
 * que esta Funcao precisa. No dia em que forem cinco, a decisao volta a
 * ser gate.
 *
 * Nunca deriva de `error.message`, `details` ou `hint` do driver — o
 * modulo de dados ja descarta essas mensagens e registra so o codigo.
 */
const MENSAGEM_ERRO_VENDAS = "Nao foi possivel ler as vendas do periodo.";

/**
 * `interpretarSaida` de `vendas.consultar` — e por que ha checagem de
 * runtime aqui.
 *
 * `saida as ResultadoVendas` seria apagado na compilacao e nao provaria
 * nada: `null`, `[]`, `{}` e `{ erro: 123 }` passariam pelo cast e
 * quebrariam adiante, ou pior, virariam "sucesso". A forma minima e
 * conferida de verdade, e o que nao a respeita e `invalida`.
 *
 * As LINHAS nao sao validadas uma a uma: `ResultadoVendas` nao promete
 * mais do que "array", e exigir a forma de cada `LinhaVenda` inventaria
 * requisito que o contrato nao tem.
 *
 * `truncado` atravessa para o `data`. Silencia-lo entregaria um total
 * incompleto com cara de completo — o proprio contrato de
 * `ResultadoVendas` diz que quem consome PRECISA propagar isso.
 */
function interpretarSaidaVendasConsultar(saida: unknown): ResultadoInterpretacaoSaida {
  if (typeof saida !== "object" || saida === null) return { tipo: "invalida" };
  const proto = Object.getPrototypeOf(saida);
  if (proto !== Object.prototype && proto !== null) return { tipo: "invalida" };

  const bruto = saida as Record<string, unknown>;
  if (!Array.isArray(bruto.linhas)) return { tipo: "invalida" };
  if (typeof bruto.truncado !== "boolean") return { tipo: "invalida" };

  const erro = bruto.erro;
  if (erro === null) {
    return {
      tipo: "sucesso",
      data: { linhas: bruto.linhas, truncado: bruto.truncado, erro: null },
    };
  }

  // String vazia nao e codigo de erro nem ausencia de erro: e saida que
  // nao respeita o proprio contrato.
  if (typeof erro !== "string" || erro.trim().length === 0) return { tipo: "invalida" };

  return {
    tipo: "erro",
    codigo: erro,
    mensagem: MENSAGEM_ERRO_VENDAS,
    // Leitura idempotente: repetir nao causa dano. Isto NAO pede retry —
    // nao existe retry no sistema, e o executor nao reexecuta nada.
    retryable: true,
  };
}

// ─── O registry ───────────────────────────────────────────────────────

/**
 * O mapa. Congelado, explicito, sem entrada dinamica.
 *
 * Ids seguem a mesma forma que a SKILL-1B ja valida em manifestos de
 * Skill (`dominio.acao`, minusculas e pontos), para que o id que uma
 * Skill escreve seja literalmente o id que este mapa resolve. A suite
 * compara as duas formas e reprova se divergirem.
 */
export const FUNCOES: Readonly<Record<string, DefinicaoFuncao>> = Object.freeze({
  // `acesso: "leitura"` — o executor nao escreve nada: zero
  // `insert`/`update`/`delete`, como a suite da capability ja verifica.
  //
  // `idempotente: true` — leitura pura, ja registrado na secao acima.
  //
  // `conexaoNecessaria: null` — e a resposta HONESTA, nao uma omissao.
  // `criarLeiturasDeVendas` le `pedidos`, tabela da propria CDS, com a
  // service_role. Nao chama Mercado Livre nem Shopee, nao usa token de
  // marketplace e nao tem `fetch`. Declarar um requisito de conexao aqui
  // criaria uma pendencia inexistente e faria o guard negar uma Funcao
  // que funciona.
  "vendas.consultar": Object.freeze({
    executor: executarVendasConsultar,
    // Delega a `validarFiltroVendas`; nenhuma regra e recopiada.
    validarEntrada: validarEntradaVendasConsultar,
    // Le o `ResultadoVendas` que o executor acima produz, com checagem
    // de runtime — o cast sozinho nao provaria nada.
    interpretarSaida: interpretarSaidaVendasConsultar,
    // Primeira revisao publicada; nenhuma versao anterior existiu.
    revisao: "1",
    acesso: "leitura",
    idempotente: true,
    conexaoNecessaria: null,
  }),

  // A PRIMEIRA Funcao conectada — M2-I1-A2.
  //
  // Os tres wrappers moram em `funcoes/mercadolivre-perguntas.ts`, e nao
  // aqui. Nao e estilo: uma segunda Funcao no padrao inline levaria este
  // arquivo a ~640 linhas contra um tripwire de 560, e subir o tripwire
  // seria desligar o alarme em vez de responder a ele. O catalogo volta
  // a ser o mapa; a implementacao vive ao lado.
  //
  // O id NAO e `mercado_livre.*`: o CHECK
  // `agente_permissoes_funcao_id_formato` e `^[a-z0-9]+(\.[a-z0-9_]+)+$`,
  // e o primeiro segmento nao aceita underscore. `plataforma` continua
  // sendo `mercado_livre` — a coluna e o id sao vocabularios diferentes,
  // e forcar um no outro quebraria o banco ou o mapa de marketplaces.
  //
  // `conexaoNecessaria` preenchido e o que a distingue de tudo que veio
  // antes: sem loja escolhida e sem cobertura confirmada, o guard nega
  // `conexao_ausente` e o executor nem e chamado. Isso e o desenho, nao
  // uma pendencia — cobertura remota e slice proprio.
  "mercadolivre.perguntas.listar": Object.freeze({
    executor: executarPerguntasML,
    // Delega a `validarFiltroPerguntas`; nenhuma regra e recopiada.
    validarEntrada: validarEntradaPerguntasML,
    // Checagem de runtime sobre `ResultadoPerguntas`, como em vendas.
    interpretarSaida: interpretarSaidaPerguntasML,
    revisao: "1",
    // Leitura: nao responde pergunta, nao altera anuncio, nao envia nada.
    acesso: "leitura",
    idempotente: true,
    conexaoNecessaria: CONEXAO_PERGUNTAS_ML,
  }),
});

/** Erro de Funcao inexistente. Classe propria para que quem chama a
 *  distinga de falha do executor — sao causas diferentes. */
export class ErroFuncaoDesconhecida extends Error {
  readonly id: string;
  constructor(id: string) {
    super("funcao nao registrada");
    this.name = "ErroFuncaoDesconhecida";
    this.id = id;
  }
}

/**
 * Os ids reais, em ordem estavel.
 *
 * Ordenado explicitamente: a ordem de declaracao no objeto nao pode
 * decidir a saida, senao mover uma linha mudaria o resultado de quem
 * lista sem que nada tenha mudado de fato.
 */
export function listarFuncoesRegistradas(): readonly string[] {
  return Object.freeze(Object.keys(FUNCOES).sort());
}

/**
 * "Esta Funcao existe?" — a pergunta que vira `FatoFuncao.existe`.
 *
 * `hasOwnProperty` e nao `in`: `in` acha `toString`, `constructor` e o
 * resto do prototipo, e um id chamado `constructor` passaria a "existir".
 */
export function funcaoExiste(id: unknown): boolean {
  return typeof id === "string" && Object.prototype.hasOwnProperty.call(FUNCOES, id);
}

/**
 * Resolve o executor de um id conhecido.
 *
 * LANCA em id desconhecido — nunca devolve `undefined`, nunca cai num
 * executor default e nunca aproxima por prefixo ou semelhanca.
 * `mensagens.responder` nao vira um handler que contenha "mensagem": uma
 * Funcao que ninguem sabe executar precisa falhar alto, e nao parecer
 * feita.
 */
export function resolverFuncao(id: unknown): DefinicaoFuncao {
  if (!funcaoExiste(id)) throw new ErroFuncaoDesconhecida(typeof id === "string" ? id : String(id));
  return FUNCOES[id as string];
}
