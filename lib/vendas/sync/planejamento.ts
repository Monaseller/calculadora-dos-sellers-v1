/**
 * Planejamento PURO do coordenador de vendas (SALES-SYNC-A1).
 *
 * Para uma loja e um periodo [de, ate] (dias civis de Sao Paulo, ja
 * resolvidos — presets nao sao daqui) responde, SEM efeito colateral:
 * cobertura, frescor, se o resultado e DEFINITIVO, as necessidades com
 * prioridade e a UNICA proxima acao da loja (fila serial: o banco so
 * admite um job ativo por loja — idx_sync_jobs_loja_ativo).
 *
 *   ML      cobertura = janelas date_closed completas por DIA (motor ML).
 *           frescor   = idade da ultima observacao do dia vs politica.
 *           refresh   = RELER a mesma janela date_closed (populacao imutavel).
 *   Shopee  cobertura = cadeia create_time de [inicio − prazo publicado, fim]
 *                       (mesma base POLITICA do servico canonico).
 *           frescor   = escrow pendente, pedido nao pago sem observacao apos
 *                       o periodo (contagens do servico canonico) e idade da
 *                       observacao das janelas.
 *           refresh   = catch-up de escrow / reler janelas create_time.
 *   update_time NUNCA e cobertura. O dia corrente nunca vira job e deixa o
 *   periodo IN_PROGRESS (nunca definitivo).
 */
import { diaEmSaoPaulo, somarDiasNoCalendario } from "@/lib/fuso-sao-paulo";
import { diasDaJanela, limitesDaJanela } from "@/lib/mercado-livre/ingestao/janelas";
import { planejarJanelasCriacao } from "@/lib/shopee/ingestao/janelas";
import { LIMITE_POLITICA_PAGAMENTO_MS } from "@/lib/vendas/canonico/shopee";
import {
  alvoIntradayMs, CADENCIA_INTRADAY_MS, chaveIntraday, ehJobIntraday, ehJobIntradayDoDia, limitesDoDiaMs, PRIORIDADE_INTRADAY,
} from "./intraday";
import type {
  AvaliacaoLojaSync, AvaliacaoSync, Cobertura, Frescor, Intervalo, JobExistenteSync, JobPlanejado, LojaAtivaSync, Necessidade,
  OrigemPedido, PoliticaSync, ProximaAcao, SinaisShopeeSync, Sincronizacao,
} from "./tipos";

const DIA_MS = 24 * 3600 * 1000;
const ATIVOS = new Set(["pendente", "rodando"]);
const t = (iso: string | null) => (iso ? new Date(iso).getTime() : NaN);
const isoDe = (ms: number) => new Date(ms).toISOString();

/**
 * A politica de frescor/retry — UNICO lugar. PROPOSTA (nao oficial, nao
 * financeira): cancel_detail/status mudam mais nos primeiros dias (o
 * pack_splitted de 02/10 apareceu dias depois); reler um dia ML custa ~6
 * chamadas; reler Shopee e proporcional aos pedidos. Alem de 90 dias: so
 * sob demanda explicita.
 */
export const POLITICA_SYNC_PROPOSTA: PoliticaSync = {
  faixas: [
    { idadeMaxDias: 7, intervaloMs: 6 * 3600 * 1000 },
    { idadeMaxDias: 30, intervaloMs: 24 * 3600 * 1000 },
    { idadeMaxDias: 90, intervaloMs: 7 * DIA_MS },
  ],
  intervaloSobDemandaMs: 24 * 3600 * 1000,
  maxFalhasPorNecessidade: 3,
  esperaAposFalhaMs: 30 * 60 * 1000,
  janelaContagemFalhasMs: 24 * 3600 * 1000,
  maxDiasPorJobML: 7,
  horizonteRecenteDias: 30,
};

/**
 * Prioridade da fila serial (menor = antes), dentro da mesma: mais recente
 * primeiro. 1 descoberta do periodo pedido pelo usuario; 2 frescor do
 * periodo pedido; 3 cobertura recente; 4 frescor recente; 5 backfill
 * inicial recente; 6 backfill historico; 7 frescor historico.
 */
export function prioridadeDe(origem: OrigemPedido, tipo: "discovery" | "refresh", recente: boolean): number {
  if (origem === "usuario") return tipo === "discovery" ? 1 : 2;
  if (origem === "bootstrap") return tipo === "discovery" ? (recente ? 5 : 6) : 7;
  if (tipo === "discovery") return recente ? 3 : 6;
  return recente ? 4 : 7;
}

