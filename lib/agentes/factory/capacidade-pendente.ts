import "server-only";

/**
 * A capacidade que falta, e a tarefa que espera — F7b.4.6 §10/§11.
 *
 * ── Por que a tarefa precisa de identidade ──────────────────────────
 *
 * Entre "faltou Planilhas" e "pronto, analisei seu arquivo" ha uma espera
 * com um humano no meio. Ele clica, pode dar refresh, pode sair e voltar,
 * pode ter de autorizar uma conta do Google. O que atravessa tudo isso e
 * esta linha.
 *
 * Sem ela, depois de ativar a ferramenta so restaria dizer "pronto,
 * adicionei" — e pedir que a pessoa repetisse o pedido. E o §9 proibe
 * exatamente isso.
 *
 * ── A autoridade nao vem do cliente ─────────────────────────────────
 *
 * O cliente manda UM id de pendencia e, quando ha mais de uma opcao, qual
 * delas. `objetivo`, `agente_id` e `user_id` saem todos da linha gravada;
 * as OPCOES tambem, congeladas no momento em que a CDS as resolveu.
 *
 * Congelar as opcoes tem uma razao concreta: a pessoa clica no que leu. Se
 * o catalogo mudasse entre o cartao e o clique, ela ativaria outra coisa.
 */
import { getSupabaseServidor } from "@/lib/estudio-anuncios/supabase-servidor";
import type { OpcaoDeCapacidade } from "@/lib/agentes/factory/capacidade-faltante";

const TABELA = "agente_capacidades_pendentes";
const COLUNAS =
  "id, agente_id, conversa_id, objetivo, necessidade, opcoes, " +
  "escolha_chave, escolha_origem, estado";

/** Os estados em que a pendencia ainda pode virar alguma coisa. */
export const ESTADOS_VIVOS = Object.freeze([
  "pendente", "ativando", "aguardando_conexao",
] as const);

export interface CapacidadePendente {
  readonly id: string;
  readonly agenteId: string;
  readonly conversaId: string;
  /** O que a pessoa pediu, com as palavras dela. */
  readonly objetivo: string;
  readonly necessidade: string;
  readonly opcoes: readonly OpcaoDeCapacidade[];
  readonly escolhaChave: string | null;
  readonly escolhaOrigem: "cds" | "integracao" | null;
  readonly estado: string;
}

function daLinha(bruta: unknown): CapacidadePendente | null {
  if (typeof bruta !== "object" || bruta === null) return null;
  const l = bruta as Record<string, unknown>;
  if (typeof l.id !== "string" || typeof l.objetivo !== "string") return null;
  if (typeof l.agente_id !== "string" || typeof l.conversa_id !== "string") return null;

  const opcoes: OpcaoDeCapacidade[] = [];
  if (Array.isArray(l.opcoes)) {
    for (const o of l.opcoes) {
      if (typeof o !== "object" || o === null) continue;
      const x = o as Record<string, unknown>;
      if (typeof x.chave !== "string" || typeof x.nome !== "string") continue;
      opcoes.push({
        chave: x.chave,
        origem: x.origem === "integracao" ? "integracao" : "cds",
        nome: x.nome,
        descricao: typeof x.descricao === "string" ? x.descricao : "",
        exigeConexao: x.exigeConexao === true,
      });
    }
  }

  return {
    id: l.id,
    agenteId: l.agente_id,
    conversaId: l.conversa_id,
    objetivo: l.objetivo,
    necessidade: typeof l.necessidade === "string" ? l.necessidade : "",
    opcoes,
    escolhaChave: typeof l.escolha_chave === "string" ? l.escolha_chave : null,
    escolhaOrigem: l.escolha_origem === "cds" || l.escolha_origem === "integracao"
      ? l.escolha_origem : null,
    estado: typeof l.estado === "string" ? l.estado : "",
  };
}

/**
 * Cria — ou reencontra — a pendencia desta conversa.
 *
 * ── Por que REENCONTRAR, e nao criar sempre ─────────────────────────
 *
 * A pessoa pode reformular o pedido antes de clicar. Criar uma pendencia
 * por turno encheria o chat de cartoes iguais, e o terceiro seria tao
 * ignorado quanto o segundo.
 *
 * Uma viva por conversa e por necessidade: enquanto o cartao de Planilhas
 * estiver aberto, pedir de novo nao cria outro.
 */
