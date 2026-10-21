/**
 * Etapa 3 / V1 — lista canonica paginada de pedidos Shopee (offline).
 *
 * Sem rede, sem banco: um duplo do PostgREST APLICA de verdade os filtros (eq/gte/gt/lt/lte/in/not/or), a ordem e o
 * limite pedidos pelo modulo, sobre tabelas em memoria; registra toda consulta e qualquer tentativa de escrita.
 *
 *  L1  so R.D. / so Monamor / as duas
 *  L2  50 pedidos por pagina, ultima pagina incompleta, total e paginas
 *  L3  fronteiras: ida e volta pelas paginas sem repetir nem omitir pedido
 *  L4  datas iguais e desempate (loja, order_sn), inclusive no meio de um empate
 *  L5  isolamento por dono e loja (loja de outro dono, loja ML, linhas de outro dono)
 *  L6  pedidos com varios itens: pagina conta PEDIDOS; itens agrupados sem N+1
 *  L7  recorte e status canonicos (pay_time em Sao Paulo, qualquer status, nao pago fora, vendas pela formula)
 *  L8  historico sendo preenchido: insercao atras do cursor, pagamento depois de consultaAte, cobertura
 *  L9  falhas: erro de leitura, prazo, filtro ignorado, linha repetida, capability, teto de itens
 *  L10 cursor: adulterado, de outra consulta, sem direcao; parametros invalidos
 *  L11 nenhum sync/escrita/rede no GET (execucao + guarda de fonte)
 *
 * Uso: npx tsx scripts/testar-vendas-lista-shopee.ts
 */
import "./_server-only-inerte";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const RAIZ = join(__dirname, "..");
let passou = 0, falhou = 0;
let fila: Promise<void> = Promise.resolve();
function t(nome: string, fn: () => void | Promise<void>) {
  fila = fila.then(async () => {
    try { await fn(); passou++; console.log(`  PASS  ${nome}`); }
    catch (e: any) { falhou++; console.log(`  FALHA ${nome} -> ${e?.message ?? e}`); }
  });
}
function assert(c: unknown, m: string): asserts c { if (!c) throw new Error(m); }
const fonte = (rel: string) => readFileSync(join(RAIZ, rel), "utf8");
const semComentarios = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'])\/\/.*$/gm, "$1");

let fetches = 0;
(globalThis as any).fetch = async () => { fetches++; throw new Error("REDE_PROIBIDA"); };

// ── Duplo do PostgREST ────────────────────────────────────────────────

type Linha = Record<string, any>;
interface Consulta { tabela: string; colunas: string; filtros: string[]; limite: number | null; head: boolean }
interface Mundo {
  tabelas: Record<string, Linha[]>;
  consultas: Consulta[];
  escritas: string[];
  falhar?: (c: Consulta) => { code: string; message: string } | null;
  travar?: (c: Consulta) => boolean;
  adulterar?: (c: Consulta, linhas: Linha[]) => Linha[];
}

const ehTempo = (col: string) => /time|janela|_em$|_at$/.test(col);
function cmp(col: string, a: any, b: any): number {
  if (a === b) return 0;
  if (a === null || a === undefined) return 1;
  if (b === null || b === undefined) return -1;
  if (ehTempo(col)) { const x = Date.parse(a), y = Date.parse(b); if (x !== y) return x - y; return 0; }
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}
const op = (o: string, col: string, v: any, alvo: any): boolean => {
  if (v === null || v === undefined) return false;
  const c = cmp(col, v, alvo);
  return o === "eq" ? c === 0 : o === "gt" ? c > 0 : o === "gte" ? c >= 0 : o === "lt" ? c < 0 : o === "lte" ? c <= 0 : (() => { throw new Error(`op ${o}`); })();
};
function termosOr(s: string): [string, string, string][] {
  const out: string[] = []; let atual = "", aspas = false;
  for (const ch of s) { if (ch === '"') aspas = !aspas; if (ch === "," && !aspas) { out.push(atual); atual = ""; } else atual += ch; }
  out.push(atual);
  return out.map((t) => { const m = /^([a-z_]+)\.(eq|gt|gte|lt|lte)\.(.*)$/.exec(t); if (!m) throw new Error(`or invalido: ${t}`); return [m[1], m[2], m[3].replace(/^"|"$/g, "")]; });
}

