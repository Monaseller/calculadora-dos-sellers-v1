/**
 * O contrato de FERRAMENTAS para o modelo — AGENT-FACTORY-F1.
 *
 * ── Por que um contrato novo, e nao `AdaptadorIA` alargado ──────────
 *
 * `AdaptadorIA` e `<T>(pedido) => Promise<RespostaEstruturadaIA<T>>`:
 * UMA chamada, saida estruturada, validada por um validador que o
 * chamador traz. Ele resolve "texto entra, estrutura sai" e resolve bem.
 *
 * Ferramenta e outra forma: o dialogo tem TURNOS, a resposta pode ser
 * um PEDIDO em vez de um resultado, e o que volta do modelo nao e o
 * dado — e a intencao de obte-lo. Forcar as duas no mesmo tipo faria
 * `T` significar coisas diferentes em cada ramo, e o `tsc` pararia de
 * ajudar exatamente onde mais importa.
 *
 * Os dois compartilham `ProvedorIA` e os campos de uso, de proposito: a
 * contabilidade de tokens nao muda por causa do formato do turno.
 *
 * ── Este modulo e PURO ──────────────────────────────────────────────
 *
 * Sem `server-only`, sem rede, sem banco, sem provedor. Ele descreve a
 * forma e converte catalogo em declaracao. Quem fala com Anthropic ou
 * Google vive em `lib/ai-gateway/provedores/`; quem executa vive no
 * laco. Assim a suite exercita a conversao e o contrato sem subir nada.
 */
import type { ProvedorIA } from "@/lib/ai-gateway/tipos";

// ─── O que o modelo pode pedir ────────────────────────────────────────

/**
 * Uma ferramenta, como o MODELO a enxerga.
 *
 * `nome` e o `funcaoId` do catalogo, sem traducao. Um dicionario entre
 * "nome bonito para o modelo" e "id real" seria mais um lugar onde um
 * pedido pode virar outra Funcao — e e precisamente o erro que o guard
 * existe para impedir tarde demais.
 */
export interface FerramentaDeclarada {
  readonly nome: string;
  readonly descricao: string;
  readonly schemaEntrada: object;
}

/** O que o modelo pediu. `id` e do PROVEDOR — o turno o devolve. */
export interface PedidoDeFerramenta {
  readonly id: string;
  readonly nome: string;
  readonly argumentos: unknown;
}

/** O que devolvemos ao modelo depois de executar (ou recusar). */
export interface RespostaDeFerramenta {
  readonly id: string;
  /** Ja serializado: o modelo le texto, nunca objeto vivo do dominio. */
  readonly conteudo: string;
  /** `true` tambem para RECUSA — negar e um desfecho, nao uma excecao. */
  readonly erro: boolean;
}

// ─── O dialogo ────────────────────────────────────────────────────────

export type MensagemDoDialogo =
  | { readonly papel: "usuario"; readonly texto: string }
  | {
      readonly papel: "assistente";
      readonly texto: string | null;
      readonly pedidos: readonly PedidoDeFerramenta[];
    }
  | { readonly papel: "ferramenta"; readonly respostas: readonly RespostaDeFerramenta[] };

export interface PedidoIAComFerramentas {
  /** Instrucao de sistema. Comportamento, jamais autorizacao. */
  readonly instrucao: string;
  readonly mensagens: readonly MensagemDoDialogo[];
  /**
   * SOMENTE as ferramentas que este agente pode usar.
   *
   * Declarar o catalogo inteiro e depois negar no guard funcionaria — o
   * guard e a cerca de verdade —, mas convidaria o modelo a pedir o que
   * nunca sera permitido e transformaria negacao em rotina. Declarar o
   * que ele pode e defesa em profundidade, nao substituicao da cerca.
   */
  readonly ferramentas: readonly FerramentaDeclarada[];
}

export interface RespostaIAComFerramentas {
  /** Texto para o usuario. `null` quando o turno so pede ferramenta. */
  readonly texto: string | null;
  readonly pedidos: readonly PedidoDeFerramenta[];
  readonly provedor: ProvedorIA;
  readonly modelo: string;
  readonly tokensEntrada: number;
  readonly tokensSaida: number;
  readonly tempoMs: number;
}

/**
 * O adaptador com ferramentas. Um pedido, um TURNO de resposta.
 *
 * Ele NAO executa ferramenta e NAO conhece guard: devolve o pedido do
 * modelo e para. Quem decide se aquilo pode rodar e o laco, que passa
 * por `executarFuncao`. Um adaptador que executasse seria um caminho
 * paralelo a cerca.
 */
export type AdaptadorIAComFerramentas = (
  pedido: PedidoIAComFerramentas
) => Promise<RespostaIAComFerramentas>;

