/**
 * Motor de ingestao Shopee — orquestracao por FATIA (S2-D2).
 *
 *   LIST (update_time | create_time, cursor ate o fim)
 *     → DETAIL (lotes de 50, concorrencia limitada)
 *     → ESCROW (1 pedido/chamada, concorrencia limitada; so pagos que
 *               precisam: sem escrow, ou escrow anterior ao update_time)
 *     → DONE
 * com checkpoint em sync_jobs.checkpoint depois de cada pagina/rodada.
 *
 * Fatia: recebe um prazo; ANTES de cada chamada confere o orcamento e, se
 * nao cabe, salva o checkpoint e devolve `pausado` (sem lancar timeout). A
 * proxima fatia continua do checkpoint; repetir trabalho e seguro (upserts
 * idempotentes por (loja, order_sn) e por id de item).
 *
 * Evidencias que o motor produz (quem DECIDE completude e o servico
 * canonico, lib/vendas/canonico/shopee.ts):
 *  - `listagem_completa`: false ate a ultima pagina; true so quando o cursor
 *    acabou sem erro e todo order_sn listado foi registrado no checkpoint;
 *  - status do job: `concluido` quando todo pedido listado materializou;
 *    `erro` se algum listado nunca materializou (detail desistido) — a
 *    janela entao NAO serve de prova de cobertura;
 *  - detail_fetched_at / escrow_fetched_at / escrow_update_time por pedido.
 *
 * S2-D3-B2.1: janelas de `create_time` (FECHADAS) sao a DESCOBERTA do corpus;
 * janelas de `update_time` so aceleram frescor (o cursor real pula pedidos
 * quando o conjunto muda durante a paginacao) e nunca provam descoberta.
 * Fica atras de ENABLE_ASYNC_SYNC_JOBS (padrao OFF).
 */
import "server-only";
import { ASYNC_SYNC_JOBS_ENABLED } from "@/lib/feature-flags";
import { JANELA_MAXIMA_MS } from "./janelas";
import { escrowShopeeAtual } from "@/lib/vendas/canonico/shopee";
import { ErroCorrespondenciaEscrow, normalizarDetalhe, normalizarEscrow } from "./normalizar";
import { comRetry, RETRY_PADRAO, type OpcoesRetry } from "./retry";
import {
  ErroShopee, type CheckpointCatchUpEscrow, type CheckpointShopee, type JobShopee, type LinhaItemDetalhe, type LinhaPedidoDetalhe,
  type ProgressoShopee, type Relogio, type Repositorio, type ShopeeApi,
} from "./tipos";

export interface OpcoesMotor {
  /** Instante (epoch ms) ate o qual a fatia pode trabalhar. */
  prazoMs: number;
  /** Reserva antes do prazo: nao inicia chamada se sobrar menos que isso. */
  margemMs?: number;
  tamanhoPagina?: number;
  loteDetalhe?: number;
  concorrenciaDetalhe?: number;
  concorrenciaEscrow?: number;
  /** Quantas fatias um pedido pode falhar (detail ausente/escrow) antes de desistir. */
  maxTentativasPorPedido?: number;
  retry?: OpcoesRetry;
  /** Sobrescreve a feature flag (testes). Padrao: ENABLE_ASYNC_SYNC_JOBS. */
  habilitado?: boolean;
}

export const PADROES = {
  margemMs: 8_000, tamanhoPagina: 100, loteDetalhe: 50,
  concorrenciaDetalhe: 2, concorrenciaEscrow: 4, maxTentativasPorPedido: 3,
};

export type ResultadoFatia =
  | { estado: "desabilitado" }
  | { estado: "pausado" | "concluido" | "falhou"; motivo?: string; checkpoint: CheckpointShopee; progresso: ProgressoShopee };

export function checkpointInicial(): CheckpointShopee {
  return { versao: 1, fase: "LIST", listagemIniciadaEm: null, cursor: null, paginasLidas: 0, listagemTerminou: false,
    pendentesDetalhe: [], tentativasDetalhe: {}, falhasDetalhe: [], pendentesEscrow: [], tentativasEscrow: {}, falhasEscrow: {} };
}
export function progressoInicial(): ProgressoShopee {
  return { paginas: 0, listados: 0, detail_solicitados: 0, detail_concluidos: 0, detail_falhos: 0,
    escrow_necessarios: 0, escrow_concluidos: 0, escrow_falhos: 0, pedidos_gravados: 0, itens_gravados: 0,
    erros_listagem: 0, ultimo_erro: null };
}

