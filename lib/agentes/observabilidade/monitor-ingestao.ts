/**
 * OBS-5 — o vigia da ingestao de perguntas. A orquestracao.
 *
 * Descobre o alvo, carrega o que precisa, chama os detectores puros,
 * traduz o resultado em observacoes e aplica o ciclo de vida. Nada mais.
 *
 * ── TUDO POR PORTA, DE PROPOSITO ────────────────────────────────────
 *
 * Este modulo NAO importa Supabase e NAO declara `server-only`. Todo
 * acesso a banco entra por `PortasDoMonitor`, o que permite a suite
 * inteira rodar sem rede e sem banco — inclusive os casos que so
 * aparecem quando a leitura FALHA, que sao justamente os que ninguem
 * consegue reproduzir contra um banco de verdade.
 *
 * ── A PLATAFORMA NAO SE MONITORA A SI MESMA ─────────────────────────
 *
 * Se o Postgres estiver fora, o vigia nao consegue gravar no mesmo
 * Postgres que "o Postgres esta fora". Tentar seria produzir um alerta
 * que nunca chega e, pior, deixar a rodada parecer concluida. Entao
 * falha de leitura ou de escrita vira 5xx e log estruturado, e a
 * disponibilidade de Vercel/Postgres fica com o monitoramento de
 * plataforma, que e quem tem como observa-la de fora.
 *
 * ── DUAS EXECUCOES NAO PODEM AVALIAR JUNTAS (I4P9-R1) ───────────────
 *
 * O indice unico parcial dos alertas serializa a ABERTURA do mesmo
 * incidente, e so isso. Ele nao serializa duas AVALIACOES sobrepostas, e
 * o caso pior nem chega a tocar linha de alerta:
 *
 *   T2  a execucao NOVA le tudo saudavel -> NOOP, nada e escrito
 *   T1  a execucao VELHA, atrasada, le um gap antigo -> ABRE incidente
 *
 * Nao existe linha contra a qual comparar, entao nenhum CAS por alerta
 * resolve. O que falta e impedir que as duas avaliem ao mesmo tempo:
 * antes de qualquer leitura de estado, a execucao adquire o direito de
 * avaliar aquele escopo. Quem nao adquire NAO avalia e NAO toca o ciclo
 * de vida — sai com 200 e o proximo minuto reavalia tudo do zero.
 *
 * Pular uma rodada custa um minuto de latencia. Escrever estado velho
 * por cima de evidencia nova custa um incidente falso que ninguem sabe
 * de onde veio.
 *
 * ── ALVO AUSENTE NAO E CONFIGURACAO AUSENTE ─────────────────────────
 *
 * Sem `N8N_INGESTAO_AGENT_ID` nao se sabe nem de QUEM seria a
 * configuracao — falta o sujeito do alerta. Isso e falha de implantacao
 * do proprio vigia (`MONITOR_TARGET_UNCONFIGURED`), nao achado sobre o
 * sistema observado: 5xx, zero linha de alerta.
 * `monitor_configuration_missing` so nasce quando o agente ja e
 * conhecido e a autoridade ja foi derivada do banco.
 */

import {
  reduzirEstadoDoAlerta,
  type CamposDeAtualizacao,
  type EscopoDoAlerta,
  type IncidenteAberto,
  type NovoIncidente,
  type ObservacaoDeAlerta,
  type TipoDeAlerta,
} from "./alerta";
import { CADENCIA_MS } from "./fronteira-bucket";
import { FOLGA_DE_FECHAMENTO_MS, JANELA_DE_BUSCA_EM_BUCKETS, type EstadoEsperado } from "./gap";
import {
  avaliarIngestao,
  type CargaDoLedger,
  type LeituraDoCursorDoMonitor,
} from "./monitor-avaliacao";

/** O par canonico da V1. O chamador nao escolhe recurso. */
export const PLATAFORMA_DO_MONITOR = "mercado_livre";
export const RECURSO_DO_MONITOR = "perguntas";