/** Hoje (dia civil de SP) e a parte FECHADA do periodo. */
export function separarDiaCorrente(de: string, ate: string, agoraMs: number): { hoje: string; fechadoAte: string | null; incluiHoje: boolean } {
  const hoje = diaEmSaoPaulo(isoDe(agoraMs))!;
  const ontem = somarDiasNoCalendario(hoje, -1);
  const limite = ate < ontem ? ate : ontem;
  return { hoje, fechadoAte: limite < de ? null : limite, incluiHoje: ate >= hoje };
}

// ── intervalos ──
type Iv = [number, number];
function uniao(ivs: Iv[]): Iv[] {
  const o = ivs.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]); const out: Iv[] = [];
  for (const [a, b] of o) { const u = out[out.length - 1]; if (u && a <= u[1]) u[1] = Math.max(u[1], b); else out.push([a, b]); }
  return out;
}
function subtrair(base: Iv, menos: Iv[]): Iv[] {
  let partes: Iv[] = [base];
  for (const [a, b] of uniao(menos)) partes = partes.flatMap(([x, y]) => (b <= x || a >= y ? [[x, y] as Iv] : [[x, Math.min(a, y)] as Iv, [Math.max(b, x), y] as Iv]).filter(([p, q]) => q > p));
  return partes;
}
const sobrepoe = (j: JobExistenteSync, [a, b]: Iv) => (j.catchup ? a === -Infinity && b === Infinity : t(j.janelaInicio) < b && t(j.janelaFim) > a);
const contem = (j: JobExistenteSync, [a, b]: Iv) => t(j.janelaInicio) <= a && t(j.janelaFim) >= b;
const completo = (j: JobExistenteSync) => j.status === "concluido" && j.listagemCompleta === true;
const diaCivil = (ms: number) => diaEmSaoPaulo(isoDe(ms))!;

/** Um trecho atomico da janela e a observacao MAIS NOVA que o cobre por inteiro (null = nenhuma). */
export interface SegmentoObservado { inicio: number; fim: number; ultimaMs: number | null }

/**
 * Observacao por SEGMENTO de uma janela create_time (SALES-SYNC-A2).
 * So contam janelas create_time CONCLUIDAS com listagem completa (pendente,
 * rodando, erro, listagem incompleta, update_time, legado e catch-up ficam
 * de fora). A janela e cortada em todos os limites dessas janelas; cada
 * segmento [p, q] recebe o MAIOR concluido_em entre os jobs que o contem por
 * inteiro. Bordas sao compartilhadas ([A,B] e [B,C] cobrem B sem buraco):
 * a mesma semantica de `contem`/`subtrair` do resto do planner.
 */
export function observacaoPorSegmento(jobs: JobExistenteSync[], [a, b]: [number, number]): SegmentoObservado[] {
  const validos = jobs.filter((j) => j.campoTempo === "create_time" && j.janelaInicio && j.janelaFim && completo(j) && Number.isFinite(t(j.concluidoEm)));
  const cortes = [...new Set([a, b, ...validos.flatMap((j) => [t(j.janelaInicio), t(j.janelaFim)]).filter((x) => x > a && x < b)])].sort((x, y) => x - y);
  const out: SegmentoObservado[] = [];
  for (let i = 0; i + 1 < cortes.length; i++) {
    const seg: Iv = [cortes[i], cortes[i + 1]];
    const obs = validos.filter((j) => contem(j, seg)).map((j) => t(j.concluidoEm));
    out.push({ inicio: seg[0], fim: seg[1], ultimaMs: obs.length ? Math.max(...obs) : null });
  }
  return out;
}

/** Observacao EFETIVA de uma janela = a mais velha entre as mais novas de cada segmento (null = algum trecho sem observacao). */
export function observacaoEfetivaDaJanela(jobs: JobExistenteSync[], iv: [number, number]): number | null {
  const segs = observacaoPorSegmento(jobs, iv);
  if (!segs.length || segs.some((s) => s.ultimaMs === null)) return null;
  return Math.min(...segs.map((s) => s.ultimaMs!));
}

/** Intervalo maximo aceito entre observacoes para um periodo que termina em `fimMs`. null = sem exigencia. */
function intervaloDeFrescor(pol: PoliticaSync, fimMs: number, agoraMs: number, origem: OrigemPedido): number | null {
  const idadeDias = (agoraMs - fimMs) / DIA_MS;
  const faixa = pol.faixas.find((f) => idadeDias <= f.idadeMaxDias);
  if (faixa) return faixa.intervaloMs;
  return origem === "usuario" ? pol.intervaloSobDemandaMs : null;
}

