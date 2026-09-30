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
  /**
   * Estado OPACO do provedor, devolvido verbatim no turno seguinte —
   * F7b.4.
   *
   * O Gemini emite no `function_call` um campo `signature` de algumas
   * centenas de caracteres. Ele NAO e legivel e NAO e interpretado aqui:
   * e devolvido exatamente como veio.
   *
   * Existe porque sem ele o segundo turno e recusado. Foi medido: um
   * `function_call` RECONSTRUIDO com `{id, name, arguments}` leva 400
   * "Request contains an invalid argument"; o MESMO objeto com a
   * assinatura preservada fecha o ciclo com `store: false`. Era isso que
   * o F4 nao tinha isolado, e e por isso que ele concluiu que so havia
   * caminho com `store: true`.
   *
   * A Anthropic nao usa este campo e o ignora. Nada do dominio depende
   * dele, e ele nunca chega ao guard nem a auditoria.
   */
  readonly assinatura?: string;
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
  /**
   * O nivel de trabalho escolhido pelo dono — AGENT-FACTORY-F7b.4.2.
   *
   * Rotulo da CDS (`rapido`, `equilibrado`, `avancado`, `maximo`), e NAO
   * o parametro do provedor. Cada adaptador traduz para o que a sua API
   * aceita de verdade, e ignora o campo quando nao ha controle.
   *
   * OPCIONAL de proposito: ausente significa "use o default do modelo".
   * Um default nosso aqui seria uma opiniao sobre quanto o modelo deve
   * pensar, tomada longe de quem paga a conta.
   */
  readonly nivelDeTrabalho?: string;
  /**
   * Como o modelo escolhe a ferramenta — AGENT-FACTORY-F4.
   *
   * `"auto"` (o padrao) e o comportamento de producao: o modelo decide.
   * `{ nome }` OBRIGA aquela ferramenta, usando o mecanismo oficial de
   * cada provedor (`tool_choice` na Anthropic,
   * `generation_config.tool_choice` na Interactions API do Google).
   *
   * Existe para PROVA, e a distincao importa: forcar mostra que o
   * protocolo de ida-e-volta funciona; nao forcar mostra se o modelo
   * ESCOLHE a ferramenta sozinho. Sao perguntas diferentes, e misturar
   * as duas faria um "sim" responder pela outra.
   *
   * Nada disto e autorizacao: forcar uma ferramenta nao pula o guard —
   * quem decide se ela pode rodar continua sendo `executarFuncao`.
   */
  readonly escolhaDeFerramenta?: "auto" | { readonly nome: string };
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
/**
 * Uma acao externa pronta para ser declarada — F7b.4.2.
 *
 * `descricao` e `schemaEntrada` vem do CATALOGO do provedor externo, e nao
 * de nos: inventar o schema de uma acao do Google Sheets faria o modelo
 * montar argumentos que a acao recusa, e o erro apareceria como falha da
 * ferramenta em vez de defeito nosso.
 *
 * Por isso quem chama fornece as duas coisas. `declararFerramentas` nao
 * consulta catalogo externo — ela e pura, e continua sendo.
 */