/**
 * Folga para tras na consulta do ledger, alem da janela do detector.
 *
 * Duas coisas a exigem. A juncao de fases precisa da ABERTURA da
 * execucao cujo DESFECHO caiu dentro da janela — sem ela o desfecho
 * viraria orfao, um achado falso. E a proveniencia precisa enxergar
 * quem escreveu o cursor um pouco antes da primeira fronteira avaliada.
 * Dois buckets cobrem com folga o teto de 60 s de uma execucao.
 */
export const MARGEM_DA_CONSULTA_MS = 2 * CADENCIA_MS;

/**
 * A janela de consulta.
 *
 * ⚠ Ela ESPELHA a aritmetica de `detectarSaudeDosBuckets`. Nao da para
 * derivar do detector: os buckets so existem depois de carregar as
 * linhas, e as linhas so podem ser carregadas com a janela na mao. A
 * mitigacao e um teste que roda os dois e exige que todo bucket
 * devolvido caiba aqui dentro — se a formula de la mudar, ele quebra.
 *
 * O fim e AGORA, nao o ultimo bucket: escritor posterior ao ultimo
 * bucket tambem pode ter deixado o cursor no valor que estamos lendo, e
 * o OBS-3 abre o limite superior justamente por isso.
 */
export function janelaDeConsulta(
  agora: number,
  esperadoDesde: number
): { readonly de: number; readonly ate: number } {
  const ultimoFechado = Math.floor((agora - FOLGA_DE_FECHAMENTO_MS) / CADENCIA_MS) * CADENCIA_MS;
  const inicio = Math.max(esperadoDesde, ultimoFechado - (JANELA_DE_BUSCA_EM_BUCKETS - 1) * CADENCIA_MS);
  return { de: inicio - MARGEM_DA_CONSULTA_MS, ate: agora };
}

const FORMA_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type LeituraDoAgenteAlvo =
  | { readonly estado: "ok"; readonly userId: string }
  | { readonly estado: "ausente" }
  | { readonly estado: "falhou" };

export type LeituraDoIncidente =
  | { readonly estado: "encontrado"; readonly id: string; readonly incidente: IncidenteAberto }
  | { readonly estado: "ausente" }
  | { readonly estado: "falhou" };

export type EscritaDoIncidente =
  | { readonly estado: "aplicada" }
  | { readonly estado: "duplicada" }
  | { readonly estado: "falhou" };

/** O escopo que o lease serializa. A mesma forma do escopo do alerta. */
export type EscopoDaSerializacao = EscopoDoAlerta;

export type AquisicaoDaSerializacao =
  | {
      readonly estado: "adquirida";
      /** Opaco, por execucao. E o que impede A de liberar o lease de B. */
      readonly portador: string;
      readonly expiraEm: string | null;
      /** O portador anterior morreu sem liberar. Sintoma, nao rotina. */
      readonly tomadaDeExpirada: boolean;
    }
  /** Outra execucao esta avaliando este escopo AGORA. Nao e falha. */
  | { readonly estado: "ocupada" }
  | { readonly estado: "falhou" };

export interface PortasDoMonitor {
  readonly agora: () => number;
  /** O id do agente alvo, cru, como veio do ambiente. */
  readonly lerAlvo: () => string | null | undefined;
  readonly lerAgente: (agenteId: string) => Promise<LeituraDoAgenteAlvo>;
  readonly lerConfiguracao: (agenteId: string) => Promise<EstadoEsperado>;
  readonly carregarLedger: (e: {
    readonly userId: string;
    readonly agenteId: string;
    readonly de: number;
    readonly ate: number;
  }) => Promise<CargaDoLedger | null>;
  readonly lerCursor: (e: {
    readonly userId: string;
    readonly agenteId: string;
  }) => Promise<LeituraDoCursorDoMonitor>;
  readonly adquirirSerializacao: (escopo: EscopoDaSerializacao) => Promise<AquisicaoDaSerializacao>;
  /** Melhor esforco: a expiracao e a garantia real. Nunca lanca. */
  readonly liberarSerializacao: (escopo: EscopoDaSerializacao, portador: string) => Promise<void>;
  readonly lerIncidenteAberto: (escopo: EscopoDoAlerta, tipo: TipoDeAlerta) => Promise<LeituraDoIncidente>;
  readonly abrirIncidente: (novo: NovoIncidente) => Promise<EscritaDoIncidente>;
  readonly atualizarIncidente: (id: string, campos: CamposDeAtualizacao) => Promise<EscritaDoIncidente>;
  readonly resolverIncidente: (
    id: string,
    campos: CamposDeAtualizacao,
    resolvidoEm: number
  ) => Promise<EscritaDoIncidente>;
}