function criarCliente(m: Mundo) {
  const escrita = (nome: string) => () => { m.escritas.push(nome); throw new Error("ESCRITA_PROIBIDA"); };
  return {
    from(tabela: string) {
      const consulta: Consulta = { tabela, colunas: "*", filtros: [], limite: null, head: false };
      const preds: ((l: Linha) => boolean)[] = [];
      const ordens: [string, boolean][] = [];
      let count = false;
      const b: any = {
        select(cols: string, opts?: { count?: string; head?: boolean }) { consulta.colunas = cols; count = opts?.count === "exact"; consulta.head = !!opts?.head; return b; },
        eq(c: string, v: any) { consulta.filtros.push(`${c}=${v}`); preds.push((l) => op("eq", c, l[c], v)); return b; },
        gt(c: string, v: any) { consulta.filtros.push(`${c}>${v}`); preds.push((l) => op("gt", c, l[c], v)); return b; },
        gte(c: string, v: any) { consulta.filtros.push(`${c}>=${v}`); preds.push((l) => op("gte", c, l[c], v)); return b; },
        lt(c: string, v: any) { consulta.filtros.push(`${c}<${v}`); preds.push((l) => op("lt", c, l[c], v)); return b; },
        lte(c: string, v: any) { consulta.filtros.push(`${c}<=${v}`); preds.push((l) => op("lte", c, l[c], v)); return b; },
        in(c: string, vs: any[]) { consulta.filtros.push(`${c} in (${vs.length})`); preds.push((l) => vs.includes(l[c])); return b; },
        not(c: string, o: string, v: any) { if (o !== "is" || v !== null) throw new Error("not"); preds.push((l) => l[c] !== null && l[c] !== undefined); return b; },
        or(s: string) { consulta.filtros.push(`or(${s})`); const ts = termosOr(s); preds.push((l) => ts.some(([c, o, v]) => op(o, c, l[c], v))); return b; },
        order(c: string, o: { ascending: boolean }) { ordens.push([c, o.ascending]); return b; },
        limit(n: number) { consulta.limite = n; return b; },
        insert: escrita("insert"), update: escrita("update"), upsert: escrita("upsert"), delete: escrita("delete"),
        then(res: (v: any) => any, rej: (e: any) => any) {
          m.consultas.push(consulta);
          if (m.travar?.(consulta)) return new Promise(() => {}).then(res, rej);
          const erro = m.falhar?.(consulta) ?? null;
          if (erro) return Promise.resolve({ data: null, error: erro, count: null }).then(res, rej);
          let ls = (m.tabelas[tabela] ?? []).filter((l) => preds.every((p) => p(l)));
          const n = ls.length;
          ls = [...ls].sort((x, y) => { for (const [c, asc] of ordens) { const r = cmp(c, x[c], y[c]); if (r) return asc ? r : -r; } return 0; });
          if (consulta.limite !== null) ls = ls.slice(0, consulta.limite);
          const cols = consulta.colunas === "*" ? null : consulta.colunas.split(",").map((s) => s.trim());
          ls = ls.map((l) => (cols ? Object.fromEntries(cols.map((c) => [c, l[c] ?? null])) : { ...l }));
          if (m.adulterar) ls = m.adulterar(consulta, ls);
          return Promise.resolve({ data: consulta.head ? null : ls, error: null, count: count ? n : null }).then(res, rej);
        },
      };
      return b;
    },
    rpc: () => { m.escritas.push("rpc"); throw new Error("RPC_PROIBIDA"); },
  } as any;
}

// ── Fixtures ──────────────────────────────────────────────────────────

const DONO = "11111111-1111-4111-8111-111111111111";
const OUTRO = "22222222-2222-4222-8222-222222222222";
const MON = "5d6468bf-7e73-4db6-9fa9-cbaf4946f89f";
const RD = "1c6cfabe-6fa2-4f4f-9a08-7d6522a0b662";
const ML = "50165b6f-5185-4da7-991a-07c0c6bc8f39";
const ALHEIA = "99999999-9999-4999-8999-999999999999";
const AGORA = Date.parse("2026-10-21T12:00:00Z");

const lojasDe = (dono: string) => async (userId: string) => ({
  linhas: userId !== dono ? [] : [
    { id: MON, marketplace: "Shopee" as const, ativo: true, elegibilidade: "ELEGIVEL" as any },
    { id: RD, marketplace: "Shopee" as const, ativo: true, elegibilidade: "ELEGIVEL" as any },
    { id: ML, marketplace: "ML" as const, ativo: true, elegibilidade: "ELEGIVEL" as any },
  ],
  erro: null,
});

let seq = 0;
function pedido(loja: string, sn: string, pay: string | null, extra: Partial<Linha> = {}): Linha {
  return { user_id: DONO, loja_id: loja, order_sn: sn, order_status: "COMPLETED", create_time: pay ?? "2026-09-10T10:00:00Z", pay_time: pay,
    update_time: "2026-10-01T00:00:00Z", escrow_fetched_at: "2026-10-02T00:00:00Z", escrow_update_time: "2026-10-01T00:00:00Z",
    original_shopee_discount: 1, pix_discount: 0.5, ...extra };
}
function item(loja: string, sn: string, extra: Partial<Linha> = {}): Linha {
  seq++;
  return { id: `it-${String(seq).padStart(6, "0")}`, user_id: DONO, marketplace: "Shopee", loja_id: loja, order_id: sn, ml_item_id: `I${seq}`, variation_id: null,
    anuncio: `Produto ${seq}`, sku: `SKU${seq}`, qtd: 1, valor_unit: 10, escrow_voucher_seller: 2, escrow_voucher_shopee: 1, escrow_coin: 0, ...extra };
}
/** n pedidos por loja em setembro, pay_time em minutos crescentes, com empates propositais a cada 7. */
function mundoSetembro(nMon: number, nRd: number): Mundo {
  const sp: Linha[] = [], it: Linha[] = [];
  const base = Date.parse("2026-09-05T12:00:00Z");
  for (const [loja, n, pre] of [[MON, nMon, "MON"], [RD, nRd, "RD"]] as const) {
    for (let i = 0; i < n; i++) {
      const pay = new Date(base + Math.floor(i / 7) * 60_000).toISOString();   // 7 pedidos por minuto: empates
      const sn = `${pre}${String(i).padStart(5, "0")}`;
      sp.push(pedido(loja, sn, pay)); it.push(item(loja, sn));
    }
  }
  return { tabelas: { shopee_pedidos: sp, pedidos: it, sync_jobs: [] }, consultas: [], escritas: [] };
}

