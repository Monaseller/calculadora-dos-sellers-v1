/**
 * A pericia de setembro/2026, regerada — F7b.4.8.4-R2.
 *
 * UM script, UMA linhagem. No R1 a matriz de candidatas e a decomposicao
 * vinham de lugares diferentes do mesmo JSON: a matriz era derivada dos
 * dados e a decomposicao era um caminho que eu havia fixado a mao. A
 * decomposicao parou numa candidata PIOR e apresentou como "nao explicado"
 * o residuo dela — R$ 81,00 e 4 pedidos que nao existiam.
 *
 * Aqui a candidata vencedora e ESCOLHIDA pelos dados, e todo numero
 * apresentado sai da mesma apuracao.
 *
 * ── O que e derivado e o que e observado ────────────────────────────
 *
 * DERIVADO (lido de arquivo, nunca digitado):
 *   - o dataset da API, de `pedidos.jsonl`
 *   - os totais do relatorio OFICIAL, lidos do .xlsx que o dono baixou
 *   - as candidatas, de `pericia-ml-periodo.ts`
 *
 * OBSERVADO (duas leituras de tela, declaradas como tal):
 *   - `PAINEL_VENDAS_BRUTAS_EXIBIDO`
 *   - `PAINEL_CANCELADAS_EXIBIDO`
 *
 * Nenhum total calculado e digitado. §5.
 *
 * READ-ONLY: nao fala com a API nem com o banco; nao altera runtime.
 *
 * Roda com: npx tsx scripts/gerar-pericia-r2.ts [pasta-de-saida]
 */
import "./_server-only-inerte";

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { lerXlsx } from "../lib/agentes/planilhas/leitura";
import { escreverXlsx } from "./gerar-xlsx";
import {
  apurar, conferirCobertura, dentroDoPeriodo, diaComoEscrito, diaEmSaoPaulo,
  minutoEmSaoPaulo, montarCandidatas, numero, pagamentoDoAgente, populacaoDoRaw,
  unidadesDoPedido, type Apuracao, type Candidata, type PedidoPericia,
} from "./pericia-ml-periodo";

const DE = "2026-09-01";
const ATE = "2026-09-30";

const ORIGEM = process.env.ORIGEM ??
  join("C:", "Users", "USER", "AppData", "Local", "Temp", "claude",
    "c--Users-USER-Desktop-calculadora-dos-sellers-v1",
    "c9e0b194-ce1f-484c-80df-7b403c7a8702", "scratchpad", "ml-setembro");
const SAIDA = process.argv[2] ??
  join("C:", "Users", "USER", "Desktop", "reconciliacao-ml-setembro-2026");
const OFICIAL = process.env.OFICIAL ??
  join("C:", "Users", "USER", "Desktop", "boleto e comprovante",
    "20261001_Vendas_BR_Mercado_Libre_y_Mercado_Shops_2026-10-01_08-21hs_744240004.xlsx");

/**
 * As DUAS leituras de tela do painel.
 *
 * Nao sao calculo: sao o que o dono viu em Metricas > Negocio > Visao
 * geral. Ficam isoladas aqui, nomeadas, para que nenhum total derivado
 * possa ser confundido com elas. O painel nao mostra centavos.
 */
const PAINEL_VENDAS_BRUTAS_EXIBIDO = 393_839;
const PAINEL_CANCELADAS_EXIBIDO = 414;

