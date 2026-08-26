/**
 * Suite da composicao pura analise -> IA — AGENTES-FASE1E-b.
 *
 * SEM banco, SEM rede, SEM env, SEM SDK, SEM provedor real, SEM IA.
 *
 * ── A ausencia de shim no topo continua sendo barreira ──────────────
 * Como nas suites 1D-c e 1E-a, esta NAO importa `_server-only-inerte`
 * nem `_env-inerte`. Se `interpretar-analise-vendas.ts` algum dia passar
 * a importar como VALOR qualquer coisa que arraste `server-only` — a
 * capability de vendas, um cliente Supabase, um SDK — esta suite para de
 * carregar, antes do primeiro assert.
 *
 * O limite dessa barreira foi medido na 1D-c: import de valor NAO USADO
 * e apagado pela elisao do esbuild e escapa. Por isso ela convive com
 * (i) a varredura de fonte do grupo R e (ii) a inspecao de
 * `require.cache` do grupo Q, que enxergam o que a elisao apaga.
 *
 * ── Fixture sintetica ───────────────────────────────────────────────
 * Nenhum assert depende de dado real de cliente. Os SKUs, marketplaces e
 * datas abaixo sao inventados e escolhidos para exercitar as bordas que
 * importam: ranking cortado (`skusOmitidos > 0`), linha sem SKU, linha
 * sem valor e dois marketplaces.
 */
import { readFileSync } from "fs";
import { join } from "path";

import {
  interpretarAnaliseVendas,
  prepararPedidoInterpretacao,
  INSTRUCAO_INTERPRETACAO_VENDAS,
} from "../lib/agentes/ia/interpretar-analise-vendas";
import {
  validarAnaliseVendasIA,
  SCHEMA_ANALISE_VENDAS_IA,
  CHAVES_ANALISE_IA,
} from "../lib/agentes/ia/contrato-analise";
import { criarAdaptadorFake } from "../lib/agentes/ia/fake";
import { ErroProvedorIA } from "../lib/ai-gateway/erros";
import type { AnaliseVendasDeterministica } from "../lib/agentes/ia/interpretar-analise-vendas";
import type { PedidoIA } from "../lib/agentes/ia/tipos";

// ── Armadilha de rede ─────────────────────────────────────────────────
let chamadasDeRede = 0;
(globalThis as unknown as { fetch: unknown }).fetch = (...args: unknown[]) => {
  chamadasDeRede++;
  throw new Error(`suite pura: fetch proibido (${String(args[0]).slice(0, 60)})`);
};

const RAIZ = join(__dirname, "..");
const ARQUIVO_MODULO = join(RAIZ, "lib", "agentes", "ia", "interpretar-analise-vendas.ts");
const FONTE = readFileSync(ARQUIVO_MODULO, "utf8");

let passou = 0;
let falhou = 0;
function ok(nome: string, condicao: boolean) {
  if (condicao) passou++;
  else {
    falhou++;
    console.error(`  x ${nome}`);
  }
}

function capturar(acao: () => unknown) {
  try {
    return { lancou: false, erro: undefined as unknown, valor: acao() };
  } catch (erro) {
    return { lancou: true, erro, valor: undefined };
  }
}

async function capturarAsync(acao: () => Promise<unknown>) {
  return acao().then(
    (valor) => ({ lancou: false, erro: undefined as unknown, valor }),
    (erro: unknown) => ({ lancou: true, erro, valor: undefined })
  );
}

/** Remove comentario, preservando string literal (mesmo motivo da 1E-a). */
function semComentarios(fonte: string): string {
  let s = "", i = 0, d: string | null = null;
  while (i < fonte.length) {
    const c = fonte[i], n = fonte[i + 1];
    if (d !== null) {
      s += c;
      if (c === "\\") { s += fonte[i + 1] ?? ""; i += 2; continue; }
      if (c === d) d = null;
      i++; continue;
    }
    if (c === '"' || c === "'" || c === "`") { d = c; s += c; i++; continue; }
    if (c === "/" && n === "/") { while (i < fonte.length && fonte[i] !== "\n") i++; continue; }
    if (c === "/" && n === "*") { i += 2; while (i < fonte.length && !(fonte[i] === "*" && fonte[i + 1] === "/")) i++; i += 2; s += " "; continue; }
    s += c; i++;
  }
  return s;
}
const CODIGO = semComentarios(FONTE);

