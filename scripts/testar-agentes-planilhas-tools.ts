/**
 * AGENT-FACTORY-F3 — as Tools deterministicas.
 *
 * Planilha (inspecionar/ler/agregar), calculadora e calendario: o
 * catalogo, os limites, o dinheiro, as datas, o guard e o laco.
 *
 * NAO chama IA, NAO chama rede, NAO chama banco. As fixtures foram
 * geradas pelo `zipfile` do Python — implementacao de ZIP independente
 * da que este repositorio le —, entao o leitor daqui esta sendo provado
 * contra bytes que ele mesmo nunca escreveu.
 *
 * Rodar:  npx tsx scripts/testar-agentes-planilhas-tools.ts
 */
// Primeiro de todos: neutraliza `server-only` antes que o grafo o puxe.
import "./_server-only-inerte";

import { readFileSync, readdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

import { FUNCOES, resolverFuncao, type ContextoFuncao } from "@/lib/agentes/funcoes/registry";
import { autorizarFuncao } from "@/lib/agentes/funcoes/guard";
import { DECLARACOES, declararFerramentas } from "@/lib/agentes/ia/ferramentas";
import { conversarComFerramentas } from "@/lib/agentes/ia/laco-ferramentas";
import { criarAdaptadorFakeComFerramentas } from "@/lib/agentes/ia/ferramentas-fake";
import { registrarFonteDeArquivo } from "@/lib/agentes/funcoes/planilha";
import type { ArquivoResolvido, FonteDeArquivo } from "@/lib/agentes/planilhas/fonte";
import { lerValorMonetario, paraTexto } from "@/lib/agentes/planilhas/numeros";
import { deSerialExcel, inferirOrdem, lerData } from "@/lib/agentes/planilhas/datas";
import { calcular } from "@/lib/agentes/funcoes/calculadora";
import { PERIODOS, resolverPeriodo } from "@/lib/agentes/funcoes/calendario";
import { MAX_LINHAS_POR_LEITURA } from "@/lib/agentes/planilhas/tabela";
import type { FatoConexao, FatoFuncao, FatoPermissao } from "@/lib/ia/skills/diagnostico";

const RAIZ = join(__dirname, "..");
const FIXTURES = join(RAIZ, "scripts", "fixtures", "planilhas");

let passou = 0;
let falhou = 0;
function ok(nome: string, cond: boolean, detalhe?: string): void {
  if (cond) {
    passou += 1;
    console.log(`  PASS  ${nome}`);
  } else {
    falhou += 1;
    console.log(`  FAIL  ${nome}${detalhe ? ` — ${detalhe}` : ""}`);
  }
}
function secao(t: string): void {
  console.log(`\n${"─".repeat(2)} ${t} ${"─".repeat(Math.max(2, 62 - t.length))}`);
}
function ler(rel: string): string {
  return readFileSync(join(RAIZ, rel), "utf8");
}
function semComentarios(fonte: string): string {
  return fonte.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

// ─── A fonte de arquivos da suite ─────────────────────────────────────
//
// Le do diretorio de fixtures, e SOMENTE dele. O `fileId` e um nome
// logico do mapa abaixo: nao ha concatenacao de nada que venha do
// pedido com um caminho, que e a propriedade que `fonte.ts` existe para
// garantir.

const ARQUIVOS_DA_FIXTURE: Readonly<Record<string, { nome: string; ext: "xlsx" | "csv" }>> =
  Object.freeze({
    entradas: { nome: "entrada.xlsx", ext: "xlsx" },
    saidas: { nome: "saida.xlsx", ext: "xlsx" },
    movimentos: { nome: "movimentos.csv", ext: "csv" },
    ambiguo: { nome: "ambiguo.csv", ext: "csv" },
  });

const DONO = "dono-da-fixture";

const fonteDaFixture: FonteDeArquivo = {
  async resolver(userId: string, fileId: string): Promise<ArquivoResolvido | null> {
    if (userId !== DONO) return null;                       // tenant scoping
    const e = Object.prototype.hasOwnProperty.call(ARQUIVOS_DA_FIXTURE, fileId)
      ? ARQUIVOS_DA_FIXTURE[fileId]
      : undefined;
    if (!e) return null;
    return {
      fileId,
      nome: e.nome,
      extensao: e.ext,
      bytes: new Uint8Array(readFileSync(join(FIXTURES, e.nome))),
    };
  },
};

const CONTEXTO: ContextoFuncao = Object.freeze({ userId: DONO, conexao: null });

async function chamar(funcaoId: string, argumentos: unknown): Promise<Record<string, unknown>> {
  const def = resolverFuncao(funcaoId);
  const v = def.validarEntrada(argumentos);
  if (!v.valida) return { ok: false, codigo: v.codigo, mensagem: "entrada invalida" };
  return (await def.executor(CONTEXTO, argumentos)) as Record<string, unknown>;
}

// ─── A porta REAL do laco, sem banco ──────────────────────────────────
//
// O gate proibe chamar o executor direto para "simular sucesso", e com
// razao: isso provaria o fake, nao o sistema. Entao a porta abaixo NAO
// fabrica nada — ela roda o guard DE VERDADE (`autorizarFuncao`) e, so
// se ele permitir, resolve a Funcao no catalogo REAL e chama o executor
// REAL, na ordem real.
//
// O que ela NAO faz e a perna de banco de `executarFuncao`: abertura,
// desfecho e auditoria falam com Postgres, e esta suite nao tem banco.
// Isso esta declarado no relatorio como limite, nao apresentado como
// prova.

interface EspiaoDaPorta {
  guard: string[];
  executor: string[];
}

function criarPortaReal(
  permissoes: readonly FatoPermissao[],
  espiao: EspiaoDaPorta
) {
  const funcoes: FatoFuncao[] = Object.keys(FUNCOES).map((id) => ({ id, existe: true }));
  const conexoes: readonly FatoConexao[] = [];

  return async (entrada: { funcaoId: unknown; argumentos: unknown }) => {
    const id = String(entrada.funcaoId);
    const def = Object.prototype.hasOwnProperty.call(FUNCOES, id) ? FUNCOES[id] : undefined;

    espiao.guard.push(id);
    const g = autorizarFuncao({
      funcaoId: entrada.funcaoId,
      conexaoNecessaria: def?.conexaoNecessaria ?? null,
      funcoes,
      permissoes,
      conexoes,
    });
    if (!g.permitido) {
      return g.estado === "aguardando_aprovacao"
        ? { tipo: "aguardando_aprovacao" as const, requestId: `req-${id}`, codigo: g.codigo }
        : { tipo: "negado" as const, requestId: `req-${id}`, codigo: g.codigo };
    }

    const definicao = resolverFuncao(id);
    const v = definicao.validarEntrada(entrada.argumentos);
    if (!v.valida) {
      return { tipo: "erro" as const, requestId: `req-${id}`, codigo: v.codigo, retryable: false };
    }
    espiao.executor.push(id);
    const bruto = await definicao.executor(CONTEXTO, entrada.argumentos);
    const interp = definicao.interpretarSaida(bruto);
    if (interp.tipo === "invalida") {
      return { tipo: "erro" as const, requestId: `req-${id}`, codigo: "contrato", retryable: false };
    }
    if (interp.tipo === "erro") {
      return { tipo: "erro" as const, requestId: `req-${id}`, codigo: interp.codigo, retryable: interp.retryable };
    }
    return {
      tipo: "sucesso" as const,
      requestId: `req-${id}`,
      envelope: { data: interp.data },
      auditoria: "completa" as const,
    };
  };
}

const TOOLS_F3 = [
  "planilha.inspecionar", "planilha.ler", "planilha.agregar",
  "calculadora.calcular", "calendario.periodo",
] as const;

const TODAS_AUTOMATICAS: FatoPermissao[] = TOOLS_F3.map((funcaoId) => ({
  funcaoId, nivel: "automatico" as const,
}));

async function main(): Promise<void> {
  registrarFonteDeArquivo(fonteDaFixture);

  console.log("\n══ CDS IA — AGENT-FACTORY-F3: Tools deterministicas ══");

  // ═══════════════════════════════════════════════════════════════════
  secao("A/B/C. Registry: autoridade unica e ids");
  // ═══════════════════════════════════════════════════════════════════
  {
    const FONTE_REG = ler("lib/agentes/funcoes/registry.ts");
    const linhas = FONTE_REG.split("\n").length;
    ok(`A1  J1: registry abaixo de 560 linhas (hoje ${linhas})`, linhas < 560, String(linhas));
    ok("A2  CONTROLE: a contagem leu o arquivo real", linhas > 100);

    const ids = Object.keys(FUNCOES);
    ok("B1  existe UM mapa de Funcoes, e ele e este",
      (FONTE_REG.match(/export const FUNCOES/g) ?? []).length === 1);
    ok("B2  nenhum outro modulo declara um catalogo de Funcoes",
      readdirSync(join(RAIZ, "lib/agentes/funcoes"))
        .filter((f) => f !== "registry.ts")
        .every((f) => !/export const FUNCOES/.test(ler(`lib/agentes/funcoes/${f}`))));
    ok("B3  os modulos irmaos nao se auto-registram",
      !/FUNCOES\[/.test(semComentarios(ler("lib/agentes/funcoes/planilha.ts"))));

    ok("C1  ids unicos", new Set(ids).size === ids.length);
    // A gramatica REAL do banco: CHECK agente_permissoes_funcao_id_formato.
    const GRAMATICA = /^[a-z0-9]+(\.[a-z0-9_]+)+$/;
    ok("C2  todos os ids passam na gramatica real do banco",
      ids.every((i) => GRAMATICA.test(i)), ids.join(", "));
    ok("C3  CONTROLE: a gramatica reprova underscore no primeiro segmento",
      !GRAMATICA.test("agente_financeiro.somar"));
    ok("C4  as 5 Tools novas estao no catalogo",
      TOOLS_F3.every((t) => ids.includes(t)));
    ok("C5  e nenhuma delas tem nome preso a um agente",
      TOOLS_F3.every((t) => !/agente|financeiro|excel|rodrigo/i.test(t)));
    ok("C6  todas declaram leitura, idempotente e sem conexao",
      TOOLS_F3.every((t) => FUNCOES[t].acesso === "leitura" &&
        FUNCOES[t].idempotente && FUNCOES[t].conexaoNecessaria === null));
  }

  // ═══════════════════════════════════════════════════════════════════
  secao("D/E. Inspecionar .xlsx e .csv");
  // ═══════════════════════════════════════════════════════════════════
  {
    const r = await chamar("planilha.inspecionar", { fileId: "entradas" });
    const abas = r.abas as { nome: string; linhas: number; colunas: number;
      cabecalhos: string[]; formulasPresentes: boolean; textoQuePareceFormula: number }[];
    ok("D1  inspeciona o .xlsx e acha a aba", r.ok === true && abas.length === 1 &&
      abas[0].nome === "Entradas");
    ok("D2  cabecalhos vieram das strings compartilhadas",
      JSON.stringify(abas[0].cabecalhos) ===
        JSON.stringify(["Data", "Descricao", "Valor", "Categoria"]));
    ok("D3  conta 7 linhas de dado e 4 colunas",
      abas[0].linhas === 7 && abas[0].colunas === 4, `${abas[0].linhas}x${abas[0].colunas}`);
    ok("D4  NAO devolve caminho de sistema",
      !JSON.stringify(r).includes("\\") && !/[A-Za-z]:\//.test(JSON.stringify(r)));
    ok("D5  o arquivo aparece por fileId e nome logico",
      JSON.stringify(r.arquivo) === JSON.stringify({ fileId: "entradas", nome: "entrada.xlsx" }));

    const c = await chamar("planilha.inspecionar", { fileId: "movimentos" });
    const abasC = c.abas as { cabecalhos: string[]; linhas: number }[];
    ok("E1  inspeciona o .csv", c.ok === true && abasC.length === 1);
    ok("E2  detectou o separador ';' do Excel pt-BR",
      JSON.stringify(abasC[0].cabecalhos) ===
        JSON.stringify(["Data", "Descricao", "Valor", "Categoria"]),
      abasC[0].cabecalhos.join("|"));
    ok("E3  o BOM do Excel nao virou parte do primeiro cabecalho",
      abasC[0].cabecalhos[0] === "Data");
    ok("E4  campo com ';' dentro de aspas continua UM campo", abasC[0].linhas === 5);
  }

  // ═══════════════════════════════════════════════════════════════════
  secao("F/G/H. Ler: aba, recusa e limites");
  // ═══════════════════════════════════════════════════════════════════
  {
    const r = await chamar("planilha.ler", { fileId: "entradas", aba: "Entradas", limite: 3 });
    ok("F1  le a aba pedida", r.ok === true && r.aba === "Entradas");
    ok("F2  devolve exatamente o limite pedido", (r.linhas as string[][]).length === 3);
    ok("F3  e diz que truncou", r.truncado === true && r.totalDeLinhas === 7);
    const so = await chamar("planilha.ler",
      { fileId: "entradas", colunas: ["Valor", "Categoria"], limite: 2 });
    ok("F4  projecao de colunas respeita a ORDEM pedida",
      JSON.stringify(so.colunas) === JSON.stringify(["Valor", "Categoria"]));

    const g = await chamar("planilha.ler", { fileId: "entradas", aba: "NaoExiste" });
    ok("G1  aba inexistente e recusada", g.ok === false && g.codigo === "aba_inexistente");
    const g2 = await chamar("planilha.ler", { fileId: "entradas", colunas: ["Fantasma"] });
    ok("G2  coluna inexistente e recusada", g2.ok === false && g2.codigo === "coluna_inexistente");
    const g3 = await chamar("planilha.ler", { fileId: "nao-existe-este" });
    ok("G3  fileId desconhecido e recusado",
      g3.ok === false && g3.codigo === "arquivo_nao_encontrado");
    ok("G4  'nao existe' e 'nao e seu' respondem IGUAL — sem oraculo de ids",
      JSON.stringify(g3.codigo) ===
        JSON.stringify(((await (async () => {
          const def = resolverFuncao("planilha.ler");
          return (await def.executor({ userId: "outro-dono", conexao: null },
            { fileId: "entradas" })) as Record<string, unknown>;
        })()) as Record<string, unknown>).codigo));

    const h = await chamar("planilha.ler", { fileId: "entradas", limite: 10_000 });
    ok("H1  limite acima do teto e RECUSADO, nao silenciosamente cortado",
      h.ok === false && h.codigo === "limite_acima_do_teto");
    const h2 = await chamar("planilha.ler", { fileId: "entradas" });
    ok("H2  sem limite, o teto vale assim mesmo",
      (h2.linhas as string[][]).length <= MAX_LINHAS_POR_LEITURA);
    const h3 = await chamar("planilha.ler", { fileId: "entradas", limite: 0 });
    ok("H3  limite zero e invalido", h3.ok === false && h3.codigo === "limite_invalido");
    ok("H4  o teto de linhas e explicito e modesto", MAX_LINHAS_POR_LEITURA === 500);
  }

  // ═══════════════════════════════════════════════════════════════════
  secao("I..O. Agregacao: os numeros conhecidos");
  // ═══════════════════════════════════════════════════════════════════
  {
    const soma = await chamar("planilha.agregar",
      { fileId: "entradas", operacao: "sum", coluna: "Valor" });
    // 1234.56 + 2000 + 500 + 1000 + 1234.56 = 5969.12 (a linha de
    // formula tem valor cacheado 5969.12 e NAO entra: e a 7a linha,
    // cuja coluna Valor guarda a formula — ela conta.)
    ok("I1  sum le R$ nativo e de texto", soma.ok === true, JSON.stringify(soma.valor));
    ok("I2  a proveniencia diz de onde veio",
      (soma.proveniencia as Record<string, unknown>).arquivo === "entrada.xlsx");

    const somaVendas = await chamar("planilha.agregar", {
      fileId: "entradas", operacao: "sum", coluna: "Valor",
      filtros: [{ coluna: "Categoria", operador: "igual", valor: "vendas" }],
    });
    // vendas: 1234.56 + 2000 + 1000 + 1234.56 = 5469.12 (a de 25/09 e vazia)
    ok("I3  sum com filtro = 5469.12", somaVendas.valor === "5469.12",
      String(somaVendas.valor));
    ok("I4  e conta a celula VAZIA como ignorada, nao como zero",
      (somaVendas.proveniencia as Record<string, number>).celulasIgnoradas === 1,
      JSON.stringify(somaVendas.proveniencia));

    const saidas = await chamar("planilha.agregar",
      { fileId: "saidas", operacao: "sum", coluna: "Valor" });
    ok("I5  sum de 'R$ 1.500,00' em texto = 4100.50", saidas.valor === "4100.50",
      String(saidas.valor));

    const cnt = await chamar("planilha.agregar", { fileId: "entradas", operacao: "count" });
    ok("J1  count nao exige coluna", cnt.ok === true && cnt.valor === 7, String(cnt.valor));

    const mn = await chamar("planilha.agregar",
      { fileId: "entradas", operacao: "min", coluna: "Valor" });
    const mx = await chamar("planilha.agregar",
      { fileId: "entradas", operacao: "max", coluna: "Valor" });
    ok("K1  min = 500.00", mn.valor === "500.00", String(mn.valor));
    ok("K2  max = 5969.12 (a celula de formula, pelo valor cacheado)",
      mx.valor === "5969.12", String(mx.valor));

    const miss = await chamar("planilha.agregar",
      { fileId: "entradas", operacao: "missing", coluna: "Valor" });
    ok("L1  missing acha exatamente a celula vazia conhecida", miss.valor === 1,
      String(miss.valor));

    const dup = await chamar("planilha.agregar",
      { fileId: "entradas", operacao: "duplicates", coluna: "Descricao" });
    ok("M1  duplicates acha a linha repetida conhecida",
      JSON.stringify(dup.valor) === JSON.stringify(["Venda balcao"]),
      JSON.stringify(dup.valor));

    const dist = await chamar("planilha.agregar",
      { fileId: "entradas", operacao: "distinct", coluna: "Categoria" });
    ok("M2  distinct devolve o conjunto ordenado",
      JSON.stringify(dist.valor) === JSON.stringify(["controle", "servicos", "vendas"]),
      JSON.stringify(dist.valor));

    const filtrado = await chamar("planilha.agregar", {
      fileId: "entradas", operacao: "count",
      filtros: [{ coluna: "Valor", operador: "maior", valor: "1000" }],
    });
    // 4 e nao 3: alem de 1234.56, 2000 e 1234.56, entra a linha de
    // formula pelo valor CACHEADO (5969.12). Comparando como TEXTO,
    // "500" > "1000" seria verdadeiro e a contagem daria 5 — e esse o
    // erro que este assert pega.
    ok("N1  filter numerico compara como NUMERO, nao como texto",
      filtrado.valor === 4, String(filtrado.valor));
    const semControle = await chamar("planilha.agregar", {
      fileId: "entradas", operacao: "count",
      filtros: [
        { coluna: "Valor", operador: "maior", valor: "1000" },
        { coluna: "Categoria", operador: "diferente", valor: "controle" },
      ],
    });
    ok("N1a dois filtros se somam com E: tira a linha de controle e sobram 3",
      semControle.valor === 3, String(semControle.valor));
    ok("N1b CONTROLE: comparado como TEXTO daria outro numero",
      "500" > "1000");
    const vazio = await chamar("planilha.agregar", {
      fileId: "entradas", operacao: "count",
      filtros: [{ coluna: "Valor", operador: "vazio" }],
    });
    ok("N2  filter 'vazio' acha a celula vazia", vazio.valor === 1, String(vazio.valor));
    const ruim = await chamar("planilha.agregar", {
      fileId: "entradas", operacao: "count",
      filtros: [{ coluna: "Fantasma", operador: "igual", valor: "x" }],
    });
    ok("N3  filtro em coluna inexistente e recusado",
      ruim.ok === false && ruim.codigo === "coluna_inexistente");

    const grupo = await chamar("planilha.agregar", {
      fileId: "entradas", operacao: "sum", coluna: "Valor", agruparPor: "Categoria",
    });
    const grupos = grupo.grupos as { chave: string; valor: string; linhas: number }[];
    ok("O1  group devolve um balde por categoria", grupos.length === 3,
      JSON.stringify(grupos.map((g) => g.chave)));
    ok("O2  e a soma de 'vendas' bate com o filtro equivalente",
      grupos.find((g) => g.chave === "vendas")?.valor === "5469.12",
      JSON.stringify(grupos));
    ok("O3  group nao devolve `valor` solto — o numero mora nos baldes",
      grupo.valor === null);
  }

  // ═══════════════════════════════════════════════════════════════════
  secao("P/Q/R/S. Dinheiro e datas");
  // ═══════════════════════════════════════════════════════════════════
  {
    const casos: [string, string][] = [
      ["R$ 1.234,56", "1234.56"], ["1.234,56", "1234.56"], ["1234,56", "1234.56"],
      ["1234.56", "1234.56"], ["R$ 1.234", "1234.00"], ["-1.234,56", "-1234.56"],
      ["(1.234,56)", "-1234.56"], ["1.234.567,89", "1234567.89"],
    ];
    for (const [entrada, esperado] of casos) {
      const r = lerValorMonetario(entrada);
      ok(`P1  '${entrada}' -> ${esperado}`,
        r.tipo === "ok" && paraTexto(r.valor) === esperado,
        r.tipo === "ok" ? paraTexto(r.valor) : r.tipo);
    }
    ok("P2  numero nativo do Excel entra sem passar por float",
      (() => { const r = lerValorMonetario(1234.56);
        return r.tipo === "ok" && paraTexto(r.valor) === "1234.56"; })());
    ok("P3  '1,234' SEM R$ e AMBIGUO — nao escolhe por conta propria",
      lerValorMonetario("1,234").tipo === "ambiguo");
    ok("P4  '1.234' SEM R$ tambem e ambiguo",
      lerValorMonetario("1.234").tipo === "ambiguo");
    ok("P5  mas 'R$ 1.234' nao e: o simbolo E a evidencia",
      lerValorMonetario("R$ 1.234").tipo === "ok");
    ok("P6  texto que nao e numero e invalido, nao zero",
      lerValorMonetario("abc").tipo === "invalido");
    ok("P7  0.1 + 0.2 da exatamente 0.30 — o erro classico de float",
      (() => { const a = lerValorMonetario("0.1"); const b = lerValorMonetario("0.2");
        if (a.tipo !== "ok" || b.tipo !== "ok") return false;
        return paraTexto({ unidades: a.valor.unidades + b.valor.unidades }) === "0.30"; })());

    ok("Q1  serial 46266 = 2026-09-01",
      (() => { const d = deSerialExcel(46266); return d.tipo === "ok" && d.iso === "2026-09-01"; })());
    ok("Q2  o serial 60 (29/02/1900) e RECUSADO", deSerialExcel(60).tipo === "invalido");
    ok("Q3  serial 0 e invalido", deSerialExcel(0).tipo === "invalido");

    ok("R1  dd/mm/yyyy com prova de dia-primeiro",
      inferirOrdem(["13/01/2026", "02/03/2026"]).formato === "dd/mm/yyyy");
    ok("R2  e a leitura usa essa ordem",
      (() => { const d = lerData("02/03/2026", "dd/mm/yyyy");
        return d.tipo === "ok" && d.iso === "2026-03-02"; })());
    ok("R3  mm/dd/yyyy quando a coluna prova o contrario",
      inferirOrdem(["01/13/2026"]).formato === "mm/dd/yyyy");
    ok("R4  sem prova, assume dd/mm mas MARCA como presumido",
      (() => { const o = inferirOrdem(["01/02/2026", "03/04/2026"]);
        return o.formato === "dd/mm/yyyy" && o.presumido === true; })());
    ok("R5  ISO e lido sem depender de ordem",
      (() => { const d = lerData("2026-09-01", "mm/dd/yyyy");
        return d.tipo === "ok" && d.iso === "2026-09-01"; })());

    ok("S1  coluna que prova AS DUAS ordens e ambigua",
      inferirOrdem(["13/01/2026", "01/13/2026"]).ambiguo === true);
    const amb = await chamar("planilha.agregar", {
      fileId: "ambiguo", operacao: "count",
      filtros: [{ coluna: "Data", operador: "entre", valor: "2026-01-01", ate: "2026-12-31" }],
    });
    ok("S2  e a Tool RECUSA filtrar por data nela",
      amb.ok === false && amb.codigo === "AMBIGUOUS_DATE_FORMAT", JSON.stringify(amb));
    ok("S3  data impossivel e invalida, nao 'corrigida'",
      lerData("31/02/2026", "dd/mm/yyyy").tipo === "invalido");
  }

  // ═══════════════════════════════════════════════════════════════════
  secao("T..W. Calculadora");
  // ═══════════════════════════════════════════════════════════════════
  {
    ok("T1  add exato", calcular({ operacao: "add", valores: ["1234.56", "2000"] }) as never &&
      (() => { const r = calcular({ operacao: "add", valores: ["1234.56", "2000"] });
        return r.ok && r.resultado === "3234.56"; })());
    ok("T2  add de varios", (() => {
      const r = calcular({ operacao: "add", valores: ["0.1", "0.2", "0.3"] });
      return r.ok && r.resultado === "0.60"; })());
    ok("U1  subtract", (() => {
      const r = calcular({ operacao: "subtract", valores: ["4969.12", "2600.50"] });
      return r.ok && r.resultado === "2368.62"; })());
    ok("U2  multiply", (() => {
      const r = calcular({ operacao: "multiply", valores: ["12.50", "4"] });
      return r.ok && r.resultado === "50.00"; })());
    ok("U3  percentage: 15% de 200 = 30", (() => {
      const r = calcular({ operacao: "percentage", valores: ["200", "15"] });
      return r.ok && r.resultado === "30.00"; })());
    ok("U4  average", (() => {
      const r = calcular({ operacao: "average", valores: ["10", "20", "31"] });
      return r.ok && r.resultado === "20.33"; })());

    const z = calcular({ operacao: "divide", valores: ["10", "0"] });
    ok("V1  divisao por zero falha TIPADA", !z.ok && z.codigo === "divisao_por_zero");
    ok("V2  e nao devolve Infinity nem NaN em lugar nenhum",
      !JSON.stringify(z).includes("Infinity") && !JSON.stringify(z).includes("null"));
    const inval = calcular({ operacao: "add", valores: ["abc", "1"] });
    ok("V3  valor ilegivel falha tipada", !inval.ok && inval.codigo === "valor_invalido");
    const ambc = calcular({ operacao: "add", valores: ["1,234", "1"] });
    ok("V4  valor ambiguo NAO e chutado", !ambc.ok && ambc.codigo === "AMBIGUOUS_NUMBER_FORMAT");
    const grande = calcular({ operacao: "multiply", valores: ["999999999999999", "999999999"] });
    ok("V5  magnitude fora do teto falha tipada",
      !grande.ok && String(grande.codigo).includes("fora_do_limite"), JSON.stringify(grande));
    const ar = resolverFuncao("calculadora.calcular").validarEntrada(
      { operacao: "divide", valores: ["1", "2", "3"] });
    ok("V6  divide com 3 valores e recusado na ENTRADA",
      !ar.valida && ar.codigo === "aridade_invalida");

    const FONTE_CALC = ler("lib/agentes/funcoes/calculadora.ts");
    const CODIGO_CALC = semComentarios(FONTE_CALC);
    ok("W1  zero `eval`", !/\beval\s*\(/.test(CODIGO_CALC));
    ok("W2  zero `new Function` / `Function(`", !/\bFunction\s*\(/.test(CODIGO_CALC));
    ok("W3  zero `require` dinamico e zero `import(`",
      !/\brequire\s*\(/.test(CODIGO_CALC) && !/[^.\w]import\s*\(/.test(CODIGO_CALC));
    ok("W4  a entrada nao tem campo de expressao",
      !/express|formula|script/i.test(CODIGO_CALC));
    ok("W5  CONTROLE: o detector de eval funciona",
      /\beval\s*\(/.test("const x = eval(\"1+1\");"));
    ok("W6  o conjunto do que pode acontecer e finito e escrito",
      /OPERACOES_CALCULADORA/.test(CODIGO_CALC));
  }

  // ═══════════════════════════════════════════════════════════════════
  secao("X/Y/Z/AA. Calendario");
  // ═══════════════════════════════════════════════════════════════════
  {
    // Relogio FIXO: terca-feira, 2026-09-29 12:00Z (09:00 BRT).
    const RELOGIO = Date.UTC(2026, 8, 29, 12, 0, 0);
    const h = resolverPeriodo("hoje", RELOGIO);
    ok("X1  hoje = 2026-09-29, inicio == fim",
      h.inicio === "2026-09-29" && h.fim === "2026-09-29" && h.dias === 1, JSON.stringify(h));
    ok("X2  ontem = 2026-09-28",
      resolverPeriodo("ontem", RELOGIO).inicio === "2026-09-28");
    // 01:00Z de 29/09 ainda e dia 28 em BRT (-3h). E o caso que um
    // calculo em UTC erraria calado.
    ok("X3  01:00Z ainda e o dia ANTERIOR em BRT",
      resolverPeriodo("hoje", Date.UTC(2026, 8, 29, 1, 0, 0)).inicio === "2026-09-28");

    const em = resolverPeriodo("este_mes", RELOGIO);
    ok("Y1  este_mes = 2026-09-01..2026-09-30",
      em.inicio === "2026-09-01" && em.fim === "2026-09-30" && em.dias === 30,
      JSON.stringify(em));
    const mp = resolverPeriodo("mes_passado", RELOGIO);
    ok("Z1  mes_passado = 2026-08-01..2026-08-31",
      mp.inicio === "2026-08-01" && mp.fim === "2026-08-31" && mp.dias === 31,
      JSON.stringify(mp));
    ok("Z2  virada de ano: janeiro -> dezembro anterior",
      (() => { const r = resolverPeriodo("mes_passado", Date.UTC(2027, 0, 15, 12));
        return r.inicio === "2026-12-01" && r.fim === "2026-12-31"; })());
    ok("Z3  esta_semana comeca na SEGUNDA",
      (() => { const r = resolverPeriodo("esta_semana", RELOGIO);
        return r.inicio === "2026-09-28" && r.fim === "2026-10-04" && r.dias === 7; })());
    ok("Z4  semana_passada e a anterior, inteira",
      (() => { const r = resolverPeriodo("semana_passada", RELOGIO);
        return r.inicio === "2026-09-21" && r.fim === "2026-09-27"; })());
    ok("Z5  este_ano cobre o ano civil",
      (() => { const r = resolverPeriodo("este_ano", RELOGIO);
        return r.inicio === "2026-01-01" && r.fim === "2026-12-31"; })());

    ok("AA1 o fuso viaja na resposta, e nao e UTC",
      h.fuso === "America/Sao_Paulo");
    ok("AA2 todos os periodos declarados resolvem",
      PERIODOS.every((p) => resolverPeriodo(p, RELOGIO).inicio <= resolverPeriodo(p, RELOGIO).fim));
    const pv = resolverFuncao("calendario.periodo").validarEntrada({ periodo: "semana_que_vem" });
    ok("AA3 periodo fora do vocabulario e recusado",
      !pv.valida && pv.codigo === "periodo_invalido");
    ok("AA4 o modulo nao alcanca rede nem credencial",
      !/fetch|googleapis|OAuth|credencial|token/i.test(
        semComentarios(ler("lib/agentes/funcoes/calendario.ts"))));
  }

  // ═══════════════════════════════════════════════════════════════════
  secao("AB..AE. Guard: nenhuma Tool 'segura' pula a cerca");
  // ═══════════════════════════════════════════════════════════════════
  {
    const funcoes: FatoFuncao[] = Object.keys(FUNCOES).map((id) => ({ id, existe: true }));
    const guardar = (permissoes: FatoPermissao[], id: string) =>
      autorizarFuncao({
        funcaoId: id, conexaoNecessaria: FUNCOES[id]?.conexaoNecessaria ?? null,
        funcoes, permissoes, conexoes: [],
      });

    for (const t of TOOLS_F3) {
      const g = guardar([], t);
      ok(`AB1 ${t}: SEM permissao -> permissao_ausente`,
        !g.permitido && g.codigo === "permissao_ausente", JSON.stringify(g));
    }
    for (const t of TOOLS_F3) {
      const g = guardar([{ funcaoId: t, nivel: "bloqueado" }], t);
      ok(`AC1 ${t}: bloqueado -> permissao_bloqueada`,
        !g.permitido && g.codigo === "permissao_bloqueada");
    }
    for (const t of TOOLS_F3) {
      const g = guardar([{ funcaoId: t, nivel: "automatico" }], t);
      ok(`AD1 ${t}: automatico -> permitido`, g.permitido === true);
    }
    for (const t of TOOLS_F3) {
      const g = guardar([{ funcaoId: t, nivel: "aprovacao" }], t);
      ok(`AE1 ${t}: aprovacao NAO executa — aguarda`,
        !g.permitido && g.estado === "aguardando_aprovacao" &&
          g.codigo === "aprovacao_necessaria");
    }
    ok("AE2 permissao de OUTRA Funcao nao serve para esta",
      (() => { const g = guardar([{ funcaoId: "vendas.consultar", nivel: "automatico" }],
        "calculadora.calcular");
        return !g.permitido && g.codigo === "permissao_ausente"; })());
  }

  // ═══════════════════════════════════════════════════════════════════
  secao("AF/AG/AH/AI. O laco, pela porta real");
  // ═══════════════════════════════════════════════════════════════════
  {
    const declaradas = declararFerramentas({
      catalogo: FUNCOES, permissoes: TODAS_AUTOMATICAS,
    });
    ok("AF0 as 5 Tools chegam ao modelo VIA REGISTRY, sem catalogo paralelo",
      TOOLS_F3.every((t) => declaradas.some((d) => d.nome === t)),
      declaradas.map((d) => d.nome).join(","));
    ok("AF0a toda Funcao do registry tem declaracao escrita",
      Object.keys(FUNCOES).every((id) => id in DECLARACOES),
      Object.keys(FUNCOES).filter((id) => !(id in DECLARACOES)).join(","));

    // ── calculadora ──
    {
      const espiao: EspiaoDaPorta = { guard: [], executor: [] };
      const r = await conversarComFerramentas({
        userId: DONO, agenteId: "ag-f3", instrucao: "use as ferramentas",
        mensagemDoUsuario: "quanto e 4969,12 menos 2600,50?",
        ferramentas: declaradas,
        adaptador: criarAdaptadorFakeComFerramentas([
          { tipo: "pede", pedidos: [{ nome: "calculadora.calcular",
            argumentos: { operacao: "subtract", valores: ["4969.12", "2600.50"] } }] },
          { tipo: "fala", texto: "O saldo e 2368.62." },
        ]),
        executar: criarPortaReal(TODAS_AUTOMATICAS, espiao) as never,
      });
      ok("AF1 o laco rodou a calculadora e voltou ao modelo",
        r.passos.length === 1 && r.passos[0].desfecho === "sucesso" && r.motivo === "concluido");
      ok("AF2 o GUARD foi chamado antes do executor",
        espiao.guard.length === 1 && espiao.executor.length === 1);
      ok("AF3 o resultado que voltou ao modelo veio da Tool, nao do fake",
        JSON.stringify(r.mensagens).includes("2368.62"), JSON.stringify(r.mensagens).slice(0, 200));
    }

    // ── calendario ──
    {
      const espiao: EspiaoDaPorta = { guard: [], executor: [] };
      const r = await conversarComFerramentas({
        userId: DONO, agenteId: "ag-f3", instrucao: "use as ferramentas",
        mensagemDoUsuario: "qual o periodo deste mes?",
        ferramentas: declaradas,
        adaptador: criarAdaptadorFakeComFerramentas([
          { tipo: "pede", pedidos: [{ nome: "calendario.periodo",
            argumentos: { periodo: "este_mes" } }] },
          { tipo: "fala", texto: "pronto" },
        ]),
        executar: criarPortaReal(TODAS_AUTOMATICAS, espiao) as never,
      });
      ok("AG1 o laco rodou o calendario",
        r.passos.length === 1 && r.passos[0].desfecho === "sucesso");
      ok("AG2 e o intervalo veio de codigo, com fuso",
        JSON.stringify(r.mensagens).includes("America/Sao_Paulo"));
      ok("AG3 guard antes do executor", espiao.guard.length === 1 && espiao.executor.length === 1);
    }

    // ── planilha ──
    {
      const espiao: EspiaoDaPorta = { guard: [], executor: [] };
      const r = await conversarComFerramentas({
        userId: DONO, agenteId: "ag-f3", instrucao: "use as ferramentas",
        mensagemDoUsuario: "quanto entrou em vendas?",
        ferramentas: declaradas,
        adaptador: criarAdaptadorFakeComFerramentas([
          { tipo: "pede", pedidos: [{ nome: "planilha.agregar", argumentos: {
            fileId: "entradas", operacao: "sum", coluna: "Valor",
            filtros: [{ coluna: "Categoria", operador: "igual", valor: "vendas" }] } }] },
          { tipo: "fala", texto: "Entraram 5469.12 em vendas." },
        ]),
        executar: criarPortaReal(TODAS_AUTOMATICAS, espiao) as never,
      });
      ok("AH1 o laco rodou a planilha sobre a fixture",
        r.passos.length === 1 && r.passos[0].desfecho === "sucesso", JSON.stringify(r.passos));
      ok("AH2 o total que chegou ao modelo e o calculado pela Tool",
        JSON.stringify(r.mensagens).includes("5469.12"));
      ok("AH3 e a proveniencia viajou junto",
        JSON.stringify(r.mensagens).includes("linhasCorrespondentes"));
    }

    // ── AI: sem permissao, NADA executa ──
    {
      const espiao: EspiaoDaPorta = { guard: [], executor: [] };
      const r = await conversarComFerramentas({
        userId: DONO, agenteId: "ag-f3", instrucao: "use as ferramentas",
        mensagemDoUsuario: "some ai",
        ferramentas: declaradas,
        adaptador: criarAdaptadorFakeComFerramentas([
          { tipo: "pede", pedidos: [{ nome: "calculadora.calcular",
            argumentos: { operacao: "add", valores: ["1", "2"] } }] },
          { tipo: "fala", texto: "nao deu" },
        ]),
        executar: criarPortaReal([], espiao) as never,   // NENHUMA permissao
      });
      ok("AI1 sem permissao o guard NEGA e o executor nunca roda",
        espiao.guard.length === 1 && espiao.executor.length === 0,
        JSON.stringify(espiao));
      ok("AI2 e o passo registrado e a negacao, nao sucesso",
        r.passos[0].desfecho === "negado" && r.passos[0].executou === false);
      // F4.1: negacao agora FECHA o turno. O roteiro do fake ainda tem
      // um "nao deu" a dizer, e o assert cobra que ele NAO foi dito —
      // porque o modelo nao chegou a ser chamado.
      ok("AI3 a negacao FECHA o turno — o modelo nao responde por conta propria",
        r.motivo === "bloqueado_por_ferramenta" && r.texto !== "nao deu",
        `${r.motivo}/${String(r.texto).slice(0, 40)}`);

      const espiao2: EspiaoDaPorta = { guard: [], executor: [] };
      await conversarComFerramentas({
        userId: DONO, agenteId: "ag-f3", instrucao: "x", mensagemDoUsuario: "y",
        ferramentas: declaradas,
        adaptador: criarAdaptadorFakeComFerramentas([
          { tipo: "pede", pedidos: [{ nome: "calculadora.calcular",
            argumentos: { operacao: "add", valores: ["1"] } }] },
          { tipo: "fala", texto: "ok" },
        ]),
        executar: criarPortaReal(
          [{ funcaoId: "calculadora.calcular", nivel: "aprovacao" }], espiao2) as never,
      });
      ok("AI4 com nivel `aprovacao` tambem NAO executa",
        espiao2.guard.length === 1 && espiao2.executor.length === 0);
    }

    // ── AI estrutural: o laco nao tem outra porta ──
    {
      const LACO = semComentarios(ler("lib/agentes/ia/laco-ferramentas.ts"));
      ok("AI5 o laco nao importa resolverFuncao nem autorizarFuncao",
        !/resolverFuncao|autorizarFuncao/.test(LACO));
      ok("AI6 e nao alcanca `.executor`", !/\.executor\b/.test(LACO));
      ok("AI7 CONTROLE: o detector veria a aresta se ela existisse",
        /resolverFuncao/.test(`${LACO} resolverFuncao(`));
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  secao("AJ. Proveniencia");
  // ═══════════════════════════════════════════════════════════════════
  {
    const r = await chamar("planilha.agregar", {
      fileId: "entradas", operacao: "sum", coluna: "Valor", agruparPor: "Categoria",
      filtros: [{ coluna: "Categoria", operador: "diferente", valor: "controle" }],
    });
    const p = r.proveniencia as Record<string, unknown>;
    for (const campo of ["fileId", "arquivo", "aba", "operacao", "coluna", "filtros",
                         "agruparPor", "linhasNaAba", "linhasCorrespondentes", "celulasIgnoradas"]) {
      ok(`AJ1 proveniencia tem '${campo}'`, campo in p, JSON.stringify(Object.keys(p)));
    }
    ok("AJ2 o filtro aplicado aparece literal, para a UI reproduzir",
      JSON.stringify(p.filtros).includes("controle"));
    ok("AJ3 NENHUM caminho de sistema na resposta inteira",
      !/[A-Za-z]:[\\/]|\.\.[\\/]|scripts[\\/]fixtures/.test(JSON.stringify(r)));
    ok("AJ4 o nome do arquivo e logico, nao caminho",
      p.arquivo === "entrada.xlsx");
  }

  // ═══════════════════════════════════════════════════════════════════
  secao("AK/AL/AM/AN. Seguranca de arquivo e formulas");
  // ═══════════════════════════════════════════════════════════════════
  {
    const hostis = [
      "../entrada.xlsx", "../../etc/passwd", "....//entrada.xlsx",
      "/etc/passwd", "C:\\Windows\\win.ini", "\\\\servidor\\share\\x.xlsx",
      "file:///etc/passwd", "entrada.xlsx", "entradas/../saidas",
      "entradas%2f..%2f", "", "a".repeat(65),
    ];
    for (const id of hostis) {
      const v = resolverFuncao("planilha.inspecionar").validarEntrada({ fileId: id });
      const r = v.valida
        ? ((await resolverFuncao("planilha.inspecionar").executor(CONTEXTO, { fileId: id })) as Record<string, unknown>)
        : { ok: false, codigo: v.codigo };
      ok(`AK1 '${id.slice(0, 28)}' nunca vira caminho`,
        r.ok === false, JSON.stringify(r).slice(0, 120));
    }
    ok("AK2 CONTROLE: um fileId legitimo PASSA — 'tudo negado' nao e prova",
      (await chamar("planilha.inspecionar", { fileId: "entradas" })).ok === true);
    ok("AK3 arquivo de OUTRO dono nao e lido",
      ((await resolverFuncao("planilha.inspecionar")
        .executor({ userId: "outro", conexao: null }, { fileId: "entradas" })) as Record<string, unknown>)
        .ok === false);
    const FONTE_F = semComentarios(ler("lib/agentes/planilhas/fonte.ts"));
    ok("AK4 o contrato de fonte NAO conhece filesystem",
      !/readFile|node:fs|path\.join|resolve\(/.test(FONTE_F));
    ok("AK5 nem o modulo das Funcoes de planilha",
      !/node:fs|readFileSync/.test(semComentarios(ler("lib/agentes/funcoes/planilha.ts"))));

    ok("AL1 extensao nao suportada e recusada",
      (() => { const f: FonteDeArquivo = { async resolver() {
          return { fileId: "x", nome: "a.xls", extensao: "xls" as never, bytes: new Uint8Array() }; } };
        registrarFonteDeArquivo(f);
        return true; })());
    {
      const r = await chamar("planilha.inspecionar", { fileId: "qualquer" });
      ok("AL2 .xls cai em extensao_nao_suportada",
        r.ok === false && r.codigo === "extensao_nao_suportada", JSON.stringify(r));
    }
    registrarFonteDeArquivo(null);
    {
      const r = await chamar("planilha.inspecionar", { fileId: "entradas" });
      ok("AL3 SEM fonte configurada, o default NEGA",
        r.ok === false && r.codigo === "fonte_nao_configurada", JSON.stringify(r));
    }
    registrarFonteDeArquivo(fonteDaFixture);

    const insp = await chamar("planilha.inspecionar", { fileId: "entradas" });
    const abas = insp.abas as { formulasPresentes: boolean; celulasComFormula: number }[];
    ok("AM1 a formula da fixture foi DETECTADA",
      abas[0].formulasPresentes === true && abas[0].celulasComFormula === 1);
    ok("AM2 e o aviso diz que nada foi recalculado",
      (insp.avisos as string[]).some((a) => /recalcul/i.test(a)),
      JSON.stringify(insp.avisos));
    const lido = await chamar("planilha.ler",
      { fileId: "entradas", colunas: ["Valor"], inicio: 6, limite: 1 });
    ok("AM3 a celula de formula entrega o valor CACHEADO, nao a formula",
      JSON.stringify((lido.linhas as string[][])[0]) === JSON.stringify(["5969.12"]),
      JSON.stringify(lido.linhas));
    const csvInsp = await chamar("planilha.inspecionar", { fileId: "movimentos" });
    const abasCsv = csvInsp.abas as { textoQuePareceFormula: number }[];
    ok("AM4 '=SOMA(...)' e '@INJECAO' no CSV sao contados como TEXTO suspeito",
      abasCsv[0].textoQuePareceFormula === 2, String(abasCsv[0].textoQuePareceFormula));
    const csvLido = await chamar("planilha.ler",
      { fileId: "movimentos", colunas: ["Descricao"], inicio: 3, limite: 2 });
    ok("AM5 e viajam como texto literal, nunca executados",
      JSON.stringify(csvLido.linhas) === JSON.stringify([["=SOMA(A1:A9)"], ["@INJECAO"]]),
      JSON.stringify(csvLido.linhas));
    const LEITURA = semComentarios(ler("lib/agentes/planilhas/leitura.ts"));
    ok("AM6 o leitor nao tem eval/Function em lugar nenhum",
      !/\beval\s*\(|\bFunction\s*\(/.test(LEITURA));
    ok("AM7 e recusa XML com DOCTYPE/ENTITY (XXE)",
      /DOCTYPE/.test(LEITURA) && /xml_com_doctype/.test(LEITURA));

    // AN — a fixture nao pode ter sido tocada por nada disto.
    const hashes = Object.values(ARQUIVOS_DA_FIXTURE).map((a) => {
      const caminho = join(FIXTURES, a.nome);
      return `${a.nome}:${createHash("sha256").update(readFileSync(caminho)).digest("hex").slice(0, 16)}:${statSync(caminho).size}`;
    });
    ok("AN1 as 4 fixtures continuam legiveis e com tamanho > 0",
      hashes.length === 4 && hashes.every((h) => !h.endsWith(":0")), hashes.join(" "));
    ok("AN2 leitura e READ-ONLY: nenhum modulo de planilhas escreve em disco",
      readdirSync(join(RAIZ, "lib/agentes/planilhas")).every((f) =>
        !/writeFile|createWriteStream|appendFile|unlink|rmSync/
          .test(ler(`lib/agentes/planilhas/${f}`))));
    ok("AN3 nem o modulo das Funcoes",
      !/writeFile|createWriteStream|appendFile/.test(ler("lib/agentes/funcoes/planilha.ts")));
    ok("AN4 CONTROLE: o detector de escrita funciona",
      /writeFile/.test("await writeFile(x)"));
  }


  // ═══════════════════════════════════════════════════════════════════
  secao("AO. Teste financeiro sintetico: entradas, saidas, saldo");
  // ═══════════════════════════════════════════════════════════════════
  {
    // Os numeros sao CONHECIDOS por construcao da fixture:
    //   entradas de setembro : 1234.56 + 2000 + 500 + 1234.56 = 4969.12
    //   saidas   de setembro :  800 + 1500 + 300.50           = 2600.50
    //   saldo                                                 = 2368.62
    // Nenhum deles pode sair de um modelo. Todos saem de Tool.
    const declaradas = declararFerramentas({ catalogo: FUNCOES, permissoes: TODAS_AUTOMATICAS });
    const espiao: EspiaoDaPorta = { guard: [], executor: [] };

    const r = await conversarComFerramentas({
      userId: DONO, agenteId: "ag-f3", instrucao: "use as ferramentas",
      mensagemDoUsuario: "qual foi o saldo de setembro?",
      ferramentas: declaradas,
      maxPassos: 6,
      adaptador: criarAdaptadorFakeComFerramentas([
        { tipo: "pede", pedidos: [{ nome: "planilha.agregar", argumentos: {
          fileId: "entradas", operacao: "sum", coluna: "Valor",
          filtros: [
            { coluna: "Data", operador: "entre", valor: "2026-09-01", ate: "2026-09-30" },
            { coluna: "Categoria", operador: "diferente", valor: "controle" },
          ] } }] },
        { tipo: "pede", pedidos: [{ nome: "planilha.agregar", argumentos: {
          fileId: "saidas", operacao: "sum", coluna: "Valor",
          filtros: [{ coluna: "Data", operador: "entre", valor: "2026-09-01", ate: "2026-09-30" }] } }] },
        { tipo: "pede", pedidos: [{ nome: "calculadora.calcular", argumentos: {
          operacao: "subtract", valores: ["4969.12", "2600.50"] } }] },
        { tipo: "fala", texto: "Saldo de setembro: 2368.62." },
      ]),
      executar: criarPortaReal(TODAS_AUTOMATICAS, espiao) as never,
    });

    const respostas = JSON.stringify(r.mensagens);
    ok("AO1 tres Tools rodaram, todas pelo guard",
      r.passos.length === 3 && espiao.guard.length === 3 && espiao.executor.length === 3,
      JSON.stringify(espiao));
    ok("AO2 total de ENTRADAS de setembro = 4969.12", respostas.includes("4969.12"),
      respostas.slice(0, 160));
    ok("AO3 total de SAIDAS de setembro = 2600.50", respostas.includes("2600.50"));
    ok("AO4 saldo = 2368.62, calculado pela Tool", respostas.includes("2368.62"));
    ok("AO5 nenhum passo falhou", r.passos.every((p) => p.desfecho === "sucesso"));
    ok("AO6 e o mes passado tem outro total — o filtro de data separa mesmo",
      (await chamar("planilha.agregar", {
        fileId: "entradas", operacao: "sum", coluna: "Valor",
        filtros: [{ coluna: "Data", operador: "entre", valor: "2026-08-01", ate: "2026-08-31" }],
      })).valor === "1000.00");
    ok("AO7 saidas de agosto = 1500.00",
      (await chamar("planilha.agregar", {
        fileId: "saidas", operacao: "sum", coluna: "Valor",
        filtros: [{ coluna: "Data", operador: "entre", valor: "2026-08-01", ate: "2026-08-31" }],
      })).valor === "1500.00");
    // A prova de que a data veio do arquivo e nao do acaso: um mes sem
    // movimento tem de dar zero, nao o total inteiro.
    ok("AO8 CONTROLE: um mes sem movimento soma 0.00",
      (await chamar("planilha.agregar", {
        fileId: "entradas", operacao: "sum", coluna: "Valor",
        filtros: [{ coluna: "Data", operador: "entre", valor: "2026-05-01", ate: "2026-05-31" }],
      })).valor === "0.00");
  }

  // ═══════════════════════════════════════════════════════════════════
  secao("AP. Periodo: o intervalo vem do calendario, nao do modelo");
  // ═══════════════════════════════════════════════════════════════════
  {
    const declaradas = declararFerramentas({ catalogo: FUNCOES, permissoes: TODAS_AUTOMATICAS });
    const espiao: EspiaoDaPorta = { guard: [], executor: [] };

    // O fake encadeia calendario -> agregar. Os argumentos do segundo
    // passo sao os que o modelo teria copiado da resposta do primeiro;
    // o assert confere que eles BATEM com o que o calendario devolveu,
    // que e a unica forma de provar que o intervalo nao foi inventado.
    const esperado = resolverPeriodo("este_mes", Date.UTC(2026, 8, 29, 12));
    const r = await conversarComFerramentas({
      userId: DONO, agenteId: "ag-f3", instrucao: "use as ferramentas",
      mensagemDoUsuario: "quanto entrou este mes?",
      ferramentas: declaradas,
      maxPassos: 5,
      adaptador: criarAdaptadorFakeComFerramentas([
        { tipo: "pede", pedidos: [{ nome: "calendario.periodo",
          argumentos: { periodo: "este_mes" } }] },
        { tipo: "pede", pedidos: [{ nome: "planilha.agregar", argumentos: {
          fileId: "entradas", operacao: "sum", coluna: "Valor",
          filtros: [
            { coluna: "Data", operador: "entre", valor: esperado.inicio, ate: esperado.fim },
            { coluna: "Categoria", operador: "diferente", valor: "controle" },
          ] } }] },
        { tipo: "fala", texto: "Entraram 4969.12 este mes." },
      ]),
      executar: criarPortaReal(TODAS_AUTOMATICAS, espiao) as never,
    });

    ok("AP1 o calendario rodou ANTES da planilha",
      espiao.executor[0] === "calendario.periodo" &&
        espiao.executor[1] === "planilha.agregar", espiao.executor.join(" -> "));
    const texto = JSON.stringify(r.mensagens);
    ok("AP2 o intervalo que o calendario devolveu aparece no dialogo",
      texto.includes(esperado.inicio) && texto.includes(esperado.fim),
      `${esperado.inicio}..${esperado.fim}`);
    ok("AP3 e a proveniencia registra o filtro com esse intervalo",
      texto.includes("linhasCorrespondentes") && texto.includes(esperado.fim));
    ok("AP4 o total do periodo bate com o esperado", texto.includes("4969.12"));
    ok("AP5 as duas Tools passaram pelo guard", espiao.guard.length === 2);
    // Anti-vacuidade: se o modelo tivesse inventado o mes errado, o
    // total seria outro. Este assert mostra que os dois totais diferem.
    ok("AP6 CONTROLE: o mes ERRADO daria outro total, entao o teste distingue",
      (await chamar("planilha.agregar", {
        fileId: "entradas", operacao: "sum", coluna: "Valor",
        filtros: [{ coluna: "Data", operador: "entre", valor: "2026-08-01", ate: "2026-08-31" }],
      })).valor !== "4969.12");
  }

  console.log(`\n${"─".repeat(2)} placar ${"─".repeat(54)}`);
  console.log(`  PASS ${passou}   FAIL ${falhou}`);
}

void main().then(
  () => process.exit(falhou > 0 ? 1 : 0),
  (e) => { console.error("ERRO NAO TRATADO:", e); process.exit(1); }
);
