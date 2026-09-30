import "server-only";

/**
 * O que o agente POSSUI de ferramenta externa — AGENT-FACTORY-F7b.4.2.
 *
 * ── A distincao que este modulo existe para sustentar ───────────────
 *
 *   POSSUIR   esta tabela          -> o agente TEM esta acao
 *   PODER     `agente_permissoes`  -> COMO ele pode usa-la
 *
 * No F7b.4.1 as duas eram a mesma linha, e isso apagava o estado mais
 * importante: "selecionada e ainda nao decidida". Sem ele a regra de
 * completude da ativacao nao tinha o que barrar, e o nivel que o dono
 * deveria escolher vinha de um default nosso.
 *
 * ── A consequencia que o gate exige, e que cai daqui ────────────────
 *
 * Permissao que sobrou de um vinculo removido NAO ressuscita a
 * ferramenta. Quem afirma que a Funcao externa EXISTE e esta tabela; a
 * permissao so diz o nivel. Por isso `fatosDeFuncaoExterna` deriva
 * `existe` do VINCULO, e nunca da permissao — e e esse fato que
 * `autorizarFuncao` consome.
 *
 * Sem isso, desvincular uma ferramenta deixaria a permissao antiga
 * falando por ela, e o modelo continuaria recebendo a declaracao de algo
 * que o dono ja tirou do agente.
 */
import { getSupabaseServidor } from "@/lib/estudio-anuncios/supabase-servidor";
import {
  ehFuncaoExterna, idDaFuncaoExterna, pecasDoId,
} from "@/lib/agentes/composio/identidade-de-funcao";
import { NIVEIS_AUTONOMIA } from "@/lib/ia/conceitos";

const TABELA = "agente_ferramentas_externas";
const COLUNAS = "id, provedor_externo, toolkit, acao, funcao_id, criado_em";

export interface VinculoExterno {
  readonly id: string;
  readonly provedorExterno: string;
  readonly toolkit: string;
  readonly acao: string;
  readonly funcaoId: string;
  readonly criadoEm: string;
}

export type ResultadoVinculos =
  | { readonly coleta: "ok"; readonly vinculos: readonly VinculoExterno[] }
  | { readonly coleta: "entrada_invalida" }
  | { readonly coleta: "falha" };

function daLinha(bruta: unknown): VinculoExterno | null {
  if (typeof bruta !== "object" || bruta === null) return null;
  const l = bruta as Record<string, unknown>;
  if (typeof l.id !== "string" || typeof l.funcao_id !== "string") return null;
  if (typeof l.toolkit !== "string" || typeof l.acao !== "string") return null;
  return {
    id: l.id,
    provedorExterno: typeof l.provedor_externo === "string" ? l.provedor_externo : "",
    toolkit: l.toolkit,
    acao: l.acao,
    funcaoId: l.funcao_id,
    criadoEm: typeof l.criado_em === "string" ? l.criado_em : "",
  };
}

/** As ferramentas externas deste agente. Escopo na propria instrucao. */
export async function listarVinculosExternos(entrada: {
  readonly userId: string;
  readonly agenteId: string;
  readonly signal?: AbortSignal;
}): Promise<ResultadoVinculos> {
  const { userId, agenteId } = entrada;
  if (!userId || !agenteId) return { coleta: "entrada_invalida" };

  const consulta = getSupabaseServidor()
    .from(TABELA)
    .select(COLUNAS)
    .eq("user_id", userId)
    .eq("agente_id", agenteId);

  const { data, error } = await (entrada.signal === undefined
    ? consulta : consulta.abortSignal(entrada.signal));

  if (error) {
    // Sem `error.message`: driver vaza nome de coluna e de constraint.
    console.error("[ferramentas-externas] falha ao listar vinculos");
    return { coleta: "falha" };
  }

  const vinculos: VinculoExterno[] = [];
  for (const bruta of data ?? []) {
    const v = daLinha(bruta);
    // Linha torta CONDENA a coleta. Uma lista pela metade apresentada
    // como completa faria o agente perder uma ferramenta em silencio.
    if (v === null) return { coleta: "falha" };
    vinculos.push(v);
  }
  return { coleta: "ok", vinculos };
}