/**
 * Falhas de uma NECESSIDADE (janela logica), nao de um UUID: todo job em
 * erro que sobrepoe a janela, depois do ultimo sucesso dela e dentro da
 * janela de contagem. Um job novo (UUID novo) nao zera nada.
 */
function avaliarFalhas(jobs: JobExistenteSync[], iv: Iv, desdeSucessoMs: number, pol: PoliticaSync, agoraMs: number): { estado: "ok" | "esperar" | "esgotado"; ate?: string } {
  const corte = Math.max(desdeSucessoMs, agoraMs - pol.janelaContagemFalhasMs);
  const falhas = jobs.filter((j) => j.status === "erro" && sobrepoe(j, iv)).map((j) => t(j.concluidoEm) || t(j.criadoEm)).filter((x) => x > corte);
  if (falhas.length >= pol.maxFalhasPorNecessidade) return { estado: "esgotado" };
  const ultima = Math.max(...falhas, -Infinity);
  if (falhas.length && agoraMs - ultima < pol.esperaAposFalhaMs) return { estado: "esperar", ate: isoDe(ultima + pol.esperaAposFalhaMs) };
  return { estado: "ok" };
}

interface Parcial {
  cobertura: Cobertura; frescor: Exclude<Frescor, "IN_PROGRESS">; motivos: string[]; faltando: Intervalo[]; desatualizado: Intervalo[];
  necessidades: Necessidade[]; esperaAte: string | null; esgotado: string[]; andamento: string[];
}

// ── Mercado Livre ──
function planejarML(loja: LojaAtivaSync, de: string, ate: string, agoraMs: number, jobs: JobExistenteSync[], pol: PoliticaSync, origem: OrigemPedido): Parcial {
  // D15B: intraday prova so OBSERVED_THROUGH — nunca cobertura de dia fechado
  const meus = jobs.filter((j) => j.lojaId === loja.id && j.marketplace === "ML" && j.campoTempo === "date_closed" && j.janelaInicio && j.janelaFim && !ehJobIntraday(j));
  const faltam: string[] = [], velhos: string[] = [], refreshaveis: string[] = [], esgotado: string[] = [], andamento = new Set<string>();
  let descobrindo = 0, esperaDescoberta = false, refreshEsgotado = 0; let espera: string | null = null;
  const anotarEspera = (ate: string) => { espera = espera && espera > ate ? espera : ate; };
  for (const dia of diasDaJanela(de, ate)) {
    const l = limitesDaJanela(dia, dia)!; const iv: Iv = [l.inicio.getTime(), l.fim.getTime()];
    const ativo = meus.find((j) => ATIVOS.has(j.status) && sobrepoe(j, iv));
    if (ativo) andamento.add(ativo.id);
    const feitos = meus.filter((j) => completo(j) && contem(j, iv));
    if (!feitos.length) {                                   // COBERTURA
      if (ativo) { descobrindo++; continue; }
      const f = avaliarFalhas(meus, iv, -Infinity, pol, agoraMs);
      if (f.estado === "esgotado") esgotado.push(`falhas_repetidas:${dia}`);
      else if (f.estado === "esperar") { esperaDescoberta = true; anotarEspera(f.ate!); }
      else faltam.push(dia);
      continue;
    }
    const ultima = Math.max(...feitos.map((j) => t(j.concluidoEm)).filter(Number.isFinite), -Infinity);
    const intervalo = intervaloDeFrescor(pol, iv[1], agoraMs, origem);
    if (intervalo === null || agoraMs - ultima <= intervalo) continue;   // FRESCO
    velhos.push(dia);                                       // STALE (o snapshot continua valido)
    if (ativo) continue;
    const f = avaliarFalhas(meus, iv, ultima, pol, agoraMs);
    if (f.estado === "esgotado") refreshEsgotado++;
    else if (f.estado === "esperar") anotarEspera(f.ate!);
    else refreshaveis.push(dia);
  }
  const blocos = (lista: string[]) => { const out: string[][] = [];
    for (const d of lista) { const u = out[out.length - 1]; if (u && somarDiasNoCalendario(u[u.length - 1], 1) === d && u.length < pol.maxDiasPorJobML) u.push(d); else out.push([d]); }
    return out; };
  const lim = (b: string[]) => limitesDaJanela(b[0], b[b.length - 1])!;
  const job = (b: string[], proposito: "descoberta" | "refresh"): JobPlanejado => { const l = lim(b);
    return { chave: `ML|${loja.id}|date_closed|${l.inicio.toISOString()}|${l.fim.toISOString()}|${proposito}`, marketplace: "ML", lojaId: loja.id,
      campoTempo: "date_closed", inicio: l.inicio.toISOString(), fim: l.fim.toISOString(), de: b[0], ate: b[b.length - 1], proposito }; };
  const recente = (b: string[]) => agoraMs - lim(b).fim.getTime() <= pol.horizonteRecenteDias * DIA_MS;
  const necessidades: Necessidade[] = [
    ...blocos(faltam).map((b) => ({ job: job(b, "descoberta"), tipo: "discovery" as const, prioridade: prioridadeDe(origem, "discovery", recente(b)) })),
    ...blocos(refreshaveis).map((b) => ({ job: job(b, "refresh"), tipo: "refresh" as const, prioridade: prioridadeDe(origem, "refresh", recente(b)) })),
  ];
  const motivos = [
    ...(faltam.length ? [`cobertura_date_closed_faltando:${faltam.length}_dias`] : []),
    ...(descobrindo ? [`descoberta_em_andamento:${descobrindo}_dias`] : []),
    ...(esgotado.length ? [`falhas_repetidas:${esgotado.length}_dias`] : []),
    ...(velhos.length ? [`observacao_velha:${velhos.length}_dias`] : []),
    ...(refreshEsgotado ? [`refresh_falhas_repetidas:${refreshEsgotado}_dias`] : []),
    ...(espera ? ["aguardando_retry_apos_falha"] : []),
  ];
  return {
    cobertura: esgotado.length ? "FAILED" : faltam.length || descobrindo || esperaDescoberta ? "PARTIAL" : "COMPLETE",
    frescor: velhos.length ? "STALE" : "FRESH", motivos,
    faltando: blocos(faltam).map((b) => ({ inicio: lim(b).inicio.toISOString(), fim: lim(b).fim.toISOString() })),
    desatualizado: blocos(velhos).map((b) => ({ inicio: lim(b).inicio.toISOString(), fim: lim(b).fim.toISOString() })),
    necessidades, esperaAte: espera, esgotado: [...esgotado, ...(refreshEsgotado ? ["refresh_falhas_repetidas"] : [])], andamento: [...andamento],
  };
}

