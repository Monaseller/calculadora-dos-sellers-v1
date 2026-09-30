import "server-only";

/**
 * TODAS as permissoes gravadas de um agente — AGENT-FACTORY-F7b.4.1.
 *
 * ── Por que `resolverFatosPermissoes` nao serve aqui ────────────────
 *
 * Aquela funcao exige `funcaoIds` e filtra com `.in()`. Isso e correto
 * para o que ela faz: o guard pergunta sobre Funcoes que ele conhece, e
 * um `select` sem filtro seria uma varredura sem pergunta.
 *
 * Mas Function EXTERNA nao esta no registry. Ninguem sabe, de antemao,
 * que `composio.googlesheets.googlesheets_get_spreadsheet_info` foi
 * vinculada a este agente — e justamente essa a pergunta: "o que o dono
 * escolheu?". Filtrar por uma lista conhecida nunca a responderia.
 *
 * Daí uma leitura SEM filtro de id, e com escopo por dono e agente na
 * propria instrucao.
 *
 * ── A linha de permissao E o vinculo ────────────────────────────────
 *
 * Nao existe tabela de "ferramentas externas selecionadas". Selecionar
 * uma acao externa E gravar a permissao dela, do mesmo jeito que
 * selecionar um pack interno e gravar as permissoes das Funcoes dele.
 *
 * Isso nao e economia de tabela: e o que faz o guard continuar sendo a
 * unica autoridade. Uma segunda tabela de selecao criaria um estado
 * "selecionada mas sem permissao" que alguem teria de reconciliar — e
 * reconciliacao entre duas fontes de verdade e onde o buraco aparece.
 */
import { getSupabaseServidor } from "@/lib/estudio-anuncios/supabase-servidor";

const TABELA = "agente_permissoes";
const COLUNAS = "funcao_id, nivel";

export interface PermissaoGravada {
  readonly funcaoId: string;
  readonly nivel: string;
}

export type ResultadoGravadas =
  | { readonly coleta: "ok"; readonly permissoes: readonly PermissaoGravada[] }
  | { readonly coleta: "entrada_invalida" }
  | { readonly coleta: "falha" };

/**
 * O que o dono decidiu para ESTE agente, sem filtrar por catalogo.
 *
 * Autoridade primeiro: sem dono ou sem agente nao ha pergunta a fazer, e
 * devolver "nenhuma permissao" afirmaria algo sobre um agente que ninguem
 * identificou.
 */
export async function listarPermissoesGravadas(entrada: {
  readonly userId: string;
  readonly agenteId: string;
  readonly signal?: AbortSignal;
}): Promise<ResultadoGravadas> {
  const { userId, agenteId } = entrada;
  if (!userId || !agenteId) return { coleta: "entrada_invalida" };

  const consulta = getSupabaseServidor()
    .from(TABELA)
    .select(COLUNAS)
    // Os DOIS na propria instrucao. Cross-tenant nao depende de ninguem
    // lembrar de filtrar depois.
    .eq("agente_id", agenteId)
    .eq("user_id", userId);

  const { data, error } = await (entrada.signal === undefined
    ? consulta
    : consulta.abortSignal(entrada.signal));

  if (error) {
    // Sem `error.message`: mensagem de driver vaza nome de coluna, de
    // constraint e as vezes de valor, e acaba em log e em resposta HTTP.
    console.error("[permissoes] falha ao listar permissoes gravadas");
    return { coleta: "falha" };
  }

  const permissoes: PermissaoGravada[] = [];
  for (const bruta of data ?? []) {
    const linha = bruta as { funcao_id?: unknown; nivel?: unknown };
    // Linha torta e DESCARTADA em silencio? Nao: ela condena a coleta.
    // Uma lista de permissoes pela metade apresentada como completa faria
    // a tela dizer que uma ferramenta nao esta configurada quando esta.
    if (typeof linha.funcao_id !== "string" || linha.funcao_id === "") {
      return { coleta: "falha" };
    }
    if (typeof linha.nivel !== "string" || linha.nivel === "") {
      return { coleta: "falha" };
    }
    permissoes.push({ funcaoId: linha.funcao_id, nivel: linha.nivel });
  }

  return { coleta: "ok", permissoes };
}