export type ResultadoVincular =
  | { readonly estado: "vinculada"; readonly funcaoId: string }
  | { readonly estado: "ja_vinculada"; readonly funcaoId: string }
  | { readonly estado: "entrada_invalida"; readonly motivo: string }
  | { readonly estado: "falha" };

/**
 * Vincula UMA acao externa ao agente.
 *
 * NAO grava permissao. E o ponto inteiro: a acao passa a existir para o
 * agente e fica UNCONFIGURED ate o dono decidir o nivel, o que e o que
 * faz a ativacao ser barrada.
 *
 * Idempotente: vincular duas vezes e a mesma coisa que vincular uma. O
 * `unique (agente_id, funcao_id)` garante isso no banco, e `ja_vinculada`
 * e sucesso para quem so queria garantir.
 */
export async function vincularFerramentaExternaNoAgente(entrada: {
  readonly userId: string;
  readonly agenteId: string;
  readonly provedorExterno: string;
  readonly toolkit: string;
  readonly acao: string;
}): Promise<ResultadoVincular> {
  const { userId, agenteId, provedorExterno, toolkit, acao } = entrada;
  if (!userId || !agenteId) return { estado: "entrada_invalida", motivo: "autoridade" };
  if (!toolkit.trim() || !acao.trim()) {
    return { estado: "entrada_invalida", motivo: "toolkit_ou_acao" };
  }

  const id = idDaFuncaoExterna({ toolkit, acao });
  if (!id.ok) return { estado: "entrada_invalida", motivo: id.motivo };

  const { error } = await getSupabaseServidor()
    .from(TABELA)
    .insert({
      user_id: userId,
      agente_id: agenteId,
      provedor_externo: provedorExterno,
      toolkit: toolkit.trim().toLowerCase(),
      acao: acao.trim(),
      funcao_id: id.funcaoId,
    });

  if (error) {
    // `23505` e unique violation: ja existe, que e o estado desejado.
    if ((error as { code?: string }).code === "23505") {
      return { estado: "ja_vinculada", funcaoId: id.funcaoId };
    }
    console.error("[ferramentas-externas] falha ao vincular");
    return { estado: "falha" };
  }
  return { estado: "vinculada", funcaoId: id.funcaoId };
}

export type ResultadoDesvincular =
  | { readonly estado: "desvinculada" }
  | { readonly estado: "nao_encontrada" }
  | { readonly estado: "entrada_invalida" }
  | { readonly estado: "falha" };

/**
 * Remove o vinculo.
 *
 * A linha de permissao NAO e tocada, de proposito: ela e o registro de uma
 * decisao que o dono tomou, e apagar historico para remover uma ferramenta
 * seria perder informacao por conveniencia.
 *
 * O efeito e completo mesmo assim — sem vinculo, `fatosDeFuncaoExterna`
 * nao afirma `existe`, a Funcao nao e declarada ao modelo e o guard a
 * trata como inexistente. E isso que faz "permissao historica nao
 * ressuscita ferramenta removida" ser verdade por construcao.
 */
export async function desvincularFerramentaExternaDoAgente(entrada: {
  readonly userId: string;
  readonly agenteId: string;
  readonly funcaoId: string;
}): Promise<ResultadoDesvincular> {
  const { userId, agenteId, funcaoId } = entrada;
  if (!userId || !agenteId) return { estado: "entrada_invalida" };
  if (!ehFuncaoExterna(funcaoId)) return { estado: "entrada_invalida" };

  const { data, error } = await getSupabaseServidor()
    .from(TABELA)
    .delete()
    .eq("user_id", userId)
    .eq("agente_id", agenteId)
    .eq("funcao_id", funcaoId)
    .select("id");

  if (error) {
    console.error("[ferramentas-externas] falha ao desvincular");
    return { estado: "falha" };
  }
  return (data ?? []).length === 1
    ? { estado: "desvinculada" }
    : { estado: "nao_encontrada" };
}