// ── Shopee ──
function planejarShopee(loja: LojaAtivaSync, de: string, ate: string, agoraMs: number, jobs: JobExistenteSync[], sinais: SinaisShopeeSync, pol: PoliticaSync, origem: OrigemPedido): Parcial {
  const l = limitesDaJanela(de, ate)!;
  const necessario: Iv = [l.inicio.getTime() - LIMITE_POLITICA_PAGAMENTO_MS, l.fim.getTime()];
  // D15B: intraday prova so OBSERVED_THROUGH — nunca cobertura de periodo fechado
  const meus = jobs.filter((j) => j.lojaId === loja.id && j.marketplace === "Shopee" && !ehJobIntraday(j));
  const descoberta = meus.filter((j) => j.campoTempo === "create_time" && j.janelaInicio && j.janelaFim);
  const feitos = descoberta.filter(completo);
  const ativos = descoberta.filter((j) => ATIVOS.has(j.status));
  const catchups = meus.filter((j) => j.catchup === true);
  const catchupAtivo = catchups.find((j) => ATIVOS.has(j.status));
  const lacunas = subtrair(necessario, feitos.map((j) => [t(j.janelaInicio), t(j.janelaFim)] as Iv));
  const faltando = subtrair(necessario, [...feitos, ...ativos].map((j) => [t(j.janelaInicio), t(j.janelaFim)] as Iv));
  const andamento = [...ativos.filter((j) => sobrepoe(j, necessario)).map((j) => j.id), ...(catchupAtivo ? [catchupAtivo.id] : [])];
  const recente = agoraMs - necessario[1] <= pol.horizonteRecenteDias * DIA_MS;
  const janelaJob = (a: number, b: number, proposito: "descoberta" | "refresh"): JobPlanejado[] =>
    planejarJanelasCriacao(new Date(a), new Date(b)).map((w) => ({
      chave: `Shopee|${loja.id}|create_time|${w.inicio.toISOString()}|${w.fim.toISOString()}|${proposito}`, marketplace: "Shopee", lojaId: loja.id,
      campoTempo: "create_time", inicio: w.inicio.toISOString(), fim: w.fim.toISOString(), de: diaCivil(w.inicio.getTime()), ate: diaCivil(w.fim.getTime() - 1), proposito }));
  const motivos: string[] = []; const necessidades: Necessidade[] = []; const esgotado: string[] = []; let espera: string | null = null;
  for (const g of faltando) {
    const f = avaliarFalhas(descoberta, g, -Infinity, pol, agoraMs);
    if (f.estado === "esgotado") esgotado.push(`falhas_repetidas:${isoDe(g[0])}`);
    else if (f.estado === "esperar") espera = f.ate!;
    else necessidades.push(...janelaJob(g[0], g[1], "descoberta").map((job) => ({ job, tipo: "discovery" as const, prioridade: prioridadeDe(origem, "discovery", recente) })));
  }
  if (faltando.length) motivos.push(`cobertura_create_time_faltando:${faltando.length}_trechos`);

  // ── frescor (so faz sentido sobre o corpus ja descoberto) ──
  let stale = false; const desat: Intervalo[] = [];
  if (sinais.escrowPendentes > 0) {
    stale = true; motivos.push(`escrow_pendente:${sinais.escrowPendentes}`);
    if (!catchupAtivo) {
      // catch-up nao tem janela: a necessidade e "escrow da loja", contada pelos jobs de catch-up
      const ultimoOk = Math.max(...catchups.filter((j) => j.status === "concluido").map((j) => t(j.concluidoEm)).filter(Number.isFinite), -Infinity);
      const f = avaliarFalhas(catchups, [-Infinity, Infinity], ultimoOk, pol, agoraMs);
      if (f.estado === "esgotado") { motivos.push("catchup_falhas_repetidas"); esgotado.push("catchup_falhas_repetidas"); }
      else if (f.estado === "esperar") espera = f.ate!;
      else necessidades.push({ job: { chave: `Shopee|${loja.id}|catchup_escrow`, marketplace: "Shopee", lojaId: loja.id, campoTempo: null, inicio: null, fim: null, de, ate, proposito: "catchup_escrow" },
        tipo: "refresh", prioridade: prioridadeDe(origem, "refresh", recente) });
    }
  }
  if (!lacunas.length) {
    // Frescor por SEGMENTO (SALES-SYNC-A2): um refresh mais novo substitui o
    // job antigo onde reobservou; o trecho NAO reobservado mantem a idade dele.
    const segs = observacaoPorSegmento(feitos, necessario);
    const intervalo = intervaloDeFrescor(pol, necessario[1], agoraMs, origem);
    const velhos = intervalo === null ? [] : uniao(segs.filter((s) => s.ultimaMs === null || agoraMs - s.ultimaMs > intervalo).map((s) => [s.inicio, s.fim] as Iv));
    // nao pago sem observacao pos-periodo: qualquer ponto da janela pode ter o pedido → reler a janela toda
    const alvos: Iv[] = sinais.naoObservadosAposPeriodo > 0 ? [necessario] : velhos;
    if (sinais.naoObservadosAposPeriodo > 0) motivos.push(`nao_pagos_sem_observacao_pos_periodo:${sinais.naoObservadosAposPeriodo}`);
    if (velhos.length) motivos.push("observacao_velha");
    if (alvos.length) {
      stale = true; desat.push(...alvos.map(([x, y]) => ({ inicio: isoDe(x), fim: isoDe(y) })));
      if (!ativos.length) for (const iv of alvos) {
        // falhas contam a partir da observacao efetiva DESTE trecho (nao de um job antigo de outro trecho)
        const f = avaliarFalhas(descoberta, iv, observacaoEfetivaDaJanela(feitos, iv) ?? -Infinity, pol, agoraMs);
        if (f.estado === "esgotado") { motivos.push("refresh_falhas_repetidas"); esgotado.push("refresh_falhas_repetidas"); }
        else if (f.estado === "esperar") espera = espera && espera > f.ate! ? espera : f.ate!;
        else necessidades.push(...janelaJob(iv[0], iv[1], "refresh").map((job) => ({ job, tipo: "refresh" as const, prioridade: prioridadeDe(origem, "refresh", recente) })));
      }
    }
  }
  if (espera) motivos.push("aguardando_retry_apos_falha");
  return {
    cobertura: esgotado.some((m) => m.startsWith("falhas_repetidas")) ? "FAILED" : faltando.length || (lacunas.length && ativos.length) ? "PARTIAL" : "COMPLETE",
    frescor: stale ? "STALE" : "FRESH", motivos: [...new Set(motivos)],
    faltando: faltando.map(([a, b]) => ({ inicio: isoDe(a), fim: isoDe(b) })), desatualizado: desat,
    necessidades, esperaAte: espera, esgotado, andamento,
  };
}

