import "server-only";

/**
 * O que o agente PODE usar de externo, neste turno — F7b.4.3 §5/§6.
 *
 * ── As TRES condicoes, e a ordem delas ──────────────────────────────
 *
 * Uma Function externa so e DECLARADA ao modelo se, ao mesmo tempo:
 *
 *   1. ha VINCULO atual do agente        (`agente_ferramentas_externas`)
 *   2. a action ainda EXISTE no catalogo (`GET /tools/{SLUG}`)
 *   3. ha PERMISSAO explicita            (`agente_permissoes`, 3 niveis)
 *
 * Faltando qualquer uma, ela nao e declarada — e o modelo nunca fica
 * sabendo que ela existiu.
 *
 * ── Por que o VINCULO e a primeira, e nao a permissao ───────────────
 *
 * Porque e ele a autoridade sobre PRESENCA (§6). A permissao e um
 * registro historico que nunca se apaga: desvincular deixa a linha de
 * permissao intacta de proposito, para que a decisao que o dono tomou um
 * dia continue explicavel.
 *
 * Se a lista partisse da permissao, uma ferramenta removida ressuscitaria
 * sozinha. Partindo do vinculo, isso e impossivel por construcao — e nao
 * por uma checagem que alguem precise lembrar de fazer.
 *
 * ── Por que o CATALOGO tambem conta ─────────────────────────────────
 *
 * Uma action retirada pelo provedor continuaria vinculada e permitida no
 * nosso banco. Declara-la faria o modelo pedir algo que sempre falharia,
 * e a falha apareceria como defeito do agente. Perguntar ao catalogo e o
 * que mantem a declaracao honesta — e e a mesma consulta que traz o
 * schema, entao nao custa uma ida a mais.
 *
 * ── Permissao AUSENTE nao e `bloqueado` ─────────────────────────────
 *
 * `bloqueado` E declarado, como toda Funcao bloqueada desde o F7b.0: o
 * modelo pede, o guard nega, o laco fecha o turno. Isso existe porque nao
 * declarar faz o modelo responder de cabeca — foi medido.
 *
 * Ausente e outra coisa: ninguem decidiu, a Funcao nao faz parte deste
 * agente, e a ATIVACAO ja barra esse estado antes de qualquer turno.
 */
import type { DefinicaoFuncao } from "@/lib/agentes/funcoes/registry";
import type { FerramentaDeclarada, FuncaoExternaDeclaravel } from "@/lib/agentes/ia/ferramentas";
import { detalharAcao } from "@/lib/agentes/composio/cliente";
import { definicaoDaAcaoExterna } from "@/lib/agentes/composio/definicao-externa";
import type { VinculoExterno } from "@/lib/agentes/ferramentas-externas/repositorio";

/** Os tres niveis que contam como DECISAO. Ausente nao esta aqui. */
const NIVEIS_DECIDIDOS = new Set(["automatico", "aprovacao", "bloqueado"]);

export interface ExternasPreparadas {
  /** Para `declararFerramentas`: descricao e schema, prontos. */
  readonly declaraveis: readonly FuncaoExternaDeclaravel[];
  /** Para `executarFuncao`: a definicao completa, por id. */
  readonly definicoes: Readonly<Record<string, DefinicaoFuncao>>;
  /**
   * Quantas foram descartadas por NAO existirem mais no catalogo.
   *
   * Publicado para observabilidade: um agente que perde ferramenta em
   * silencio e exatamente o que nao queremos, e este numero e o que
   * permite alguem notar.
   */
  readonly sumiramDoCatalogo: number;
  /** `true` quando o catalogo nao pode ser consultado neste ambiente. */
  readonly catalogoIndisponivel: boolean;
}

const VAZIO: ExternasPreparadas = Object.freeze({
  declaraveis: Object.freeze([]),
  definicoes: Object.freeze({}),
  sumiramDoCatalogo: 0,
  catalogoIndisponivel: false,
});

