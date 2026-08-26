/**
 * Suite da capability de leitura de vendas — AGENTES-FASE1D-a (+FIX).
 *
 * SEM rede, SEM banco, SEM IA.
 *
 * ── Cinco instrumentos ──────────────────────────────────────────────
 *  1. FUNCOES PURAS executadas — `validarFiltroVendas`, `filtrosVendas`.
 *  2. SIMULADOR DE PAGINACAO que alimenta o `paginarKeyset` REAL com um
 *     duplo em memoria. As provas de "nao duplica", "nao omite" e
 *     "insert nao desloca" valem sobre a implementacao de producao —
 *     nao sobre uma imitacao escrita no teste.
 *  3. EXECUTOR EM MEMORIA para a semantica de `.eq()` encadeado.
 *  4. INSPECAO DE FONTE — barreiras, projecao, ausencia de escrita.
 *  5. CLOSURE — a leitura devolvida nao tem parametro de dono.
 *
 * ── Anti-vacuidade ─────────────────────────────────────────────────
 * Toda varredura prova primeiro que ACHOU o alvo, e so entao que ele e
 * o unico. Assert de ausencia sobre texto vazio passa sempre.
 */
import "./_server-only-inerte";
import "./_env-inerte";
import { readFileSync } from "fs";
import { join } from "path";

import {
  JANELA_MAXIMA_DIAS,
  PAGE_SIZE,
  MAX_PAGES,
  COLUNAS_VENDAS,
  COLUNAS_LEITURA_INTERNA,
  MARKETPLACES_VALIDOS,
  validarFiltroVendas,
  filtrosVendas,
  criarLeiturasDeVendas,
  paginarKeyset,
  type FiltroVendas,
  type LinhaVendaInterna,
} from "../lib/agentes/dados/vendas";

const RAIZ = join(__dirname, "..");
const fonte = (rel: string) => readFileSync(join(RAIZ, rel), "utf8");
const codigo = (rel: string) =>
  fonte(rel)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

let passou = 0;
let falhou = 0;
function ok(nome: string, condicao: boolean) {
  if (condicao) passou++;
  else {
    falhou++;
    console.error(`  x ${nome}`);
  }
}
const conta = (t: string, re: RegExp) => (t.match(re) ?? []).length;

const ARQ = "lib/agentes/dados/vendas.ts";
const src = codigo(ARQ);
const bruta = fonte(ARQ);

const COLUNAS_PROIBIDAS = [
  "custo", "imposto", "margem_contrib", "mc_percent", "lucro_liquido",
  "roi", "seller_income", "escrow_amount", "tarifa_venda", "commission_fee",
  "service_fee", "transaction_fee", "campaign_fee",
];

// ── Executor em memoria: `.eq()` encadeado ────────────────────────────
type Linha = Record<string, unknown>;
function selecionar(tabela: Linha[], filtros: Record<string, unknown>): Linha[] {
  return tabela.filter((l) => Object.entries(filtros).every(([c, v]) => String(l[c]) === String(v)));
}
function entrePeriodo(linhas: Linha[], de: string, ate: string): Linha[] {
  return linhas.filter((l) => { const d = String(l.data_pagamento ?? ""); return d >= de && d <= ate; });
}

const A = "dono-a";
const B = "dono-b";
const PEDIDOS: Linha[] = [
  { order_id: "A1", user_id: A, status: "paid",      marketplace: "Shopee", data_pagamento: "2026-07-05", sku: "S1", qtd: 1 },
  { order_id: "A2", user_id: A, status: "paid",      marketplace: "ML",     data_pagamento: "2026-07-06", sku: null, qtd: 2 },
  { order_id: "A3", user_id: A, status: "cancelled", marketplace: "Shopee", data_pagamento: "2026-07-07", sku: "S2", qtd: 1 },
  { order_id: "A4", user_id: A, status: "devolucao", marketplace: "Shopee", data_pagamento: "2026-07-07", sku: "S3", qtd: 1 },
  { order_id: "A5", user_id: A, status: "paid",      marketplace: "Shopee", data_pagamento: "2026-08-01", sku: "S1", qtd: 1 },
  { order_id: "B1", user_id: B, status: "paid",      marketplace: "Shopee", data_pagamento: "2026-07-05", sku: "S9", qtd: 1 },
];