/** A UNICA proxima acao da loja: fila serial (um ativo por loja), prioridade e, empatado, o mais recente. */
export function escolherProximaAcao(args: { necessidades: Necessidade[]; jobAtivoDaLoja: string | null; esperaAte: string | null; esgotado: string[] }): ProximaAcao {
  if (args.jobAtivoDaLoja) return { acao: "WAIT_ACTIVE_JOB", jobId: args.jobAtivoDaLoja };
  const ord = [...args.necessidades].sort((a, b) => a.prioridade - b.prioridade || t(b.job.fim ?? b.job.inicio) - t(a.job.fim ?? a.job.inicio) || (a.job.proposito === "catchup_escrow" ? -1 : 0));
  const n = ord[0];
  if (n) return n.tipo === "discovery" ? { acao: "CREATE_DISCOVERY_JOB", job: n.job, prioridade: n.prioridade } : { acao: "CREATE_REFRESH_JOB", job: n.job, prioridade: n.prioridade };
  if (args.esperaAte) return { acao: "WAIT_RETRY", ate: args.esperaAte };
  if (args.esgotado.length) return { acao: "FAILED", motivos: args.esgotado };
  return { acao: "NOOP" };
}

/**
 * Avaliacao de UMA loja para [de, ate]. A parte de HOJE (aberta) nunca
 * gera job e deixa o frescor em IN_PROGRESS (nunca definitivo).
 */