export interface FuncaoExternaDeclaravel {
  readonly funcaoId: string;
  readonly descricao: string;
  readonly schemaEntrada: Readonly<Record<string, unknown>>;
}

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
    "mercadolivre.vendas.consultar": Object.freeze({
      descricao:
        "Consulta as vendas PAGAS na conta do Mercado Livre ligada a este agente, direto " +
        "na API oficial do Mercado Livre. Use esta ferramenta quando a pergunta for sobre " +
        "vendas, faturamento ou pedidos DO MERCADO LIVRE: ela e a fonte oficial. " +
        "Em `periodo`, repita o periodo COM AS PALAVRAS DA PESSOA — 'esta semana', " +
        "'ultimos 7 dias', 'agosto de 2026', 'de 10/09/2026 ate 20/09/2026', " +
        "'no dia 15/08/2026'. A CDS converte em datas no fuso de Sao Paulo; nao calcule " +
        "datas de cabeca e nao mande data que a pessoa nao disse. " +
        // ── F7b.4.8.3 §39: mes sem ano NAO e ambiguidade ────────────
        //
        // MEDIDO na rota real: em "compare agosto com setembro" a OpenAI
        // parou e perguntou "de qual ano?" em vez de consultar. A CDS
        // resolve isso por regra escrita e testada (§19), entao a pergunta
        // gastava um turno para saber algo que o sistema ja sabia.
        //
        // A saida nao e obrigar uma resposta: e a ferramenta DIZER o
        // periodo que resolveu, no `rotulo`, para a pessoa poder corrigir.
        "Mes sem ano — 'agosto', 'compare agosto com setembro' — NAO e ambiguo: a CDS " +
        "resolve como o ano corrente se o mes ja comecou, senao o ano anterior. " +
        "NAO pergunte de que ano e; consulte, e diga na resposta o periodo que a " +
        "ferramenta devolveu, para a pessoa corrigir se nao for o que ela queria. " +
        "Para COMPARAR dois periodos, chame a ferramenta DUAS vezes, uma por periodo. " +
        "A resposta traz `completo`: quando ele for false, a varredura nao recuperou " +
        "todos os pedidos e NAO ha totais — nesse caso diga que nao foi possivel " +
        "recuperar tudo e NAO apresente comparacao nem porcentagem como conclusao. " +
        // ── F7b.4.8.3 §10: o que o numero E, dito ao modelo ─────────
        //
        // A auditoria de semantica (docs/SEMANTICA_FATURAMENTO_ML.md)
        // mediu o que entra e o que nao entra. Duas dessas conclusoes
        // mudam a RESPOSTA, e nao so o calculo: o faturamento e bruto, e
        // periodo passado nao e imutavel. Se o modelo nao souber, ele
        // apresenta um numero bruto como se fosse o que a pessoa ganhou,
        // e um mes fechado como se nunca mais fosse mudar.
        "O `faturamento` e BRUTO — e o que o comprador pagou, sem descontar tarifa " +
        "do Mercado Livre, frete do vendedor, imposto nem custo. Nao o chame de lucro " +
        "nem de liquido. Estorno, chargeback e mediacao mudam o numero de um periodo " +
        "JA PASSADO, entao nao apresente periodo fechado como definitivo: e o que a " +
        "conta do Mercado Livre diz agora sobre aquele periodo. " +
        "Somente leitura: nao altera anuncio, nao cancela e nao responde nada.",
      // ── F7b.4.8.2: SO `periodo`, e OBRIGATORIO ────────────────────
      //
      // O schema oferecia `periodo`, `de` e `ate` com `required: []`, e
      // dizia "use um ou o outro" apenas numa descricao. MEDIDO no agente
      // real do Rodrigo: a OpenAI mandou os dois, e o validador recusou
      // com `filtro_ambiguo` — a auditoria registrou
      // "Regra: filtro_ambiguo" as 20:32 de 2026-09-30.
      //
      // Descricao nao e contrato. Com um caminho so, o argumento ambiguo
      // deixa de ser possivel — e `required` fecha a outra metade: `{}`
      // nao chega mais como `filtro_ausente`.
      //
      // Datas explicitas continuam valendo no VALIDADOR, para quem nao e
      // modelo. O que saiu foi a oferta ao modelo: quem resolve periodo e
      // a CDS, e ele nunca precisou calcular data nenhuma.
      schemaEntrada: Object.freeze({
        type: "object",
        properties: {
          // ── F7b.4.8.3: texto livre, e nao `enum` ──────────────────
          //
          // O enum de sete valores nao tinha como expressar "agosto de
          // 2026", "de 10/09 ate 20/09" nem "no dia 15/08" — e sem isso a
          // pergunta sobre data antiga nao tinha caminho nenhum.
          //
          // Texto NAO afrouxa: `periodo-em-texto.ts` resolve
          // deterministicamente e RECUSA o que nao entende, e a recusa e
          // corrigivel. O modelo continua sem calcular data.
          periodo: {
            type: "string",
            description:
              "O periodo, nas palavras da pessoa. Ex.: 'esta semana', " +
              "'semana passada', 'ultimos 7 dias', 'ultimos 30 dias', " +
              "'agosto de 2026', 'no dia 15/08/2026', " +
              "'de 10/09/2026 ate 20/09/2026'. A CDS resolve as datas.",
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
 *   2. ha uma LINHA de permissao para ela (qualquer nivel conhecido);
 *   3. ha declaracao escrita para ela.
 *
 * ── Por que `bloqueado` E DECLARADO — revisao do F7b ────────────────
 *
 * Ate o F7b este filtro exigia `automatico` ou `aprovacao`, com o
 * argumento de que declarar o que nunca sera permitido "convidaria o
 * modelo a pedir" e transformaria negacao em rotina. O argumento era de
 * UX, e o proprio texto admitia que "o guard e a cerca de verdade".
 *
 * O primeiro turno REAL contra a Anthropic mostrou o custo disso. Com a
 * calculadora em `bloqueado`, a ferramenta nao era declarada, o modelo
 * nunca a pedia, o guard nunca era consultado — e ele respondia
 * "1500 - 275 = 1.225" de cabeca. O fail-closed do F4.1 nao disparava,
 * porque ele fecha o turno quando um PEDIDO e negado, e nao havia
 * pedido.
 *
 * Entao `bloqueado` volta a ser declarado, e declarado IGUAL aos outros:
 *
 *   modelo pede -> guard NEGA -> o laco FECHA o turno (F4.1)
 *
 * ── E por que a declaracao NAO avisa que esta bloqueada ─────────────
 *
 * Seria tentador escrever "esta ferramenta esta bloqueada" na descricao.
 * Isso reabriria o buraco pelo outro lado: um modelo que SABE que vai
 * ser negado desvia — e desviar, aqui, significa responder de cabeca.
 * A ferramenta e apresentada normalmente; quem diz nao e o guard, no
 * unico lugar onde dizer nao tem efeito.
 *
 * ── Permissao AUSENTE continua fora ─────────────────────────────────
 *
 * Nao ha linha, nao ha declaracao. E diferente de `bloqueado`: ali o
 * dono decidiu "nao"; aqui ninguem decidiu nada, e a Funcao nao faz
 * parte deste agente. O caso de "Tool escolhida sem permissao
 * configurada" e barrado antes, na ativacao — e e trabalho da UI.
 */
export function declararFerramentas(entrada: {
  readonly catalogo: Readonly<Record<string, DefinicaoParaDeclaracao>>;
  readonly permissoes: readonly { funcaoId: string; nivel: string }[];
  /**
   * As acoes externas VINCULADAS a este agente — F7b.4.2 §13.
   *
   * Esta lista vem de `agente_ferramentas_externas`, e NUNCA de
   * `agente_permissoes`. E dai que sai a garantia de que permissao
   * historica nao ressuscita ferramenta removida: sem vinculo, a acao nao
   * entra aqui, e nao ha permissao que a coloque de volta.
   *
   * O nivel continua vindo de `permissoes`, como em qualquer Funcao —
   * inclusive `bloqueado`, que e declarado para que o guard seja
   * consultado e o turno feche (ver o docblock acima). Permissao AUSENTE
   * continua fora: uma acao vinculada e sem decisao nao e declarada, e a
   * ativacao ja barra esse estado.
   */
  readonly externas?: readonly FuncaoExternaDeclaravel[];
}): readonly FerramentaDeclarada[] {
  const saida: FerramentaDeclarada[] = [];
  const nivelPorId = new Map(entrada.permissoes.map((p) => [p.funcaoId, p.nivel]));

  // ── As externas, pela mesma regra de nivel que as internas ────────
  for (const e of entrada.externas ?? []) {
    const nivel = nivelPorId.get(e.funcaoId);
    if (nivel !== "automatico" && nivel !== "aprovacao" && nivel !== "bloqueado") continue;
    saida.push({
      nome: e.funcaoId,
      descricao: e.descricao,
      schemaEntrada: e.schemaEntrada,
    });
  }

  for (const p of entrada.permissoes) {
    // Qualquer nivel CONHECIDO entra — inclusive `bloqueado`. Ver o
    // docblock: e assim que o guard volta a ser consultado, e e a
    // consulta que faz o F4.1 fechar o turno.
    if (p.nivel !== "automatico" && p.nivel !== "aprovacao" && p.nivel !== "bloqueado") continue;
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
