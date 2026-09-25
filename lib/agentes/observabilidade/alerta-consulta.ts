/**
 * I4P10 — a leitura do operador. SOMENTE leitura.
 *
 * ── Por que nao reaproveita `alerta-repositorio` ────────────────────
 *
 * Aquele modulo e a porta do MONITOR: le um incidente aberto por chave
 * logica e escreve. Este le a lista do DONO e nao escreve nada. Manter
 * os dois separados e o que permite provar, por arquivo, que a
 * superficie do operador nao virou um segundo escritor da tabela — e
 * escritor concorrente e exatamente o que o I4P9-R1 acabou de fechar.
 *
 * ── A cerca de dono e a PRIMEIRA condicao de toda consulta ──────────
 *
 * Todas filtram `user_id` pela sessao. O `agenteId` opcional e filtro de
 * NAVEGACAO, nunca autoridade: ele entra por cima do dono, entao um id
 * de outro tenant devolve lista vazia em vez de dado alheio. Nao ha
 * consulta de "este agente e seu?" — a resposta e estruturalmente a
 * mesma de um agente que nao existe, e e assim de proposito: distinguir
 * os dois casos contaria a quem sonda quais ids existem.
 *
 * ── Ler pode falhar, e falha NAO e "nenhum alerta" ──────────────────
 *
 * Toda funcao aqui tem um estado `falhou` proprio. Transformar erro de
 * leitura em lista vazia faria a tela dizer "nada aberto" sobre uma
 * tabela que ninguem conseguiu ler — a mentira mais cara que uma
 * superficie de operacao pode contar.
 */
import "server-only";

import { getSupabaseServidor } from "@/lib/estudio-anuncios/supabase-servidor";

import {
  ordenarIncidentes,
  projetarIncidente,
  type AtividadeDoMonitor,
  type ConfiguracaoParaOperador,
  type IncidenteParaOperador,
  type MonitorDeUmAgente,
} from "./alerta-apresentacao";
import { interpretarLinhaDoEstadoEsperado } from "./estado-esperado";
import { PLATAFORMA_DO_MONITOR, RECURSO_DO_MONITOR } from "./monitor-ingestao";

const TABELA_ALERTAS = "agente_ingestao_alertas";
const TABELA_ESTADO = "agente_ingestao_estado_esperado";
const TABELA_LEASE = "agente_ingestao_monitor_lease";

/**
 * A minimizacao comeca no SELECT, nao na projecao.
 *
 * `user_id` fica de fora porque e a propria sessao de quem perguntou.
 * `ultima_evidencia_chave` e `evidencias_saudaveis_consecutivas` sao
 * vocabulario interno do reducer: dizem como o ciclo de vida decide, nao
 * o que houve, e nao teriam leitor na tela.
 */
const COLUNAS_ALERTA =
  "id,agente_id,tipo,estado,severidade_atual,severidade_maxima,causa_atual," +
  "aberto_em,ultimo_visto_em,ultima_avaliacao_em,resolvido_em,ocorrencias,detalhes";

/**
 * Teto de incidentes ABERTOS.
 *
 * O indice unico parcial ja limita a um aberto por (dono, agente,
 * recurso, tipo) — sao sete tipos, entao a lista real e pequena por
 * construcao. O teto existe so para que uma tabela anomala nao vire uma
 * consulta ilimitada.
 */
export const TETO_DE_ABERTOS = 200;

/** Historico curto: responde "ja aconteceu antes?", nao "conte tudo". */
export const LIMITE_DE_RESOLVIDOS = 10;

export type LeituraDeIncidentes =
  | { readonly estado: "ok"; readonly incidentes: readonly IncidenteParaOperador[] }
  | { readonly estado: "falhou" };

export type LeituraDeMonitores =
  | { readonly estado: "ok"; readonly monitores: readonly MonitorDeUmAgente[] }
  | { readonly estado: "falhou" };

