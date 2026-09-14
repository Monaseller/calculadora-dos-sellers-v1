/**
 * Escrita autorizada da permissao de Funcao — PERMISSOES-FUNCTION-V1-A.
 *
 * ── A pergunta que este modulo responde ─────────────────────────────
 *
 *   "para ESTE agente, ESTA Funcao passa a valer NESTE nivel"
 *
 * A SKILL-1D.d.1 criou onde guardar (`agente_permissoes`) e a 1D.d.2
 * ensinou a LER (`fatos.ts`). Ate aqui nada sabia GRAVAR: a tabela so
 * podia ser povoada por SQL manual, e por isso estava com zero linhas.
 * Este e o caminho de escrita, e o unico.
 *
 * ── A doutrina que este modulo revoga, e o quanto dela sobrevive ────
 *
 * Duas suites afirmavam que "nao existe write path de permissao". A
 * revogacao foi ratificada e e ESTREITA: existe UM escritor, para UMA
 * linha, com UM upsert. Nao existe DELETE — ver "Ausente nao e um
 * destino" abaixo — e nao existe escrita em lote, em cascata ou por
 * perfil de agente.
 *
 * ── CONFIGURAR nao e EXECUTAR ───────────────────────────────────────
 *
 * Este modulo grava a intencao do dono. Ele nao chama `autorizarFuncao`,
 * nao chama `executarFuncao`, nao abre Approval, nao registra Tool Call
 * e nao cria Task. Quem decide se uma chamada passa continua sendo o
 * guard, na hora da chamada, lendo o que ficou gravado aqui.
 *
 * ── Ausente nao e um destino ────────────────────────────────────────
 *
 * `bloqueado` GRAVA linha; nao apaga. Ausencia e bloqueio sao fatos
 * diferentes no dominio — o guard emite `permissao_ausente` para um e
 * `permissao_bloqueada` para o outro — e representar bloqueio como
 * ausencia perderia QUANDO o dono decidiu, tornaria
 * `permissao_bloqueada` inalcancavel na pratica e confundiria "nunca
 * configurei" com "proibi". Por isso nao ha `removerPermissao` nesta
 * fase: negar e uma escolha explicita, com carimbo.
 *
 * ── Autenticacao NAO acontece aqui ──────────────────────────────────
 *
 * `userId` e a identidade que a ROTA autenticou, nunca um campo de
 * corpo. A FK composta `(agente_id, user_id) -> agentes(id, user_id)`
 * garante que o par seja COERENTE; ela nao prova que quem chamou e
 * aquele dono, e essa prova e obrigacao do chamador. Por isso o payload
 * e montado INTERNAMENTE, campo a campo: nao ha `...entrada` espalhado
 * para dentro da escrita, e nenhuma coluna arbitraria do chamador
 * alcanca a tabela.
 */
import "server-only";
import { getSupabaseServidor } from "@/lib/estudio-anuncios/supabase-servidor";
import { NIVEIS_AUTONOMIA, type NivelAutonomia } from "@/lib/ia/conceitos";
import { funcaoExiste } from "@/lib/agentes/funcoes/registry";

const TABELA_PERMISSOES = "agente_permissoes";

/**
 * O alvo do conflito e a PK publicada, e nada alem dela.
 *
 * `user_id` NAO entra: ele nao faz parte da identidade logica — um
 * agente pertence a um dono so, entao acrescenta-lo nao separaria nada
 * e exigiria um indice unico que nao existe. `nivel` e `alterado_em`
 * sao o que MUDA; alvo de conflito e o que identifica.
 */
const CONFLITO_IDENTIDADE = "agente_id,funcao_id";

/**
 * O unico SQLSTATE com significado de DOMINIO aqui.
 *
 * `23503` e a FK composta — e as duas causas possiveis (agente
 * inexistente, agente de outro dono) chegam INDISTINGUIVEIS de
 * proposito: separa-las viraria um oraculo de existencia de agente
 * alheio. Mesmo tratamento de `definirSelecaoDeLoja`.
 *
 * Nao ha `23505` a tratar: o UPSERT existe justamente para que colidir
 * com a PK seja o caminho normal, nao um erro.
 */
const SQLSTATE_FK = "23503";

/** A autoridade da definicao: dono, agente, Funcao e nivel. Quatro
 *  campos, sempre juntos e tipados um a um. Nao existe campo livre e nao
 *  existe objeto de colunas — o que chega aqui e contrato, nao payload. */
export interface EntradaDefinirPermissao {
  userId: string;
  agenteId: string;
  funcaoId: string;
  nivel: string;
}

export interface ResultadoDefinirPermissao {
  estado: "definida" | "nao_disponivel" | "entrada_invalida" | "falha_escrita";
}

const ENTRADA_INVALIDA: ResultadoDefinirPermissao = Object.freeze({ estado: "entrada_invalida" as const });
const NAO_DISPONIVEL: ResultadoDefinirPermissao = Object.freeze({ estado: "nao_disponivel" as const });
const FALHA_ESCRITA: ResultadoDefinirPermissao = Object.freeze({ estado: "falha_escrita" as const });
const DEFINIDA: ResultadoDefinirPermissao = Object.freeze({ estado: "definida" as const });

