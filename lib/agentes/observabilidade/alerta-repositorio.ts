/**
 * OBS-4 — a porta de persistencia dos incidentes.
 *
 * Aplica o que o reducer decidiu, e NADA mais: nenhuma regra de abrir,
 * escalar ou resolver vive aqui. Se este arquivo precisar decidir algo,
 * a decisao esta no lugar errado.
 *
 * ── AINDA NAO E CHAMADO POR NINGUEM ─────────────────────────────────
 *
 * O monitor (OBS-5) e quem vai usar isto. A migration correspondente
 * tambem nao foi aplicada em producao. Este modulo existe para que o
 * gate seguinte encontre a porta pronta e testada, nao para rodar agora.
 *
 * ── A CORRIDA ───────────────────────────────────────────────────────
 *
 * Duas execucoes sobrepostas do monitor podem tentar abrir o MESMO
 * incidente. A defesa final e o indice unico parcial
 * `..._um_aberto_por_chave`: a segunda recebe 23505 e vira uma releitura
 * seguida de atualizacao, em vez de uma segunda linha aberta que
 * ninguem notaria. Por isso `criarAlerta` devolve `duplicada` em vez de
 * lancar — a corrida perdida e informacao, nao erro.
 */
import "server-only";

import { getSupabaseServidor } from "@/lib/estudio-anuncios/supabase-servidor";

import type {
  CamposDeAtualizacao,
  EscopoDoAlerta,
  IncidenteAberto,
  NovoIncidente,
  SeveridadeDoAlerta,
  TipoDeAlerta,
} from "./alerta";

const TABELA = "agente_ingestao_alertas";
const COLUNAS =
  "id,tipo,estado,severidade_atual,severidade_maxima,causa_atual,ocorrencias," +
  "ultima_evidencia_chave,evidencias_saudaveis_consecutivas";

const SQLSTATE_UNICO = "23505";

export type LeituraDoAlerta =
  | { readonly estado: "encontrado"; readonly id: string; readonly incidente: IncidenteAberto }
  | { readonly estado: "ausente" }
  | { readonly estado: "falhou" };

export type EscritaDoAlerta =
  | { readonly estado: "aplicada" }
  /** Outra execucao abriu o mesmo incidente primeiro. */
  | { readonly estado: "duplicada" }
  | { readonly estado: "falhou" };

function lerIncidente(bruto: unknown): IncidenteAberto | null {
  if (typeof bruto !== "object" || bruto === null) return null;
  const o = bruto as Record<string, unknown>;
  const tipo = o.tipo;
  const atual = o.severidade_atual;
  const maxima = o.severidade_maxima;
  const ocorrencias = o.ocorrencias;
  const saudaveis = o.evidencias_saudaveis_consecutivas;
  if (typeof tipo !== "string") return null;
  if (typeof atual !== "string" || typeof maxima !== "string") return null;
  if (typeof ocorrencias !== "number" || !Number.isInteger(ocorrencias)) return null;
  if (typeof saudaveis !== "number" || !Number.isInteger(saudaveis)) return null;
  const chave = o.ultima_evidencia_chave;
  return {
    tipo: tipo as TipoDeAlerta,
    severidadeAtual: atual as SeveridadeDoAlerta,
    severidadeMaxima: maxima as SeveridadeDoAlerta,
    causaAtual: typeof o.causa_atual === "string" ? o.causa_atual : null,
    ocorrencias,
    ultimaEvidenciaChave: typeof chave === "string" ? chave : null,
    evidenciasSaudaveisConsecutivas: saudaveis,
  };
}

/**
 * O incidente ABERTO daquela chave logica, se houver.
 *
 * Sem `maybeSingle()`: o indice unico parcial ja garante no maximo um, e
 * um `.limit(2)` denuncia um schema que deixou de garanti-lo em vez de
 * escolher o primeiro em silencio.
 */
export async function lerAlertaAberto(
  escopo: EscopoDoAlerta,
  tipo: TipoDeAlerta,
  signal?: AbortSignal
): Promise<LeituraDoAlerta> {
  let consulta = getSupabaseServidor()
    .from(TABELA)
    .select("id," + COLUNAS)
    .eq("user_id", escopo.userId)
    .eq("agente_id", escopo.agenteId)
    .eq("plataforma", escopo.plataforma)
    .eq("recurso", escopo.recurso)
    .eq("tipo", tipo)
    .eq("estado", "aberto")
    .limit(2);
  if (signal !== undefined) consulta = consulta.abortSignal(signal);

  const { data, error } = await consulta;
  if (error) {
    console.error("[observabilidade] falha ao ler alerta aberto");
    return { estado: "falhou" };
  }
  if (!Array.isArray(data)) return { estado: "falhou" };
  if (data.length === 0) return { estado: "ausente" };
  if (data.length > 1) {
    console.error("[observabilidade] mais de um alerta aberto para a mesma chave");
    return { estado: "falhou" };
  }
  // Via `unknown`: o cliente tipado nao conhece esta tabela ainda, e o
  // tipo que ele infere nao se sobrepoe ao shape real. A validacao de
  // verdade e `lerIncidente`, campo a campo, logo abaixo.
  const linha = data[0] as unknown as Record<string, unknown>;
  const incidente = lerIncidente(linha);
  if (incidente === null) return { estado: "falhou" };
  const id = linha.id;
  if (typeof id !== "string") return { estado: "falhou" };
  return { estado: "encontrado", id, incidente };
}

