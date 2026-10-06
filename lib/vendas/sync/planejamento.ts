/**
 * Planejamento PURO do coordenador de vendas (SALES-SYNC-A).
 *
 * Responde, para uma loja e um periodo [de, ate] (dias civis de Sao
 * Paulo, ja resolvidos — presets nao sao responsabilidade daqui):
 * o que falta descobrir, o que esta velho, que job precisa existir, o que
 * ja esta rodando e em que estado o periodo esta. Nao calcula valor.
 *
 *   ML      descoberta  = date_closed, janelas por DIA (motor ML).
 *           refresh     = RELER a propria janela fechada (populacao
 *                         imutavel; upsert atualiza cancel_detail/status).
 *   Shopee  descoberta  = create_time, cadeia [inicio − prazo publicado,
 *                         fim] (mesma base POLITICA do servico canonico),
 *                         blocos de 14 dias com borda compartilhada
 *                         (planejarJanelasCriacao do motor Shopee).
 *           estado      = escrow pendente → catch-up de escrow; pedido nao
 *                         pago sem observacao depois do periodo → reler as
 *                         janelas de create_time.
 *   update_time NUNCA conta como cobertura (S2-D3-B2.1).
 *
 * Dia corrente: aberto — nunca COMPLETE, nunca vira job (os motores
 * recusam janela aberta). O resto do periodo e avaliado normalmente.
 */
import { diaEmSaoPaulo, somarDiasNoCalendario } from "@/lib/fuso-sao-paulo";
import { diasDaJanela, limitesDaJanela } from "@/lib/mercado-livre/ingestao/janelas";
import { planejarJanelasCriacao } from "@/lib/shopee/ingestao/janelas";
import { LIMITE_POLITICA_PAGAMENTO_MS } from "@/lib/vendas/canonico/shopee";
import type {
  EstadoSync, Intervalo, JobExistenteSync, JobPlanejado, LojaAtivaSync, PoliticaSync, ResultadoLojaSync, SinaisShopeeSync,
} from "./tipos";

const DIA_MS = 24 * 3600 * 1000;
const ATIVOS = new Set(["pendente", "rodando"]);
const t = (iso: string | null) => (iso ? new Date(iso).getTime() : NaN);
const isoDe = (ms: number) => new Date(ms).toISOString();

/**
 * PROPOSTA de frescor (nao e politica oficial — o coordenador recebe a
 * politica explicitamente). Racional: cancel_detail/status mudam mais nos
 * primeiros dias (pack_splitted apareceu dias depois no ML-CORPUS-C2);
 * reler um dia ML custa ~6 chamadas (paginas de 51), e reler a Shopee e
 * proporcional aos pedidos. Dias mais velhos que a ultima faixa so sao
 * relidos sob demanda.
 */
export const POLITICA_SYNC_PROPOSTA: PoliticaSync = {
  faixas: [
    { idadeMaxDias: 7, intervaloMs: 6 * 3600 * 1000 },
    { idadeMaxDias: 30, intervaloMs: 24 * 3600 * 1000 },
    { idadeMaxDias: 90, intervaloMs: 7 * DIA_MS },
  ],
  maxFalhasPorJanela: 3,
  esperaAposFalhaMs: 30 * 60 * 1000,
  maxDiasPorJobML: 31,
};

/** Hoje (dia civil de SP) e a parte FECHADA do periodo. */
export function separarDiaCorrente(de: string, ate: string, agoraMs: number): { hoje: string; fechadoAte: string | null; incluiHoje: boolean } {
  const hoje = diaEmSaoPaulo(isoDe(agoraMs))!;
  const ontem = somarDiasNoCalendario(hoje, -1);
  const incluiHoje = ate >= hoje;
  const fechadoAte = (ate < ontem ? ate : ontem) < de ? null : (ate < ontem ? ate : ontem);
  return { hoje, fechadoAte, incluiHoje };
}

// ── intervalos (instantes em ms) ──
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
const sobrepoe = (j: JobExistenteSync, [a, b]: Iv) => t(j.janelaInicio) < b && t(j.janelaFim) > a;
const contem = (j: JobExistenteSync, [a, b]: Iv) => t(j.janelaInicio) <= a && t(j.janelaFim) >= b;
const completo = (j: JobExistenteSync) => j.status === "concluido" && j.listagemCompleta === true;
const diaCivil = (ms: number) => diaEmSaoPaulo(isoDe(ms))!;