export function avaliarLoja(args: {
  loja: LojaAtivaSync; de: string; ate: string; agoraMs: number; jobs: JobExistenteSync[];
  sinaisShopee?: SinaisShopeeSync; politica: PoliticaSync; origem: OrigemPedido;
}): AvaliacaoLojaSync {
  const { loja, de, ate, agoraMs, jobs, politica, origem } = args;
  if (!diasDaJanela(de, ate).length) throw new Error("periodo_invalido");
  const ativoDaLoja = jobs.find((j) => j.lojaId === loja.id && ATIVOS.has(j.status))?.id ?? null;
  const { fechadoAte, incluiHoje } = separarDiaCorrente(de, ate, agoraMs);
  const p: Parcial = fechadoAte === null
    ? { cobertura: "PARTIAL", frescor: "FRESH", motivos: ["periodo_aberto"], faltando: [], desatualizado: [], necessidades: [], esperaAte: null, esgotado: [], andamento: [] }
    : loja.marketplace === "ML"
      ? planejarML(loja, de, fechadoAte, agoraMs, jobs, politica, origem)
      : planejarShopee(loja, de, fechadoAte, agoraMs, jobs, args.sinaisShopee ?? { escrowPendentes: 0, naoObservadosAposPeriodo: 0 }, politica, origem);
  const frescor: Frescor = incluiHoje ? "IN_PROGRESS" : p.frescor;
  const proximaAcao = escolherProximaAcao({ necessidades: p.necessidades, jobAtivoDaLoja: ativoDaLoja, esperaAte: p.esperaAte, esgotado: p.esgotado });
  const sincronizacao: Sincronizacao = p.andamento.length || proximaAcao.acao === "WAIT_ACTIVE_JOB" ? "SYNCING" : p.esperaAte ? "WAITING_RETRY" : "IDLE";
  return {
    lojaId: loja.id, marketplace: loja.marketplace, cobertura: p.cobertura, frescor,
    definitivo: p.cobertura === "COMPLETE" && frescor === "FRESH",
    sincronizacao, motivos: [...p.motivos, ...(incluiHoje ? ["periodo_inclui_hoje"] : [])],
    faltando: p.faltando, desatualizado: p.desatualizado, necessidades: p.necessidades, proximaAcao, jobsEmAndamento: p.andamento,
  };
}

/**
 * Combinado (TODOS / varias lojas): definitivo so se TODAS as lojas
 * necessarias forem definitivas. Sem loja: nunca definitivo.
 */
