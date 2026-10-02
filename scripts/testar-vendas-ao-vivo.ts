/**
 * CDS IA — painel "Vendas ao vivo" (F8.2-A, ampliado no F8.2-B).
 *
 * Prova: (1) o resumo COPIA a camada deterministica de vendas do ML —
 * sem LLM; (2) o corte por horario mora NA camada (mesmo `date_closed`)
 * e, ausente, nao muda nada; (3) hoje x ontem compara janelas iguais;
 * (4) o transporte valida campo a campo; (5) erro preserva o ultimo
 * retrato bom; (6) o ciclo de 10 min nunca tem duas leituras em voo;
 * (7) o painel e global e so FORMATA. Valores sinteticos.
 *
 * Rodar: npx tsx scripts/testar-vendas-ao-vivo.ts
 */
import "./_env-inerte";
import "./_server-only-inerte";

import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  comparativoDoResultado, corteDeOntemMs, lojaAoVivoDoResultado, nomeDaLoja, variacao,
  PERIODO_AO_VIVO, PERIODO_COMPARADO,
} from "@/lib/agentes/dados/vendas-ao-vivo";
import { criarLeiturasDeVendasML, type ResultadoVendasML } from "@/lib/agentes/dados/vendas-ml";
import { lerVendasAoVivo, vendasAoVivoDaResposta, type RespostaVendasAoVivo } from "@/lib/ia/agentes-http";
import {
  INTERVALO_AO_VIVO_MS, LIMITE_DESATUALIZADO_MS, MEMORIA_INICIAL,
  aplicarResposta, criarCicloAoVivo, estadoAoVivo, haQuantoTempo, type RelogioDoCiclo,
} from "@/lib/ia/vendas-ao-vivo";

let passou = 0;
let falhou = 0;
const ok = (nome: string, cond: boolean, det = ""): void => {
  if (cond) { passou += 1; console.log(`  PASS  ${nome}`); }
  else { falhou += 1; console.log(`  FAIL  ${nome}${det ? `  — ${det}` : ""}`); }
};
const secao = (t: string) =>
  console.log(`\n── ${t} ${"─".repeat(Math.max(2, 58 - t.length))}`);
const RAIZ = join(__dirname, "..");
const ler = (rel: string) => readFileSync(join(RAIZ, rel), "utf8").replace(/\r\n/g, "\n");
const semComentario = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
const semStrings = (s: string) => s.replace(/"[^"\n]*"|`[^`]*`/g, '""');

// ticketMedio NAO e valor/vendas de proposito: so passa se for COPIADO.
const BRUTAS = { valor: 777.77, vendas: 6, unidades: 8, ticketMedio: 99.99 };
function resultado(extra: Partial<ResultadoVendasML> = {}): ResultadoVendasML {
  return {
    vendasBrutas: BRUTAS,
    porDia: [{ dia: "2026-10-02", valor: 777.77, vendas: 6, unidades: 8 }],
    periodo: { de: "2026-10-02", ate: "2026-10-02", rotulo: "hoje", fuso: "America/Sao_Paulo" },
    fonte: "mercadolivre_api",
    completo: true,
    truncado: false,
    parcial: null,
    diagnostico: {
      paginasLidas: 1, recebidosDoProvider: 6, foraDoPeriodo: 0, duplicadosDescartados: 0,
      excluidosPackSplitted: 0, divergenciasDeValor: 0, campoDeData: "order.date_closed",
    },
    erro: null,
    ...extra,
  } as ResultadoVendasML;
}
const ONTEM_BRUTAS = { valor: 500, vendas: 4, unidades: 8, ticketMedio: 125 };
const rOntem = (extra: Partial<ResultadoVendasML> = {}) => resultado({
  vendasBrutas: ONTEM_BRUTAS,
  periodo: { de: "2026-10-01", ate: "2026-10-01", rotulo: "ontem", fuso: "America/Sao_Paulo" },
  ...extra,
});