const msgDe = (e: unknown) => (e instanceof Error ? e.message : String(e));
const tipoDe = (e: unknown) => (e instanceof ErroShopee ? e.tipo : "transitorio");
function acrescentar(lista: string[], novos: string[]) { const s = new Set(lista); for (const x of novos) if (!s.has(x)) { s.add(x); lista.push(x); } }

export async function executarFatiaShopee(
  job: JobShopee,
  deps: { api: ShopeeApi; repo: Repositorio; relogio: Relogio },
  opcoes: OpcoesMotor,
): Promise<ResultadoFatia> {
  if (!(opcoes.habilitado ?? ASYNC_SYNC_JOBS_ENABLED)) return { estado: "desabilitado" };
  const o = { ...PADROES, ...opcoes, retry: opcoes.retry ?? RETRY_PADRAO };
  const { api, repo, relogio } = deps;
  const ck: CheckpointShopee = job.checkpoint ? structuredClone(job.checkpoint) : checkpointInicial();
  const pr: ProgressoShopee = job.progresso ? structuredClone(job.progresso) : progressoInicial();
  const dono = { id: job.id, userId: job.userId, lojaId: job.lojaId };
  let janelaFim = job.janelaFim;

  type Extra = { listagemCompleta?: boolean; janelaFim?: string; status?: "rodando" | "concluido" | "erro"; erroMensagem?: string | null };
  const salvar = (extra: Extra = {}) => repo.salvarJob(dono, { checkpoint: ck, progresso: pr, ...extra });
  const pausar = async (motivo: string, listagemCompleta?: boolean) => {
    await salvar({ status: "rodando", ...(listagemCompleta === undefined ? {} : { listagemCompleta }) });
    return { estado: "pausado" as const, motivo, checkpoint: ck, progresso: pr };
  };
  const falhar = async (motivo: string) => {
    pr.ultimo_erro = motivo;
    await salvar({ status: "erro", erroMensagem: motivo, listagemCompleta: ck.listagemTerminou ? undefined : false });
    return { estado: "falhou" as const, motivo, checkpoint: ck, progresso: pr };
  };
  const cabe = () => relogio.agoraMs() + o.margemMs < o.prazoMs;

  // ── dono e janela ────────────────────────────────────────────────
  // Ownership vem do BANCO (loja do usuario), nunca do shop_id da API.
  if (!(await repo.lojaDoDono(job.userId, job.lojaId))) return falhar("loja_invalida");
  const ini = new Date(job.janelaInicio).getTime(), fimOriginal = new Date(job.janelaFim).getTime();
  if (!(Number.isFinite(ini) && Number.isFinite(fimOriginal) && fimOriginal > ini)) return falhar("janela_invalida");
  if (fimOriginal - ini > JANELA_MAXIMA_MS) return falhar("janela_maior_que_o_limite_da_api");

  // ── LIST ─────────────────────────────────────────────────────────
  if (ck.fase === "LIST") {
    if (ck.listagemIniciadaEm === null) {
      const agora = relogio.agoraMs();
      // Nunca declarar cobertura do futuro: fim <= inicio da listagem.
      if (fimOriginal > agora) janelaFim = new Date(agora).toISOString();
      ck.listagemIniciadaEm = new Date(agora).toISOString();
      await salvar({ status: "rodando", janelaFim, listagemCompleta: false });
    }
    const fimMs = new Date(janelaFim).getTime();
    while (!ck.listagemTerminou) {
      if (!cabe()) return pausar("prazo", false);
      let pagina;
      try {
        pagina = await comRetry(() => api.listarPagina({ campoTempo: job.campoTempo, de: ini, ate: fimMs, cursor: ck.cursor, tamanhoPagina: o.tamanhoPagina }), o.retry);
      } catch (e) {
        // Erro de pagina NUNCA vira "zero pedidos" nem "fim": cursor fica onde
        // estava, listagem_completa = false, a fatia para.
        pr.erros_listagem++; pr.ultimo_erro = `listagem: ${msgDe(e)}`;
        if (tipoDe(e) === "permanente") return falhar(pr.ultimo_erro);
        return pausar(pr.ultimo_erro, false);
      }
      const sns = pagina.pedidos.map((p) => p.orderSn);
      acrescentar(ck.pendentesDetalhe, sns);
      ck.paginasLidas++; pr.paginas++; pr.listados += sns.length;
      if (pagina.mais) {
        ck.cursor = pagina.proximoCursor;
        await salvar({ status: "rodando" });
      } else {
        ck.listagemTerminou = true; ck.cursor = null; ck.fase = "DETAIL";
        // So agora: ultima pagina lida, todos os order_sn ja no checkpoint.
        await salvar({ status: "rodando", listagemCompleta: true });
      }
    }
  }

  // ── DETAIL ───────────────────────────────────────────────────────
  if (ck.fase === "DETAIL") {
    while (ck.pendentesDetalhe.length > 0) {
      if (!cabe()) return pausar("prazo");
      const rodada = ck.pendentesDetalhe.slice(0, o.loteDetalhe * o.concorrenciaDetalhe);
      const lotes: string[][] = [];
      for (let i = 0; i < rodada.length; i += o.loteDetalhe) lotes.push(rodada.slice(i, i + o.loteDetalhe));
      const agoraIso = new Date(relogio.agoraMs()).toISOString();
      let transitorio: string | null = null;
      const resultados = await Promise.all(lotes.map(async (lote) => {
        pr.detail_solicitados += lote.length;
        try { return { lote, det: await comRetry(() => api.detalhes(lote), o.retry), erro: null as unknown }; }
        catch (e) { return { lote, det: null, erro: e }; }
      }));
      const pedidos: LinhaPedidoDetalhe[] = []; const itens: LinhaItemDetalhe[] = [];
      const pagos = new Map<string, string>(); // sn -> update_time
      const resolvidos = new Set<string>();
      for (const r of resultados) {
        if (r.det === null) {
          if (tipoDe(r.erro) !== "permanente") { transitorio = `detail: ${msgDe(r.erro)}`; continue; }
          for (const sn of r.lote) registrarFalhaDetalhe(sn, `detail permanente: ${msgDe(r.erro)}`);
          continue;
        }
        const porSn = new Map(r.det.map((d) => [d.orderSn, d]));
        for (const sn of r.lote) {
          const d = porSn.get(sn);
          // Pediu N e veio menos: o que faltou NAO e concluido.
          if (!d) { registrarFalhaDetalhe(sn, "detail ausente na resposta"); continue; }
          try {
            const n = normalizarDetalhe(d, { userId: job.userId, lojaId: job.lojaId, agoraIso });
            pedidos.push(n.pedido); itens.push(...n.itens); resolvidos.add(sn);
            if (n.pedido.pay_time) pagos.set(sn, n.pedido.update_time);
          } catch (e) { registrarFalhaDetalhe(sn, `normalizacao: ${msgDe(e)}`, true); }
        }
      }
      // Chave de item por loja (S2-D2.1): o repositorio resolve o id pela
      // chave (loja, pedido, item, variacao) — nada cruza loja, nada falha.
      if (pedidos.length) {
        await repo.gravarDetalhes(pedidos, itens);
        pr.detail_concluidos += pedidos.length; pr.pedidos_gravados += pedidos.length; pr.itens_gravados += itens.length;
        // Escrow necessario: pago E nao atual — `escrowShopeeAtual`, a mesma
        // regra da coluna gerada `escrow_pendente` (S2-D3-A.1: so `<` ou
        // nunca lido; `>=` e atual). estadoEscrow so devolve escrow_update_time,
        // que e gravado junto com escrow_fetched_at.
        const estado = await repo.estadoEscrow(job.userId, job.lojaId, [...pagos.keys()]);
        const precisa = [...pagos].filter(([sn, upd]) => {
          const lido = estado.get(sn) ?? null;
          return !escrowShopeeAtual(lido, lido, upd);
        }).map(([sn]) => sn);
        pr.escrow_necessarios += precisa.length;
        acrescentar(ck.pendentesEscrow, precisa);
      }
      ck.pendentesDetalhe = ck.pendentesDetalhe.filter((sn) => !resolvidos.has(sn) && !ck.falhasDetalhe.includes(sn));
      for (const sn of resolvidos) delete ck.tentativasDetalhe[sn];
      await salvar({ status: "rodando" });
      if (transitorio) return pausar(transitorio);
    }
    ck.fase = "ESCROW";
    await salvar({ status: "rodando" });
  }

  // ── ESCROW ───────────────────────────────────────────────────────
  if (ck.fase === "ESCROW") {
    while (ck.pendentesEscrow.length > 0) {
      if (!cabe()) return pausar("prazo");
      const rodada = ck.pendentesEscrow.slice(0, o.concorrenciaEscrow);
      const agoraIso = new Date(relogio.agoraMs()).toISOString();
      let progrediu = false; let transitorio: string | null = null;
      await Promise.all(rodada.map(async (sn) => {
        const r = await processarEscrowDePedido(sn, { userId: job.userId, lojaId: job.lojaId, api, repo, retry: o.retry, agoraIso });
        if (r.ok) {
          pr.escrow_concluidos++; progrediu = true;
          ck.pendentesEscrow = ck.pendentesEscrow.filter((x) => x !== sn); delete ck.tentativasEscrow[sn];
          return;
        }
        if (r.definitivo) { desistirEscrow(sn, r.motivo); return; }
        transitorio = r.motivo;
        ck.tentativasEscrow[sn] = (ck.tentativasEscrow[sn] ?? 0) + 1;
        if (ck.tentativasEscrow[sn] >= o.maxTentativasPorPedido) desistirEscrow(sn, transitorio);
      }));
      await salvar({ status: "rodando" });
      if (transitorio && !progrediu) return pausar(transitorio);
    }
    ck.fase = "DONE";
  }

  // ── DONE ─────────────────────────────────────────────────────────
  // Pedido listado que nunca materializou invalida a janela como prova.
  if (ck.falhasDetalhe.length > 0) return falhar(`pedidos_listados_nao_materializados:${ck.falhasDetalhe.length}`);
  await salvar({ status: "concluido", erroMensagem: null });
  return { estado: "concluido", checkpoint: ck, progresso: pr };

  function registrarFalhaDetalhe(sn: string, motivo: string, definitiva = false) {
    ck.tentativasDetalhe[sn] = (ck.tentativasDetalhe[sn] ?? 0) + 1;
    pr.ultimo_erro = `${sn}: ${motivo}`;
    if (definitiva || ck.tentativasDetalhe[sn] >= o.maxTentativasPorPedido) {
      if (!ck.falhasDetalhe.includes(sn)) { ck.falhasDetalhe.push(sn); pr.detail_falhos++; }
    }
  }
  function desistirEscrow(sn: string, motivo: string) {
    ck.falhasEscrow[sn] = motivo; pr.escrow_falhos++; pr.ultimo_erro = `${sn}: ${motivo}`;
    ck.pendentesEscrow = ck.pendentesEscrow.filter((x) => x !== sn); delete ck.tentativasEscrow[sn];
  }
}

