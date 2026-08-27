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
import "server-only";
import {
  criarLeiturasDeVendas,
  type FiltroVendas,
  type ResultadoVendas,
} from "@/lib/agentes/dados/vendas";

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
 * `loja_id` tambem NAO esta aqui: resolver conexao e a SKILL-1D.c. A
 * primeira Funcao real nao precisa dele, e um campo sem consumidor viria
 * com a tentacao de aceita-lo de qualquer chamador.
 *
 * O contexto vem da sessao/runtime. NUNCA dos argumentos, e nunca do
 * modelo — e por isso ele e o PRIMEIRO parametro, separado do segundo:
 * a assinatura torna impossivel confundir "quem esta pedindo" com "o que
 * foi pedido".
 */
export interface ContextoFuncao {
  userId: string;
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
 * O que se sabe sobre uma Funcao AQUI.
 *
 * Somente o executor. `rotulo`, `descricao`, `acesso`, `risco`,
 * `procedencia`, nivel e icone NAO entram: os quatro primeiros ja vivem
 * em `FuncaoUI` (apresentacao) e nivel vive em permissao — duplicar aqui
 * criaria uma segunda verdade e permitiria que o catalogo contradissesse
 * a UI sobre o que e leitura e o que e acao.
 */
export interface DefinicaoFuncao {
  executor: ExecutorFuncao;
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
  "vendas.consultar": Object.freeze({ executor: executarVendasConsultar }),
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