// ─── Do catalogo para a declaracao ────────────────────────────────────

/**
 * O minimo do catalogo que este modulo precisa ler.
 *
 * Estrutural de proposito: importar `DefinicaoFuncao` puxaria
 * `registry.ts`, que e `server-only`, e este arquivo deixaria de ser
 * puro. A forma e a mesma; a dependencia, nao.
 */
export interface DefinicaoParaDeclaracao {
  readonly acesso: "leitura" | "escrita";
  readonly conexaoNecessaria: { plataforma: string; recurso: string } | null;
}

/**
 * Descricao e schema de cada Funcao, para o modelo.
 *
 * ── Por que um mapa explicito, e nao geracao automatica ─────────────
 *
 * O catalogo nao guarda schema de entrada: `validarEntrada` e uma
 * FUNCAO, e funcao nao vira JSON Schema por introspeccao. Derivar um
 * schema aproximado produziria um contrato que o validador recusaria
 * depois — o modelo obedeceria a descricao errada e seria negado por
 * algo que ninguem lhe disse.
 *
 * Entao a declaracao e escrita a mao, UMA vez por Funcao, ao lado do
 * catalogo. A suite reprova se uma Funcao registrada nao tiver
 * declaracao: catalogo e declaracao andam juntos ou o modelo fica cego
 * para uma capacidade que existe.
 */
export const DECLARACOES: Readonly<Record<string, { descricao: string; schemaEntrada: object }>> =
  Object.freeze({
    "vendas.consultar": Object.freeze({
      descricao:
        "Le as vendas pagas do lojista num periodo. Devolve as linhas do periodo, " +
        "nunca um total ja calculado.",
      schemaEntrada: Object.freeze({
        type: "object",
        properties: {
          inicio: { type: "string", description: "Data inicial, AAAA-MM-DD." },
          fim: { type: "string", description: "Data final, AAAA-MM-DD." },
          marketplace: { type: "string", description: "Opcional. ML ou Shopee." },
        },
        required: ["inicio", "fim"],
        additionalProperties: false,
      }),
    }),
    // ── AGENT-FACTORY-F3: as Tools deterministicas ──────────────────
    //
    // As descricoes dizem ao modelo o que a Tool FAZ e, onde importa, o
    // que ela NAO faz. "Devolve as linhas, nunca um total ja calculado"
    // e "a Tool calcula; nao estime" existem porque um modelo que acha
    // que pode somar, soma — e some com o erro dentro de um numero de
    // aparencia perfeita.
    "planilha.inspecionar": Object.freeze({
      descricao:
        "Descreve uma planilha sem despejar o conteudo: abas, cabecalhos, quantas linhas " +
        "e colunas, se ha formulas. Use SEMPRE antes de ler ou agregar, para saber que " +
        "colunas existem em vez de adivinhar o nome delas.",
      schemaEntrada: Object.freeze({
        type: "object",
        properties: {
          fileId: { type: "string", description: "Identificador do arquivo. NUNCA um caminho." },
        },
        required: ["fileId"],
        additionalProperties: false,
      }),
    }),
    "planilha.ler": Object.freeze({
      descricao:
        "Le linhas de uma aba, com limite obrigatorio. Serve para VER exemplos de dado. " +
        "Nao use para calcular: para somar, contar ou agrupar existe planilha.agregar, " +
        "que calcula sem passar os numeros por voce.",
      schemaEntrada: Object.freeze({
        type: "object",
        properties: {
          fileId: { type: "string", description: "Identificador do arquivo. NUNCA um caminho." },
          aba: { type: "string", description: "Opcional. Padrao: a primeira aba." },
          colunas: {
            type: "array", items: { type: "string" },
            description: "Opcional. Nomes de cabecalho; padrao e todas.",
          },
          inicio: { type: "integer", description: "Opcional. Primeira linha de dado, base 0." },
          limite: { type: "integer", description: "Opcional. Maximo de linhas (teto 500)." },
        },
        required: ["fileId"],
        additionalProperties: false,
      }),
    }),
    "planilha.agregar": Object.freeze({
      descricao:
        "Calcula sobre uma aba: count, sum, min, max, average, distinct, missing, duplicates. " +
        "Aceita filtros e agrupamento na MESMA chamada. Use isto para qualquer total — nao " +
        "some voce mesmo os valores lidos, e nao estime. Para filtrar por periodo, pegue o " +
        "intervalo com calendario.periodo e use o operador 'entre'.",
      schemaEntrada: Object.freeze({
        type: "object",
        properties: {
          fileId: { type: "string", description: "Identificador do arquivo. NUNCA um caminho." },
          aba: { type: "string", description: "Opcional. Padrao: a primeira aba." },
          operacao: {
            type: "string",
            enum: ["count", "sum", "min", "max", "average", "distinct", "missing", "duplicates"],
          },
          coluna: { type: "string", description: "Obrigatoria, exceto para count." },
          agruparPor: { type: "string", description: "Opcional. Cabecalho pelo qual agrupar." },
          filtros: {
            type: "array",
            description: "Opcional. Todos os filtros precisam passar (E, nao OU).",
            items: {
              type: "object",
              properties: {
                coluna: { type: "string" },
                operador: {
                  type: "string",
                  enum: ["igual", "diferente", "contem", "maior", "menor", "entre", "vazio", "nao_vazio"],
                },
                valor: { description: "Valor de comparacao. Para datas, use AAAA-MM-DD." },
                ate: { description: "Limite superior, so com o operador 'entre'." },
              },
              required: ["coluna", "operador"],
              additionalProperties: false,
            },
          },
        },
        required: ["fileId", "operacao"],
        additionalProperties: false,
      }),
    }),
    "calculadora.calcular": Object.freeze({
      descricao:
        "Aritmetica exata para dinheiro. Operacao nomeada mais uma lista de valores — nao " +
        "aceita expressao escrita. Use para QUALQUER conta, inclusive as que parecem faceis: " +
        "e ela que garante o centavo. subtract, divide e percentage levam exatamente 2 valores.",
      schemaEntrada: Object.freeze({
        type: "object",
        properties: {
          operacao: {
            type: "string",
            enum: ["add", "subtract", "multiply", "divide", "percentage", "average"],
          },
          valores: {
            type: "array",
            items: { type: ["string", "number"] },
            description: "Aceita 1.234,56 e 1234.56. Em percentage: [valor, percentual].",
          },
        },
        required: ["operacao", "valores"],
        additionalProperties: false,
      }),
    }),
    "calendario.periodo": Object.freeze({
      descricao:
        "Converte um periodo em datas reais (America/Sao_Paulo), com inicio e fim INCLUSIVOS. " +
        "Use SEMPRE que a pergunta citar um periodo: voce nao tem relogio, e uma data " +
        "escrita de memoria produz um total certo sobre o mes errado.",
      schemaEntrada: Object.freeze({
        type: "object",
        properties: {
          periodo: {
            type: "string",
            enum: ["hoje", "ontem", "esta_semana", "semana_passada", "este_mes", "mes_passado", "este_ano"],
          },
        },
        required: ["periodo"],
        additionalProperties: false,
      }),
    }),
    "mercadolivre.perguntas.listar": Object.freeze({
      descricao:
        "Lista as perguntas recebidas na conta do Mercado Livre ligada a este agente. " +
        "Somente leitura: nao responde nem altera nada.",
      schemaEntrada: Object.freeze({
        type: "object",
        properties: {
          status: { type: "string", description: "Opcional. Ex.: UNANSWERED." },
          limite: { type: "integer", description: "Opcional. Maximo de linhas." },
          deslocamento: { type: "integer", description: "Opcional. Inicio da janela." },
        },
        required: [],
        additionalProperties: false,
      }),
    }),
  });