// ── Escrow de UM pedido (rotina unica: fase ESCROW e catch-up) ───────

export type ResultadoEscrow = { ok: true } | { ok: false; definitivo: boolean; motivo: string };

/**
 * get_escrow_detail → normalizacao 1:1 → gravacao, para um pedido da loja.
 * `definitivo` = nao adianta repetir (permanente, correspondencia quebrada,
 * pedido nao materializado); senao e transitorio (ja houve retry/backoff).
 */
export async function processarEscrowDePedido(sn: string, c: {
  userId: string; lojaId: string; api: ShopeeApi; repo: Repositorio; retry: OpcoesRetry; agoraIso: string;
}): Promise<ResultadoEscrow> {
  try {
    const ped = await c.repo.pedidoParaEscrow(c.userId, c.lojaId, sn);
    if (!ped) return { ok: false, definitivo: true, motivo: "pedido nao materializado" };
    const e = await comRetry(() => c.api.escrow(sn), c.retry);
    const n = normalizarEscrow(e, { userId: c.userId, lojaId: c.lojaId, agoraIso: c.agoraIso, updateTimeDoPedido: ped.updateTime, itensGravados: ped.itens });
    await c.repo.gravarEscrow(n.pedido, n.itens);
    return { ok: true };
  } catch (e) {
    // Correspondencia 1:1 quebrada: nao adivinhar — falha o financeiro do pedido.
    const definitivo = e instanceof ErroCorrespondenciaEscrow || tipoDe(e) === "permanente";
    return { ok: false, definitivo, motivo: `escrow: ${msgDe(e)}` };
  }
}