const lojaOk = {
  nome: "Loja X", estado: "ok", periodo: { de: "2026-10-02", ate: "2026-10-02" },
  kpis: { valor: 777.77, vendas: 6, unidades: 8, ticketMedio: 99.99 },
  comparativo: null as unknown,
};
const corpoOk = (lojas: unknown[], configurado = true) => ({
  ok: true, geradoEm: "2026-10-02T12:40:00.000Z",
  corteHoje: "2026-10-02T12:40:00.000Z", corteOntem: "2026-10-01T12:40:00.000Z",
  marketplaces: [{ marketplace: "mercadolivre", configurado, lojas }],
});

// ── Provedor ML falso: responde por janela de `order.date_closed` ────
const CREDENCIAL = { accessToken: "t", sellerId: "1", id: "loja", userId: "dono" } as never;
function provedor(pedidos: readonly { id: number; date_closed: string; total: number; qtd: number }[]) {
  const buscar: typeof fetch = async (entrada) => {
    const url = new URL(String(entrada));
    const inicio = new Date(url.searchParams.get("order.date_closed.from") ?? "").getTime();
    const fim = new Date(url.searchParams.get("order.date_closed.to") ?? "").getTime();
    const offset = Number(url.searchParams.get("offset") ?? "0");
    const doDia = pedidos.filter((p) => {
      const t = new Date(p.date_closed).getTime();
      return t >= inicio && t <= fim;
    });
    const lote = doDia.slice(offset, offset + 51).map((p) => ({
      id: p.id, status: "paid", date_created: p.date_closed, date_closed: p.date_closed,
      total_amount: p.total, paid_amount: p.total, cancel_detail: null,
      order_items: [{ quantity: p.qtd, unit_price: p.total / p.qtd }],
    }));
    return new Response(JSON.stringify({ paging: { total: doDia.length }, results: lote }), {
      status: 200, headers: { "Content-Type": "application/json" },
    });
  };
  return { resolverCredencial: async () => CREDENCIAL, buscar };
}