export function agregar(lojas: AvaliacaoLojaSync[]): AvaliacaoSync {
  if (!lojas.length) return { cobertura: "PARTIAL", frescor: "FRESH", definitivo: false, sincronizacao: "IDLE", motivos: ["nenhuma_loja_conectada"], lojas };
  const cobertura: Cobertura = lojas.some((l) => l.cobertura === "FAILED") ? "FAILED" : lojas.some((l) => l.cobertura === "PARTIAL") ? "PARTIAL" : "COMPLETE";
  const frescor: Frescor = lojas.some((l) => l.frescor === "IN_PROGRESS") ? "IN_PROGRESS" : lojas.some((l) => l.frescor === "STALE") ? "STALE" : "FRESH";
  const sincronizacao: Sincronizacao = lojas.some((l) => l.sincronizacao === "SYNCING") ? "SYNCING" : lojas.some((l) => l.sincronizacao === "WAITING_RETRY") ? "WAITING_RETRY" : "IDLE";
  return { cobertura, frescor, definitivo: lojas.every((l) => l.definitivo), sincronizacao,
    motivos: [...new Set(lojas.flatMap((l) => l.motivos.map((m) => `${l.marketplace}:${m}`)))], lojas };
}

/**
 * Junta avaliacoes da MESMA loja vindas de pedidos diferentes (ex.: um
 * backfill em background e o usuario pedindo "ultimos 7 dias") e escolhe
 * a proxima acao pela prioridade combinada. Job rodando nunca e cancelado.
 */
export function proximaAcaoCombinada(avaliacoes: AvaliacaoLojaSync[], jobs: JobExistenteSync[]): ProximaAcao {
  if (!avaliacoes.length) return { acao: "NOOP" };
  const lojaId = avaliacoes[0].lojaId;
  if (avaliacoes.some((a) => a.lojaId !== lojaId)) throw new Error("lojas_diferentes");
  const vistas = new Set<string>(); const necessidades: Necessidade[] = [];
  for (const n of avaliacoes.flatMap((a) => a.necessidades)) { if (!vistas.has(n.job.chave)) { vistas.add(n.job.chave); necessidades.push(n); }
    else { const i = necessidades.findIndex((x) => x.job.chave === n.job.chave); if (n.prioridade < necessidades[i].prioridade) necessidades[i] = n; } }
  const espera = avaliacoes.map((a) => (a.proximaAcao.acao === "WAIT_RETRY" ? a.proximaAcao.ate : null)).filter(Boolean).sort()[0] ?? null;
  const esgotado = avaliacoes.flatMap((a) => (a.proximaAcao.acao === "FAILED" ? a.proximaAcao.motivos : []));
  return escolherProximaAcao({ necessidades, jobAtivoDaLoja: jobs.find((j) => j.lojaId === lojaId && ATIVOS.has(j.status))?.id ?? null, esperaAte: espera, esgotado });
}

/** Opcoes de backfill INICIAL (loja recem-conectada) — o coordenador nao escolhe sozinho. */
export const OPCOES_BACKFILL_INICIAL = [
  { id: "ULTIMOS_7_DIAS", dias: 7 },
  { id: "ULTIMOS_30_DIAS", dias: 30 },
  { id: "ULTIMOS_90_DIAS", dias: 90 },
  { id: "ANO_CORRENTE", dias: null },
] as const;

/** Bootstrap de loja nova: [hoje − N dias (ou 1o de janeiro), ontem], origem "bootstrap". */
export function avaliarBootstrap(args: { loja: LojaAtivaSync; agoraMs: number; jobs: JobExistenteSync[]; politica: PoliticaSync; horizonte: (typeof OPCOES_BACKFILL_INICIAL)[number]["id"] }): AvaliacaoLojaSync {
  const hoje = diaEmSaoPaulo(isoDe(args.agoraMs))!;
  const op = OPCOES_BACKFILL_INICIAL.find((o) => o.id === args.horizonte)!;
  const de = op.dias === null ? `${hoje.slice(0, 4)}-01-01` : somarDiasNoCalendario(hoje, -op.dias);
  return avaliarLoja({ loja: args.loja, de, ate: somarDiasNoCalendario(hoje, -1), agoraMs: args.agoraMs, jobs: args.jobs, politica: args.politica, origem: "bootstrap" });
}

// ── Intraday (SALES-SYNC-D15B) ──