/**
 * Monta as duas listas a partir dos VINCULOS e das permissoes.
 *
 * As consultas ao catalogo saem em paralelo porque sao independentes e
 * acontecem dentro do turno do chat — em serie, cinco ferramentas
 * vinculadas somariam cinco idas antes de a primeira palavra sair.
 *
 * Falha de UMA action nao derruba as outras: a que falhou some, as demais
 * continuam. E o oposto da regra de `listarVinculosExternos`, onde linha
 * torta condena a coleta — e a diferenca e proposital. Ali uma leitura
 * parcial apresentada como completa faria o dono achar que configurou o
 * que nao configurou. Aqui, derrubar o turno inteiro porque o catalogo de
 * terceiro oscilou tiraria do agente tambem as ferramentas INTERNAS, que
 * nao tem nada com isso (§13).
 */
export async function prepararFuncoesExternas(entrada: {
  readonly vinculos: readonly VinculoExterno[];
  readonly permissoes: readonly { readonly funcaoId: string; readonly nivel: string }[];
}): Promise<ExternasPreparadas> {
  if (entrada.vinculos.length === 0) return VAZIO;

  const nivelPorId = new Map(entrada.permissoes.map((p) => [p.funcaoId, p.nivel]));

  // Condicoes 1 e 3 sao locais e baratas: filtram ANTES de qualquer rede.
  const candidatos = entrada.vinculos.filter((v) => {
    const nivel = nivelPorId.get(v.funcaoId);
    return nivel !== undefined && NIVEIS_DECIDIDOS.has(nivel);
  });
  if (candidatos.length === 0) return VAZIO;

  const detalhes = await Promise.all(
    candidatos.map(async (v) => ({ vinculo: v, detalhe: await detalharAcao(v.acao) }))
  );

  const declaraveis: FuncaoExternaDeclaravel[] = [];
  const definicoes: Record<string, DefinicaoFuncao> = {};
  let sumiram = 0;
  let indisponivel = false;

  for (const { vinculo, detalhe } of detalhes) {
    if (detalhe.estado === "nao_configurado") { indisponivel = true; continue; }
    if (detalhe.estado !== "ok") { sumiram += 1; continue; }

    const acao = {
      slug: detalhe.dados.slug,
      descricao: detalhe.dados.descricao,
      parametros: detalhe.dados.parametros,
      versao: detalhe.dados.versao,
    };

    const definicao = definicaoDaAcaoExterna(vinculo.funcaoId, acao);
    // Id que nao decompoe nao vira Funcao — mesma regra de
    // `fatosDeFuncaoExterna`. Sem definicao nao ha declaracao: declarar o
    // que nao se pode executar seria prometer capacidade inexistente.
    if (definicao === null) continue;

    definicoes[vinculo.funcaoId] = definicao;
    declaraveis.push({
      funcaoId: vinculo.funcaoId,
      // A descricao do PROVEDOR. Sem acrescentar aviso de bloqueio: um
      // modelo que sabe que sera negado desvia, e desviar significa
      // responder de cabeca (F7b.0).
      descricao: detalhe.dados.descricao !== ""
        ? detalhe.dados.descricao
        : `Ação ${detalhe.dados.nome} do aplicativo ${vinculo.toolkit}.`,
      schemaEntrada: detalhe.dados.parametros,
    });
  }

  return {
    declaraveis: Object.freeze(declaraveis),
    definicoes: Object.freeze(definicoes),
    sumiramDoCatalogo: sumiram,
    catalogoIndisponivel: indisponivel,
  };
}

/**
 * As ferramentas declaradas que sao EXTERNAS, para contagem e teste.
 *
 * Existe para que um oraculo consiga afirmar "nenhuma externa foi
 * declarada" sem precisar conhecer a forma do id em dois lugares.
 */
export function declaradasExternas(
  declaradas: readonly FerramentaDeclarada[]
): readonly FerramentaDeclarada[] {
  return declaradas.filter((d) => d.nome.startsWith("composio."));
}