const L = () => import("../lib/vendas/listagem/shopee-pedidos");
async function listar(m: Mundo, e: Partial<{ de: string; ate: string; lojaIds: string[] | null; cursor: string | null; direcao: "proximo" | "anterior" | null; userId: string }>, deps: Partial<{ prazoMs: number; agoraMs: number }> = {}) {
  const { listarPedidosShopee } = await L();
  return listarPedidosShopee({ userId: e.userId ?? DONO, de: e.de ?? "2026-09-01", ate: e.ate ?? "2026-09-30", lojaIds: e.lojaIds === undefined ? null : e.lojaIds,
    cursor: e.cursor ?? null, direcao: e.direcao ?? null }, { cliente: criarCliente(m), agoraMs: deps.agoraMs ?? AGORA, prazoMs: deps.prazoMs, listarLojas: lojasDe(DONO) as any });
}
async function todasAsPaginas(m: Mundo, lojaIds: string[] | null) {
  const paginas: Awaited<ReturnType<typeof listar>>[] = [];
  let p = await listar(m, { lojaIds });
  paginas.push(p);
  while (p.cursores.proximo) { p = await listar(m, { lojaIds, cursor: p.cursores.proximo, direcao: "proximo" }); paginas.push(p); if (paginas.length > 1000) throw new Error("laco"); }
  return paginas;
}
const chaves = (ps: { pedidos: { lojaId: string; orderSn: string }[] }[]) => ps.flatMap((p) => p.pedidos.map((x) => `${x.lojaId}|${x.orderSn}`));
async function erroDe(f: () => Promise<unknown>): Promise<string> {
  try { await f(); return "SEM_ERRO"; } catch (e: any) { return e?.codigo ? `${e.codigo}${e.detalhe ? ":" + e.detalhe : ""}` : `OUTRO:${e?.message}`; }
}
/** ordem global esperada: pay_time DESC, loja ASC, order_sn ASC */
const ordemEsperada = (m: Mundo, lojas: string[]) => m.tabelas.shopee_pedidos
  .filter((p) => lojas.includes(p.loja_id) && p.user_id === DONO && p.pay_time !== null
    && Date.parse(p.pay_time) >= Date.parse("2026-09-01T03:00:00Z") && Date.parse(p.pay_time) < Date.parse("2026-10-01T03:00:00Z"))
  .sort((a, b) => Date.parse(b.pay_time) - Date.parse(a.pay_time) || (a.loja_id < b.loja_id ? -1 : a.loja_id > b.loja_id ? 1 : 0) || (a.order_sn < b.order_sn ? -1 : 1))
  .map((p) => `${p.loja_id}|${p.order_sn}`);

