/**
 * Escrita autorizada da selecao de loja — SKILL-1D.g.2-B.
 *
 * ── As duas perguntas que este modulo responde ──────────────────────
 *
 *   "para ESTE requisito deste agente, passa a valer ESTA loja"
 *   "este requisito deste agente deixa de ter loja"
 *
 * A 1D.g.1 criou onde guardar (`agente_conexoes`) e ensinou a LER
 * (`selecao-fatos.ts`). Ate aqui nada sabia GRAVAR: a tabela so podia
 * ser povoada por SQL manual. Este e o caminho de escrita.
 *
 * ── O que este modulo NAO faz ───────────────────────────────────────
 *
 * Nao ESCOLHE. Nao busca lojas, nao pega a primeira, nao pega a unica,
 * nao infere por marketplace, nao tem `limit(1)` nem `maybeSingle`.
 * `lojaId` ausente e entrada invalida, nunca convite para decidir.
 *
 * Nao confere se a loja SERVE. `lojas.marketplace`, token, validade e
 * cobertura do recurso sao de `resolverFatoConexao`, e continuam la. Uma
 * selecao gravada hoje pode ser considerada indisponivel amanha sem que
 * nada aqui esteja errado: esta camada responde QUAL loja o dono
 * escolheu, nao SE ela esta operacional.
 *
 * Nao le token, `access_token`, `refresh_token` nem `partner_key` — nao
 * ha `select` de credencial em lugar nenhum deste arquivo.
 *
 * E nao tem consumidor de producao: nenhuma rota, UI ou chat o chama, e
 * uma sonda da suite cobra esse zero.
 *
 * ── Autenticacao NAO acontece aqui ──────────────────────────────────
 *
 * As FKs compostas garantem que o `user_id` informado seja COERENTE com
 * o agente e com a loja. Elas nao provam que quem chamou e aquele dono —
 * isso e obrigacao do wiring de producao, que ainda nao existe. Por isso
 * o payload e montado INTERNAMENTE, campo a campo: nao ha `...entrada`
 * espalhado para dentro da escrita, e nenhuma coluna arbitraria do
 * chamador alcanca a tabela.
 */
import "server-only";
import { getSupabaseServidor } from "@/lib/estudio-anuncios/supabase-servidor";
import { plataformaConhecida, recursoValido } from "@/lib/agentes/conexoes/selecao-estado";

const TABELA_SELECOES = "agente_conexoes";

/**
 * O alvo do conflito e a PK publicada, e nada alem dela.
 *
 * `user_id` NAO entra: ele nao faz parte da identidade logica — um
 * agente pertence a um dono so, entao acrescenta-lo ao alvo nao
 * separaria nada e exigiria um indice unico que nao existe.
 * `loja_id` e `alterado_em` sao o que MUDA; alvo de conflito e o que
 * identifica.
 */
const CONFLITO_IDENTIDADE = "agente_id,plataforma,recurso";

/**
 * O unico SQLSTATE com significado de DOMINIO aqui.
 *
 * `23503` e qualquer das duas FKs compostas — e as quatro causas
 * possiveis (agente inexistente, loja inexistente, agente de outro dono,
 * loja de outro dono) chegam INDISTINGUIVEIS de proposito: separa-las
 * viraria um oraculo de existencia de recurso alheio. Mesmo tratamento
 * de `associarSkillAoAgente`.
 *
 * Nao ha `23505` a tratar: o UPSERT existe justamente para que colidir
 * com a PK seja o caminho normal, nao um erro.
 */
const SQLSTATE_FK = "23503";

/**
 * A autoridade da definicao: dono, agente, requisito e escolha.
 *
 * Os cinco campos, sempre juntos e tipados um a um. Nao existe campo
 * livre, nao existe objeto de colunas — o que chega aqui e contrato, nao
 * payload.
 */
export interface EntradaDefinirSelecao {
  userId: string;
  agenteId: string;
  plataforma: string;
  recurso: string;
  lojaId: string;
}

/** A remocao nao tem `lojaId`: apagar a escolha nao depende de saber
 *  qual era. Exigi-lo permitiria "remova se for a loja X", que e outra
 *  operacao — e uma que ninguem pediu. */
export interface EntradaRemoverSelecao {
  userId: string;
  agenteId: string;
  plataforma: string;
  recurso: string;
}