function faixaDeFrescor(pol: PoliticaSync, fimDoPeriodoMs: number, agoraMs: number) {
  const idadeDias = (agoraMs - fimDoPeriodoMs) / DIA_MS;
  return pol.faixas.find((f) => idadeDias <= f.idadeMaxDias) ?? null;
}
/** Falhas da janela: FAILED alem do teto; espera depois da ultima falha. */
function avaliarFalhas(falhas: JobExistenteSync[], pol: PoliticaSync, agoraMs: number): "ok" | "esperar" | "esgotado" {
  if (falhas.length >= pol.maxFalhasPorJanela) return "esgotado";
  const ultima = Math.max(...falhas.map((j) => t(j.concluidoEm) || t(j.criadoEm)), -Infinity);
  return falhas.length && agoraMs - ultima < pol.esperaAposFalhaMs ? "esperar" : "ok";
}
function estadoDe(falhou: string[], parcial: string[], andamento: boolean, cobertos: number, total: number): EstadoSync {
  if (falhou.length) return { estado: "FAILED", motivos: falhou };
  if (parcial.length) return { estado: "PARTIAL", motivos: parcial };
  if (andamento) return { estado: "SYNCING", progresso: { cobertos, total } };
  return { estado: "COMPLETE" };
}

// ── Mercado Livre ──
function planejarML(loja: LojaAtivaSync, de: string, ate: string, agoraMs: number, jobs: JobExistenteSync[], pol: PoliticaSync): ResultadoLojaSync {
  const meus = jobs.filter((j) => j.lojaId === loja.id && j.marketplace === "ML" && j.campoTempo === "date_closed" && j.janelaInicio && j.janelaFim);
  const faltam: string[] = [], velhos: string[] = [], andamento = new Set<string>(); const falhou: string[] = []; let esperar = false, cobertos = 0;
  const dias = diasDaJanela(de, ate);
  for (const dia of dias) {
    const l = limitesDaJanela(dia, dia)!; const iv: Iv = [l.inicio.getTime(), l.fim.getTime()];
    const ativo = meus.find((j) => ATIVOS.has(j.status) && sobrepoe(j, iv));
    const feitos = meus.filter((j) => completo(j) && contem(j, iv));
    if (feitos.length) {
      cobertos++;
      const faixa = faixaDeFrescor(pol, iv[1], agoraMs);
      const ultima = Math.max(...feitos.map((j) => t(j.concluidoEm)).filter(Number.isFinite), -Infinity);
      if (faixa && !ativo && agoraMs - ultima > faixa.intervaloMs) velhos.push(dia);
      if (ativo) andamento.add(ativo.id);
      continue;
    }
    if (ativo) { andamento.add(ativo.id); continue; }
    const f = avaliarFalhas(meus.filter((j) => j.status === "erro" && contem(j, iv)), pol, agoraMs);
    if (f === "esgotado") falhou.push(`falhas_repetidas:${dia}`);
    else if (f === "esperar") esperar = true;
    else faltam.push(dia);
  }
  const blocos = (lista: string[]) => { const out: string[][] = [];
    for (const d of lista) { const u = out[out.length - 1]; if (u && somarDiasNoCalendario(u[u.length - 1], 1) === d && u.length < pol.maxDiasPorJobML) u.push(d); else out.push([d]); }
    return out; };
  const job = (b: string[], proposito: "descoberta" | "refresh"): JobPlanejado => { const l = limitesDaJanela(b[0], b[b.length - 1])!;
    return { chave: `ML|${loja.id}|date_closed|${l.inicio.toISOString()}|${l.fim.toISOString()}|${proposito}`, marketplace: "ML", lojaId: loja.id,
      campoTempo: "date_closed", inicio: l.inicio.toISOString(), fim: l.fim.toISOString(), de: b[0], ate: b[b.length - 1], proposito }; };
  const novos = blocos(faltam).reverse().map((b) => job(b, "descoberta"));      // mais recente primeiro
  const refresh = andamento.size || novos.length ? [] : blocos(velhos).reverse().map((b) => job(b, "refresh"));
  const parcial = [...(faltam.length ? [`cobertura_date_closed_faltando:${faltam.length}_dias`] : []), ...(esperar ? ["aguardando_retry_apos_falha"] : [])];
  return {
    lojaId: loja.id, marketplace: "ML", estado: estadoDe(falhou, parcial, andamento.size > 0, cobertos, dias.length),
    faltando: blocos(faltam).map((b) => { const l = limitesDaJanela(b[0], b[b.length - 1])!; return { inicio: l.inicio.toISOString(), fim: l.fim.toISOString() }; }),
    desatualizado: blocos(velhos).map((b) => { const l = limitesDaJanela(b[0], b[b.length - 1])!; return { inicio: l.inicio.toISOString(), fim: l.fim.toISOString() }; }),
    jobsNecessarios: [...novos, ...refresh], jobsEmAndamento: [...andamento],
  };
}

