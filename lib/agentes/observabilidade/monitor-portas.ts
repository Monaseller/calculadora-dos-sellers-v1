/**
 * OBS-5 — as portas REAIS do vigia. Aqui, e so aqui, ha banco.
 *
 * Todo SQL do monitor mora neste arquivo; toda decisao mora nos modulos
 * puros. Isso e o que permite a suite exercitar os caminhos de FALHA —
 * que sao os que ninguem consegue provocar de proposito num banco de
 * verdade — sem simular Postgres.
 *
 * ── SOMENTE LEITURA, FORA DOS ALERTAS ───────────────────────────────
 *
 * As consultas daqui leem ledger e cursor. Nao escrevem em nenhum dos
 * dois: o vigia OBSERVA a ingestao, nao participa dela. A unica escrita
 * do monitor e a do proprio incidente, e ela sai pelo repositorio do
 * OBS-4 — nao por este modulo.
 */
import "server-only";

import { ACAO_SINCRONIZAR_PERGUNTAS } from "@/lib/agentes/acoes/auditoria-acao";
import { lerAgenteParaAcaoInterna } from "@/lib/agentes/capability-worker";
import { getSupabaseServidor } from "@/lib/estudio-anuncios/supabase-servidor";

import {
  atualizarAlerta,
  criarAlerta,
  lerAlertaAberto,
  resolverAlerta,
} from "./alerta-repositorio";
import { lerEstadoEsperadoDaIngestao } from "./estado-esperado";
import { lerCursorDoMonitor, montarCarga, type EscopoDaCarga } from "./monitor-carga";
import type { CargaDoLedger, LeituraDoCursorDoMonitor } from "./monitor-avaliacao";
import {
  PLATAFORMA_DO_MONITOR,
  RECURSO_DO_MONITOR,
  type LeituraDoAgenteAlvo,
  type PortasDoMonitor,
} from "./monitor-ingestao";

const TABELA_LEDGER = "agente_acao_execucoes";
const TABELA_CURSOR = "agente_perguntas_continuacao";

const COLUNAS_LEDGER =
  "user_id,agente_id,request_id,fase,status,idempotency_key,criado_em,codigo_desfecho,entrada_resumo";
const COLUNAS_CURSOR = "agente_id,user_id,proximo_deslocamento,versao,alterado_em";

/**
 * Teto de linhas da janela.
 *
 * Seis buckets, com base, continuacoes e retentativas, em duas fases,
 * nao chegam perto disto. O teto existe para que uma janela anomala nao
 * vire uma consulta ilimitada — e quando ele e atingido a carga e
 * marcada como TRUNCADA, o que abre alerta de dado incompleto em vez de
 * produzir uma classificacao inventada sobre metade das linhas.
 */
export const TETO_DE_LINHAS = 500;

async function lerAgente(agenteId: string): Promise<LeituraDoAgenteAlvo> {
  const r = await lerAgenteParaAcaoInterna(agenteId);
  if (r.erro !== null) return { estado: "falhou" };
  if (r.agente === null) return { estado: "ausente" };
  // O dono sai do BANCO. Nenhum campo do request chega ate aqui.
  return { estado: "ok", userId: r.agente.userId };
}

async function carregarLedger(e: {
  readonly userId: string;
  readonly agenteId: string;
  readonly de: number;
  readonly ate: number;
}): Promise<CargaDoLedger | null> {
  const escopo: EscopoDaCarga = {
    userId: e.userId,
    agenteId: e.agenteId,
    plataforma: PLATAFORMA_DO_MONITOR,
    recurso: RECURSO_DO_MONITOR,
  };

  // `acao_id` e o recorte de RECURSO: a acao de sincronizar perguntas e
  // a unica que escreve este cursor. O filtro NAO e por chave de
  // idempotencia — pegar so `n8n:w5m-*` deixaria de fora as execucoes
  // `diag-*`, que atravessam a mesma rota e movem o mesmo cursor, e era
  // exatamente esse buraco que o OBS-3 R1 fechou.
  const { data, error } = await getSupabaseServidor()
    .from(TABELA_LEDGER)
    .select(COLUNAS_LEDGER)
    .eq("user_id", e.userId)
    .eq("agente_id", e.agenteId)
    .eq("acao_id", ACAO_SINCRONIZAR_PERGUNTAS)
    .gte("criado_em", new Date(e.de).toISOString())
    .lte("criado_em", new Date(e.ate).toISOString())
    .order("criado_em", { ascending: true })
    .limit(TETO_DE_LINHAS + 1);

  if (error) {
    console.error("[monitor-ingestao] falha ao ler o ledger de acoes");
    return null;
  }
  if (!Array.isArray(data)) return null;

  const truncada = data.length > TETO_DE_LINHAS;
  return montarCarga(truncada ? data.slice(0, TETO_DE_LINHAS) : data, escopo, truncada);
}

async function lerCursor(e: {
  readonly userId: string;
  readonly agenteId: string;
}): Promise<LeituraDoCursorDoMonitor> {
  const escopo: EscopoDaCarga = {
    userId: e.userId,
    agenteId: e.agenteId,
    plataforma: PLATAFORMA_DO_MONITOR,
    recurso: RECURSO_DO_MONITOR,
  };

  // `alterado_em` nao esta em `lerContinuacao`, e o OBS-3 precisa dele
  // para decidir se o cursor atual pode ser atribuido ao ultimo bucket.
  // Por isso a consulta e propria, e nao uma chamada ao modulo de dados.
  const { data, error } = await getSupabaseServidor()
    .from(TABELA_CURSOR)
    .select(COLUNAS_CURSOR)
    .eq("user_id", e.userId)
    .eq("agente_id", e.agenteId)
    .eq("plataforma", PLATAFORMA_DO_MONITOR)
    .eq("recurso", RECURSO_DO_MONITOR)
    .limit(2);

  if (error) {
    console.error("[monitor-ingestao] falha ao ler o cursor da ingestao");
    return { estado: "falhou" };
  }
  if (!Array.isArray(data)) return { estado: "falhou" };
  if (data.length === 0) return { estado: "ausente" };
  if (data.length > 1) {
    console.error("[monitor-ingestao] mais de um cursor para o mesmo escopo");
    return { estado: "falhou" };
  }
  return lerCursorDoMonitor(data[0], escopo);
}

/** As portas de producao. O unico lugar que amarra o vigia ao banco. */
export function portasDeProducao(): PortasDoMonitor {
  return {
    agora: () => Date.now(),
    // A fonte do alvo e o AMBIENTE, nunca a tabela de configuracao: se
    // o alvo viesse da propria configuracao, a ausencia dela seria
    // invisivel — e detectar essa ausencia e metade do porque o vigia
    // existe.
    lerAlvo: () => process.env.N8N_INGESTAO_AGENT_ID,
    lerAgente,
    lerConfiguracao: (agenteId: string) => lerEstadoEsperadoDaIngestao(agenteId),
    carregarLedger,
    lerCursor,
    lerIncidenteAberto: (escopo, tipo) => lerAlertaAberto(escopo, tipo),
    abrirIncidente: (novo) => criarAlerta(novo),
    atualizarIncidente: (id, campos) => atualizarAlerta(id, campos),
    resolverIncidente: (id, campos, resolvidoEm) => resolverAlerta(id, campos, resolvidoEm),
  };
}