const iso = (ms: number) => new Date(ms).toISOString();

export async function criarAlerta(
  novo: NovoIncidente,
  signal?: AbortSignal
): Promise<EscritaDoAlerta> {
  let consulta = getSupabaseServidor().from(TABELA).insert({
    user_id: novo.escopo.userId,
    agente_id: novo.escopo.agenteId,
    plataforma: novo.escopo.plataforma,
    recurso: novo.escopo.recurso,
    tipo: novo.tipo,
    estado: "aberto",
    severidade_atual: novo.severidadeAtual,
    severidade_maxima: novo.severidadeMaxima,
    causa_atual: novo.causaAtual,
    ocorrencias: novo.ocorrencias,
    ultima_evidencia_chave: novo.ultimaEvidenciaChave,
    evidencias_saudaveis_consecutivas: novo.evidenciasSaudaveisConsecutivas,
    detalhes: novo.detalhes,
    aberto_em: iso(novo.abertoEm),
    ultimo_visto_em: iso(novo.ultimoVistoEm),
    ultima_avaliacao_em: iso(novo.ultimaAvaliacaoEm),
  });
  if (signal !== undefined) consulta = consulta.abortSignal(signal);

  const { error } = await consulta;
  if (error) {
    // A corrida perdida NAO e erro: o indice parcial fez o trabalho dele.
    if ((error as { code?: string }).code === SQLSTATE_UNICO) return { estado: "duplicada" };
    console.error("[observabilidade] falha ao abrir alerta");
    return { estado: "falhou" };
  }
  return { estado: "aplicada" };
}

function corpoDaAtualizacao(campos: CamposDeAtualizacao): Record<string, unknown> {
  const corpo: Record<string, unknown> = {
    ultima_avaliacao_em: iso(campos.ultimaAvaliacaoEm),
  };
  if (campos.severidadeAtual !== undefined) corpo.severidade_atual = campos.severidadeAtual;
  if (campos.severidadeMaxima !== undefined) corpo.severidade_maxima = campos.severidadeMaxima;
  if (campos.causaAtual !== undefined) corpo.causa_atual = campos.causaAtual;
  if (campos.ocorrencias !== undefined) corpo.ocorrencias = campos.ocorrencias;
  if (campos.ultimaEvidenciaChave !== undefined) {
    corpo.ultima_evidencia_chave = campos.ultimaEvidenciaChave;
  }
  if (campos.evidenciasSaudaveisConsecutivas !== undefined) {
    corpo.evidencias_saudaveis_consecutivas = campos.evidenciasSaudaveisConsecutivas;
  }
  if (campos.ultimoVistoEm !== undefined) corpo.ultimo_visto_em = iso(campos.ultimoVistoEm);
  if (campos.detalhes !== undefined) corpo.detalhes = campos.detalhes;
  return corpo;
}

export async function atualizarAlerta(
  id: string,
  campos: CamposDeAtualizacao,
  signal?: AbortSignal
): Promise<EscritaDoAlerta> {
  let consulta = getSupabaseServidor()
    .from(TABELA)
    .update(corpoDaAtualizacao(campos))
    .eq("id", id)
    // So um incidente ABERTO e atualizavel: reabrir um resolvido por
    // acidente apagaria a fronteira entre dois incidentes distintos.
    .eq("estado", "aberto");
  if (signal !== undefined) consulta = consulta.abortSignal(signal);

  const { error } = await consulta;
  if (error) {
    console.error("[observabilidade] falha ao atualizar alerta");
    return { estado: "falhou" };
  }
  return { estado: "aplicada" };
}

export async function resolverAlerta(
  id: string,
  campos: CamposDeAtualizacao,
  resolvidoEm: number,
  signal?: AbortSignal
): Promise<EscritaDoAlerta> {
  let consulta = getSupabaseServidor()
    .from(TABELA)
    .update({
      ...corpoDaAtualizacao(campos),
      estado: "resolvido",
      resolvido_em: iso(resolvidoEm),
    })
    .eq("id", id)
    .eq("estado", "aberto");
  if (signal !== undefined) consulta = consulta.abortSignal(signal);

  const { error } = await consulta;
  if (error) {
    console.error("[observabilidade] falha ao resolver alerta");
    return { estado: "falhou" };
  }
  return { estado: "aplicada" };
}