// ── Shopee ──
function planejarShopee(loja: LojaAtivaSync, de: string, ate: string, agoraMs: number, jobs: JobExistenteSync[], sinais: SinaisShopeeSync, pol: PoliticaSync): ResultadoLojaSync {
  const l = limitesDaJanela(de, ate)!;
  const necessario: Iv = [l.inicio.getTime() - LIMITE_POLITICA_PAGAMENTO_MS, l.fim.getTime()];
  const meus = jobs.filter((j) => j.lojaId === loja.id && j.marketplace === "Shopee");
  const descoberta = meus.filter((j) => j.campoTempo === "create_time" && j.janelaInicio && j.janelaFim);
  const feitos = descoberta.filter(completo);
  const ativos = descoberta.filter((j) => ATIVOS.has(j.status));
  const catchupAtivo = meus.find((j) => j.campoTempo === null && j.janelaInicio === null && ATIVOS.has(j.status));
  const lacunas = subtrair(necessario, feitos.map((j) => [t(j.janelaInicio), t(j.janelaFim)] as Iv));
  const faltando = subtrair(necessario, [...feitos, ...ativos].map((j) => [t(j.janelaInicio), t(j.janelaFim)] as Iv));
  const andamento = new Set<string>([...ativos.filter((j) => lacunas.some((g) => sobrepoe(j, g))).map((j) => j.id), ...(catchupAtivo ? [catchupAtivo.id] : [])]);
  const falhou: string[] = []; const parcial: string[] = []; const novos: JobPlanejado[] = [];
  const janelaJob = (a: number, b: number, proposito: "descoberta" | "refresh"): JobPlanejado[] =>
    planejarJanelasCriacao(new Date(a), new Date(b)).map((w) => ({
      chave: `Shopee|${loja.id}|create_time|${w.inicio.toISOString()}|${w.fim.toISOString()}|${proposito}`, marketplace: "Shopee", lojaId: loja.id,
      campoTempo: "create_time", inicio: w.inicio.toISOString(), fim: w.fim.toISOString(), de: diaCivil(w.inicio.getTime()), ate: diaCivil(w.fim.getTime() - 1), proposito }));
  for (const g of faltando) {
    const f = avaliarFalhas(descoberta.filter((j) => j.status === "erro" && sobrepoe(j, g)), pol, agoraMs);
    if (f === "esgotado") falhou.push(`falhas_repetidas:${isoDe(g[0])}`);
    else if (f === "esperar") parcial.push("aguardando_retry_apos_falha");
    else novos.push(...janelaJob(g[0], g[1], "descoberta"));
  }
  if (faltando.length) parcial.push(`cobertura_create_time_faltando:${faltando.length}_trechos`);
  if (sinais.escrowPendentes > 0) {
    if (!catchupAtivo) {
      parcial.push(`escrow_pendente:${sinais.escrowPendentes}`);
      novos.push({ chave: `Shopee|${loja.id}|catchup_escrow`, marketplace: "Shopee", lojaId: loja.id, campoTempo: null, inicio: null, fim: null, de, ate, proposito: "catchup_escrow" });
    }
  }
  const semLacuna = lacunas.length === 0;
  let velho = false;
  if (semLacuna && !ativos.length) {
    if (sinais.naoObservadosAposPeriodo > 0) { parcial.push(`nao_pagos_sem_observacao_pos_periodo:${sinais.naoObservadosAposPeriodo}`); novos.push(...janelaJob(necessario[0], necessario[1], "refresh")); }
    else {
      const faixa = faixaDeFrescor(pol, necessario[1], agoraMs);
      const ultima = Math.min(...feitos.filter((j) => sobrepoe(j, necessario)).map((j) => t(j.concluidoEm)).filter(Number.isFinite));
      if (faixa && agoraMs - ultima > faixa.intervaloMs) { velho = true; novos.push(...janelaJob(necessario[0], necessario[1], "refresh")); }
    }
  }
  const ordenados = [...novos.filter((j) => j.proposito === "descoberta").reverse(), ...novos.filter((j) => j.proposito === "catchup_escrow"), ...novos.filter((j) => j.proposito === "refresh").reverse()];
  const total = necessario[1] - necessario[0], cobertoMs = total - lacunas.reduce((s, [a, b]) => s + (b - a), 0);
  return {
    lojaId: loja.id, marketplace: "Shopee",
    estado: estadoDe(falhou, [...new Set(parcial)], andamento.size > 0, Math.round(cobertoMs / DIA_MS), Math.round(total / DIA_MS)),
    faltando: faltando.map(([a, b]) => ({ inicio: isoDe(a), fim: isoDe(b) })),
    desatualizado: velho ? [{ inicio: isoDe(necessario[0]), fim: isoDe(necessario[1]) }] : [],
    jobsNecessarios: ordenados, jobsEmAndamento: [...andamento],
  };
}

