/**
 * Suite do motor de ingestao Shopee — CDS-STABILIZATION S2-D2.
 *
 * Tudo com fakes deterministicos (scripts/fakes/shopee-ingestao-fake.ts):
 * nenhuma chamada Shopee real, nenhum token, nenhum banco.
 *
 * Cobertura: 1.300 pedidos em 13+ paginas, cursor ate o fim, lotes de
 * detail, multi-item, cancelado depois do pagamento, pedido criado muito
 * antes do pagamento, update posterior, detail ausente, escrow ausente,
 * rate limit, erro transitorio, erro permanente, erro de paginacao, corrida
 * durante a paginacao, retomada por checkpoint em LIST/DETAIL/ESCROW,
 * lojas/donos, janela futura, flag, create_time sem prova, adaptador
 * Supabase (formato das consultas).
 *
 * As metricas finais sao conferidas pelo SERVICO CANONICO (a unica formula)
 * contra valores esperados calculados aqui, de forma independente.
 *
 * Uso: npx tsx scripts/testar-shopee-ingestao.ts
 */
import "./_server-only-inerte";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ErroShopee, type CampoTempo, type CheckpointCatchUpEscrow, type CheckpointShopee } from "../lib/shopee/ingestao/tipos";
import { RelogioFake, RepoFake, ShopeeFake, type JobFake, type PedidoFake } from "./fakes/shopee-ingestao-fake";
import type { ItemShopeeCanonico, JanelaListagem, PedidoShopeeCanonico } from "../lib/vendas/canonico/shopee";

let passou = 0, falhou = 0;
let fila: Promise<void> = Promise.resolve();
function t(nome: string, fn: () => void | Promise<void>) {
  fila = fila.then(async () => {
    try { await fn(); passou++; console.log(`  PASS  ${nome}`); }
    catch (e: any) { falhou++; console.log(`  FALHA ${nome} -> ${e?.stack?.split("\n").slice(0, 2).join(" | ") ?? e}`); }
  });
}
function assert(c: unknown, m: string): asserts c { if (!c) throw new Error(m); }
const RAIZ = join(__dirname, "..");

// ── cenario base: dia D = 02/10/2026 em Sao Paulo ────────────────────
const UID = "user-a", LOJA = "11111111-1111-4111-8111-111111111111";
const D0 = Date.parse("2026-10-02T03:00:00Z") / 1000;  // 00:00 BRT
const D1 = Date.parse("2026-10-03T03:00:00Z") / 1000;  // 00:00 BRT do dia seguinte
const AGORA = Date.parse("2026-10-10T12:00:00Z");
const W1 = { inicio: "2026-10-01T00:00:00.000Z", fim: "2026-10-03T12:00:00.000Z" };
const W2 = { inicio: "2026-10-03T11:45:00.000Z", fim: "2026-10-09T00:00:00.000Z" };

/** Pedidos variados: pagos em D, nao pagos, cancelados depois, TO_RETURN, criados ate 30d antes, multi-item. */
function gerar(n: number, prefixo = "S"): PedidoFake[] {
  const out: PedidoFake[] = [];
  for (let i = 0; i < n; i++) {
    const naoPago = i % 29 === 7;
    const pay = naoPago ? null : D0 + ((i * 61) % 86400);
    const create = pay === null ? D0 + (i % 86000) : pay - (i % 17 === 0 ? 30 * 86400 : i % 13 === 0 ? 10 * 86400 : 60 * (i % 30));
    const status = naoPago ? "UNPAID" : i % 23 === 0 ? "CANCELLED" : i % 41 === 0 ? "TO_RETURN" : ["SHIPPED", "COMPLETED", "TO_CONFIRM_RECEIVE", "PROCESSED"][i % 4];
    const nItens = i % 7 === 0 ? 3 : 1;
    const itens = Array.from({ length: nItens }, (_, k) => ({
      itemId: `I${i}_${k}`, modelId: k % 2 === 0 ? `M${k}` : null, preco: 10 + (i % 13) + 0.99, qtd: 1 + (i % 3 === 0 ? 1 : 0),
      vs: i % 5 === 0 ? 2.5 : 0, vsh: i % 11 === 0 ? 1.25 : 0, coin: i % 9 === 0 ? 0.37 : 0,
    }));
    out.push({ orderSn: `${prefixo}${String(i).padStart(5, "0")}`, createTime: create, updateTime: (pay ?? create) + 300, payTime: pay, status,
      totalAmount: 99, osd: i % 6 === 0 ? 3.1 : 0, pix: i % 4 === 0 ? 0.6 : 0, itens });
  }
  return out;
}

/** Metricas esperadas para D, calculadas aqui (independente do servico). */
function esperado(pedidos: PedidoFake[]) {
  const pagos = pedidos.filter((p) => p.payTime !== null && p.payTime >= D0 && p.payTime < D1);
  let itens = 0, vs = 0, vsh = 0, coin = 0, osd = 0, pix = 0, unid = 0;
  for (const p of pagos) {
    osd += Math.round(p.osd * 100); pix += Math.round(p.pix * 100);
    for (const i of p.itens) { itens += Math.round(i.preco * i.qtd * 100); vs += Math.round(i.vs * 100); vsh += Math.round(i.vsh * 100); coin += Math.round(i.coin * 100); unid += i.qtd; }
  }
  return { pedidos: pagos.length, cancelados: pagos.filter((p) => p.status === "CANCELLED").length, unidades: unid,
    vendas: (itens - vs + osd - pix) / 100, vendasSemDescontosPlataforma: (itens - vs - vsh - coin) / 100 };
}

function cenario(pedidos: PedidoFake[], lojas = [{ id: LOJA, user_id: UID }]) {
  const relogio = new RelogioFake(AGORA);
  const api = new ShopeeFake(relogio, pedidos);
  const repo = new RepoFake(); repo.lojas = lojas;
  const dormidas: number[] = [];
  const retry = { tentativas: 3, baseMs: 10, dormir: async (ms: number) => { dormidas.push(ms); } };
  return { relogio, api, repo, dormidas, retry };
}

type Cen = ReturnType<typeof cenario>;
let seq = 0;
async function rodarJob(c: Cen, M: typeof import("../lib/shopee/ingestao/motor"), j: { campoTempo?: CampoTempo; inicio: string; fim: string; userId?: string; lojaId?: string; api?: ShopeeFake },
  o: { fatiaMs?: number; maxFatias?: number; concorrenciaEscrow?: number } = {}) {
  const id = `job-${++seq}`;
  const userId = j.userId ?? UID, lojaId = j.lojaId ?? LOJA;
  c.repo.criarJob({ id, userId, lojaId, campoTempo: j.campoTempo ?? "update_time", inicio: j.inicio, fim: j.fim });
  const fasesPausa: string[] = []; let res: Awaited<ReturnType<typeof M.executarFatiaShopee>> | null = null; let fatias = 0;
  for (; fatias < (o.maxFatias ?? 5000); ) {
    const r = c.repo.jobs.get(id)!;
    fatias++;
    res = await M.executarFatiaShopee({ id, userId, lojaId, campoTempo: r.campo_tempo!, janelaInicio: r.janela_inicio!, janelaFim: r.janela_fim!, checkpoint: r.checkpoint as CheckpointShopee | null, progresso: r.progresso },
      { api: j.api ?? c.api, repo: c.repo, relogio: c.relogio },
      { prazoMs: c.relogio.agoraMs() + (o.fatiaMs ?? 10_000_000), margemMs: 0, habilitado: true, retry: c.retry, concorrenciaEscrow: o.concorrenciaEscrow ?? 4 });
    if (res.estado === "pausado") { fasesPausa.push(res.checkpoint.fase); continue; }
    break;
  }
  // job de LISTAGEM: o checkpoint e o do motor de listagem (nao o do catch-up)
  return { id, res: res!, fatias, fasesPausa, job: c.repo.jobs.get(id)! as Omit<JobFake, "checkpoint"> & { checkpoint: CheckpointShopee | null } };
}

/** Repo → entradas do servico canonico. */
function paraCanonico(repo: RepoFake) {
  const pedidos: PedidoShopeeCanonico[] = [...repo.pedidos.values()].map((p: any) => ({
    lojaId: p.loja_id, orderSn: p.order_sn, orderStatus: p.order_status, payTime: p.pay_time, updateTime: p.update_time,
    detailFetchedAt: p.detail_fetched_at ?? null, escrowFetchedAt: p.escrow_fetched_at ?? null, escrowUpdateTime: p.escrow_update_time ?? null,
    originalShopeeDiscount: p.original_shopee_discount ?? null, pixDiscount: p.pix_discount ?? null }));
  const itens: ItemShopeeCanonico[] = [...repo.itens.values()].map((i: any) => ({
    lojaId: i.loja_id, orderSn: i.order_id, precoUnitario: i.valor_unit, quantidade: i.qtd,
    voucherVendedor: i.escrow_voucher_seller ?? null, voucherShopee: i.escrow_voucher_shopee ?? null, moedas: i.escrow_coin ?? null }));
  // como o leitor real: so jobs COM janela (catch-up de escrow nao tem)
  const janelas: JanelaListagem[] = [...repo.jobs.values()].filter((j) => j.janela_inicio !== null).map((j) => ({ lojaId: j.loja_id, campoTempo: j.campo_tempo!,
    inicio: j.janela_inicio!, fim: j.janela_fim!, listagemCompleta: j.listagem_completa, status: j.status }));
  return { pedidos, itens, janelas };
}