/** Estado do intraday de uma loja, para relatorio (a acao continua sendo decidida por escolherProximaAcao). */
export type EstadoIntraday =
  | "NEED_INTRADAY" | "WAIT_INTRADAY_CADENCE" | "INTRADAY_ALREADY_AT_TARGET" | "INTRADAY_SEM_ALVO"
  | "WAIT_ACTIVE_JOB" | "WAIT_RETRY" | "FAILED";

/**
 * Necessidade INTRADAY de UMA loja: observar o dia corrente ate T (grade de
 * 15 min), no maximo a cada 30 min (pelo T da ultima observacao CONCLUIDA —
 * zero linhas tambem e observacao: so o job conta, nunca as linhas). Entra na
 * MESMA fila serial (escolherProximaAcao): job ativo → espera; falhas → a
 * MESMA politica (avaliarFalhas). Nunca vira cobertura fechada.
 *
 *   ML      [inicio do dia, T]           (relista o dia ate T — check B)
 *   Shopee  [ultimo T concluido, T]      (create_time incremental; REDETAIL no D15D)
 */
export function avaliarIntradayLoja(args: { loja: LojaAtivaSync; agoraMs: number; jobs: JobExistenteSync[]; politica: PoliticaSync }): { estado: EstadoIntraday; avaliacao: AvaliacaoLojaSync } {
  const { loja, agoraMs, jobs, politica } = args;
  const hoje = diaEmSaoPaulo(isoDe(agoraMs))!;
  const dia = limitesDoDiaMs(hoje)!;
  const campo = loja.marketplace === "ML" ? "date_closed" : "create_time";
  const alvo = alvoIntradayMs(agoraMs);
  const meus = jobs.filter((j) => j.lojaId === loja.id && j.marketplace === loja.marketplace && j.campoTempo === campo && ehJobIntradayDoDia(j, hoje));
  const ativo = jobs.find((j) => j.lojaId === loja.id && ATIVOS.has(j.status))?.id ?? null;
  const concluidos = meus.filter(completo);
  const ultimoT = Math.max(...concluidos.map((j) => t(j.janelaFim)).filter(Number.isFinite), -Infinity);
  const ultimoSucesso = Math.max(...concluidos.map((j) => t(j.concluidoEm)).filter(Number.isFinite), -Infinity);

  const resultado = (estado: EstadoIntraday, necessidades: Necessidade[], esperaAte: string | null = null, esgotado: string[] = []) => ({
    estado: ativo && necessidades.length ? "WAIT_ACTIVE_JOB" as const : estado,
    avaliacao: {
      lojaId: loja.id, marketplace: loja.marketplace, cobertura: "PARTIAL" as Cobertura, frescor: "IN_PROGRESS" as Frescor, definitivo: false,
      sincronizacao: (ativo ? "SYNCING" : esperaAte ? "WAITING_RETRY" : "IDLE") as Sincronizacao,
      motivos: [`intraday:${estado}`], faltando: [], desatualizado: [], necessidades,
      proximaAcao: escolherProximaAcao({ necessidades, jobAtivoDaLoja: ativo, esperaAte, esgotado }), jobsEmAndamento: ativo ? [ativo] : [],
    },
  });

  if (alvo <= dia.inicio) return resultado("INTRADAY_SEM_ALVO", []);
  if (ultimoT >= alvo) return resultado("INTRADAY_ALREADY_AT_TARGET", []);
  if (ultimoT > alvo - CADENCIA_INTRADAY_MS) return resultado("WAIT_INTRADAY_CADENCE", []);
  const f = avaliarFalhas(meus, [dia.inicio, dia.fim], ultimoSucesso, politica, agoraMs);
  if (f.estado === "esgotado") return resultado("FAILED", [], null, ["intraday_falhas_repetidas"]);
  if (f.estado === "esperar") return resultado("WAIT_RETRY", [], f.ate!);

  const inicio = campo === "date_closed" ? dia.inicio : Math.max(dia.inicio, ultimoT);
  const job: JobPlanejado = {
    chave: chaveIntraday(loja.marketplace, loja.id, campo, isoDe(dia.inicio), isoDe(alvo)), marketplace: loja.marketplace, lojaId: loja.id,
    campoTempo: campo, inicio: isoDe(inicio), fim: isoDe(alvo), de: hoje, ate: hoje, proposito: "intraday",
  };
  return resultado("NEED_INTRADAY", [{ job, tipo: "refresh", prioridade: PRIORIDADE_INTRADAY }]);
}