async function main(): Promise<void> {
  console.log("\n══ CDS IA — Vendas ao vivo (F8.2-A/B) ══");
  const logOriginal = console.log;

  // =====================================================================
  secao("A. Resumo da loja: copia a camada ML");
  const a = lojaAoVivoDoResultado("Loja X", resultado());
  ok("A1  completo -> ok", a.estado === "ok");
  if (a.estado === "ok") {
    ok("A2  os 4 valores copiados exatamente",
      a.kpis.valor === BRUTAS.valor && a.kpis.vendas === BRUTAS.vendas &&
        a.kpis.unidades === BRUTAS.unidades && a.kpis.ticketMedio === BRUTAS.ticketMedio);
    ok("A3  ticket medio e o RECEBIDO, nao valor/vendas", a.kpis.ticketMedio !== BRUTAS.valor / BRUTAS.vendas);
    ok("A4  sem leitura de ontem -> comparativo null", a.comparativo === null);
    ok("A5  nada de porDia/diagnostico no bloco", !/porDia|diagnostico|date_closed/.test(JSON.stringify(a)));
  }
  ok("A6  incompleto -> sem numero",
    lojaAoVivoDoResultado("L", resultado({ completo: false, vendasBrutas: null })).estado === "incompleto");
  ok("A7  erro -> sem numero",
    lojaAoVivoDoResultado("L", resultado({ erro: "credencial_ausente" as never })).estado === "erro");
  ok("A8  nome: loja > nickname > generico",
    nomeDaLoja({ nome: "LOJA TESTE", nickname: "x" }) === "LOJA TESTE" &&
      nomeDaLoja({ nome: null, nickname: "nick" }) === "nick" &&
      nomeDaLoja({ nome: " ", nickname: null }) === "Mercado Livre");

  // =====================================================================
  secao("B. Hoje x ontem no MESMO horario");
  const AGORA = Date.parse("2026-10-02T09:40:00-03:00");
  ok("B1  corte de ontem = mesmo horario, um dia antes (SP sem horario de verao)",
    corteDeOntemMs(AGORA) === Date.parse("2026-10-01T09:40:00-03:00"));
  ok("B2  periodos pedidos a camada: 'hoje' e 'ontem'",
    PERIODO_AO_VIVO === "hoje" && PERIODO_COMPARADO === "ontem");
  const c = lojaAoVivoDoResultado("L", resultado(), rOntem());
  ok("B3  com ontem completo -> comparativo presente", c.estado === "ok" && c.comparativo !== null);
  if (c.estado === "ok" && c.comparativo !== null) {
    const cmp = c.comparativo;
    ok("B4  valores de ontem COPIADOS", cmp.ontem.valor === 500 && cmp.ontem.vendas === 4 &&
      cmp.ontem.unidades === 8 && cmp.ontem.ticketMedio === 125);
    ok("B5  delta absoluto (centavos)", cmp.variacao.valor.delta === 277.77);
    ok("B6  delta % sobre ontem, 1 casa", cmp.variacao.valor.pct === 55.6, String(cmp.variacao.valor.pct));
    ok("B7  pedidos: +2 / +50%", cmp.variacao.vendas.delta === 2 && cmp.variacao.vendas.pct === 50);
    ok("B8  unidades iguais: 0 / 0%", cmp.variacao.unidades.delta === 0 && cmp.variacao.unidades.pct === 0);
    ok("B9  ticket: queda com sinal", cmp.variacao.ticketMedio.delta === -25.01 &&
      cmp.variacao.ticketMedio.pct === -20);
    ok("B10 progresso do medidor = hoje/ontem (3 casas), calculado no servidor",
      cmp.progressoValor === 1.556, String(cmp.progressoValor));
    ok("B11 periodo de ontem copiado", cmp.periodoOntem.de === "2026-10-01");
  }
  ok("B12 ontem incompleto -> comparativo null (sem comparar parcial)",
    comparativoDoResultado(BRUTAS, rOntem({ completo: false, vendasBrutas: null })) === null);
  ok("B13 ontem com erro -> comparativo null",
    comparativoDoResultado(BRUTAS, rOntem({ erro: "limite_de_taxa" as never })) === null);
  const zero = comparativoDoResultado(BRUTAS, rOntem({ vendasBrutas: { valor: 0, vendas: 0, unidades: 0, ticketMedio: 0 } }));
  ok("B14 ontem zero -> pct null e progresso null (sem base)",
    zero !== null && zero.variacao.valor.pct === null && zero.progressoValor === null &&
      zero.variacao.valor.delta === 777.77);
  ok("B15 variacao monetaria arredonda centavos; contagem nao",
    variacao(0.3, 0.1, true).delta === 0.2 && variacao(3, 1, false).delta === 2);

  // =====================================================================
  secao("C. Corte por horario NA camada ML (mesmo date_closed)");
  const PEDIDOS = [
    { id: 1, date_closed: "2026-10-01T08:00:00.000-03:00", total: 100, qtd: 1 },
    { id: 2, date_closed: "2026-10-01T09:40:00.000-03:00", total: 50, qtd: 2 },
    { id: 3, date_closed: "2026-10-01T11:00:00.000-03:00", total: 70, qtd: 1 },
  ];
  console.log = () => {}; // a camada loga uma linha de observabilidade por consulta
  const semCorte = await criarLeiturasDeVendasML("dono", "loja", AGORA, undefined, provedor(PEDIDOS))(
    { periodo: "ontem" });
  const comCorte = await criarLeiturasDeVendasML("dono", "loja", AGORA, undefined, provedor(PEDIDOS),
    { ateInstanteMs: corteDeOntemMs(AGORA) })({ periodo: "ontem" });
  console.log = logOriginal;
  ok("C1  SEM corte: o dia inteiro, como sempre (3 pedidos, R$ 220)",
    semCorte.vendasBrutas?.vendas === 3 && semCorte.vendasBrutas?.valor === 220,
    JSON.stringify(semCorte.vendasBrutas));
  ok("C2  COM corte 09:40: so ate o mesmo horario (2 pedidos, R$ 150)",
    comCorte.vendasBrutas?.vendas === 2 && comCorte.vendasBrutas?.valor === 150,
    JSON.stringify(comCorte.vendasBrutas));
  ok("C3  o pedido exatamente no corte conta (<=)", comCorte.vendasBrutas?.unidades === 3);
  ok("C4  o cortado vira borda (foraDoPeriodo), nao some calado",
    comCorte.diagnostico.foraDoPeriodo === semCorte.diagnostico.foraDoPeriodo + 1);
  ok("C5  ticket medio continua sendo o da camada", comCorte.vendasBrutas?.ticketMedio === 75);
  const ML = semComentario(ler("lib/mercado-livre-vendas.ts"));
  ok("C6  FONTE: o corte usa o MESMO date_closed, depois do recorte por dia",
    /const dia = diaEmSaoPaulo\(o\.date_closed\);[\s\S]{0,400}entrada\.ateInstanteMs !== undefined[\s\S]{0,200}Date\.parse\(o\.date_closed\)/.test(ML));
  const MLD = semComentario(ler("lib/agentes/dados/vendas-ml.ts"));
  ok("C7  FONTE: o filtro do MODELO nao ganhou campo de corte",
    !/ateInstanteMs/.test(MLD.slice(MLD.indexOf("export interface FiltroVendasML"),
      MLD.indexOf("}", MLD.indexOf("export interface FiltroVendasML")))));
  const TOOL = semComentario(ler("lib/agentes/funcoes/mercadolivre-vendas.ts"));
  ok("C8  FONTE: a Tool nao passa corte", !/ateInstanteMs|corte/.test(TOOL));

  // =====================================================================
  secao("D. Rota: camada deterministica, ZERO LLM");
  const codRota = semComentario(ler("app/api/ia/vendas-ao-vivo/route.ts"));
  ok("D1  hoje cortado em AGORA, ontem no mesmo horario",
    /criarLeiturasDeVendasML\(\s*auth\.uid, loja\.id, agora, undefined, undefined, \{ ateInstanteMs: agora \}\)/.test(codRota) &&
      /\{ ateInstanteMs: corteDeOntemMs\(agora\) \}/.test(codRota));
  ok("D2  as duas leituras em paralelo, com o mesmo agora",
    /Promise\.all\(\[\s*lerHoje\(\{ periodo: PERIODO_AO_VIVO \}\),[\s\S]*lerOntem\(\{ periodo: PERIODO_COMPARADO \}\)/.test(codRota));
  ok("D3  ontem que falha nao derruba hoje", /lerOntem\([^)]*\)\.catch\(\(\) => null\)/.test(codRota));
  ok("D4  sem import de IA/agente/conversa/laco",
    !/ai-gateway|laco-ferramentas|conversas|anthropic|openai|gemini|adaptador|executarFuncao/i.test(codRota));
  ok("D5  sem conta sobre os KPIs na rota",
    !/(valor|vendas|unidades|ticketMedio)\s*[-+*/]/.test(semStrings(codRota)));
  ok("D6  sem Shopee simulado", !/shopee/i.test(codRota));
  await import("@/app/api/ia/vendas-ao-vivo/route");
  const carregados = Object.keys(require.cache).map((k) => k.replace(/\\/g, "/"));
  const iaNoGrafo = carregados.filter((k) =>
    /lib\/ai-gateway\/|lib\/agentes\/ia\/|lib\/agentes\/conversas\/|execucao-funcoes/.test(k));
  ok("D7  GRAFO: importar a rota nao carrega ai-gateway/laco/conversas/executor",
    carregados.some((k) => k.includes("vendas-ao-vivo/route")) && iaNoGrafo.length === 0,
    iaNoGrafo.join(", "));

  // =====================================================================
  secao("E. Transporte: validacao campo a campo");
  const cmpOk = lojaAoVivoDoResultado("Loja X", resultado(), rOntem());
  const v = vendasAoVivoDaResposta(corpoOk([JSON.parse(JSON.stringify(cmpOk))]));
  ok("E1  aceita resposta com comparativo", v !== null && v.marketplaces[0].lojas[0].estado === "ok");
  ok("E2  comparativo atravessa intacto",
    v !== null && v.marketplaces[0].lojas[0].estado === "ok" &&
      JSON.stringify(v.marketplaces[0].lojas[0].comparativo) === JSON.stringify((cmpOk as { comparativo: unknown }).comparativo));
  ok("E3  aceita comparativo null", vendasAoVivoDaResposta(corpoOk([lojaOk])) !== null);
  ok("E4  aceita loja incompleto/erro",
    vendasAoVivoDaResposta(corpoOk([{ nome: "L", estado: "incompleto" }, { nome: "M", estado: "erro" }])) !== null);
  ok("E5  cortes atravessam", v?.corteHoje === "2026-10-02T12:40:00.000Z" && v?.corteOntem === "2026-10-01T12:40:00.000Z");
  const cmpBase = JSON.parse(JSON.stringify((cmpOk as { comparativo: unknown }).comparativo));
  const tortos: [string, unknown][] = [
    ["kpi string", corpoOk([{ ...lojaOk, kpis: { ...lojaOk.kpis, valor: "777" } }])],
    ["sem cortes", { ...corpoOk([lojaOk]), corteHoje: undefined }],
    ["comparativo sem ontem", corpoOk([{ ...lojaOk, comparativo: { ...cmpBase, ontem: undefined } }])],
    ["variacao pct string", corpoOk([{ ...lojaOk, comparativo: { ...cmpBase,
      variacao: { ...cmpBase.variacao, valor: { delta: 1, pct: "5" } } } }])],
    ["progresso string", corpoOk([{ ...lojaOk, comparativo: { ...cmpBase, progressoValor: "1.5" } }])],
    ["estado desconhecido", corpoOk([{ nome: "L", estado: "parcial" }])],
    ["marketplace desconhecido", { ...corpoOk([]), marketplaces: [{ marketplace: "amazon", configurado: true, lojas: [] }] }],
  ];
  for (const [rotulo, corpo] of tortos) {
    ok(`E6  rejeita: ${rotulo}`, vendasAoVivoDaResposta(JSON.parse(JSON.stringify(corpo))) === null);
  }
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response("{}", { status: 401 })) as typeof fetch;
  ok("E7  401 -> nao_autenticado", (await lerVendasAoVivo()).estado === "nao_autenticado");
  globalThis.fetch = (async () => new Response(JSON.stringify(corpoOk([lojaOk])), { status: 200 })) as typeof fetch;
  ok("E8  200 valido -> ok", (await lerVendasAoVivo()).estado === "ok");
  globalThis.fetch = original;

  // =====================================================================
  secao("F. Estado: erro preserva o ultimo retrato bom");
  const T0 = 1_000_000;
  const okR: RespostaVendasAoVivo = { estado: "ok", dados: v! };
  ok("F1  inicio: LOADING", estadoAoVivo(MEMORIA_INICIAL, T0) === "LOADING");
  ok("F2  falha sem retrato: ERROR",
    estadoAoVivo(aplicarResposta(MEMORIA_INICIAL, { estado: "falha" }, T0), T0) === "ERROR");
  const bom = aplicarResposta(MEMORIA_INICIAL, okR, T0);
  ok("F3  retrato bom: OK", estadoAoVivo(bom, T0 + 1000) === "OK");
  const depoisDaFalha = aplicarResposta(bom, { estado: "falha" }, T0 + 5000);
  ok("F4  falha DEPOIS de dado bom: retrato mantido",
    depoisDaFalha.retrato === bom.retrato && depoisDaFalha.obtidoEmMs === T0);
  ok("F5  ...e o painel fica STALE", estadoAoVivo(depoisDaFalha, T0 + 5000) === "STALE");
  ok("F6  velho demais: STALE", estadoAoVivo(bom, T0 + LIMITE_DESATUALIZADO_MS + 1) === "STALE");
  const naoConf = aplicarResposta(MEMORIA_INICIAL,
    { estado: "ok", dados: vendasAoVivoDaResposta(corpoOk([], false))! }, T0);
  ok("F7  sem loja ML: NOT_CONFIGURED", estadoAoVivo(naoConf, T0) === "NOT_CONFIGURED");
  ok("F8  'atualizado ha X'", haQuantoTempo(T0, T0 + 30_000) === "agora" &&
    haQuantoTempo(T0, T0 + 12 * 60_000) === "há 12 min");

  // =====================================================================
  secao("G. Ciclo de 10 min: nunca duas leituras em voo");
  const timers: { fn: () => void; ms: number; id: number }[] = [];
  let seq = 0;
  const relogio: RelogioDoCiclo = {
    agendar: (fn, ms) => { seq += 1; timers.push({ fn, ms, id: seq }); return seq; },
    cancelar: (id) => { const i = timers.findIndex((t) => t.id === id); if (i >= 0) timers.splice(i, 1); },
  };
  let leituras = 0;
  let resolver: ((r: RespostaVendasAoVivo) => void) | null = null;
  const respostas: RespostaVendasAoVivo[] = [];
  let ultimoSinal: AbortSignal | null = null;
  const ciclo = criarCicloAoVivo({
    ler: (signal) => { leituras += 1; ultimoSinal = signal; return new Promise((r) => { resolver = r; }); },
    aoComecar: () => {},
    aoResponder: (r) => respostas.push(r),
    relogio,
  });
  const tick = () => new Promise((r) => setImmediate(r));
  ciclo.iniciar();
  ok("G1  iniciar: UMA leitura imediata", leituras === 1);
  ciclo.atualizarAgora(); ciclo.atualizarAgora(); ciclo.iniciar();
  ok("G2  manual/rerender durante a leitura: continua UMA", leituras === 1 && timers.length === 0);
  resolver!(okR); await tick();
  ok("G3  terminou: UM timer de 10 min", respostas.length === 1 && timers.length === 1 &&
    timers[0].ms === INTERVALO_AO_VIVO_MS && INTERVALO_AO_VIVO_MS === 600_000);
  ciclo.atualizarAgora();
  ok("G4  manual fora de leitura: le e cancela o timer antigo", leituras === 2 && timers.length === 0);
  resolver!({ estado: "falha" }); await tick();
  ok("G5  falha tambem reagenda (sem acelerar)", timers.length === 1 && timers[0].ms === INTERVALO_AO_VIVO_MS);
  timers.shift()!.fn(); // como o setTimeout real: o timer disparado deixa de existir
  ok("G6  o timer dispara a proxima leitura", leituras === 3);
  ciclo.parar();
  ok("G7  parar aborta a leitura em voo", (ultimoSinal as AbortSignal | null)?.aborted === true);
  resolver!(okR); await tick();
  ok("G8  resposta tardia apos parar e descartada, sem timer", respostas.length === 2 && timers.length === 0,
    `respostas=${respostas.length} timers=${timers.length}`);

  // =====================================================================
  secao("H. Painel: global e so FORMATA");
  const ESC = ler("components/ia/office/Escritorio.tsx");
  const iPainel = ESC.indexOf("<OfficeAgentPanelV1");
  const iFimPainel = ESC.indexOf("/>", iPainel);
  const iVivo = ESC.indexOf("<VendasAoVivo />");
  ok("H1  montado fora do painel do agente (key por agente), sem props", iVivo > iFimPainel && iFimPainel > iPainel);
  const VIVO = semComentario(ler("components/ia/office/VendasAoVivo.tsx"));
  ok("H2  o painel nao conhece agente nem chat", !/agenteId|ChatDoAgente|TextoDoAgente|conversa/.test(VIVO));
  ok("H3  o ciclo e criado UMA vez", /c\.iniciar\(\);[\s\S]*?\}, \[\]\);/.test(VIVO));
  const VIVO_SEM_STRINGS = semStrings(VIVO);
  ok("H4  nenhuma conta financeira na tela (sem kpis/ontem/delta com operador)",
    !/(kpis|ontem|delta|progresso|razao)\.?\w*\s*[-+*/]\s*\w/.test(VIVO_SEM_STRINGS.replace(/\(v \/ max\) \* 100/g, "")),
    "a unica aritmetica permitida e a geometria da barra (v / max)");
  // ── F8.2-B2: hierarquia HOJE em cima, ONTEM separado embaixo ──
  const CSS = ler("components/ia/office/office-v1.module.css");
  const regra = (classe: string) => {
    const i = CSS.indexOf(`.${classe} {`);
    return i < 0 ? "" : CSS.slice(i, CSS.indexOf("}", i));
  };
  ok("H5  valor de KPI NUNCA quebra (nowrap, keep-all, sem overflow-wrap:anywhere)",
    /white-space: nowrap/.test(regra("aoVivoKpiValor")) &&
      /word-break: keep-all/.test(regra("aoVivoKpiValor")) &&
      /overflow-wrap: normal/.test(regra("aoVivoKpiValor")) &&
      /font-variant-numeric: tabular-nums/.test(regra("aoVivoKpiValor")) &&
      /white-space: nowrap/.test(regra("aoVivoCmpValores")) &&
      /white-space: nowrap/.test(regra("aoVivoVariacao")));
  ok("H6  a fonte encolhe com o card em vez de quebrar (container query)",
    /container-type: inline-size/.test(regra("aoVivoKpi")) && /cqi/.test(regra("aoVivoKpiValor")));
  const iHoje = VIVO.indexOf("className={estilos.aoVivoHoje}");
  const iCmp = VIVO.indexOf("<ComparativoComOntem", iHoje);
  ok("H6b HOJE vem antes, e o comparativo e uma secao separada depois",
    iHoje > 0 && iCmp > iHoje && /aria-label="Comparativo com ontem"/.test(VIVO));
  const corpoHoje = VIVO.slice(VIVO.indexOf("function CardHoje"), VIVO.indexOf("function BarrasPareadas"));
  ok("H6c o card de HOJE nao mostra nada de ontem", corpoHoje.length > 100 && !/ontem|Variacao|cmp/.test(corpoHoje));
  ok("H6d o comparativo ocupa o espaco livre de baixo (flex: 1)", /flex: 1/.test(regra("aoVivoCmp")));
  ok("H7  horarios so FORMATADOS no fuso de SP", /timeZone: "America\/Sao_Paulo"/.test(VIVO));
  ok("H8  variacao nunca so por cor: seta + sinal + texto para leitor",
    /"▲"/.test(ler("components/ia/office/VendasAoVivo.tsx")) && /acima de ontem/.test(ler("components/ia/office/VendasAoVivo.tsx")));
  ok("H9  sem Shopee simulado na tela", !/shopee/i.test(VIVO.replace(/shopee: "Shopee"/, "")));

  console.log(`\n── placar ${"─".repeat(50)}\n  PASS ${passou}   FAIL ${falhou}\n`);
  if (falhou > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