// ── CATCH-UP de escrow (S2-D2.1) ─────────────────────────────────────
//
// Varre a fila `escrow_pendente` de UMA loja (user_id + loja_id), em ordem
// de order_sn, em lotes pequenos, sem depender de o pedido reaparecer em
// get_order_list. Resumivel: o checkpoint guarda so o ultimo order_sn
// passado e mapas pequenos. NAO produz evidencia de listagem: o job de
// catch-up nao tem janela nem `listagem_completa` — o servico canonico
// continua exigindo cobertura de update_time E escrow atual.

export function checkpointCatchUpInicial(): CheckpointCatchUpEscrow {
  return { versao: 1, modo: "escrow_catchup", apos: null, varreduraTerminou: false, retentar: [], tentativas: {}, falhas: {} };
}

export type ResultadoCatchUp =
  | { estado: "desabilitado" }
  | { estado: "pausado" | "concluido" | "falhou"; motivo?: string; checkpoint: CheckpointCatchUpEscrow; progresso: ProgressoShopee };

export async function executarFatiaCatchUpEscrow(
  job: { id: string; userId: string; lojaId: string; checkpoint: CheckpointCatchUpEscrow | null; progresso: ProgressoShopee | null },
  deps: { api: ShopeeApi; repo: Repositorio; relogio: Relogio },
  opcoes: OpcoesMotor & { loteCatchUp?: number },
): Promise<ResultadoCatchUp> {
  if (!(opcoes.habilitado ?? ASYNC_SYNC_JOBS_ENABLED)) return { estado: "desabilitado" };
  const o = { ...PADROES, loteCatchUp: 50, ...opcoes, retry: opcoes.retry ?? RETRY_PADRAO };
  const { api, repo, relogio } = deps;
  const ck: CheckpointCatchUpEscrow = job.checkpoint ? structuredClone(job.checkpoint) : checkpointCatchUpInicial();
  const pr: ProgressoShopee = job.progresso ? structuredClone(job.progresso) : progressoInicial();
  const dono = { id: job.id, userId: job.userId, lojaId: job.lojaId };
  const salvar = (status: "rodando" | "concluido" | "erro", erroMensagem?: string | null) =>
    repo.salvarJob(dono, { checkpoint: ck, progresso: pr, status, ...(erroMensagem === undefined ? {} : { erroMensagem }) });
  const cabe = () => relogio.agoraMs() + o.margemMs < o.prazoMs;

  if (!(await repo.lojaDoDono(job.userId, job.lojaId))) {
    pr.ultimo_erro = "loja_invalida"; await salvar("erro", "loja_invalida");
    return { estado: "falhou", motivo: "loja_invalida", checkpoint: ck, progresso: pr };
  }

  const processar = async (sns: string[]) => {
    const agoraIso = new Date(relogio.agoraMs()).toISOString();
    let progrediu = false; let transitorio: string | null = null;
    for (let i = 0; i < sns.length; i += o.concorrenciaEscrow) {
      await Promise.all(sns.slice(i, i + o.concorrenciaEscrow).map(async (sn) => {
        pr.escrow_necessarios++;
        const r = await processarEscrowDePedido(sn, { userId: job.userId, lojaId: job.lojaId, api, repo, retry: o.retry, agoraIso });
        if (r.ok) { pr.escrow_concluidos++; progrediu = true; ck.retentar = ck.retentar.filter((x) => x !== sn); delete ck.tentativas[sn]; return; }
        if (r.definitivo) { ck.falhas[sn] = r.motivo; pr.escrow_falhos++; ck.retentar = ck.retentar.filter((x) => x !== sn); delete ck.tentativas[sn]; return; }
        transitorio = r.motivo;
        ck.tentativas[sn] = (ck.tentativas[sn] ?? 0) + 1;
        if (ck.tentativas[sn] >= o.maxTentativasPorPedido) {
          ck.falhas[sn] = r.motivo; pr.escrow_falhos++; ck.retentar = ck.retentar.filter((x) => x !== sn); delete ck.tentativas[sn];
        } else if (!ck.retentar.includes(sn)) ck.retentar.push(sn);
      }));
    }
    pr.ultimo_erro = transitorio ?? pr.ultimo_erro;
    return { progrediu, transitorio };
  };

  // 1) varredura da fila, em ordem de order_sn
  while (!ck.varreduraTerminou) {
    if (!cabe()) { await salvar("rodando"); return { estado: "pausado", motivo: "prazo", checkpoint: ck, progresso: pr }; }
    const lote = await repo.pendentesEscrow(job.userId, job.lojaId, ck.apos, o.loteCatchUp);
    // falhas definitivas continuam pendentes no banco: pular, nao repetir
    const aProcessar = lote.filter((sn) => !(sn in ck.falhas));
    if (lote.length === 0) { ck.varreduraTerminou = true; break; }
    await processar(aProcessar);
    ck.apos = lote[lote.length - 1];
    await salvar("rodando");
  }
  // 2) repete os transitorios (limite por pedido)
  while (ck.retentar.length > 0) {
    if (!cabe()) { await salvar("rodando"); return { estado: "pausado", motivo: "prazo", checkpoint: ck, progresso: pr }; }
    const r = await processar([...ck.retentar]);
    await salvar("rodando");
    if (r.transitorio && !r.progrediu && ck.retentar.length > 0) return { estado: "pausado", motivo: r.transitorio, checkpoint: ck, progresso: pr };
  }
  await salvar("concluido", null);
  return { estado: "concluido", checkpoint: ck, progresso: pr };
}
