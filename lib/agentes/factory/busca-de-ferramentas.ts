import "server-only";

/**
 * A busca unificada de ferramentas — AGENT-FACTORY-F7b.4.1.
 *
 * ── Duas origens, um resultado ──────────────────────────────────────
 *
 * A pessoa digita "planilha" ou "sheets" e nao deveria precisar saber que
 * uma dessas coisas e Function interna da CDS e a outra vem de um
 * catalogo de 1584 integracoes. Aqui as duas viram a mesma forma.
 *
 * ── O que NAO acontece ──────────────────────────────────────────────
 *
 * O catalogo externo nao e baixado. A busca do Composio e paginada no
 * servidor dele, com limite, e so acontece quando ha termo. Termo vazio
 * devolve SO o que e interno — que e o estado inicial da tela.
 *
 * Isso importa para alem de performance: 1584 toolkits perto de um prompt
 * seria exatamente o que o §19 do F7b.3 proibiu, e a forma de nao chegar
 * la e nunca ter a lista inteira em memoria.
 *
 * ── Falha do externo nao derruba o interno ──────────────────────────
 *
 * O resultado carrega `externoDisponivel`. Composio fora significa uma
 * busca que devolve as internas e diz que a parte externa falhou — nunca
 * uma tela vazia, e nunca um erro que parece "nao encontrei nada".
 */
import { TOOL_PACKS, type ToolPack } from "@/lib/agentes/factory/catalogo-ui";
import {
  buscarToolkits, catalogoExternoConfigurado,
} from "@/lib/agentes/composio/cliente";

/** O termo, normalizado para comparar sem acento e sem caixa. */
function normalizar(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();
}

export const ORIGENS = Object.freeze(["cds", "integracao"] as const);
export type OrigemDaFerramenta = (typeof ORIGENS)[number];

export interface AchadoDeFerramenta {
  /**
   * Identificador para a proxima etapa. Para `cds` e o id do pack; para
   * `integracao` e o slug do toolkit. NAO e mostrado como interface.
   */
  readonly chave: string;
  readonly origem: OrigemDaFerramenta;
  readonly nome: string;
  readonly descricao: string;
  /** `null` quando a origem nao permite afirmar. Nunca chutado. */
  readonly acesso: "leitura" | "escrita" | null;
  readonly exigeConexao: boolean;
}

export interface ResultadoDaBusca {
  readonly achados: readonly AchadoDeFerramenta[];
  /** `false` quando o catalogo externo nao respondeu ou nao existe. */
  readonly externoDisponivel: boolean;
  /** Codigo do desfecho externo, para a tela poder explicar. */
  readonly externoDesfecho: "ok" | "nao_configurado" | "falha" | "nao_consultado";
  /** Quantos toolkits externos existem para o termo, alem dos mostrados. */
  readonly externoTotal: number;
}

/**
 * As palavras pelas quais um pack interno pode ser encontrado.
 *
 * Existe porque ninguem procura "planilhas" digitando "planilhas": procura
 * "excel", "xlsx", "sheets". Sem sinonimos a busca interna seria uma
 * comparacao de prefixo que quase nunca casa.
 *
 * Derivado do PROPRIO pack (nome, descricao, capacidades) mais um punhado
 * de termos que a pessoa usaria. Nao ha lista de packs escrita a mao aqui.
 */
function termosDoPack(p: ToolPack): string {
  const extras: Record<string, string> = {
    planilhas: "excel xlsx csv sheets planilha tabela",
    calculadora: "calculo conta matematica somar subtrair",
    calendario: "data datas periodo mes prazo",
    vendas: "venda faturamento pedido pedidos receita marketplace",
    "mercadolivre-perguntas": "mercado livre ml pergunta perguntas comprador",
  };
  return normalizar([
    p.nome, p.descricao, ...p.capacidades, extras[p.id] ?? "",
  ].join(" "));
}

function packComoAchado(p: ToolPack): AchadoDeFerramenta {
  return {
    chave: p.id,
    origem: "cds",
    nome: p.nome,
    descricao: p.descricao,
    acesso: p.acesso,
    exigeConexao: p.exigeConexao,
  };
}

/**
 * Busca em CDS e, quando ha termo, tambem no catalogo externo.
 *
 * `limiteExterno` e pequeno de proposito: a tela mostra alguns e oferece
 * refinar o termo. Uma lista longa convida a rolar em vez de pesquisar.
 */
export async function buscarFerramentas(
  termo: string,
  limiteExterno = 8
): Promise<ResultadoDaBusca> {
  const alvo = normalizar(termo);

  // ── Internas: sempre, com ou sem termo ───────────────────────────
  //
  // Derivadas do catalogo real de packs, e nao de uma lista escrita aqui.
  // Um pack novo aparece na busca sem este arquivo mudar.
  const internas = alvo === ""
    ? TOOL_PACKS.map(packComoAchado)
    : TOOL_PACKS.filter((p) => termosDoPack(p).includes(alvo)).map(packComoAchado);

  // ── Externas: SO sob demanda ─────────────────────────────────────
  if (alvo === "") {
    return {
      achados: internas,
      externoDisponivel: catalogoExternoConfigurado(),
      externoDesfecho: "nao_consultado",
      externoTotal: 0,
    };
  }

  const externo = await buscarToolkits(termo, limiteExterno);
  if (externo.estado !== "ok") {
    return {
      achados: internas,
      externoDisponivel: false,
      externoDesfecho: externo.estado === "nao_configurado" ? "nao_configurado" : "falha",
      externoTotal: 0,
    };
  }

  const externas: AchadoDeFerramenta[] = externo.dados.itens
    // Depreciado nao e oferecido para uma escolha NOVA. Um vinculo antigo
    // continua funcionando; o que nao faz sentido e sugerir legado a quem
    // esta montando o agente agora.
    .filter((t) => !t.depreciado)
    .map((t) => ({
      chave: t.slug,
      origem: "integracao" as const,
      nome: t.nome,
      // O catalogo nao publica descricao curta confiavel por toolkit. Em
      // vez de inventar uma, a tela diz o que ela sabe: e uma integracao,
      // e se precisa de conta.
      descricao: t.semAutenticacao
        ? "Integração externa. Não precisa conectar conta."
        : "Integração externa. Precisa de conta conectada.",
      // O acesso e por ACAO, nao por toolkit: um toolkit tem acoes de
      // leitura e de escrita. Afirmar um dos dois aqui seria chutar.
      acesso: null,
      exigeConexao: !t.semAutenticacao,
    }));

  return {
    // Internas primeiro: o que a CDS faz por si nao deve ficar abaixo de
    // uma integracao que ainda precisa de conta conectada.
    achados: [...internas, ...externas],
    externoDisponivel: true,
    externoDesfecho: "ok",
    externoTotal: externo.dados.totalDisponivel,
  };
}