export interface MetricasDoMonitor {
  readonly tiposAvaliados: number;
  readonly abertos: number;
  readonly atualizados: number;
  readonly resolvidos: number;
  readonly noop: number;
}

export type ResultadoDoMonitor =
  | { readonly estado: "avaliado"; readonly metricas: MetricasDoMonitor }
  /** Parte das observacoes foi persistida e o resto nao. NUNCA vira 200. */
  | {
      readonly estado: "avaliacao_parcial";
      readonly metricas: MetricasDoMonitor;
      readonly estagio: string;
    }
  /** Outra execucao detinha o direito de avaliar. NAO e erro. */
  | { readonly estado: "ignorado_por_sobreposicao" }
  | { readonly estado: "alvo_nao_configurado" }
  | { readonly estado: "alvo_invalido" }
  | { readonly estado: "falha_de_plataforma"; readonly estagio: string };

const ZERO: MetricasDoMonitor = Object.freeze({
  tiposAvaliados: 0, abertos: 0, atualizados: 0, resolvidos: 0, noop: 0,
});

interface Contadores {
  tiposAvaliados: number;
  abertos: number;
  atualizados: number;
  resolvidos: number;
  noop: number;
}

/**
 * Aplica UMA observacao.
 *
 * `duplicada` nao e erro: outra execucao do vigia abriu o mesmo
 * incidente entre a nossa leitura e a nossa escrita, e o indice parcial
 * fez o trabalho dele. A resposta certa e reler e recalcular com o
 * incidente que agora existe — perder a avaliacao seria jogar fora a
 * unica evidencia daquele ciclo. UMA releitura, sem laco: se a segunda
 * tentativa tambem nao casar, e falha e sobe como falha.
 */
async function aplicarObservacao(
  portas: PortasDoMonitor,
  escopo: EscopoDoAlerta,
  obs: ObservacaoDeAlerta,
  c: Contadores,
  segundaTentativa = false
): Promise<"ok" | "falhou"> {
  const leitura = await portas.lerIncidenteAberto(escopo, obs.tipo);
  if (leitura.estado === "falhou") return "falhou";

  const atual = leitura.estado === "encontrado" ? leitura.incidente : null;
  const intencao = reduzirEstadoDoAlerta(atual, obs);

  if (intencao.acao === "NOOP") { c.noop += 1; return "ok"; }

  if (intencao.acao === "OPEN") {
    const escrita = await portas.abrirIncidente(intencao.incidente);
    if (escrita.estado === "aplicada") { c.abertos += 1; return "ok"; }
    if (escrita.estado === "duplicada" && !segundaTentativa) {
      return aplicarObservacao(portas, escopo, obs, c, true);
    }
    return "falhou";
  }

  if (leitura.estado !== "encontrado") return "falhou";

  const escrita =
    intencao.acao === "RESOLVE"
      ? await portas.resolverIncidente(leitura.id, intencao.campos, intencao.resolvidoEm)
      : await portas.atualizarIncidente(leitura.id, intencao.campos);

  if (escrita.estado !== "aplicada") return "falhou";
  if (intencao.acao === "RESOLVE") c.resolvidos += 1;
  else c.atualizados += 1;
  return "ok";
}