// ══ SIMULADOR DE PAGINACAO ════════════════════════════════════════════
//
// Reproduz a semantica EXATA da query de pagina:
//    WHERE id > cursor AND id <= limite   ORDER BY id ASC   LIMIT n
//
// Ele nao reimplementa o laco — o laco e o `paginarKeyset` de producao.
// Este duplo so entrega paginas, como o Postgres entregaria.
function criarTabela(qtd: number, prefixo = "id-"): LinhaVendaInterna[] {
  return Array.from({ length: qtd }, (_, i) => ({
    // Largura fixa: ordenacao TEXTUAL precisa casar com a numerica no duplo.
    id: `${prefixo}${String(i).padStart(6, "0")}`,
    order_id: `o${i}`, sku: `S${i % 7}`, anuncio: `anuncio ${i}`,
    marketplace: i % 3 === 0 ? "ML" : "Shopee",
    qtd: 1, item_subtotal: 10, faturamento: 12, data_pagamento: "2026-07-05",
  }));
}
function paginador(tabela: () => LinhaVendaInterna[], limite: string | null, tamanho = PAGE_SIZE) {
  return async (cursor: string | null): Promise<LinhaVendaInterna[]> =>
    tabela()
      .filter((l) => (cursor === null || l.id > cursor) && (limite === null || l.id <= limite))
      .sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0))
      .slice(0, tamanho);
}

