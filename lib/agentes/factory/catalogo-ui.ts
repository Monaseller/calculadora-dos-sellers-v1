/**
 * O catalogo como a PESSOA ve — F7b.1.
 *
 * ── Tool Pack e apresentacao, nao autoridade ────────────────────────
 *
 * O lojista nao escolhe `planilha.inspecionar`, `planilha.ler` e
 * `planilha.agregar`: ele escolhe PLANILHAS. Uma pessoa que quer somar
 * uma coluna nao tem como saber que isso exige tres Funcoes, e pedir que
 * saiba e transformar o produto em painel de administrador.
 *
 * Mas o backend continua por FUNCAO, sem excecao: permissao e por
 * `funcao_id`, o guard le `funcao_id`, o ledger grava `funcao_id`. O
 * pack e um agrupamento de EXIBICAO, e este modulo e o unico lugar onde
 * ele existe.
 *
 * ── Derivado do registry, nao paralelo a ele ────────────────────────
 *
 * Os packs listam ids, e a suite reprova se um id do pack nao existir no
 * catalogo REAL — e tambem se uma Funcao do catalogo nao aparecer em
 * pack nenhum. As duas direcoes, porque uma capacidade que existe e nao
 * aparece na tela e tao ruim quanto uma que aparece e nao existe.
 *
 * ── Este modulo e PURO ──────────────────────────────────────────────
 *
 * Sem `server-only`: a UI o importa no cliente para desenhar os cartoes.
 * Ele nao le banco, nao sabe de dono e nao decide permissao.
 */

export interface ToolPack {
  readonly id: string;
  readonly nome: string;
  /** Uma frase. O que a pessoa ganha, nao como funciona. */
  readonly descricao: string;
  /** O que ela permite, em linguagem de quem usa. */
  readonly capacidades: readonly string[];
  /** As Funcoes REAIS. A autoridade vive aqui, nao no pack. */
  readonly funcoes: readonly string[];
  readonly acesso: "leitura" | "escrita";
  /** `true` quando alguma Funcao do pack exige conta conectada. */
  readonly exigeConexao: boolean;
}

export const TOOL_PACKS: readonly ToolPack[] = Object.freeze([
  Object.freeze({
    id: "planilhas",
    nome: "Planilhas",
    descricao: "Ler e analisar arquivos Excel e CSV.",
    capacidades: Object.freeze([
      "Identificar abas e colunas de um arquivo",
      "Ler linhas, com limite",
      "Somar, contar, agrupar e achar duplicados",
      "Filtrar por período ou por valor",
    ]),
    funcoes: Object.freeze(["planilha.inspecionar", "planilha.ler", "planilha.agregar"]),
    acesso: "leitura",
    exigeConexao: false,
  }),
  Object.freeze({
    id: "calculadora",
    nome: "Calculadora",
    descricao: "Executar cálculos exatos, com precisão de centavo.",
    capacidades: Object.freeze([
      "Somar, subtrair, multiplicar e dividir",
      "Porcentagem e média",
      "Sem arredondamento surpresa em valores em reais",
    ]),
    funcoes: Object.freeze(["calculadora.calcular"]),
    acesso: "leitura",
    exigeConexao: false,
  }),
  Object.freeze({
    id: "calendario",
    nome: "Calendário",
    descricao: "Trabalhar com datas e períodos.",
    capacidades: Object.freeze([
      "Converter “este mês”, “mês passado”, “esta semana” em datas reais",
      "Usar o fuso de São Paulo",
    ]),
    funcoes: Object.freeze(["calendario.periodo"]),
    acesso: "leitura",
    exigeConexao: false,
  }),
  Object.freeze({
    id: "vendas",
    nome: "Vendas da CDS",
    descricao: "Consultar as vendas pagas da sua loja.",
    capacidades: Object.freeze([
      "Ler as vendas de um período",
      "Devolve as linhas, nunca um total já calculado",
    ]),
    funcoes: Object.freeze(["vendas.consultar"]),
    acesso: "leitura",
    exigeConexao: false,
  }),
  Object.freeze({
    id: "mercadolivre-perguntas",
    nome: "Perguntas do Mercado Livre",
    descricao: "Ler as perguntas recebidas na sua conta do Mercado Livre.",
    capacidades: Object.freeze([
      "Listar perguntas por status",
      "Somente leitura: não responde nem altera anúncio",
    ]),
    funcoes: Object.freeze(["mercadolivre.perguntas.listar"]),
    acesso: "leitura",
    exigeConexao: true,
  }),
]);

export function packDaFuncao(funcaoId: string): ToolPack | null {
  return TOOL_PACKS.find((p) => p.funcoes.includes(funcaoId)) ?? null;
}

export function packPorId(packId: string): ToolPack | null {
  return TOOL_PACKS.find((p) => p.id === packId) ?? null;
}

/** Todas as Funcoes que os packs cobrem. */
export function funcoesDosPacks(): readonly string[] {
  return TOOL_PACKS.flatMap((p) => p.funcoes);
}

/**
 * Os packs que este agente "tem", derivados das PERMISSOES.
 *
 * ── Nao existe tabela de "Tool selecionada" ─────────────────────────
 *
 * Selecionar uma Tool na etapa 4 e criar as linhas de permissao dela na
 * etapa 8 sao a MESMA coisa no banco. Guardar "selecionada" separado de
 * "tem permissao" criaria dois estados que podem discordar — e o que o
 * guard le e so um deles.
 *
 * Entao: um pack esta selecionado quando ALGUMA Funcao dele tem linha de
 * permissao, em qualquer nivel. E esta COMPLETO quando TODAS tem.
 */
export interface EstadoDoPack {
  readonly pack: ToolPack;
  readonly selecionado: boolean;
  readonly completo: boolean;
  readonly semPermissao: readonly string[];
  /** O nivel, quando as Funcoes do pack concordam. `null` se divergirem. */
  readonly nivelUniforme: string | null;
}

export function estadoDosPacks(
  permissoes: readonly { readonly funcaoId: string; readonly nivel: string }[]
): readonly EstadoDoPack[] {
  const porFuncao = new Map(permissoes.map((p) => [p.funcaoId, p.nivel]));
  return TOOL_PACKS.map((pack) => {
    const semPermissao = pack.funcoes.filter((f) => !porFuncao.has(f));
    const niveis = new Set(pack.funcoes.map((f) => porFuncao.get(f)).filter((n) => n !== undefined));
    return {
      pack,
      selecionado: semPermissao.length < pack.funcoes.length,
      completo: semPermissao.length === 0,
      semPermissao,
      nivelUniforme: semPermissao.length === 0 && niveis.size === 1
        ? ([...niveis][0] as string) : null,
    };
  });
}