export interface ResultadoDefinir {
  estado: "definida" | "nao_disponivel" | "entrada_invalida" | "falha_escrita";
}

export interface ResultadoRemover {
  estado: "removida" | "nao_encontrada" | "entrada_invalida" | "falha_escrita";
}

const DEFINIR_ENTRADA_INVALIDA: ResultadoDefinir = Object.freeze({ estado: "entrada_invalida" as const });
const DEFINIR_NAO_DISPONIVEL: ResultadoDefinir = Object.freeze({ estado: "nao_disponivel" as const });
const DEFINIR_FALHA: ResultadoDefinir = Object.freeze({ estado: "falha_escrita" as const });
const DEFINIDA: ResultadoDefinir = Object.freeze({ estado: "definida" as const });

const REMOVER_ENTRADA_INVALIDA: ResultadoRemover = Object.freeze({ estado: "entrada_invalida" as const });
const REMOVER_FALHA: ResultadoRemover = Object.freeze({ estado: "falha_escrita" as const });
const REMOVIDA: ResultadoRemover = Object.freeze({ estado: "removida" as const });
const NAO_ENCONTRADA: ResultadoRemover = Object.freeze({ estado: "nao_encontrada" as const });

/** Codigo SQLSTATE do erro do PostgREST, sem tocar em `message` — a
 *  mensagem do driver vaza nome de coluna, de constraint e as vezes de
 *  VALOR, e acaba em log e em resposta HTTP. Mesma logica do modulo de
 *  escrita de Skills, reproduzida aqui porque la ela nao e exportada e
 *  exporta-la exigiria editar um arquivo publicado fora desta frente. */
function codigoDe(erro: unknown): string | undefined {
  return (erro as { code?: string } | null)?.code;
}

/**
 * O requisito e o dono, validados antes de qualquer ida ao banco.
 *
 * `plataformaConhecida` e `recursoValido` vem de `selecao-estado.ts` —
 * a MESMA autoridade que a leitura usa, que por sua vez le
 * `MARKETPLACE_POR_PLATAFORMA`. Nao ha segunda lista aqui, e nao ha
 * regex de slug propria: divergir da leitura significaria gravar
 * selecao que a leitura depois recusaria.
 */
function requisitoValido(userId: string, agenteId: string, plataforma: string, recurso: string): boolean {
  if (!userId || !agenteId) return false;
  if (!plataformaConhecida(plataforma)) return false;
  return recursoValido(recurso);
}

/**
 * Define — ou substitui — a loja selecionada para um requisito.
 *
 * ── Uma escrita, sem pre-leitura ────────────────────────────────────
 *
 * Nao se busca o agente nem a loja antes para conferir o dono depois: a
 * conferencia esta na PROPRIA escrita, nas duas FKs compostas
 * `(agente_id, user_id)` e `(loja_id, user_id)`. Uma consulta previa
 * acrescentaria round trip, abriria janela TOCTOU entre conferir e
 * gravar, e ainda seria capaz de responder sobre recurso alheio.
 *
 * ── Por que UPSERT, e nao update, insert ou delete+insert ───────────
 *
 * Um `insert` puro nao substitui; um `update` puro nao cria a primeira
 * selecao; `delete` + `insert` sao duas instrucoes, e o client Supabase
 * nao abre transacao multi-statement — se a segunda falhasse, o
 * requisito ficaria sem loja nenhuma. O UPSERT sobre a PK e UMA
 * instrucao atomica que produz o estado final desejado nos dois casos.
 *
 * ── Concorrencia ────────────────────────────────────────────────────
 *
 * Duas definicoes simultaneas para o mesmo requisito terminam em
 * last-writer-wins, e isso e o CORRETO para uma preferencia explicita:
 * a ultima coisa que o dono escolheu e o que ele quer. Nao ha invariante
 * entre linhas a proteger — diferente de `promover_skill_vigente`, onde
 * um slug precisa de exatamente uma vigente —, entao nao ha CAS, versao,
 * lock nem RPC.
 *
 * ── Trocar de dono e impossivel por desenho ─────────────────────────
 *
 * O ramo de conflito atualiza as colunas do payload, `user_id`
 * inclusive. Mirar a linha de um agente alheio produziria o par
 * `(agente do outro, user_id deste)`, que nao existe em
 * `agentes(id, user_id)` — a FK derruba a instrucao inteira com `23503`.
 */