function projetarLista(data: unknown[]): readonly IncidenteParaOperador[] {
  const saida: IncidenteParaOperador[] = [];
  for (const linha of data) {
    const projetado = projetarIncidente(linha);
    if (projetado !== null) saida.push(projetado);
  }
  return saida;
}

/**
 * Os incidentes ABERTOS do dono.
 *
 * A ordenacao por gravidade acontece em memoria, e isso e escolha, nao
 * limitacao: o ranking `critical > alert > warning` precisa ser
 * explicito — ordenar por texto poria `alert` na frente de `critical` —
 * e a lista e pequena por construcao. Ordenar no banco exigiria um CASE
 * que o cliente nao expressa, e uma segunda definicao da mesma ordem.
 */
export async function listarIncidentesAbertos(
  userId: string,
  filtro: { readonly agenteId?: string | null } = {}
): Promise<LeituraDeIncidentes> {
  if (typeof userId !== "string" || userId.length === 0) return { estado: "falhou" };

  let consulta = getSupabaseServidor()
    .from(TABELA_ALERTAS)
    .select(COLUNAS_ALERTA)
    .eq("user_id", userId)
    .eq("estado", "aberto")
    .limit(TETO_DE_ABERTOS);

  const agenteId = filtro.agenteId;
  if (typeof agenteId === "string" && agenteId.length > 0) {
    consulta = consulta.eq("agente_id", agenteId);
  }

  const { data, error } = await consulta;
  if (error) {
    // Sem `error.message`: mensagem de driver vaza nome de coluna.
    console.error("[observabilidade] falha ao listar incidentes abertos");
    return { estado: "falhou" };
  }
  if (!Array.isArray(data)) return { estado: "falhou" };

  return { estado: "ok", incidentes: ordenarIncidentes(projetarLista(data)) };
}

/**
 * Os ultimos incidentes RESOLVIDOS.
 *
 * Existe porque a primeira pergunta de quem investiga e "isso ja
 * aconteceu antes?", e a tabela guarda uma linha por incidente
 * justamente para responde-la. Ordenado pelo fim, nao pelo comeco.
 */
export async function listarIncidentesResolvidos(
  userId: string,
  filtro: { readonly agenteId?: string | null } = {}
): Promise<LeituraDeIncidentes> {
  if (typeof userId !== "string" || userId.length === 0) return { estado: "falhou" };

  let consulta = getSupabaseServidor()
    .from(TABELA_ALERTAS)
    .select(COLUNAS_ALERTA)
    .eq("user_id", userId)
    .eq("estado", "resolvido")
    .order("resolvido_em", { ascending: false })
    .limit(LIMITE_DE_RESOLVIDOS);

  const agenteId = filtro.agenteId;
  if (typeof agenteId === "string" && agenteId.length > 0) {
    consulta = consulta.eq("agente_id", agenteId);
  }

  const { data, error } = await consulta;
  if (error) {
    console.error("[observabilidade] falha ao listar incidentes resolvidos");
    return { estado: "falhou" };
  }
  if (!Array.isArray(data)) return { estado: "falhou" };

  // Sem reordenar por gravidade: aqui a pergunta e cronologica.
  return { estado: "ok", incidentes: projetarLista(data) };
}

function comoConfiguracao(bruta: unknown): ConfiguracaoParaOperador {
  const lido = interpretarLinhaDoEstadoEsperado(bruta);
  if (lido.estado === "configurado_ativo") return "ativo";
  if (lido.estado === "configurado_inativo") return "inativo";
  if (lido.estado === "configuracao_ausente") return "nao_configurado";
  return "desconhecido";
}