/**
 * Monta as declaracoes para UM agente.
 *
 * Tres filtros, nesta ordem, e nenhum deles substitui o guard:
 *   1. a Funcao existe no catalogo;
 *   2. o agente tem permissao `automatico` ou `aprovacao` para ela;
 *   3. ha declaracao escrita para ela.
 *
 * `bloqueado` e permissao ausente nao entram — o modelo nem fica sabendo
 * que existem.
 */
export function declararFerramentas(entrada: {
  readonly catalogo: Readonly<Record<string, DefinicaoParaDeclaracao>>;
  readonly permissoes: readonly { funcaoId: string; nivel: string }[];
}): readonly FerramentaDeclarada[] {
  const saida: FerramentaDeclarada[] = [];
  for (const p of entrada.permissoes) {
    if (p.nivel !== "automatico" && p.nivel !== "aprovacao") continue;
    if (!Object.prototype.hasOwnProperty.call(entrada.catalogo, p.funcaoId)) continue;
    const d = Object.prototype.hasOwnProperty.call(DECLARACOES, p.funcaoId)
      ? DECLARACOES[p.funcaoId]
      : undefined;
    if (d === undefined) continue;
    saida.push({ nome: p.funcaoId, descricao: d.descricao, schemaEntrada: d.schemaEntrada });
  }
  // Ordem estavel: o mesmo agente produz a mesma declaracao em toda
  // chamada, e um diff de prompt nao acusa mudanca que nao houve.
  saida.sort((a, b) => (a.nome < b.nome ? -1 : a.nome > b.nome ? 1 : 0));
  return Object.freeze(saida);
}