export async function abrirCapacidadePendente(entrada: {
  readonly userId: string;
  readonly agenteId: string;
  readonly conversaId: string;
  readonly objetivo: string;
  readonly necessidade: string;
  readonly opcoes: readonly OpcaoDeCapacidade[];
}): Promise<CapacidadePendente | null> {
  const { userId, agenteId, conversaId, objetivo, necessidade, opcoes } = entrada;
  if (!userId || !agenteId || !conversaId) return null;
  if (objetivo.trim() === "" || necessidade.trim() === "") return null;
  if (opcoes.length === 0) return null;

  const db = getSupabaseServidor();

  const viva = await db
    .from(TABELA)
    .select(COLUNAS)
    .eq("user_id", userId)
    .eq("conversa_id", conversaId)
    .eq("necessidade", necessidade)
    .in("estado", [...ESTADOS_VIVOS])
    .limit(1);
  if (viva.error) {
    console.error("[capacidades] falha ao procurar pendencia viva");
    return null;
  }
  const ja = (viva.data ?? [])[0];
  if (ja !== undefined) return daLinha(ja);

  const { data, error } = await db
    .from(TABELA)
    .insert({
      user_id: userId, agente_id: agenteId, conversa_id: conversaId,
      objetivo: objetivo.trim().slice(0, 4000),
      necessidade,
      opcoes,
    })
    .select(COLUNAS)
    .limit(1);
  if (error) {
    console.error("[capacidades] falha ao abrir pendencia");
    return null;
  }
  return daLinha((data ?? [])[0]);
}

export type LeituraDaPendencia =
  | { readonly leitura: "ok"; readonly pendencia: CapacidadePendente }
  | { readonly leitura: "nao_encontrada" }
  | { readonly leitura: "falha" };

/**
 * UMA pendencia, escopada pelo dono.
 *
 * "nao existe" e "e de outra pessoa" dao o MESMO resultado, pela mesma
 * razao de sempre — distinguir seria um oraculo sobre recurso alheio.
 */
export async function lerCapacidadePendente(entrada: {
  readonly userId: string;
  readonly pendenciaId: string;
}): Promise<LeituraDaPendencia> {
  if (!entrada.userId || !entrada.pendenciaId) return { leitura: "nao_encontrada" };

  const { data, error } = await getSupabaseServidor()
    .from(TABELA)
    .select(COLUNAS)
    .eq("id", entrada.pendenciaId)
    .eq("user_id", entrada.userId)
    .limit(1);
  if (error) {
    console.error("[capacidades] falha ao ler pendencia");
    return { leitura: "falha" };
  }
  const p = daLinha((data ?? [])[0]);
  return p === null ? { leitura: "nao_encontrada" } : { leitura: "ok", pendencia: p };
}

/** A pendencia ainda VIVA de uma conversa. E o que faz o cartao voltar. */
export async function lerPendenciaVivaDaConversa(entrada: {
  readonly userId: string;
  readonly conversaId: string;
}): Promise<
  | { readonly leitura: "ok"; readonly pendencia: CapacidadePendente | null }
  | { readonly leitura: "falha" }
> {
  if (!entrada.userId || !entrada.conversaId) {
    return { leitura: "ok", pendencia: null };
  }
  const { data, error } = await getSupabaseServidor()
    .from(TABELA)
    .select(COLUNAS)
    .eq("user_id", entrada.userId)
    .eq("conversa_id", entrada.conversaId)
    .in("estado", [...ESTADOS_VIVOS])
    .order("criado_em", { ascending: false })
    .limit(1);
  if (error) {
    console.error("[capacidades] falha ao ler pendencia viva");
    return { leitura: "falha" };
  }
  return { leitura: "ok", pendencia: daLinha((data ?? [])[0]) };
}

export type ResultadoDeTransicao =
  | { readonly estado: "ok" }
  /** Outro clique venceu a corrida. Idempotencia: nao e erro. */
  | { readonly estado: "ja_decidida" }
  | { readonly estado: "falha" };

/**
 * Move a pendencia de estado, SO a partir de um estado esperado.
 *
 * ── A condicao no WHERE e a idempotencia — §11 ──────────────────────
 *
 * `.in("estado", de)` faz o UPDATE nao encontrar linha quando outro clique
 * ja moveu. Dois cliques simultaneos: o primeiro atualiza uma linha, o
 * segundo atualiza zero e recebe `ja_decidida`.
 *
 * Nao ha trava nossa e nao ha janela entre conferir e gravar — quem
 * garante e o banco, que e o unico que roda em transacao.
 */
export async function moverPendencia(entrada: {
  readonly userId: string;
  readonly pendenciaId: string;
  readonly de: readonly string[];
  readonly para: string;
  readonly escolha?: { readonly chave: string; readonly origem: "cds" | "integracao" };
}): Promise<ResultadoDeTransicao> {
  const { userId, pendenciaId, de, para } = entrada;
  if (!userId || !pendenciaId) return { estado: "falha" };

  const agora = new Date().toISOString();
  const alteracoes: Record<string, unknown> = { estado: para };
  if (entrada.escolha !== undefined) {
    alteracoes.escolha_chave = entrada.escolha.chave;
    alteracoes.escolha_origem = entrada.escolha.origem;
    alteracoes.decidido_em = agora;
  }
  if (para === "concluida" || para === "recusada" || para === "falhou") {
    alteracoes.concluido_em = agora;
  }

  const { data, error } = await getSupabaseServidor()
    .from(TABELA)
    .update(alteracoes)
    .eq("id", pendenciaId)
    .eq("user_id", userId)
    .in("estado", [...de])
    .select("id");
  if (error) {
    console.error("[capacidades] falha ao mover pendencia");
    return { estado: "falha" };
  }
  return (data ?? []).length === 1 ? { estado: "ok" } : { estado: "ja_decidida" };
}