/** Todas as chaves alcancaveis de um objeto, recursivamente. */
function chavesProfundas(valor: unknown, saida = new Set<string>()): Set<string> {
  if (valor === null || typeof valor !== "object") return saida;
  if (Array.isArray(valor)) {
    for (const v of valor) chavesProfundas(v, saida);
    return saida;
  }
  for (const [k, v] of Object.entries(valor)) {
    saida.add(k);
    chavesProfundas(v, saida);
  }
  return saida;
}

// ── Fixture deterministica, 100% sintetica ────────────────────────────
function analiseFixture(): AnaliseVendasDeterministica {
  return {
    escopo: { campoData: "data_pagamento", statusConsiderado: "paid", incluiRentabilidade: false },
    periodo: { inicio: "2026-05-01", fim: "2026-05-07", marketplace: null },
    totais: { pedidosPagos: 12, unidades: 19, faturamento: 4830.5, ticketMedio: 402.54 },
    marketplaces: [
      { marketplace: "mercado_livre", pedidos: 7, unidades: 11, faturamento: 3010.0 },
      { marketplace: "shopee", pedidos: 5, unidades: 8, faturamento: 1820.5 },
    ],
    skus: [
      { sku: "SKU-ALFA", anuncio: "Anuncio Alfa Premium", marketplace: "mercado_livre", pedidos: 4, unidades: 6, faturamento: 1900.0, anunciosDistintos: 2 },
      { sku: "SKU-BETA", anuncio: null, marketplace: "shopee", pedidos: 3, unidades: 5, faturamento: 1200.5, anunciosDistintos: 1 },
    ],
    qualidadeDados: { linhas: 24, linhasSemSku: 2, linhasSemValor: 1, skusDistintos: 9, skusOmitidos: 7 },
  };
}