export type ResultadoDefinirNivel =
  | { readonly estado: "definida" }
  | { readonly estado: "nao_vinculada" }
  | { readonly estado: "entrada_invalida" }
  | { readonly estado: "falha" };

/**
 * Define o nivel de UMA acao externa — F7b.4.2 §11/§16.
 *
 * ── Por que nao `definirPermissaoDeFuncaoDoAgente` ──────────────────
 *
 * Aquela escrita valida `funcaoExiste()` contra o registry, e isso esta
 * CORRETO: ela existe para as Functions que a CDS implementa, e aceitar id
 * arbitrario ali seria abrir a porta que a validacao fecha. Acao externa
 * nao esta no registry e sempre seria recusada.
 *
 * Entao a prova de existencia aqui e o VINCULO, que e a mesma autoridade
 * do §13 — e ela e conferida ANTES de gravar. Sem isso, um cliente poderia
 * gravar permissao para uma acao que o agente nem tem, e a permissao
 * voltaria a ser prova de existencia por acidente.
 *
 * Esta e a UNICA escrita de permissao externa que existe, e ela e sempre
 * uma DECISAO EXPLICITA do dono — nunca efeito colateral de vincular.
 */
export async function definirPermissaoDeFerramentaExterna(entrada: {
  readonly userId: string;
  readonly agenteId: string;
  readonly funcaoId: string;
  readonly nivel: string;
}): Promise<ResultadoDefinirNivel> {
  const { userId, agenteId, funcaoId, nivel } = entrada;
  if (!userId || !agenteId) return { estado: "entrada_invalida" };
  if (!ehFuncaoExterna(funcaoId)) return { estado: "entrada_invalida" };
  if (!(NIVEIS_AUTONOMIA as readonly string[]).includes(nivel)) {
    return { estado: "entrada_invalida" };
  }

  const db = getSupabaseServidor();

  // ── A prova de existencia: o vinculo ──────────────────────────────
  const achado = await db
    .from(TABELA)
    .select("id")
    .eq("user_id", userId)
    .eq("agente_id", agenteId)
    .eq("funcao_id", funcaoId)
    .limit(1);
  if (achado.error) {
    console.error("[ferramentas-externas] falha ao conferir vinculo");
    return { estado: "falha" };
  }
  if ((achado.data ?? []).length === 0) return { estado: "nao_vinculada" };

  // A mesma tabela e o mesmo `onConflict` do resto: nao ha segunda
  // arquitetura de permissao, e o guard continua lendo um lugar so.
  const { error } = await db
    .from("agente_permissoes")
    .upsert(
      {
        agente_id: agenteId,
        user_id: userId,
        funcao_id: funcaoId,
        nivel,
        alterado_em: new Date().toISOString(),
      },
      { onConflict: "agente_id,funcao_id" }
    );
  if (error) {
    console.error("[ferramentas-externas] falha ao definir nivel externo");
    return { estado: "falha" };
  }
  return { estado: "definida" };
}

/**
 * Os FATOS de existencia que o guard consome.
 *
 * Esta e a peca que sustenta o §13 do gate. `autorizarFuncao` recebe
 * `funcoes: FatoFuncao[]` e nega o que nao esta la; para Function externa,
 * quem entra nessa lista e o VINCULO — nunca a permissao.
 *
 * Derivado, e nao armazenado: um vinculo cujo id nao decompoe em pecas
 * validas NAO entra, porque uma Funcao que ninguem consegue nomear nao
 * deveria poder ser autorizada.
 */
export function fatosDeFuncaoExterna(
  vinculos: readonly VinculoExterno[]
): readonly { readonly id: string; readonly existe: true }[] {
  const fatos: { id: string; existe: true }[] = [];
  for (const v of vinculos) {
    if (!ehFuncaoExterna(v.funcaoId)) continue;
    if (pecasDoId(v.funcaoId) === null) continue;
    if (fatos.some((f) => f.id === v.funcaoId)) continue;
    fatos.push({ id: v.funcaoId, existe: true });
  }
  return fatos;
}