async function principal() {
  const M = await import("../lib/shopee/ingestao/motor");
  const C = await import("../lib/vendas/canonico/shopee");
  const N = await import("../lib/shopee/ingestao/normalizar");
  const J = await import("../lib/shopee/ingestao/janelas");
  const dia = C.intervaloSaoPaulo("2026-10-02", "2026-10-02");
  // DISCOVERY_ANCHOR do cenario: nenhum pedido do fake e criado antes dela.
  const ANCORA_T = new Date("2026-08-01T00:00:00.000Z");
  const canonico = (repo: RepoFake, ancora: Date | null = ANCORA_T) => {
    const { pedidos, itens, janelas } = paraCanonico(repo);
    const pagos = C.filtrarPagosNoIntervalo(pedidos, dia.inicio, dia.fim);
    const f = dia.fim.getTime();
    const naoPagos = [...repo.pedidos.values()].filter((p: any) => p.pay_time === null && Date.parse(p.create_time) < f
      && !(p.detail_fetched_at && Date.parse(p.detail_fetched_at) >= f)).length;
    const comp = C.avaliarCompletudeShopee({ ...dia, janelas, ancoraDescoberta: ancora, pedidosPagos: pagos, itens, naoPagosSemObservacaoPosPeriodo: naoPagos });
    return { comp, metricas: comp.completude === "COMPLETE" ? C.calcularMetricasShopee(pagos, itens).metricas : null, pagos };
  };
  /** Corpus por create_time da ancora ate `ate` (blocos de 14 dias, janelas fechadas). */
  const rodarCorpus = async (c: Cen, ate = "2026-10-04T00:00:00.000Z", api?: ShopeeFake, de: Date = ANCORA_T) => {
    for (const j of J.planejarJanelasCriacao(de, new Date(ate))) {
      const r = await rodarJob(c, M, { campoTempo: "create_time", inicio: j.inicio.toISOString(), fim: j.fim.toISOString(), api });
      assert(r.res.estado === "concluido", `corpus ${j.inicio.toISOString()}: ${JSON.stringify(r.res)}`);
    }
  };

  console.log("\n[1. fluxo completo: 1.300 pedidos, paginas, lotes, multi-item]");
  const base = gerar(1300);
  t("1a. LIST pagina ate o fim (14 paginas), DETAIL e ESCROW concluem; listagem_completa so no fim", async () => {
    const c = cenario(base);
    const r1 = await rodarJob(c, M, W1);
    assert(r1.res.estado === "concluido", JSON.stringify(r1.res));
    assert(r1.job.listagem_completa === true && r1.job.status === "concluido", `${r1.job.listagem_completa} ${r1.job.status}`);
    assert(r1.job.progresso!.paginas === 13 && r1.job.progresso!.listados === 1300, JSON.stringify(r1.job.progresso));
    assert(c.repo.pedidos.size === 1300, `pedidos ${c.repo.pedidos.size}`);
    const pagos = base.filter((p) => p.payTime !== null).length;
    assert(c.api.chamadas.escrow === pagos && r1.job.progresso!.escrow_concluidos === pagos, `escrow ${c.api.chamadas.escrow}/${pagos}`);
    assert(c.api.chamadas.detalhes === 26, `detail chamadas ${c.api.chamadas.detalhes} (lotes de 50)`);
  });
  t("1b. a cadeia W1+W2 de update_time sozinha NAO da COMPLETE; com o corpus create_time da ancora, COMPLETE e metricas exatas", async () => {
    const c = cenario(base);
    await rodarJob(c, M, W1); await rodarJob(c, M, W2);
    assert(canonico(c.repo).comp.completude !== "COMPLETE", "update_time provou descoberta");
    await rodarCorpus(c);
    const { comp, metricas } = canonico(c.repo);
    assert(comp.completude === "COMPLETE", JSON.stringify(comp));
    assert(JSON.stringify(metricas) === JSON.stringify(esperado(base)), `${JSON.stringify(metricas)} != ${JSON.stringify(esperado(base))}`);
  });
  t("1c. valores de PEDIDO ficam UMA vez em shopee_pedidos; itens nao recebem osd/pix/total", async () => {
    const c = cenario(base);
    await rodarJob(c, M, W1);
    for (const i of c.repo.itens.values()) for (const k of ["original_shopee_discount", "pix_discount", "total_amount", "osd", "pix"]) assert(!(k in i), `item com ${k}`);
    const somaOsd = [...c.repo.pedidos.values()].reduce((s: number, p: any) => s + Math.round((p.original_shopee_discount ?? 0) * 100), 0);
    const esperadoOsd = base.filter((p) => p.payTime !== null).reduce((s, p) => s + Math.round(p.osd * 100), 0);
    assert(somaOsd === esperadoOsd, `${somaOsd} != ${esperadoOsd}`);
  });

  console.log("\n[2. erro de paginacao (pagina 3)]");
  t("2a. paginas 1-2 OK, pagina 3 ERRO: listagem_completa=false, nao 'zero pedidos', checkpoint preservado; retomada termina certo", async () => {
    const c = cenario(base);
    let falhar = true;
    c.api.onListar = (n) => (falhar && n >= 3 ? new ErroShopee("transitorio", "pagina 3 fora") : undefined);
    const r = await rodarJob(c, M, W1, { maxFatias: 1 });
    assert(r.res.estado === "pausado", r.res.estado);
    assert(r.job.listagem_completa === false && r.job.status === "rodando", `${r.job.listagem_completa} ${r.job.status}`);
    assert(r.job.checkpoint!.paginasLidas === 2 && r.job.checkpoint!.cursor !== null && !r.job.checkpoint!.listagemTerminou, JSON.stringify(r.job.checkpoint).slice(0, 200));
    assert(r.job.progresso!.listados === 200 && r.job.checkpoint!.pendentesDetalhe.length === 200, "nao preservou os 200 ja listados");
    assert(r.job.progresso!.erros_listagem === 1, "erro nao registrado");
    assert(c.dormidas.length === 2, `retries ${c.dormidas.length}`);
    falhar = false;
    // retoma o MESMO job
    const id = r.id;
    for (let k = 0; k < 50; k++) {
      const j = c.repo.jobs.get(id)!;
      const res = await M.executarFatiaShopee({ id, userId: UID, lojaId: LOJA, campoTempo: "update_time", janelaInicio: j.janela_inicio!, janelaFim: j.janela_fim!, checkpoint: j.checkpoint as CheckpointShopee | null, progresso: j.progresso },
        { api: c.api, repo: c.repo, relogio: c.relogio }, { prazoMs: c.relogio.agoraMs() + 1e9, margemMs: 0, habilitado: true, retry: c.retry });
      if (res.estado !== "pausado") break;
    }
    const j = c.repo.jobs.get(id)!;
    assert(j.status === "concluido" && j.listagem_completa === true && c.repo.pedidos.size === 1300, `${j.status} ${j.listagem_completa} ${c.repo.pedidos.size}`);
  });
  t("2c. listagem_completa NUNCA vira true antes do ultimo cursor (historico de todas as gravacoes)", async () => {
    const c = cenario(base);
    const r = await rodarJob(c, M, W1, { fatiaMs: 400 });
    const h = r.job.historicoListagem;
    assert(h.length > 3 && h.some((x) => x.completa), JSON.stringify(h.slice(0, 5)));
    const cedo = h.filter((x) => x.completa && !x.terminou);
    assert(cedo.length === 0, `true antes do fim em ${JSON.stringify(cedo[0])}`);
    assert(h.filter((x) => x.completa).every((x) => x.paginas === 13), "true com paginas faltando");
  });
  t("2b. erro PERMANENTE de paginacao: job falha, listagem_completa=false", async () => {
    const c = cenario(gerar(300));
    c.api.onListar = (n) => (n === 2 ? new ErroShopee("permanente", "error_param") : undefined);
    const r = await rodarJob(c, M, W1);
    assert(r.res.estado === "falhou" && r.job.listagem_completa === false && r.job.status === "erro", `${r.res.estado} ${r.job.listagem_completa}`);
  });

  console.log("\n[3. detail parcial]");
  t("3a. pede 50, vem 49 (sempre): 49 gravados, 1 explicitamente falho; job erro; janela NAO prova", async () => {
    const ps = gerar(60);
    const c = cenario(ps);
    c.api.omitirDetalhe.set("S00007", Infinity);
    const r1 = await rodarJob(c, M, W1); await rodarJob(c, M, W2);
    assert(c.repo.pedidos.size === 59 && !c.repo.pedidos.has(`${LOJA}|S00007`), `gravados ${c.repo.pedidos.size}`);
    assert(r1.job.checkpoint!.falhasDetalhe.join() === "S00007" && r1.job.progresso!.detail_falhos === 1, JSON.stringify(r1.job.checkpoint!.falhasDetalhe));
    assert(r1.res.estado === "falhou" && r1.job.status === "erro" && r1.job.listagem_completa === true, `${r1.res.estado} ${r1.job.status}`);
    assert(canonico(c.repo).comp.completude !== "COMPLETE", "pedido listado faltando nao pode dar COMPLETE");
  });
  t("3b. omissao transitoria (1 vez): o pedido volta na rodada seguinte e o job conclui", async () => {
    const c = cenario(gerar(60));
    c.api.omitirDetalhe.set("S00007", 1);
    const r = await rodarJob(c, M, W1);
    assert(r.res.estado === "concluido" && c.repo.pedidos.size === 60 && r.job.progresso!.detail_falhos === 0, `${r.res.estado} ${c.repo.pedidos.size}`);
  });

  console.log("\n[4. escrow parcial]");
  t("4a. 100 pagos, 99 escrow OK, 1 falha: 99 com escrow, 1 incompleto, periodo PARTIAL e total nulo", async () => {
    const ps = gerar(110).filter((p) => p.payTime !== null).slice(0, 100);
    const c = cenario(ps);
    c.api.onEscrow = (sn) => (sn === ps[42].orderSn ? new ErroShopee("permanente", "escrow indisponivel") : undefined);
    await rodarJob(c, M, W1); await rodarJob(c, M, W2);
    const comEscrow = [...c.repo.pedidos.values()].filter((p: any) => p.escrow_fetched_at).length;
    assert(c.repo.pedidos.size === 100 && comEscrow === 99, `${c.repo.pedidos.size} ${comEscrow}`);
    const { comp, metricas } = canonico(c.repo);
    assert(comp.completude === "PARTIAL" && metricas === null && comp.motivos.some((m) => m.startsWith("escrow_ausente")), JSON.stringify(comp));
  });

  console.log("\n[5. multi-item]");
  t("5a. pedido com 3 itens (osd 10, pix 2): pedido guarda 10 e 2 uma vez; Vendas nao multiplica por 3", async () => {
    const p: PedidoFake = { orderSn: "MULTI", createTime: D0 + 100, updateTime: D0 + 400, payTime: D0 + 200, status: "SHIPPED", totalAmount: 70, osd: 10, pix: 2,
      itens: [{ itemId: "A", modelId: "1", preco: 10, qtd: 2, vs: 1, vsh: 0.5, coin: 0.25 }, { itemId: "B", modelId: null, preco: 20, qtd: 1, vs: 1, vsh: 0.5, coin: 0.25 },
        { itemId: "C", modelId: "0", preco: 5, qtd: 3, vs: 1, vsh: 0.5, coin: 0.25 }] };
    const c = cenario([p]);
    await rodarCorpus(c);
    const ped: any = c.repo.pedidos.get(`${LOJA}|MULTI`);
    assert(ped.original_shopee_discount === 10 && ped.pix_discount === 2, JSON.stringify(ped));
    assert(c.repo.itens.size === 3 && [...c.repo.itens.keys()].some((k) => k.endsWith("_C_0")), [...c.repo.itens.keys()].join());
    const { metricas } = canonico(c.repo);
    assert(metricas!.vendas === 55 - 3 + 10 - 2 && metricas!.vendasSemDescontosPlataforma === 55 - 3 - 1.5 - 0.75 && metricas!.pedidos === 1, JSON.stringify(metricas));
  });

  console.log("\n[6. cancelamento depois do pagamento]");
  t("6a. SHIPPED pago em D → depois CANCELLED com update posterior: mesma linha, mesmo pay_time, status novo, escrow refeito, continua em D", async () => {
    const p: PedidoFake = { orderSn: "CANC", createTime: D0 + 100, updateTime: D0 + 400, payTime: D0 + 200, status: "SHIPPED", totalAmount: 30, osd: 1, pix: 0,
      itens: [{ itemId: "A", modelId: null, preco: 30, qtd: 1, vs: 0, vsh: 0, coin: 0 }] };
    const c = cenario([p]);
    await rodarJob(c, M, W1);
    const antes: any = structuredClone(c.repo.pedidos.get(`${LOJA}|CANC`));
    const escAntes = c.api.chamadas.escrow;
    const novo = c.api.pedidos.get("CANC")!; novo.status = "CANCELLED"; novo.updateTime = Date.parse("2026-10-05T10:00:00Z") / 1000; novo.osd = 0;
    await rodarJob(c, M, W2);
    const depois: any = c.repo.pedidos.get(`${LOJA}|CANC`);
    assert(c.repo.pedidos.size === 1 && depois.pay_time === antes.pay_time, "linha duplicada ou pay_time mudou");
    assert(depois.order_status === "CANCELLED" && depois.escrow_update_time === depois.update_time && depois.update_time !== antes.update_time, JSON.stringify(depois));
    assert(c.api.chamadas.escrow === escAntes + 1 && depois.original_shopee_discount === 0, "escrow nao refeito");
    await rodarCorpus(c);
    const { metricas } = canonico(c.repo);
    assert(metricas!.pedidos === 1 && metricas!.cancelados === 1, JSON.stringify(metricas));
  });
  t("6b. escrow NAO e refeito se o pedido nao mudou (escrow_update_time == update_time)", async () => {
    const c = cenario(gerar(40));
    await rodarJob(c, M, W1);
    const antes = c.api.chamadas.escrow;
    await rodarJob(c, M, W1); // mesma janela de novo
    assert(c.api.chamadas.escrow === antes, `refez ${c.api.chamadas.escrow - antes}`);
    c.api.pedidos.get("S00001")!.updateTime += 60; // so ele muda
    await rodarJob(c, M, { inicio: W1.inicio, fim: "2026-10-04T00:00:00.000Z" });
    assert(c.api.chamadas.escrow === antes + 1, `esperava 1 refetch, vieram ${c.api.chamadas.escrow - antes}`);
  });

  console.log("\n[7. lojas e donos]");
  t("7a. mesmo order_sn em lojas de donos diferentes: duas ordens distintas, nada cruza", async () => {
    const LB = "22222222-2222-4222-8222-222222222222";
    const ps = gerar(5);
    const c = cenario(ps, [{ id: LOJA, user_id: UID }, { id: LB, user_id: "user-b" }]);
    const apiB = new ShopeeFake(c.relogio, ps);
    await rodarJob(c, M, W1); await rodarJob(c, M, { ...W1, userId: "user-b", lojaId: LB, api: apiB });
    assert(c.repo.pedidos.size === 10 && c.repo.pedidos.has(`${LOJA}|S00000`) && c.repo.pedidos.has(`${LB}|S00000`), `${c.repo.pedidos.size}`);
    for (const i of c.repo.itens.values()) assert((i.loja_id === LOJA) === (i.user_id === UID), "item cruzou dono/loja");
  });
  t("7b. MESMO dono, lojas A e B, order ABC / item 10 / model 20: as duas persistem, sem overwrite, move, conflito ou falha", async () => {
    const LB = "33333333-3333-4333-8333-333333333333";
    const mk = (osd: number, preco: number): PedidoFake => ({ orderSn: "ABC", createTime: D0 + 50, updateTime: D0 + 400, payTime: D0 + 100, status: "SHIPPED",
      totalAmount: preco, osd, pix: 0, itens: [{ itemId: "10", modelId: "20", preco, qtd: 1, vs: 0, vsh: 0, coin: 0 }] });
    const c = cenario([mk(1, 30)], [{ id: LOJA, user_id: UID }, { id: LB, user_id: UID }]);
    const apiB = new ShopeeFake(c.relogio, [mk(2, 55)]);
    const ra = await rodarJob(c, M, W1);
    const rb = await rodarJob(c, M, { ...W1, lojaId: LB, api: apiB });
    assert(ra.res.estado === "concluido" && rb.res.estado === "concluido", `${ra.res.estado} ${rb.res.estado} ${rb.job.erro_mensagem}`);
    assert(c.repo.pedidos.has(`${LOJA}|ABC`) && c.repo.pedidos.has(`${LB}|ABC`), "falta pedido de uma loja");
    const its = [...c.repo.itens.values()].filter((i) => i.order_id === "ABC");
    assert(its.length === 2, `itens ${its.length}`);
    const a = its.find((i) => i.loja_id === LOJA)!, b = its.find((i) => i.loja_id === LB)!;
    assert(a && b && a.id !== b.id, "ids iguais");
    assert(a.id === `${UID}_SHOPEE_ABC_10_20` && b.id === `${UID}_SHOPEE_L${LB}_ABC_10_20`, `${a.id} | ${b.id}`);
    assert(a.valor_unit === 30 && b.valor_unit === 55, "overwrite entre lojas");
    assert((c.repo.pedidos.get(`${LOJA}|ABC`) as any).original_shopee_discount === 1 && (c.repo.pedidos.get(`${LB}|ABC`) as any).original_shopee_discount === 2, "escrow cruzou loja");
    // re-sync das duas: idempotente, mesmos ids, nada duplica
    await rodarJob(c, M, W1); await rodarJob(c, M, { ...W1, lojaId: LB, api: apiB });
    assert([...c.repo.itens.values()].filter((i) => i.order_id === "ABC").length === 2, "duplicou no re-sync");
  });
  t("7b3. SO a fundacao (sem o indice de cutover): sync A, B, A, B → exatamente 2 linhas, uma por loja", async () => {
    const LB = "66666666-6666-4666-8666-666666666666";
    const mk = (preco: number): PedidoFake => ({ orderSn: "ABC", createTime: D0 + 50, updateTime: D0 + 400, payTime: D0 + 100, status: "SHIPPED",
      totalAmount: preco, osd: 0, pix: 0, itens: [{ itemId: "10", modelId: "20", preco, qtd: 1, vs: 0, vsh: 0, coin: 0 }] });
    const c = cenario([mk(30)], [{ id: LOJA, user_id: UID }, { id: LB, user_id: UID }]);
    c.repo.exigirIndiceUnicoPorLoja = false; // banco sem a chave unica: quem garante e o motor
    const apiB = new ShopeeFake(c.relogio, [mk(55)]);
    for (const [loja, api] of [[LOJA, c.api], [LB, apiB], [LOJA, c.api], [LB, apiB]] as const) {
      const r = await rodarJob(c, M, { ...W1, lojaId: loja, api });
      assert(r.res.estado === "concluido", `${loja}: ${r.res.estado}`);
    }
    const its = [...c.repo.itens.values()].filter((i) => i.order_id === "ABC" && i.ml_item_id === "10" && i.variation_id === "20");
    assert(its.length === 2, `linhas ${its.length}`);
    assert(its.filter((i) => i.loja_id === LOJA).length === 1 && its.filter((i) => i.loja_id === LB).length === 1, "nao e uma por loja");
    assert(its.find((i) => i.loja_id === LOJA)!.valor_unit === 30 && its.find((i) => i.loja_id === LB)!.valor_unit === 55, "overwrite entre lojas");
    assert(c.repo.pedidos.size === 2, `pedidos ${c.repo.pedidos.size}`);
  });
  t("7b2. a ordem nao importa: loja B sincronizada primeiro fica com o id legado; A recebe a variante — sem conflito", async () => {
    const LB = "44444444-4444-4444-8444-444444444444";
    const mk = (preco: number): PedidoFake => ({ orderSn: "ABC", createTime: D0 + 50, updateTime: D0 + 400, payTime: D0 + 100, status: "SHIPPED",
      totalAmount: preco, osd: 0, pix: 0, itens: [{ itemId: "10", modelId: "20", preco, qtd: 1, vs: 0, vsh: 0, coin: 0 }] });
    const c = cenario([mk(30)], [{ id: LOJA, user_id: UID }, { id: LB, user_id: UID }]);
    const rb = await rodarJob(c, M, { ...W1, lojaId: LB, api: new ShopeeFake(c.relogio, [mk(55)]) });
    const ra = await rodarJob(c, M, W1);
    assert(ra.res.estado === "concluido" && rb.res.estado === "concluido", "falhou");
    const its = [...c.repo.itens.values()];
    assert(its.length === 2 && its.find((i) => i.loja_id === LB)!.id === `${UID}_SHOPEE_ABC_10_20` && its.find((i) => i.loja_id === LOJA)!.id === `${UID}_SHOPEE_L${LOJA}_ABC_10_20`, its.map((i) => i.id).join());
  });
  t("7c. loja que nao e do usuario: falha antes de qualquer chamada a Shopee", async () => {
    const c = cenario(gerar(5), [{ id: LOJA, user_id: "outro" }]);
    const r = await rodarJob(c, M, W1);
    assert(r.res.estado === "falhou" && (r.res as any).motivo === "loja_invalida" && c.api.chamadas.listar === 0, JSON.stringify(r.res).slice(0, 120));
  });

  console.log("\n[8. retomada por checkpoint]");
  t("8a. fatias minusculas pausam em LIST, DETAIL e ESCROW; resultado final identico ao sem interrupcao, sem duplicar", async () => {
    const ps = gerar(260);
    const a = cenario(ps); await rodarJob(a, M, W1, { fatiaMs: 1e9 });
    const b = cenario(ps); const rb = await rodarJob(b, M, W1, { fatiaMs: 400, concorrenciaEscrow: 2 });
    for (const f of ["LIST", "DETAIL", "ESCROW"]) assert(rb.fasesPausa.includes(f), `nao pausou em ${f}: ${[...new Set(rb.fasesPausa)]}`);
    const limpar = (m: Map<string, Record<string, unknown>>) => JSON.stringify([...m.entries()].sort().map(([k, v]) => [k, Object.fromEntries(Object.entries(v)
      .filter(([c]) => !/fetched_at|synced_at/.test(c)).sort())]));
    assert(limpar(a.repo.pedidos) === limpar(b.repo.pedidos), "shopee_pedidos diferente");
    assert(limpar(a.repo.itens) === limpar(b.repo.itens), "pedidos (itens) diferente");
    assert(rb.res.estado === "concluido" && b.repo.pedidos.size === 260, `${rb.res.estado} ${b.repo.pedidos.size}`);
  });

  console.log("\n[9. corrida durante a paginacao]");
  t("9a. pedido muda durante a pagina 2 da janela 1 e sai do intervalo: nao e perdido — entra no overlap da janela 2", async () => {
    const ps = gerar(300);
    const c = cenario(ps);
    const alvo = "S00250"; // estaria na pagina 3 de W1
    const w1 = { inicio: "2026-10-01T00:00:00.000Z", fim: "2026-10-03T12:00:00.000Z" };
    c.api.onListar = (n) => { if (n === 2) c.api.pedidos.get(alvo)!.updateTime = Date.parse("2026-10-03T12:00:00Z") / 1000 + 60; };
    await rodarJob(c, M, w1);
    assert(!c.repo.pedidos.has(`${LOJA}|${alvo}`), "fixture: o pedido devia ter escapado da janela 1");
    assert(canonico(c.repo).comp.completude !== "COMPLETE", "uma janela sozinha nao pode provar o dia");
    c.api.onListar = undefined;
    await rodarJob(c, M, { inicio: "2026-10-03T11:45:00.000Z", fim: "2026-10-04T00:00:00.000Z" });
    assert(c.repo.pedidos.has(`${LOJA}|${alvo}`), "PERDIDO: overlap nao recuperou");
    assert(canonico(c.repo).comp.completude !== "COMPLETE", "overlap de update_time virou prova");
    await rodarCorpus(c);
    const { comp, metricas } = canonico(c.repo);
    const exp = esperado([...c.api.pedidos.values()]);
    assert(comp.completude === "COMPLETE" && JSON.stringify(metricas) === JSON.stringify(exp), JSON.stringify(comp));
  });

  console.log("\n[10. rate limit / transitorio / permanente]");
  t("10a. rate limit 2x no detail e transitorio 1x no escrow: retry com backoff finito e sucesso", async () => {
    const c = cenario(gerar(20));
    c.api.onDetalhes = (n) => (n <= 2 ? new ErroShopee("rate_limit", "error_busy") : undefined);
    let escFalhou = false;
    c.api.onEscrow = () => { if (!escFalhou) { escFalhou = true; return new ErroShopee("transitorio", "error_server"); } };
    const r = await rodarJob(c, M, W1);
    assert(r.res.estado === "concluido" && c.repo.pedidos.size === 20, r.res.estado);
    assert(c.dormidas.length === 3 && c.dormidas[1] > c.dormidas[0], `backoff ${c.dormidas}`);
  });
  t("10b. retry e FINITO: transitorio permanente no escrow desiste do pedido apos o limite", async () => {
    const c = cenario(gerar(10).filter((p) => p.payTime !== null).slice(0, 3));
    c.api.onEscrow = (sn) => (sn === "S00001" ? new ErroShopee("transitorio", "sempre") : undefined);
    const r = await rodarJob(c, M, W1);
    assert(r.res.estado === "concluido" && "S00001" in r.job.checkpoint!.falhasEscrow, JSON.stringify(r.job.checkpoint!.falhasEscrow));
  });
  t("10c. escrow sem correspondencia 1:1 com o detail: nao adivinha, falha o financeiro do pedido", async () => {
    const ps = gerar(4).filter((p) => p.payTime !== null);
    const c = cenario(ps);
    c.api.escrowItens.set(ps[0].orderSn, [{ itemId: "OUTRO", modelId: null, voucherVendedor: 1, voucherShopee: 0, moedas: 0 }]);
    const r = await rodarJob(c, M, W1);
    const ped: any = c.repo.pedidos.get(`${LOJA}|${ps[0].orderSn}`);
    assert(/sem_par/.test(r.job.checkpoint!.falhasEscrow[ps[0].orderSn] ?? "") && !ped.escrow_fetched_at, JSON.stringify(r.job.checkpoint!.falhasEscrow));
  });

  console.log("\n[11. janela, flag e limites]");
  t("11a. janela pedida no futuro: o motor corta o fim no inicio da listagem (nunca cobre o futuro)", async () => {
    const c = cenario(gerar(5));
    const r = await rodarJob(c, M, { inicio: "2026-10-09T00:00:00.000Z", fim: "2026-10-11T00:00:00.000Z" });
    const ini = Date.parse(r.job.checkpoint!.listagemIniciadaEm!);
    assert(Date.parse(r.job.janela_fim!) <= ini && Date.parse(r.job.janela_fim!) === AGORA, `${r.job.janela_fim} vs ${r.job.checkpoint!.listagemIniciadaEm}`);
  });
  t("11b. janela acima do limite da API (14d) e recusada sem chamar a Shopee", async () => {
    const c = cenario(gerar(5));
    const r = await rodarJob(c, M, { inicio: "2026-09-01T00:00:00.000Z", fim: "2026-09-20T00:00:00.000Z" });
    assert(r.res.estado === "falhou" && c.api.chamadas.listar === 0, r.res.estado);
  });
  t("11c. flag padrao OFF: sem habilitado explicito o motor nao faz nada", async () => {
    const c = cenario(gerar(5)); c.repo.criarJob({ id: "j-off", userId: UID, lojaId: LOJA, campoTempo: "update_time", inicio: W1.inicio, fim: W1.fim });
    const r = await M.executarFatiaShopee({ id: "j-off", userId: UID, lojaId: LOJA, campoTempo: "update_time", janelaInicio: W1.inicio, janelaFim: W1.fim, checkpoint: null, progresso: null },
      { api: c.api, repo: c.repo, relogio: c.relogio }, { prazoMs: AGORA + 1e9 });
    assert(r.estado === "desabilitado" && c.api.chamadas.listar === 0 && c.repo.jobs.get("j-off")!.status === "pendente", r.estado);
  });
  t("11d. sem limite artificial de paginas; lote de detail 50; concorrencia configuravel", () => {
    const fonte = readFileSync(join(RAIZ, "lib/shopee/ingestao/motor.ts"), "utf8");
    assert(!/max(Paginas|_paginas|Pages)|paginasLidas\s*[<>]=?\s*\d/i.test(fonte), "limite de paginas");
    assert(M.PADROES.loteDetalhe === 50 && M.PADROES.tamanhoPagina === 100, JSON.stringify(M.PADROES));
  });

  console.log("\n[12. create_time: DESCOBERTA a partir da ancora (S2-D3-B2.1)]");
  t("12a. corpus create_time que NAO comeca na ancora (D-13) popula, mas o dia segue PARTIAL", async () => {
    const c = cenario(gerar(80));
    await rodarJob(c, M, { campoTempo: "create_time", inicio: "2026-09-19T00:00:00.000Z", fim: "2026-10-03T00:00:00.000Z" });
    await rodarJob(c, M, { campoTempo: "create_time", inicio: "2026-10-02T23:45:00.000Z", fim: "2026-10-09T00:00:00.000Z" });
    assert(c.repo.pedidos.size > 0, "nao populou");
    const { comp } = canonico(c.repo);
    assert(comp.completude === "PARTIAL" && comp.motivos.includes("descoberta_por_create_time_nao_provada"), JSON.stringify(comp));
  });
  t("12a2. corpus create_time da ancora ate depois do dia → COMPLETE; sem ancora → PARTIAL", async () => {
    const ps = gerar(80);
    const c = cenario(ps);
    await rodarCorpus(c);
    const { comp, metricas } = canonico(c.repo);
    assert(comp.completude === "COMPLETE" && JSON.stringify(metricas) === JSON.stringify(esperado(ps)), JSON.stringify(comp));
    assert(canonico(c.repo, null).comp.completude === "PARTIAL", "sem ancora deu COMPLETE");
  });
  t("12b. guard: o motor nao reintroduz completude por N dias nem por create_time", () => {
    for (const f of ["motor.ts", "janelas.ts", "normalizar.ts", "persistencia.ts", "transporte.ts", "retry.ts", "tipos.ts"]) {
      const s = readFileSync(join(RAIZ, "lib/shopee/ingestao", f), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
      assert(!/MARGEM_OPERACIONAL|LAG_MAXIMO|COMPLETE|PARTIAL|avaliarCompletude|watermark/.test(s), `${f} decide completude`);
    }
  });

  console.log("\n[13. planejamento de janelas]");
  t("13a. incremental: overlap de 15 min, nenhuma janela no futuro, <= 14 dias", () => {
    const js = J.planejarJanelasIncrementais(new Date("2026-09-01T00:00:00Z"), new Date("2026-10-05T00:00:00Z"));
    assert(js.length >= 3 && js[js.length - 1].fim.toISOString() === "2026-10-05T00:00:00.000Z", js.map((j) => j.fim.toISOString()).join());
    for (let i = 0; i < js.length; i++) {
      assert(js[i].fim.getTime() - js[i].inicio.getTime() <= J.JANELA_MAXIMA_MS, "janela > 14d");
      if (i > 0) assert(js[i - 1].fim.getTime() - js[i].inicio.getTime() === J.SOBREPOSICAO_MS, "sem overlap de 15 min");
    }
    assert(J.planejarJanelasIncrementais(new Date("2026-10-05T00:00:00Z"), new Date("2026-10-05T00:00:00Z")).length === 0, "cursor no presente");
  });
  t("13b. create_time: blocos contiguos de ate 14 dias", () => {
    const js = J.planejarJanelasCriacao(new Date("2026-05-01T00:00:00Z"), new Date("2026-06-15T00:00:00Z"));
    for (let i = 1; i < js.length; i++) assert(js[i].inicio.getTime() === js[i - 1].fim.getTime(), "buraco/overlap");
    assert(js[0].inicio.toISOString() === "2026-05-01T00:00:00.000Z" && js[js.length - 1].fim.toISOString() === "2026-06-15T00:00:00.000Z", "bordas");
  });

  console.log("\n[14. normalizacao]");
  t("14a. model_id 0/vazio = sem variacao (id ..._nv), chave de item identica a do sync atual", () => {
    assert(N.normalizarModelId(0) === null && N.normalizarModelId("0") === null && N.normalizarModelId("") === null && N.normalizarModelId("12") === "12", "modelId");
    assert(N.idItem("u", "SN", "I1", null) === "u_SHOPEE_SN_I1_nv" && N.idItem("u", "SN", "I1", "9") === "u_SHOPEE_SN_I1_9", "id");
  });
  t("14b. pedido nao pago: pay_time NULL e data_pagamento NULL (sem fallback)", () => {
    const n = N.normalizarDetalhe({ orderSn: "U", status: "UNPAID", createTime: D0 + 10, updateTime: D0 + 20, payTime: null, cancelBy: null, cancelReason: null, totalAmount: null,
      itens: [{ itemId: "A", modelId: null, nome: null, sku: null, precoDescontado: 5, precoOriginal: 9, quantidade: 1 }] }, { userId: UID, lojaId: LOJA, agoraIso: "x" });
    assert(n.pedido.pay_time === null && n.itens[0].data_pagamento === null && n.pedido.total_amount === null && n.itens[0].data_criacao === "2026-10-02", JSON.stringify(n.itens[0]));
  });

  console.log("\n[16. catch-up de escrow (sem relistagem)]");
  const rodarCatchUp = async (c: Cen, o: { fatiaMs?: number; lojaId?: string; userId?: string } = {}) => {
    const id = `cu-${++seq}`; const userId = o.userId ?? UID, lojaId = o.lojaId ?? LOJA;
    c.repo.criarJob({ id, userId, lojaId, campoTempo: null, inicio: null, fim: null });
    const pausas: number[] = []; let res: Awaited<ReturnType<typeof M.executarFatiaCatchUpEscrow>> | null = null;
    for (let k = 0; k < 5000; k++) {
      const j = c.repo.jobs.get(id)!;
      res = await M.executarFatiaCatchUpEscrow({ id, userId, lojaId, checkpoint: j.checkpoint as CheckpointCatchUpEscrow | null, progresso: j.progresso },
        { api: c.api, repo: c.repo, relogio: c.relogio },
        { prazoMs: c.relogio.agoraMs() + (o.fatiaMs ?? 1e9), margemMs: 0, habilitado: true, retry: c.retry, loteCatchUp: 7, concorrenciaEscrow: 3 });
      if (res.estado === "pausado") { pausas.push(k); continue; }
      break;
    }
    return { id, res: res!, pausas, job: c.repo.jobs.get(id)! };
  };
  /** Popula o banco so com DETAIL (escrow falha) e depois deixa o escrow disponivel. */
  const semEscrow = async (ps: PedidoFake[]) => {
    const c = cenario(ps);
    let bloquear = true;
    c.api.onEscrow = () => (bloquear ? new ErroShopee("permanente", "indisponivel") : undefined);
    await rodarCorpus(c);
    bloquear = false; c.api.onEscrow = undefined;
    const listarAntes = c.api.chamadas.listar;
    return { c, listarAntes };
  };
  t("16A. pedido pago sem escrow e NUNCA relistado: o catch-up acha e completa (0 chamadas de listagem)", async () => {
    const ps = gerar(40);
    const { c, listarAntes } = await semEscrow(ps);
    assert(canonico(c.repo).comp.completude === "PARTIAL", "fixture: devia estar sem escrow");
    const r = await rodarCatchUp(c);
    assert(r.res.estado === "concluido" && c.api.chamadas.listar === listarAntes, `${r.res.estado} listou ${c.api.chamadas.listar - listarAntes}`);
    const { comp, metricas } = canonico(c.repo);
    assert(comp.completude === "COMPLETE" && JSON.stringify(metricas) === JSON.stringify(esperado(ps)), JSON.stringify(comp));
  });
  t("16B. escrow antigo (escrow_update_time < update_time): refetch pelo catch-up", async () => {
    const c = cenario(gerar(10));
    await rodarJob(c, M, W1); await rodarJob(c, M, W2);
    const p: any = c.repo.pedidos.get(`${LOJA}|S00001`);
    p.update_time = new Date(Date.parse(p.update_time) + 60_000).toISOString(); // pedido mudou (detail mais novo)
    c.api.pedidos.get("S00001")!.osd = 7;
    const antes = c.api.chamadas.escrow;
    const r = await rodarCatchUp(c);
    assert(r.res.estado === "concluido" && c.api.chamadas.escrow === antes + 1, `chamadas ${c.api.chamadas.escrow - antes}`);
    assert(p.escrow_update_time === p.update_time && p.original_shopee_discount === 7, JSON.stringify(p));
  });
  t("16C. escrow atual (escrow_update_time == update_time): 0 chamadas", async () => {
    const c = cenario(gerar(30));
    await rodarJob(c, M, W1);
    const antes = c.api.chamadas.escrow;
    const r = await rodarCatchUp(c);
    assert(r.res.estado === "concluido" && c.api.chamadas.escrow === antes, `chamadas ${c.api.chamadas.escrow - antes}`);
  });
  t("16C2. A-F na fila do catch-up: so nunca-lido, escrow_update_time NULL e '<' sao refeitos", async () => {
    const c = cenario(gerar(30));
    await rodarJob(c, M, W1); await rodarJob(c, M, W2);
    const pagos = [...c.repo.pedidos.values()].filter((p: any) => p.pay_time).sort((a: any, b: any) => (a.order_sn < b.order_sn ? -1 : 1)) as any[];
    const naoPago = [...c.repo.pedidos.values()].find((p: any) => !p.pay_time) as any;
    assert(naoPago && pagos.length >= 5, "fixture");
    naoPago.escrow_fetched_at = null; naoPago.escrow_update_time = null;                                   // A → nao
    pagos[0].escrow_fetched_at = null; pagos[0].escrow_update_time = null;                                 // B → sim
    pagos[1].escrow_update_time = null;                                                                    // C → sim
    pagos[2].escrow_update_time = new Date(Date.parse(pagos[2].update_time) - 1000).toISOString();         // D → sim
    pagos[3].escrow_update_time = pagos[3].update_time;                                                    // E → nao
    pagos[4].escrow_update_time = new Date(Date.parse(pagos[4].update_time) + 1000).toISOString();         // F → nao
    const vistos: string[] = []; c.api.onEscrow = (sn) => { vistos.push(sn); return undefined; };
    const r = await rodarCatchUp(c);
    c.api.onEscrow = undefined;
    const esperado = [pagos[0], pagos[1], pagos[2]].map((p) => p.order_sn).sort();
    assert(r.res.estado === "concluido" && JSON.stringify([...vistos].sort()) === JSON.stringify(esperado), `refeitos ${JSON.stringify(vistos)}`);
  });
  t("16C3. NAO-LOOP: escrow_update_time (T2) > update_time (T1) → 0 chamadas de escrow em DUAS execucoes do catch-up", async () => {
    const c = cenario(gerar(20));
    await rodarJob(c, M, W1); await rodarJob(c, M, W2);
    for (const p of c.repo.pedidos.values() as any) if (p.pay_time) p.escrow_update_time = new Date(Date.parse(p.update_time) + 5 * 60_000).toISOString();
    const antes = c.api.chamadas.escrow;
    const r1 = await rodarCatchUp(c);
    assert(r1.res.estado === "concluido" && c.api.chamadas.escrow === antes, `1a: ${c.api.chamadas.escrow - antes}`);
    const r2 = await rodarCatchUp(c);
    assert(r2.res.estado === "concluido" && c.api.chamadas.escrow === antes, `2a: ${c.api.chamadas.escrow - antes}`);
  });
  t("16C4. NAO-LOOP na fase ESCROW do job: relistar a janela com escrow_update_time > update_time → 0 chamadas", async () => {
    const c = cenario(gerar(20));
    await rodarJob(c, M, W1);
    for (const p of c.repo.pedidos.values() as any) if (p.pay_time) p.escrow_update_time = new Date(Date.parse(p.update_time) + 5 * 60_000).toISOString();
    const antes = c.api.chamadas.escrow;
    await rodarJob(c, M, W1); await rodarJob(c, M, W1);
    assert(c.api.chamadas.escrow === antes, `refez ${c.api.chamadas.escrow - antes}`);
  });
  t("16C5. regra unica: motor e servico canonico usam escrowShopeeAtual; motor sem comparacao propria", () => {
    const motor = readFileSync(join(RAIZ, "lib/shopee/ingestao/motor.ts"), "utf8");
    assert(/escrowShopeeAtual\(/.test(motor) && !/getTime\(\) !== new Date/.test(motor), "motor com regra propria");
    const can = readFileSync(join(RAIZ, "lib/vendas/canonico/shopee.ts"), "utf8");
    assert((can.match(/escrowShopeeAtual\(/g) ?? []).length === 2, "servico canonico sem a regra unica");
  });
  t("16D. 1 de 100 falha transitoriamente: retry dentro do contrato e completa", async () => {
    const ps = gerar(120).filter((p) => p.payTime !== null).slice(0, 100);
    const { c } = await semEscrow(ps);
    let falhas = 0;
    c.api.onEscrow = (sn) => (sn === ps[50].orderSn && falhas++ < 4 ? new ErroShopee("transitorio", "error_server") : undefined);
    const r = await rodarCatchUp(c);
    const comEscrow = [...c.repo.pedidos.values()].filter((p: any) => p.escrow_fetched_at).length;
    assert(r.res.estado === "concluido" && comEscrow === 100 && Object.keys((r.job.checkpoint as CheckpointCatchUpEscrow).falhas).length === 0, `${comEscrow} ${JSON.stringify((r.job.checkpoint as any).falhas)}`);
  });
  t("16E. falha permanente: fica pendente/incompleto, periodo PARTIAL e sem total", async () => {
    const ps = gerar(20).filter((p) => p.payTime !== null);
    const { c } = await semEscrow(ps);
    c.api.onEscrow = (sn) => (sn === ps[3].orderSn ? new ErroShopee("permanente", "nao existe") : undefined);
    const r = await rodarCatchUp(c);
    const ck = r.job.checkpoint as CheckpointCatchUpEscrow;
    assert(r.res.estado === "concluido" && ps[3].orderSn in ck.falhas, JSON.stringify(ck.falhas));
    assert((await c.repo.pendentesEscrow(UID, LOJA, null, 100)).join() === ps[3].orderSn, "devia continuar pendente no banco");
    const { comp, metricas } = canonico(c.repo);
    assert(comp.completude === "PARTIAL" && metricas === null, JSON.stringify(comp));
  });
  t("16F. resume: fatias minusculas pausam e retomam, resultado igual ao sem interrupcao, sem duplicar chamadas", async () => {
    const ps = gerar(60).filter((p) => p.payTime !== null);
    const a = await semEscrow(ps); const ra = await rodarCatchUp(a.c);
    const b = await semEscrow(ps); const escAntes = b.c.api.chamadas.escrow; const rb = await rodarCatchUp(b.c, { fatiaMs: 400 });
    assert(ra.res.estado === "concluido" && rb.res.estado === "concluido" && rb.pausas.length > 3, `${rb.pausas.length} pausas`);
    const limpar = (m: Map<string, Record<string, unknown>>) => JSON.stringify([...m.entries()].sort().map(([k, v]) => [k, Object.fromEntries(Object.entries(v).filter(([c]) => !/fetched_at|synced_at/.test(c)).sort())]));
    assert(limpar(a.c.repo.pedidos) === limpar(b.c.repo.pedidos) && limpar(a.c.repo.itens) === limpar(b.c.repo.itens), "estado final diferente");
    assert(b.c.api.chamadas.escrow - escAntes === ps.length, `chamadas ${b.c.api.chamadas.escrow - escAntes} para ${ps.length} pedidos (duplicou?)`);
    const ck = rb.job.checkpoint as CheckpointCatchUpEscrow;
    assert(JSON.stringify(ck).length < 2000, "checkpoint guarda payload");
  });
  t("16G. catch-up e por LOJA: nunca toca outra loja/dono", async () => {
    const LB = "55555555-5555-4555-8555-555555555555";
    const ps = gerar(10).filter((p) => p.payTime !== null);
    const c = cenario(ps, [{ id: LOJA, user_id: UID }, { id: LB, user_id: "user-b" }]);
    c.api.onEscrow = () => new ErroShopee("permanente", "x");
    const apiB = new ShopeeFake(c.relogio, ps); apiB.onEscrow = () => new ErroShopee("permanente", "x");
    await rodarJob(c, M, W1); await rodarJob(c, M, { ...W1, userId: "user-b", lojaId: LB, api: apiB });
    assert([...c.repo.pedidos.values()].filter((p: any) => p.loja_id === LB).every((p: any) => !p.escrow_fetched_at), "fixture: B devia estar sem escrow");
    c.api.onEscrow = undefined; apiB.onEscrow = undefined;
    await rodarCatchUp(c, { lojaId: LOJA });
    assert([...c.repo.pedidos.values()].filter((p: any) => p.loja_id === LOJA).every((p: any) => p.escrow_fetched_at), "catch-up de A nao completou A");
    const b = [...c.repo.pedidos.values()].filter((p: any) => p.loja_id === LB);
    assert(b.length > 0 && b.every((p: any) => !p.escrow_fetched_at), "catch-up da loja A tocou a loja B");
  });
  t("16H. catch-up NAO e evidencia de listagem: sem corpus da ancora o dia segue PARTIAL", async () => {
    const ps = gerar(15).filter((p) => p.payTime !== null);
    const c = cenario(ps);
    c.api.onEscrow = () => new ErroShopee("permanente", "x");
    await rodarJob(c, M, { campoTempo: "create_time", inicio: "2026-09-20T00:00:00.000Z", fim: "2026-10-03T12:00:00.000Z" });
    c.api.onEscrow = undefined;
    const r = await rodarCatchUp(c);
    assert(r.res.estado === "concluido" && r.job.listagem_completa === null && r.job.janela_inicio === null, "catch-up virou janela");
    const { comp } = canonico(c.repo);
    assert(comp.completude === "PARTIAL" && comp.motivos.includes("descoberta_por_create_time_nao_provada"), JSON.stringify(comp));
  });
  t("16I. uma unica implementacao de escrow: fase ESCROW e catch-up usam processarEscrowDePedido", () => {
    const fonte = readFileSync(join(RAIZ, "lib/shopee/ingestao/motor.ts"), "utf8");
    assert((fonte.match(/api\.escrow\(/g) ?? []).length === 1 && (fonte.match(/normalizarEscrow\(/g) ?? []).length === 1, "escrow duplicado");
    assert((fonte.match(/processarEscrowDePedido\(sn, /g) ?? []).length === 2, "fase ESCROW e catch-up nao compartilham a rotina");
  });

  console.log("\n[15. adaptador Supabase: formato das consultas]");
  t("15a. toda consulta/escrita leva dono e loja; upserts nas chaves certas; job filtrado por dono/loja", async () => {
    const regs: { tabela: string; op: string; filtros: string[]; opcoes?: any }[] = [];
    const cliente: any = { from(tabela: string) {
      const r = { tabela, op: "select", filtros: [] as string[], opcoes: undefined as any }; regs.push(r);
      const c: any = new Proxy({}, { get(_a, p: string) {
        if (p === "then") return (ok: any) => ok({ data: [], error: null });
        if (p === "maybeSingle") return async () => ({ data: null, error: null });
        return (...args: any[]) => {
          if (["upsert", "update", "insert", "delete"].includes(p)) { r.op = p; r.opcoes = args[1]; }
          if (["eq", "neq", "in"].includes(p)) r.filtros.push(`${p}:${args[0]}`);
          return c;
        };
      } });
      return c;
    } };
    const P = await import("../lib/shopee/ingestao/persistencia");
    const repo = P.criarRepositorioSupabase(cliente);
    await repo.lojaDoDono(UID, LOJA);
    await repo.gravarDetalhes([{ user_id: UID, loja_id: LOJA, order_sn: "S" } as any],
      [{ id: "i", user_id: UID, loja_id: LOJA, order_id: "S", ml_item_id: "1", variation_id: null, marketplace: "Shopee" } as any]);
    await repo.pendentesEscrow(UID, LOJA, null, 10);
    await repo.estadoEscrow(UID, LOJA, ["S"]);
    await repo.pedidoParaEscrow(UID, LOJA, "S");
    await repo.gravarEscrow({ user_id: UID, loja_id: LOJA, order_sn: "S" } as any, [{ id: "i", user_id: UID, loja_id: LOJA } as any]);
    await repo.salvarJob({ id: "j", userId: UID, lojaId: LOJA }, { checkpoint: M.checkpointInicial(), progresso: M.progressoInicial() });
    const up = regs.filter((r) => r.op === "upsert");
    assert(up.find((r) => r.tabela === "shopee_pedidos")?.opcoes?.onConflict === "loja_id,order_sn", "onConflict pedido");
    assert(up.find((r) => r.tabela === "pedidos")?.opcoes?.onConflict === "id", "onConflict item");
    assert(!regs.some((r) => r.op === "delete"), "delete!");
    for (const r of regs.filter((r) => r.op !== "upsert")) {
      assert(r.filtros.includes("eq:user_id"), `${r.tabela}/${r.op} sem user_id: ${r.filtros}`);
      // unica consulta sem loja: "id legado ja ocupado?" — de proposito em
      // TODAS as lojas do dono (e o que impede reutilizar id de outra loja)
      const ocupados = r.tabela === "pedidos" && r.filtros.join() === "eq:user_id,in:id";
      if (r.tabela !== "lojas" && !ocupados) assert(r.filtros.some((f) => /:loja_id$/.test(f)), `${r.tabela}/${r.op} sem loja_id: ${r.filtros}`);
    }
    assert(regs.some((r) => r.tabela === "pedidos" && r.filtros.join() === "eq:user_id,in:id"), "consulta de id ocupado ausente");
    const pend = regs.find((r) => r.tabela === "shopee_pedidos" && r.filtros.includes("eq:escrow_pendente"));
    assert(pend && pend.filtros.includes("eq:user_id") && pend.filtros.includes("eq:loja_id"), `fila de escrow: ${pend?.filtros}`);
    const job = regs.find((r) => r.tabela === "sync_jobs")!;
    assert(["eq:id", "eq:user_id", "eq:loja_id", "eq:marketplace"].every((f) => job.filtros.includes(f)), job.filtros.join());
    assert(regs.find((r) => r.tabela === "lojas")!.filtros.join() === "eq:id,eq:user_id,eq:marketplace,eq:ativo", "lojaDoDono");
  });
  t("15b. checkpoint e progresso nao carregam segredo", () => {
    const s = JSON.stringify({ ...M.checkpointInicial(), ...M.progressoInicial() });
    assert(!/token|secret|partner_key|key/i.test(s), s);
  });

  console.log("\n[17. cursor POSICIONAL sobre conjunto mutavel (bug real do S2-D3-B2)]");
  // 1.000 pedidos pagos em D, todos na mesma janela de update_time.
  const mil = (): PedidoFake[] => Array.from({ length: 1000 }, (_, i) => {
    const cr = D0 + 60 + i * 80;
    return { orderSn: `M${String(i).padStart(4, "0")}`, createTime: cr, payTime: cr + 30, updateTime: cr + 300, status: "SHIPPED",
      totalAmount: 50, osd: i % 5 === 0 ? 1 : 0, pix: 0, itens: [{ itemId: `I${i}`, modelId: null, preco: 10 + (i % 7), qtd: 1 + (i % 2), vs: 0, vsh: 0, coin: 0 }] };
  });
  const JU = { inicio: "2026-10-02T03:00:00.000Z", fim: "2026-10-03T12:00:00.000Z" };
  /** Na leitura da 3a pagina (offset 200): 10 pedidos JA LIDOS mudam de status e saem da janela de update_time. */
  const mexerNaPagina3 = (c: Cen, campo: CampoTempo) => {
    const movidos: string[] = [];
    c.api.onListar = (_n, a) => {
      if (a.campoTempo !== campo || a.cursor !== "200" || movidos.length) return;
      const ord = [...c.api.pedidos.values()].sort((x, y) => x.updateTime - y.updateTime || x.orderSn.localeCompare(y.orderSn));
      for (const p of ord.slice(0, 10)) { p.updateTime = Date.parse(JU.fim) / 1000 + 3600; p.status = "TO_CONFIRM_RECEIVE"; movidos.push(p.orderSn); }
    };
    return movidos;
  };
  t("17a. update_time + cursor posicional: 10 pedidos ESTAVEIS pulados com 0 erro, cursor ate o fim e listagem_completa=true", async () => {
    const ps = mil(); const c = cenario(ps); c.api.cursorPosicional = true;
    const movidos = mexerNaPagina3(c, "update_time");
    const r = await rodarJob(c, M, JU);
    assert(movidos.length === 10, "fixture: mutacao nao ocorreu");
    assert(r.res.estado === "concluido" && r.job.listagem_completa === true && r.job.progresso!.erros_listagem === 0, JSON.stringify(r.job.progresso));
    const faltam = ps.filter((p) => !c.repo.pedidos.has(`${LOJA}|${p.orderSn}`));
    assert(faltam.length === 10 && faltam.every((p) => !movidos.includes(p.orderSn)), `faltam ${faltam.length}`);
  });
  t("17b. nem a janela sucessora com overlap recupera os ESTAVEIS pulados; o novo modelo NAO da DISCOVERY_COMPLETE", async () => {
    const ps = mil(); const c = cenario(ps); c.api.cursorPosicional = true;
    mexerNaPagina3(c, "update_time");
    await rodarJob(c, M, JU);
    c.api.onListar = undefined;
    await rodarJob(c, M, { inicio: "2026-10-03T11:45:00.000Z", fim: "2026-10-09T00:00:00.000Z" });
    assert(ps.filter((p) => !c.repo.pedidos.has(`${LOJA}|${p.orderSn}`)).length === 10, "fixture: o overlap recuperou");
    const { comp, metricas } = canonico(c.repo);
    assert(comp.completude !== "COMPLETE" && !comp.dimensoes.descoberta && metricas === null, JSON.stringify(comp));
    assert(comp.dimensoes.estado && comp.dimensoes.financeiro, "os 990 vistos deviam estar perfeitos (o falso COMPLETE real)");
  });
  t("17c. duas passagens iguais NAO sao prova (CONSISTENCY_CHECK apenas): mesmo conjunto 2x, ainda sem COMPLETE", async () => {
    const ps = mil(); const c = cenario(ps); c.api.cursorPosicional = true;
    mexerNaPagina3(c, "update_time");
    await rodarJob(c, M, JU); c.api.onListar = undefined;
    await rodarJob(c, M, JU); await rodarJob(c, M, JU); // repassagens estaveis da mesma janela
    assert(canonico(c.repo).comp.completude !== "COMPLETE", "duas passagens viraram prova");
  });

  console.log("\n[18. create_time: a mesma mutacao nao muda a populacao da janela]");
  t("18a. create_time + cursor posicional + mesma mudanca de status: corpus completo (1.000) e COMPLETE com metricas exatas", async () => {
    const ps = mil(); const c = cenario(ps); c.api.cursorPosicional = true;
    const movidos = mexerNaPagina3(c, "create_time");
    await rodarCorpus(c);
    assert(movidos.length === 10, "fixture: mutacao nao ocorreu durante a listagem por create_time");
    assert(ps.every((p) => c.repo.pedidos.has(`${LOJA}|${p.orderSn}`)), "create_time perdeu pedido");
    const { comp, metricas } = canonico(c.repo);
    assert(comp.completude === "COMPLETE" && JSON.stringify(metricas) === JSON.stringify(esperado([...c.api.pedidos.values()])), JSON.stringify(comp));
  });
  t("18b. janela de create_time ABERTA (fim no futuro) e fechada pelo motor no inicio da listagem", async () => {
    const c = cenario(mil());
    const r = await rodarJob(c, M, { campoTempo: "create_time", inicio: "2026-10-01T00:00:00.000Z", fim: "2026-10-12T00:00:00.000Z" });
    assert(Date.parse(r.job.janela_fim!) <= AGORA + 10_000 && Date.parse(r.job.janela_fim!) < Date.parse("2026-10-12T00:00:00.000Z"), r.job.janela_fim!);
  });

  console.log("\n[19. bordas de create_time: [time_from, time_to] AMBOS inclusivos (S2-D3-B2.3)]");
  // pedido criado em `cr` (s), pago em D: atraso longo e proposital (criado meses antes)
  const naBorda = (sn: string, cr: number): PedidoFake => ({ orderSn: sn, createTime: cr, payTime: D0 + 3600, updateTime: D0 + 7200, status: "SHIPPED",
    totalAmount: 20, osd: 0, pix: 0, itens: [{ itemId: `I${sn}`, modelId: null, preco: 20, qtd: 1, vs: 0, vsh: 0, coin: 0 }] });
  t("19a. planner: blocos <= 14 dias, borda COMPARTILHADA (fim[i] === inicio[i+1]), sem lacuna, cobrindo [de, ate]", () => {
    assert(J.SEMANTICA_INTERVALO_API === "AMBOS_INCLUSIVOS" && J.ESTRATEGIA_BORDA === "BORDA_COMPARTILHADA_COM_DEDUP", "semantica");
    for (const [de, ate] of [["2026-03-01T00:00:00.000Z", "2026-10-04T00:00:00.000Z"], ["2026-03-01T00:00:00.500Z", "2026-03-29T00:00:00.250Z"], ["2026-01-01T00:00:00.000Z", "2026-01-15T00:00:00.000Z"]]) {
      const js = J.planejarJanelasCriacao(new Date(de), new Date(ate));
      assert(js[0].inicio.toISOString() === de && js[js.length - 1].fim.toISOString() === ate, `${de}: extremos`);
      for (let i = 0; i < js.length; i++) {
        assert(js[i].fim.getTime() - js[i].inicio.getTime() <= J.JANELA_MAXIMA_MS && js[i].fim > js[i].inicio, `${de}: tamanho ${i}`);
        if (i > 0) assert(js[i].inicio.getTime() === js[i - 1].fim.getTime(), `${de}: borda ${i} nao compartilhada`);
        // com milissegundos, o Math.floor do transporte leva as duas pontas ao mesmo segundo: nunca lacuna
        if (i > 0) assert(Math.floor(js[i].inicio.getTime() / 1000) <= Math.floor(js[i - 1].fim.getTime() / 1000), `${de}: lacuna de segundo ${i}`);
      }
    }
  });
  t("19b. pedido EXATAMENTE na borda, borda-1s e borda+1s: os tres no corpus, uma vez cada; o da borda listado 2x e gravado 1x", async () => {
    const js = J.planejarJanelasCriacao(ANCORA_T, new Date("2026-10-04T00:00:00.000Z"));
    const b = js[1].fim.getTime() / 1000; // borda entre a 2a e a 3a janela
    const ps = [naBorda("BMENOS", b - 1), naBorda("BIGUAL", b), naBorda("BMAIS", b + 1)];
    const c = cenario(ps);
    await rodarCorpus(c);
    const listados = [...c.repo.jobs.values()].reduce((s, j) => s + (j.progresso?.listados ?? 0), 0);
    assert(c.repo.pedidos.size === 3 && c.repo.itens.size === 3, `pedidos ${c.repo.pedidos.size} itens ${c.repo.itens.size}`);
    assert(listados === 4, `listados ${listados} (esperado 3 + 1 da borda)`);
    const { comp, metricas } = canonico(c.repo);
    assert(comp.completude === "COMPLETE" && metricas!.pedidos === 3 && metricas!.vendas === 60, JSON.stringify(comp));
  });
  t("19c. sequencia longa (ancora → 7 meses, 16 janelas): pedidos em TODAS as bordas e vizinhos; nenhuma lacuna, nenhum duplo no corpus", async () => {
    const ANC = new Date("2026-03-01T00:00:00.000Z");
    const js = J.planejarJanelasCriacao(ANC, new Date("2026-10-04T00:00:00.000Z"));
    const ps: PedidoFake[] = [naBorda("ANC0", ANC.getTime() / 1000)];
    js.forEach((j, i) => {
      const f = j.fim.getTime() / 1000;
      ps.push(naBorda(`B${i}m`, f - 1), naBorda(`B${i}i`, f), naBorda(`B${i}p`, Math.min(f + 1, Date.parse("2026-10-03T23:59:59Z") / 1000)));
      ps.push(naBorda(`M${i}`, Math.floor((j.inicio.getTime() + j.fim.getTime()) / 2000) + i));
    });
    const unicos = new Map(ps.map((p) => [p.orderSn, p]));
    const c = cenario([...unicos.values()]);
    await rodarCorpus(c, "2026-10-04T00:00:00.000Z", undefined, ANC);
    assert(js.length >= 15, `janelas ${js.length}`);
    const faltam = [...unicos.keys()].filter((sn) => !c.repo.pedidos.has(`${LOJA}|${sn}`));
    assert(faltam.length === 0, `faltam ${faltam.join()}`);
    assert(c.repo.pedidos.size === unicos.size && c.repo.itens.size === unicos.size, `duplo: ${c.repo.pedidos.size} ${c.repo.itens.size} / ${unicos.size}`);
    const listados = [...c.repo.jobs.values()].reduce((s, j) => s + (j.progresso?.listados ?? 0), 0);
    const nasBordasInternas = js.slice(0, -1).length; // o pedido "i" de cada borda interna e listado 2x
    assert(listados === unicos.size + nasBordasInternas, `listados ${listados} != ${unicos.size} + ${nasBordasInternas}`);
    const { comp, metricas } = canonico(c.repo, ANC);
    assert(comp.completude === "COMPLETE" && metricas!.pedidos === unicos.size, JSON.stringify({ comp, metricas }));
  });

  await fila;
  console.log(`\n${falhou === 0 ? "✓" : "✗"} SHOPEE-INGESTAO — ${passou} passaram, ${falhou} falharam`);
  process.exit(falhou === 0 ? 0 : 1);
}
principal().catch((e) => { console.error("ERRO FATAL", e); process.exit(1); });