/** Codigo SQLSTATE do erro do PostgREST, sem tocar em `message` — a
 *  mensagem do driver vaza nome de coluna, de constraint e as vezes de
 *  VALOR, e acaba em log e em resposta HTTP. */
function codigoDe(erro: unknown): string | undefined {
  return (erro as { code?: string } | null)?.code;
}

/** `nivel` cru -> `NivelAutonomia`. Igualdade exata contra o vocabulario
 *  canonico: sem alias, sem `toLowerCase`, sem `trim` permissivo. Um
 *  nivel quase certo e um nivel errado. */
function nivelAceito(valor: unknown): valor is NivelAutonomia {
  return typeof valor === "string" && (NIVEIS_AUTONOMIA as readonly string[]).includes(valor);
}

/**
 * A entrada inteira, validada antes de qualquer ida ao banco.
 *
 * `funcaoExiste` vem do REGISTRY — a mesma autoridade que o guard usa
 * para decidir se uma Funcao existe. Nao ha segunda lista aqui e nao ha
 * id escrito a mao: gravar permissao para uma Funcao que ninguem sabe
 * executar criaria uma linha que promete uma capacidade inexistente. O
 * CHECK do banco cobre a FORMA de `funcao_id`, nunca o vocabulario.
 */
function entradaValida(entrada: EntradaDefinirPermissao): boolean {
  if (!entrada.userId || !entrada.agenteId) return false;
  if (!funcaoExiste(entrada.funcaoId)) return false;
  return nivelAceito(entrada.nivel);
}

/**
 * Define — ou substitui — o nivel de autonomia de UMA Funcao do agente.
 *
 * ── Uma escrita, sem pre-leitura ────────────────────────────────────
 *
 * Nao se busca o agente antes para conferir o dono depois: a
 * conferencia esta na PROPRIA escrita, na FK composta. Uma consulta
 * previa acrescentaria round trip, abriria janela TOCTOU entre conferir
 * e gravar, e ainda seria capaz de responder sobre agente alheio.
 *
 * ── Por que UPSERT, e nao update, insert ou delete+insert ───────────
 *
 * Um `insert` puro nao substitui; um `update` puro nao cria a primeira
 * definicao; `delete` + `insert` sao duas instrucoes, e o client
 * Supabase nao abre transacao multi-statement — se a segunda falhasse, a
 * Funcao ficaria sem permissao nenhuma, que e justamente o estado que o
 * dono acabou de sair. O UPSERT sobre a PK e UMA instrucao atomica que
 * produz o estado final desejado nos dois casos.
 *
 * ── Por que nao ha RPC ──────────────────────────────────────────────
 *
 * Nao ha invariante ENTRE LINHAS a proteger — diferente de
 * `promover_skill_vigente`, onde um slug precisa de exatamente uma
 * vigente. Uma permissao e uma preferencia de linha unica, entao nao ha
 * CAS, versao, lock nem RPC. Duas definicoes simultaneas terminam em
 * last-writer-wins, e isso e o CORRETO: a ultima coisa que o dono
 * escolheu e o que ele quer.
 *
 * ── Trocar de dono e impossivel por desenho ─────────────────────────
 *
 * O ramo de conflito atualiza as colunas do payload, `user_id`
 * inclusive. Mirar a linha de um agente alheio produziria o par
 * `(agente do outro, user_id deste)`, que nao existe em
 * `agentes(id, user_id)` — a FK derruba a instrucao inteira com `23503`.
 */
export async function definirPermissaoDeFuncaoDoAgente(
  entrada: EntradaDefinirPermissao
): Promise<ResultadoDefinirPermissao> {
  if (!entradaValida(entrada)) return ENTRADA_INVALIDA;

  const { userId, agenteId, funcaoId, nivel } = entrada;

  // `criado_em` fica de FORA: o ramo de conflito so toca as colunas
  // presentes, entao omiti-lo preserva a data da primeira definicao na
  // substituicao, e deixa o `DEFAULT now()` valer na criacao.
  //
  // `alterado_em` entra explicitamente porque a tabela nao tem trigger
  // nenhuma — o DEFAULT nao e reaplicado no UPDATE, e sem esta linha o
  // carimbo ficaria congelado no dia da criacao para sempre.
  const r = await getSupabaseServidor()
    .from(TABELA_PERMISSOES)
    .upsert(
      {
        agente_id: agenteId,
        user_id: userId,
        funcao_id: funcaoId,
        nivel,
        alterado_em: new Date().toISOString(),
      },
      { onConflict: CONFLITO_IDENTIDADE }
    );

  if (r.error) {
    const codigo = codigoDe(r.error);

    // Agente inexistente ou agente de outro dono. Um estado so, de
    // proposito.
    if (codigo === SQLSTATE_FK) return NAO_DISPONIVEL;

    console.error(`[permissoes] falha ao definir permissao (sqlstate ${codigo ?? "desconhecido"})`);
    return FALHA_ESCRITA;
  }

  // Sem `.select()`: ausencia de erro E a prova de que a linha ficou no
  // estado pedido. Devolver a linha so ofereceria dado que o chamador
  // nao precisa — e "criada" contra "substituida" e distincao que
  // ninguem pediu, com o mesmo estado final nos dois casos.
  return DEFINIDA;
}