/**
 * Plano de UMA loja para [de, ate]. A parte de HOJE (aberta) nunca gera job
 * e deixa o periodo em IN_PROGRESS quando o resto esta COMPLETE.
 */
export function planejarLoja(args: {
  loja: LojaAtivaSync; de: string; ate: string; agoraMs: number; jobs: JobExistenteSync[];
  sinaisShopee?: SinaisShopeeSync; politica: PoliticaSync;
}): ResultadoLojaSync {
  const { loja, de, ate, agoraMs, jobs, politica } = args;
  if (!(diasDaJanela(de, ate).length)) throw new Error("periodo_invalido");
  const { fechadoAte, incluiHoje } = separarDiaCorrente(de, ate, agoraMs);
  if (fechadoAte === null) {
    return { lojaId: loja.id, marketplace: loja.marketplace, estado: { estado: "IN_PROGRESS", motivos: ["periodo_aberto"] }, faltando: [], desatualizado: [], jobsNecessarios: [], jobsEmAndamento: [] };
  }
  const r = loja.marketplace === "ML"
    ? planejarML(loja, de, fechadoAte, agoraMs, jobs, politica)
    : planejarShopee(loja, de, fechadoAte, agoraMs, jobs, args.sinaisShopee ?? { escrowPendentes: 0, naoObservadosAposPeriodo: 0 }, politica);
  if (incluiHoje && r.estado.estado === "COMPLETE") r.estado = { estado: "IN_PROGRESS", motivos: ["periodo_inclui_hoje"] };
  return r;
}

/**
 * Estado combinado (TODOS / todas as lojas): COMPLETE so se TODAS estiverem
 * COMPLETE. FAILED > PARTIAL > SYNCING > IN_PROGRESS > COMPLETE. Sem loja:
 * PARTIAL (nunca um zero "definitivo").
 */
export function agregarEstados(estados: EstadoSync[]): EstadoSync {
  if (!estados.length) return { estado: "PARTIAL", motivos: ["nenhuma_loja_conectada"] };
  const de = (e: EstadoSync["estado"]) => estados.filter((x) => x.estado === e);
  if (de("FAILED").length) return { estado: "FAILED", motivos: de("FAILED").flatMap((x: any) => x.motivos) };
  if (de("PARTIAL").length) return { estado: "PARTIAL", motivos: de("PARTIAL").flatMap((x: any) => x.motivos) };
  if (de("SYNCING").length) { const s = de("SYNCING") as Extract<EstadoSync, { estado: "SYNCING" }>[];
    return { estado: "SYNCING", progresso: { cobertos: s.reduce((a, x) => a + x.progresso.cobertos, 0), total: s.reduce((a, x) => a + x.progresso.total, 0) } }; }
  if (de("IN_PROGRESS").length) return { estado: "IN_PROGRESS", motivos: [...new Set(de("IN_PROGRESS").flatMap((x: any) => x.motivos))] };
  return { estado: "COMPLETE" };
}

/** Opcoes de backfill INICIAL (loja recem-conectada) — o coordenador nao escolhe sozinho. */
export const OPCOES_BACKFILL_INICIAL = [
  { id: "ULTIMOS_7_DIAS", dias: 7 },
  { id: "ULTIMOS_30_DIAS", dias: 30 },
  { id: "ULTIMOS_90_DIAS", dias: 90 },
  { id: "ANO_CORRENTE", dias: null },
] as const;

/** Plano de bootstrap de uma loja nova: [hoje − N dias (ou 1o de janeiro), ontem]. */
export function planejarBootstrap(args: { loja: LojaAtivaSync; agoraMs: number; jobs: JobExistenteSync[]; politica: PoliticaSync; horizonte: (typeof OPCOES_BACKFILL_INICIAL)[number]["id"] }): ResultadoLojaSync {
  const hoje = diaEmSaoPaulo(isoDe(args.agoraMs))!;
  const op = OPCOES_BACKFILL_INICIAL.find((o) => o.id === args.horizonte)!;
  const de = op.dias === null ? `${hoje.slice(0, 4)}-01-01` : somarDiasNoCalendario(hoje, -op.dias);
  return planejarLoja({ loja: args.loja, de, ate: somarDiasNoCalendario(hoje, -1), agoraMs: args.agoraMs, jobs: args.jobs, politica: args.politica });
}