/**
 * O estado do VIGIA para cada agente do dono.
 *
 * Duas leituras, e as duas em UMA consulta cada — nao uma por agente.
 * A interpretacao de cada linha de configuracao e a MESMA funcao que
 * `lerEstadoEsperadoDaIngestao` usa: a consulta muda de recorte, o
 * significado da linha nao pode mudar.
 *
 * ── O QUE O LEASE PROVA, E O QUE ELE NAO PROVA ──────────────────────
 *
 * `adquirida_em` e a ultima vez que o vigia tomou o direito de avaliar
 * aquele escopo. Isso prova que ELE rodou. Nao prova que o agendador
 * executou, que a ingestao capturou pergunta nenhuma, nem que esta tudo
 * bem — e essa distincao e a razao de a atividade aparecer separada dos
 * incidentes na tela, nunca somada a eles.
 */
export async function listarMonitoresDoDono(
  userId: string,
  filtro: { readonly agenteId?: string | null } = {}
): Promise<LeituraDeMonitores> {
  if (typeof userId !== "string" || userId.length === 0) return { estado: "falhou" };

  const cliente = getSupabaseServidor();
  const agenteId = filtro.agenteId;
  const porAgente = typeof agenteId === "string" && agenteId.length > 0 ? agenteId : null;

  let consultaEstado = cliente
    .from(TABELA_ESTADO)
    .select("agente_id,esperado_ativo,esperado_desde")
    .eq("user_id", userId)
    .eq("plataforma", PLATAFORMA_DO_MONITOR)
    .eq("recurso", RECURSO_DO_MONITOR);
  if (porAgente !== null) consultaEstado = consultaEstado.eq("agente_id", porAgente);

  const estado = await consultaEstado;
  if (estado.error || !Array.isArray(estado.data)) {
    console.error("[observabilidade] falha ao ler o estado esperado do dono");
    return { estado: "falhou" };
  }

  let consultaLease = cliente
    .from(TABELA_LEASE)
    // O PORTADOR nao entra: e token de coordenacao interna e nao tem o
    // que fazer numa tela.
    .select("agente_id,adquirida_em,liberada_em")
    .eq("user_id", userId)
    .eq("plataforma", PLATAFORMA_DO_MONITOR)
    .eq("recurso", RECURSO_DO_MONITOR);
  if (porAgente !== null) consultaLease = consultaLease.eq("agente_id", porAgente);

  const lease = await consultaLease;
  if (lease.error || !Array.isArray(lease.data)) {
    console.error("[observabilidade] falha ao ler a atividade do vigia");
    return { estado: "falhou" };
  }

  const atividadePorAgente = new Map<string, AtividadeDoMonitor>();
  for (const bruta of lease.data) {
    if (typeof bruta !== "object" || bruta === null) continue;
    const o = bruta as Record<string, unknown>;
    const id = o.agente_id;
    const adquiridaEm = o.adquirida_em;
    if (typeof id !== "string" || typeof adquiridaEm !== "string") continue;
    atividadePorAgente.set(id, {
      estado: "observada",
      adquiridaEm,
      liberadaEm: typeof o.liberada_em === "string" ? o.liberada_em : null,
    });
  }

  const monitores: MonitorDeUmAgente[] = [];
  const vistos = new Set<string>();

  for (const bruta of estado.data) {
    const o = bruta as Record<string, unknown>;
    const id = o.agente_id;
    if (typeof id !== "string") continue;
    vistos.add(id);
    monitores.push({
      agenteId: id,
      configuracao: comoConfiguracao(bruta),
      atividade: atividadePorAgente.get(id) ?? { estado: "nunca_observada" },
    });
  }

  // Um agente com lease e SEM configuracao e um estado real: o vigia
  // rodou e descobriu que ninguem declarou o que esperar dele. Some-lo
  // aqui faria a tela escondar justamente o caso que o alerta de
  // configuracao ausente existe para mostrar.
  for (const [id, atividade] of atividadePorAgente) {
    if (vistos.has(id)) continue;
    monitores.push({ agenteId: id, configuracao: "nao_configurado", atividade });
  }

  return { estado: "ok", monitores };
}