function brl(v: number): string {
  return v.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function cent(v: number): number {
  return Math.round(v * 100) / 100;
}

// ═══ 1. O dataset da API ═══════════════════════════════════════════

const linhasBrutas = readFileSync(join(ORIGEM, "pedidos.jsonl"), "utf8").trim().split("\n");
const porId = new Map<string, PedidoPericia>();
for (const l of linhasBrutas) {
  const o = JSON.parse(l) as PedidoPericia;
  const a = porId.get(o.id);
  if (a === undefined || (o.last_updated ?? "") > (a.last_updated ?? "")) porId.set(o.id, o);
}
const pedidos = [...porId.values()];
const porPack = new Map<string, PedidoPericia[]>();
for (const p of pedidos) {
  if (p.pack_id === null) continue;
  const atual = porPack.get(p.pack_id) ?? [];
  if (!atual.some((x) => x.id === p.id)) atual.push(p);
  porPack.set(p.pack_id, atual);
}
const coleta = JSON.parse(readFileSync(join(ORIGEM, "coleta.json"), "utf8")) as {
  coletadoEm: string; criacaoDe: string; criacaoAte: string;
  dias: { dia: string; unicos: number; total: number | null; completo: boolean }[];
  diasIncompletos: string[]; completo: boolean;
};

console.log("══ F7b.4.8.4-R2 — pericia regerada ══\n");
console.log("1. DATASET DA API");
console.log(`   linhas no arquivo .......... ${linhasBrutas.length}`);
console.log(`   order_id unicos ........... ${pedidos.length}`);
console.log(`   repetidos entre subjanelas  ${linhasBrutas.length - pedidos.length}`);
console.log(`   dias coletados ............ ${coleta.dias.length}`);
console.log(`   dias incompletos .......... ${coleta.diasIncompletos.length}`);

// ═══ 2. O relatorio OFICIAL, derivado do arquivo ═══════════════════

function valor(c: { bruto: string | number | null } | undefined): string {
  return c === undefined || c.bruto === null ? "" : String(c.bruto);
}
/** `null` quando a celula esta VAZIA. O R1 devolvia 0 e perdeu as 148. */
function numeroDaCelula(c: { bruto: string | number | null } | undefined): number | null {
  if (c === undefined || c.bruto === null) return null;
  if (typeof c.bruto === "number") return c.bruto;
  const t = c.bruto.trim();
  if (t === "") return null;
  const n = Number(t.replace(/[R$\s.]/g, "").replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

const MESES: Record<string, string> = {
  janeiro: "01", fevereiro: "02", março: "03", marco: "03", abril: "04",
  maio: "05", junho: "06", julho: "07", agosto: "08", setembro: "09",
  outubro: "10", novembro: "11", dezembro: "12",
};
/** "30 de setembro de 2026 23:59" -> "2026-09-30 23:59". */
function dataDoOficial(texto: string): string {
  const m = texto.toLowerCase().match(/(\d{1,2})\s+de\s+([a-zç]+)\s+de\s+(\d{4})\D+(\d{1,2}):(\d{2})/);
  if (m !== null && MESES[m[2]] !== undefined) {
    return `${m[3]}-${MESES[m[2]]}-${m[1].padStart(2, "0")} ${m[4].padStart(2, "0")}:${m[5]}`;
  }
  const dm = texto.match(/^(\d{2})\/(\d{2})\/(\d{4})\D+(\d{1,2}):(\d{2})/);
  if (dm !== null) return `${dm[3]}-${dm[2]}-${dm[1]} ${dm[4].padStart(2, "0")}:${dm[5]}`;
  return "";
}

const abaOficial = lerXlsx(new Uint8Array(readFileSync(OFICIAL))).abas[0];
let iCab = -1;
for (let i = 0; i < Math.min(15, abaOficial.linhas.length); i += 1) {
  const t = abaOficial.linhas[i].map(valor).join("|").toLowerCase();
  if (t.includes("venda") && t.includes("unidades")) { iCab = i; break; }
}
if (iCab < 0) { console.error("ERRO: cabecalho do relatorio oficial nao encontrado."); process.exit(1); }
const cabOficial = abaOficial.linhas[iCab].map(valor);
const acharColuna = (padrao: RegExp, nome: string): number => {
  const i = cabOficial.findIndex((c) => padrao.test(c.toLowerCase()));
  if (i < 0) { console.error(`ERRO: coluna ${nome} nao encontrada no oficial.`); process.exit(1); }
  return i;
};
const C_VENDA = acharColuna(/n.*de venda/, "N. de venda");
const C_DATA = acharColuna(/data de venda/, "Data de venda");
const C_ESTADO = acharColuna(/^estado$/, "Estado");
const C_UNID = acharColuna(/^unidades$/, "Unidades");
const C_PRECO = acharColuna(/pre.o unit.rio de venda/, "Preco unitario");

interface LinhaOficial {
  readonly venda: string; readonly dataSP: string; readonly estado: string;
  readonly unidades: number | null; readonly preco: number | null;
}
const todasAsLinhas: LinhaOficial[] = abaOficial.linhas.slice(iCab + 1)
  .filter((l) => l.some((c) => valor(c) !== ""))
  .map((l) => ({
    venda: valor(l[C_VENDA]),
    dataSP: dataDoOficial(valor(l[C_DATA])),
    estado: valor(l[C_ESTADO]),
    unidades: numeroDaCelula(l[C_UNID]),
    preco: numeroDaCelula(l[C_PRECO]),
  }));

// A linha-cabecalho de pacote nao tem unidade nem preco: ela nao e uma
// venda, e por isso a contagem de vendas do painel e menor que a de
// linhas. O criterio e a AUSENCIA de unidade; o texto do estado e so
// corroboracao.
const cabecalhosDePacote = todasAsLinhas.filter((l) => l.unidades === null);
const vendasOficiais = todasAsLinhas.filter((l) => l.unidades !== null);
const oficialUnidades = vendasOficiais.reduce((a, l) => a + numero(l.unidades), 0);
const oficialValor = cent(vendasOficiais.reduce(
  (a, l) => a + numero(l.unidades) * numero(l.preco), 0));
const oficialMedioVenda = oficialValor / vendasOficiais.length;
const oficialMedioUnidade = oficialValor / oficialUnidades;

console.log("\n2. RELATORIO OFICIAL (derivado do arquivo, nada digitado)");
console.log(`   arquivo ................... ${OFICIAL.split("\\").pop()}`);
console.log(`   linhas de dados ........... ${todasAsLinhas.length}`);
console.log(`   linhas-cabecalho de pacote  ${cabecalhosDePacote.length}  (sem unidade e sem preco)`);
const porTipoDePacote = new Map<string, number>();
for (const l of cabecalhosDePacote) porTipoDePacote.set(l.estado, (porTipoDePacote.get(l.estado) ?? 0) + 1);
for (const [k, v] of [...porTipoDePacote.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`     ${String(v).padStart(4)}  ${k}`);
}
console.log(`   vendas reais .............. ${vendasOficiais.length}`);
console.log(`   unidades .................. ${oficialUnidades}`);
console.log(`   soma(unidades x preco) .... R$ ${brl(oficialValor)}`);
console.log(`   medio por venda ........... R$ ${brl(oficialMedioVenda)}  (${oficialMedioVenda.toFixed(6)})`);
console.log(`   medio por unidade ......... R$ ${brl(oficialMedioUnidade)}  (${oficialMedioUnidade.toFixed(6)})`);

/** Os order_id da API por tras de um "N.º de venda" do oficial. */
function pedidosDaVenda(venda: string): readonly PedidoPericia[] {
  const direto = porId.get(venda);
  if (direto !== undefined) return [direto];
  return porPack.get(venda) ?? [];
}
const idsDoOficial = new Set<string>();
for (const l of vendasOficiais) for (const p of pedidosDaVenda(l.venda)) idsDoOficial.add(p.id);
console.log(`   resolvidas para order_id .. ${idsDoOficial.size}`);

// ═══ 3. As candidatas, pontuadas contra o OFICIAL ══════════════════

const candidatas = montarCandidatas();
const porCandidata = new Map(candidatas.map((c) => [c.id, c]));
const apuracoes = candidatas.map((c) => apurar(c, pedidos, DE, ATE));
const apuracaoPorId = new Map(apuracoes.map((a) => [a.candidataId, a]));

/**
 * A nota e contra o relatorio OFICIAL DETALHADO, nao contra o painel.
 *
 * O painel nao mostra centavos; o relatorio mostra. Pontuar contra o
 * numero exato e o que permite exigir igualdade em vez de proximidade.
 */
interface Nota {
  readonly candidataId: string;
  readonly valorIgual: boolean; readonly pedidosIgual: boolean;
  readonly unidadesIgual: boolean; readonly conjuntoIgual: boolean;
  readonly nota: number;
  readonly soNoOficial: number; readonly soNaCandidata: number;
}
const notas: Nota[] = apuracoes.map((a) => {
  const ids = new Set(a.ids);
  const soNoOficial = [...idsDoOficial].filter((x) => !ids.has(x)).length;
  const soNaCandidata = a.ids.filter((x) => !idsDoOficial.has(x)).length;
  const valorIgual = Math.abs(cent(a.total) - oficialValor) < 0.005;
  const pedidosIgual = a.pedidos === vendasOficiais.length;
  const unidadesIgual = a.unidades === oficialUnidades;
  const conjuntoIgual = soNoOficial === 0 && soNaCandidata === 0;
  return {
    candidataId: a.candidataId, valorIgual, pedidosIgual, unidadesIgual, conjuntoIgual,
    nota: [valorIgual, pedidosIgual, unidadesIgual, conjuntoIgual].filter(Boolean).length,
    soNoOficial, soNaCandidata,
  };
});
const notaPorId = new Map(notas.map((n) => [n.candidataId, n]));

/** A vencedora sai DOS DADOS: maior nota, desempate pelo menor desvio. */
const ranking = [...notas].sort((x, y) =>
  y.nota - x.nota ||
  Math.abs(cent(apuracaoPorId.get(x.candidataId)?.total ?? 0) - oficialValor) -
  Math.abs(cent(apuracaoPorId.get(y.candidataId)?.total ?? 0) - oficialValor));
const vencedoraId = ranking[0].candidataId;
const vencedora = porCandidata.get(vencedoraId) as Candidata;
const apVencedora = apuracaoPorId.get(vencedoraId) as Apuracao;

console.log("\n3. CANDIDATAS — pontuadas contra o relatorio oficial");
console.log("   (V valor | Q pedidos | U unidades | C conjunto identico)");
for (const n of ranking.slice(0, 8)) {
  const a = apuracaoPorId.get(n.candidataId) as Apuracao;
  const marcas = `${n.valorIgual ? "V" : "-"}${n.pedidosIgual ? "Q" : "-"}` +
    `${n.unidadesIgual ? "U" : "-"}${n.conjuntoIgual ? "C" : "-"}`;
  console.log(`   ${n.nota}/4 [${marcas}] ${n.candidataId}`);
  console.log(`        R$ ${brl(a.total).padStart(14)}  ped=${String(a.pedidos).padStart(6)}` +
    `  un=${String(a.unidades).padStart(6)}  so_oficial=${n.soNoOficial} so_cand=${n.soNaCandidata}`);
}
console.log(`\n   VENCEDORA (derivada, nao escolhida a mao): ${vencedoraId}`);

// ═══ 4. O raw cobre todas as candidatas — anti-vacuidade ═══════════

const doRaw = populacaoDoRaw(pedidos, DE, ATE);
const idsNoRaw = new Set(doRaw.map((p) => p.id));
const falhas = conferirCobertura(apuracoes, porCandidata, porId, idsNoRaw);

console.log("\n4. ANTI-VACUIDADE (§4)");
console.log(`   pedidos no raw ............ ${idsNoRaw.size}`);
console.log(`   candidatas conferidas ..... ${apuracoes.length}`);
console.log(`   falhas de cobertura ....... ${falhas.length}`);
for (const f of falhas.slice(0, 10)) {
  console.log(`     ${f.candidataId}  order=${f.orderId}  ${f.diaComoEscrito} -> ${f.diaEmSaoPaulo}`);
}
const falhaNaObrigatoria = falhas.filter((f) =>
  f.candidataId === "fechamento_sp|sem_pack_splitted|total_amount").length;
console.log(`   missing_from_raw na candidata obrigatoria: ${falhaNaObrigatoria}`);
if (falhas.length > 0) {
  console.error("\n   FALHA: ha candidata somando pedido ausente do raw. Artefato NAO confiavel.");
  process.exit(1);
}

// ═══ 5. Decomposicao DERIVADA ══════════════════════════════════════

const BASE_ID = "pagamento_sp|com_pagamento_que_conta|paid_amount";
const apBase = apuracaoPorId.get(BASE_ID) as Apuracao;

/**
 * Da regra de hoje ate a vencedora, um eixo por vez.
 *
 * A ordem dos passos e fixa e declarada — valor, data, populacao — mas o
 * DESTINO e a vencedora derivada, e nao um ponto que eu escolhi. Era essa
 * a troca do R1.
 */
const caminho = [
  { rotulo: "0. regra de hoje", id: BASE_ID },
  {
    rotulo: "1. troca o VALOR",
    id: `${porCandidata.get(BASE_ID)?.data.id}|${porCandidata.get(BASE_ID)?.populacao.id}|${vencedora.valor.id}`,
  },
  {
    rotulo: "2. troca a DATA",
    id: `${vencedora.data.id}|${porCandidata.get(BASE_ID)?.populacao.id}|${vencedora.valor.id}`,
  },
  { rotulo: "3. troca a POPULACAO", id: vencedoraId },
].map((passo) => {
  const a = apuracaoPorId.get(passo.id) as Apuracao;
  return { ...passo, total: a.total, pedidos: a.pedidos, unidades: a.unidades };
});
const passos = caminho.map((p, i) => ({
  ...p,
  deltaValor: i === 0 ? 0 : p.total - caminho[i - 1].total,
  deltaPedidos: i === 0 ? 0 : p.pedidos - caminho[i - 1].pedidos,
}));

/** O efeito de trocar UM eixo sozinho, a partir da regra de hoje. */
const isolados = [
  { eixo: "valor", id: `${porCandidata.get(BASE_ID)?.data.id}|${porCandidata.get(BASE_ID)?.populacao.id}|${vencedora.valor.id}` },
  { eixo: "data", id: `${vencedora.data.id}|${porCandidata.get(BASE_ID)?.populacao.id}|${porCandidata.get(BASE_ID)?.valor.id}` },
  { eixo: "populacao", id: `${porCandidata.get(BASE_ID)?.data.id}|${vencedora.populacao.id}|${porCandidata.get(BASE_ID)?.valor.id}` },
].map((x) => {
  const a = apuracaoPorId.get(x.id) as Apuracao;
  return { ...x, total: a.total, delta: a.total - apBase.total, pedidos: a.pedidos };
});

const divergenciaInicial = oficialValor - cent(apBase.total);
const residuo = oficialValor - cent(apVencedora.total);

console.log("\n5. DECOMPOSICAO (destino derivado)");
for (const p of passos) {
  console.log(`   ${p.rotulo.padEnd(26)} ${p.id}`);
  console.log(`      R$ ${brl(p.total).padStart(14)}  ped=${String(p.pedidos).padStart(6)}  un=${String(p.unidades).padStart(6)}` +
    (p.deltaValor === 0 ? "" : `   delta R$ ${brl(p.deltaValor)}  ped ${p.deltaPedidos >= 0 ? "+" : ""}${p.deltaPedidos}`));
}
console.log(`   efeito de cada eixo ISOLADO:`);
for (const i of isolados) console.log(`      ${i.eixo.padEnd(10)} R$ ${brl(i.delta)}  (ped=${i.pedidos})`);
console.log(`   oficial detalhado ......... R$ ${brl(oficialValor)}`);
console.log(`   divergencia da regra atual  R$ ${brl(divergenciaInicial)}`);
console.log(`   residuo da vencedora ...... R$ ${brl(residuo)}`);

// ═══ 6. Conjuntos contra o oficial ═════════════════════════════════

const idsVencedora = new Set(apVencedora.ids);
const soNoOficial = [...idsDoOficial].filter((x) => !idsVencedora.has(x));
const soNaCandidata = [...idsVencedora].filter((x) => !idsDoOficial.has(x));
const faltandoNoRaw = [...idsVencedora].filter((x) => !idsNoRaw.has(x));

console.log("\n6. CONJUNTOS");
console.log(`   official_orders_minus_candidate ... ${soNoOficial.length}`);
console.log(`   candidate_minus_official_orders ... ${soNaCandidata.length}`);
console.log(`   missing_candidate_orders_from_raw . ${faltandoNoRaw.length}`);

// ═══ 7. A data, ao minuto, contra o oficial ════════════════════════

const provaDeData = montarCandidatas()
  .filter((c) => c.populacao.id === "todos" && c.valor.id === "total_amount")
  .map((c) => {
    let batem = 0;
    let comparados = 0;
    for (const l of vendasOficiais) {
      const ps = pedidosDaVenda(l.venda);
      if (ps.length !== 1 || l.dataSP === "") continue;
      comparados += 1;
      if (c.data.minuto(ps[0]) === l.dataSP) batem += 1;
    }
    return { eixo: c.data.id, rotulo: c.data.rotulo, batem, comparados };
  });
console.log("\n7. A DATA, AO MINUTO, contra o oficial");
for (const p of provaDeData) {
  console.log(`   ${p.eixo.padEnd(16)} ${p.batem}/${p.comparados}  ` +
    `${p.comparados === 0 ? "-" : ((p.batem / p.comparados) * 100).toFixed(2)}%`);
}

// ═══ 8. Os dois pedidos do R1 ══════════════════════════════════════

const DOIS = ["2000018219592150", "2000018219744892"];
const provaDosDois = DOIS.map((id) => {
  const p = porId.get(id);
  const linha = vendasOficiais.find((l) => pedidosDaVenda(l.venda).some((x) => x.id === id));
  return {
    order_id: id,
    pack_id: p?.pack_id ?? "",
    date_closed_original: p?.date_closed ?? "",
    date_closed_sao_paulo: minutoEmSaoPaulo(p?.date_closed ?? null),
    dia_como_escrito: diaComoEscrito(p?.date_closed ?? null) ?? "",
    dia_em_sao_paulo: diaEmSaoPaulo(p?.date_closed ?? null) ?? "",
    total_amount: numero(p?.total_amount),
    quantity: p === undefined ? 0 : unidadesDoPedido(p),
    status: p?.status ?? "",
    cancel_code: p?.cancel_code ?? "",
    no_raw_r2: idsNoRaw.has(id) ? "SIM" : "NAO",
    na_candidata_vencedora: idsVencedora.has(id) ? "SIM" : "NAO",
    no_relatorio_oficial: linha === undefined ? "NAO" : `SIM (${linha.dataSP}, ${linha.estado})`,
    porque_entra_agora:
      "o periodo passou a ser testado com o dia JA convertido para America/Sao_Paulo; " +
      "como escrito no offset -04:00 do provedor este pedido cai em agosto",
  };
});
console.log("\n8. OS DOIS PEDIDOS DO R1");
for (const d of provaDosDois) {
  console.log(`   ${d.order_id}  pack=${d.pack_id}`);
  console.log(`      ${d.date_closed_original}  ->  SP ${d.date_closed_sao_paulo}` +
    `   escrito=${d.dia_como_escrito}  SP=${d.dia_em_sao_paulo}`);
  console.log(`      total=${d.total_amount}  un=${d.quantity}  status=${d.status}/${d.cancel_code}`);
  console.log(`      no raw R2=${d.no_raw_r2}  na vencedora=${d.na_candidata_vencedora}  oficial=${d.no_relatorio_oficial}`);
}

// ═══ 9. Canceladas ═════════════════════════════════════════════════

const porEstadoOficial = new Map<string, number>();
for (const l of vendasOficiais) {
  porEstadoOficial.set(l.estado, (porEstadoOficial.get(l.estado) ?? 0) + 1);
}
const estadosDeCancelamento = [...porEstadoOficial.entries()].filter(([k]) => /cancel/i.test(k));
const canceladasOficial = estadosDeCancelamento.reduce((a, [, v]) => a + v, 0);
const canceladasApi = apVencedora.ids
  .map((id) => porId.get(id))
  .filter((p): p is PedidoPericia => p !== undefined && p.status === "cancelled");
console.log("\n9. CANCELADAS");
console.log(`   painel exibido ............ ${PAINEL_CANCELADAS_EXIBIDO}  (leitura de tela)`);
console.log(`   oficial, estados com "cancel": ${canceladasOficial}`);
console.log(`   delta ..................... ${PAINEL_CANCELADAS_EXIBIDO - canceladasOficial}`);
console.log(`   API, status=cancelled na vencedora: ${canceladasApi.length}`);

// ═══ 10. As planilhas R2 ═══════════════════════════════════════════

mkdirSync(SAIDA, { recursive: true });

const linhaDePedido = (p: PedidoPericia) => {
  const pg = pagamentoDoAgente(p);
  const naVencedora = idsVencedora.has(p.id);
  const excecoes: string[] = [];
  if (p.pagamentos.length > 1) excecoes.push("multiplos_pagamentos");
  if (p.status === "partially_refunded") excecoes.push("estorno_parcial");
  if (p.pagamentos.length > 0 && p.pagamentos.every((x) => x.status === "refunded")) excecoes.push("estorno_total");
  if (p.status === "cancelled") excecoes.push(`cancelado:${p.cancel_code ?? "?"}`);
  if (p.pagamentos.some((x) => x.status === "charged_back")) excecoes.push("chargeback");
  if (p.mediacoes > 0 || p.pagamentos.some((x) => x.status === "in_mediation")) excecoes.push("mediacao");
  if (Math.abs(numero(p.paid_amount) - numero(p.total_amount)) > 0.005) excecoes.push("paid!=total");
  if (diaComoEscrito(p.date_closed) !== diaEmSaoPaulo(p.date_closed)) excecoes.push("muda_de_dia_pelo_fuso");
  if (dentroDoPeriodo(diaComoEscrito(p.date_closed), DE, ATE) !==
    dentroDoPeriodo(diaEmSaoPaulo(p.date_closed), DE, ATE)) excecoes.push("MUDA_DE_MES_PELO_FUSO");
  return {
    order_id: p.id,
    pack_id: p.pack_id ?? "",
    status: p.status ?? "",
    date_closed_original: p.date_closed ?? "",
    date_closed_sao_paulo: minutoEmSaoPaulo(p.date_closed),
    dia_fechamento_escrito_minus04: diaComoEscrito(p.date_closed) ?? "",
    dia_fechamento_sao_paulo: diaEmSaoPaulo(p.date_closed) ?? "",
    date_created_original: p.date_created ?? "",
    dia_criacao_sao_paulo: diaEmSaoPaulo(p.date_created) ?? "",
    dia_pagamento_sao_paulo: diaEmSaoPaulo(pg?.date_approved ?? null) ?? "",
    unidades: unidadesDoPedido(p),
    total_amount: numero(p.total_amount),
    paid_amount: numero(p.paid_amount),
    soma_gross_price: cent(p.itens.reduce((a, it) => a + numero(it.gross_price), 0)),
    soma_unit_x_qtd: cent(p.itens.reduce((a, it) => a + numero(it.unit_price) * numero(it.quantity), 0)),
    frete_comprador: cent(p.pagamentos.reduce((a, x) => a + numero(x.shipping_cost), 0)),
    estornado: cent(p.pagamentos.reduce((a, x) => a + numero(x.transaction_amount_refunded), 0)),
    qtd_pagamentos: p.pagamentos.length,
    status_pagamentos: p.pagamentos.map((x) => x.status ?? "?").join("|"),
    cancel_group: p.cancel_group ?? "",
    cancel_code: p.cancel_code ?? "",
    mediacoes: p.mediacoes,
    // A regra de HOJE
    agente_incluiu: dentroDoPeriodo(diaEmSaoPaulo(pg?.date_approved ?? null), DE, ATE) ? "SIM" : "NAO",
    agente_campo_valor: "paid_amount",
    agente_campo_data: "payments[].date_approved mais antigo -> America/Sao_Paulo",
    agente_valor_usado: dentroDoPeriodo(diaEmSaoPaulo(pg?.date_approved ?? null), DE, ATE)
      ? numero(p.paid_amount) : 0,
    agente_motivo: pg === null ? "sem pagamento approved/partially_refunded"
      : (dentroDoPeriodo(diaEmSaoPaulo(pg.date_approved), DE, ATE)
        ? "pagamento aprovado dentro do periodo" : "pagamento aprovado fora do periodo"),
    // A candidata VENCEDORA
    candidata_id: vencedoraId,
    candidata_incluiu: naVencedora ? "SIM" : "NAO",
    candidata_campo_valor: vencedora.valor.id,
    candidata_campo_data: vencedora.data.id,
    candidata_valor_usado: naVencedora ? vencedora.valor.valor(p) : 0,
    candidata_motivo: !dentroDoPeriodo(vencedora.data.dia(p), DE, ATE)
      ? "fora do periodo pela data da candidata"
      : (vencedora.populacao.inclui(p) ? "dentro do periodo e na populacao"
        : `excluido por: ${vencedora.populacao.rotulo}`),
    no_relatorio_oficial: idsDoOficial.has(p.id) ? "SIM" : "NAO",
    excecoes: excecoes.join("; "),
  };
};

const linhasRaw = [...doRaw]
  .sort((a, b) => (a.date_closed ?? "").localeCompare(b.date_closed ?? ""))
  .map(linhaDePedido);
const colsRaw = Object.keys(linhasRaw[0] ?? { order_id: "" });

const linhasPagamento: Record<string, unknown>[] = [];
for (const p of doRaw) {
  for (const pg of p.pagamentos) {
    linhasPagamento.push({
      order_id: p.id, payment_id: pg.id,
      status: pg.status ?? "", status_detail: pg.status_detail ?? "",
      date_approved_original: pg.date_approved ?? "",
      date_approved_sao_paulo: minutoEmSaoPaulo(pg.date_approved),
      dia_aprovado_escrito_minus04: diaComoEscrito(pg.date_approved) ?? "",
      dia_aprovado_sao_paulo: diaEmSaoPaulo(pg.date_approved) ?? "",
      transaction_amount: numero(pg.transaction_amount),
      total_paid_amount: numero(pg.total_paid_amount),
      shipping_cost: numero(pg.shipping_cost),
      coupon_amount: numero(pg.coupon_amount),
      taxes_amount: numero(pg.taxes_amount),
      overpaid_amount: numero(pg.overpaid_amount),
      transaction_amount_refunded: numero(pg.transaction_amount_refunded),
      installments: numero(pg.installments),
      payment_type: pg.payment_type ?? "", operation_type: pg.operation_type ?? "",
      conta_na_regra_de_hoje: pagamentoDoAgente(p)?.id === pg.id ? "SIM (escolhido)" : "NAO",
    });
  }
}

const linhasItem: Record<string, unknown>[] = [];
for (const p of doRaw) {
  for (const it of p.itens) {
    linhasItem.push({
      order_id: p.id,
      quantity: numero(it.quantity),
      unit_price: numero(it.unit_price),
      gross_price: numero(it.gross_price),
      unit_x_qtd: cent(numero(it.unit_price) * numero(it.quantity)),
      gross_menos_unit_x_qtd: cent(numero(it.gross_price) - numero(it.unit_price) * numero(it.quantity)),
    });
  }
}

/** Pedidos cuja competencia MUDA por causa do fuso — o controle de borda. */
const borda = pedidos
  .filter((p) => dentroDoPeriodo(diaComoEscrito(p.date_closed), DE, ATE) !==
    dentroDoPeriodo(diaEmSaoPaulo(p.date_closed), DE, ATE) ||
    dentroDoPeriodo(diaComoEscrito(p.date_created), DE, ATE) !==
    dentroDoPeriodo(diaEmSaoPaulo(p.date_created), DE, ATE))
  .sort((a, b) => (a.date_closed ?? "").localeCompare(b.date_closed ?? ""))
  .map((p) => ({
    order_id: p.id, pack_id: p.pack_id ?? "", status: p.status ?? "",
    campo: "date_closed",
    original: p.date_closed ?? "",
    sao_paulo: minutoEmSaoPaulo(p.date_closed),
    dia_escrito_minus04: diaComoEscrito(p.date_closed) ?? "",
    dia_sao_paulo: diaEmSaoPaulo(p.date_closed) ?? "",
    dentro_pelo_escrito: dentroDoPeriodo(diaComoEscrito(p.date_closed), DE, ATE) ? "SIM" : "NAO",
    dentro_pelo_sao_paulo: dentroDoPeriodo(diaEmSaoPaulo(p.date_closed), DE, ATE) ? "SIM" : "NAO",
    total_amount: numero(p.total_amount), unidades: unidadesDoPedido(p),
    no_relatorio_oficial: idsDoOficial.has(p.id) ? "SIM" : "NAO",
    na_candidata_vencedora: idsVencedora.has(p.id) ? "SIM" : "NAO",
  }));

const linhagem = [
  { etapa: "1. raw", descricao: "pedidos.jsonl, uma linha por leitura da API", valor: `${linhasBrutas.length} linhas` },
  { etapa: "2. deduplicacao", descricao: "por order_id, mantendo o last_updated mais recente", valor: `${pedidos.length} pedidos unicos` },
  { etapa: "3. normalizacao temporal", descricao: `offset do provedor -> America/Sao_Paulo (${"-3h fixo"})`, valor: "aplicada ANTES de qualquer teste de periodo" },
  { etapa: "4. populacao do raw", descricao: "uniao de todas as candidatas (populacaoDoRaw)", valor: `${idsNoRaw.size} pedidos` },
  { etapa: "5. candidata vencedora", descricao: vencedoraId, valor: "escolhida pela nota contra o oficial" },
  { etapa: "5a. data", descricao: vencedora.data.rotulo, valor: `${provaDeData.find((x) => x.eixo === vencedora.data.id)?.batem}/${provaDeData.find((x) => x.eixo === vencedora.data.id)?.comparados} ao minuto` },
  { etapa: "5b. populacao", descricao: vencedora.populacao.rotulo, valor: `${apVencedora.pedidos} pedidos` },
  { etapa: "5c. exclusoes", descricao: "cancel_code = pack_splitted", valor: `${pedidos.filter((p) => p.cancel_code === "pack_splitted" && dentroDoPeriodo(diaEmSaoPaulo(p.date_closed), DE, ATE)).length} pedidos fora` },
  { etapa: "6. valor", descricao: vencedora.valor.rotulo, valor: `R$ ${brl(apVencedora.total)}` },
  { etapa: "7. unidades", descricao: "soma de order_items[].quantity", valor: `${apVencedora.unidades}` },
  { etapa: "8. comparacao oficial", descricao: "relatorio detalhado baixado do ML, lido do arquivo", valor: `R$ ${brl(oficialValor)} / ${vendasOficiais.length} vendas / ${oficialUnidades} un` },
  { etapa: "9. conjunto", descricao: "oficial vs candidata, por order_id", valor: `so_oficial=${soNoOficial.length} so_candidata=${soNaCandidata.length}` },
  { etapa: "10. anti-vacuidade", descricao: "toda candidata ⊆ raw", valor: `${falhas.length} falhas` },
  { etapa: "11. painel", descricao: "leitura de tela, sem centavos", valor: `R$ ${brl(PAINEL_VENDAS_BRUTAS_EXIBIDO)}` },
];

const r1 = escreverXlsx(join(SAIDA, "ML_API_RAW_SETEMBRO_2026_R2.xlsx"), [
  { nome: "Orders_Raw_Normalized", colunas: colsRaw, linhas: linhasRaw },
  { nome: "Payments_Raw_Normalized", colunas: Object.keys(linhasPagamento[0] ?? { order_id: "" }), linhas: linhasPagamento },
  { nome: "Order_Items", colunas: Object.keys(linhasItem[0] ?? { order_id: "" }), linhas: linhasItem },
  {
    nome: "Controles_De_Borda",
    colunas: Object.keys(borda[0] ?? { order_id: "" }), linhas: borda,
  },
  {
    nome: "Metadata",
    colunas: ["item", "valor"],
    linhas: [
      { item: "gate", valor: "AGENT-FACTORY-F7b.4.8.4-R2" },
      { item: "coletado em", valor: coleta.coletadoEm },
      { item: "janela de criacao coletada", valor: `${coleta.criacaoDe} a ${coleta.criacaoAte}` },
      { item: "linhas lidas da API", valor: linhasBrutas.length },
      { item: "order_id unicos", valor: pedidos.length },
      { item: "pedidos nesta planilha", valor: linhasRaw.length },
      { item: "populacao", valor: "uniao de TODAS as candidatas (populacaoDoRaw), nao um filtro proprio" },
      { item: "fuso", valor: "toda decisao de periodo usa o dia JA convertido para America/Sao_Paulo" },
      { item: "CORRECAO R2", valor: "o R1 testava o dia como escrito no offset -04:00 do provedor e perdeu 2 pedidos de 31/08 23h que sao 01/09 em Sao Paulo" },
      { item: "falhas de anti-vacuidade", valor: falhas.length },
      { item: "pedidos na borda do fuso", valor: borda.length },
      { item: "nao contem", valor: "token, credencial, seller, comprador, endereco, titulo de anuncio" },
    ],
  },
]);

type LinhaDePedido = ReturnType<typeof linhaDePedido>;
const incluidos: LinhaDePedido[] = linhasRaw.filter((l) => l.candidata_incluiu === "SIM");
const excluidos: LinhaDePedido[] = linhasRaw.filter((l) => l.candidata_incluiu !== "SIM");
const porDia = (() => {
  const m = new Map<string, { dia: string; pedidos: number; unidades: number; total_amount: number; paid_amount: number }>();
  for (const l of incluidos) {
    const k = String(l.dia_fechamento_sao_paulo);
    const atual = m.get(k) ?? { dia: k, pedidos: 0, unidades: 0, total_amount: 0, paid_amount: 0 };
    atual.pedidos += 1;
    atual.unidades += l.unidades;
    atual.total_amount = cent(atual.total_amount + l.total_amount);
    atual.paid_amount = cent(atual.paid_amount + l.paid_amount);
    m.set(k, atual);
  }
  return [...m.values()].sort((a, b) => a.dia.localeCompare(b.dia));
})();
const comExcecao = (t: string): LinhaDePedido[] =>
  linhasRaw.filter((l) => l.excecoes.includes(t));
const suspeitos = [...linhasRaw]
  .map((l) => ({
    impacto: cent(Math.max(Math.abs(l.total_amount - l.paid_amount),
      Math.abs(l.soma_gross_price - l.total_amount), l.estornado)),
    ...l,
  }))
  .sort((a, b) => b.impacto - a.impacto).slice(0, 100);

const r2 = escreverXlsx(join(SAIDA, "AGENTE_CALCULO_SETEMBRO_2026_R2.xlsx"), [
  {
    nome: "Resumo",
    colunas: ["indicador", "regra_de_hoje", "candidata_vencedora", "oficial_detalhado", "fonte"],
    linhas: [
      { indicador: "candidata_id", regra_de_hoje: BASE_ID, candidata_vencedora: vencedoraId, oficial_detalhado: "", fonte: "pericia-ml-periodo.ts" },
      { indicador: "Valor (R$)", regra_de_hoje: cent(apBase.total), candidata_vencedora: cent(apVencedora.total), oficial_detalhado: oficialValor, fonte: "derivado" },
      { indicador: "Pedidos", regra_de_hoje: apBase.pedidos, candidata_vencedora: apVencedora.pedidos, oficial_detalhado: vendasOficiais.length, fonte: "derivado" },
      { indicador: "Unidades", regra_de_hoje: apBase.unidades, candidata_vencedora: apVencedora.unidades, oficial_detalhado: oficialUnidades, fonte: "derivado" },
      { indicador: "Medio por venda", regra_de_hoje: cent(apBase.medioPorVenda), candidata_vencedora: cent(apVencedora.medioPorVenda), oficial_detalhado: cent(oficialMedioVenda), fonte: "derivado" },
      { indicador: "Medio por unidade", regra_de_hoje: cent(apBase.medioPorUnidade), candidata_vencedora: cent(apVencedora.medioPorUnidade), oficial_detalhado: cent(oficialMedioUnidade), fonte: "derivado" },
      { indicador: "", regra_de_hoje: "", candidata_vencedora: "", oficial_detalhado: "", fonte: "" },
      { indicador: "REGRA DE VALOR", regra_de_hoje: "soma de order.paid_amount", candidata_vencedora: vencedora.valor.rotulo, oficial_detalhado: "Unidades x Preco unitario de venda", fonte: "" },
      { indicador: "REGRA DE DATA", regra_de_hoje: "payments[].date_approved mais antigo -> America/Sao_Paulo", candidata_vencedora: vencedora.data.rotulo, oficial_detalhado: "Data de venda", fonte: "" },
      { indicador: "POPULACAO", regra_de_hoje: "so quem tem pagamento approved/partially_refunded", candidata_vencedora: vencedora.populacao.rotulo, oficial_detalhado: "linhas com Unidades preenchida", fonte: "" },
      { indicador: "ESTORNO", regra_de_hoje: "nao desconta", candidata_vencedora: "nao desconta", oficial_detalhado: "", fonte: "" },
      { indicador: "CANCELAMENTO", regra_de_hoje: "nao olha order.status", candidata_vencedora: "inclui cancelado; exclui so pack_splitted", oficial_detalhado: "", fonte: "" },
      { indicador: "", regra_de_hoje: "", candidata_vencedora: "", oficial_detalhado: "", fonte: "" },
      { indicador: "ATENCAO", regra_de_hoje: "a regra financeira do agente NAO foi alterada neste gate", candidata_vencedora: "", oficial_detalhado: "", fonte: "" },
    ],
  },
  { nome: "Calculo_Por_Pedido", colunas: colsRaw, linhas: linhasRaw },
  { nome: "Calculo_Por_Dia", colunas: ["dia", "pedidos", "unidades", "total_amount", "paid_amount"], linhas: porDia },
  { nome: "Incluidos", colunas: colsRaw, linhas: incluidos },
  { nome: "Excluidos", colunas: colsRaw, linhas: excluidos },
  { nome: "Virada_de_Mes", colunas: Object.keys(borda[0] ?? { order_id: "" }), linhas: borda },
  { nome: "Multiplos_Pagamentos", colunas: colsRaw, linhas: comExcecao("multiplos_pagamentos") },
  { nome: "Reembolsos_Parciais", colunas: colsRaw, linhas: comExcecao("estorno_parcial") },
  { nome: "Reembolsos_Totais", colunas: colsRaw, linhas: comExcecao("estorno_total") },
  { nome: "Cancelados", colunas: colsRaw, linhas: comExcecao("cancelado:") },
  { nome: "Paid_vs_Total", colunas: colsRaw, linhas: comExcecao("paid!=total") },
  { nome: "Chargeback", colunas: colsRaw, linhas: comExcecao("chargeback") },
  { nome: "Mediacao", colunas: colsRaw, linhas: comExcecao("mediacao") },
  { nome: "Pedidos_Suspeitos", colunas: ["impacto", ...colsRaw], linhas: suspeitos },
  {
    nome: "Prova_Dos_Dois_Pedidos",
    colunas: Object.keys(provaDosDois[0] ?? { order_id: "" }), linhas: provaDosDois,
  },
]);

const r3 = escreverXlsx(join(SAIDA, "RECONCILIACAO_ML_SETEMBRO_2026_R2.xlsx"), [
  {
    nome: "Lineage",
    colunas: ["etapa", "descricao", "valor"], linhas: linhagem,
  },
  {
    nome: "Oficial_vs_Painel",
    colunas: ["metrica", "valor", "origem"],
    linhas: [
      { metrica: "OFFICIAL_DETAILED_EXPORT", valor: oficialValor, origem: "derivado do .xlsx baixado do Mercado Livre" },
      { metrica: "PANEL_HEADLINE", valor: PAINEL_VENDAS_BRUTAS_EXIBIDO, origem: "leitura de tela; o painel nao mostra centavos" },
      { metrica: "DELTA", valor: cent(oficialValor - PAINEL_VENDAS_BRUTAS_EXIBIDO), origem: "calculado" },
      { metrica: "PANEL_HEADLINE_RECONCILIATION", valor: "PARTIAL", origem: "nao ha evidencia objetiva que explique o delta; nenhuma regra de arredondamento foi inventada" },
      { metrica: "", valor: "", origem: "" },
      { metrica: "Vendas (oficial detalhado)", valor: vendasOficiais.length, origem: "linhas com Unidades preenchida" },
      { metrica: "Linhas no oficial", valor: todasAsLinhas.length, origem: "derivado" },
      { metrica: "Linhas-cabecalho de pacote", valor: cabecalhosDePacote.length, origem: "Unidades e Preco vazios" },
      { metrica: "Unidades (oficial)", valor: oficialUnidades, origem: "derivado" },
      { metrica: "Medio por venda (oficial)", valor: cent(oficialMedioVenda), origem: "derivado" },
      { metrica: "Medio por unidade (oficial)", valor: cent(oficialMedioUnidade), origem: "derivado" },
      { metrica: "PANEL_CANCELADAS", valor: PAINEL_CANCELADAS_EXIBIDO, origem: "leitura de tela" },
      { metrica: "Canceladas no oficial (estados com 'cancel')", valor: canceladasOficial, origem: "derivado" },
      { metrica: "DELTA canceladas", valor: PAINEL_CANCELADAS_EXIBIDO - canceladasOficial, origem: "calculado" },
      { metrica: "CANCELLED_SALES_SEMANTICS", valor: "PARTIAL", origem: "nenhuma combinacao artificial foi usada para fechar o painel" },
    ],
  },
  {
    nome: "Totais_Candidatos",
    colunas: ["candidata_id", "eixo_data", "eixo_populacao", "eixo_valor", "total", "pedidos",
      "unidades", "medio_por_venda", "medio_por_unidade", "vs_oficial_valor",
      "so_no_oficial", "so_na_candidata", "nota"],
    linhas: ranking.map((n) => {
      const a = apuracaoPorId.get(n.candidataId) as Apuracao;
      const c = porCandidata.get(n.candidataId) as Candidata;
      return {
        candidata_id: n.candidataId, eixo_data: c.data.id,
        eixo_populacao: c.populacao.id, eixo_valor: c.valor.id,
        total: cent(a.total), pedidos: a.pedidos, unidades: a.unidades,
        medio_por_venda: cent(a.medioPorVenda), medio_por_unidade: cent(a.medioPorUnidade),
        vs_oficial_valor: cent(oficialValor - a.total),
        so_no_oficial: n.soNoOficial, so_na_candidata: n.soNaCandidata,
        nota: `${n.nota}/4`,
      };
    }),
  },
  {
    nome: "Metricas_Cruzadas",
    colunas: ["indicador", "oficial_detalhado", "candidata_vencedora", "regra_de_hoje", "veredito", "candidata_id"],
    linhas: [
      { indicador: "Valor (R$)", oficial_detalhado: oficialValor, candidata_vencedora: cent(apVencedora.total), regra_de_hoje: cent(apBase.total), veredito: Math.abs(cent(apVencedora.total) - oficialValor) < 0.005 ? "IGUAL" : `difere ${cent(oficialValor - apVencedora.total)}`, candidata_id: vencedoraId },
      { indicador: "Pedidos", oficial_detalhado: vendasOficiais.length, candidata_vencedora: apVencedora.pedidos, regra_de_hoje: apBase.pedidos, veredito: apVencedora.pedidos === vendasOficiais.length ? "IGUAL" : `difere ${vendasOficiais.length - apVencedora.pedidos}`, candidata_id: vencedoraId },
      { indicador: "Unidades", oficial_detalhado: oficialUnidades, candidata_vencedora: apVencedora.unidades, regra_de_hoje: apBase.unidades, veredito: apVencedora.unidades === oficialUnidades ? "IGUAL" : `difere ${oficialUnidades - apVencedora.unidades}`, candidata_id: vencedoraId },
      { indicador: "Medio por venda", oficial_detalhado: cent(oficialMedioVenda), candidata_vencedora: cent(apVencedora.medioPorVenda), regra_de_hoje: cent(apBase.medioPorVenda), veredito: Math.abs(apVencedora.medioPorVenda - oficialMedioVenda) < 0.005 ? "IGUAL" : "difere", candidata_id: vencedoraId },
      { indicador: "Medio por unidade", oficial_detalhado: cent(oficialMedioUnidade), candidata_vencedora: cent(apVencedora.medioPorUnidade), regra_de_hoje: cent(apBase.medioPorUnidade), veredito: Math.abs(apVencedora.medioPorUnidade - oficialMedioUnidade) < 0.005 ? "IGUAL" : "difere", candidata_id: vencedoraId },
      { indicador: "official_orders_minus_candidate", oficial_detalhado: "", candidata_vencedora: soNoOficial.length, regra_de_hoje: "", veredito: soNoOficial.length === 0 ? "ZERO" : "FALHA", candidata_id: vencedoraId },
      { indicador: "candidate_minus_official_orders", oficial_detalhado: "", candidata_vencedora: soNaCandidata.length, regra_de_hoje: "", veredito: soNaCandidata.length === 0 ? "ZERO" : "FALHA", candidata_id: vencedoraId },
      { indicador: "missing_candidate_orders_from_raw", oficial_detalhado: "", candidata_vencedora: faltandoNoRaw.length, regra_de_hoje: "", veredito: faltandoNoRaw.length === 0 ? "ZERO" : "FALHA", candidata_id: vencedoraId },
      ...provaDeData.map((p) => ({
        indicador: `Data ao minuto — ${p.eixo}`, oficial_detalhado: p.comparados,
        candidata_vencedora: p.batem, regra_de_hoje: "",
        veredito: p.comparados > 0 && p.batem === p.comparados ? "100%" :
          `${p.comparados === 0 ? 0 : ((p.batem / p.comparados) * 100).toFixed(2)}%`,
        candidata_id: `${p.eixo}|todos|total_amount`,
      })),
    ],
  },
  {
    nome: "Categorias_Divergencia",
    colunas: ["passo", "candidata_id", "total", "pedidos", "unidades", "delta_valor", "delta_pedidos"],
    linhas: [
      ...passos.map((p) => ({
        passo: p.rotulo, candidata_id: p.id, total: cent(p.total),
        pedidos: p.pedidos, unidades: p.unidades,
        delta_valor: cent(p.deltaValor), delta_pedidos: p.deltaPedidos,
      })),
      { passo: "", candidata_id: "", total: "", pedidos: "", unidades: "", delta_valor: "", delta_pedidos: "" },
      ...isolados.map((i) => ({
        passo: `eixo isolado: ${i.eixo}`, candidata_id: i.id, total: cent(i.total),
        pedidos: i.pedidos, unidades: "", delta_valor: cent(i.delta), delta_pedidos: "",
      })),
      { passo: "", candidata_id: "", total: "", pedidos: "", unidades: "", delta_valor: "", delta_pedidos: "" },
      { passo: "DIVERGENCIA da regra de hoje vs oficial", candidata_id: BASE_ID, total: "", pedidos: "", unidades: "", delta_valor: cent(divergenciaInicial), delta_pedidos: vendasOficiais.length - apBase.pedidos },
      { passo: "RESIDUO da candidata vencedora vs oficial", candidata_id: vencedoraId, total: "", pedidos: "", unidades: "", delta_valor: cent(residuo), delta_pedidos: vendasOficiais.length - apVencedora.pedidos },
    ],
  },
  {
    nome: "Prova_Dos_Dois_Pedidos",
    colunas: Object.keys(provaDosDois[0] ?? { order_id: "" }), linhas: provaDosDois,
  },
  {
    nome: "Anti_Vacuidade",
    colunas: ["controle", "resultado"],
    linhas: [
      { controle: "candidatas conferidas", resultado: apuracoes.length },
      { controle: "pedidos no raw", resultado: idsNoRaw.size },
      { controle: "falhas de cobertura (qualquer candidata)", resultado: falhas.length },
      { controle: `missing_from_raw na candidata ${vencedoraId}`, resultado: falhaNaObrigatoria },
      { controle: "pedidos na borda do fuso", resultado: borda.length },
      { controle: "dos quais trocam de MES", resultado: borda.filter((b) => b.dentro_pelo_escrito !== b.dentro_pelo_sao_paulo).length },
      { controle: "o gerador aborta se houver falha", resultado: "SIM — process.exit(1) antes de escrever planilha" },
    ],
  },
  {
    nome: "Checklist_Para_Rodrigo",
    colunas: ["ordem", "o_que_conferir", "onde", "resultado_medido"],
    linhas: [
      { ordem: 1, o_que_conferir: "o valor, a contagem e as unidades batem com o relatorio oficial", onde: "Metricas_Cruzadas", resultado_medido: `R$ ${brl(apVencedora.total)} / ${apVencedora.pedidos} / ${apVencedora.unidades}` },
      { ordem: 2, o_que_conferir: "os conjuntos sao identicos, pedido por pedido", onde: "Metricas_Cruzadas", resultado_medido: `so_oficial=${soNoOficial.length} so_candidata=${soNaCandidata.length}` },
      { ordem: 3, o_que_conferir: "os dois pedidos que faltavam no R1 agora entram", onde: "Prova_Dos_Dois_Pedidos", resultado_medido: provaDosDois.every((d) => d.na_candidata_vencedora === "SIM" && d.no_raw_r2 === "SIM") ? "os dois entram" : "AINDA FALTAM" },
      { ordem: 4, o_que_conferir: "a data bate ao minuto com o oficial", onde: "Metricas_Cruzadas, linhas 'Data ao minuto'", resultado_medido: `${provaDeData.find((x) => x.eixo === vencedora.data.id)?.batem}/${provaDeData.find((x) => x.eixo === vencedora.data.id)?.comparados}` },
      { ordem: 5, o_que_conferir: "nenhuma candidata soma pedido ausente do raw", onde: "Anti_Vacuidade", resultado_medido: `${falhas.length} falhas` },
      { ordem: 6, o_que_conferir: "o delta contra o painel segue sem explicacao", onde: "Oficial_vs_Painel", resultado_medido: `R$ ${brl(cent(oficialValor - PAINEL_VENDAS_BRUTAS_EXIBIDO))} — PARTIAL` },
      { ordem: 7, o_que_conferir: "as canceladas do painel seguem sem fechar", onde: "Oficial_vs_Painel", resultado_medido: `${canceladasOficial} medido x ${PAINEL_CANCELADAS_EXIBIDO} no painel` },
      { ordem: 8, o_que_conferir: "a regra financeira do agente NAO mudou", onde: "Resumo do AGENTE_CALCULO", resultado_medido: "intacta; a candidata e proposta, nao implementacao" },
    ],
  },
]);

// ═══ 11. O JSON de linhagem ════════════════════════════════════════

writeFileSync(join(ORIGEM, "analise-r2.json"), JSON.stringify({
  geradoEm: new Date().toISOString(),
  periodo: { de: DE, ate: ATE },
  painelObservado: {
    vendasBrutas: PAINEL_VENDAS_BRUTAS_EXIBIDO,
    canceladas: PAINEL_CANCELADAS_EXIBIDO,
  },
  oficialDerivado: {
    arquivo: OFICIAL,
    linhas: todasAsLinhas.length,
    cabecalhosDePacote: cabecalhosDePacote.length,
    vendas: vendasOficiais.length,
    unidades: oficialUnidades,
    valor: oficialValor,
    medioPorVenda: oficialMedioVenda,
    medioPorUnidade: oficialMedioUnidade,
    canceladasPorEstado: estadosDeCancelamento,
  },
  vencedoraId, ranking, apuracoes: apuracoes.map((a) => ({ ...a, ids: a.ids.length })),
  passos, isolados, divergenciaInicial, residuo,
  conjuntos: { soNoOficial: soNoOficial.length, soNaCandidata: soNaCandidata.length, faltandoNoRaw: faltandoNoRaw.length },
  provaDeData, provaDosDois, falhasDeCobertura: falhas,
  raw: { pedidos: idsNoRaw.size, borda: borda.length },
}, null, 2), "utf8");

console.log("\n10. PLANILHAS R2");
console.log(`   ${SAIDA}`);
console.log(`   ML_API_RAW_SETEMBRO_2026_R2.xlsx        ${r1.abas} abas  ${(r1.bytes / 1024 / 1024).toFixed(2)} MB`);
console.log(`   AGENTE_CALCULO_SETEMBRO_2026_R2.xlsx    ${r2.abas} abas  ${(r2.bytes / 1024 / 1024).toFixed(2)} MB`);
console.log(`   RECONCILIACAO_ML_SETEMBRO_2026_R2.xlsx  ${r3.abas} abas  ${(r3.bytes / 1024 / 1024).toFixed(2)} MB`);