export async function executarMonitorDaIngestao(
  portas: PortasDoMonitor
): Promise<ResultadoDoMonitor> {
  // ── Alvo ──────────────────────────────────────────────────────────
  const bruto = portas.lerAlvo();
  if (typeof bruto !== "string" || !FORMA_UUID.test(bruto.trim())) {
    return { estado: "alvo_nao_configurado" };
  }
  const agenteId = bruto.trim();

  const agente = await portas.lerAgente(agenteId);
  // Falha de leitura e alvo inexistente terminam igual para quem chama —
  // 5xx e zero escrita — mas sao registrados separados: um e banco, o
  // outro e implantacao apontando para um agente que nao existe.
  if (agente.estado === "falhou") {
    return { estado: "falha_de_plataforma", estagio: "leitura_do_agente" };
  }
  if (agente.estado === "ausente") return { estado: "alvo_invalido" };

  // A autoridade vem do BANCO. Nenhum campo do request participa disto.
  const escopo: EscopoDoAlerta = {
    userId: agente.userId,
    agenteId,
    plataforma: PLATAFORMA_DO_MONITOR,
    recurso: RECURSO_DO_MONITOR,
  };

  // ── Serializacao ──────────────────────────────────────────────────
  //
  // Depois do alvo e da autoridade, porque sem escopo nao ha o que
  // serializar; e ANTES de qualquer leitura de estado, porque uma
  // avaliacao que ja comecou nao pode ser desfeita.
  const lease = await portas.adquirirSerializacao(escopo);
  if (lease.estado === "falhou") {
    return { estado: "falha_de_plataforma", estagio: "aquisicao_da_serializacao" };
  }
  if (lease.estado === "ocupada") {
    // Sobreposicao nao e falha do agendador nem cegueira do vigia: e o
    // vigia funcionando. Abrir alerta aqui seria alarme sobre si mesmo.
    return { estado: "ignorado_por_sobreposicao" };
  }

  try {
    return await avaliarEAplicar(portas, escopo);
  } finally {
    // O `finally` NAO pode derrubar o resultado que ja foi decidido: se
    // a liberacao falhar, a expiracao resolve sozinha.
    try {
      await portas.liberarSerializacao(escopo, lease.portador);
    } catch {
      // Silencio deliberado. Ver acima.
    }
  }
}

async function avaliarEAplicar(
  portas: PortasDoMonitor,
  escopo: EscopoDoAlerta
): Promise<ResultadoDoMonitor> {
  const { agenteId } = escopo;
  // O instante e lido DEPOIS da aquisicao: a avaliacao pertence a janela
  // serializada, nao ao momento em que a requisicao chegou.
  const agora = portas.agora();

  // ── Configuracao ──────────────────────────────────────────────────
  const configuracao = await portas.lerConfiguracao(agenteId);
  if (configuracao.estado === "falhou_leitura") {
    return { estado: "falha_de_plataforma", estagio: "leitura_da_configuracao" };
  }

  let carga: CargaDoLedger | null = null;
  let cursor: LeituraDoCursorDoMonitor | null = null;

  if (configuracao.estado === "configurado_ativo") {
    const desde = Date.parse(configuracao.esperadoDesde);
    if (!Number.isFinite(desde)) {
      return { estado: "falha_de_plataforma", estagio: "fronteira_invalida" };
    }
    const janela = janelaDeConsulta(agora, desde);

    carga = await portas.carregarLedger({ userId: escopo.userId, agenteId, ...janela });
    if (carga === null) {
      return { estado: "falha_de_plataforma", estagio: "leitura_do_ledger" };
    }

    cursor = await portas.lerCursor({ userId: escopo.userId, agenteId });
    if (cursor.estado === "falhou") {
      return { estado: "falha_de_plataforma", estagio: "leitura_do_cursor" };
    }
  }

  const avaliacao = avaliarIngestao({ agora, escopo, configuracao, carga, cursor });

  // ── Ciclo de vida ─────────────────────────────────────────────────
  const c: Contadores = { ...ZERO };
  for (const obs of avaliacao.observacoes) {
    const r = await aplicarObservacao(portas, escopo, obs, c);
    if (r === "falhou") {
      // Para na PRIMEIRA falha. Continuar gravando contra um repositorio
      // que acabou de recusar produziria uma rodada meio aplicada sem
      // que ninguem soubesse ate onde ela chegou.
      return { estado: "avaliacao_parcial", metricas: { ...c }, estagio: obs.tipo };
    }
    c.tiposAvaliados += 1;
  }

  return { estado: "avaliado", metricas: { ...c } };
}