export async function definirSelecaoDeLoja(entrada: EntradaDefinirSelecao): Promise<ResultadoDefinir> {
  const { userId, agenteId, plataforma, recurso, lojaId } = entrada;

  // Sem loja NAO ha escolha a registrar — e nao ha busca a fazer. Zero
  // query: procurar "alguma loja compativel" aqui seria exatamente a
  // escolha implicita que esta camada existe para nao fazer.
  if (!lojaId) return DEFINIR_ENTRADA_INVALIDA;
  if (!requisitoValido(userId, agenteId, plataforma, recurso)) return DEFINIR_ENTRADA_INVALIDA;

  // `criado_em` fica de FORA: o ramo de conflito so toca as colunas
  // presentes, entao omiti-lo preserva a data de criacao original na
  // substituicao, e deixa o `DEFAULT now()` valer na criacao.
  //
  // `alterado_em` entra explicitamente porque o projeto nao tem trigger
  // nenhuma — o DEFAULT nao e reaplicado no UPDATE, e sem esta linha o
  // carimbo ficaria congelado no dia da criacao para sempre.
  const r = await getSupabaseServidor()
    .from(TABELA_SELECOES)
    .upsert(
      {
        agente_id: agenteId,
        user_id: userId,
        plataforma,
        recurso,
        loja_id: lojaId,
        alterado_em: new Date().toISOString(),
      },
      { onConflict: CONFLITO_IDENTIDADE }
    );

  if (r.error) {
    const codigo = codigoDe(r.error);

    // Agente inexistente, loja inexistente, ou qualquer dos dois de
    // outro dono. Um estado so, de proposito.
    if (codigo === SQLSTATE_FK) return DEFINIR_NAO_DISPONIVEL;

    console.error(`[conexoes] falha ao definir selecao (sqlstate ${codigo ?? "desconhecido"})`);
    return DEFINIR_FALHA;
  }

  // Sem `.select()`: ausencia de erro E a prova de que a linha ficou no
  // estado pedido. Devolver a linha so ofereceria dado que o chamador
  // nao precisa — e "criada" contra "substituida" e distincao que
  // ninguem pediu, com o mesmo estado final nos dois casos.
  return DEFINIDA;
}

/**
 * Remove a selecao exata — e so ela.
 *
 * O DELETE e quadruplamente filtrado. `user_id` nao pertence a PK, e e
 * justamente ele que fecha a operacao no dono: sem esse filtro, conhecer
 * o uuid de um agente alheio bastaria para apagar a escolha dele.
 *
 * Ausencia e estado proprio, nao sucesso mudo. E a distincao sai do
 * `.select()` do PROPRIO DELETE, nao de uma consulta previa: como o
 * DELETE ja e fechado por dono, ele so pode devolver linha do proprio
 * dono — perguntar antes "existe?" seria justamente a consulta capaz de
 * responder sobre selecao alheia. Por isso tambem nao se distingue "nao
 * existia" de "era de outro dono": os dois sao a mesma resposta.
 */
export async function removerSelecaoDeLoja(entrada: EntradaRemoverSelecao): Promise<ResultadoRemover> {
  const { userId, agenteId, plataforma, recurso } = entrada;

  if (!requisitoValido(userId, agenteId, plataforma, recurso)) return REMOVER_ENTRADA_INVALIDA;

  // Projecao minima. `agente_id` basta para contar linhas, e nao carrega
  // a escolha nem carimbo nenhum de volta.
  const r = await getSupabaseServidor()
    .from(TABELA_SELECOES)
    .delete()
    .eq("user_id", userId)
    .eq("agente_id", agenteId)
    .eq("plataforma", plataforma)
    .eq("recurso", recurso)
    .select("agente_id");

  if (r.error) {
    console.error(`[conexoes] falha ao remover selecao (sqlstate ${codigoDe(r.error) ?? "desconhecido"})`);
    return REMOVER_FALHA;
  }

  const removidas = ((r.data ?? []) as unknown[]).length;
  return removidas > 0 ? REMOVIDA : NAO_ENCONTRADA;
}