async function main() {
  console.log("\nAGENTES-FASE1E-b — composicao pura analise -> IA\n");

  // ═══ A. HAPPY PATH ════════════════════════════════════════════════
  console.log("A. Happy path");
  {
    const analise = analiseFixture();
    const { adaptador, chamadas } = criarAdaptadorFake();
    const r = await interpretarAnaliseVendas(analise, adaptador);

    ok("A1 devolve as tres secoes: analise, interpretacao, origem",
       JSON.stringify(Object.keys(r).sort()) === JSON.stringify(["analise", "interpretacao", "origem"]));
    ok("A2 a interpretacao passou pelo validador (3 chaves do contrato)",
       JSON.stringify(Object.keys(r.interpretacao).sort()) === JSON.stringify([...CHAVES_ANALISE_IA].sort()));
    ok("A3 origem traz provedor/modelo/uso, sem conteudo",
       JSON.stringify(Object.keys(r.origem).sort()) === JSON.stringify(["modelo", "provedor", "tempoMs", "tokensEntrada", "tokensSaida"]));
    ok("A4 provedor e `fake` — nenhum provedor real envolvido", r.origem.provedor === "fake");

    // B. exatamente UM pedido.
    ok("B1 o adaptador recebeu exatamente UM pedido", chamadas.length === 1);
    ok("B2 o pedido tem apenas os 4 campos do contrato",
       JSON.stringify(Object.keys(chamadas[0]).sort()) === JSON.stringify(["dados", "instrucao", "schema", "validar"]));

    // C / D. identidade, nao copia.
    ok("C1 `validar` E o validador estrutural publicado (identidade)", chamadas[0].validar === validarAnaliseVendasIA);
    ok("D1 `schema` E o schema publicado (identidade)", chamadas[0].schema === SCHEMA_ANALISE_VENDAS_IA);
    ok("D2 CONTROLE NEGATIVO: uma copia estrutural do schema NAO passa no teste de identidade",
       chamadas[0].schema !== JSON.parse(JSON.stringify(SCHEMA_ANALISE_VENDAS_IA)));

    // H. numeros ficam com o CDS.
    ok("H1 `analise` e a MESMA referencia recebida (IA nao substitui numero)", r.analise === analise);
    ok("H2 os totais continuam exatamente os do CDS",
       r.analise.totais.faturamento === 4830.5 && r.analise.totais.ticketMedio === 402.54);
    ok("H3 a interpretacao NAO tem campo numerico algum",
       Object.values(r.interpretacao).every((v) => typeof v === "string" || (Array.isArray(v) && v.every((x) => typeof x === "string"))));
  }

  // ═══ E/F/G. DETERMINISMO E IMUTABILIDADE ═════════════════════════
  console.log("E/F/G. Determinismo do pedido");
  {
    const a1 = analiseFixture();
    const a2 = analiseFixture();
    const p1 = prepararPedidoInterpretacao(a1);
    const p2 = prepararPedidoInterpretacao(a1);
    const p3 = prepararPedidoInterpretacao(a2);

    ok("E1 `dados` e string JSON valida", capturar(() => JSON.parse(p1.dados)).lancou === false);
    ok("E2 duas chamadas com o MESMO objeto dao `dados` byte a byte igual", p1.dados === p2.dados);
    ok("F1 objetos distintos e equivalentes dao o MESMO pedido", p1.dados === p3.dados && p1.instrucao === p3.instrucao);
    ok("F2 schema e validar seguem identicos entre chamadas", p1.schema === p3.schema && p1.validar === p3.validar);

    const antes = JSON.stringify(analiseFixture());
    ok("G1 a entrada nao foi mutada", JSON.stringify(a1) === antes);

    const alterada = analiseFixture();
    alterada.totais.faturamento = 999;
    ok("F3 CONTROLE NEGATIVO: entrada diferente muda `dados`", prepararPedidoInterpretacao(alterada).dados !== p1.dados);
  }

  // ═══ I. NENHUMA CHAVE PROIBIDA CHEGA AO PEDIDO ═══════════════════
  console.log("I. Ausencia de identidade no pedido");
  {
    const PROIBIDAS = ["userId", "user_id", "tenantId", "tenant_id", "projetoId", "jobId"];

    // A analise recebe chaves proibidas GRUDADAS — o cenario real de
    // alguem anexar contexto ao objeto antes de passar adiante.
    const suja = analiseFixture() as AnaliseVendasDeterministica & Record<string, unknown>;
    suja.user_id = "11111111-2222-3333-4444-555555555555";
    suja.userId = "quem-chamou";
    suja.tenantId = "t-1";
    suja.tenant_id = "t-2";
    suja.projetoId = "p-1";
    suja.jobId = "j-1";
    (suja.totais as unknown as Record<string, unknown>).user_id = "vazou-fundo";

    const pedido = prepararPedidoInterpretacao(suja);
    const chaves = chavesProfundas(pedido);

    ok("I1 ANCORA: a analise suja REALMENTE carrega as chaves proibidas",
       PROIBIDAS.every((k) => k in suja));
    ok("I2 nenhuma chave proibida sobrevive a projecao (estrutura)",
       PROIBIDAS.every((k) => !chaves.has(k)));
    ok("I3 nenhuma chave proibida aparece no TEXTO enviado ao modelo",
       PROIBIDAS.every((k) => !pedido.dados.includes(k)));
    ok("I4 o UUID plantado nao aparece no texto", !pedido.dados.includes("11111111-2222-3333-4444-555555555555"));
    ok("I5 chave proibida ANINHADA (dentro de totais) tambem nao passa", !pedido.dados.includes("vazou-fundo"));
    ok("I6 CONTROLE NEGATIVO: o detector acha quando a chave esta presente",
       chavesProfundas({ a: { b: [{ user_id: 1 }] } }).has("user_id"));

    // A projecao e allowlist: `anuncio` (texto de terceiro) fica fora.
    const limpo = prepararPedidoInterpretacao(analiseFixture());
    ok("I7 ANCORA: a fixture TEM um anuncio de texto livre", analiseFixture().skus[0].anuncio === "Anuncio Alfa Premium");
    ok("I8 o texto do anuncio NAO e enviado ao modelo (decisao 1E-a)", !limpo.dados.includes("Anuncio Alfa Premium"));
    ok("I9 mas a CONTAGEM de anuncios vai", limpo.dados.includes("anunciosDistintos"));
    ok("I10 os fatos que devem ir foram mesmo", limpo.dados.includes("SKU-ALFA") && limpo.dados.includes("data_pagamento"));
  }

  // ═══ J/K/L/M. RESPOSTA DO ADAPTADOR ══════════════════════════════
  console.log("J/K/L/M. Comportamento do adaptador");
  {
    // J. extra anexado pelo adapter nao sobrevive.
    const { adaptador } = criarAdaptadorFake({
      bruto: { resumo: "r", destaques: [], alertas: [], proximas_acoes: ["executar x"] },
    });
    const r = await capturarAsync(() => interpretarAnaliseVendas(analiseFixture(), adaptador));
    ok("J1 campo extra anexado pelo adapter e RECUSADO", r.lancou);
    ok("J2 a recusa e a do contrato estrutural",
       r.erro instanceof ErroProvedorIA && (r.erro as ErroProvedorIA).tipo === "validation" &&
       (r.erro as Error).message.includes("proximas_acoes"));
  }
  {
    const { adaptador } = criarAdaptadorFake({ bruto: { resumo: "", destaques: [], alertas: [] } });
    const r = await capturarAsync(() => interpretarAnaliseVendas(analiseFixture(), adaptador));
    ok("K1 resposta estruturalmente invalida reprova", r.lancou && r.erro instanceof ErroProvedorIA);
  }
  {
    const { adaptador } = criarAdaptadorFake({ modo: "erro", tipoErro: "auth", mensagemErro: "sem credencial" });
    const r = await capturarAsync(() => interpretarAnaliseVendas(analiseFixture(), adaptador));
    ok("L1 erro do adaptador PROPAGA (nao vira resposta inventada)", r.lancou);
    ok("L2 propaga intacto: tipo e mensagem preservados",
       (r.erro as ErroProvedorIA)?.tipo === "auth" && (r.erro as Error)?.message === "sem credencial");
    ok("L3 nao devolveu objeto nenhum no lugar", r.valor === undefined);
  }
  {
    const { adaptador } = criarAdaptadorFake({ modo: "erro", tipoErro: "transient", mensagemErro: "timeout" });
    const r = await capturarAsync(() => interpretarAnaliseVendas(analiseFixture(), adaptador));
    ok("M1 transient/timeout propaga como `transient`", (r.erro as ErroProvedorIA)?.tipo === "transient");
    ok("M2 continua sendo ErroProvedorIA, sem reclassificacao", r.erro instanceof ErroProvedorIA);
  }
  {
    // Adaptador ausente e erro de composicao, nao silencio.
    const r = await capturarAsync(() => interpretarAnaliseVendas(analiseFixture(), undefined as never));
    ok("L4 adaptador ausente lanca na composicao", r.lancou);
    const r2 = capturar(() => prepararPedidoInterpretacao({ escopo: {} } as never));
    ok("L5 analise malformada lanca, sem prompt degradado", r2.lancou);
  }

  // ═══ N/O/P. PUREZA EM RUNTIME ════════════════════════════════════
  console.log("N/O/P. Pureza em runtime");
  {
    const nowReal = Date.now, randReal = Math.random;
    const descEnv = Object.getOwnPropertyDescriptor(process, "env")!;
    const envReal = process.env;
    let usosNow = 0, usosRand = 0, usosEnv = 0;

    Date.now = () => { usosNow++; return nowReal.call(Date); };
    Math.random = () => { usosRand++; return randReal(); };
    Object.defineProperty(process, "env", { configurable: true, get() { usosEnv++; return envReal; } });
    try {
      const { adaptador } = criarAdaptadorFake();
      await interpretarAnaliseVendas(analiseFixture(), adaptador);
      prepararPedidoInterpretacao(analiseFixture());
    } finally {
      Date.now = nowReal; Math.random = randReal;
      Object.defineProperty(process, "env", descEnv);
    }
    ok("P1 zero Date.now no caminho completo", usosNow === 0);
    ok("P2 zero Math.random", usosRand === 0);
    ok("O1 zero acesso a process.env", usosEnv === 0);

    let c1 = 0, c2 = 0, c3 = 0;
    const d2 = Object.getOwnPropertyDescriptor(process, "env")!;
    const n2 = Date.now, r2 = Math.random, e2 = process.env;
    Date.now = () => { c1++; return n2.call(Date); };
    Math.random = () => { c2++; return r2(); };
    Object.defineProperty(process, "env", { configurable: true, get() { c3++; return e2; } });
    try { Date.now(); Math.random(); void process.env; }
    finally { Date.now = n2; Math.random = r2; Object.defineProperty(process, "env", d2); }
    ok("P3 CONTROLE NEGATIVO: os tres instrumentos acusam quando ha uso", c1 === 1 && c2 === 1 && c3 === 1);

    ok("P4 `new Date` ausente do codigo do modulo", !/new\s+Date\b/.test(CODIGO));
    ok("N1 zero chamadas de rede", chamadasDeRede === 0);
  }

  // ═══ Q/R. GRAFO E DEPENDENCIAS ═══════════════════════════════════
  console.log("Q/R. Grafo carregado e dependencias");
  {
    const carregados = Object.keys(require.cache).map((p) => p.replace(/\\/g, "/"));
    ok("Q1 ANCORA: o modulo da 1E-b esta mesmo no grafo carregado",
       carregados.some((p) => p.includes("/lib/agentes/ia/interpretar-analise-vendas.ts")));
    const PROIBIDO = /server-only|@supabase|@google\/genai|@anthropic-ai|\/lib\/supabase/;
    ok("Q2 nenhum server-only/Supabase/SDK no grafo", !carregados.some((p) => PROIBIDO.test(p)));
    ok("Q3 a capability de vendas NAO foi carregada (import type e apagado)",
       !carregados.some((p) => p.includes("/lib/agentes/dados/vendas")));
    ok("Q4 o handler tambem nao (so o TIPO dele e usado)",
       !carregados.some((p) => p.includes("/lib/agentes/handlers/")));
    ok("Q5 CONTROLE NEGATIVO: os predicados acusam caminhos proibidos",
       PROIBIDO.test("/x/node_modules/server-only/index.js") && PROIBIDO.test("/x/node_modules/@supabase/supabase-js"));

    // R. o modulo nao pode ter meio de BUSCAR dado.
    const importsDeValor = [...CODIGO.matchAll(/^import\s+(?!type\b)([\s\S]*?)from\s+"([^"]+)"/gm)].map((m) => m[2]);
    const importsDeTipo = [...CODIGO.matchAll(/^import\s+type\s+[\s\S]*?from\s+"([^"]+)"/gm)].map((m) => m[1]);
    ok(`R1 ANCORA: imports extraidos (valor=${importsDeValor.length}, tipo=${importsDeTipo.length})`,
       importsDeValor.length > 0 && importsDeTipo.length > 0);
    ok("R2 o UNICO import de valor e o contrato da 1E-a",
       JSON.stringify(importsDeValor) === JSON.stringify(["@/lib/agentes/ia/contrato-analise"]));
    ok("R3 o handler e a capability entram apenas como TIPO",
       importsDeTipo.includes("@/lib/agentes/handlers/analise-vendas") &&
       !importsDeValor.some((i) => i.includes("handlers/") || i.includes("dados/")));
    ok("R4 nenhum import de runtime de agentes (executor/registry/worker/rota)",
       !/executar-tarefa|handlers\/registry|capability-worker|app\/api/.test(CODIGO));
    for (const [rot, re] of [
      ["fetch", /\bfetch\s*\(/], ["process.env", /process\s*\.\s*env/], ["supabase", /supabase/i],
      ["createClient", /\bcreateClient\b/], ["rpc(", /\.\s*rpc\s*\(/], ["SQL", /\bfrom\s+public\./i],
      ["URL", /https?:\/\//], ["tools", /\btools\s*:|\btool_choice\b|\binput_schema\b/],
      ["service_role", /service_role/i],
    ] as const) {
      ok(`R5 codigo do modulo sem ${rot}`, !re.test(CODIGO));
    }
    ok("R6 CONTROLE NEGATIVO: a varredura acha os termos quando presentes",
       [/\bfetch\s*\(/, /process\s*\.\s*env/, /supabase/i, /\btools\s*:/].every((re) =>
         re.test('fetch(); process.env; supabase; tools: [];')));
    ok("R7 ANCORA: o extrator de comentario nao apagou o codigo",
       CODIGO.includes("export async function interpretarAnaliseVendas") && CODIGO.length > 800);
  }

  // ═══ S/T. CONTRATO DE SAIDA ══════════════════════════════════════
  console.log("S/T. Contrato de saida");
  {
    const comAcao = ["proximas_acoes", "acoes", "comandos", "sugestoes", "tool_calls", "tools"];
    for (const campo of comAcao) {
      const r = capturar(() => validarAnaliseVendasIA({ resumo: "r", destaques: [], alertas: [], [campo]: ["x"] }));
      ok(`S1 campo de acao "${campo}" e recusado`, r.lancou);
    }
    ok("S2 o schema publicado nao declara campo de acao/comando/tool",
       !/acao|acoes|sugest|comando|tool/i.test(JSON.stringify(SCHEMA_ANALISE_VENDAS_IA)));

    for (const campo of ["faturamento", "ticketMedio", "variacao", "projecao"]) {
      const r = capturar(() => validarAnaliseVendasIA({ resumo: "r", destaques: [], alertas: [], [campo]: 10 }));
      ok(`T1 campo numerico "${campo}" e recusado no contrato da IA`, r.lancou);
    }
    ok("T2 o schema nao declara nenhum tipo numerico",
       !/"(number|integer)"/.test(JSON.stringify(SCHEMA_ANALISE_VENDAS_IA)));
    ok("T3 CONTROLE NEGATIVO: os predicados S2/T2 acusam se o campo existir",
       /tool/i.test(JSON.stringify({ tools: 1 })) && /"number"/.test(JSON.stringify({ x: { type: "number" } })));
  }

  // ═══ X. INSTRUCAO — orienta, nao autoriza ════════════════════════
  console.log("X. Instrucao de sistema");
  {
    ok("X1 declara que os numeros sao fatos ja calculados pelo CDS", /JA CALCULADO pelo CDS/.test(INSTRUCAO_INTERPRETACAO_VENDAS));
    ok("X2 proibe recalcular/substituir valor", /NAO recalcule/.test(INSTRUCAO_INTERPRETACAO_VENDAS) && /NAO substitua/.test(INSTRUCAO_INTERPRETACAO_VENDAS));
    ok("X3 proibe inventar metrica", /NAO invente metrica/.test(INSTRUCAO_INTERPRETACAO_VENDAS));
    ok("X4 proibe propor ou executar acao", /NAO proponha nem execute acao/.test(INSTRUCAO_INTERPRETACAO_VENDAS));
    ok("X5 avisa que receita nao e rentabilidade", /nunca lucro nem margem/.test(INSTRUCAO_INTERPRETACAO_VENDAS));
    ok("X6 avisa sobre ranking cortado", /skusOmitidos/.test(INSTRUCAO_INTERPRETACAO_VENDAS));
    ok("X7 exige o formato do contrato", /resumo, destaques e alertas/.test(INSTRUCAO_INTERPRETACAO_VENDAS));
    ok("X8 a instrucao NAO contem identificador nem credencial",
       !/user_?id|tenant|projeto|job|secret|token|senha|https?:\/\//i.test(INSTRUCAO_INTERPRETACAO_VENDAS));
    ok("X9 a instrucao e constante (nao depende da analise)",
       prepararPedidoInterpretacao(analiseFixture()).instrucao === INSTRUCAO_INTERPRETACAO_VENDAS);
  }

  const total = passou + falhou;
  console.log(`\n${"=".repeat(58)}`);
  console.log(`AGENTES-FASE1E-b — composicao pura analise -> IA:  ${passou}/${total} passaram`);
  if (falhou > 0) {
    console.log(`${falhou} FALHARAM`);
    process.exitCode = 1;
  } else console.log("TODOS OS ASSERTS PASSARAM");
  console.log("=".repeat(58));
}

main().catch((e) => {
  console.error("ERRO NAO TRATADO:", e instanceof Error ? e.message.slice(0, 300) : "desconhecido");
  process.exitCode = 1;
});