async function principal() {
  console.log("\n[L1 lojas]");
  t("L1a so R.D.: so pedidos da R.D., na ordem global", async () => {
    const m = mundoSetembro(60, 40);
    const ps = await todasAsPaginas(m, [RD]);
    assert(chaves(ps).join() === ordemEsperada(m, [RD]).join(), "ordem/conjunto");
    assert(ps[0].lojas.join() === RD && ps[0].total === 40, `${ps[0].lojas} ${ps[0].total}`);
  });
  t("L1b so Monamor", async () => {
    const m = mundoSetembro(60, 40);
    const ps = await todasAsPaginas(m, [MON]);
    assert(chaves(ps).join() === ordemEsperada(m, [MON]).join() && ps[0].total === 60, "monamor");
  });
  t("L1c as duas: merge exato e total somado; sem loja_ids = as duas (nunca a ML)", async () => {
    const m = mundoSetembro(60, 40);
    const ps = await todasAsPaginas(m, [MON, RD]);
    assert(chaves(ps).join() === ordemEsperada(m, [MON, RD]).join(), "merge");
    const todas = await todasAsPaginas(m, null);
    assert(chaves(todas).join() === chaves(ps).join() && todas[0].lojas.join() === [MON, RD].sort().join(), "sem loja_ids");
  });

  console.log("\n[L2 50 por pagina]");
  t("L2a 123 pedidos: 50/50/23, total 123, 3 paginas, numeracao 1..3", async () => {
    const m = mundoSetembro(80, 43);
    const ps = await todasAsPaginas(m, null);
    assert(ps.map((p) => p.pedidos.length).join() === "50,50,23", ps.map((p) => p.pedidos.length).join());
    assert(ps.every((p) => p.total === 123 && p.totalPaginas === 3 && p.tamanhoPagina === 50), "total");
    assert(ps.map((p) => p.pagina).join() === "1,2,3", ps.map((p) => p.pagina).join());
    assert(ps[2].cursores.proximo === null && ps[0].cursores.anterior === null, "bordas");
  });
  t("L2b exatamente 100: duas paginas cheias, sem pagina vazia no fim", async () => {
    const m = mundoSetembro(50, 50);
    const ps = await todasAsPaginas(m, null);
    assert(ps.map((p) => p.pedidos.length).join() === "50,50" && ps[1].cursores.proximo === null, ps.map((p) => p.pedidos.length).join());
  });
  t("L2c periodo vazio: total 0, nenhuma pagina extra", async () => {
    const m = mundoSetembro(0, 0);
    const p = await listar(m, {});
    assert(p.total === 0 && p.totalPaginas === 0 && p.pedidos.length === 0 && p.cursores.proximo === null, JSON.stringify(p.cursores));
  });
  t("L2d nunca o periodo inteiro: cada leitura de pedidos pede no maximo 51 linhas", async () => {
    const m = mundoSetembro(400, 300);
    await todasAsPaginas(m, null);
    const lidas = m.consultas.filter((c) => c.tabela === "shopee_pedidos" && !c.head);
    assert(lidas.length > 0 && lidas.every((c) => c.limite !== null && c.limite <= 51), lidas.map((c) => c.limite).join());
  });

  console.log("\n[L3 fronteiras]");
  t("L3a ida: uniao das paginas = conjunto exato, sem repeticao", async () => {
    const m = mundoSetembro(137, 89);
    const ks = chaves(await todasAsPaginas(m, null));
    assert(new Set(ks).size === ks.length && ks.join() === ordemEsperada(m, [MON, RD]).join(), "ida");
  });
  t("L3b volta pelo cursor 'anterior' reproduz cada pagina e chega na 1", async () => {
    const m = mundoSetembro(137, 89);
    const ida = await todasAsPaginas(m, null);
    let p = ida[ida.length - 1];
    for (let i = ida.length - 2; i >= 0; i--) {
      p = await listar(m, { cursor: p.cursores.anterior!, direcao: "anterior" });
      assert(chaves([p]).join() === chaves([ida[i]]).join(), `pagina ${i + 1} diferente na volta`);
      assert(p.pagina === i + 1 && !p.dadosAlterados, `numero ${p.pagina}`);
    }
    assert(p.cursores.anterior === null, "anterior da 1a");
  });

  console.log("\n[L4 empates]");
  t("L4a todos no MESMO segundo nas duas lojas: desempate loja ASC, order_sn ASC, fronteira no meio do empate", async () => {
    const m = mundoSetembro(0, 0);
    for (let i = 0; i < 70; i++) { m.tabelas.shopee_pedidos.push(pedido(MON, `A${String(i).padStart(3, "0")}`, "2026-09-10T15:00:00Z")); m.tabelas.shopee_pedidos.push(pedido(RD, `B${String(i).padStart(3, "0")}`, "2026-09-10T15:00:00Z")); }
    const ps = await todasAsPaginas(m, null);
    const ks = chaves(ps);
    assert(ks.join() === ordemEsperada(m, [MON, RD]).join() && new Set(ks).size === 140, "empate");
    assert(ks[0].startsWith(RD) === (RD < MON), "loja ASC");
  });
  t("L4b mesmo pay_time com formatos diferentes do banco (+00:00 / Z) e o mesmo instante", async () => {
    const m = mundoSetembro(0, 0);
    m.tabelas.shopee_pedidos.push(pedido(MON, "X1", "2026-09-10T15:00:00+00:00"), pedido(MON, "X2", "2026-09-10T15:00:00.000Z"));
    const p = await listar(m, {});
    assert(p.pedidos.map((x) => x.orderSn).join() === "X1,X2" && p.pedidos.every((x) => x.pagoEm === "2026-09-10T15:00:00.000Z"), JSON.stringify(p.pedidos.map((x) => x.pagoEm)));
  });

  console.log("\n[L5 isolamento]");
  t("L5a loja de outro dono, loja ML ou uuid desconhecido → LOJA_FORA_DO_OWNER (nunca 'o resto')", async () => {
    const m = mundoSetembro(10, 10);
    for (const ids of [[ALHEIA], [MON, ALHEIA], [ML]]) {
      const e = await erroDe(() => listar(m, { lojaIds: ids }));
      assert(e === "LOJA_FORA_DO_OWNER", `${ids}: ${e}`);
    }
    assert(m.consultas.every((c) => c.tabela !== "shopee_pedidos"), "leu pedidos antes de validar");
  });
  t("L5b linhas de outro dono na mesma loja nunca aparecem; toda leitura leva user_id e loja_id", async () => {
    const m = mundoSetembro(10, 10);
    m.tabelas.shopee_pedidos.push(pedido(MON, "INTRUSO", "2026-09-10T15:00:00Z", { user_id: OUTRO }));
    m.tabelas.pedidos.push(item(MON, "MON00000", { user_id: OUTRO, anuncio: "intruso" }));
    const ps = await todasAsPaginas(m, null);
    assert(!chaves(ps).some((k) => k.endsWith("INTRUSO")), "pedido intruso");
    assert(!ps.some((p) => p.pedidos.some((x) => x.itens.some((i) => i.titulo === "intruso"))), "item intruso");
    for (const c of m.consultas.filter((c) => ["shopee_pedidos", "pedidos", "sync_jobs"].includes(c.tabela))) {
      assert(c.filtros.includes(`user_id=${DONO}`) && c.filtros.some((f) => f.startsWith("loja_id=")), `${c.tabela}: ${c.filtros}`);
    }
  });
  t("L5c dono sem loja Shopee: lista vazia, nenhuma leitura de pedidos", async () => {
    const m = mundoSetembro(10, 10);
    const { listarPedidosShopee } = await L();
    const p = await listarPedidosShopee({ userId: OUTRO, de: "2026-09-01", ate: "2026-09-30", lojaIds: null, cursor: null, direcao: null },
      { cliente: criarCliente(m), agoraMs: AGORA, listarLojas: lojasDe(DONO) as any });
    assert(p.lojas.length === 0 && p.pedidos.length === 0 && !m.consultas.some((c) => c.tabela === "shopee_pedidos"), "vazio");
  });

  console.log("\n[L6 itens]");
  t("L6a pedido com 3 itens: um pedido, 3 itens agrupados, unidades somadas; pagina = 50 PEDIDOS com 150 linhas", async () => {
    const m = mundoSetembro(60, 0);
    for (const p of m.tabelas.shopee_pedidos) { m.tabelas.pedidos.push(item(MON, p.order_sn, { qtd: 2 }), item(MON, p.order_sn, { qtd: 3 })); }
    const p = await listar(m, {});
    assert(p.pedidos.length === 50 && p.linhasDeItens === 150, `${p.pedidos.length}/${p.linhasDeItens}`);
    assert(p.pedidos.every((x) => x.itens.length === 3 && x.unidades === 6 && x.itensDisponiveis), "agrupamento");
  });
  t("L6b sem N+1: por pagina, UMA leitura de itens por loja presente na pagina", async () => {
    const m = mundoSetembro(60, 60);
    m.consultas = [];
    await listar(m, {});
    const itens = m.consultas.filter((c) => c.tabela === "pedidos");
    assert(itens.length === 2, `${itens.length} leituras de itens`);
  });
  t("L6c pedido sem linha de item: itensDisponiveis=false, vendas null (nunca zero)", async () => {
    const m = mundoSetembro(3, 0);
    m.tabelas.pedidos = m.tabelas.pedidos.filter((i) => i.order_id !== "MON00001");
    const p = await listar(m, {});
    const x = p.pedidos.find((y) => y.orderSn === "MON00001")!;
    assert(!x.itensDisponiveis && x.vendas === null && x.unidades === 0, JSON.stringify(x));
  });

  console.log("\n[L7 recorte e status canonicos]");
  t("L7a borda de Sao Paulo: 01/09 03:00Z entra, 02:59:59Z nao; 01/10 02:59:59Z entra, 03:00Z nao; nao pago fora", async () => {
    const m = mundoSetembro(0, 0);
    m.tabelas.shopee_pedidos.push(pedido(MON, "AGO", "2026-09-01T02:59:59Z"), pedido(MON, "SET1", "2026-09-01T03:00:00Z"),
      pedido(MON, "SET30", "2026-10-01T02:59:59Z"), pedido(MON, "OUT", "2026-10-01T03:00:00Z"), pedido(MON, "NAOPAGO", null));
    const p = await listar(m, {});
    assert(p.pedidos.map((x) => x.orderSn).join() === "SET30,SET1", p.pedidos.map((x) => x.orderSn).join());
    assert(p.pedidos[0].diaPagamento === "2026-09-30" && p.pedidos[1].diaPagamento === "2026-09-01", "dia SP");
  });
  t("L7b qualquer status pago entra (como no Dashboard) e ganha categoria", async () => {
    const m = mundoSetembro(0, 0);
    const st: [string, string][] = [["CANCELLED", "CANCELADO_APOS_PAGAMENTO"], ["IN_CANCEL", "EM_CANCELAMENTO"], ["TO_RETURN", "DEVOLUCAO"], ["SHIPPED", "VALIDO"], ["ALGO_NOVO", "DESCONHECIDO"]];
    st.forEach(([s], i) => m.tabelas.shopee_pedidos.push(pedido(MON, `S${i}`, `2026-09-10T1${i}:00:00Z`, { order_status: s })));
    const p = await listar(m, {});
    assert(p.total === 5, `total ${p.total}`);
    for (const [s, c] of st) assert(p.pedidos.find((x) => x.statusOriginal === s)?.categoria === c, s);
  });
  t("L7c vendas do pedido = formula canonica (itens − voucher vendedor + subsidio − Pix), em centavos", async () => {
    const m = mundoSetembro(0, 0);
    m.tabelas.shopee_pedidos.push(pedido(MON, "V1", "2026-09-10T12:00:00Z", { original_shopee_discount: 3.33, pix_discount: 1.11 }));
    m.tabelas.pedidos.push(item(MON, "V1", { qtd: 3, valor_unit: 19.9, escrow_voucher_seller: 2.5 }), item(MON, "V1", { qtd: 1, valor_unit: 0.1, escrow_voucher_seller: 0 }));
    const p = await listar(m, {});
    const esperado = (Math.round(19.9 * 3 * 100) + 10 - 250 + 333 - 111) / 100;
    assert(p.pedidos[0].vendas === esperado, `${p.pedidos[0].vendas} != ${esperado}`);
  });
  t("L7d escrow ausente → vendas null; escrow anterior ao update_time → financeiroAtual=false", async () => {
    const m = mundoSetembro(0, 0);
    m.tabelas.shopee_pedidos.push(pedido(MON, "E1", "2026-09-10T12:00:00Z", { pix_discount: null }), pedido(MON, "E2", "2026-09-10T11:00:00Z", { escrow_update_time: "2026-09-20T00:00:00Z" }));
    m.tabelas.pedidos.push(item(MON, "E1"), item(MON, "E2"));
    const p = await listar(m, {});
    assert(p.pedidos[0].vendas === null && p.pedidos[1].vendas !== null && p.pedidos[1].financeiroAtual === false, JSON.stringify(p.pedidos.map((x) => [x.vendas, x.financeiroAtual])));
  });

  console.log("\n[L8 historico sendo preenchido]");
  t("L8a pedido inserido ATRAS do cursor: paginas seguintes sem repeticao/omissao do que existia; dadosAlterados=true", async () => {
    const m = mundoSetembro(120, 0);
    const p1 = await listar(m, {});
    m.tabelas.shopee_pedidos.push(pedido(MON, "TARDIO", "2026-09-30T20:00:00Z"));   // mais recente que tudo: cairia na pagina 1
    const p2 = await listar(m, { cursor: p1.cursores.proximo!, direcao: "proximo" });
    const p3 = await listar(m, { cursor: p2.cursores.proximo!, direcao: "proximo" });
    const ks = chaves([p1, p2, p3]);
    assert(!ks.some((k) => k.endsWith("TARDIO")) && new Set(ks).size === 120 && ks.length === 120, `${ks.length}`);
    assert(p2.dadosAlterados && p2.total === 121, `${p2.dadosAlterados} ${p2.total}`);
  });
  t("L8b pedido PAGO depois de consultaAte nao entra na navegacao (periodo com hoje)", async () => {
    const m = mundoSetembro(0, 0);
    for (let i = 0; i < 60; i++) m.tabelas.shopee_pedidos.push(pedido(MON, `H${String(i).padStart(3, "0")}`, new Date(Date.parse("2026-10-21T10:00:00Z") + i * 1000).toISOString()));
    const p1 = await listar(m, { de: "2026-10-21", ate: "2026-10-21" });
    m.tabelas.shopee_pedidos.push(pedido(MON, "NOVO", "2026-10-21T12:30:00Z"));
    const p2 = await listar(m, { de: "2026-10-21", ate: "2026-10-21", cursor: p1.cursores.proximo!, direcao: "proximo" }, { agoraMs: Date.parse("2026-10-21T13:00:00Z") });
    assert(p1.consultaAte === "2026-10-21T12:00:00.000Z" && p2.consultaAte === p1.consultaAte, "consultaAte");
    assert(!chaves([p1, p2]).some((k) => k.endsWith("NOVO")) && p2.total === 60 && !p2.dadosAlterados, `${p2.total}`);
  });
  t("L8c cobertura: cadeia de create_time cobre → listaCompleta; lacuna → incompleta por loja", async () => {
    const m = mundoSetembro(5, 5);
    const job = (loja: string, a: string, b: string, id: string) => ({ id, user_id: DONO, loja_id: loja, marketplace: "Shopee", campo_tempo: "create_time", janela_inicio: a, janela_fim: b, listagem_completa: true, status: "concluido" });
    m.tabelas.sync_jobs.push(job(MON, "2026-08-01T00:00:00Z", "2026-09-15T00:00:00Z", "j1"), job(MON, "2026-09-15T00:00:00Z", "2026-10-05T00:00:00Z", "j2"),
      job(RD, "2026-08-01T00:00:00Z", "2026-09-15T00:00:00Z", "j3"), job(RD, "2026-09-16T00:00:00Z", "2026-10-05T00:00:00Z", "j4"));
    const p = await listar(m, {});
    const c = p.cobertura!;
    assert(!c.listaCompleta, "lista completa com lacuna");
    assert(c.lojas.find((l) => l.lojaId === MON)!.descobertaCompleta && !c.lojas.find((l) => l.lojaId === RD)!.descobertaCompleta, JSON.stringify(c));
    assert(c.lojas.find((l) => l.lojaId === RD)!.descobertaComprovadaAte === "2026-09-15T00:00:00.000Z", "alcance RD");
    const p2 = await listar(m, { cursor: p.cursores.proximo ?? undefined, direcao: p.cursores.proximo ? "proximo" : null });
    assert(p.cursores.proximo === null || p2.cobertura === null, "cobertura so na 1a pagina");
  });
  t("L8d sem nenhuma janela: descoberta nao comprovada (nunca 'completo' por falta de prova)", async () => {
    const m = mundoSetembro(5, 5);
    const p = await listar(m, {});
    assert(p.cobertura && !p.cobertura.listaCompleta && p.cobertura.lojas.every((l) => l.descobertaComprovadaAte === null), "sem janelas");
  });

  console.log("\n[L9 falhas]");
  const casos: [string, (c: Consulta) => boolean][] = [
    ["pedidos", (c) => c.tabela === "shopee_pedidos" && !c.head], ["contagem", (c) => c.tabela === "shopee_pedidos" && c.head],
    ["itens", (c) => c.tabela === "pedidos"], ["cobertura", (c) => c.tabela === "sync_jobs"],
  ];
  for (const [nome, alvo] of casos) {
    t(`L9 erro de leitura em ${nome} (57014) → LEITURA_FALHOU, nada parcial`, async () => {
      const m = mundoSetembro(60, 60);
      m.falhar = (c) => (alvo(c) ? { code: "57014", message: "canceling statement due to statement timeout" } : null);
      const e = await erroDe(() => listar(m, {}));
      assert(e.startsWith("LEITURA_FALHOU"), e);
    });
  }
  t("L9 prazo estourado (leitura que nunca responde) → LEITURA_FALHOU:timeout", async () => {
    const m = mundoSetembro(10, 10);
    m.travar = (c) => c.tabela === "pedidos";
    const e = await erroDe(() => listar(m, {}, { prazoMs: 150 }));
    assert(e === "LEITURA_FALHOU:timeout", e);
  });
  t("L9 filtro ignorado pelo servidor (linha fora do periodo, na posicao certa da ordem) → pedido_fora_do_periodo", async () => {
    for (const [pos, pay] of [["inicio", "2026-10-05T00:00:00Z"], ["fim", "2026-08-01T00:00:00Z"]] as const) {
      const m = mundoSetembro(10, 0);
      m.adulterar = (c, ls) => {
        if (c.tabela !== "shopee_pedidos" || c.head || !c.filtros.includes(`loja_id=${MON}`)) return ls;
        const fora = { ...ls[0], order_sn: "FORA", pay_time: pay };
        return pos === "inicio" ? [fora, ...ls] : [...ls, fora];
      };
      const e = await erroDe(() => listar(m, {}));
      assert(e === "LEITURA_FALHOU:pedido_fora_do_periodo", `${pos}: ${e}`);
    }
  });
  t("L9 linha repetida / fora de ordem → ordem_instavel; do lado errado do cursor → pedido_do_lado_errado_da_borda", async () => {
    for (const adulterar of [
      (c: Consulta, ls: Linha[]) => (c.tabela === "shopee_pedidos" && !c.head && c.filtros.includes(`loja_id=${MON}`) && ls.length > 1 ? [ls[0], ...ls.slice(0, -1)] : ls),
      (c: Consulta, ls: Linha[]) => (c.tabela === "shopee_pedidos" && !c.head && c.filtros.includes(`loja_id=${MON}`) ? [...ls].reverse() : ls),
    ]) {
      const m = mundoSetembro(30, 0);
      m.adulterar = adulterar;
      const e = await erroDe(() => listar(m, {}));
      assert(e === "LEITURA_FALHOU:ordem_instavel", e);
    }
    const m = mundoSetembro(120, 0);
    const p1 = await listar(m, {});
    // troca a 1a linha da pagina 2 pelo pedido mais recente (que e da pagina 1): mesma quantidade, ordem decrescente valida
    m.adulterar = (c, ls) => (c.tabela === "shopee_pedidos" && !c.head && c.filtros.includes(`loja_id=${MON}`) ? [{ ...m.tabelas.shopee_pedidos.find((x) => x.order_sn === "MON00119")! }, ...ls.slice(1)] : ls);
    const e = await erroDe(() => listar(m, { cursor: p1.cursores.proximo!, direcao: "proximo" }));
    assert(e === "LEITURA_FALHOU:pedido_do_lado_errado_da_borda", e);
  });
  t("L9 item de outra loja devolvido pelo servidor → item_fora_do_recorte", async () => {
    const m = mundoSetembro(5, 0);
    m.adulterar = (c, ls) => (c.tabela === "pedidos" ? ls.map((x, i) => (i === 0 ? { ...x, loja_id: RD } : x)) : ls);
    const e = await erroDe(() => listar(m, {}));
    assert(e === "LEITURA_FALHOU:item_fora_do_recorte", e);
  });
  t("L9 capability de lojas falhou → LEITURA_FALHOU (nunca 'sem loja')", async () => {
    const m = mundoSetembro(5, 5);
    const { listarPedidosShopee } = await L();
    const e = await erroDe(() => listarPedidosShopee({ userId: DONO, de: "2026-09-01", ate: "2026-09-30", lojaIds: null, cursor: null, direcao: null },
      { cliente: criarCliente(m), agoraMs: AGORA, listarLojas: (async () => ({ linhas: [], erro: "erro_consulta_loja" })) as any }));
    assert(e.startsWith("LEITURA_FALHOU"), e);
  });
  t("L9 itens no teto de linhas → falha (nunca itens cortados em silencio)", async () => {
    const m = mundoSetembro(50, 0);
    for (const p of m.tabelas.shopee_pedidos) for (let i = 0; i < 20; i++) m.tabelas.pedidos.push(item(MON, p.order_sn));
    assert((await erroDe(() => listar(m, {}))) === "LEITURA_FALHOU:itens_teto", "teto");
  });

  console.log("\n[L10 cursor e parametros]");
  t("L10a cursor adulterado, de outra consulta ou de outra direcao → CURSOR_INVALIDO", async () => {
    const m = mundoSetembro(120, 30);
    const p1 = await listar(m, {});
    const c = p1.cursores.proximo!;
    const { lerCursorListaShopee, codificarCursorListaShopee } = await L();
    const dec = lerCursorListaShopee(c);
    for (const [nome, f] of [
      ["lixo", () => listar(m, { cursor: "nao-e-cursor", direcao: "proximo" })],
      ["periodo", () => listar(m, { ate: "2026-09-29", cursor: c, direcao: "proximo" })],
      ["lojas", () => listar(m, { lojaIds: [MON], cursor: c, direcao: "proximo" })],
      ["direcao", () => listar(m, { cursor: c, direcao: "anterior" })],
      ["sn", () => listar(m, { cursor: codificarCursorListaShopee({ ...dec, s: "x\",y" }), direcao: "proximo" })],
      ["pagina", () => listar(m, { cursor: codificarCursorListaShopee({ ...dec, pg: 0 }), direcao: "proximo" })],
    ] as const) assert((await erroDe(f as any)) === "CURSOR_INVALIDO", nome);
  });
  t("L10b parametros invalidos → PARAMETRO_INVALIDO", async () => {
    const m = mundoSetembro(1, 1);
    for (const e of [{ de: "2026-9-1" }, { de: "2026-09-30", ate: "2026-09-01" }, { lojaIds: [] }, { lojaIds: ["x"] }, { de: "2025-01-01", ate: "2026-09-30" },
      { cursor: "abc" }, { direcao: "proximo" as const }]) {
      const r = await erroDe(() => listar(m, e as any));
      assert(r.startsWith("PARAMETRO_INVALIDO"), `${JSON.stringify(e)}: ${r}`);
    }
  });

  console.log("\n[L11 so leitura]");
  t("L11a navegacao completa: zero escrita, zero rpc, zero rede", async () => {
    const m = mundoSetembro(130, 70);
    await todasAsPaginas(m, null);
    assert(m.escritas.length === 0 && fetches === 0, `${m.escritas} ${fetches}`);
  });
  t("L11b fonte: modulo e rota sem escrita, sync, job, provider, token ou cookie de loja; rota so GET", () => {
    for (const f of ["lib/vendas/listagem/shopee-pedidos.ts", "app/api/vendas/shopee/pedidos/route.ts"]) {
      const s = semComentarios(fonte(f));
      assert(!/\.(insert|update|upsert|delete|rpc)\(/.test(s), `${f}: escrita`);
      assert(!/fetch\(|sync-shopee|syncShopee|coordenador|garantirProximaAcao|worker|motor|shopee-auth|ml-auth|renovar|refresh_token|access_token/i.test(s), `${f}: efeito`);
      assert(!/shopee_loja_id|lerCookie|NOME_COOKIE|cookies\(/.test(s), `${f}: cookie da TopBar`);
      assert(!/vendas\/canonico\/(service|periodo|dashboard-resumo)/.test(s), `${f}: importa o servico canonico`);
    }
    const rota = semComentarios(fonte("app/api/vendas/shopee/pedidos/route.ts"));
    assert(/export async function GET\(/.test(rota) && !/export async function (POST|PUT|PATCH|DELETE)\(/.test(rota), "metodos");
    assert(/autenticarRequisicao/.test(rota) && /auth\.uid/.test(rota), "dono da sessao");
  });
  t("L11c a pagina Vendas existente nao foi tocada (nao consome a rota nova)", () => {
    assert(!/api\/vendas\/shopee\/pedidos/.test(fonte("app/(app)/vendas/page.tsx")), "page.tsx consome a rota");
  });

  await fila;
  concluida = true;
  console.log(`\n${passou} PASS, ${falhou} FALHA`);
  if (falhou > 0) process.exit(1);
}

// uma promessa que nunca resolve esvazia o event loop e o node sai com 0 no meio da fila: isso e FALHA, nunca PASS
let concluida = false;
process.on("exit", (codigo) => { if (!concluida && codigo === 0) { console.log("\nFALHA suite terminou antes do fim (promessa pendente)"); process.exitCode = 1; } });

principal().catch((e) => { console.error("ERRO FATAL", e); process.exit(1); });