async function main() {
  // ═══ A. CONSTANTES ════════════════════════════════════════════════
  console.log("\nA. Constantes do contrato");
  ok("A0  a fonte foi lida (anti-vacuidade)", src.length > 1000);
  ok("A1  JANELA_MAXIMA_DIAS === 14", JANELA_MAXIMA_DIAS === 14);
  ok("A2  PAGE_SIZE === 1000 (teto server-side medido)", PAGE_SIZE === 1000);
  ok("A3  MAX_PAGES === 50", MAX_PAGES === 50);
  ok("A4  teto de linhas = 50.000", PAGE_SIZE * MAX_PAGES === 50_000);
  ok("A5  marketplaces sao exatamente Shopee e ML",
     JSON.stringify([...MARKETPLACES_VALIDOS]) === JSON.stringify(["Shopee", "ML"]));
  // O motivo do 1000 tem de estar ESCRITO: sem isso, alguem "otimiza"
  // para 2000 e perde dados em silencio.
  ok("A6  o teto server-side esta documentado na fonte",
     /db-max-rows|teto server-side|PERDA SILENCIOSA/i.test(bruta));

  // ═══ B. PROJECAO: INTERNA vs PUBLICA ══════════════════════════════
  console.log("B. Projecao interna vs publica");
  const pub = COLUNAS_VENDAS.split(",").map((c) => c.trim());
  const interna = COLUNAS_LEITURA_INTERNA.split(",").map((c) => c.trim());
  ok("B0  ambas tem colunas (anti-vacuidade)", pub.length > 0 && interna.length > 0);
  ok("B1  publica tem exatamente 8 colunas", pub.length === 8);
  ok("B2  publica e exatamente a aprovada",
     JSON.stringify([...pub].sort()) ===
       JSON.stringify(["anuncio","data_pagamento","faturamento","item_subtotal","marketplace","order_id","qtd","sku"].sort()));
  ok("B3  publica NAO contem id", !pub.includes("id"));
  ok("B4  interna tem exatamente 9 colunas", interna.length === 9);
  ok("B5  interna = publica + id", interna[0] === "id" && interna.slice(1).join(",") === pub.join(","));
  ok("B6  zero select(\"*\")", conta(src, /select\(\s*["'`]\s*\*/g) === 0);
  for (const c of COLUNAS_PROIBIDAS) ok(`B7 nenhuma projecao traz "${c}"`, !interna.includes(c) && !pub.includes(c));
  ok("B8  nenhuma coluna proibida em qualquer select do arquivo",
     (src.match(/\.select\(([^)]*)\)/g) ?? []).every(
       (s) => !COLUNAS_PROIBIDAS.some((c) => new RegExp(`\\b${c}\\b`).test(s))));
  ok("B9  o unico select usa a projecao INTERNA", /\.select\(COLUNAS_LEITURA_INTERNA\)/.test(src));
  ok("B10 ha exatamente 1 .select( no arquivo", conta(src, /\.select\(/g) === 1);

  // ═══ C. BARREIRAS ═════════════════════════════════════════════════
  console.log("C. Barreiras");
  ok("C1  primeira instrucao e import server-only",
     /^\s*import\s+"server-only";/m.test(bruta.replace(/\/\*[\s\S]*?\*\//, "").trimStart()));
  ok("C2  usa getSupabaseServidor", /getSupabaseServidor\(\)/.test(src));
  ok("C3  zero createClient proprio", !/createClient/.test(src));
  ok("C4  nao expoe nem recebe SupabaseClient", !/SupabaseClient/.test(src));
  ok("C5  zero NEXT_PUBLIC_SUPABASE_ANON_KEY", !/NEXT_PUBLIC_SUPABASE_ANON_KEY/.test(bruta));
  ok("C6  zero insert/update/upsert/delete/rpc",
     !/\.insert\(|\.update\(|\.upsert\(|\.delete\(|\.rpc\(/.test(src));
  ok("C7  le SOMENTE a tabela pedidos",
     JSON.stringify([...new Set(src.match(/\.from\("[a-z_]+"\)/g) ?? [])]) === JSON.stringify(['.from("pedidos")']));
  ok("C8  nao toca lojas/perfil", !/\.from\("(lojas|perfil)"\)/.test(src));
  ok("C9  zero fetch/rede/API externa", !/fetch\(|axios|https?:\/\//.test(src));
  ok("C10 zero Storage", !/storage|\.upload\(|createSignedUrl/i.test(src));
  ok("C11 zero IA/gateway", !/ai-gateway|anthropic|@google\/genai|openai/i.test(src));
  const logs = (src.match(/console\.[a-z]+\(([^)]*)\)/g) ?? []).map((l) => l.slice(l.indexOf("(") + 1, -1));
  ok("C12 ha logs a inspecionar (anti-vacuidade)", logs.length >= 2);
  ok("C13 nenhum log com identificador ou error.message",
     logs.every((a) => !/userId|user_id|filtro|error|cursor|limiteInicial/.test(a)) && !/error\.message/.test(src));

  // ═══ D. STATUS E CAMPO TEMPORAL ═══════════════════════════════════
  console.log("D. Status e campo temporal");
  const f = filtrosVendas(A);
  ok("D1  status='paid' e fixo", f.status === "paid");
  ok("D2  user_id entra no filtro", f.user_id === A);
  ok("D3  sem marketplace, 2 chaves", Object.keys(f).length === 2);
  ok("D4  com marketplace, 3 chaves", Object.keys(filtrosVendas(A, "Shopee")).length === 3);
  ok("D5  normaliza user_id com String()", filtrosVendas(123 as unknown as string).user_id === "123");
  ok("D6  campo temporal e data_pagamento", /\.gte\("data_pagamento"/.test(src) && /\.lte\("data_pagamento"/.test(src));
  ok("D7  data_criacao NAO e filtro temporal", !/\.(gte|lte|eq)\("data_criacao"/.test(src));
  ok("D8  a coluna `data` legada NAO e usada", !/\.(gte|lte|eq)\("data"/.test(src));
  ok("D9  campoData nao e configuravel", !/date_field|campoData|tipoData/.test(src));
  ok("D10 status nao e configuravel", conta(src, /status:\s*"paid"/g) === 1);

  // ═══ E. JANELA ════════════════════════════════════════════════════
  console.log("E. Janela");
  const jan = (i: string, fim: string): FiltroVendas => ({ dataInicio: i, dataFim: fim });
  ok("E1  mesmo dia e valido", validarFiltroVendas(jan("2026-07-01","2026-07-01")).erro === null);
  ok("E2  mesmo dia conta 1", validarFiltroVendas(jan("2026-07-01","2026-07-01")).dias === 1);
  ok("E3  01→14 = 14 dias PASSA", (() => { const v = validarFiltroVendas(jan("2026-07-01","2026-07-14")); return v.erro === null && v.dias === 14; })());
  ok("E4  01→15 = 15 dias REJEITA", (() => { const v = validarFiltroVendas(jan("2026-07-01","2026-07-15")); return v.erro === "janela_excedida" && v.dias === 15; })());
  ok("E5  janela anual rejeita", validarFiltroVendas(jan("2026-01-01","2026-12-31")).erro === "janela_excedida");
  ok("E6  invertido rejeita", validarFiltroVendas(jan("2026-07-10","2026-07-01")).erro === "periodo_invertido");
  ok("E7  formato errado rejeita", validarFiltroVendas(jan("01/07/2026","2026-07-02")).erro === "data_invalida");
  ok("E8  data inexistente rejeita", validarFiltroVendas(jan("2026-02-31","2026-03-01")).erro === "data_invalida");
  ok("E9  filtro ausente rejeita", validarFiltroVendas(undefined as unknown as FiltroVendas).erro === "filtro_ausente");
  ok("E10 virada de mes conta certo", validarFiltroVendas(jan("2026-07-25","2026-08-07")).dias === 14);
  ok("E11 virada de ano conta certo", validarFiltroVendas(jan("2026-12-25","2027-01-07")).dias === 14);
  ok("E12 fevereiro bissexto conta certo", validarFiltroVendas(jan("2028-02-25","2028-03-01")).dias === 6);

  // ═══ F. MARKETPLACE ═══════════════════════════════════════════════
  console.log("F. Marketplace");
  const base = jan("2026-07-01","2026-07-02");
  ok("F1  Shopee aceito", validarFiltroVendas({ ...base, marketplace: "Shopee" }).erro === null);
  ok("F2  ML aceito", validarFiltroVendas({ ...base, marketplace: "ML" }).erro === null);
  ok("F3  null aceito", validarFiltroVendas({ ...base, marketplace: null }).erro === null);
  ok("F4  ausente aceito", validarFiltroVendas(base).erro === null);
  ok("F5  desconhecido rejeita", validarFiltroVendas({ ...base, marketplace: "Amazon" as never }).erro === "marketplace_invalido");
  ok("F6  case errado rejeita", validarFiltroVendas({ ...base, marketplace: "shopee" as never }).erro === "marketplace_invalido");

  // ═══ G. ISOLAMENTO E CLOSURE ══════════════════════════════════════
  console.log("G. Isolamento e closure");
  const lerA = criarLeiturasDeVendas(A);
  ok("G1  a fabrica devolve funcao", typeof lerA === "function");
  ok("G2  a leitura tem aridade 1 (so o filtro)", lerA.length === 1);
  ok("G3  fabricas diferentes -> funcoes diferentes", lerA !== criarLeiturasDeVendas(B));
  ok("G4  a fabrica exige userId", criarLeiturasDeVendas("").length === 1);
  ok("G5  FiltroVendas NAO tem campo de dono", !/interface FiltroVendas[\s\S]{0,200}?user_?[Ii]d/.test(src));
  ok("G6  o tipo da leitura nao carrega userId", /export type LerVendasDoPeriodo = \(filtro: FiltroVendas\)/.test(src));
  const semDono = selecionar(PEDIDOS, filtrosVendas(A));
  ok("G7  o executor enxerga linhas (anti-vacuidade)", PEDIDOS.length === 6);
  ok("G8  dono A ve so o dele", semDono.every((l) => l.user_id === A));
  ok("G9  dono A NAO ve linha de B", !semDono.some((l) => l.order_id === "B1"));
  ok("G10 dono B ve so o dele", selecionar(PEDIDOS, filtrosVendas(B)).every((l) => l.user_id === B));
  ok("G11 dono inexistente ve zero", selecionar(PEDIDOS, filtrosVendas("nao-existe")).length === 0);

  // ═══ H. SEMANTICA DO FILTRO ═══════════════════════════════════════
  console.log("H. Semantica do filtro");
  const paidA = selecionar(PEDIDOS, filtrosVendas(A));
  ok("H1  cancelled fica de fora", !paidA.some((l) => l.order_id === "A3"));
  ok("H2  devolucao fica de fora", !paidA.some((l) => l.order_id === "A4"));
  ok("H3  restam 3 pagos de A", paidA.length === 3);
  const julho = entrePeriodo(paidA, "2026-07-01", "2026-07-14");
  ok("H4  o periodo corta o que esta fora", julho.length === 2 && !julho.some((l) => l.order_id === "A5"));
  ok("H5  marketplace restringe", selecionar(PEDIDOS, filtrosVendas(A, "ML")).length === 1);
  ok("H6  sku null nao e descartado pelo filtro", selecionar(PEDIDOS, filtrosVendas(A, "ML"))[0].sku === null);

  // ═══ I. KEYSET — a fonte ══════════════════════════════════════════
  console.log("I. Keyset (fonte)");
  ok("I1  NAO usa .range() em lugar nenhum", !/\.range\(/.test(src));
  ok("I2  usa .limit(PAGE_SIZE)", /\.limit\(PAGE_SIZE\)/.test(src));
  ok("I3  cursor estrito com .gt(\"id\", cursor)", /\.gt\("id", cursor\)/.test(src));
  ok("I4  limite superior com .lte(\"id\", limiteInicial)", /\.lte\("id", limiteInicial\)/.test(src));
  ok("I5  ordena ASC por id nas paginas", /\.order\("id", \{ ascending: true \}\)/.test(src));
  // ── I6..I6d: a query de LIMITE INICIAL, delimitada ────────────────
  //
  // O assert antigo exigia `order DESC + limit 1`. Esse `limit(1)` era o
  // gatilho de um plano patologico: com ele o Postgres varria
  // `pedidos_pkey` de tras para frente (432.472 linhas descartadas,
  // 43,5 s medidos) e estourava o `statement_timeout` de 8 s para
  // qualquer dono que nao ordenasse por ultimo. A prova 1D-e encontrou.
  //
  // A varredura abaixo delimita PRIMEIRO o trecho entre o comentario da
  // secao 1 e o `if (erroTopo)`, e so entao afirma sobre ele. Um grep
  // global de `.limit(1)` acusaria a paginacao junto e seria fragil.
  const blocoLimite = (() => {
    const i = src.indexOf("const { data: topo");
    const f = src.indexOf("if (erroTopo)");
    return i >= 0 && f > i ? src.slice(i, f) : "";
  })();
  ok("I6  o trecho do limite inicial foi delimitado (anti-vacuidade)",
     blocoLimite.length > 30 && /consultaBase\(\)/.test(blocoLimite));
  ok("I6a o limite inicial ordena por id DESC (e assim topo[0] e o maior)",
     /\.order\("id", \{ ascending: false \}\)/.test(blocoLimite));
  ok("I6b o limite inicial usa .limit(PAGE_SIZE), nao .limit(1)",
     /\.limit\(PAGE_SIZE\)/.test(blocoLimite));
  ok("I6c REGRESSAO: .limit(1) NAO pode voltar a este trecho — arma o backward scan da PK",
     !/\.limit\(\s*1\s*\)/.test(blocoLimite));
  ok("I6d CONTROLE NEGATIVO: a varredura acusaria o limit(1) se ele voltasse",
     /\.limit\(\s*1\s*\)/.test(blocoLimite.replace(".limit(PAGE_SIZE)", ".limit(1)")));
  ok("I6e topo[0] segue sendo a origem do limite (semantica de max preservada)",
     /topo\[0\]/.test(src) && /const limiteInicial = primeiraLinha\.id/.test(src));
  ok("I7  o limite usa a MESMA consultaBase (mesmo conjunto)",
     conta(src, /consultaBase\(\)/g) === 2 && /const consultaBase = \(\) =>/.test(src));
  ok("I8  consultaBase carrega filtros + intervalo de datas",
     /consultaBase = \(\) =>[\s\S]{0,300}aplicarFiltros[\s\S]{0,200}\.gte\("data_pagamento"[\s\S]{0,120}\.lte\("data_pagamento"/.test(src));
  ok("I9  conjunto vazio devolve cedo, sem erro", /if \(!primeiraLinha\) return \{ linhas: \[\], truncado: false, erro: null \}/.test(src));
  ok("I10 o cursor avanca para o ULTIMO id da pagina", /cursor = lote\[lote\.length - 1\]\.id/.test(src));
  ok("I11 pagina incompleta encerra", /lote\.length < PAGE_SIZE/.test(src));
  ok("I12 falha de pagina invalida a leitura inteira", /if \(erroPagina\) return \{ linhas: \[\], truncado: false, erro: erroPagina \}/.test(src));
  ok("I13 semId remove a PK antes de devolver", /const \{ id: _ignorado, \.\.\.publica \} = linha/.test(src));

  // ── I14..I17: PROVA SEMANTICA de que trocar o LIMIT nao muda o valor
  //
  // A correcao de desempenho so vale se `topo[0]` continuar sendo o
  // MESMO id. Aqui isso e exercitado, nao argumentado: um duplo aplica a
  // ordenacao DESC exatamente como a query, e compara o primeiro
  // elemento com N=1 e com N=PAGE_SIZE, contra o maior id calculado de
  // forma independente.
  //
  // Os tamanhos incluem casos ACIMA de PAGE_SIZE — sem eles o teste
  // seria vacuo, porque com poucas linhas os dois recortes coincidem
  // trivialmente.
  {
    const topoDesc = (linhas: LinhaVendaInterna[], n: number) =>
      [...linhas].sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)).slice(0, n);

    for (const tamanho of [1, 7, PAGE_SIZE - 1, PAGE_SIZE, PAGE_SIZE + 1, PAGE_SIZE + 1234]) {
      const t = criarTabela(tamanho);
      const comUm = topoDesc(t, 1)[0].id;
      const comPagina = topoDesc(t, PAGE_SIZE)[0].id;
      const maiorReal = t.reduce((m, l) => (l.id > m ? l.id : m), t[0].id);
      ok(`I14 [${tamanho} linhas] topo[0] com PAGE_SIZE == topo[0] com 1`, comUm === comPagina);
      ok(`I15 [${tamanho} linhas] e ambos SAO o maior id elegivel`, comPagina === maiorReal);
    }
    // Ordem inversa da entrada: o resultado nao pode depender de como as
    // linhas chegaram, so da ordenacao.
    const embaralhada = criarTabela(PAGE_SIZE + 50).reverse();
    ok("I16 independe da ordem em que as linhas chegam",
       topoDesc(embaralhada, PAGE_SIZE)[0].id === topoDesc(embaralhada, 1)[0].id);
    ok("I17 CONTROLE NEGATIVO: o duplo NAO devolve o menor id",
       topoDesc(criarTabela(PAGE_SIZE + 50), 1)[0].id !== "id-000000");
  }

  // ═══ J. KEYSET — comportamento, com o paginarKeyset REAL ══════════
  console.log("J. Keyset (comportamento real)");

  // 1) Duas paginas, sem duplicacao e sem omissao.
  {
    const tabela = criarTabela(2500);
    const r = await paginarKeyset(paginador(() => tabela, tabela[tabela.length - 1].id));
    ok("J1  le todas as 2500 linhas", r.linhas.length === 2500);
    ok("J2  zero duplicacao (order_id unicos)", new Set(r.linhas.map((l) => l.order_id)).size === 2500);
    ok("J3  zero omissao (conjunto identico ao original)",
       JSON.stringify(r.linhas.map((l) => l.order_id)) === JSON.stringify(tabela.map((l) => l.order_id)));
    ok("J4  truncado=false quando acaba naturalmente", r.truncado === false);
    ok("J5  o retorno publico NUNCA contem id", r.linhas.every((l) => !("id" in l)));
    ok("J6  o retorno publico tem exatamente 8 chaves", Object.keys(r.linhas[0]).length === 8);
  }

  // 2) INSERT com id ABAIXO do cursor durante a leitura: nao desloca.
  {
    const tabela = criarTabela(2500);
    const limite = tabela[tabela.length - 1].id;
    let chamadas = 0;
    const r = await paginarKeyset(async (cursor) => {
      chamadas++;
      if (chamadas === 2) {
        // Chega uma linha bem no comeco da ordenacao — o caso que
        // quebrava OFFSET, deslocando todas as paginas seguintes.
        tabela.unshift({ ...criarTabela(1, "id-AAA")[0], order_id: "intruso-abaixo" });
        tabela.sort((x, y) => (x.id < y.id ? -1 : 1));
      }
      return paginador(() => tabela, limite)(cursor);
    });
    ok("J7  insert abaixo do cursor NAO duplica",
       new Set(r.linhas.map((l) => l.order_id)).size === r.linhas.length);
    ok("J8  insert abaixo do cursor NAO omite as originais",
       criarTabela(2500).every((o) => r.linhas.some((l) => l.order_id === o.order_id)));
    ok("J9  a linha inserida abaixo do cursor nao aparece (ja passamos por ali)",
       !r.linhas.some((l) => l.order_id === "intruso-abaixo"));
  }

  // 3) INSERT ACIMA do cursor mas DENTRO do limite: entra. E a janela
  //    residual que o limite superior nao fecha — declarada, nao negada.
  {
    const tabela = criarTabela(2500);
    const limite = tabela[tabela.length - 1].id;
    let chamadas = 0;
    const r = await paginarKeyset(async (cursor) => {
      chamadas++;
      if (chamadas === 1) {
        tabela.push({ ...tabela[2000], id: "id-002000x", order_id: "intruso-dentro" });
        tabela.sort((x, y) => (x.id < y.id ? -1 : 1));
      }
      return paginador(() => tabela, limite)(cursor);
    });
    ok("J10 insert acima do cursor e DENTRO do limite entra (semantica declarada)",
       r.linhas.some((l) => l.order_id === "intruso-dentro"));
    ok("J11 e mesmo assim nao ha duplicacao",
       new Set(r.linhas.map((l) => l.order_id)).size === r.linhas.length);
  }

  // 4) INSERT ACIMA do limite inicial: barrado.
  {
    const tabela = criarTabela(1500);
    const limite = tabela[tabela.length - 1].id;
    let chamadas = 0;
    const r = await paginarKeyset(async (cursor) => {
      chamadas++;
      if (chamadas === 1) tabela.push({ ...criarTabela(1, "id-ZZZ")[0], order_id: "intruso-acima" });
      return paginador(() => tabela, limite)(cursor);
    });
    ok("J12 insert acima do limiteInicial NAO entra", !r.linhas.some((l) => l.order_id === "intruso-acima"));
    ok("J13 e as originais continuam completas", r.linhas.length === 1500);
  }

  // 5) Limite pertence ao mesmo conjunto filtrado.
  {
    const tabela = criarTabela(50);
    const limiteMeio = tabela[24].id;
    const r = await paginarKeyset(paginador(() => tabela, limiteMeio));
    ok("J14 nada acima do limite entra", r.linhas.length === 25);
    ok("J15 o limite E incluido (lte, nao lt)", r.linhas.some((l) => l.order_id === "o24"));
  }

  // 6) Pagina final incompleta encerra.
  {
    const tabela = criarTabela(PAGE_SIZE + 7);
    const r = await paginarKeyset(paginador(() => tabela, tabela[tabela.length - 1].id));
    ok("J16 pagina final incompleta encerra", r.linhas.length === PAGE_SIZE + 7 && r.truncado === false);
  }
  // Exatamente uma pagina cheia e nada mais: proxima pagina vazia encerra.
  {
    const tabela = criarTabela(PAGE_SIZE);
    const r = await paginarKeyset(paginador(() => tabela, tabela[tabela.length - 1].id));
    ok("J17 exatamente 1 pagina cheia encerra sem truncar", r.linhas.length === PAGE_SIZE && r.truncado === false);
  }

  // 7) 50 paginas cheias -> truncado, e o teto de 50.000 e respeitado.
  {
    let entregues = 0;
    const r = await paginarKeyset(async () => {
      entregues++;
      return criarTabela(PAGE_SIZE, `p${String(entregues).padStart(3, "0")}-`);
    });
    ok("J18 50 paginas cheias marcam truncado=true", r.truncado === true);
    ok("J19 teto de 50.000 respeitado", r.linhas.length === 50_000);
    ok("J20 nunca pede mais que MAX_PAGES paginas", entregues === MAX_PAGES);
  }

  // 8) Conjunto vazio.
  {
    const r = await paginarKeyset(async () => []);
    ok("J21 conjunto vazio devolve zero, sem truncar", r.linhas.length === 0 && r.truncado === false);
  }

  // ═══ K. ERROS E SEGREDOS ══════════════════════════════════════════
  console.log("K. Erros e segredos");
  for (const c of ["filtro_ausente","data_invalida","periodo_invertido","janela_excedida","marketplace_invalido","user_id_ausente","erro_consulta_vendas"]) {
    ok(`K1 codigo "${c}" existe na fonte`, new RegExp(`"${c}"`).test(src));
  }
  ok("K2  nenhum error.message vaza", !/error\.message/.test(src));
  for (const [nome, re] of [
    ["JWT", /eyJ[A-Za-z0-9_-]{10,}/],
    ["sbp_/sk-/AIza/AKIA", /sbp_[A-Za-z0-9]{16,}|sk-[A-Za-z0-9]{20,}|AIza[0-9A-Za-z_-]{30,}|AKIA[0-9A-Z]{16}/],
    ["postgres com credencial", /postgres(ql)?:\/\/[^:/@\s]+:[^@\s]+@/],
    ["Bearer literal", /Bearer [A-Za-z0-9._-]{16,}/],
  ] as const) ok(`K3 zero ${nome}`, !re.test(bruta));

  const total = passou + falhou;
  console.log(`\n${"=".repeat(58)}`);
  console.log(`AGENTES-FASE1D-a — capability de vendas:  ${passou}/${total} passaram`);
  if (falhou > 0) { console.log(`${falhou} FALHARAM`); process.exitCode = 1; }
  else console.log("TODOS OS ASSERTS PASSARAM");
  console.log("=".repeat(58));
}

main().catch((e) => {
  console.error("ERRO NAO TRATADO:", e instanceof Error ? e.message.slice(0, 300) : "desconhecido");
  process.exitCode = 1;
});
