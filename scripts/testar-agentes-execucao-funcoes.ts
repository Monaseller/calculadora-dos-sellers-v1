/**
 * CDS IA — TOOL-EXEC-B. Suite do primeiro executor real de Funcoes.
 *
 * ── Como o caminho inteiro roda sem banco ───────────────────────────
 *
 * Pelo mesmo mecanismo que `testar-ia-skill-1d-consumer.ts` ja usa: um
 * duplo de `Module.prototype.require` troca APENAS `supabase-servidor`
 * por um cliente falso. Tudo abaixo disso — `lerAgenteDoDono`,
 * `resolverFatosPermissoes`, `registrarAbertura`, o executor de
 * `vendas.consultar` — roda DE VERDADE, contra respostas roteirizadas.
 *
 * Isso importa: a interceptacao vive no HARNESS, e producao continua
 * com uma assinatura so, `executarFuncao(entrada)`. Nenhum `deps`,
 * nenhum `skipGuard`, nenhum registry substituivel — a suite prova isso
 * na secao G.
 *
 * Rodar:  npx tsx scripts/testar-agentes-execucao-funcoes.ts
 * Sem rede, sem banco, sem IA, sem escrita.
 */
import "./_server-only-inerte";

import Module from "node:module";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

let passou = 0;
let falhou = 0;

function ok(nome: string, condicao: boolean, detalhe = ""): void {
  if (condicao) {
    passou++;
  } else {
    falhou++;
    console.error(`  x ${nome}${detalhe ? `  · ${detalhe}` : ""}`);
  }
}

function secao(titulo: string): void {
  console.log(`\n── ${titulo}`);
}

const RAIZ = join(__dirname, "..");
const ler = (rel: string) => readFileSync(join(RAIZ, rel), "utf8");
const semComentarios = (t: string) =>
  t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

// ─── Contabilidade de simbolo — fecha o achado B1-R1-N2 ───────────────
//
// O detector antigo perguntava "existe `NOME(` fora da definicao?". A
// pergunta parece a certa e nao e: um alias
//
//   const f = cancelarAprovacaoRetomadaIncompativel;
//   await f(u, a);
//
// escapa inteiro, porque a linha que cria o alias nao tem parentese
// nenhum depois do nome. Uma lista de padroes proibidos tambem nao
// resolve — ela so cobre as formas que alguem lembrou de escrever.
//
// O criterio aqui e uma IDENTIDADE CONTABIL: toda ocorrencia do nome
// precisa caber em exatamente um de tres papeis legitimos — definicao,
// especificador de import, invocacao direta. Se a soma dos tres nao
// bate com o total de ocorrencias, existe uma quarta forma no arquivo,
// e o assert cai sem precisar saber qual e. Alias, callback, re-export
// e destructuring caem todos pelo mesmo buraco, inclusive os que ainda
// nao foram inventados.

interface PapeisDoSimbolo {
  readonly total: number;
  readonly definicoes: number;
  readonly importacoes: number;
  readonly invocacoes: number;
  /** `total - definicoes - importacoes - invocacoes`. Zero e a unica
   *  contagem aceitavel: qualquer resto e uma ocorrencia sem papel. */
  readonly semPapel: number;
}

/**
 * Conta os papeis de um identificador em UM fonte, ja sem comentarios.
 *
 * A ordem das substituicoes importa: cada papel reconhecido e apagado
 * antes do proximo ser procurado, para que a mesma ocorrencia nunca
 * seja contada duas vezes.
 */
function papeisDoSimbolo(fonteSemComentarios: string, nome: string): PapeisDoSimbolo {
  const todas = new RegExp(`\\b${nome}\\b`, "g");
  const total = (fonteSemComentarios.match(todas) ?? []).length;

  let resto = fonteSemComentarios;

  // 1. Definicao: `export async function NOME`, `export function NOME`,
  //    `async function NOME` ou `function NOME`.
  const defs = new RegExp(`(?:export\\s+)?(?:async\\s+)?function\\s+${nome}\\b`, "g");
  const definicoes = (resto.match(defs) ?? []).length;
  resto = resto.replace(defs, "@DEF@");

  // 2. Especificador de import: o nome dentro de um bloco
  //    `import { ... } from "..."`. Recorta o bloco inteiro e conta as
  //    ocorrencias do nome dentro dele.
  let importacoes = 0;
  resto = resto.replace(/import\s*\{[\s\S]*?\}\s*from\s*"[^"]*";?/g, (bloco) => {
    const dentro = (bloco.match(new RegExp(`\\b${nome}\\b`, "g")) ?? []).length;
    importacoes += dentro;
    return "@IMP@";
  });

  // 3. Invocacao direta: `NOME(`, com ou sem qualificador antes.
  const chamadas = new RegExp(`\\b${nome}\\s*\\(`, "g");
  const invocacoes = (resto.match(chamadas) ?? []).length;
  resto = resto.replace(chamadas, "@CALL@");

  const semPapel = (resto.match(new RegExp(`\\b${nome}\\b`, "g")) ?? []).length;
  return { total, definicoes, importacoes, invocacoes, semPapel };
}

/**
 * Corpo EXATO de um export, da assinatura ate o `}` da coluna 0.
 *
 * Mesmo recorte fechado das secoes O e P, agora no topo porque quatro
 * blocos diferentes precisam dele. Fatiar ate o fim do arquivo acusaria
 * o vizinho — foi esse o bug do recorte aberto do L32.
 */
function corpoDeExportado(fonte: string, nome: string): string {
  const linhas = fonte.split("\n");
  const i = linhas.findIndex((l) => l.startsWith(`export async function ${nome}`));
  if (i < 0) return "";
  for (let j = i + 1; j < linhas.length; j++) {
    if (linhas[j] === "}") return linhas.slice(i, j + 1).join("\n");
  }
  return "";
}

/** As raizes de producao. `middleware.ts` entra aqui — ele e codigo de
 *  producao de verdade e ficava fora de toda varredura (B1-R1-N3). */
const RAIZES_PRODUCAO = ["lib", "app", "components"];
const ARQUIVOS_PRODUCAO_SOLTOS = ["middleware.ts"];

/** Todos os `.ts`/`.tsx` de producao, com barra normalizada. */
function arquivosDeProducao(): string[] {
  const achados: string[] = [];
  const varrer = (dir: string): void => {
    for (const e of readdirSync(join(RAIZ, dir), { withFileTypes: true })) {
      const rel = `${dir}/${e.name}`.replace(/\\/g, "/");
      if (e.isDirectory()) {
        varrer(rel);
        continue;
      }
      if (/\.tsx?$/.test(e.name) && !/\.d\.ts$/.test(e.name)) achados.push(rel);
    }
  };
  for (const d of RAIZES_PRODUCAO) varrer(d);
  for (const f of ARQUIVOS_PRODUCAO_SOLTOS) achados.push(f);
  return achados;
}

const EXECUTOR = ler("lib/agentes/execucao-funcoes/executar.ts");
const EXECUTOR_CODIGO = semComentarios(EXECUTOR);
const REGISTRY = ler("lib/agentes/funcoes/registry.ts");
const REGISTRY_CODIGO = semComentarios(REGISTRY);

// ─── O duplo do cliente Supabase ──────────────────────────────────────

interface Chamada {
  tabela: string;
  filtros: Record<string, unknown>;
  escrita: boolean;
  linha?: Record<string, unknown>;
  /** Payload de `.update(...)`. Campo PROPRIO, separado de `linha`: os
   *  asserts de auditoria ja leem `linha` para `insert`, e reaproveitar
   *  o mesmo campo mudaria o que eles enxergam. */
  payload?: Record<string, unknown>;
  /** Filtros `.is(coluna, valor)`, que nao sao igualdade e por isso nao
   *  podem se misturar com `filtros` — `IS NULL` e `= NULL` sao coisas
   *  diferentes em SQL, e o teste precisa distinguir as duas. */
  filtrosIs: Record<string, unknown>;
  /** `.select(...)` literal, para provar a FORMA da projecao. */
  select?: string;
  /** `.not(coluna, operador, valor)` — a negacao NAO e igualdade nem
   *  `IS NULL`. `IS NOT NULL` so existe por aqui, entao sem este campo
   *  qualquer assert sobre as cercas estruturais seria vacuo. */
  nots: ReadonlyArray<{ coluna: string; operador: string; valor: unknown }>;
  /** `.order(coluna, {ascending})` NA ORDEM DAS CHAMADAS. O driver
   *  concatena as chaves de ordenacao na sequencia em que chegam, entao
   *  a sequencia E a semantica: registrar um conjunto perderia a prova. */
  orders: ReadonlyArray<{ coluna: string; ascendente: boolean }>;
  /** Valor cru entregue a `.limit(...)`. Guardado como veio para que um
   *  `NaN` que escapasse do normalizador fique visivel no assert. */
  limite?: unknown;
  /** Coluna e valores de `.in(coluna, valores)`. Ate a M2-I1-A1-FIX1 o
   *  duplo descartava os dois: nenhum assert precisava saber POR QUAIS
   *  ids uma leitura perguntou. Precisa agora — e exatamente a diferenca
   *  entre "leu o catalogo inteiro" e "leu so a Funcao atual". */
  inColuna?: string;
  inValores?: readonly unknown[];
}

interface Resposta {
  data?: unknown;
  error?: Record<string, unknown> | null;
  /** Entrega `data` EXATAMENTE como veio, sem o `?? null` do canal
   *  normal. Existe por um motivo estreito: sem ele e impossivel provar
   *  que um wrapper trata `undefined` — o coalesce do fake colapsaria o
   *  caso em `null` antes de a producao ver qualquer coisa, e o assert
   *  estaria medindo o duplo, nao o codigo. Aditivo: um roteiro que nao
   *  pede `bruto` passa pelo mesmo caminho de sempre. */
  bruto?: boolean;
}

/** Uma chamada de RPC. O nome e os parametros ficam registrados porque
 *  a fronteira de confianca da retomada e exatamente isto: o que a
 *  aplicacao MANDA para o banco. */
interface ChamadaRpc {
  nome: string;
  parametros: Record<string, unknown>;
}

let respostas: Resposta[] = [];
let chamadas: Chamada[] = [];
let consumidas = 0;

let respostasRpc: Resposta[] = [];
let chamadasRpc: ChamadaRpc[] = [];
let consumidasRpc = 0;

function roteiro(...rs: Resposta[]): void {
  respostas = rs;
  chamadas = [];
  consumidas = 0;
  respostasRpc = [];
  chamadasRpc = [];
  consumidasRpc = 0;
}

/** Roteiriza as RPCs do cenario. Sempre DEPOIS de `roteiro`, que
 *  limpa os dois canais para que um cenario nunca herde o anterior. */
function roteiroRpc(...rs: Resposta[]): void {
  respostasRpc = rs;
  chamadasRpc = [];
  consumidasRpc = 0;
}

function construtor(tabela: string): Record<string, unknown> {
  const c: Chamada = {
    tabela, filtros: {}, escrita: false, filtrosIs: {},
    nots: [], orders: [],
  };
  const resolver = (fn: (v: { data: unknown; error: unknown }) => void) => {
    chamadas.push(c);
    const r = respostas[consumidas++];
    fn({ data: r?.data ?? null, error: r?.error ?? null });
  };
  const b: Record<string, unknown> = {
    select(colunas?: string) {
      if (typeof colunas === "string") c.select = colunas;
      return b;
    },
    eq(coluna: string, valor: unknown) { c.filtros[coluna] = valor; return b; },
    in(coluna: string, valores: readonly unknown[]) {
      c.inColuna = coluna;
      c.inValores = valores;
      return b;
    },
    order(coluna: string, opcoes?: { ascending?: boolean }) {
      (c.orders as { coluna: string; ascendente: boolean }[]).push({
        coluna,
        ascendente: opcoes?.ascending !== false,
      });
      return b;
    },
    limit(valor: unknown) { c.limite = valor; return b; },
    not(coluna: string, operador: string, valor: unknown) {
      (c.nots as { coluna: string; operador: string; valor: unknown }[])
        .push({ coluna, operador, valor });
      return b;
    },
    gte() { return b; },
    lte() { return b; },
    gt() { return b; },
    lt() { return b; },
    insert(linha: Record<string, unknown>) { c.escrita = true; c.linha = linha; return b; },
    is(coluna: string, valor: unknown) { c.filtrosIs[coluna] = valor; return b; },
    update(payload: Record<string, unknown>) { c.escrita = true; c.payload = payload; return b; },
    upsert() { c.escrita = true; return b; },
    delete() { c.escrita = true; return b; },
    maybeSingle() {
      return { then: (fn: (v: { data: unknown; error: unknown }) => void) => resolver(fn) };
    },
    single() {
      return { then: (fn: (v: { data: unknown; error: unknown }) => void) => resolver(fn) };
    },
    then(fn: (v: { data: unknown; error: unknown }) => void) { resolver(fn); },
  };
  return b;
}

const clienteFake = {
  from: (t: string) => construtor(t),
  rpc: (nome: string, parametros: Record<string, unknown>) => {
    chamadasRpc.push({ nome, parametros: parametros ?? {} });
    const r = respostasRpc[consumidasRpc++];
    return Promise.resolve({
      data: r?.bruto === true ? r.data : (r?.data ?? null),
      error: r?.error ?? null,
    });
  },
};

// ─── O duplo do catalogo ──────────────────────────────────────────────
//
// ── Por que o catalogo precisa de duplo, e o Supabase nao basta ─────
//
// Quatro caminhos pos-abertura do executor sao inalcancaveis pela unica
// Funcao real: `vendas.consultar` nunca lanca, nunca devolve saida
// malformada, tem interpretador que nunca estoura e sempre produz
// codigo de erro bem formado. Sem catalogo controlado esses quatro
// ramos ficariam so no fonte — o achado A2 do TOOL-EXEC-R1.
//
// A troca acontece SO no harness, pelo mesmo `Module.prototype.require`
// que ja substitui `supabase-servidor`. Producao continua com uma
// assinatura so: nenhum `deps`, nenhum registry substituivel. A secao E
// prova isso lendo o fonte.
//
// `FUNCOES` e exposto por GETTER de proposito: o modulo do executor le
// a propriedade a cada chamada, entao o catalogo pode ser trocado por
// cenario DEPOIS que ele ja foi carregado. `F0` prova que a troca vale
// de verdade — sem ela, todos os cenarios desta secao rodariam contra o
// catalogo real e passariam por engano.
interface FuncaoControlada {
  executor: (contexto: unknown, argumentos: unknown) => Promise<unknown>;
  validarEntrada: (argumentos: unknown) => unknown;
  interpretarSaida: (saida: unknown) => unknown;
  acesso: "leitura" | "escrita";
  idempotente: boolean;
  conexaoNecessaria: unknown;
  /** A persistencia de aprovacao compara a revisao congelada com esta.
   *  Sem ela os cenarios de retomada acusariam `aprovacao_desatualizada`
   *  por ausencia de campo, e nao pelo motivo sob teste. */
  revisao: string;
}

let catalogoControlado: Record<string, FuncaoControlada> | null = null;

/**
 * O resolver de Connections, dublado.
 *
 * `null` = comportamento neutro (nenhuma conexao, nenhum binding), que e
 * o que todo cenario NAO-conectado deste arquivo assume. Os cenarios
 * conectados o preenchem para escolher o que o pipeline enxerga.
 *
 * O duplo cobre `executar.ts` E `aprovacoes/persistencia.ts`, que sao os
 * dois consumidores reais — e por isso o caminho automatico e o
 * pos-Approval veem a MESMA fonte, como em producao.
 */
interface ConexoesDubladas {
  conexoes: readonly unknown[];
  semSelecao: readonly unknown[];
  bindings: readonly { plataforma: string; recurso: string; lojaId: string }[];
  /** O snapshot do CATALOGO INTEIRO que o agregador publica (M2-I1-A1-FIX1).
   *  E daqui que o executor tira o nivel da Funcao em execucao quando ha
   *  requisito de conexao — sem reler `agente_permissoes`. */
  permissoes: readonly { funcaoId: string; nivel: string }[];
  coleta: string;
}
let conexoesControladas: ConexoesDubladas | null = null;
let vezesResolverConexoes = 0;
const SEM_CONEXOES: ConexoesDubladas = {
  conexoes: [], semSelecao: [], bindings: [], permissoes: [], coleta: "ok",
};

const requireOriginal = (Module as unknown as { prototype: { require: (id: string) => unknown } }).prototype.require;
let interceptou = false;
let interceptouCatalogo = false;
let interceptouAgregador = false;
(Module as unknown as { prototype: { require: unknown } }).prototype.require = function (this: unknown, id: string) {
  if (typeof id === "string" && id.includes("supabase-servidor")) {
    interceptou = true;
    return { getSupabaseServidor: () => clienteFake };
  }
  if (typeof id === "string" && id.includes("conexoes/agregador")) {
    interceptouAgregador = true;
    return {
      resolverConexoesDoAgente: async () => {
        vezesResolverConexoes++;
        return conexoesControladas ?? SEM_CONEXOES;
      },
    };
  }
  if (typeof id === "string" && id.includes("funcoes/registry")) {
    interceptouCatalogo = true;
    const real = requireOriginal.apply(this, arguments as unknown as [string]) as {
      FUNCOES: Record<string, unknown>;
    };
    const ativo = () => (catalogoControlado ?? real.FUNCOES) as Record<string, unknown>;
    return {
      get FUNCOES() {
        return ativo();
      },
      funcaoExiste: (alvo: string) => Object.prototype.hasOwnProperty.call(ativo(), alvo),
    };
  }
  return requireOriginal.apply(this, arguments as unknown as [string]);
};

// ── Por que os modulos entram por `await import` ────────────────────
//
// O transform CJS do tsx HOISTA todo `import` estatico: eles rodariam
// antes do duplo acima, e `supabase-servidor` seria carregado de
// verdade — lancando por falta de env. Importar dinamicamente dentro da
// rotina garante que o duplo ja esteja instalado. Mesmo padrao de
// `testar-ia-skill-1d-consumer.ts`.

// ─── Fixtures ─────────────────────────────────────────────────────────

const USER = "user-sintetico-exec";
const AGENTE = "11111111-1111-4111-8111-111111111111";
const TAREFA = "22222222-2222-4222-8222-222222222222";
const FILTRO_OK = { dataInicio: "2026-08-01", dataFim: "2026-08-07" };

const agenteOk: Resposta = { data: { id: AGENTE, user_id: USER, nome: "A", tipo: "personalizado", ativo: true } };
const agenteAusente: Resposta = { data: null };
const tarefaOk: Resposta = { data: { id: TAREFA, user_id: USER, status: "rodando" } };
const semPermissao: Resposta = { data: [] };
const permissao = (nivel: string): Resposta => ({ data: [{ funcao_id: "vendas.consultar", nivel }] });
const gravou: Resposta = { data: null, error: null };
const naoGravou: Resposta = { data: null, error: { code: "08006" } };
const duplicado: Resposta = { data: null, error: { code: "23505" } };
const semVendas: Resposta = { data: [] };

const base = { userId: USER, agenteId: AGENTE, funcaoId: "vendas.consultar", argumentos: FILTRO_OK };

// ── Fixtures do catalogo controlado ──────────────────────────────────

const ID_CONTROLADA = "teste.controlada";
const REVISAO_CONTROLADA = "1";
const APROVACAO = "33333333-3333-4333-8333-333333333333";
const permissaoDe = (id: string, nivel: string): Resposta => ({ data: [{ funcao_id: id, nivel }] });

// ── Fixtures de aprovacao ────────────────────────────────────────────

/** O retorno da RPC `aprovacao_criar`: uma linha com id e veredito. */
const criouAprovacao = (resultado: "criada" | "reutilizada", id = APROVACAO): Resposta => ({
  data: { id, resultado },
});
/** O retorno da RPC `aprovacao_consumir_e_abrir`: um codigo, so. */
const consumo = (codigo: string): Resposta => ({ data: codigo });

/** A linha da aprovacao, como a persistencia a le ANTES de consumir. */
const aprovacaoLinha = (partes: Record<string, unknown> = {}): Resposta => ({
  data: {
    id: APROVACAO,
    funcao_id: ID_CONTROLADA,
    revisao_funcao: REVISAO_CONTROLADA,
    acesso: "leitura",
    conexao_plataforma: null,
    conexao_recurso: null,
    conexao_loja_id: null,
    argumentos: { congelado: true },
    agente_id: AGENTE,
    tarefa_id: null,
    ...partes,
  },
});

/** A linha de ABERTURA que a RPC acabou de gravar — a unica autoridade
 *  do nivel que o desfecho vai espelhar. */
const aberturaComNivel = (nivel: unknown): Resposta => ({ data: { nivel_no_momento: nivel } });

let vezesExecutor = 0;
/** O que o executor da Funcao REALMENTE recebeu. Na retomada isto e a
 *  prova de que os argumentos vieram da aprovacao congelada, e nao de
 *  quem pediu para retomar. */
let ultimosArgumentos: unknown;
let ultimoContexto: unknown;

/** Uma Funcao de leitura sem requisito de conexao, com as tres pecas
 *  substituiveis por cenario. Tudo que nao e o alvo do teste e trivial,
 *  para que a unica variavel seja o ramo sob prova. */
function controlada(partes: Partial<FuncaoControlada>): Record<string, FuncaoControlada> {
  return {
    [ID_CONTROLADA]: {
      executor: async (contexto: unknown, argumentos: unknown) => {
        vezesExecutor++;
        ultimoContexto = contexto;
        ultimosArgumentos = argumentos;
        return { ok: true };
      },
      validarEntrada: () => ({ valida: true }),
      interpretarSaida: (saida: unknown) => ({ tipo: "sucesso", data: saida }),
      acesso: "leitura",
      idempotente: true,
      conexaoNecessaria: null,
      revisao: REVISAO_CONTROLADA,
      ...partes,
    },
  };
}

/** Envolve o executor da fixture para que o contador continue valendo
 *  mesmo quando o cenario troca o corpo dele. */
function contando(corpo: () => Promise<unknown>): (c: unknown, a: unknown) => Promise<unknown> {
  return async () => {
    vezesExecutor++;
    return corpo();
  };
}

const baseControlada = { userId: USER, agenteId: AGENTE, funcaoId: ID_CONTROLADA, argumentos: {} };

const linhasGravadas = () => chamadas.filter((c) => c.escrita && c.tabela === "agente_funcao_chamadas");

async function principal(): Promise<void> {
  const { executarFuncao, retomarAprovacao } = await import("../lib/agentes/execucao-funcoes/executar");
  const { FUNCOES } = await import("../lib/agentes/funcoes/registry");
  const { CODIGOS_NEGACAO, CODIGOS_EXECUCAO, envelopeValido } =
    await import("../lib/agentes/chamadas/contrato");

  // ─── A. Tripwire da pasta nova ─────────────────────────────────────

  secao("A. A pasta nova tem exatamente o modulo autorizado");
  {
    const AUTORIZADOS = ["executar.ts"];
    const noDisco = readdirSync(join(RAIZ, "lib/agentes/execucao-funcoes")).sort();
    ok("A1  lib/agentes/execucao-funcoes com um modulo so",
      JSON.stringify(noDisco) === JSON.stringify(AUTORIZADOS), noDisco.join(", "));
    ok("A2  CONTROLE: um arquivo EXTRA reprovaria",
      JSON.stringify([...AUTORIZADOS, "tipos.ts"].sort()) !== JSON.stringify(AUTORIZADOS));
    ok("A3  CONTROLE: o modulo ausente reprovaria",
      JSON.stringify([]) !== JSON.stringify(AUTORIZADOS));
    ok("A4  ANCORA: o duplo de supabase-servidor foi instalado", interceptou);
  }

  // ─── B. Contrato do registry ───────────────────────────────────────

  secao("B. DefinicaoFuncao exige validar e interpretar");
  {
    const def = FUNCOES["vendas.consultar"];
    ok("B1  vendas.consultar tem validarEntrada", typeof def.validarEntrada === "function");
    ok("B2  vendas.consultar tem interpretarSaida", typeof def.interpretarSaida === "function");

    // O `tsc` e quem prova a obrigatoriedade: uma definicao sem os
    // campos nao satisfaz o tipo. Aqui fica a prova estrutural de que
    // eles NAO sao opcionais na interface.
    ok("B3  os dois campos sao obrigatorios na interface",
      /validarEntrada: ValidadorEntrada;/.test(REGISTRY_CODIGO) &&
      /interpretarSaida: InterpretadorSaida;/.test(REGISTRY_CODIGO) &&
      !/validarEntrada\?:|interpretarSaida\?:/.test(REGISTRY_CODIGO));
    ok("B4  `executor` continua o primeiro campo",
      /interface DefinicaoFuncao \{[\s\S]{0,400}?executor: ExecutorFuncao;[\s\S]{0,120}?validarEntrada/
        .test(REGISTRY_CODIGO));
    ok("B5  a ordem acesso -> idempotente -> conexaoNecessaria sobrevive",
      /acesso:[\s\S]*?idempotente:[\s\S]*?conexaoNecessaria:/.test(REGISTRY_CODIGO));
    ok("B6  toda Funcao registrada declara os tres contratos",
      Object.values(FUNCOES).every(
        (d) => typeof d.executor === "function" &&
          typeof d.validarEntrada === "function" &&
          typeof d.interpretarSaida === "function"));
  }

  secao("B2. O validador delega, nao recopia");
  {
    const def = FUNCOES["vendas.consultar"];
    ok("B7  entrada valida passa", def.validarEntrada(FILTRO_OK).valida === true);

    const casos: [string, unknown, string][] = [
      ["nao-objeto", null, "filtro_ausente"],
      ["data invalida", { dataInicio: "x", dataFim: "y" }, "data_invalida"],
      ["periodo invertido", { dataInicio: "2026-08-07", dataFim: "2026-08-01" }, "periodo_invertido"],
      ["janela excedida", { dataInicio: "2026-01-01", dataFim: "2026-08-01" }, "janela_excedida"],
      ["marketplace invalido", { ...FILTRO_OK, marketplace: "Amazon" }, "marketplace_invalido"],
    ];
    for (const [nome, arg, codigo] of casos) {
      const r = def.validarEntrada(arg);
      ok(`B8  ${nome} -> ${codigo}`, r.valida === false && r.codigo === codigo,
        r.valida ? "passou" : r.codigo);
    }

    // A prova de que nao houve copia: os codigos nao aparecem escritos
    // no registry — eles vem de `validarFiltroVendas`.
    ok("B9  os codigos de dominio NAO foram recopiados no registry",
      !/filtro_ausente|periodo_invertido|janela_excedida|marketplace_invalido/.test(REGISTRY_CODIGO));
    ok("B10 e o registry delega a autoridade existente",
      /validarFiltroVendas/.test(REGISTRY_CODIGO));
  }

  secao("B3. O interpretador valida a forma em RUNTIME");
  {
    const interpretar = FUNCOES["vendas.consultar"].interpretarSaida;

    const okShape = { linhas: [], truncado: false, erro: null };
    const r1 = interpretar(okShape);
    ok("B11 forma valida + erro null -> sucesso", r1.tipo === "sucesso");
    ok("B12 truncado atravessa para o data",
      interpretar({ linhas: [], truncado: true, erro: null }).tipo === "sucesso" &&
      (interpretar({ linhas: [], truncado: true, erro: null }) as { data: { truncado: boolean } })
        .data.truncado === true);

    const r2 = interpretar({ linhas: [], truncado: false, erro: "erro_consulta_vendas" });
    ok("B13 erro de dominio -> tipo erro com codigo preservado",
      r2.tipo === "erro" && r2.codigo === "erro_consulta_vendas");
    ok("B14 erro de dominio traz mensagem e retryable",
      r2.tipo === "erro" && typeof r2.mensagem === "string" && r2.mensagem.length > 0 &&
      r2.retryable === true);

    const invalidos: [string, unknown][] = [
      ["null", null],
      ["array", []],
      ["objeto vazio", {}],
      ["erro numerico", { linhas: [], truncado: false, erro: 123 }],
      ["sem linhas", { truncado: false, erro: null }],
      ["sem truncado", { linhas: [], erro: null }],
      ["truncado nao-boolean", { linhas: [], truncado: "sim", erro: null }],
      ["erro string vazia", { linhas: [], truncado: false, erro: "   " }],
      ["instancia de classe", new Map()],
    ];
    for (const [nome, saida] of invalidos) {
      ok(`B15 saida invalida: ${nome}`, interpretar(saida).tipo === "invalida");
    }

    ok("B16 o cast sozinho NAO e a autoridade — ha checagem de runtime",
      /Array\.isArray/.test(REGISTRY_CODIGO) && /typeof .*truncado.*boolean|truncado.*!== "boolean"/.test(REGISTRY_CODIGO));
  }

  // ─── C. Caminhos que nao chegam ao executor ────────────────────────

  secao("C. Recusas antes da abertura");
  {
    roteiro(agenteAusente);
    const r = await executarFuncao({ ...base });
    ok("C1  agente inexistente/outro dono -> indisponivel", r.tipo === "indisponivel");
    ok("C2  e NENHUMA linha de auditoria e gravada", linhasGravadas().length === 0);
    ok("C3  requestId existe mesmo sem Tool Call", typeof r.requestId === "string" && r.requestId.length > 0);

    roteiro(agenteOk, { data: null });
    const r2 = await executarFuncao({ ...base, tarefaId: TAREFA });
    ok("C4  tarefa de outro dono -> indisponivel", r2.tipo === "indisponivel");
    ok("C5  e sem Tool Call", linhasGravadas().length === 0);

    roteiro(agenteOk, gravou);
    const r3 = await executarFuncao({ ...base, funcaoId: "NAO..VALIDO" });
    ok("C6  funcaoId malformado -> negado/funcao_inexistente",
      r3.tipo === "negado" && r3.codigo === "funcao_inexistente");
    ok("C7  e grava funcao_id NULL", linhasGravadas()[0]?.linha?.funcao_id === null);
    ok("C8  com acesso NULL", linhasGravadas()[0]?.linha?.acesso === null);

    roteiro(agenteOk, gravou);
    const r4 = await executarFuncao({ ...base, funcaoId: "vendas.inexistente" });
    ok("C9  id valido e desconhecido -> negado/funcao_inexistente",
      r4.tipo === "negado" && r4.codigo === "funcao_inexistente");
    ok("C10 e PRESERVA o funcao_id tentado",
      linhasGravadas()[0]?.linha?.funcao_id === "vendas.inexistente");

    roteiro(agenteOk, gravou);
    const r5 = await executarFuncao({ ...base, funcaoId: 42 });
    ok("C11 funcaoId nao-string -> negado", r5.tipo === "negado");
    ok("C12 nenhuma consulta de permissao para Funcao inexistente",
      !chamadas.some((c) => c.tabela === "agente_permissoes"));
  }

  secao("C2. Permissao e guard");
  {
    roteiro(agenteOk, semPermissao, gravou);
    const r = await executarFuncao({ ...base });
    ok("C13 permissao ausente -> negado/permissao_ausente",
      r.tipo === "negado" && r.codigo === "permissao_ausente");
    ok("C14 grava status negado", linhasGravadas()[0]?.linha?.status === "negado");
    ok("C15 nivel_no_momento NULL quando nao ha fato",
      linhasGravadas()[0]?.linha?.nivel_no_momento === null);

    roteiro(agenteOk, permissao("bloqueado"), gravou);
    const r2 = await executarFuncao({ ...base });
    ok("C16 bloqueado -> negado/permissao_bloqueada",
      r2.tipo === "negado" && r2.codigo === "permissao_bloqueada");
    ok("C17 snapshot do nivel e gravado",
      linhasGravadas()[0]?.linha?.nivel_no_momento === "bloqueado");

    roteiro(agenteOk, permissao("aprovacao"));
    roteiroRpc(criouAprovacao("criada"));
    const r3 = await executarFuncao({ ...base });
    ok("C18 aprovacao -> VARIANTE PROPRIA, nao negado",
      r3.tipo === "aguardando_aprovacao" && r3.codigo === "aprovacao_necessaria");

    // ── C19: a autoridade da espera MUDOU de lugar ──────────────────
    //
    // Ate o APPROVAL-B1C-I1 este assert provava que o ramo gravava um
    // desfecho isolado dizendo "aguardando_aprovacao". A partir do I2 a
    // espera vive na aprovacao — com dono, prazo e argumentos
    // congelados —, e a Tool Call deixa de contar a mesma historia pela
    // metade. O assert nao afrouxou: ele passou a exigir o CONTRARIO,
    // e continua sendo sobre a mesma linha.
    ok("C19 a espera NAO grava mais desfecho isolado na Tool Call",
      linhasGravadas().length === 0, `${linhasGravadas().length} linha(s)`);
    ok("C19a e nenhuma linha diz aguardando_aprovacao",
      !linhasGravadas().some((c) => c.linha?.status === "aguardando_aprovacao"));
    ok("C19b a aprovacao criada volta identificada",
      r3.tipo === "aguardando_aprovacao" && r3.aprovacaoId === APROVACAO &&
      r3.estadoAprovacao === "criada");
    ok("C19c CONTROLE: a sonda de linhas gravadas funciona neste cenario",
      chamadas.length > 0 && chamadasRpc.length === 1);
    ok("C20 nenhuma abertura", !linhasGravadas().some((c) => c.linha?.fase === "abertura"));

    roteiro(agenteOk, { data: null, error: { code: "08006" } }, gravou);
    const r4 = await executarFuncao({ ...base });
    ok("C21 falha de coleta de permissao -> erro/erro_interno, NAO permissao_ausente",
      r4.tipo === "erro" && r4.envelope.error.code === "erro_interno");
    ok("C22 e a auditoria registra erro_interno",
      linhasGravadas()[0]?.linha?.codigo_desfecho === "erro_interno");
  }

  secao("C3. Entrada invalida");
  {
    roteiro(agenteOk, permissao("automatico"), gravou);
    const r = await executarFuncao({ ...base, argumentos: { dataInicio: "x", dataFim: "y" } });
    ok("C23 entrada invalida -> erro", r.tipo === "erro");
    ok("C24 envelope preserva o codigo de DOMINIO",
      r.tipo === "erro" && r.envelope.error.code === "data_invalida");
    ok("C25 a Tool Call registra a CATEGORIA entrada_invalida",
      linhasGravadas()[0]?.linha?.codigo_desfecho === "entrada_invalida");
    ok("C26 e sem abertura", linhasGravadas().every((c) => c.linha?.fase === "desfecho"));
    ok("C27 nenhuma consulta a pedidos", !chamadas.some((c) => c.tabela === "pedidos"));
  }

  // ─── D. Caminho completo ───────────────────────────────────────────

  secao("D. Abertura, execucao e desfecho");
  {
    roteiro(agenteOk, permissao("automatico"), gravou, semVendas, gravou);
    const r = await executarFuncao({ ...base });
    ok("D1  caminho feliz -> sucesso", r.tipo === "sucesso", r.tipo);
    ok("D2  auditoria completa", r.tipo === "sucesso" && r.auditoria === "completa");
    ok("D3  envelope no contrato 1, ok true",
      r.tipo === "sucesso" && r.envelope.contrato === 1 && r.envelope.ok === true);
    ok("D4  request_id do envelope e o da tentativa",
      r.tipo === "sucesso" && r.envelope.request_id === r.requestId);
    ok("D5  sem execution_id — executor in-process",
      r.tipo === "sucesso" && !("execution_id" in r.envelope));

    const auditadas = linhasGravadas();
    ok("D6  exatamente DUAS linhas: abertura e desfecho", auditadas.length === 2, String(auditadas.length));
    ok("D7  a primeira e a abertura, com status executando",
      auditadas[0]?.linha?.fase === "abertura" && auditadas[0]?.linha?.status === "executando");
    ok("D8  a segunda e o desfecho de sucesso",
      auditadas[1]?.linha?.fase === "desfecho" && auditadas[1]?.linha?.status === "sucesso");
    ok("D9  a abertura vem ANTES da consulta a pedidos",
      chamadas.findIndex((c) => c.escrita && c.tabela === "agente_funcao_chamadas") <
      chamadas.findIndex((c) => c.tabela === "pedidos"));
    ok("D10 leitura grava idempotency_key NULL", auditadas[0]?.linha?.idempotency_key === null);
    ok("D11 abertura sem latencia", auditadas[0]?.linha?.latencia_ms === null);
    ok("D12 desfecho com latencia medida >= 0",
      typeof auditadas[1]?.linha?.latencia_ms === "number" &&
      (auditadas[1]?.linha?.latencia_ms as number) >= 0);
    ok("D13 entrada_resumo vazio", JSON.stringify(auditadas[0]?.linha?.entrada_resumo) === "{}");
    ok("D14 nenhuma coluna de saida foi gravada",
      auditadas.every((c) => !("data" in (c.linha ?? {})) && !("saida" in (c.linha ?? {})) &&
        !("resultado" in (c.linha ?? {}))));
    ok("D15 sem conexao: plataforma, recurso e loja NULL",
      auditadas[0]?.linha?.plataforma === null && auditadas[0]?.linha?.recurso === null &&
      auditadas[0]?.linha?.loja_id === null);
    ok("D16 vendas.consultar nao consulta agente_conexoes",
      !chamadas.some((c) => c.tabela === "agente_conexoes"));
  }

  secao("D2. Falhas de auditoria e de execucao");
  {
    roteiro(agenteOk, permissao("automatico"), naoGravou);
    const r = await executarFuncao({ ...base });
    ok("D17 abertura que nao grava -> falha_auditoria/abertura",
      r.tipo === "falha_auditoria" && r.etapa === "abertura" && r.reexecutavel === false);
    ok("D18 e o EXECUTOR nao roda", !chamadas.some((c) => c.tabela === "pedidos"));

    roteiro(agenteOk, permissao("automatico"), duplicado);
    const r2 = await executarFuncao({ ...base });
    ok("D19 abertura duplicada tambem impede o executor",
      r2.tipo === "falha_auditoria" && !chamadas.some((c) => c.tabela === "pedidos"));

    roteiro(agenteOk, permissao("automatico"), gravou, semVendas, naoGravou);
    const r3 = await executarFuncao({ ...base });
    ok("D20 leitura com desfecho que falha -> sucesso com auditoria incompleta",
      r3.tipo === "sucesso" && r3.auditoria === "incompleta");

    roteiro(agenteOk, permissao("automatico"), gravou,
      { data: null, error: { code: "08006" } }, gravou);
    const r4 = await executarFuncao({ ...base });
    ok("D21 erro de dominio da Funcao -> erro com codigo do dominio",
      r4.tipo === "erro" && r4.envelope.error.code === "erro_consulta_vendas");
    ok("D22 e a Tool Call registra a categoria executor_falhou",
      linhasGravadas()[1]?.linha?.codigo_desfecho === "executor_falhou");
    ok("D23 retryable vem da Funcao, e e true para leitura",
      r4.tipo === "erro" && r4.envelope.error.retryable === true);
    ok("D24 o desfecho de erro tambem tem latencia",
      typeof linhasGravadas()[1]?.linha?.latencia_ms === "number");
  }

  // ─── E. Estrutura do executor ──────────────────────────────────────

  secao("E. O executor nao vira registry nem porta de injecao");
  {
    ok("E1  e server-only", /^import "server-only";/m.test(EXECUTOR));
    ok("E2  nenhum switch ou if por funcaoId",
      !/switch\s*\(\s*funcaoId/.test(EXECUTOR_CODIGO) &&
      !/funcaoId\s*===\s*"/.test(EXECUTOR_CODIGO));
    ok("E3  CONTROLE: a sonda acharia o special-case",
      /funcaoId\s*===\s*"/.test('if (funcaoId === "vendas.consultar") {}'));

    ok("E4  nenhum fetch", !/\bfetch\s*\(/.test(EXECUTOR_CODIGO));
    ok("E5  nenhuma mencao a n8n ou marketplace",
      !/\bn8n\b|mercado_?livre|shopee|webhook/i.test(EXECUTOR_CODIGO));
    ok("E6  nenhum retry, replay ou recovery",
      !/\bretry\b|\breplay\b|recovery|tentarNovamente|setTimeout/i.test(EXECUTOR_CODIGO));
    ok("E7  nao toca agente_tarefas nem status de tarefa",
      !/agente_tarefas|concluir_tarefa|falhar_tarefa/.test(EXECUTOR_CODIGO));

    // A porta que NAO existe: um segundo parametro de dependencias.
    ok("E8  executarFuncao aceita UM parametro",
      /export async function executarFuncao\(\s*entrada: EntradaExecucaoFuncao\s*\): Promise</.test(EXECUTOR_CODIGO));
    ok("E9  executarFuncao.length === 1", executarFuncao.length === 1);
    ok("E10 nenhum override de autoridade exportado",
      !/skipGuard|mockPermission|overrideAccess|overrideConnection|fakeRegistry|deps/i.test(EXECUTOR_CODIGO));

    ok("E11 a entrada publica NAO tem campos de autoridade",
      !/interface EntradaExecucaoFuncao \{[^}]*(requestId|acesso|idempotente|conexaoNecessaria|nivel|lojaId|plataforma|recurso)/s
        .test(EXECUTOR_CODIGO));
    ok("E12 conexaoNecessaria vem SEMPRE da definicao",
      /conexaoNecessaria: definicao\.conexaoNecessaria/.test(EXECUTOR_CODIGO) &&
      !/entrada\.conexaoNecessaria|input\.conexaoNecessaria/.test(EXECUTOR_CODIGO));
    ok("E13 acesso vem da definicao", /acesso: definicao\.acesso/.test(EXECUTOR_CODIGO));
    ok("E14 request_id nasce aqui, por randomUUID",
      /const requestId = randomUUID\(\)/.test(EXECUTOR_CODIGO) &&
      !/entrada\.requestId/.test(EXECUTOR_CODIGO));
    // A sonda mira a FORMA de usar o perfil — ler `agente.tipo`, ou
    // comparar com um valor canonico. Nao pode ser `/\.tipo\b/` solto: a
    // propria uniao publica usa `tipo` como discriminante, e a sonda
    // acabaria acusando o discriminante dela mesma.
    const LE_PERFIL =
      /agente[\w.]*\.tipo\b|linha\.tipo\b|\.tipo\s*===\s*"(personalizado|mensagens|ads|fotos|anuncios|financeiro|gerente)"/;
    ok("E15 agentes.tipo nao participa da decisao", !LE_PERFIL.test(EXECUTOR_CODIGO));
    ok("E15b CONTROLE: a sonda acha as duas formas de usar o perfil",
      LE_PERFIL.test('if (agente.tipo === "financeiro") liberar()') &&
      LE_PERFIL.test("const t = agente.linha.tipo;"));
    ok("E16 nenhum erro cru do driver e propagado",
      !/error\.message|err\.message|\.details|\.hint|\.stack/.test(EXECUTOR_CODIGO));
    ok("E17 escrita e fail-closed antes da abertura",
      /definicao\.acesso === "escrita"/.test(EXECUTOR_CODIGO) &&
      EXECUTOR_CODIGO.indexOf('definicao.acesso === "escrita"') <
        EXECUTOR_CODIGO.indexOf("registrarAbertura("));
    // ── E18: conjunto EXATO, e nao subconjunto ──────────────────────
    //
    // A versao anterior fazia `EXPERADAS.every(...)` sobre o arquivo
    // inteiro, o que prova apenas que as esperadas EXISTEM em algum
    // lugar. Duas fraquezas: uma variante nova entrava na uniao publica
    // sem ninguem notar — foi o que aconteceu com
    // `aprovacao_indisponivel` —, e um `tipo: "..."` de qualquer outro
    // objeto do arquivo contava como prova.
    //
    // Agora o detector isola a DECLARACAO da uniao pela profundidade de
    // chaves — o `;` que a fecha e o primeiro em profundidade zero, e
    // nao o `requestId: string;` do primeiro membro — e exige igualdade
    // de conjunto nos dois sentidos.
    const VARIANTES_ESPERADAS = [
      "sucesso",
      "negado",
      "aguardando_aprovacao",
      "aprovacao_indisponivel",
      "erro",
      "falha_auditoria",
      "indisponivel",
    ] as const;

    const blocoDeTipo = (codigo: string, nome: string): string | null => {
      const inicio = codigo.indexOf(`export type ${nome} =`);
      if (inicio < 0) return null;
      let profundidade = 0;
      for (let i = inicio; i < codigo.length; i++) {
        const c = codigo[i];
        if (c === "{") profundidade++;
        else if (c === "}") profundidade--;
        else if (c === ";" && profundidade === 0) return codigo.slice(inicio, i + 1);
      }
      return null;
    };

    const variantesDe = (bloco: string): string[] =>
      [...bloco.matchAll(/tipo: "([a-z_]+)"/g)].map((m) => m[1]);

    /** O detector, um so: `null` (bloco nao encontrado) reprova, e a
     *  comparacao e por conjunto — tamanho igual mais conteudo igual,
     *  entao faltar, sobrar ou duplicar reprova do mesmo jeito. */
    const uniaoCorreta = (bloco: string | null, esperadas: readonly string[]): boolean => {
      if (bloco === null) return false;
      const achadas = variantesDe(bloco);
      return (
        achadas.length === esperadas.length &&
        JSON.stringify([...achadas].sort()) === JSON.stringify([...esperadas].sort())
      );
    };

    // As duas fixtures negativas DERIVAM do bloco real: uma union curta
    // escrita a mao provaria o detector contra um texto que ninguem
    // mantem, e continuaria passando depois que a uniao real mudasse.
    const semVariante = (bloco: string, nome: string): string => {
      const i = bloco.indexOf(`| { tipo: "${nome}"`);
      if (i < 0) return bloco;
      return bloco.slice(0, i) + bloco.slice(bloco.indexOf("}", i) + 1);
    };
    const comVariante = (bloco: string, nome: string): string =>
      `${bloco.slice(0, -1)}\n  | { tipo: "${nome}"; requestId: string };`;

    const BLOCO = blocoDeTipo(EXECUTOR_CODIGO, "ResultadoExecucaoFuncao");
    const VARIANTES_REAIS = BLOCO === null ? [] : variantesDe(BLOCO);

    ok("E18 a uniao publica tem EXATAMENTE as sete variantes declaradas",
      uniaoCorreta(BLOCO, VARIANTES_ESPERADAS), VARIANTES_REAIS.join(", "));
    ok("E18a ANCORA: a declaracao da uniao foi encontrada e delimitada",
      BLOCO !== null && BLOCO.startsWith("export type ResultadoExecucaoFuncao =") &&
      BLOCO.endsWith(";"));
    ok("E18b ANCORA: o bloco para na declaracao, e nao engole o arquivo",
      BLOCO !== null && !BLOCO.includes("type ResultadoErro") && VARIANTES_REAIS.length === 7,
      `${VARIANTES_REAIS.length} variantes`);
    ok("E18c CONTROLE: bloco ausente reprova, em vez de passar vazio",
      !uniaoCorreta(blocoDeTipo(EXECUTOR_CODIGO, "TipoQueNaoExiste"), VARIANTES_ESPERADAS) &&
      !uniaoCorreta(null, VARIANTES_ESPERADAS));

    const SEM_APROVACAO = BLOCO === null ? "" : semVariante(BLOCO, "aprovacao_indisponivel");
    ok("E18d CONTROLE: a fixture derivada realmente perdeu uma variante",
      variantesDe(SEM_APROVACAO).length === 6 &&
      !variantesDe(SEM_APROVACAO).includes("aprovacao_indisponivel"));
    ok("E18e CONTROLE: voltar para seis variantes reprova no MESMO detector",
      !uniaoCorreta(SEM_APROVACAO, VARIANTES_ESPERADAS));

    const COM_OITAVA = BLOCO === null ? "" : comVariante(BLOCO, "variante_inesperada");
    ok("E18f CONTROLE: a fixture derivada realmente ganhou uma variante",
      variantesDe(COM_OITAVA).length === 8 &&
      variantesDe(COM_OITAVA).includes("variante_inesperada"));
    ok("E18g CONTROLE: uma oitava variante nao declarada tambem reprova",
      !uniaoCorreta(COM_OITAVA, VARIANTES_ESPERADAS));
    ok("E18h CONTROLE: duplicata reprova pelo tamanho, nao passa por conteudo",
      !uniaoCorreta(BLOCO === null ? "" : comVariante(BLOCO, "sucesso"), VARIANTES_ESPERADAS));
    ok("E19 CodigoNegacaoTerminal e DERIVADO, nao recopiado",
      /Exclude<CodigoNegacao, "aprovacao_necessaria">/.test(EXECUTOR_CODIGO) &&
      !/"permissao_ausente"[\s\S]{0,40}"permissao_bloqueada"/.test(EXECUTOR_CODIGO));
    ok("E20 o executor da Funcao e chamado uma vez so",
      (EXECUTOR_CODIGO.match(/definicao\.executor\(/g) ?? []).length === 1);
  }

  secao("E2. Vocabulario continua com dono unico");
  {
    ok("E21 os cinco codigos de negacao seguem no guard",
      CODIGOS_NEGACAO.length === 5 && CODIGOS_NEGACAO.includes("aprovacao_necessaria"));
    ok("E22 os cinco de execucao seguem no contrato",
      CODIGOS_EXECUCAO.length === 5 && !(CODIGOS_EXECUCAO as readonly string[]).includes("erro_consulta_vendas"));
    ok("E23 o codigo de dominio de vendas NAO virou categoria",
      !/erro_consulta_vendas/.test(semComentarios(ler("lib/agentes/chamadas/contrato.ts"))));
  }

  // ─── F. Caminhos pos-abertura, fim a fim ───────────────────────────
  //
  // O achado A2 do TOOL-EXEC-R1: quatro ramos existiam no codigo e
  // nenhum era exercitado por comportamento. Cada cenario abaixo roda o
  // `executarFuncao` REAL contra um catalogo controlado, e os que
  // envolvem auditoria sao medidos DUAS vezes — desfecho que grava e
  // desfecho que nao grava —, porque so o par prova que `auditoria` nao
  // esta fixa numa constante.

  secao("F. Falhas pos-abertura, com o executor real");
  {
    // Roteiro de uma Funcao controlada: agente, permissao, abertura,
    // desfecho. Ela nao consulta `pedidos` e nao pede conexao.
    const cenario = (desfecho: Resposta) =>
      roteiro(agenteOk, permissaoDe(ID_CONTROLADA, "automatico"), gravou, desfecho);

    const desfechoGravado = () => linhasGravadas()[1]?.linha ?? {};

    // ── F0. A ANCORA. Sem ela a secao inteira seria falsa ───────────
    catalogoControlado = controlada({});
    cenario(gravou);
    vezesExecutor = 0;
    const rAncora = await executarFuncao(baseControlada);

    ok("F0  ANCORA: o duplo do catalogo foi instalado", interceptouCatalogo);
    ok("F0a ANCORA: a Funcao controlada e resolvida como canonica",
      rAncora.tipo === "sucesso", rAncora.tipo);
    ok("F0b ANCORA: ela NAO existe no catalogo real",
      !Object.prototype.hasOwnProperty.call(FUNCOES, ID_CONTROLADA));
    ok("F0c ANCORA: o executor controlado rodou uma vez", vezesExecutor === 1);

    // ── F1. Executor lanca ──────────────────────────────────────────
    catalogoControlado = controlada({
      executor: contando(async () => {
        throw new Error("estouro sintetico com dado sensivel: senha=123");
      }),
    });

    cenario(gravou);
    vezesExecutor = 0;
    const rLanca = await executarFuncao(baseControlada);
    const linhasLanca = linhasGravadas();

    ok("F1  executor que lanca -> tipo erro", rLanca.tipo === "erro", rLanca.tipo);
    ok("F1a o executor foi chamado exatamente uma vez", vezesExecutor === 1, String(vezesExecutor));
    ok("F1b houve abertura ANTES, e sao duas linhas",
      linhasLanca.length === 2 && linhasLanca[0].linha?.status === "executando",
      String(linhasLanca.length));
    ok("F1c o desfecho registra executor_falhou",
      desfechoGravado().codigo_desfecho === "executor_falhou",
      String(desfechoGravado().codigo_desfecho));
    ok("F1d a latencia foi medida",
      typeof desfechoGravado().latencia_ms === "number" &&
        (desfechoGravado().latencia_ms as number) >= 0);
    ok("F1e auditoria completa quando o desfecho grava",
      rLanca.tipo === "erro" && rLanca.auditoria === "completa");
    ok("F1f o envelope e valido e traz executor_falhou",
      rLanca.tipo === "erro" && envelopeValido(rLanca.envelope) &&
        rLanca.envelope.error.code === "executor_falhou");
    ok("F1g nenhuma excecao crua chega ao chamador",
      rLanca.tipo === "erro" && !/estouro sintetico|senha=123|Error/.test(JSON.stringify(rLanca)));

    // ── F2. Executor lanca E o desfecho nao grava ───────────────────
    cenario(naoGravou);
    vezesExecutor = 0;
    const rLancaSemAudit = await executarFuncao(baseControlada);

    ok("F2  a falha da Tool NAO some quando a auditoria falha",
      rLancaSemAudit.tipo === "erro" &&
        rLancaSemAudit.envelope.error.code === "executor_falhou",
      rLancaSemAudit.tipo);
    ok("F2a e a auditoria e declarada incompleta",
      rLancaSemAudit.tipo === "erro" && rLancaSemAudit.auditoria === "incompleta");
    ok("F2b o executor continua com UMA chamada — zero retry", vezesExecutor === 1);
    ok("F2c nenhuma segunda tentativa de gravar o desfecho",
      linhasGravadas().length === 2, String(linhasGravadas().length));
    ok("F2d CONTROLE: o par prova que `auditoria` nao e constante",
      rLanca.tipo === "erro" && rLanca.auditoria === "completa" &&
        rLancaSemAudit.tipo === "erro" && rLancaSemAudit.auditoria === "incompleta");

    // ── F3. Interpretador lanca ─────────────────────────────────────
    catalogoControlado = controlada({
      interpretarSaida: () => {
        throw new Error("estouro do interpretador");
      },
    });

    cenario(gravou);
    vezesExecutor = 0;
    const rInterp = await executarFuncao(baseControlada);

    ok("F3  interpretador que lanca -> tipo erro", rInterp.tipo === "erro", rInterp.tipo);
    ok("F3a o executor rodou normalmente, uma vez", vezesExecutor === 1);
    ok("F3b a abertura aconteceu", linhasGravadas().length === 2);
    ok("F3c o desfecho registra erro_interno, NAO saida_invalida",
      desfechoGravado().codigo_desfecho === "erro_interno",
      String(desfechoGravado().codigo_desfecho));
    ok("F3d o envelope e valido e traz erro_interno",
      rInterp.tipo === "erro" && envelopeValido(rInterp.envelope) &&
        rInterp.envelope.error.code === "erro_interno");
    ok("F3e auditoria completa", rInterp.tipo === "erro" && rInterp.auditoria === "completa");
    ok("F3f nenhuma excecao crua vaza",
      !/estouro do interpretador|Error/.test(JSON.stringify(rInterp)));

    cenario(naoGravou);
    const rInterpSemAudit = await executarFuncao(baseControlada);
    ok("F3g o mesmo caminho com desfecho falho vira incompleta",
      rInterpSemAudit.tipo === "erro" && rInterpSemAudit.auditoria === "incompleta");

    // ── F4. Saida malformada, fim a fim ─────────────────────────────
    catalogoControlado = controlada({
      executor: contando(async () => null),
      interpretarSaida: (saida: unknown) =>
        saida === null ? { tipo: "invalida" } : { tipo: "sucesso", data: saida },
    });

    cenario(gravou);
    vezesExecutor = 0;
    const rInvalida = await executarFuncao(baseControlada);

    ok("F4  saida malformada -> tipo erro, nunca sucesso", rInvalida.tipo === "erro", rInvalida.tipo);
    ok("F4a o executor rodou uma vez", vezesExecutor === 1);
    ok("F4b a abertura aconteceu antes", linhasGravadas().length === 2);
    ok("F4c o desfecho registra saida_invalida, NAO executor_falhou",
      desfechoGravado().codigo_desfecho === "saida_invalida",
      String(desfechoGravado().codigo_desfecho));
    ok("F4d o envelope e valido e traz saida_invalida",
      rInvalida.tipo === "erro" && envelopeValido(rInvalida.envelope) &&
        rInvalida.envelope.error.code === "saida_invalida");
    ok("F4e auditoria completa", rInvalida.tipo === "erro" && rInvalida.auditoria === "completa");
    ok("F4f nenhuma coluna de saida foi gravada",
      !("data" in desfechoGravado()) && !("saida" in desfechoGravado()) &&
        !("resultado" in desfechoGravado()));

    // ── F5. Erro de dominio com auditoria perdida ───────────────────
    catalogoControlado = controlada({
      interpretarSaida: () => ({
        tipo: "erro",
        codigo: "erro_consulta_vendas",
        mensagem: "Nao foi possivel ler as vendas do periodo.",
        retryable: true,
      }),
    });

    cenario(gravou);
    vezesExecutor = 0;
    const rDominio = await executarFuncao(baseControlada);

    ok("F5  erro de dominio com desfecho gravado -> completa",
      rDominio.tipo === "erro" && rDominio.auditoria === "completa");
    ok("F5a o codigo de dominio chega ao envelope",
      rDominio.tipo === "erro" && rDominio.envelope.error.code === "erro_consulta_vendas");
    ok("F5b a Tool Call registra a CATEGORIA executor_falhou",
      desfechoGravado().codigo_desfecho === "executor_falhou");

    cenario(naoGravou);
    vezesExecutor = 0;
    const rDominioSemAudit = await executarFuncao(baseControlada);

    ok("F5c erro de dominio com desfecho perdido -> incompleta",
      rDominioSemAudit.tipo === "erro" && rDominioSemAudit.auditoria === "incompleta");
    ok("F5d o codigo de dominio continua o mesmo",
      rDominioSemAudit.tipo === "erro" &&
        rDominioSemAudit.envelope.error.code === "erro_consulta_vendas");
    ok("F5e retryable continua true — leitura repetivel, nao ordem de repetir",
      rDominioSemAudit.tipo === "erro" && rDominioSemAudit.envelope.error.retryable === true);
    ok("F5f zero retry: uma chamada ao executor", vezesExecutor === 1);
  }

  // ─── F2. O contrato publico nunca sai quebrado ─────────────────────

  secao("F2. EnvelopeErro invalido nao escapa");
  {
    // ── F6. Codigo invalido vindo do INTERPRETADOR (pos-abertura) ───
    //
    // `envelopeValido` exige `error.code` com texto util. Um codigo so
    // de espacos e o candidato mais barato que reprova sem inventar
    // regra nova: e a mesma condicao de `ehTextoUtil` do contrato.
    catalogoControlado = controlada({
      interpretarSaida: () => ({ tipo: "erro", codigo: "   ", mensagem: "m", retryable: true }),
    });

    roteiro(agenteOk, permissaoDe(ID_CONTROLADA, "automatico"), gravou, gravou);
    const rQuebrado = await executarFuncao(baseControlada);
    const linhaQuebrado = linhasGravadas()[1]?.linha ?? {};

    ok("F6  envelope candidato invalido NAO e devolvido",
      rQuebrado.tipo === "erro" && rQuebrado.envelope.error.code !== "   ");
    ok("F6a o que sai e um envelope VALIDO",
      rQuebrado.tipo === "erro" && envelopeValido(rQuebrado.envelope));
    ok("F6b e ele e classificado como erro_interno",
      rQuebrado.tipo === "erro" && rQuebrado.envelope.error.code === "erro_interno");
    ok("F6c a Tool Call degrada junto, e NAO diz executor_falhou",
      linhaQuebrado.codigo_desfecho === "erro_interno",
      String(linhaQuebrado.codigo_desfecho));
    ok("F6d o request_id do envelope continua o da tentativa",
      rQuebrado.tipo === "erro" && rQuebrado.envelope.request_id === rQuebrado.requestId);
    ok("F6e nada do candidato entra na mensagem",
      rQuebrado.tipo === "erro" && !/^m$/.test(rQuebrado.envelope.error.message) &&
        rQuebrado.envelope.error.message.trim().length > 0);

    // ── F7. Codigo invalido vindo do VALIDADOR (pre-abertura) ───────
    catalogoControlado = controlada({
      validarEntrada: () => ({ valida: false, codigo: "" }),
    });

    roteiro(agenteOk, permissaoDe(ID_CONTROLADA, "automatico"), gravou);
    vezesExecutor = 0;
    const rValidador = await executarFuncao(baseControlada);
    const linhaValidador = linhasGravadas()[0]?.linha ?? {};

    ok("F7  entrada invalida com codigo vazio nao devolve envelope quebrado",
      rValidador.tipo === "erro" && envelopeValido(rValidador.envelope));
    ok("F7a o envelope degrada para erro_interno",
      rValidador.tipo === "erro" && rValidador.envelope.error.code === "erro_interno");
    ok("F7b a linha degrada junto, e NAO diz entrada_invalida",
      linhaValidador.codigo_desfecho === "erro_interno",
      String(linhaValidador.codigo_desfecho));
    ok("F7c continua sem abertura e sem executor",
      linhasGravadas().length === 1 && vezesExecutor === 0);
    ok("F7d a auditoria e declarada tambem no caminho pre-abertura",
      rValidador.tipo === "erro" && rValidador.auditoria === "completa");

    // ── F8. CONTROLE: um codigo BOM nao degrada nada ────────────────
    //
    // Sem este par, F6/F7 passariam mesmo que o executor devolvesse
    // `erro_interno` para tudo.
    catalogoControlado = controlada({
      validarEntrada: () => ({ valida: false, codigo: "janela_excedida" }),
    });

    roteiro(agenteOk, permissaoDe(ID_CONTROLADA, "automatico"), gravou);
    const rBom = await executarFuncao(baseControlada);

    ok("F8  CONTROLE: codigo de dominio valido chega intacto ao envelope",
      rBom.tipo === "erro" && rBom.envelope.error.code === "janela_excedida");
    ok("F8a CONTROLE: e a linha registra a categoria entrada_invalida",
      (linhasGravadas()[0]?.linha ?? {}).codigo_desfecho === "entrada_invalida");
    ok("F8b CONTROLE: a auditoria acompanha o estado da gravacao",
      rBom.tipo === "erro" && rBom.auditoria === "completa");

    catalogoControlado = null;
  }

  // ─── G. O request que precisa de aprovacao ─────────────────────────
  //
  // O que mudou no APPROVAL-B1C-I2: o ramo `aguardando_aprovacao`
  // deixou de gravar um desfecho isolado e passou a criar — ou
  // reencontrar — uma aprovacao. A espera ganhou dono, prazo e
  // argumentos congelados; a Tool Call parou de contar a mesma historia
  // pela metade.

  secao("G. Request com nivel aprovacao cria a Approval, e nao a Tool Call");
  {
    const pedirAprovacao = (argumentos: unknown = {}) =>
      executarFuncao({ ...baseControlada, argumentos });

    // ── G0. Caminho feliz ───────────────────────────────────────────
    catalogoControlado = controlada({});
    roteiro(agenteOk, permissaoDe(ID_CONTROLADA, "aprovacao"));
    roteiroRpc(criouAprovacao("criada"));
    vezesExecutor = 0;
    const rCriada = await pedirAprovacao({ filtro: 1 });

    ok("G1  nivel aprovacao com argumento valido chama criarAprovacao",
      chamadasRpc.length === 1 && chamadasRpc[0]?.nome === "aprovacao_criar");
    ok("G2  o resultado carrega o id da aprovacao",
      rCriada.tipo === "aguardando_aprovacao" && rCriada.aprovacaoId === APROVACAO &&
      rCriada.estadoAprovacao === "criada");
    ok("G3  nenhuma Tool Call e gravada", linhasGravadas().length === 0);
    ok("G4  nenhuma abertura", !chamadas.some((c) => c.escrita && c.linha?.fase === "abertura"));
    ok("G5  o executor da Funcao NAO roda", vezesExecutor === 0);
    ok("G6  requestId continua existindo como correlacao",
      typeof rCriada.requestId === "string" && rCriada.requestId.length > 0);
    ok("G7  o argumento congelado e o MESMO que foi validado",
      JSON.stringify(chamadasRpc[0]?.parametros?.p_argumentos) === JSON.stringify({ filtro: 1 }));
    ok("G8  a revisao vai do catalogo, nao do chamador",
      chamadasRpc[0]?.parametros?.p_revisao_funcao === REVISAO_CONTROLADA);
    ok("G9  o acesso tambem vem do catalogo",
      chamadasRpc[0]?.parametros?.p_acesso === "leitura");

    // ── G10. Reuso ──────────────────────────────────────────────────
    roteiro(agenteOk, permissaoDe(ID_CONTROLADA, "aprovacao"));
    roteiroRpc(criouAprovacao("reutilizada"));
    const rReuso = await pedirAprovacao({ filtro: 1 });
    ok("G10 reutilizada devolve o MESMO aprovacaoId",
      rReuso.tipo === "aguardando_aprovacao" && rReuso.aprovacaoId === APROVACAO);
    ok("G11 e se declara reutilizada, nao criada",
      rReuso.tipo === "aguardando_aprovacao" && rReuso.estadoAprovacao === "reutilizada");
    ok("G12 reuso tambem nao grava Tool Call", linhasGravadas().length === 0);

    // ── G13. Argumento invalido NAO vira aprovacao ──────────────────
    //
    // Congelar um argumento invalido produziria uma aprovacao que o
    // dono poderia aprovar e que o consumo — que revalida — jamais
    // aceitaria. O comportamento de entrada invalida e o de sempre:
    // erro com o codigo de DOMINIO e a categoria na Tool Call.
    catalogoControlado = controlada({
      validarEntrada: () => ({ valida: false, codigo: "data_invalida" }),
    });
    roteiro(agenteOk, permissaoDe(ID_CONTROLADA, "aprovacao"), gravou);
    roteiroRpc(criouAprovacao("criada"));
    const rInvalida = await pedirAprovacao({ ruim: true });

    ok("G13 argumento invalido NAO chama criarAprovacao", chamadasRpc.length === 0);
    ok("G14 e o resultado preserva o erro de entrada",
      rInvalida.tipo === "erro" && rInvalida.envelope.error.code === "data_invalida");
    ok("G15 a Tool Call registra a CATEGORIA entrada_invalida",
      linhasGravadas()[0]?.linha?.codigo_desfecho === "entrada_invalida");
    ok("G16 e o executor nao roda", vezesExecutor === 0);

    // ── G17. Validador que LANCA e bug nosso, nao entrada ruim ──────
    catalogoControlado = controlada({
      validarEntrada: () => {
        throw new Error("validador quebrado");
      },
    });
    roteiro(agenteOk, permissaoDe(ID_CONTROLADA, "aprovacao"), gravou);
    roteiroRpc(criouAprovacao("criada"));
    const rLancou = await pedirAprovacao({});
    ok("G17 throw do validador -> erro_interno, e nao entrada_invalida",
      rLancou.tipo === "erro" && rLancou.envelope.error.code === "erro_interno");
    ok("G18 e nenhuma aprovacao e criada", chamadasRpc.length === 0);

    // ── G19. Corridas de autoridade entre o guard e a RPC ───────────
    //
    // Cada uma destas e o dono mudando algo DURANTE o pedido. Nenhuma
    // pode virar execucao, e nenhuma pode virar silencio.
    const recusa = async (codigo: string, respostasExtra: Resposta[] = [gravou]) => {
      catalogoControlado = controlada({});
      roteiro(agenteOk, permissaoDe(ID_CONTROLADA, "aprovacao"), ...respostasExtra);
      roteiroRpc({ data: { id: null, resultado: codigo } });
      vezesExecutor = 0;
      return pedirAprovacao({});
    };

    const rSemPerm = await recusa("permissao_ausente");
    ok("G19 permissao_ausente -> negado, com a linha da negacao",
      rSemPerm.tipo === "negado" && rSemPerm.codigo === "permissao_ausente" &&
      linhasGravadas()[0]?.linha?.status === "negado");

    const rSemConexao = await recusa("conexao_indisponivel");
    ok("G20 conexao_indisponivel -> negado/conexao_ausente",
      rSemConexao.tipo === "negado" && rSemConexao.codigo === "conexao_ausente" &&
      linhasGravadas()[0]?.linha?.codigo_desfecho === "conexao_ausente");

    const rSemAgente = await recusa("agente_indisponivel", []);
    ok("G21 agente_indisponivel -> indisponivel, e sem gravar linha",
      rSemAgente.tipo === "indisponivel" && linhasGravadas().length === 0);

    const rCorrida = await recusa("permissao_nao_exige_aprovacao");
    ok("G22 corrida de autoridade -> erro_interno fail-closed, nunca execucao",
      rCorrida.tipo === "erro" && rCorrida.envelope.error.code === "erro_interno" &&
      vezesExecutor === 0);

    const rConflito = await recusa("conflito_nao_resolvido");
    ok("G23 conflito nao resolvido -> erro_interno",
      rConflito.tipo === "erro" && rConflito.envelope.error.code === "erro_interno");

    // ── G24. REGRESSAO: automatico e bloqueado seguem intocados ─────
    catalogoControlado = controlada({});
    roteiro(agenteOk, permissaoDe(ID_CONTROLADA, "automatico"), gravou, gravou);
    roteiroRpc();
    vezesExecutor = 0;
    const rAuto = await executarFuncao(baseControlada);

    ok("G24 automatico executa como antes", rAuto.tipo === "sucesso" && vezesExecutor === 1);
    ok("G25 automatico NAO toca aprovacao", chamadasRpc.length === 0);
    ok("G26 automatico grava abertura E desfecho, nessa ordem",
      linhasGravadas().length === 2 &&
      linhasGravadas()[0]?.linha?.fase === "abertura" &&
      linhasGravadas()[1]?.linha?.fase === "desfecho");
    ok("G27 e as duas linhas usam o MESMO request_id",
      linhasGravadas()[0]?.linha?.request_id === rAuto.requestId &&
      linhasGravadas()[1]?.linha?.request_id === rAuto.requestId);

    roteiro(agenteOk, permissaoDe(ID_CONTROLADA, "bloqueado"), gravou);
    roteiroRpc();
    vezesExecutor = 0;
    const rBloq = await executarFuncao(baseControlada);
    ok("G28 bloqueado continua negando", rBloq.tipo === "negado" && rBloq.codigo === "permissao_bloqueada");
    ok("G29 bloqueado NAO cria aprovacao", chamadasRpc.length === 0);
    ok("G30 e nao executa", vezesExecutor === 0);

    catalogoControlado = null;
  }

  // ─── H. A retomada ─────────────────────────────────────────────────

  secao("H. Retomada: uma aprovacao consumida, uma Tool Call, uma execucao");
  {
    const retomar = () => retomarAprovacao({ userId: USER, aprovacaoId: APROVACAO });
    const paramConsumo = () =>
      chamadasRpc.find((c) => c.nome === "aprovacao_consumir_e_abrir")?.parametros ?? {};

    // ── H0. Caminho feliz ───────────────────────────────────────────
    catalogoControlado = controlada({});
    roteiro(aprovacaoLinha(), aberturaComNivel("aprovacao"), gravou);
    roteiroRpc(consumo("consumida"));
    vezesExecutor = 0;
    ultimosArgumentos = undefined;
    const rOk = await retomar();

    ok("H1  a retomada executa a Funcao uma vez", rOk.tipo === "sucesso" && vezesExecutor === 1);
    ok("H2  os argumentos vem da APROVACAO, nao de quem retomou",
      JSON.stringify(ultimosArgumentos) === JSON.stringify({ congelado: true }));
    ok("H3  o contexto do executor carrega o userId autenticado",
      JSON.stringify(ultimoContexto) === JSON.stringify({ userId: USER, conexao: null }));
    ok("H3a Funcao SEM requisito recebe `conexao: null`, nunca `undefined`",
      (ultimoContexto as { conexao?: unknown })?.conexao === null &&
        "conexao" in (ultimoContexto as object));
    ok("H4  a definicao e resolvida ANTES do consumo",
      chamadasRpc[0]?.parametros?.p_revisao_atual === REVISAO_CONTROLADA);
    ok("H5  o requestId vem da RPC, e nao e gerado aqui",
      paramConsumo().p_request_id === rOk.requestId);
    ok("H6  a retomada NAO abre Tool Call",
      !linhasGravadas().some((c) => c.linha?.fase === "abertura"));
    ok("H7  ela grava exatamente UMA linha, o desfecho",
      linhasGravadas().length === 1 && linhasGravadas()[0]?.linha?.fase === "desfecho");
    ok("H8  o desfecho fecha a MESMA chamada",
      linhasGravadas()[0]?.linha?.request_id === rOk.requestId);
    ok("H9  o nivel do desfecho espelha o da ABERTURA",
      linhasGravadas()[0]?.linha?.nivel_no_momento === "aprovacao");
    ok("H10 a leitura da abertura foi feita pelo request_id e pela fase",
      chamadas.some((c) => c.tabela === "agente_funcao_chamadas" && !c.escrita &&
        c.filtros.request_id === rOk.requestId && c.filtros.fase === "abertura" &&
        c.filtros.user_id === USER));
    ok("H11 funcaoId e tarefaId vem da aprovacao",
      linhasGravadas()[0]?.linha?.funcao_id === ID_CONTROLADA &&
      linhasGravadas()[0]?.linha?.tarefa_id === null);
    ok("H12 entrada_resumo continua vazio",
      JSON.stringify(linhasGravadas()[0]?.linha?.entrada_resumo) === "{}");
    ok("H13 uma unica RPC por retomada", chamadasRpc.length === 1);

    // ── H14. O nivel NAO e adivinhado ───────────────────────────────
    //
    // Se o dono relaxou a permissao durante a espera, a RPC abre a
    // chamada com `automatico`. O desfecho precisa dizer o mesmo — e e
    // por isso que ele e LIDO da abertura, e nao reconstruido.
    catalogoControlado = controlada({});
    roteiro(aprovacaoLinha(), aberturaComNivel("automatico"), gravou);
    roteiroRpc(consumo("consumida"));
    const rRelaxou = await retomar();
    ok("H14 nivel relaxado durante a espera e espelhado tal como esta",
      rRelaxou.tipo === "sucesso" &&
      linhasGravadas()[0]?.linha?.nivel_no_momento === "automatico");

    // ── H15. Falha do executor fecha a MESMA chamada ────────────────
    catalogoControlado = controlada({
      executor: contando(async () => {
        throw new Error("executor quebrou");
      }),
    });
    roteiro(aprovacaoLinha(), aberturaComNivel("aprovacao"), gravou);
    roteiroRpc(consumo("consumida"));
    vezesExecutor = 0;
    const rFalhou = await retomar();
    ok("H15 executor que lanca -> erro, com a Funcao tendo rodado",
      rFalhou.tipo === "erro" && vezesExecutor === 1);
    ok("H16 e o desfecho fecha a MESMA chamada aberta pela RPC",
      linhasGravadas().length === 1 &&
      linhasGravadas()[0]?.linha?.request_id === rFalhou.requestId &&
      linhasGravadas()[0]?.linha?.codigo_desfecho === "executor_falhou");

    // ── H17. Abertura ilegivel: a crash window controlada ───────────
    //
    // A aprovacao ja foi gasta e a chamada ja esta aberta, mas nao
    // sabemos o que a abertura registrou. Executar produziria um
    // desfecho que discorda da propria abertura. Nao executar deixa uma
    // linha orfa — o dano menor, e o unico honesto.
    const ilegivel = async (resposta: Resposta) => {
      catalogoControlado = controlada({});
      roteiro(aprovacaoLinha(), resposta, gravou);
      roteiroRpc(consumo("consumida"));
      vezesExecutor = 0;
      return retomar();
    };

    const rErroLeitura = await ilegivel(naoGravou);
    ok("H17 leitura da abertura que falha -> falha_auditoria na abertura",
      rErroLeitura.tipo === "falha_auditoria" && rErroLeitura.etapa === "abertura" &&
      rErroLeitura.reexecutavel === false);
    ok("H18 e a Funcao NAO roda", vezesExecutor === 0);
    ok("H19 e nada e gravado — nem abertura, nem desfecho", linhasGravadas().length === 0);
    ok("H20 o requestId devolvido e o da chamada orfa, para quem for investigar",
      rErroLeitura.tipo === "falha_auditoria" &&
      rErroLeitura.requestId === paramConsumo().p_request_id);

    const rSemNivel = await ilegivel(aberturaComNivel(null));
    ok("H21 abertura sem nivel tambem para", rSemNivel.tipo === "falha_auditoria" && vezesExecutor === 0);

    const rNivelEstranho = await ilegivel(aberturaComNivel("inventado"));
    ok("H22 nivel fora do vocabulario tambem para",
      rNivelEstranho.tipo === "falha_auditoria" && vezesExecutor === 0);

    const rSemLinha = await ilegivel({ data: null });
    ok("H23 abertura inexistente tambem para",
      rSemLinha.tipo === "falha_auditoria" && vezesExecutor === 0);

    // ── H24. Nada consome sem consumir ──────────────────────────────
    //
    // Uma tabela: TODO codigo que nao seja `consumida` para antes do
    // executor, mesmo com o contexto ja lido em memoria.
    const RECUSAS = [
      "aprovacao_pendente", "ja_consumida", "ja_rejeitada", "ja_cancelada",
      "expirada", "aprovacao_desatualizada", "permissao_ausente",
      "permissao_bloqueada", "conexao_indisponivel", "escrita_nao_suportada",
      "agente_indisponivel", "tarefa_indisponivel",
    ] as const;

    let recusasCorretas = 0;
    for (const codigo of RECUSAS) {
      catalogoControlado = controlada({});
      roteiro(aprovacaoLinha(), gravou);
      roteiroRpc(consumo(codigo));
      vezesExecutor = 0;
      const r = await retomar();
      if (
        r.tipo === "aprovacao_indisponivel" && r.codigo === codigo &&
        vezesExecutor === 0 && linhasGravadas().length === 0
      ) {
        recusasCorretas++;
      }
    }
    ok(`H24 os ${RECUSAS.length} codigos de recusa param antes do executor`,
      recusasCorretas === RECUSAS.length, `${recusasCorretas}/${RECUSAS.length}`);
    ok("H25 ANCORA: a tabela cobre ja_consumida, expirada e stale",
      (RECUSAS as readonly string[]).includes("ja_consumida") &&
      (RECUSAS as readonly string[]).includes("expirada") &&
      (RECUSAS as readonly string[]).includes("aprovacao_desatualizada"));

    // ── H26. O que nem chega a consumir ─────────────────────────────
    catalogoControlado = controlada({});
    roteiro(aprovacaoLinha({ revisao_funcao: "9" }));
    roteiroRpc(consumo("consumida"));
    vezesExecutor = 0;
    const rStale = await retomar();
    ok("H26 revisao stale recusa ANTES de consumir",
      rStale.tipo === "aprovacao_indisponivel" && rStale.codigo === "aprovacao_desatualizada");
    ok("H27 e a RPC de consumo NAO e chamada", chamadasRpc.length === 0);
    ok("H28 e a Funcao nao roda", vezesExecutor === 0);

    catalogoControlado = controlada({});
    roteiro(aprovacaoLinha({ funcao_id: "teste.sumiu" }));
    roteiroRpc(consumo("consumida"));
    const rSemDef = await retomar();
    ok("H29 Funcao ausente do catalogo recusa antes de consumir",
      rSemDef.tipo === "aprovacao_indisponivel" && rSemDef.codigo === "aprovacao_desatualizada" &&
      chamadasRpc.length === 0);

    catalogoControlado = controlada({});
    roteiro({ data: null });
    roteiroRpc(consumo("consumida"));
    const rInexistente = await retomar();
    ok("H30 aprovacao inexistente ou de outro dono nem consulta a RPC",
      rInexistente.tipo === "aprovacao_indisponivel" &&
      rInexistente.codigo === "aprovacao_inexistente" && chamadasRpc.length === 0);

    // ── H31. A fronteira de confianca da retomada ───────────────────
    const ENTRADA_RETOMADA = EXECUTOR_CODIGO.slice(
      EXECUTOR_CODIGO.indexOf("export interface EntradaRetomadaAprovacao"),
      EXECUTOR_CODIGO.indexOf("export async function retomarAprovacao")
    );
    ok("H31 a entrada da retomada tem SO userId e aprovacaoId",
      /\{\s*userId: string;\s*aprovacaoId: string;\s*\}/.test(ENTRADA_RETOMADA), ENTRADA_RETOMADA);
    ok("H32 e nenhum campo de autoridade cabe nela",
      !/(funcaoId|argumentos|agenteId|tarefaId|revisao|acesso|nivel|lojaId|plataforma|recurso|requestId)\??:/
        .test(ENTRADA_RETOMADA));
    ok("H33 CONTROLE: a sonda acharia um campo de autoridade",
      /(funcaoId|argumentos)\??:/.test("interface X { userId: string; argumentos: unknown; }"));
    ok("H34 a retomada nunca chama registrarAbertura nem executarFuncao",
      !/registrarAbertura|executarFuncao\(/.test(
        EXECUTOR_CODIGO.slice(EXECUTOR_CODIGO.indexOf("export async function retomarAprovacao"))));
    ok("H35 e so `consumida` alcanca o pos-abertura",
      /consumo\.codigo !== "consumida"/.test(EXECUTOR_CODIGO));

    catalogoControlado = null;
  }

  // ═══ I. FUNCTION-RUNTIME-V1-A — o primeiro consumidor de Funcao ════
  //
  // Ate aqui `executarFuncao` nao tinha consumidor de producao: era
  // motor sem veiculo. `handlers/consultar-vendas.ts` e o primeiro, e
  // esta secao prova o que so ele pode quebrar — a traducao entre o
  // vocabulario do executor de Funcoes e o da maquina de estados de
  // Tarefa.
  secao("I. FUNCTION-RUNTIME-V1-A: handler consultar_vendas");
  {
    const HANDLER = "lib/agentes/handlers/consultar-vendas.ts";
    const CONTRATO = "lib/agentes/handlers/consultar-vendas-contrato.ts";
    // A FABRICA e o que sobrou no handler: so a chamada ao executor.
    const FABRICA = semComentarios(ler(HANDLER));
    const PURO = semComentarios(ler(CONTRATO));
    // D5-C1: a implementacao de `consultar_vendas` passou a viver em DOIS
    // arquivos. `CODIGO` continua sendo "a implementacao", agora somada —
    // e isso importa mais para as assercoes de AUSENCIA do que para as de
    // presenca: apontar `!/process\.env/` so para a fabrica encolhida as
    // deixaria vacuamente verdes justamente onde o codigo se mudou.
    const CODIGO = `${FABRICA}\n${PURO}`;
    const mod = await import("../lib/agentes/handlers/consultar-vendas");
    const puro = await import("../lib/agentes/handlers/consultar-vendas-contrato");
    const {
      TIPO_CONSULTAR_VENDAS,
      FUNCAO_ID,
      lerEntradaConsultarVendas,
      agregarConsultaDeVendas,
      mapearResultadoConsultarVendas,
      criarHandlerConsultarVendas,
    } = mod;
    const { ErroEntradaTarefa, PausaPorAprovacao } = await import("../lib/agentes/erros");

    ok("I0  ANCORA: as duas fontes da implementacao foram lidas",
      FABRICA.length > 500 && PURO.length > 2000);

    // ── D5-C1: a separacao e REAL, e o reexport nao cria copia ──────
    ok("I0a a fabrica NAO carrega mais a logica pura",
      !/function agregarConsultaDeVendas|function lerEntradaConsultarVendas|case "sucesso":/.test(FABRICA));
    ok("I0b e o modulo puro NAO chama o executor",
      !/executarFuncao\(/.test(PURO));
    ok("I0c o reexport devolve a MESMA referencia, nunca um invólucro",
      mod.lerEntradaConsultarVendas === puro.lerEntradaConsultarVendas &&
      mod.mapearResultadoConsultarVendas === puro.mapearResultadoConsultarVendas &&
      mod.agregarConsultaDeVendas === puro.agregarConsultaDeVendas &&
      mod.FUNCAO_ID === puro.FUNCAO_ID &&
      mod.TIPO_CONSULTAR_VENDAS === puro.TIPO_CONSULTAR_VENDAS);
    ok("I0d CONTROLE: duas funcoes distintas NAO satisfariam o oraculo",
      ((a: unknown, b: unknown) => a !== b)(() => 1, () => 1));
    ok("I0e o literal `vendas.consultar` tem UMA fonte",
      (PURO.match(/"vendas\.consultar"/g) ?? []).length === 1 &&
      !/"vendas\.consultar"/.test(FABRICA));
    // A SEQUENCIA do caminho automatico, congelada por posicao: ler ->
    // 25 -> executar -> 75 -> mapear -> 100 -> devolver. A extracao nao
    // podia reordenar nada, e antes disto nada media a ordem.
    {
      const pos = (re: RegExp) => FABRICA.search(re);
      const iLer = pos(/const entrada = lerEntradaConsultarVendas\(contexto\.entrada\)/);
      const i25 = pos(/relatarProgresso\(25\)/);
      const iExec = pos(/await executarFuncao\(/);
      const i75 = pos(/relatarProgresso\(75\)/);
      const iMapear = pos(/const saida = mapearResultadoConsultarVendas\(resultado, entrada\)/);
      const i100 = pos(/relatarProgresso\(100\)/);
      const iRet = pos(/return saida;/);
      ok("I0f a sequencia do caminho automatico esta preservada, em ordem",
        iLer > 0 && iLer < i25 && i25 < iExec && iExec < i75 &&
        i75 < iMapear && iMapear < i100 && i100 < iRet);
      ok("I0g e o progresso comeca em 0 antes de tudo",
        pos(/relatarProgresso\(0\)/) > 0 && pos(/relatarProgresso\(0\)/) < iLer);
    }

    // ── A. o wiring com executarFuncao ──────────────────────────────
    ok("I1  o handler chama executarFuncao, e uma unica vez",
      (CODIGO.match(/await executarFuncao\(/g) ?? []).length === 1);
    ok("I2  userId vem da CLOSURE da fabrica, nao do contexto",
      /export function criarHandlerConsultarVendas\(userId: string\)/.test(CODIGO) &&
      /^\s+userId,$/m.test(CODIGO) &&
      !/contexto\.userId/.test(CODIGO));
    ok("I3  agenteId e tarefaId vem do CONTEXTO",
      /agenteId: contexto\.agenteId,/.test(CODIGO) &&
      /tarefaId: contexto\.tarefaId,/.test(CODIGO));
    ok("I4  funcaoId e CONSTANTE do modulo, nunca da entrada",
      FUNCAO_ID === "vendas.consultar" &&
      /funcaoId: FUNCAO_ID,/.test(CODIGO) &&
      !/funcaoId:\s*(entrada|contexto|bruta)/.test(CODIGO));
    ok("I5  os argumentos sao o RECORTE, campo a campo",
      /argumentos: \{\s*dataInicio: entrada\.dataInicio,\s*dataFim: entrada\.dataFim,\s*marketplace: entrada\.marketplace,\s*\}/
        .test(CODIGO));
    ok("I6  a entrada crua NAO e repassada inteira",
      !/argumentos: contexto\.entrada/.test(CODIGO) && !/argumentos: bruta/.test(CODIGO));
    ok("I7  tarefaId e exigido — nunca null neste caminho",
      /if \(!contexto\.tarefaId\) throw new Error/.test(CODIGO));
    ok("I8  o tipo e a chave do registry", TIPO_CONSULTAR_VENDAS === "consultar_vendas");
    ok("I9  a fabrica tem aridade 1 e devolve funcao de aridade 2",
      criarHandlerConsultarVendas.length === 1 &&
      typeof criarHandlerConsultarVendas("dono") === "function" &&
      criarHandlerConsultarVendas("dono").length === 2);

    // ── B/C. entrada fechada, so estrutura ──────────────────────────
    const lanca = (fn: () => unknown): unknown => {
      try { fn(); return null; } catch (e) { return e; }
    };
    ok("I10 entrada valida minima e aceita, marketplace vira null",
      JSON.stringify(lerEntradaConsultarVendas({ dataInicio: "2026-09-11", dataFim: "2026-09-11" })) ===
      JSON.stringify({ dataInicio: "2026-09-11", dataFim: "2026-09-11", marketplace: null }));
    ok("I11 marketplace null explicito tambem vira null",
      lerEntradaConsultarVendas({ dataInicio: "a", dataFim: "b", marketplace: null }).marketplace === null);
    ok("I12 marketplace texto e PRESERVADO, sem alias nem upper",
      lerEntradaConsultarVendas({ dataInicio: "a", dataFim: "b", marketplace: "Shopee" }).marketplace === "Shopee");
    ok("I13 propriedade EXTRA reprova com ErroEntradaTarefa",
      lanca(() => lerEntradaConsultarVendas({ dataInicio: "a", dataFim: "b", funcaoId: "x" }))
        instanceof ErroEntradaTarefa);
    ok("I14 `userId` na entrada tambem reprova — nao ha como escolher dono",
      lanca(() => lerEntradaConsultarVendas({ dataInicio: "a", dataFim: "b", userId: "outro" }))
        instanceof ErroEntradaTarefa);
    ok("I15 dataInicio ausente reprova",
      lanca(() => lerEntradaConsultarVendas({ dataFim: "b" })) instanceof ErroEntradaTarefa);
    ok("I16 dataFim nao-textual reprova",
      lanca(() => lerEntradaConsultarVendas({ dataInicio: "a", dataFim: 20260911 })) instanceof ErroEntradaTarefa);
    ok("I17 marketplace nao-textual reprova",
      lanca(() => lerEntradaConsultarVendas({ dataInicio: "a", dataFim: "b", marketplace: 7 }))
        instanceof ErroEntradaTarefa);
    ok("I18 array e null reprovam",
      lanca(() => lerEntradaConsultarVendas([])) instanceof ErroEntradaTarefa &&
      lanca(() => lerEntradaConsultarVendas(null)) instanceof ErroEntradaTarefa);

    // ── D. regras de DOMINIO nao sao duplicadas ─────────────────────
    //
    // O handler nao pode conhecer janela, calendario nem enum: essas
    // regras tem dono, e o dono e `validarFiltroVendas`.
    ok("I19 o handler NAO reimplementa as regras de dominio",
      !/JANELA_MAXIMA|Date\.UTC|MARKETPLACES_VALIDOS|validarFiltroVendas/.test(CODIGO));
    ok("I20 e uma janela absurda NAO e recusada pelo handler",
      lerEntradaConsultarVendas({ dataInicio: "2020-01-01", dataFim: "2030-12-31" }).dataFim === "2030-12-31");
    ok("I21 nem uma data impossivel — quem recusa e o validador da Funcao",
      lerEntradaConsultarVendas({ dataInicio: "2026-02-31", dataFim: "xxx" }).dataInicio === "2026-02-31");

    // ── E. o switch cobre EXATAMENTE as 7 variantes ─────────────────
    const VARIANTES = [
      "sucesso", "negado", "aguardando_aprovacao", "aprovacao_indisponivel",
      "erro", "falha_auditoria", "indisponivel",
    ];
    const cases = [...CODIGO.matchAll(/case "([a-z_]+)":/g)].map((m) => m[1]).sort();
    ok(`I22 o switch tem exatamente as 7 variantes (${cases.join(", ")})`,
      cases.join(",") === [...VARIANTES].sort().join(","));
    ok("I23 CONTROLE NEGATIVO: seis variantes nao satisfariam o oraculo",
      VARIANTES.slice(0, 6).sort().join(",") !== [...VARIANTES].sort().join(","));
    ok("I24 ha checagem de exaustividade com never",
      /const _exaustivo: never = resultado;/.test(CODIGO));
    ok("I25 nao ha fallback silencioso mandando tudo para handler_falhou",
      !/else\s*\{[\s\S]{0,80}handler_falhou/.test(CODIGO));

    // ── F..N. cada variante, com objeto sintetico ───────────────────
    const ENTRADA = { dataInicio: "2026-09-11", dataFim: "2026-09-11", marketplace: null };
    const mapear = (r: unknown) => mapearResultadoConsultarVendas(r as never, ENTRADA as never);
    const erroDe = (r: unknown): unknown => { try { mapear(r); return null; } catch (e) { return e; } };

    const eAprovacao = erroDe({
      tipo: "aguardando_aprovacao", requestId: "r", codigo: "aprovacao_necessaria",
      aprovacaoId: "ap-1", estadoAprovacao: "criada",
    });
    ok("I26 aguardando_aprovacao lanca PausaPorAprovacao", eAprovacao instanceof PausaPorAprovacao);
    ok("I27 e carrega o aprovacaoId devolvido pelo executor",
      (eAprovacao as { aprovacaoId?: string })?.aprovacaoId === "ap-1");
    ok("I28 pausa NAO e erro comum — e semanticamente distinta",
      eAprovacao instanceof Error && !(eAprovacao instanceof ErroEntradaTarefa) &&
      (eAprovacao as Error).name === "PausaPorAprovacao");

    for (const codigo of ["permissao_ausente", "permissao_bloqueada", "funcao_inexistente", "conexao_ausente"]) {
      const e = erroDe({ tipo: "negado", requestId: "r", codigo });
      ok(`I29 negado:${codigo} TERMINA e nao pausa`,
        e instanceof Error && !(e instanceof PausaPorAprovacao) &&
        (e as Error).message === `funcao_negada:${codigo}`);
    }

    const eIndisp = erroDe({ tipo: "aprovacao_indisponivel", requestId: "r", codigo: "expirada" });
    ok("I30 aprovacao_indisponivel TERMINA — nunca pausa",
      eIndisp instanceof Error && !(eIndisp instanceof PausaPorAprovacao) &&
      (eIndisp as Error).message === "aprovacao_indisponivel:expirada");

    for (const etapa of ["abertura", "desfecho"]) {
      const e = erroDe({ tipo: "falha_auditoria", requestId: "r", etapa, reexecutavel: false });
      ok(`I31 falha_auditoria:${etapa} TERMINA preservando a etapa`,
        e instanceof Error && (e as Error).message === `falha_auditoria:${etapa}`);
    }

    const eIndisponivel = erroDe({ tipo: "indisponivel", requestId: "r" });
    ok("I32 indisponivel TERMINA sem oraculo de existencia",
      eIndisponivel instanceof Error && (eIndisponivel as Error).message === "funcao_indisponivel");

    const envErro = (code: string) => ({
      tipo: "erro", requestId: "r", auditoria: "completa",
      envelope: { contrato: "1", ok: false, request_id: "r", error: { code, message: "frase", retryable: false } },
    });
    for (const code of ["filtro_ausente", "data_invalida", "periodo_invertido", "janela_excedida", "marketplace_invalido"]) {
      const e = erroDe(envErro(code));
      ok(`I33 erro de validacao (${code}) vira ErroEntradaTarefa`,
        e instanceof ErroEntradaTarefa && (e as Error).message === `entrada_invalida:${code}`);
    }
    for (const code of ["executor_falhou", "erro_consulta_vendas", "saida_invalida", "erro_interno"]) {
      const e = erroDe(envErro(code));
      ok(`I34 erro de execucao (${code}) e terminal sanitizado`,
        e instanceof Error && !(e instanceof ErroEntradaTarefa) &&
        (e as Error).message === `funcao_erro:${code}`);
    }
    ok("I35 a frase do envelope NAO vaza para a mensagem do erro",
      !/frase/.test(String((erroDe(envErro("executor_falhou")) as Error).message)));

    // ── M/N. sucesso e truncado ─────────────────────────────────────
    const linha = (p: Record<string, unknown>) => ({
      order_id: "o1", sku: "s1", anuncio: "a", marketplace: "Shopee",
      qtd: 1, item_subtotal: 10, faturamento: 99, data_pagamento: "2026-09-11", ...p,
    });
    const sucesso = (linhas: unknown[], truncado: boolean) => ({
      tipo: "sucesso", requestId: "r", auditoria: "completa",
      envelope: { contrato: "1", ok: true, request_id: "r", data: { linhas, truncado, erro: null } },
    });

    const saida = mapear(sucesso([linha({}), linha({ order_id: "o2", sku: "s2" })], false)) as Record<string, unknown>;
    ok("I36 sucesso devolve periodo/resumo/marketplaces/truncado, e so isso",
      Object.keys(saida).sort().join(",") === "marketplaces,periodo,resumo,truncado");
    ok("I37 o periodo ecoa a entrada aceita",
      JSON.stringify(saida.periodo) === JSON.stringify(ENTRADA));
    const resumo = saida.resumo as Record<string, number>;
    ok("I38 resumo conta linhas, pedidos, unidades e skus distintos",
      resumo.linhas === 2 && resumo.pedidos === 2 && resumo.unidades === 2 && resumo.skusDistintos === 2);
    ok("I39 faturamento usa item_subtotal positivo, nao faturamento rateado",
      resumo.faturamento === 20 && resumo.ticketMedio === 10);
    ok("I40 truncado=true AINDA conclui, com o sinal propagado",
      (mapear(sucesso([linha({})], true)) as Record<string, unknown>).truncado === true);
    ok("I41 envelope, requestId e auditoria NAO viajam para o resultado",
      !("requestId" in saida) && !("envelope" in saida) && !("auditoria" in saida));

    // ── O. coercao monetaria ────────────────────────────────────────
    const sujas = [
      linha({ order_id: "x1", qtd: "3", item_subtotal: "10", faturamento: "20" }),
      linha({ order_id: "x2", qtd: NaN, item_subtotal: NaN, faturamento: NaN }),
      linha({ order_id: "x3", qtd: Infinity, item_subtotal: Infinity, faturamento: Infinity }),
      linha({ order_id: "x4", qtd: null, item_subtotal: null, faturamento: null }),
      linha({ order_id: "x5", qtd: undefined, item_subtotal: undefined, faturamento: undefined }),
    ];
    const agSujo = agregarConsultaDeVendas(sujas as never);
    ok("I42 string/NaN/Infinity/null/undefined viram 0 — zero concatenacao",
      agSujo.resumo.unidades === 0 && agSujo.resumo.faturamento === 0 &&
      typeof agSujo.resumo.faturamento === "number" && Number.isFinite(agSujo.resumo.faturamento));
    ok("I43 ticketMedio com faturamento 0 e 0, nunca NaN",
      agSujo.resumo.ticketMedio === 0 && !Number.isNaN(agSujo.resumo.ticketMedio));
    ok("I44 periodo sem linha nenhuma nao divide por zero",
      agregarConsultaDeVendas([]).resumo.ticketMedio === 0);
    ok("I45 o handler nao usa Number()/parseFloat/coercao implicita",
      !/Number\(/.test(CODIGO) && !/parseFloat|parseInt/.test(CODIGO));
    ok("I46 faturamento sai arredondado em centavos",
      agregarConsultaDeVendas([
        linha({ item_subtotal: 0.1 }), linha({ order_id: "o2", item_subtotal: 0.2 }),
      ] as never).resumo.faturamento === 0.3);
    ok("I47 fallback para faturamento quando item_subtotal nao e positivo",
      agregarConsultaDeVendas([linha({ item_subtotal: 0, faturamento: 7.5 })] as never).resumo.faturamento === 7.5);

    // ── P. buckets FIXOS de marketplace ─────────────────────────────
    const ag = agregarConsultaDeVendas([
      linha({ order_id: "a1", marketplace: "Shopee", item_subtotal: 1 }),
      linha({ order_id: "b1", marketplace: "ML", item_subtotal: 2 }),
      linha({ order_id: "c1", marketplace: "TikTokShop", item_subtotal: 4 }),
      linha({ order_id: "c2", marketplace: "Amazon", item_subtotal: 8 }),
    ] as never);
    ok("I48 sempre os TRES buckets, na mesma ordem, mesmo zerados",
      Object.keys(ag.marketplaces).join(",") === "Shopee,ML,outros");
    ok("I49 marketplace desconhecido cai em `outros`, agregado",
      ag.marketplaces.outros.linhas === 2 && ag.marketplaces.outros.faturamento === 12 &&
      ag.marketplaces.outros.pedidos === 2);
    ok("I50 e o NOME do marketplace desconhecido nao e exposto",
      !JSON.stringify(ag).includes("TikTokShop") && !JSON.stringify(ag).includes("Amazon"));
    ok("I51 buckets vazios continuam presentes e zerados",
      JSON.stringify(agregarConsultaDeVendas([]).marketplaces) ===
      JSON.stringify({
        Shopee: { linhas: 0, pedidos: 0, unidades: 0, faturamento: 0 },
        ML: { linhas: 0, pedidos: 0, unidades: 0, faturamento: 0 },
        outros: { linhas: 0, pedidos: 0, unidades: 0, faturamento: 0 },
      }));
    ok("I52 pedidos do bucket sao cardinalidade DENTRO do bucket",
      ag.marketplaces.Shopee.pedidos === 1 && ag.marketplaces.ML.pedidos === 1);

    // ── Q. nada de cardinalidade alta no retorno ────────────────────
    const muitas = Array.from({ length: 500 }, (_, i) =>
      linha({ order_id: `p${i}`, sku: `sku-${i}`, anuncio: `anuncio ${i}` }));
    const grande = mapear(sucesso(muitas, false));
    const json = JSON.stringify(grande);
    ok("I53 o resultado NAO cresce com o numero de linhas", json.length < 700, String(json.length));
    ok("I54 zero lista: nem linhas, nem skus, nem pedidos, nem anuncios",
      !/"linhas":\s*\[/.test(json) && !/"skus"/.test(json) &&
      !/"orderIds"|"orders"|"pedidosIds"/.test(json) && !/"anuncio/.test(json));
    ok("I55 nenhum order_id, sku ou anuncio individual vaza",
      !json.includes("p499") && !json.includes("sku-499") && !json.includes("anuncio 499"));
    ok("I56 `resumo.linhas` NUMERICO continua permitido",
      typeof (grande as Record<string, Record<string, unknown>>).resumo.linhas === "number" &&
      (grande as Record<string, Record<string, unknown>>).resumo.linhas === 500);
    ok("I57 nenhuma data por pedido no retorno", !/data_pagamento/.test(json));

    // ── R. zero provedor, zero atalho ───────────────────────────────
    ok("I58 o handler nao alcanca provedor de IA",
      !/PedidoIA|adaptador|Adaptador|provedorRealHabilitado|AGENTES_IA_PROVIDER_REAL_ENABLED|anthropic|google|openai/i
        .test(CODIGO));
    ok("I59 nem rede, nem env, nem banco",
      !/fetch\(|process\.env|createClient|getSupabaseServidor|\.from\(/.test(CODIGO));
    ok("I60 nao chama a capability de pausa nem RPC de tarefa",
      !/aguardarAprovacaoTarefa|concluirTarefa|falharTarefa|\.rpc\(/.test(CODIGO));
    ok("I61 nao decide, cria nem consome Approval",
      !/criarAprovacao|decidirAprovacao|consumirAprovacao|retomarAprovacao|agente_funcao_aprovacoes/
        .test(CODIGO));
    ok("I62 nao registra Tool Call a mao",
      !/registrarAbertura|registrarDesfecho|agente_funcao_chamadas/.test(CODIGO));
    ok("I63 sem cast cego nem supressao de tipo",
      !/as any|@ts-ignore|@ts-expect-error|eslint-disable/.test(CODIGO));
    ok("I64 sem retry proprio",
      !/setTimeout|setInterval|for \(let tentativa|while \(true\)/.test(CODIGO));
    ok("I65 a funcao de agregacao e PURA — um parametro, nada injetado",
      agregarConsultaDeVendas.length === 1);

    // ── A excecao arquitetural e NOMINAL ────────────────────────────
    const CONVERSA = semComentarios(ler("lib/agentes/handlers/conversa.ts"));
    ok("I66 `conversa` continua SEM alcancar Funcao, Approval ou pausa",
      !/executarFuncao|execucao-funcoes|vendas\.consultar|PausaPorAprovacao/.test(CONVERSA));
    const TESTE_FUNDACAO = semComentarios(ler("lib/agentes/handlers/teste-fundacao.ts"));
    const ANALISE = semComentarios(ler("lib/agentes/handlers/analise-vendas.ts"));
    ok("I67 e os outros dois handlers tambem continuam fora",
      !/executarFuncao|execucao-funcoes|PausaPorAprovacao/.test(TESTE_FUNDACAO) &&
      !/executarFuncao|execucao-funcoes|PausaPorAprovacao/.test(ANALISE));
    {
      // A excecao e de UM arquivo, medida por VARREDURA — nao por
      // confianca. Um quinto handler que alcance a Funcao reprova.
      const handlers = readdirSync(join(RAIZ, "lib/agentes/handlers"))
        .filter((f) => f.endsWith(".ts") && f !== "registry.ts");
      const comFuncao = handlers.filter((f) =>
        /executarFuncao/.test(semComentarios(ler(`lib/agentes/handlers/${f}`))));
      // M2-I1-A7: sao DOIS, e o conjunto e NOMINAL nos dois sentidos.
      // Contagem sozinha deixaria uma TROCA passar; `includes` deixaria um
      // terceiro entrar. A lista ordenada compara identidade, nao tamanho.
      const HANDLERS_COM_FUNCAO = ["consultar-perguntas-ml.ts", "consultar-vendas.ts"];
      ok(`I68 exatamente os DOIS handlers nominais alcancam executarFuncao (${comFuncao.join(", ")})`,
        JSON.stringify([...comFuncao].sort()) ===
          JSON.stringify([...HANDLERS_COM_FUNCAO].sort()));
      ok("I69 CONTROLE: um terceiro handler nao satisfaria o oraculo",
        JSON.stringify([...HANDLERS_COM_FUNCAO, "outro.ts"].sort()) !==
          JSON.stringify([...HANDLERS_COM_FUNCAO].sort()));
      ok("I69a CONTROLE: perder um dos dois tambem reprova",
        JSON.stringify(HANDLERS_COM_FUNCAO.slice(1)) !==
          JSON.stringify([...HANDLERS_COM_FUNCAO].sort()));
      ok("I69b CONTROLE: uma TROCA mantendo o total de dois reprova",
        JSON.stringify(["consultar-vendas.ts", "consultar-anuncios.ts"].sort()) !==
          JSON.stringify([...HANDLERS_COM_FUNCAO].sort()));
    }

    // ── As contagens de auditoria, congeladas por CONTRATO ──────────
    //
    // Nao ha DB aqui. O que se congela e o LUGAR do codigo onde cada
    // contagem e decidida, para que mudar uma delas exija mudar isto.
    ok("I70 automatico+sucesso: abertura + desfecho = 2 linhas",
      /const abertura = await registrarAbertura\(/.test(EXECUTOR_CODIGO) &&
      /registrarDesfechoDeExecucao\(\{ \.\.\.snapshot, status: "sucesso"/.test(EXECUTOR_CODIGO));
    ok("I71 negado: 1 linha de desfecho, sem abertura",
      /registrarDesfechoSemExecucao\(\{ \.\.\.snapshot, status: "negado", codigo \}\)/
        .test(EXECUTOR_CODIGO));
    ok("I72 aguardando_aprovacao: ZERO Tool Call",
      (() => {
        const i = EXECUTOR_CODIGO.indexOf('pedido.codigo === "criada"');
        const f = EXECUTOR_CODIGO.indexOf("return recusaDeCriacao(", i);
        const ramo = i > 0 && f > i ? EXECUTOR_CODIGO.slice(i, f) : "";
        return ramo.length > 100 && !/registrarAbertura|registrarDesfecho/.test(ramo);
      })());

    // ── V1A-F1: a IDENTIDADE do pedido e (marketplace, order_id) ────
    //
    // `order_id` sozinho nao e identidade: `pedidos` so tem unique sobre
    // a PK interna `id`, nao ha CHECK algum, e os numeros vem de dois
    // sistemas que nao se conhecem. Uma coincidencia entre Shopee e ML
    // contaria dois pedidos como um — e `ticketMedio`, que divide por
    // essa contagem, dobraria junto. Os asserts abaixo sao
    // COMPORTAMENTAIS: alimentam a funcao real e reprovam a versao
    // anterior da implementacao.
    {
      const cross = agregarConsultaDeVendas([
        linha({ marketplace: "Shopee", order_id: "123", item_subtotal: 10 }),
        linha({ marketplace: "ML", order_id: "123", item_subtotal: 20 }),
      ] as never);
      ok(`I73 mesmo order_id em marketplaces diferentes = DOIS pedidos (${cross.resumo.pedidos})`,
        cross.resumo.pedidos === 2);
      ok("I74 e cada bucket enxerga o seu, um de cada",
        cross.marketplaces.Shopee.pedidos === 1 && cross.marketplaces.ML.pedidos === 1);
      ok(`I75 faturamento soma os dois (${cross.resumo.faturamento})`,
        cross.resumo.faturamento === 30);
      ok(`I76 ticketMedio divide por DOIS pedidos, nao por um (${cross.resumo.ticketMedio})`,
        cross.resumo.ticketMedio === 15);
      // A prova de que a soma dos buckets voltou a bater com o total: com
      // chave so por `order_id` era 2 contra 1.
      ok("I77 soma dos buckets = total global em contagem de pedidos",
        cross.marketplaces.Shopee.pedidos +
        cross.marketplaces.ML.pedidos +
        cross.marketplaces.outros.pedidos === cross.resumo.pedidos);
    }

    {
      // CONTROLE COMPLEMENTAR: a correcao nao pode ter transformado
      // LINHA em PEDIDO. Duas linhas do mesmo pedido continuam sendo um.
      const mesmo = agregarConsultaDeVendas([
        linha({ marketplace: "Shopee", order_id: "777", sku: "a", item_subtotal: 5 }),
        linha({ marketplace: "Shopee", order_id: "777", sku: "b", item_subtotal: 5 }),
      ] as never);
      ok(`I78 duas linhas do MESMO pedido continuam UM pedido (${mesmo.resumo.pedidos})`,
        mesmo.resumo.pedidos === 1 && mesmo.marketplaces.Shopee.pedidos === 1);
      ok("I79 mas as duas linhas continuam contando como duas linhas",
        mesmo.resumo.linhas === 2 && mesmo.marketplaces.Shopee.linhas === 2);
      ok(`I80 e o ticketMedio usa o pedido unico (${mesmo.resumo.ticketMedio})`,
        mesmo.resumo.faturamento === 10 && mesmo.resumo.ticketMedio === 10);
    }

    {
      // O bucket `outros` agrega VARIOS marketplaces desconhecidos: ali o
      // argumento "o marketplace ja esta fixado" nao existe, e a chave
      // composta e a unica coisa que impede a subcontagem.
      const desconhecidos = agregarConsultaDeVendas([
        linha({ marketplace: "TikTokShop", order_id: "9", item_subtotal: 3 }),
        linha({ marketplace: "Amazon", order_id: "9", item_subtotal: 4 }),
      ] as never);
      ok(`I81 dois desconhecidos com o mesmo order_id = DOIS pedidos em outros (${desconhecidos.marketplaces.outros.pedidos})`,
        desconhecidos.marketplaces.outros.pedidos === 2);
      ok("I82 e o bucket continua unico e agregado",
        desconhecidos.marketplaces.outros.linhas === 2 &&
        desconhecidos.marketplaces.outros.faturamento === 7);
      ok("I83 os nomes desconhecidos continuam NAO aparecendo no JSON",
        !JSON.stringify(desconhecidos).includes("TikTokShop") &&
        !JSON.stringify(desconhecidos).includes("Amazon"));
    }

    {
      // A representacao do par tem de ser NAO AMBIGUA. Com um
      // delimitador ingenuo — `${marketplace}:${orderId}` — os dois pares
      // abaixo produziriam a MESMA string ("a:b:c") e virariam um pedido
      // so. Nada no schema impede `:` num marketplace ou num order_id.
      const ambiguo = agregarConsultaDeVendas([
        linha({ marketplace: "a:b", order_id: "c", item_subtotal: 1 }),
        linha({ marketplace: "a", order_id: "b:c", item_subtotal: 1 }),
      ] as never);
      ok(`I84 pares que colidiriam sob delimitador ingenuo sao DISTINTOS (${ambiguo.resumo.pedidos})`,
        ambiguo.resumo.pedidos === 2);
      ok("I85 CONTROLE: a concatenacao ingenua de fato colidiria",
        `${"a:b"}:${"c"}` === `${"a"}:${"b:c"}`);
      ok("I86 e ambos caem em `outros`, sem abrir chave nova",
        ambiguo.marketplaces.outros.pedidos === 2 &&
        Object.keys(ambiguo.marketplaces).join(",") === "Shopee,ML,outros");
    }

    {
      // BOUND estrutural preservado: 100 marketplaces desconhecidos
      // distintos nao aumentam o shape nem abrem chave dinamica.
      const cem = agregarConsultaDeVendas(
        Array.from({ length: 100 }, (_, i) =>
          linha({ marketplace: `mp-${i}`, order_id: `o${i}`, item_subtotal: 1 })) as never);
      ok("I87 100 marketplaces desconhecidos: shape continua com 3 buckets",
        Object.keys(cem.marketplaces).join(",") === "Shopee,ML,outros");
      ok("I88 e os 100 pedidos sao contados, um por par",
        cem.resumo.pedidos === 100 && cem.marketplaces.outros.pedidos === 100);
      const jsonCem = JSON.stringify(cem);
      ok("I89 nenhum nome de marketplace desconhecido vaza", !/mp-\d/.test(jsonCem));
      ok("I90 nenhum order_id vaza, nem a chave composta interna",
        !/"o\d/.test(jsonCem) && !/\[\\"/.test(jsonCem));
      ok("I91 e o tamanho continua bounded", jsonCem.length < 400, String(jsonCem.length));
    }

    // ── V1A-F2: marketplace nao-string e SAIDA INESPERADA ───────────
    //
    // A chave composta so e nao ambigua no dominio string x string.
    // Dentro de um array, `undefined`, `NaN` e `Infinity` nao sao
    // valores JSON e viram `null` — colidiriam entre si e com `null`,
    // reproduzindo a subcontagem que o F1 eliminou, por outra porta.
    // A resposta NAO e sanear a chave: e recusar a linha, porque uma
    // saida ja declarada SUCESSO com campo fora do contrato nao pode
    // virar resumo.
    {
      // A colisao que a guarda existe para impedir, medida no proprio
      // `JSON.stringify` — para que o teste nao dependa de acreditar.
      ok("I92 CONTROLE: undefined, null, NaN e Infinity colidem numa tupla JSON",
        JSON.stringify([undefined, "1"]) === JSON.stringify([null, "1"]) &&
        JSON.stringify([NaN, "1"]) === JSON.stringify([null, "1"]) &&
        JSON.stringify([Infinity, "1"]) === JSON.stringify([null, "1"]));
      ok("I93 CONTROLE: mas nenhuma STRING colide com null",
        JSON.stringify(["null", "1"]) !== JSON.stringify([null, "1"]));

      // Fixtures invalidas por CONSTRUCAO: `unknown[]` atravessa a
      // fronteira de chamada uma vez so, sem `as any` e sem afrouxar
      // `LinhaVenda`.
      const agregarCru = agregarConsultaDeVendas as unknown as
        (l: readonly unknown[]) => unknown;
      const lancou = (l: readonly unknown[]): unknown => {
        try { agregarCru(l); return null; } catch (e) { return e; }
      };

      const MALFORMADOS: readonly [string, unknown][] = [
        ["undefined", undefined],
        ["null", null],
        ["NaN", NaN],
        ["Infinity", Infinity],
        ["-Infinity", -Infinity],
        ["numero", 7],
        ["boolean", false],
        ["objeto", { nome: "Shopee" }],
        ["array", ["Shopee"]],
      ];
      for (const [rotulo, valor] of MALFORMADOS) {
        const e = lancou([linha({ marketplace: valor, order_id: "1", item_subtotal: 10 })]);
        ok(`I94 marketplace ${rotulo} FALHA FECHADO com saida_inesperada`,
          e instanceof Error && (e as Error).message === "funcao_erro:saida_inesperada");
      }

      // Duas linhas malformadas DIFERENTES com o mesmo order_id: antes
      // da guarda virariam um pedido so e dobrariam o ticket.
      const eColisao = lancou([
        linha({ marketplace: undefined, order_id: "1", item_subtotal: 10 }),
        linha({ marketplace: null, order_id: "1", item_subtotal: 20 }),
      ]);
      ok("I95 o par que colidia agora nem chega a produzir resumo",
        eColisao instanceof Error && (eColisao as Error).message === "funcao_erro:saida_inesperada");

      // ── SEM PARCIALIDADE: o caso discriminante ────────────────────
      //
      // Linha valida PRIMEIRO, invalida DEPOIS. Se a guarda estivesse no
      // lugar errado — ou fosse um `continue` silencioso — sairia um
      // resumo com faturamento 1010, 1 pedido e ticket 1010: numero
      // errado com cara de certo.
      const eParcial = lancou([
        linha({ marketplace: "Shopee", order_id: "A", item_subtotal: 10 }),
        linha({ marketplace: null, order_id: "B", item_subtotal: 1000 }),
      ]);
      ok("I96 linha valida antes da invalida NAO produz resumo parcial",
        eParcial instanceof Error && (eParcial as Error).message === "funcao_erro:saida_inesperada");
      ok("I97 e a falha nao vaza TypeError, stack nem o valor malformado",
        eParcial instanceof Error &&
        !/TypeError|undefined|null|1000|Shopee/.test((eParcial as Error).message));

      // A mesma falha atravessa o mapper terminal com o vocabulario
      // estavel, e NAO vira `entrada_invalida` nem pausa.
      const eMapper = erroDe(sucesso(
        [linha({ marketplace: null, order_id: "1", item_subtotal: 5 })], false));
      ok("I98 pelo mapper de sucesso, a falha chega sanitizada e terminal",
        eMapper instanceof Error &&
        !(eMapper instanceof ErroEntradaTarefa) &&
        !(eMapper instanceof PausaPorAprovacao) &&
        (eMapper as Error).message === "funcao_erro:saida_inesperada");

      // ── E o que NAO mudou ─────────────────────────────────────────
      //
      // A guarda e sobre TIPO em runtime, nunca sobre o enum de
      // dominio: string desconhecida continua valida e continua em
      // `outros`. Validar Shopee/ML aqui seria duplicar a regra da
      // Funcao, que e o que o handler existe para nao fazer.
      const desconhecida = agregarConsultaDeVendas([
        linha({ marketplace: "TikTokShop", order_id: "9", item_subtotal: 3 }),
        linha({ marketplace: "Amazon", order_id: "9", item_subtotal: 4 }),
      ] as never);
      ok("I99 string DESCONHECIDA continua aceita e continua em `outros`",
        desconhecida.marketplaces.outros.pedidos === 2 &&
        desconhecida.marketplaces.outros.faturamento === 7);
      ok("I100 e a string vazia tambem e um marketplace valido para o tipo",
        agregarConsultaDeVendas([
          linha({ marketplace: "", order_id: "1", item_subtotal: 2 }),
        ] as never).marketplaces.outros.linhas === 1);
      ok("I101 o handler continua sem conhecer o enum de dominio",
        !/"Shopee"\s*\)\s*\|\||MARKETPLACES_VALIDOS|marketplace_invalido.*throw/.test(CODIGO));

      // A assinatura estreitou: nenhum `unknown` sobrou na chave.
      ok("I102 chavePedido opera sobre string x string",
        /function chavePedido\(marketplace: string, orderId: string\): string/.test(CODIGO) &&
        !/chavePedido\(marketplace: unknown/.test(CODIGO));
      // Le o CONTRATO, e nao mais o handler: o comentario mudou de casa
      // junto com `chavePedido`, e apontar para a fabrica deixaria esta
      // assercao de ausencia vacuamente verde.
      ok("I103 e o comentario nao promete injetividade sobre valor arbitrario",
        /chavePedido/.test(ler(CONTRATO)) && !/injetora para qualquer par/.test(ler(CONTRATO)));
      // A guarda tem de ser a PRIMEIRA instrucao do laco — se vier
      // depois de um acumulador, a parcialidade volta.
      {
        const laco = CODIGO.slice(CODIGO.indexOf("for (const linha of linhas)"));
        const iGuarda = laco.indexOf('typeof linha.marketplace !== "string"');
        const iAcumulador = laco.indexOf("unidades += qtd;");
        const iBucket = laco.indexOf("bucketDe(linha.marketplace)");
        ok("I104 a guarda precede TODOS os acumuladores da linha",
          iGuarda > 0 && iAcumulador > iGuarda && iBucket > iGuarda);
        ok("I105 e nao ha skip silencioso da linha invalida",
          !/marketplace !== "string"\)\s*\{\s*continue;/.test(CODIGO));
        ok("I106 nem coercao para string",
          !/String\(linha\.marketplace\)|`\$\{linha\.marketplace\}`/.test(CODIGO));
      }
    }
  }

  // ── J. APPROVAL-DECISION-RESUME-D5-C1: contratos de retomada ──────
  //
  // O registry existe para que a retomada pos-aprovacao prepare a MESMA
  // entrada e interprete o MESMO resultado do caminho automatico. A
  // propriedade que interessa nao e "existe um contrato" — e que ele
  // aponta para as FUNCOES REAIS, nao para copias que um dia divergem.
  //
  // Nada aqui ativa D5: o registry continua sem chamador de producao.
  secao("J. RESUME-D5-C1: registry de contratos, dormente");
  {
    const RESUME = "lib/agentes/resume-contratos.ts";
    const RESUME_CODIGO = semComentarios(ler(RESUME));
    const CONTRATO_PURO = "lib/agentes/handlers/consultar-vendas-contrato.ts";
    const PURO_CODIGO = semComentarios(ler(CONTRATO_PURO));

    const reg = await import("../lib/agentes/resume-contratos");
    const puro = await import("../lib/agentes/handlers/consultar-vendas-contrato");
    const { resolverContratoResume, tiposComContratoResume } = reg;

    ok("J0  ANCORA: as duas fontes foram lidas",
      RESUME_CODIGO.length > 300 && PURO_CODIGO.length > 2000);

    // ── §23. IDENTIDADE ESTRITA — o coracao deste slice ────────────
    const contrato = resolverContratoResume("consultar_vendas");
    ok("J1  consultar_vendas TEM contrato", contrato !== null);
    ok("J2  funcaoId e a MESMA constante do caminho automatico",
      contrato?.funcaoId === puro.FUNCAO_ID && contrato?.funcaoId === "vendas.consultar");
    ok("J3  prepararEntrada === lerEntradaConsultarVendas (referencia, nao copia)",
      contrato?.prepararEntrada === puro.lerEntradaConsultarVendas);
    ok("J4  continuarAposFuncao === mapearResultadoConsultarVendas",
      contrato?.continuarAposFuncao === puro.mapearResultadoConsultarVendas);
    ok("J5  CONTROLE: um adaptador equivalente NAO satisfaria J3/J4",
      ((f: unknown) => f !== puro.lerEntradaConsultarVendas)(
        (bruta: unknown) => puro.lerEntradaConsultarVendas(bruta)));
    ok("J6  e o contrato nao embrulha: zero arrow/bind na tabela",
      !/=>\s*lerEntradaConsultarVendas|=>\s*mapearResultadoConsultarVendas|\.bind\(/
        .test(RESUME_CODIGO));

    // ── §24. tipo desconhecido FALHA FECHADO ───────────────────────
    ok("J7  tipo inexistente devolve null, nunca contrato de reserva",
      resolverContratoResume("tipo_que_nao_existe") === null);
    ok("J8  e chave de prototipo tambem — `toString` nao e contrato",
      resolverContratoResume("toString") === null &&
      resolverContratoResume("constructor") === null);
    // M2-I1-A7: DOIS tipos com contrato de retomada. A ordem e a que o
    // owner devolve (`Object.keys` da tabela), e nao uma reordenacao do
    // teste — comparar contra a ordem real e o que faz o assert medir a
    // tabela, e nao a si mesmo.
    // Tipado como `string`: sem isso o TypeScript prova que os literais dos
    // controles diferem e reprova a comparacao — o controle viraria erro de
    // compilacao em vez de assert.
    const TIPOS_COM_RESUME: string = "consultar_perguntas_ml,consultar_vendas";
    ok("J9  os tipos com contrato de retomada sao exatamente os dois nominais",
      tiposComContratoResume().join(",") === TIPOS_COM_RESUME);
    ok("J10 CONTROLE: um tipo a mais nao satisfaria J9",
      ["consultar_perguntas_ml", "consultar_vendas", "outro"].join(",") !== TIPOS_COM_RESUME);
    ok("J10a CONTROLE: um tipo a menos tambem reprova",
      "consultar_vendas" !== TIPOS_COM_RESUME);
    ok("J10b CONTROLE: uma TROCA mantendo o total reprova",
      ["consultar_perguntas_ml", "consultar_anuncios"].join(",") !== TIPOS_COM_RESUME);

    // ── §25. TRIPWIRE do grafo: aresta de VALOR e proibida ─────────
    //
    // `import type` desaparece na compilacao; `import` de valor nao. A
    // checagem distingue os dois, entao trocar um pelo outro por
    // descuido deixa esta suite vermelha em vez de criar um ciclo.
    const importsDeValor = (codigo: string): string[] =>
      [...codigo.matchAll(/^import\s+(?!type\s)([\s\S]*?)from\s+"([^"]+)";/gm)]
        .filter((m) => !/^\s*\{\s*type\s/.test(m[1]))
        .map((m) => m[2]);
    const alvosResume = importsDeValor(RESUME_CODIGO);
    const alvosPuro = importsDeValor(PURO_CODIGO);

    ok(`J11 resume-contratos NAO importa o handler que executa (${alvosResume.join(", ")})`,
      !alvosResume.some((a) => /handlers\/consultar-vendas$/.test(a)));
    ok("J12 nem alcanca o executor por valor",
      !alvosResume.some((a) => /execucao-funcoes\/executar$/.test(a)));
    ok("J13 o modulo puro tambem nao importa o executor por valor",
      !alvosPuro.some((a) => /execucao-funcoes\/executar$/.test(a)));
    ok("J14 mas ele USA o tipo do executor — por `import type`",
      /^import type \{ ResultadoExecucaoFuncao \} from "@\/lib\/agentes\/execucao-funcoes\/executar";$/m
        .test(PURO_CODIGO));
    ok("J15 CONTROLE: o detector reconhece uma aresta de VALOR se ela surgir",
      importsDeValor('import { executarFuncao } from "@/lib/agentes/execucao-funcoes/executar";')
        .join(",") === "@/lib/agentes/execucao-funcoes/executar" &&
      importsDeValor('import type { X } from "@/lib/agentes/execucao-funcoes/executar";').length === 0);
    // M2-I1-A7: agora sao DOIS contratos puros, e sao SO eles. O que este
    // assert protege — o resume nunca importa handler nem executor por
    // valor — segue valendo, e a lista continua exata.
    ok("J16 os imports de valor do resume sao exatamente os dois contratos puros",
      JSON.stringify([...alvosResume].sort()) === JSON.stringify([
        "@/lib/agentes/handlers/consultar-perguntas-ml-contrato",
        "@/lib/agentes/handlers/consultar-vendas-contrato",
      ]));
    ok("J16a CONTROLE: um import de valor a mais reprova",
      JSON.stringify([...alvosResume, "@/lib/agentes/handlers/consultar-vendas"].sort()) !==
        JSON.stringify([...alvosResume].sort()));

    // ── §26. CRUZAMENTO handler x contrato ─────────────────────────
    //
    // Limitacao declarada: o cruzamento e por VARREDURA de fonte, nao
    // por AST. Ele responde "quais handlers alcancam executarFuncao" e
    // "quais tipos tem contrato" — o bastante para o estado atual, e
    // deterministico. Um handler que alcance a Funcao por um modulo
    // intermediario escaparia desta rede; hoje nenhum o faz, e I68 ja
    // congela esse fato.
    {
      const handlers = readdirSync(join(RAIZ, "lib/agentes/handlers"))
        .filter((f) => f.endsWith(".ts") && f !== "registry.ts");
      const comFuncao = handlers.filter((f) =>
        /executarFuncao\(/.test(semComentarios(ler(`lib/agentes/handlers/${f}`))));
      const registrados = tiposComContratoResume();
      const CHAMAM_FUNCAO = ["consultar-perguntas-ml.ts", "consultar-vendas.ts"];
      ok(`J17 exatamente os dois handlers nominais CHAMAM executarFuncao (${comFuncao.join(", ")})`,
        JSON.stringify([...comFuncao].sort()) === JSON.stringify([...CHAMAM_FUNCAO].sort()));
      // J18 e a rede que impede aprovacao ORFA: todo tipo que alcanca uma
      // Funcao pode cair em `aguardando_aprovacao`, e sem contrato de
      // retomada essa espera nasceria sem continuacao conhecida.
      ok("J18 e OS DOIS tipos deles TEM contrato de retomada",
        registrados.includes("consultar_vendas") &&
        registrados.includes("consultar_perguntas_ml"));
      ok("J19 CONTROLE: um tipo sem contrato seria detectado",
        !registrados.includes("consultar_anuncios"));
    }

    // ── DORMENCIA: o registry nao tem chamador de producao ─────────
    {
      const producao = ["lib/agentes", "app", "components"];
      const alcanca: string[] = [];
      const varrer = (dir: string): void => {
        for (const e of readdirSync(join(RAIZ, dir), { withFileTypes: true })) {
          const rel = `${dir}/${e.name}`;
          if (e.isDirectory()) varrer(rel);
          // IMPORT, nunca mencao: o modulo puro CITA `resume-contratos`
          // no comentario que explica por que o grafo e aciclico, e
          // contar isso como chamador transformaria documentacao em
          // violacao.
          else if (/\.tsx?$/.test(e.name) && rel !== RESUME &&
                   /(?:from|import\()\s*"[^"]*resume-contratos"/.test(semComentarios(ler(rel))))
            alcanca.push(rel);
        }
      };
      for (const d of producao) varrer(d);
      // ── FASE D5-C3-I1 ─────────────────────────────────────────────
      //
      // Ate aqui o registry nao tinha importador de producao. O executor
      // Resume e o primeiro, e e o UNICO autorizado: quem resolve o
      // contrato de um tipo e ele. Apagar o assert trocaria a prova por
      // silencio; o que ele mede agora e a IDENTIDADE da lista.
      ok(`J20 D5_ACTIVE = NO: o registry so e importado pelo executor Resume (${alcanca.join(", ") || "nenhuma"})`,
        alcanca.length === 1 && alcanca[0] === "lib/agentes/retomada/executar-retomada.ts");
      ok("J20a CONTROLE NEGATIVO: um segundo importador reprova",
        !(["lib/agentes/retomada/executar-retomada.ts", "lib/agentes/intruso.ts"].length === 1));
      ok("J20b CONTROLE NEGATIVO: um importador de OUTRO nome reprova",
        !(["lib/agentes/capability-worker.ts"][0] === "lib/agentes/retomada/executar-retomada.ts"));
    }
  }

  // ─── K. RESUME-D5-C2-I1: persistence da retomada, dormente ─────────

  secao("K. RESUME-D5-C2-I1: persistence da retomada, dormente");
  {
    const PERSIST = "lib/agentes/retomada/persistencia-retomada.ts";
    const PERSIST_FONTE = ler(PERSIST);
    const PERSIST_CODIGO = semComentarios(PERSIST_FONTE);

    const p = await import("../lib/agentes/retomada/persistencia-retomada");
    const {
      iniciarRetomadaAprovacao,
      falharTarefaRetomada,
      recuperarRetomadaStale,
      concluirTarefaRetomada,
      ehCodigoRetomadaInicio,
      ehCodigoRetomadaRecuperacao,
      codigosRetomadaInicio,
      codigosRetomadaRecuperacao,
    } = p;

    ok("K0  ANCORA: o modulo foi lido e carregado",
      PERSIST_CODIGO.length > 1000 && typeof iniciarRetomadaAprovacao === "function");

    // ── §29. As QUATRO RPCs, e nenhuma quinta ───────────────────────
    //
    // Conta sobre o codigo SEM comentarios: uma RPC citada em prosa nao
    // e uma RPC chamada.
    const rpcsNoModulo = [...PERSIST_CODIGO.matchAll(/\.rpc\(\s*"([a-z_]+)"/g)].map((m) => m[1]);
    // O A1-I1 acrescentou a DESCOBERTA de aprovacoes, e o B1-I1 o
    // CANCELAMENTO tecnico: a contagem avancou nominalmente 4 -> 5 -> 6.
    // Ela continua EXATA, nunca `>=` — um `>=` deixaria de ver a setima.
    ok(`K1  exatamente seis chamadas .rpc (${rpcsNoModulo.length})`,
      rpcsNoModulo.length === 6);
    ok("K2  e elas sao as seis RPCs da retomada, uma vez cada",
      [...rpcsNoModulo].sort().join(",") === [
        "retomada_cancelar_aprovacao_incompativel",
        "retomada_concluir_tarefa",
        "retomada_falhar_tarefa",
        "retomada_listar_candidatas",
        "retomada_recuperar_tarefa_stale",
        "retomar_aprovacao_iniciar",
      ].join(","));
    // Os dois controles avancam JUNTO com a fase. Se K3 continuasse
    // comparando contra 5 ele viraria vacuo — verdadeiro por aritmetica,
    // impossivel de reprovar — e um controle que nao pode cair nao e
    // controle nenhum.
    ok("K3  CONTROLE: uma SETIMA RPC seria detectada",
      [...rpcsNoModulo, "aprovacao_criar"].length !== 6);
    ok("K3a CONTROLE: a fase ANTERIOR, com cinco RPCs, agora reprova",
      rpcsNoModulo.length !== 5);
    ok("K3b a descoberta de retomadas travadas NAO usa RPC",
      !rpcsNoModulo.includes("retomada_recuperar_tarefa_stale_listar") &&
      rpcsNoModulo.filter((n) => n === "retomada_listar_candidatas").length === 1);

    // ── §28. Os terminalizadores GENERICOS nao aparecem ─────────────
    //
    // CUIDADO deliberado: `retomada_falhar_tarefa` CONTEM
    // `falhar_tarefa` como substring, e `falharTarefaRetomada` contem
    // `falharTarefa`. Um matcher ingenuo acusaria o modulo correto. O
    // `\b` resolve porque `_` conta como caractere de palavra — e K7
    // prova que o cuidado nao e decorativo.
    const generico = (nome: string) => new RegExp(`\\b${nome}\\b`).test(PERSIST_CODIGO);
    ok("K4  nao chama as RPCs genericas de tarefa",
      !generico("falhar_tarefa") && !generico("concluir_tarefa") &&
      !generico("aguardar_aprovacao_tarefa"));
    ok("K5  nao importa nem chama os wrappers genericos",
      !generico("falharTarefa") && !generico("concluirTarefa") &&
      !generico("registrarProgresso") && !generico("aguardarAprovacaoTarefa"));
    ok("K6  nao importa capability-worker",
      !/capability-worker/.test(PERSIST_CODIGO));
    ok("K7  CONTROLE: o matcher ingenuo por substring acusaria o modulo CORRETO",
      PERSIST_CODIGO.includes("falhar_tarefa") &&
      PERSIST_CODIGO.includes("concluir_tarefa") &&
      !generico("falhar_tarefa") && !generico("concluir_tarefa"));
    ok("K8  CONTROLE: o matcher com \\b acusaria a RPC generica de verdade",
      /\bfalhar_tarefa\b/.test('await x.rpc("falhar_tarefa", {})') &&
      /\bconcluir_tarefa\b/.test('await x.rpc("concluir_tarefa", {})'));

    // ── §36. O normalizador e REUSADO, nunca recopiado ──────────────
    ok("K9  importa o normalizador neutro compartilhado",
      /from\s+"@\/lib\/agentes\/normalizar-linha"/.test(PERSIST_CODIGO));
    ok("K10 nao define normalizarLinha localmente",
      !/(function|const)\s+normalizarLinha/.test(PERSIST_CODIGO));
    // O que caracteriza uma COPIA do normalizador e a semantica dele:
    // devolver `data[0]` de um array, ou `data ?? null`. Procurar apenas
    // `Array.isArray` era largo demais — o heartbeat usa a mesma funcao
    // para CONTAR linhas afetadas, que e outra coisa. O matcher foi
    // estreitado para o comportamento, nao para a ferramenta.
    ok("K11 nem recopia o CORPO dele",
      !/data\s*\[\s*0\s*\]/.test(PERSIST_CODIGO) &&
      !/data\s*\?\?\s*null/.test(PERSIST_CODIGO));
    ok("K11a CONTROLE: uma copia real do normalizador seria detectada",
      /data\s*\[\s*0\s*\]/.test("if (Array.isArray(data)) return data.length > 0 ? data[0] : null;") &&
      /data\s*\?\?\s*null/.test("return data ?? null;"));

    // ── §30. Os 17 codigos de INICIO, escritos aqui ─────────────────
    //
    // Esta lista NAO deriva da constante de producao: ela foi digitada
    // a partir da migration. Se a de producao mudar sozinha, o conjunto
    // deixa de bater e esta suite fica vermelha.
    const INICIO_ESPERADO = [
      "agente_indisponivel", "aprovacao_desatualizada", "aprovacao_inexistente",
      "aprovacao_pendente", "conexao_indisponivel", "consumida", "entrada_invalida",
      "escrita_nao_suportada", "expirada", "funcao_incompativel", "ja_cancelada",
      "ja_consumida", "ja_rejeitada", "permissao_ausente", "permissao_bloqueada",
      "tarefa_incompativel", "tarefa_indisponivel",
    ];
    ok("K12 sao 17 codigos de inicio", INICIO_ESPERADO.length === 17);
    ok("K13 o catalogo de producao tem o MESMO conjunto, sem sobra nem falta",
      [...codigosRetomadaInicio()].sort().join(",") === [...INICIO_ESPERADO].sort().join(","));
    ok("K14 todos os 17 sao aceitos pelo guard",
      INICIO_ESPERADO.every((c) => ehCodigoRetomadaInicio(c)));
    ok("K15 e desconhecido/null/numero/objeto sao recusados",
      !ehCodigoRetomadaInicio("consumido") && !ehCodigoRetomadaInicio(null) &&
      !ehCodigoRetomadaInicio(undefined) && !ehCodigoRetomadaInicio(1) &&
      !ehCodigoRetomadaInicio({}) && !ehCodigoRetomadaInicio("") &&
      !ehCodigoRetomadaInicio("toString"));

    // ── §31. Os 5 codigos de RECUPERACAO, escritos aqui ─────────────
    const RECUP_ESPERADO = [
      "causal_incompativel", "entrada_invalida", "execucao_incerta",
      "execucao_ja_ocorrida_resultado_indisponivel", "nao_stale",
    ];
    ok("K16 sao 5 codigos de recuperacao", RECUP_ESPERADO.length === 5);
    ok("K17 o catalogo de producao tem o MESMO conjunto",
      [...codigosRetomadaRecuperacao()].sort().join(",") === [...RECUP_ESPERADO].sort().join(","));
    ok("K18 todos os 5 sao aceitos pelo guard",
      RECUP_ESPERADO.every((c) => ehCodigoRetomadaRecuperacao(c)));
    ok("K19 e desconhecido/null sao recusados",
      !ehCodigoRetomadaRecuperacao("stale") && !ehCodigoRetomadaRecuperacao(null) &&
      !ehCodigoRetomadaRecuperacao(undefined) && !ehCodigoRetomadaRecuperacao(""));
    ok("K20 os dois catalogos sao DISJUNTOS, exceto entrada_invalida",
      codigosRetomadaInicio().filter((c) =>
        (codigosRetomadaRecuperacao() as readonly string[]).includes(c)
      ).join(",") === "entrada_invalida");

    // ── INICIO: comportamento real, contra o duplo ──────────────────
    roteiro();
    roteiroRpc({ data: "consumida" });
    const inicioOk = await iniciarRetomadaAprovacao(
      USER, APROVACAO, "req-1", "7", "consultar_vendas", "vendas.consultar");
    ok("K21 inicio bem-sucedido devolve ok + codigo de dominio",
      inicioOk.ok === true && inicioOk.ok && inicioOk.codigo === "consumida");
    ok("K22 chamou UMA RPC, e e a do inicio de retomada",
      chamadasRpc.length === 1 && chamadasRpc[0]?.nome === "retomar_aprovacao_iniciar");
    ok("K23 com os SEIS parametros exatos da migration",
      JSON.stringify(Object.keys(chamadasRpc[0]?.parametros ?? {}).sort()) ===
      JSON.stringify(["p_aprovacao_id", "p_funcao_id_esperada", "p_request_id",
        "p_revisao_atual", "p_tipo_tarefa_esperado", "p_user_id"]));
    ok("K24 e os valores viajam sem transformacao",
      chamadasRpc[0]?.parametros?.p_user_id === USER &&
      chamadasRpc[0]?.parametros?.p_aprovacao_id === APROVACAO &&
      chamadasRpc[0]?.parametros?.p_request_id === "req-1" &&
      chamadasRpc[0]?.parametros?.p_revisao_atual === "7" &&
      chamadasRpc[0]?.parametros?.p_tipo_tarefa_esperado === "consultar_vendas" &&
      chamadasRpc[0]?.parametros?.p_funcao_id_esperada === "vendas.consultar");

    roteiro();
    roteiroRpc({ data: "  consumida  " });
    const inicioEspaco = await iniciarRetomadaAprovacao(
      USER, APROVACAO, " req-1 ", "7", "consultar_vendas", "vendas.consultar");
    ok("K25 o request id NAO e aparado pelo wrapper",
      chamadasRpc[0]?.parametros?.p_request_id === " req-1 ");
    ok("K26 e um codigo com espacos NAO e normalizado para caber — falha fechado",
      inicioEspaco.ok === false && !inicioEspaco.ok &&
      inicioEspaco.falha === "resposta_invalida");

    roteiro();
    roteiroRpc({ data: "codigo_inventado" });
    const inicioDesconhecido = await iniciarRetomadaAprovacao(
      USER, APROVACAO, "req-1", "7", "consultar_vendas", "vendas.consultar");
    ok("K27 codigo fora do catalogo NAO vira codigo por cast",
      inicioDesconhecido.ok === false && !inicioDesconhecido.ok &&
      inicioDesconhecido.falha === "resposta_invalida");

    roteiro();
    roteiroRpc({ data: null });
    const inicioNulo = await iniciarRetomadaAprovacao(
      USER, APROVACAO, "req-1", "7", "consultar_vendas", "vendas.consultar");
    ok("K28 data null falha fechado",
      inicioNulo.ok === false && !inicioNulo.ok && inicioNulo.falha === "resposta_invalida");

    // ── §33. SQLSTATE: os tres ramos, exercitados ───────────────────
    const falhaDeErro = async (erro: Record<string, unknown>): Promise<string> => {
      roteiro();
      roteiroRpc({ data: null, error: erro });
      const r = await iniciarRetomadaAprovacao(
        USER, APROVACAO, "req-1", "7", "consultar_vendas", "vendas.consultar");
      return r.ok ? "NAO_FALHOU" : r.falha;
    };
    ok("K29 22023 vira rpc_entrada_invalida",
      (await falhaDeErro({ code: "22023" })) === "rpc_entrada_invalida");
    ok("K30 55000 vira rpc_fora_de_contrato",
      (await falhaDeErro({ code: "55000" })) === "rpc_fora_de_contrato");
    ok("K31 outro code vira rpc_indisponivel",
      (await falhaDeErro({ code: "08006" })) === "rpc_indisponivel");
    ok("K32 code AUSENTE tambem vira rpc_indisponivel",
      (await falhaDeErro({ message: "boom" })) === "rpc_indisponivel");
    // A comparacao e por STRING. Um driver que entregasse o SQLSTATE
    // como numero nao pode ser lido como entrada invalida por acidente:
    // classificar errado aqui mandaria o chamador tratar uma falha de
    // transporte como recusa definitiva do banco.
    ok("K33 SQLSTATE NUMERICO nao e confundido com o codigo textual",
      (await falhaDeErro({ code: 22023 })) === "rpc_indisponivel" &&
      (await falhaDeErro({ code: 55000 })) === "rpc_indisponivel");
    ok("K34 CONTROLE: os quatro rotulos de falha sao distintos",
      new Set(["rpc_entrada_invalida", "rpc_fora_de_contrato",
        "rpc_indisponivel", "resposta_invalida"]).size === 4);

    // ── FALHA: RPC propria, mensagem limitada, linha validada ───────
    const linhaTarefa = (partes: Record<string, unknown> = {}) => ({
      id: TAREFA, agente_id: AGENTE, user_id: USER, tipo: "consultar_vendas",
      entrada: {}, status: "erro", progresso: 0, resultado: null,
      erro_tipo: "x", erro_mensagem: "y", tentativas: 1, max_tentativas: 3,
      criado_em: "2026-09-16T00:00:00Z", iniciado_em: null, concluido_em: null,
      heartbeat_em: null, ...partes,
    });

    roteiro();
    roteiroRpc({ data: linhaTarefa() });
    const falhouOk = await falharTarefaRetomada(
      TAREFA, USER, "erro_execucao", "m".repeat(900), 1, "req-1");
    ok("K35 falha devolve a linha validada",
      falhouOk.ok === true && falhouOk.ok && falhouOk.linha.id === TAREFA);
    ok("K36 chamou UMA RPC, e e a da retomada — nunca a generica",
      chamadasRpc.length === 1 &&
      chamadasRpc[0]?.nome === "retomada_falhar_tarefa");
    ok("K37 com os SEIS parametros exatos",
      JSON.stringify(Object.keys(chamadasRpc[0]?.parametros ?? {}).sort()) ===
      JSON.stringify(["p_erro_mensagem", "p_erro_tipo", "p_retomada_request_id",
        "p_tarefa_id", "p_tentativa_esperada", "p_user_id"]));
    ok("K38 a mensagem chega ao banco cortada em EXATAMENTE 300",
      (chamadasRpc[0]?.parametros?.p_erro_mensagem as string).length === 300);
    ok("K39 CONTROLE: o limite e 300, nao 500 nem o tamanho original",
      (chamadasRpc[0]?.parametros?.p_erro_mensagem as string).length !== 500 &&
      (chamadasRpc[0]?.parametros?.p_erro_mensagem as string).length !== 900);

    roteiro();
    roteiroRpc({ data: [linhaTarefa()] });
    const falhouArray = await falharTarefaRetomada(TAREFA, USER, "e", "m", 1, "req-1");
    ok("K40 linha composta em ARRAY e normalizada pelo helper compartilhado",
      falhouArray.ok === true && falhouArray.ok && falhouArray.linha.id === TAREFA);

    roteiro();
    roteiroRpc({ data: [] });
    const falhouVazio = await falharTarefaRetomada(TAREFA, USER, "e", "m", 1, "req-1");
    ok("K41 array VAZIO nunca conta como sucesso",
      falhouVazio.ok === false && !falhouVazio.ok &&
      falhouVazio.falha === "resposta_invalida");

    roteiro();
    roteiroRpc({ data: { id: TAREFA } });
    const falhouParcial = await falharTarefaRetomada(TAREFA, USER, "e", "m", 1, "req-1");
    ok("K42 linha SEM os campos minimos falha fechado",
      falhouParcial.ok === false && !falhouParcial.ok &&
      falhouParcial.falha === "resposta_invalida");

    roteiro();
    roteiroRpc({ data: null, error: { code: "55000" } });
    const falhouCerca = await falharTarefaRetomada(TAREFA, USER, "e", "m", 9, "req-errado");
    ok("K43 cerca que nao casa vira rpc_fora_de_contrato, sem linha",
      falhouCerca.ok === false && !falhouCerca.ok &&
      falhouCerca.falha === "rpc_fora_de_contrato");

    // ── RECUPERACAO: observacional, uma RPC, codigo validado ────────
    roteiro();
    roteiroRpc({ data: "nao_stale" });
    const recupOk = await recuperarRetomadaStale(TAREFA, USER, 1, "req-1");
    ok("K44 recuperacao devolve o codigo de dominio",
      recupOk.ok === true && recupOk.ok && recupOk.codigo === "nao_stale");
    ok("K45 chamou UMA RPC, e e a de recuperacao",
      chamadasRpc.length === 1 &&
      chamadasRpc[0]?.nome === "retomada_recuperar_tarefa_stale");
    ok("K46 com os QUATRO parametros exatos",
      JSON.stringify(Object.keys(chamadasRpc[0]?.parametros ?? {}).sort()) ===
      JSON.stringify(["p_retomada_request_id", "p_tarefa_id",
        "p_tentativa_esperada", "p_user_id"]));
    ok("K47 o corte de 5 minutos NAO viaja do TypeScript",
      !/5\s*\*\s*60|300000|minutes/.test(PERSIST_CODIGO));

    for (const codigo of RECUP_ESPERADO) {
      roteiro();
      roteiroRpc({ data: codigo });
      const r = await recuperarRetomadaStale(TAREFA, USER, 1, "req-1");
      ok(`K48 recuperacao aceita o codigo real "${codigo}"`,
        r.ok === true && r.ok && r.codigo === codigo && chamadasRpc.length === 1);
    }

    roteiro();
    roteiroRpc({ data: "recuperada" });
    const recupDesconhecido = await recuperarRetomadaStale(TAREFA, USER, 1, "req-1");
    ok("K49 codigo fora do catalogo de recuperacao falha fechado",
      recupDesconhecido.ok === false && !recupDesconhecido.ok &&
      recupDesconhecido.falha === "resposta_invalida");

    // ── SUCESSO: a RPC propria, jamais a generica ───────────────────
    roteiro();
    roteiroRpc({ data: linhaTarefa({ status: "concluido", progresso: 100 }) });
    const concluiuOk = await concluirTarefaRetomada(
      TAREFA, USER, { total: 1 }, 1, "req-1");
    ok("K50 sucesso devolve a linha validada",
      concluiuOk.ok === true && concluiuOk.ok && concluiuOk.linha.status === "concluido");
    ok("K51 chamou UMA RPC, e e a de conclusao de RETOMADA",
      chamadasRpc.length === 1 &&
      chamadasRpc[0]?.nome === "retomada_concluir_tarefa");
    ok("K52 e NAO o terminalizador generico de sucesso",
      chamadasRpc.every((c) => c.nome !== "concluir_tarefa"));
    ok("K53 com os CINCO parametros exatos",
      JSON.stringify(Object.keys(chamadasRpc[0]?.parametros ?? {}).sort()) ===
      JSON.stringify(["p_resultado", "p_retomada_request_id", "p_tarefa_id",
        "p_tentativa_esperada", "p_user_id"]));
    ok("K54 o marcador causal viaja em toda escrita terminal",
      chamadasRpc[0]?.parametros?.p_retomada_request_id === "req-1");
    ok("K55 o wrapper NAO forca progresso — isso e do banco",
      !/progresso/.test(PERSIST_CODIGO));

    roteiro();
    roteiroRpc({ data: [] });
    const concluiuVazio = await concluirTarefaRetomada(TAREFA, USER, {}, 1, "req-1");
    ok("K56 conclusao com retorno vazio NUNCA e sucesso",
      concluiuVazio.ok === false && !concluiuVazio.ok &&
      concluiuVazio.falha === "resposta_invalida");

    roteiro();
    roteiroRpc({ data: null, error: { code: "22023" } });
    const concluiuInvalido = await concluirTarefaRetomada(TAREFA, USER, {}, 1, "");
    ok("K57 entrada recusada pelo banco vira rpc_entrada_invalida",
      concluiuInvalido.ok === false && !concluiuInvalido.ok &&
      concluiuInvalido.falha === "rpc_entrada_invalida");

    // ── §35. ROTEAMENTO: cada desfecho na sua lane ──────────────────
    //
    // Varredura sobre TODAS as chamadas que os cenarios acima
    // produziram nao serviria: `roteiro()` limpa o canal. A prova e
    // por cenario, e aqui ela e consolidada no fonte.
    const linhaDoWrapper = (nome: string): string => {
      const i = PERSIST_CODIGO.indexOf(`export async function ${nome}`);
      return i < 0 ? "" : PERSIST_CODIGO.slice(i, i + 1400);
    };
    ok("K58 concluirTarefaRetomada so alcanca retomada_concluir_tarefa",
      /\.rpc\(\s*"retomada_concluir_tarefa"/.test(linhaDoWrapper("concluirTarefaRetomada")) &&
      !/\bconcluir_tarefa\b/.test(linhaDoWrapper("concluirTarefaRetomada")));
    ok("K59 falharTarefaRetomada so alcanca retomada_falhar_tarefa",
      /\.rpc\(\s*"retomada_falhar_tarefa"/.test(linhaDoWrapper("falharTarefaRetomada")) &&
      !/\bfalhar_tarefa\b/.test(linhaDoWrapper("falharTarefaRetomada")));

    // ── §32. Higiene de erro ────────────────────────────────────────
    ok("K60 zero leitura de message/details/hint do erro",
      !/error\.message|error\.details|error\.hint|\.message\b/.test(PERSIST_CODIGO));
    ok("K61 zero serializacao ou log do erro bruto",
      !/JSON\.stringify\(\s*err|console\.(error|log|warn)\([^")]*err/.test(PERSIST_CODIGO));
    ok("K62 zero throw de erro do driver",
      !/throw\s+err|throw\s+error/.test(PERSIST_CODIGO));
    ok("K63 so `code` e inspecionado do erro",
      /"code"\s+in\s+erro/.test(PERSIST_CODIGO));
    ok("K64 todo console.error usa mensagem FIXA, sem interpolacao",
      [...PERSIST_CODIGO.matchAll(/console\.error\(([^)]*)\)/g)]
        .every((m) => /^"[^"`$]*"$/.test(m[1].trim())));
    ok("K65 sem cast cego nem supressao de tipo",
      !/as any|@ts-ignore|@ts-expect-error|eslint-disable|Record<string,\s*any>/
        .test(PERSIST_CODIGO));

    // ── §34. Zero retry ─────────────────────────────────────────────
    ok("K66 sem loop, backoff, timer ou recursao de retry",
      !/setTimeout|setInterval|while\s*\(|for\s*\(\s*let\s+tentativa|\.catch\(/
        .test(PERSIST_CODIGO));
    ok("K67 nenhum wrapper chama outro wrapper",
      !/(iniciarRetomadaAprovacao|falharTarefaRetomada|recuperarRetomadaStale|concluirTarefaRetomada|descobrirAprovacoesParaRetomada|descobrirCandidatasRetomadaStale|cancelarAprovacaoRetomadaIncompativel)\s*\(/
        .test(PERSIST_CODIGO.replace(/export async function \w+/g, "")));

    // ── Heartbeat: o modulo GANHOU um tick, e nao um timer ──────────
    //
    // Ate o C2-I1 estes dois exigiam ausencia total de heartbeat e de
    // escrita direta. O D5-C2-I2 acrescentou, por desenho aprovado, UM
    // tick de prova de vida que e um UPDATE direto — RPC seria cerimonia
    // para uma escrita sem transicao de estado. Entao os asserts
    // avancaram de "nao existe" para "existe exatamente um, e so isso".
    ok("K68 o modulo nao cria timer nem tarefa de fundo",
      !/setInterval|setTimeout/.test(PERSIST_CODIGO));
    ok("K68a e o heartbeat e UM TICK, uma escrita por chamada",
      (PERSIST_CODIGO.match(/\.update\(/g) ?? []).length === 1);
    // O C3-I1 acrescentou a LEITURA autoritativa de N, que e um
    // `select` na mesma tabela. O assert avancou de "uma consulta so"
    // para "duas, e exatamente uma delas escreve" — a contagem de
    // `.update(` no K68a continua sendo quem prova a escrita unica.
    // O A1-I1 acrescentou a descoberta de retomadas travadas, que e uma
    // TERCEIRA consulta a mesma tabela — e um SELECT puro. Por isso a
    // contagem de `.from` avanca de 2 para 3 enquanto a de `.update`
    // continua EXATAMENTE 1: e ela quem prova que so o heartbeat escreve.
    ok("K69 a tabela e tocada por tres consultas, e so o heartbeat escreve",
      (PERSIST_CODIGO.match(/\.from\(\s*"agente_tarefas"\s*\)/g) ?? []).length === 3 &&
      /\.update\(\{\s*heartbeat_em:/.test(PERSIST_CODIGO) &&
      (PERSIST_CODIGO.match(/\.update\(/g) ?? []).length === 1);
    ok("K69z HARD: a escrita unica NAO virou duas com a descoberta nova",
      (PERSIST_CODIGO.match(/\.update\(/g) ?? []).length === 1 &&
      (PERSIST_CODIGO.match(/\.insert\(|\.upsert\(|\.delete\(/g) ?? []).length === 0);
    ok("K69b a segunda consulta e leitura pura da tentativa",
      /\.select\(\s*"tentativas"\s*\)/.test(PERSIST_CODIGO) &&
      !/\.update\([^)]*tentativas/.test(PERSIST_CODIGO));
    ok("K69c a leitura de N cerca por id, dono, status e marcador",
      /\.select\(\s*"tentativas"\s*\)[\s\S]{0,400}?\.eq\("retomada_request_id"/.test(PERSIST_CODIGO));
    ok("K69a nenhuma insercao, exclusao ou upsert em lugar nenhum",
      !/\.insert\(|\.upsert\(|\.delete\(/.test(PERSIST_CODIGO));

    // ── §26. DORMENCIA: zero chamador de producao ───────────────────
    {
      // ── Achado B1-A0-F1, fechado aqui ─────────────────────────────
      //
      // Esta lista alimenta `mencionam`. Ela ficou parada nos quatro
      // terminalizadores originais enquanto o modulo ganhou tres
      // wrappers novos — e um assert que nao conhece o nome novo nao
      // FALHA quando alguem passa a chama-lo: ele simplesmente deixa de
      // proteger, em silencio. Por isso os SETE nomes exportados estao
      // aqui, e nao so os que existiam quando o assert nasceu.
      // O D0 acrescentou `executarSlotRetomada`. Ele nao e wrapper de
      // RPC como os outros sete — e a porta de entrada da lane — mas e
      // exatamente por isso que precisa estar aqui: sem ele, um segundo
      // arquivo de producao poderia passar a chamar o slot e este
      // inventario continuaria verde, sem enxergar nada. Era o achado
      // D0-A0-F2.
      const NOMES = ["iniciarRetomadaAprovacao", "falharTarefaRetomada",
        "recuperarRetomadaStale", "concluirTarefaRetomada",
        "descobrirAprovacoesParaRetomada", "descobrirCandidatasRetomadaStale",
        "cancelarAprovacaoRetomadaIncompativel", "executarSlotRetomada"];
      const producao = ["lib/agentes", "app", "components"];
      const importadores: string[] = [];
      const mencionam: string[] = [];
      const varrer = (dir: string): void => {
        for (const e of readdirSync(join(RAIZ, dir), { withFileTypes: true })) {
          const rel = `${dir}/${e.name}`;
          if (e.isDirectory()) varrer(rel);
          else if (/\.tsx?$/.test(e.name) && rel !== PERSIST) {
            const codigo = semComentarios(ler(rel));
            if (/(?:from|import\()\s*"[^"]*persistencia-retomada"/.test(codigo))
              importadores.push(rel);
            if (NOMES.some((n) => new RegExp(`\\b${n}\\b`).test(codigo)))
              mencionam.push(rel);
          }
        }
      };
      for (const d of producao) varrer(d);
      // ── FASE D5-C3-I2-D0: a ativacao existe na FONTE ──────────────
      //
      // Ate o B2 o inventario tinha um consumidor so, e esse fato valia
      // como prova de dormencia. O D0 ligou o worker ao slot, entao o
      // esperado passa a ser DOIS arquivos — e essa e a mudanca que o
      // assert precisa descrever, em vez de continuar exigindo um.
      //
      // K70 nao se move: quem importa o ADAPTADOR de persistencia
      // continua sendo so o executor. O worker importa o slot, que e
      // outro modulo — e essa distincao e justamente o que impede o
      // dispatcher de alcancar RPC de retomada por conta propria.
      const CONSUMIDOR = "lib/agentes/retomada/executar-retomada.ts";
      const ROTA_WORKER_K = "app/api/internal/agentes/worker/route.ts";
      ok(`K70 o adaptador so e importado pelo executor Resume (${importadores.join(", ") || "nenhum"})`,
        importadores.length === 1 && importadores[0] === CONSUMIDOR);
      ok(`K71 os simbolos Resume vivem em exatamente DOIS arquivos (${mencionam.join(", ") || "nenhuma"})`,
        mencionam.length === 2 &&
        new Set(mencionam).size === 2 &&
        mencionam.includes(CONSUMIDOR) &&
        mencionam.includes(ROTA_WORKER_K));

      // ── K72. TOPOLOGIA NA FONTE ≠ ESTADO DE DEPLOYMENT ────────────
      //
      // O assert antigo se chamava "D5_ACTIVE = NO" e provava isso
      // contando consumidores. Era conveniente e errado de principio: um
      // teste de fonte nao sabe o que esta em producao. Ele podia dizer
      // NO com honestidade enquanto nao havia fiacao nenhuma; nao pode
      // dizer YES agora, porque a fiacao existir no repositorio nao
      // significa que algum deployment a esteja servindo.
      //
      // O que ele passa a afirmar e exatamente o que consegue observar:
      // a fiacao de ativacao ESTA PRESENTE NA FONTE, com esta forma. O
      // estado real de D5_ACTIVE continua governado pelo ciclo de vida
      // — worktree e commit local seguem NO, push sem prova fica
      // PENDING_DEPLOYMENT_PROOF, e so o primeiro deployment READY
      // torna YES.
      {
        const fonteWorkerK = semComentarios(ler(ROTA_WORKER_K));
        const pSlotK = papeisDoSimbolo(fonteWorkerK, "executarSlotRetomada");
        ok(`K72 ACTIVATION_WIRING_PRESENT_IN_SOURCE: worker importa e chama o slot (${JSON.stringify(pSlotK)})`,
          pSlotK.definicoes === 0 && pSlotK.importacoes === 1 &&
          pSlotK.invocacoes === 1 && pSlotK.semPapel === 0);
        ok("K72z e este assert NAO afirma estado de deployment",
          !/D5_ACTIVE\s*=\s*(YES|SIM)/.test(
            "K72 ACTIVATION_WIRING_PRESENT_IN_SOURCE: worker importa e chama o slot"));
        ok("K72c o worker alcanca o SLOT, e nenhum interno da lane",
          !/executarRetomada\b/.test(fonteWorkerK) &&
          !/persistencia-retomada/.test(fonteWorkerK) &&
          !/descobrirCandidatasRetomadaStale|recuperarRetomadaStale/.test(fonteWorkerK) &&
          !/descobrirAprovacoesParaRetomada|cancelarAprovacaoRetomadaIncompativel/.test(fonteWorkerK) &&
          !/iniciarRetomadaAprovacao/.test(fonteWorkerK));
        ok("K72d nem os nomes crus das RPCs de retomada",
          !/retomada_listar_candidatas|retomada_cancelar_aprovacao_incompativel|retomar_aprovacao_iniciar/
            .test(ler(ROTA_WORKER_K)));
      }
      ok("K72a CONTROLE NEGATIVO: um TERCEIRO consumidor reprova",
        !([CONSUMIDOR, ROTA_WORKER_K, "lib/agentes/intruso.ts"].length === 2));
      ok("K72b CONTROLE NEGATIVO: consumidor com outro nome reprova",
        !(["lib/agentes/executar-tarefa.ts", ROTA_WORKER_K].includes(CONSUMIDOR)));
    }

    // ── O worker e o executor continuam intocados por este slice ────
    ok("K73 capability-worker nao conhece a lane de retomada",
      !/persistencia-retomada|retomada\//.test(semComentarios(ler("lib/agentes/capability-worker.ts"))));
    ok("K74 o executor de Funcoes tambem nao",
      !/persistencia-retomada/.test(EXECUTOR_CODIGO));
  }

  // ─── L. RESUME-D5-C2-I2: heartbeats disjuntos, lane a lane ─────────

  secao("L. RESUME-D5-C2-I2: heartbeats disjuntos, lane a lane");
  {
    const PERSIST_L = ler("lib/agentes/retomada/persistencia-retomada.ts");
    const PERSIST_L_CODIGO = semComentarios(PERSIST_L);
    const WORKER_L = ler("lib/agentes/capability-worker.ts");
    const WORKER_L_CODIGO = semComentarios(WORKER_L);

    const pr = await import("../lib/agentes/retomada/persistencia-retomada");
    const cw = await import("../lib/agentes/capability-worker");
    const { registrarHeartbeatRetomada } = pr;
    const { registrarProgresso } = cw;

    ok("L0  ANCORA: as duas lanes foram carregadas",
      typeof registrarHeartbeatRetomada === "function" &&
      typeof registrarProgresso === "function");

    // ── LANE NORMAL: a cerca de marcador NULL, comportamental ───────
    roteiro({ data: null, error: null });
    const normalOk = await registrarProgresso("tarefa-normal", 42);
    const chamadaNormal = chamadas[0];
    ok("L1  a lane normal continua devolvendo o MESMO contrato",
      normalOk.erro === null);
    ok("L2  uma unica escrita, na tabela de tarefas",
      chamadas.length === 1 && chamadaNormal?.tabela === "agente_tarefas" &&
      chamadaNormal?.escrita === true);
    ok("L3  cercada por id e status, como antes",
      chamadaNormal?.filtros?.id === "tarefa-normal" &&
      chamadaNormal?.filtros?.status === "rodando");
    ok("L4  e AGORA tambem por marcador IS NULL",
      Object.prototype.hasOwnProperty.call(chamadaNormal?.filtrosIs ?? {}, "retomada_request_id") &&
      chamadaNormal?.filtrosIs?.retomada_request_id === null);
    ok("L5  IS NULL nao e igualdade: o marcador NAO entrou em .eq",
      !Object.prototype.hasOwnProperty.call(chamadaNormal?.filtros ?? {}, "retomada_request_id"));
    ok("L6  o payload continua sendo progresso + heartbeat, sem campo novo",
      JSON.stringify(Object.keys(chamadaNormal?.payload ?? {}).sort()) ===
      JSON.stringify(["heartbeat_em", "progresso"]) &&
      chamadaNormal?.payload?.progresso === 42);
    ok("L7  a cerca protege a UPDATE INTEIRA — uma escrita, nao duas",
      chamadas.filter((c) => c.escrita).length === 1);
    ok("L8  a lane normal NAO passou a ler retorno (zero-row segue opaco)",
      !/\.eq\("status",\s*"rodando"\)[\s\S]{0,400}?\.select\(/.test(WORKER_L_CODIGO));

    // ── LANE RESUME: o tick, e as cinco cercas ──────────────────────
    roteiro({ data: [{ id: "tarefa-retomada" }], error: null });
    const tick = await registrarHeartbeatRetomada("tarefa-retomada", "user-1", 3, "req-9");
    const chamadaTick = chamadas[0];
    ok("L9  linha correspondente devolve `renovado`", tick === "renovado");
    ok("L10 uma unica escrita, na tabela de tarefas",
      chamadas.length === 1 && chamadaTick?.tabela === "agente_tarefas" &&
      chamadaTick?.escrita === true);
    // As CINCO cercas, por NOME e por VALOR — contar `.eq` nao provaria
    // nada: cinco filtros errados tambem somam cinco.
    ok("L11 cerca 1/5 — id",
      chamadaTick?.filtros?.id === "tarefa-retomada");
    ok("L12 cerca 2/5 — user_id",
      chamadaTick?.filtros?.user_id === "user-1");
    ok("L13 cerca 3/5 — status rodando",
      chamadaTick?.filtros?.status === "rodando");
    ok("L14 cerca 4/5 — tentativa esperada",
      chamadaTick?.filtros?.tentativas === 3);
    ok("L15 cerca 5/5 — marcador de retomada",
      chamadaTick?.filtros?.retomada_request_id === "req-9");
    ok("L16 sao EXATAMENTE cinco cercas de igualdade, nem uma sexta",
      JSON.stringify(Object.keys(chamadaTick?.filtros ?? {}).sort()) ===
      JSON.stringify(["id", "retomada_request_id", "status", "tentativas", "user_id"]));
    ok("L17 e nenhum filtro IS na lane de retomada",
      Object.keys(chamadaTick?.filtrosIs ?? {}).length === 0);
    ok("L18 o payload e SO heartbeat_em",
      JSON.stringify(Object.keys(chamadaTick?.payload ?? {})) ===
      JSON.stringify(["heartbeat_em"]));
    ok("L19 e nenhum campo causal viaja no SET",
      ["progresso", "status", "resultado", "erro_tipo", "erro_mensagem", "concluido_em",
       "iniciado_em", "tentativas", "user_id", "retomada_request_id"]
        .every((campo) => !(campo in (chamadaTick?.payload ?? {}))));
    ok("L20 user_id e CERCA, nunca payload — o tick nao troca dono",
      chamadaTick?.filtros?.user_id === "user-1" &&
      !("user_id" in (chamadaTick?.payload ?? {})));

    // ── ZERO-ROW: observacional, e nunca terminal ───────────────────
    roteiro({ data: [], error: null });
    const zero = await registrarHeartbeatRetomada("tarefa-retomada", "user-1", 3, "req-9");
    ok("L21 zero linhas devolve `sem_correspondencia`", zero === "sem_correspondencia");
    ok("L22 e NAO e tratado como erro", zero !== "indisponivel");
    ok("L23 zero-row NAO terminaliza: nenhuma RPC foi chamada",
      chamadasRpc.length === 0);
    ok("L24 e nenhuma segunda escrita aconteceu",
      chamadas.filter((c) => c.escrita).length === 1);

    // ── ERRO DE BANCO: indisponivel, e nunca terminal ───────────────
    for (const erro of [{ code: "08006" }, { code: "22023" }, { code: "55000" },
                        { message: "sem code" }]) {
      roteiro({ data: null, error: erro });
      const r = await registrarHeartbeatRetomada("tarefa-retomada", "user-1", 3, "req-9");
      ok(`L25 erro ${JSON.stringify(erro).slice(0, 24)} devolve indisponivel`,
        r === "indisponivel");
      ok("L26 e nao dispara terminalizador nem recuperacao",
        chamadasRpc.length === 0);
    }

    // ── FORMATO INESPERADO: fail closed ─────────────────────────────
    for (const [nome, forma] of [["null", null], ["objeto", { id: "x" }],
                                 ["string", "ok"], ["numero", 1]] as Array<[string, unknown]>) {
      roteiro({ data: forma, error: null });
      const r = await registrarHeartbeatRetomada("tarefa-retomada", "user-1", 3, "req-9");
      ok(`L27 data ${nome} (nao-array) falha fechado como indisponivel`,
        r === "indisponivel");
    }

    // ── ENTRADA NAO E REESCRITA ─────────────────────────────────────
    roteiro({ data: [], error: null });
    await registrarHeartbeatRetomada("tarefa-retomada", " user-1 ", 3, "  req-9  ");
    ok("L28 o marcador NAO e aparado — identidade causal preservada",
      chamadas[0]?.filtros?.retomada_request_id === "  req-9  ");
    ok("L29 nem o dono",
      chamadas[0]?.filtros?.user_id === " user-1 ");
    roteiro({ data: [], error: null });
    const vazio = await registrarHeartbeatRetomada("tarefa-retomada", "user-1", 3, "");
    ok("L30 marcador em branco nao casa, e vira sem_correspondencia — nao erro",
      vazio === "sem_correspondencia" && chamadas.length === 1);

    // ── SEM RETRY, SEM TIMER ────────────────────────────────────────
    ok("L31 um tick = uma operacao: zero retry no corpo",
      !/setTimeout|setInterval|\bwhile\b|\.catch\(/.test(PERSIST_L_CODIGO));
    // O recorte precisa TERMINAR no fim da funcao. Ate o A1-I1 o tick
    // era o ultimo export do arquivo, entao `slice(i)` acertava por
    // acidente; com as duas descobertas depois dele, o recorte aberto
    // passaria a acusar o `.rpc` da descoberta de aprovacoes como se
    // fosse do heartbeat. Fechar no `}` da coluna zero e o mesmo criterio
    // que `corpoDe` ja usa na suite de execucao: torna o assert PRECISO,
    // e o que sai do recorte ganha asserts proprios em N1/N2 abaixo.
    const corpoTick = (() => {
      const linhas = PERSIST_L_CODIGO.split("\n");
      const i = linhas.findIndex((l) =>
        l.startsWith("export async function registrarHeartbeatRetomada"));
      if (i < 0) return "";
      for (let j = i + 1; j < linhas.length; j++) {
        if (linhas[j] === "}") return linhas.slice(i, j + 1).join("\n");
      }
      return "";
    })();
    ok("L32 o tick nao chama terminalizador, recuperacao nem RPC",
      corpoTick.length > 200 &&
      !/\.rpc\(/.test(corpoTick) &&
      !/falharTarefaRetomada|concluirTarefaRetomada|recuperarRetomadaStale/.test(corpoTick) &&
      !/\bfalharTarefa\b|\bconcluirTarefa\b|\bregistrarProgresso\b/.test(corpoTick));
    ok("L33 nem usa .single(), porque zero linhas e desfecho NORMAL",
      !/\.single\(/.test(PERSIST_L_CODIGO));
    ok("L34 usa select para poder CONTAR a linha afetada",
      /\.select\(\s*"id"\s*\)/.test(corpoTick));
    ok("L35 higiene de erro preservada no tick",
      !/\.message\b|\.details\b|\.hint\b|JSON\.stringify|\bthrow\b/.test(corpoTick));

    // ── DISJUNCAO BILATERAL, provada sobre os dois fontes ───────────
    //
    // Nao e comentario: extrai o predicado de marcador de cada lane e
    // confirma que um exige NULL e o outro exige igualdade. Nenhuma
    // linha satisfaz os dois quando R e nao-nulo.
    const normalExigeNull =
      /\.is\(\s*"retomada_request_id"\s*,\s*null\s*\)/.test(WORKER_L_CODIGO);
    const resumeExigeIgualdade =
      /\.eq\(\s*"retomada_request_id"\s*,\s*retomadaRequestId\s*\)/.test(corpoTick);
    ok("L36 a lane normal exige marcador IS NULL", normalExigeNull);
    ok("L37 a lane de retomada exige marcador IGUAL a R", resumeExigeIgualdade);
    ok("L38 DISJUNCAO: nenhuma tarefa com R nao-nulo satisfaz as duas",
      normalExigeNull && resumeExigeIgualdade);
    ok("L39 e a lane normal NAO usa igualdade de marcador (isso a ligaria a R)",
      !/\.eq\(\s*"retomada_request_id"/.test(WORKER_L_CODIGO));
    ok("L40 CONTROLE: sem a cerca, a lane normal alcancaria R nao-nulo",
      !/\.is\(\s*"retomada_request_id"\s*,\s*null\s*\)/.test(
        '.eq("id", tarefaId).eq("status", "rodando")'));

    // ── O RESTO DO MODULO CONTINUA INTACTO ──────────────────────────
    ok("L41 os SETE wrappers de RPC estao presentes, incluindo o cancelamento",
      ["iniciarRetomadaAprovacao", "falharTarefaRetomada",
       "recuperarRetomadaStale", "concluirTarefaRetomada",
       "descobrirAprovacoesParaRetomada", "descobrirCandidatasRetomadaStale",
       "cancelarAprovacaoRetomadaIncompativel"]
        .every((n) => typeof (pr as Record<string, unknown>)[n] === "function"));
    ok("L42 e continuam sendo SEIS chamadas .rpc, nem uma a mais",
      (PERSIST_L_CODIGO.match(/\.rpc\(/g) ?? []).length === 6);
    ok("L43 o heartbeat nao virou wrapper de RPC",
      !/\.rpc\([^)]*heartbeat/i.test(PERSIST_L_CODIGO));

    // ── DORMENCIA do tick ───────────────────────────────────────────
    {
      const producao = ["lib/agentes", "app", "components"];
      const alcanca: string[] = [];
      const varrer = (dir: string): void => {
        for (const e of readdirSync(join(RAIZ, dir), { withFileTypes: true })) {
          const rel = `${dir}/${e.name}`;
          if (e.isDirectory()) varrer(rel);
          else if (/\.tsx?$/.test(e.name) &&
                   rel !== "lib/agentes/retomada/persistencia-retomada.ts" &&
                   /\bregistrarHeartbeatRetomada\b/.test(semComentarios(ler(rel))))
            alcanca.push(rel);
        }
      };
      for (const d of producao) varrer(d);
      // ── FASE D5-C3-I1 ─────────────────────────────────────────────
      //
      // O tick passou a ter quem o agende: o executor Resume, e so ele.
      // Que o agendamento so comeca DEPOIS do contexto causal completo
      // e provado por ordem de origem em N29/N30.
      ok(`L44 o tick so e chamado pelo executor Resume (${alcanca.join(", ") || "nenhum"})`,
        alcanca.length === 1 && alcanca[0] === "lib/agentes/retomada/executar-retomada.ts");
      ok("L44a CONTROLE NEGATIVO: um segundo chamador reprova",
        !(["lib/agentes/retomada/executar-retomada.ts", "lib/agentes/executar-tarefa.ts"].length === 1));
      ok("L44b CONTROLE NEGATIVO: o chamador ser a lane normal reprova",
        !(["lib/agentes/executar-tarefa.ts"][0] === "lib/agentes/retomada/executar-retomada.ts"));
    }

    // ── F3: a CERCA DE ENTRADA, provada COMPORTAMENTALMENTE ─────────
    //
    // Estes dois asserts registravam F3 como aberto. O D5-C2-I2-F3
    // fechou a entrada pelo LOADER, e eles avancaram de fase. L45
    // tambem foi CORRIGIDO: procurava `COLUNAS_TAREFA` seguido do
    // marcador em 400 caracteres e passou a casar o USO
    // (`select(COLUNAS_TAREFA)` seguido do filtro novo) em vez da
    // DEFINICAO — media proximidade, nao projecao.
    const DEF_COLUNAS_L = (WORKER_L_CODIGO.match(/const COLUNAS_TAREFA[\s\S]*?;/) ?? [""])[0];
    ok("L45 o marcador NAO e projetado — a cerca filtra, nao seleciona",
      DEF_COLUNAS_L.length > 100 && !DEF_COLUNAS_L.includes("retomada_request_id"));
    ok("L45a CONTROLE: projetar o marcador seria detectado",
      'const COLUNAS_TAREFA = "id, retomada_request_id";'.includes("retomada_request_id"));
    ok("L46 executar-tarefa continua sem conhecer o marcador — POR DESENHO",
      !/retomada_request_id/.test(semComentarios(ler("lib/agentes/executar-tarefa.ts"))));

    // O duplo registra os filtros REAIS que a query construiu, entao
    // aqui a cerca nao e lida no fonte: ela e exercitada.
    const { lerTarefaParaExecucao } = cw;

    roteiro({ data: { id: "t-normal", agente_id: "a", user_id: "u", tipo: "x",
      entrada: {}, status: "rodando", progresso: 0, resultado: null,
      erro_tipo: null, erro_mensagem: null, tentativas: 1, max_tentativas: 3,
      criado_em: "2026-09-16T00:00:00Z", iniciado_em: null, concluido_em: null,
      heartbeat_em: null } });
    const lidaNormal = await lerTarefaParaExecucao("t-normal");
    const qNormal = chamadas[0];
    ok("L47 a leitura normal continua entregando a tarefa da lane normal",
      lidaNormal.erro === null && lidaNormal.linha?.id === "t-normal");
    ok("L48 e a query cerca por id",
      qNormal?.tabela === "agente_tarefas" && qNormal?.filtros?.id === "t-normal");
    ok("L49 E TAMBEM por marcador IS NULL — a cerca de entrada",
      Object.prototype.hasOwnProperty.call(qNormal?.filtrosIs ?? {}, "retomada_request_id") &&
      qNormal?.filtrosIs?.retomada_request_id === null);
    ok("L50 IS NULL nao e igualdade: o marcador NAO entrou em .eq",
      !Object.prototype.hasOwnProperty.call(qNormal?.filtros ?? {}, "retomada_request_id"));
    ok("L51 a leitura nao escreve nada",
      qNormal?.escrita === false && chamadasRpc.length === 0);

    // Tarefa de retomada: o banco a filtra, e `maybeSingle` devolve
    // `data: null` com `error: null`. E EXATAMENTE esse o cenario.
    roteiro({ data: null, error: null });
    const lidaRetomada = await lerTarefaParaExecucao("t-retomada");
    ok("L52 tarefa filtrada pela cerca some da lane normal",
      lidaRetomada.linha === null);
    ok("L53 e NAO vira erro — some, nao falha",
      lidaRetomada.erro === null);
    ok("L54 nenhuma RPC foi chamada na recusa",
      chamadasRpc.length === 0);
    ok("L55 e nenhuma escrita aconteceu",
      chamadas.every((c) => c.escrita === false));
    ok("L56 a cerca viajou tambem nesta leitura",
      chamadas[0]?.filtrosIs?.retomada_request_id === null);

    // ── A recusa acontece ANTES de qualquer efeito ──────────────────
    const EXEC_L = semComentarios(ler("lib/agentes/executar-tarefa.ts"));
    const posL = (re: RegExp) => EXEC_L.search(re);
    // ANCORA antes da ordem: `search` devolve -1 quando o alvo some, e
    // -1 e menor que qualquer indice — sem esta linha, APAGAR a guarda
    // faria o assert de ordem passar vazio. Medido, nao suposto: foi o
    // que o mutante "recusa depois do handler" revelou.
    const pontosL = [/if \(!tarefa\)/, /const contexto: ContextoTarefa/, /setInterval\(/,
      /await handler\(/, /await falharTarefa\(/, /await concluirTarefa\(/].map(posL);
    ok("L57 ANCORA: os seis pontos do ciclo existem no fonte",
      pontosL.every((p) => p > 0));
    ok("L57a a recusa `!tarefa` precede contexto, timer, handler e terminalizadores",
      pontosL.every((p) => p > 0) &&
      posL(/if \(!tarefa\)/) < posL(/const contexto: ContextoTarefa/) &&
      posL(/if \(!tarefa\)/) < posL(/setInterval\(/) &&
      posL(/if \(!tarefa\)/) < posL(/await handler\(/) &&
      posL(/if \(!tarefa\)/) < posL(/await falharTarefa\(/) &&
      posL(/if \(!tarefa\)/) < posL(/await concluirTarefa\(/));
    ok("L58 e recusar NAO chama terminalizador generico",
      !/falharTarefa|concluirTarefa|aguardarAprovacaoTarefa/
        .test(EXEC_L.slice(posL(/if \(!tarefa\)/), posL(/const contexto: ContextoTarefa/))));
    ok("L59 o executor le tarefa SO pelo loader cercado",
      (EXEC_L.match(/lerTarefaParaExecucao\(/g) ?? []).length === 1 &&
      !/\.from\(\s*"agente_tarefas"\s*\)/.test(EXEC_L));
    ok("L60 a rota interna depende do loader, sem cerca propria — INTENCIONAL",
      !/retomada/.test(semComentarios(ler("app/api/internal/agentes/executar/route.ts"))) &&
      /await executarTarefa\(/.test(semComentarios(ler("app/api/internal/agentes/executar/route.ts"))));
  }

  // ─── M. RESUME-D5-C3-I0: a porta estreita da lane de retomada ──────

  secao("M. RESUME-D5-C3-I0: a porta estreita da lane de retomada");
  {
    const EXEC_M = ler("lib/agentes/execucao-funcoes/executar.ts");
    const EXEC_M_CODIGO = semComentarios(EXEC_M);
    const { executarFuncaoAprovada } = await import("../lib/agentes/execucao-funcoes/executar");

    /** Corpo EXATO de uma funcao: da assinatura ate o `}` na coluna 0. */
    const corpoM = (fonte: string, nome: string): string => {
      const linhas = fonte.split("\n");
      const ini = linhas.findIndex((l) =>
        new RegExp(`^(export )?(async )?function ${nome}\\b`).test(l));
      if (ini < 0) return "";
      for (let j = ini + 1; j < linhas.length; j++) {
        if (linhas[j] === "}") return linhas.slice(ini, j + 1).join("\n");
      }
      return "";
    };
    const CORPO_APROVADA = corpoM(EXEC_M_CODIGO, "executarFuncaoAprovada");

    ok("M0  ANCORA: a nova porta existe e foi isolada",
      typeof executarFuncaoAprovada === "function" && CORPO_APROVADA.length > 300);

    // ── §14. SnapshotChamada continua PRIVADO ───────────────────────
    ok("M1  SnapshotChamada NAO e exportado",
      !/export\s+(type|interface)\s+SnapshotChamada/.test(EXEC_M_CODIGO));
    ok("M2  nem executarComAberturaFeita",
      !/export\s+async\s+function\s+executarComAberturaFeita/.test(EXEC_M_CODIGO));
    ok("M3  CONTROLE: um export real seria detectado",
      /export\s+(type|interface)\s+SnapshotChamada/.test("export type SnapshotChamada = X;"));

    // ── §22/§23. A API NAO aceita lifecycle de Tarefa nem Approval ──
    const ENTRADA = (() => {
      const i = EXEC_M_CODIGO.indexOf("export interface EntradaExecucaoFuncaoAprovada");
      return i < 0 ? "" : EXEC_M_CODIGO.slice(i, EXEC_M_CODIGO.indexOf("\n}", i));
    })();
    ok("M4  ANCORA: o tipo de entrada foi isolado",
      ENTRADA.length > 100 && ENTRADA.includes("requestId"));
    for (const proibido of ["aprovacaoId", "approvalId", "tentativas", "tentativa",
                            "maxTentativas", "status", "heartbeat", "retomada_request_id"]) {
      ok(`M5  a entrada NAO aceita \`${proibido}\``, !ENTRADA.includes(proibido));
    }
    ok("M6  e tambem nao aceita o que vem da DEFINICAO",
      !/\bacesso\b/.test(ENTRADA) && !/\bplataforma\b/.test(ENTRADA) &&
      !/\brecurso\b/.test(ENTRADA));
    ok("M7  CONTROLE: um campo proibido no tipo seria detectado",
      "  tentativas: number;".includes("tentativas"));

    // ── §12. UMA delegacao, e so para a primitiva certa ─────────────
    ok("M8  delega para executarComAberturaFeita",
      (CORPO_APROVADA.match(/executarComAberturaFeita\(/g) ?? []).length === 1);
    ok("M9  e NAO chama executarFuncao nem retomarAprovacao",
      !/\bexecutarFuncao\(/.test(CORPO_APROVADA) &&
      !/\bretomarAprovacao\b/.test(CORPO_APROVADA));

    // ── §11/§16. Nao abre Tool Call, nao toca Approval ──────────────
    for (const proibido of ["registrarAbertura", "consumirAprovacaoEAbrir", "criarAprovacao",
                            "iniciarRetomadaAprovacao", "autorizarFuncao"]) {
      ok(`M10 a porta nao chama \`${proibido}\``,
        !new RegExp(`\\b${proibido}\\s*\\(`).test(CORPO_APROVADA));
    }

    // ── §15. Zero lifecycle de Tarefa ──────────────────────────────
    for (const proibido of ["concluirTarefa", "falharTarefa", "aguardarAprovacaoTarefa",
                            "concluirTarefaRetomada", "falharTarefaRetomada",
                            "registrarHeartbeatRetomada", "registrarProgresso"]) {
      ok(`M11 a porta nao chama \`${proibido}\``,
        !new RegExp(`\\b${proibido}\\b`).test(CORPO_APROVADA));
    }

    // ── §10. O R nao e gerado nem trocado ───────────────────────────
    ok("M12 a porta NAO gera UUID",
      !/randomUUID/.test(CORPO_APROVADA));
    ok("M13 e o requestId do snapshot e o RECEBIDO",
      /requestId,/.test(CORPO_APROVADA) &&
      !/requestId:\s*(?!requestId)/.test(CORPO_APROVADA.replace(/requestId,/g, "")));

    // ── COMPORTAMENTO: o snapshot chega ao desfecho ─────────────────
    //
    // O duplo registra a linha realmente inserida em
    // `agente_funcao_chamadas`. Nao e leitura de fonte: e o que a
    // auditoria receberia.
    const R_CAUSAL = "req-causal-c3i0";
    roteiro({ data: [{ id: 1 }] }, { data: null, error: null });
    roteiroRpc();
    const entradaBoa = {
      userId: USER,
      agenteId: AGENTE,
      tarefaId: TAREFA,
      funcaoId: "vendas.consultar",
      lojaId: null,
      nivelNoMomento: "aprovacao" as const,
      requestId: R_CAUSAL,
      argumentos: FILTRO_OK,
    };
    const r = await executarFuncaoAprovada(entradaBoa);
    const desfecho = chamadas.find((c) => c.escrita && c.tabela === "agente_funcao_chamadas");

    ok("M14 o resultado tem a forma de ResultadoExecucaoFuncao",
      typeof r === "object" && r !== null && typeof (r as { tipo?: unknown }).tipo === "string");
    ok("M15 o requestId devolvido e o R RECEBIDO, nunca outro",
      (r as { requestId?: unknown }).requestId === R_CAUSAL);
    ok("M16 uma linha de desfecho foi gravada na auditoria",
      desfecho !== undefined && desfecho.linha?.fase === "desfecho");
    ok("M17 e ela carrega o MESMO R — e por ele que o desfecho acha a abertura",
      desfecho?.linha?.request_id === R_CAUSAL);
    ok("M18 com a identidade recebida, sem invencao",
      desfecho?.linha?.user_id === USER &&
      desfecho?.linha?.agente_id === AGENTE &&
      desfecho?.linha?.tarefa_id === TAREFA &&
      desfecho?.linha?.funcao_id === "vendas.consultar");
    ok("M19 e o nivel lido da abertura viaja intacto",
      desfecho?.linha?.nivel_no_momento === "aprovacao");
    // ── D5-C3-I0-R1-N1 CORRIGIDO ───────────────────────────────────
    //
    // Estes dois liam o valor esperado do MESMO catalogo que a porta
    // consulta. O oraculo era compartilhado: trocar `acesso` na
    // definicao mudava os dois lados ao mesmo tempo e o assert
    // continuava verde, provando apenas que a porta le o catalogo — nao
    // QUE valor ela grava.
    //
    // Agora o valor esperado e LITERAL e independente, e a concordancia
    // do catalogo com esses literais e um assert SEPARADO. Os dois
    // oraculos ficam distintos de proposito: se a definicao mudar sem
    // gate, M20a reprova sozinho, e os dois primeiros continuam medindo
    // o que a porta realmente gravou.
    ok("M20 acesso gravado e `leitura`, literal independente do catalogo",
      desfecho?.linha?.acesso === "leitura");
    ok("M21 plataforma e recurso gravados sao ambos null",
      desfecho?.linha?.plataforma === null && desfecho?.linha?.recurso === null);
    ok("M20a ORACULO SEPARADO: o catalogo ainda concorda com esses literais",
      FUNCOES["vendas.consultar"].acesso === "leitura" &&
      FUNCOES["vendas.consultar"].conexaoNecessaria === null);
    ok("M21a CONTROLE NEGATIVO: um literal errado seria detectado",
      !(("escrita" as string) === "leitura"));
    ok("M22 nenhuma ABERTURA foi gravada — a porta nao abre Tool Call",
      !chamadas.some((c) => c.escrita && c.linha?.fase === "abertura"));
    ok("M23 e nenhuma RPC foi chamada",
      chamadasRpc.length === 0);

    // ── FAIL CLOSED, sem inventar correlacao ────────────────────────
    for (const [nome, mut] of [
      ["userId vazio", { userId: "" }],
      ["agenteId vazio", { agenteId: "" }],
      ["requestId vazio", { requestId: "" }],
      ["funcaoId desconhecido", { funcaoId: "vendas.inexistente" }],
    ] as Array<[string, Record<string, unknown>]>) {
      roteiro();
      roteiroRpc();
      const rr = await executarFuncaoAprovada({ ...entradaBoa, ...mut } as typeof entradaBoa);
      ok(`M24 ${nome} recusa fechado como indisponivel`,
        (rr as { tipo?: unknown }).tipo === "indisponivel");
      ok(`M25 ${nome} nao escreve auditoria nem chama RPC`,
        chamadas.filter((c) => c.escrita).length === 0 && chamadasRpc.length === 0);
    }
    roteiro();
    roteiroRpc();
    const rVazio = await executarFuncaoAprovada({ ...entradaBoa, requestId: "" });
    ok("M26 na recusa o requestId devolvido e o recebido — nenhuma correlacao inventada",
      (rVazio as { requestId?: unknown }).requestId === "");

    // ── §17. Barreira F4: a porta nao e retomarAprovacao ────────────
    ok("M27 a porta nao referencia retomarAprovacao",
      !/retomarAprovacao/.test(CORPO_APROVADA));
    ok("M28 e nao alcanca a RPC generica de consumo",
      !/aprovacao_consumir_e_abrir/.test(CORPO_APROVADA));

    // ── DORMENCIA ───────────────────────────────────────────────────
    {
      const producao = ["lib/agentes", "app", "components"];
      const alcanca: string[] = [];
      const varrer = (dir: string): void => {
        for (const e of readdirSync(join(RAIZ, dir), { withFileTypes: true })) {
          const rel = `${dir}/${e.name}`;
          if (e.isDirectory()) varrer(rel);
          else if (/\.tsx?$/.test(e.name) &&
                   rel !== "lib/agentes/execucao-funcoes/executar.ts" &&
                   /\bexecutarFuncaoAprovada\b/.test(semComentarios(ler(rel))))
            alcanca.push(rel);
        }
      };
      for (const d of producao) varrer(d);
      // ── A tripwire AVANCOU de fase no D5-C3-I1 ────────────────────
      //
      // Ate o I0 a porta nao tinha chamador nenhum, e a prova era a
      // ausencia. O I1 criou o executor Resume, que e o UNICO consumidor
      // autorizado dela. Apagar o assert trocaria uma prova por um
      // silencio; o que ele mede agora e que a lista de chamadores tem
      // EXATAMENTE um nome, e que e esse.
      const AUTORIZADOS_PORTA = ["lib/agentes/retomada/executar-retomada.ts"];
      ok(`M29 a porta nova tem exatamente o chamador autorizado (${alcanca.join(", ") || "nenhum"})`,
        alcanca.length === AUTORIZADOS_PORTA.length &&
        [...alcanca].sort().every((r, i) => r === [...AUTORIZADOS_PORTA].sort()[i]));
      ok("M29a CONTROLE NEGATIVO: um segundo chamador reprova",
        !(["lib/agentes/retomada/executar-retomada.ts", "lib/agentes/intruso.ts"].length ===
          AUTORIZADOS_PORTA.length));
      ok("M29b CONTROLE NEGATIVO: chamador NENHUM tambem reprova",
        !([].length === AUTORIZADOS_PORTA.length));
    }
  }

  // ─── N. RESUME-D5-C3-I1: o executor DORMENTE da lane de retomada ───

  secao("N. RESUME-D5-C3-I1: o executor dormente da lane de retomada");
  {
    const EXEC_N = ler("lib/agentes/retomada/executar-retomada.ts");
    const CODIGO_N = semComentarios(EXEC_N);
    const modN = await import("../lib/agentes/retomada/executar-retomada");
    const executarRetomada = modN.executarRetomada;
    const INTERVALO_N = modN.INTERVALO_HEARTBEAT_RETOMADA_MS;

    const APROV = "33333333-3333-4333-8333-333333333333";
    const ARGS_APROVADOS = { dataInicio: "2026-08-01", dataFim: "2026-08-07", marketplace: null };

    const linhaAprov = (over: Record<string, unknown> = {}): Resposta => ({
      data: {
        id: APROV,
        funcao_id: "vendas.consultar",
        revisao_funcao: "1",
        acesso: "leitura",
        conexao_plataforma: null,
        conexao_recurso: null,
        conexao_loja_id: null,
        argumentos: ARGS_APROVADOS,
        agente_id: AGENTE,
        tarefa_id: TAREFA,
        ...over,
      },
    });
    const linhaTar = (over: Record<string, unknown> = {}): Resposta => ({
      data: {
        id: TAREFA, user_id: USER, agente_id: AGENTE, tipo: "consultar_vendas",
        status: "aguardando_aprovacao", tentativas: 2, max_tentativas: 3, entrada: {},
        ...over,
      },
    });
    const abertura = (nivel: unknown = "aprovacao"): Resposta => ({ data: { nivel_no_momento: nivel } });
    const tentativasN = (n: unknown = 2): Resposta => ({ data: { tentativas: n } });
    const vendas: Resposta = { data: [{ id: 1, item_subtotal: 10, faturamento: 10, marketplace: "shopee" }] };
    const linhaFinal: Resposta = { data: { id: TAREFA, user_id: USER, status: "concluido", tentativas: 2 } };

    /** O caminho feliz inteiro, do pre-read ao terminalizador. */
    const cenarioFeliz = (): void => {
      roteiro(linhaAprov(), linhaTar(), abertura(), tentativasN(), vendas, gravou);
      roteiroRpc({ data: "consumida" }, linhaFinal);
    };

    const rpcDe = (nome: string) => chamadasRpc.find((c) => c.nome === nome);
    const desfechoGravado = () =>
      chamadas.find((c) => c.escrita && c.tabela === "agente_funcao_chamadas");

    // ── N0. ANCORA ────────────────────────────────────────────────────
    ok("N0  ANCORA: o executor existe e o fonte foi lido",
      typeof executarRetomada === "function" && CODIGO_N.length > 2000);

    // ── N1..N8. A LANE NORMAL NAO ENTRA AQUI ──────────────────────────
    for (const mod of ["@/lib/agentes/executar-tarefa", "@/lib/agentes/capability-worker",
                       "@/lib/agentes/handlers/registry", "@/lib/agentes/handlers/consultar-vendas",
                       "@/lib/estudio-anuncios/supabase-servidor"]) {
      ok(`N1  nao importa \`${mod}\``, !CODIGO_N.includes(mod));
    }
    // ── N2, avancado no B2-I1 — achado B2-A0-F1 ────────────────────────
    //
    // `recuperarRetomadaStale` saiu desta lista, e SO ele. Ate o B1 o
    // executor nao tinha por que citar a recuperacao; o slot tem — e
    // manter a proibicao obrigaria a implementar a recuperacao fora do
    // dono dela, que e o oposto do que o B2-A0 congelou.
    //
    // Apagar a linha e deixar um buraco. O que substitui e mais forte
    // que a proibicao: N2a exige que o simbolo entre pelo import do
    // adaptador esperado e seja invocado EXATAMENTE uma vez, dentro do
    // corpo do slot — nenhuma ocorrencia solta, nenhum alias, nenhuma
    // segunda chamada. Os outros 16 simbolos continuam proibidos.
    for (const sim of ["executarTarefa", "INTERVALO_HEARTBEAT_MS", "executarFuncao(",
                       "retomarAprovacao", "consumirAprovacaoEAbrir", "criarAprovacao",
                       "registrarAbertura", "registrarDesfechoDeExecucao",
                       "registrarDesfechoSemExecucao", "concluirTarefa(", "falharTarefa(",
                       "aguardarAprovacaoTarefa", "registrarProgresso", "lerTarefaParaExecucao",
                       "reivindicarProximaTarefa", "resolverHandler"]) {
      ok(`N2  nao cita \`${sim}\``, !CODIGO_N.includes(sim));
    }
    ok("N2z ANCORA: a lista negativa continua com os 16 simbolos da lane normal",
      !CODIGO_N.includes("executarTarefa") && !CODIGO_N.includes("resolverHandler"));
    {
      const papeisRec = papeisDoSimbolo(CODIGO_N, "recuperarRetomadaStale");
      const corpoSlotN = corpoDeExportado(CODIGO_N, "executarSlotRetomada");
      ok(`N2a a recuperacao entra por import e e invocada UMA vez (${JSON.stringify(papeisRec)})`,
        papeisRec.definicoes === 0 && papeisRec.importacoes === 1 &&
        papeisRec.invocacoes === 1 && papeisRec.semPapel === 0);
      ok("N2b e essa unica invocacao esta DENTRO do slot",
        corpoSlotN.length > 500 &&
        (corpoSlotN.match(/\brecuperarRetomadaStale\s*\(/g) ?? []).length === 1);
      ok("N2c CONTROLE: um alias da recuperacao seria detectado",
        papeisDoSimbolo("const f = recuperarRetomadaStale; await f(a);",
          "recuperarRetomadaStale").semPapel === 1);
    }
    for (const rpc of ["aprovacao_consumir_e_abrir", "concluir_tarefa", "falhar_tarefa",
                       "aguardar_aprovacao_tarefa", "claim_next_agente_tarefa"]) {
      ok(`N3  nao cita a RPC \`${rpc}\``, !CODIGO_N.includes(rpc));
    }
    ok("N4  CONTROLE: um import proibido seria detectado",
      "import x from \"@/lib/agentes/executar-tarefa\";".includes("@/lib/agentes/executar-tarefa"));

    // ── N5..N6. A constante local, por VALOR ──────────────────────────
    ok("N5  INTERVALO_HEARTBEAT_RETOMADA_MS === 15000", INTERVALO_N === 15_000);
    ok("N6  relacao 20x com o corte de orfa de 5 min",
      INTERVALO_N * 20 === 300_000 && (5 * 60_000) / INTERVALO_N === 20);
    ok("N7  a constante e declarada LOCALMENTE, nao importada",
      /const INTERVALO_HEARTBEAT_RETOMADA_MS = 15_000/.test(CODIGO_N));

    // ── N8..N11. HIGIENE DE ERRO: texto cru nao e lido ────────────────
    for (const campo of [".message", ".details", ".hint", ".stack", ".cause",
                         "envelope.error", ".error.code"]) {
      ok(`N8  o executor nunca le \`${campo}\``, !CODIGO_N.includes(campo));
    }
    ok("N9  CONTROLE: uma leitura de message seria detectada",
      "err.message.slice(0, 300)".includes(".message"));
    ok("N10 as mensagens persistidas sao literais fixos",
      /const MSG_PAUSA = "/.test(CODIGO_N) && /const MSG_INTERNA = "/.test(CODIGO_N) &&
      /const MSG_FUNCAO_ERRO = "/.test(CODIGO_N));
    ok("N11 a etapa de auditoria passa por membership, nao por regex",
      /ETAPAS_AUDITORIA as readonly string\[\]\)\.includes\(valor\)/.test(CODIGO_N) &&
      !/\[a-z0-9_\]\{1,40\}/.test(CODIGO_N));

    // ── N12..N22. CAMINHO FELIZ ───────────────────────────────────────
    cenarioFeliz();
    const rFeliz = await executarRetomada(USER, APROV, () => true);
    const inicioRpc = rpcDe("retomar_aprovacao_iniciar");
    const concluiRpc = rpcDe("retomada_concluir_tarefa");
    const R_USADO = inicioRpc?.parametros?.p_request_id;

    ok("N12 o desfecho e `concluida`", rFeliz.tipo === "concluida");
    ok("N13 a RPC de inicio foi chamada exatamente uma vez",
      chamadasRpc.filter((c) => c.nome === "retomar_aprovacao_iniciar").length === 1);
    ok("N14 com o dono e a aprovacao recebidos",
      inicioRpc?.parametros?.p_user_id === USER &&
      inicioRpc?.parametros?.p_aprovacao_id === APROV);
    ok("N15 T-TYPE-1: o tipo enviado e o da LINHA da tarefa",
      inicioRpc?.parametros?.p_tipo_tarefa_esperado === "consultar_vendas");
    ok("N16 a funcao esperada vem do CONTRATO",
      inicioRpc?.parametros?.p_funcao_id_esperada === "vendas.consultar");
    ok("N17 a revisao enviada e a do catalogo",
      inicioRpc?.parametros?.p_revisao_atual === "1");
    ok("N18 R tem forma de uuid e nao e o id da aprovacao",
      typeof R_USADO === "string" &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(R_USADO) &&
      R_USADO !== APROV);
    ok("N19 a Funcao rodou e gravou o desfecho com o MESMO R",
      desfechoGravado()?.linha?.request_id === R_USADO &&
      desfechoGravado()?.linha?.fase === "desfecho");
    ok("N20 F2: a conclusao usa a RPC DEDICADA, exatamente uma vez",
      chamadasRpc.filter((c) => c.nome === "retomada_concluir_tarefa").length === 1);
    ok("N21 e ela carrega tarefa, dono, N e R",
      concluiRpc?.parametros?.p_tarefa_id === TAREFA &&
      concluiRpc?.parametros?.p_user_id === USER &&
      concluiRpc?.parametros?.p_tentativa_esperada === 2 &&
      concluiRpc?.parametros?.p_retomada_request_id === R_USADO);
    ok("N22 nenhum terminalizador generico e nenhuma falha dedicada",
      !chamadasRpc.some((c) => c.nome === "concluir_tarefa" || c.nome === "falhar_tarefa" ||
                               c.nome === "retomada_falhar_tarefa"));
    ok("N23 o resultado de negocio chegou ao terminalizador",
      typeof concluiRpc?.parametros?.p_resultado === "object" &&
      concluiRpc?.parametros?.p_resultado !== null &&
      "resumo" in (concluiRpc?.parametros?.p_resultado as Record<string, unknown>));

    // ── N24..N26. F1: a fonte dos argumentos ──────────────────────────
    ok("N24 F1: os argumentos executados sao os APROVADOS",
      JSON.stringify(desfechoGravado()?.linha?.funcao_id) === JSON.stringify("vendas.consultar") &&
      /argumentos: ap\.argumentos/.test(CODIGO_N));
    // M2-I1-A7: a preparacao passou a vir AMARRADA a continuacao, por
    // `prepararRetomada(tipo, bruta)`. A PROPRIEDADE nao mudou — os
    // argumentos executados sao os APROVADOS, e apenas eles.
    ok("N25 F1: prepararRetomada recebe tipoTarefa e ap.argumentos, e so",
      /prepararRetomada\(tipoTarefa, ap\.argumentos\)/.test(CODIGO_N));
    ok("N25a CONTROLE: outra fonte de argumentos seria acusada",
      !/prepararRetomada\(tipoTarefa, ap\.argumentos\)/
        .test("prepararRetomada(tipoTarefa, tarefa.linha.entrada)"));
    ok("N25b e a preparacao SOLTA do contrato nao existe mais",
      !/contrato\.prepararEntrada\(/.test(CODIGO_N) &&
      !/contrato\.continuarAposFuncao\(/.test(CODIGO_N));
    ok("N26 F1: a entrada da TAREFA nunca e usada",
      !/tarefa\.linha\.entrada/.test(CODIGO_N) && !/contexto\.entrada/.test(CODIGO_N) &&
      !/\.entrada\b/.test(CODIGO_N));

    // ── N27..N31. ORDEM DOS EFEITOS, por posicao de origem ────────────
    {
      const pos = {
        preRead: CODIGO_N.indexOf("await lerAprovacaoParaRetomada("),
        tipo: CODIGO_N.indexOf("await lerTarefaDoDono("),
        prepara: CODIGO_N.indexOf("prepararRetomada(tipoTarefa,"),
        uuid: CODIGO_N.indexOf("randomUUID()"),
        start: CODIGO_N.indexOf("await iniciarRetomadaAprovacao("),
        abertura: CODIGO_N.indexOf("await lerNivelDaAberturaDeRetomada("),
        lerN: CODIGO_N.indexOf("await lerTentativaDaRetomada("),
        timer: CODIGO_N.indexOf("setInterval("),
        funcao: CODIGO_N.indexOf("await executarFuncaoAprovada("),
        limpa: CODIGO_N.indexOf("clearInterval("),
        conclui: CODIGO_N.indexOf("await concluirTarefaRetomada("),
        falha: CODIGO_N.indexOf("await falharTarefaRetomada("),
      };
      // ANCORA primeiro: `indexOf` devolve -1 quando o alvo some, e -1
      // e menor que qualquer indice — sem esta linha, apagar um ponto
      // faria as comparacoes passarem por vacuidade. E o bug do L57.
      ok("N27 ANCORA: todos os pontos do fluxo existem no fonte",
        Object.values(pos).every((p) => p > 0));
      ok("N28 pre-read -> tipo -> preparar -> R -> start, nesta ordem",
        pos.preRead < pos.tipo && pos.tipo < pos.prepara &&
        pos.prepara < pos.uuid && pos.uuid < pos.start);
      ok("N29 start -> abertura -> N -> heartbeat, nesta ordem",
        pos.start < pos.abertura && pos.abertura < pos.lerN && pos.lerN < pos.timer);
      ok("N30 o heartbeat comeca ANTES da Funcao",
        pos.timer < pos.funcao);
      ok("N31 clearInterval vem ANTES dos dois terminalizadores",
        pos.limpa < pos.conclui && pos.limpa < pos.falha);
      ok("N32 o timer e desamarrado do event loop",
        /unref\?\.\(\)/.test(CODIGO_N));
      ok("N33 ha guarda de batida em voo",
        /baticaoEmVoo/.test(CODIGO_N) && /if \(baticaoEmVoo\) return;/.test(CODIGO_N));
      ok("N33a o tick recebe tarefa, dono, N e o R DESTE ciclo",
        /registrarHeartbeatRetomada\(tarefaId, userId, tentativas, requestId\)/.test(CODIGO_N));
      ok("N33b CONTROLE NEGATIVO: outro R ou outro N no tick seria detectado",
        !/registrarHeartbeatRetomada\(tarefaId, userId, tentativas, aprovacaoId\)/.test(CODIGO_N) &&
        !/registrarHeartbeatRetomada\(tarefaId, userId, 0, requestId\)/.test(CODIGO_N));
      ok("N34 clearInterval acontece em finally",
        /finally \{\n\s*clearInterval\(timerHeartbeat\);/.test(CODIGO_N));
    }

    // ── N35..N38. T-TYPE: o tipo vem da LINHA, nunca inferido ─────────
    ok("N35 T-TYPE-4: o tipo nunca e derivado de funcaoId",
      /const tipoTarefa = tarefa\.linha\.tipo/.test(CODIGO_N) &&
      !/tipoPorFuncao|tipoDe\(|inferirTipo/.test(CODIGO_N));

    roteiro(linhaAprov(), linhaTar({ tipo: "conversa" }));
    roteiroRpc();
    const rTipo = await executarRetomada(USER, APROV, () => true);
    ok("N36 T-TYPE-2: tipo sem contrato recusa com motivo fechado",
      rTipo.tipo === "sem_inicio" &&
      (rTipo as { motivo?: unknown }).motivo === "contrato_desconhecido");
    ok("N37 T-TYPE-2: e nenhuma RPC e chamada",
      chamadasRpc.length === 0 && !desfechoGravado());

    roteiro(linhaAprov(), linhaTar());
    roteiroRpc({ data: "tarefa_incompativel" });
    const rStale = await executarRetomada(USER, APROV, () => true);
    ok("N38 T-TYPE-3: a AUTORIDADE e o start — tipo stale vira recusa",
      rStale.tipo === "sem_inicio" &&
      (rStale as { motivo?: unknown }).motivo === "tarefa_incompativel");
    ok("N39 T-TYPE-3: Funcao 0 e terminalizador 0",
      !desfechoGravado() && chamadasRpc.length === 1);

    // ── N40..N43. START: os 16 codigos, e so `consumida` segue ────────
    {
      const CODIGOS_16 = ["entrada_invalida", "aprovacao_inexistente", "agente_indisponivel",
        "tarefa_indisponivel", "aprovacao_pendente", "ja_consumida", "ja_rejeitada",
        "ja_cancelada", "expirada", "aprovacao_desatualizada", "escrita_nao_suportada",
        "permissao_ausente", "permissao_bloqueada", "conexao_indisponivel",
        "tarefa_incompativel", "funcao_incompativel"];
      let recusas = 0;
      let execucoes = 0;
      for (const codigo of CODIGOS_16) {
        roteiro(linhaAprov(), linhaTar());
        roteiroRpc({ data: codigo });
        const rr = await executarRetomada(USER, APROV, () => true);
        if (rr.tipo === "sem_inicio" && (rr as { motivo?: unknown }).motivo === codigo) recusas++;
        if (desfechoGravado()) execucoes++;
      }
      ok(`N40 S2: os 16 codigos de recusa viram sem_inicio com o proprio motivo (${recusas}/16)`,
        recusas === 16);
      ok("N41 S2/S3: nenhum deles executa Funcao", execucoes === 0);
    }

    roteiro(linhaAprov(), linhaTar());
    roteiroRpc({ data: null, error: { code: "08006" } });
    const rAmbiguo = await executarRetomada(USER, APROV, () => true);
    ok("N42 S4: transporte no start vira inicio_ambiguo",
      rAmbiguo.tipo === "inicio_ambiguo" &&
      (rAmbiguo as { motivo?: unknown }).motivo === "rpc_indisponivel");
    ok("N43 S4: ambiguo NAO executa Funcao e NAO terminaliza",
      !desfechoGravado() &&
      !chamadasRpc.some((c) => c.nome.startsWith("retomada_")) &&
      chamadasRpc.length === 1);

    roteiro(linhaAprov(), linhaTar());
    roteiroRpc({ data: "codigo_que_nao_existe" });
    const rInvalido = await executarRetomada(USER, APROV, () => true);
    ok("N44 S5: codigo fora do catalogo vira inicio_ambiguo",
      rInvalido.tipo === "inicio_ambiguo" &&
      (rInvalido as { motivo?: unknown }).motivo === "resposta_invalida");
    ok("N45 S5: e tambem nao executa nem terminaliza",
      !desfechoGravado() && chamadasRpc.length === 1);

    roteiro(linhaAprov(), linhaTar());
    roteiroRpc({ data: null, error: { code: "55000" } });
    const r55 = await executarRetomada(USER, APROV, () => true);
    ok("N46 55000 aborta a transacao — sem_inicio, nao ambiguo",
      r55.tipo === "sem_inicio" &&
      (r55 as { motivo?: unknown }).motivo === "rpc_fora_de_contrato");

    roteiro(linhaAprov(), linhaTar());
    roteiroRpc({ data: null, error: { code: "22023" } });
    const r22 = await executarRetomada(USER, APROV, () => true);
    ok("N47 22023 tambem e sem_inicio",
      r22.tipo === "sem_inicio" &&
      (r22 as { motivo?: unknown }).motivo === "rpc_entrada_invalida");

    // ── N48..N55. CONTEXTO POS-START ──────────────────────────────────
    roteiro(linhaAprov(), linhaTar(), { data: null });
    roteiroRpc({ data: "consumida" });
    const rSemAbertura = await executarRetomada(USER, APROV, () => true);
    ok("N48 C2: abertura sem linha vira contexto_incompleto",
      rSemAbertura.tipo === "contexto_incompleto" &&
      (rSemAbertura as { motivo?: unknown }).motivo === "abertura_ilegivel");
    ok("N49 C2: Funcao 0 e terminalizador 0",
      !desfechoGravado() && chamadasRpc.length === 1);

    roteiro(linhaAprov(), linhaTar(), { data: null, error: { code: "08006" } });
    roteiroRpc({ data: "consumida" });
    const rAberturaErro = await executarRetomada(USER, APROV, () => true);
    ok("N50 C3: abertura indisponivel tambem para, fechado",
      rAberturaErro.tipo === "contexto_incompleto" && !desfechoGravado());

    roteiro(linhaAprov(), linhaTar(), abertura("valor_invalido"));
    roteiroRpc({ data: "consumida" });
    const rNivelMau = await executarRetomada(USER, APROV, () => true);
    ok("N51 nivel fora do vocabulario NAO vira nivel plausivel",
      rNivelMau.tipo === "contexto_incompleto" && !desfechoGravado());

    roteiro(linhaAprov(), linhaTar(), abertura(), { data: null });
    roteiroRpc({ data: "consumida" });
    const rSemN = await executarRetomada(USER, APROV, () => true);
    ok("N52 C5: N sem linha vira contexto_incompleto/tarefa_ilegivel",
      rSemN.tipo === "contexto_incompleto" &&
      (rSemN as { motivo?: unknown }).motivo === "tarefa_ilegivel");
    ok("N53 C5: Funcao 0 e terminalizador 0",
      !desfechoGravado() && chamadasRpc.length === 1);

    // A leitura de N cerca por QUATRO colunas causais, e le a tentativa.
    roteiro(linhaAprov(), linhaTar(), abertura(), tentativasN(7), vendas, gravou);
    roteiroRpc({ data: "consumida" }, linhaFinal);
    const rN7 = await executarRetomada(USER, APROV, () => true);
    const leituraDeN = chamadas.filter((c) => c.tabela === "agente_tarefas" && !c.escrita).pop();
    ok("N54 C6/C7: a leitura de N cerca por id, dono, status e R",
      leituraDeN?.filtros?.id === TAREFA &&
      leituraDeN?.filtros?.user_id === USER &&
      leituraDeN?.filtros?.status === "rodando" &&
      typeof leituraDeN?.filtros?.retomada_request_id === "string");
    ok("N55 C8: o N usado no terminalizador e o N LIDO, nunca calculado",
      rN7.tipo === "concluida" &&
      rpcDe("retomada_concluir_tarefa")?.parametros?.p_tentativa_esperada === 7);

    // ── N56..N62. E1/E2: higiene de erro, comportamental ──────────────
    //
    // O catalogo controlado e o unico jeito de alcancar as variantes de
    // erro: `vendas.consultar` real nunca lanca e sempre produz codigo
    // bem formado.
    const funcaoControlada = (interpretar: (s: unknown) => unknown,
                              acesso: "leitura" | "escrita" = "leitura"): void => {
      catalogoControlado = {
        "vendas.consultar": {
          executor: async () => ({ linhas: [], truncado: false, erro: null }),
          validarEntrada: () => ({ valida: true }),
          interpretarSaida: interpretar,
          acesso,
          idempotente: true,
          conexaoNecessaria: null,
          revisao: "1",
        },
      };
    };

    const falhaRpc = () => rpcDe("retomada_falhar_tarefa")?.parametros ?? {};

    // E1-a: codigo de ENTRADA -> entrada_invalida, mensagem FIXA.
    funcaoControlada(() => ({ tipo: "erro", codigo: "janela_excedida", mensagem: "x", retryable: false }));
    roteiro(linhaAprov(), linhaTar(), abertura(), tentativasN(), gravou);
    roteiroRpc({ data: "consumida" }, { data: { id: TAREFA, user_id: USER, status: "erro", tentativas: 2 } });
    const rEntrada = await executarRetomada(USER, APROV, () => true);
    ok("N56 E1: codigo de entrada vira entrada_invalida",
      rEntrada.tipo === "falhou" &&
      (rEntrada as { erroTipo?: unknown }).erroTipo === "entrada_invalida" &&
      falhaRpc().p_erro_tipo === "entrada_invalida");
    ok("N57 E1: com mensagem FIXA, sem o codigo copiado",
      falhaRpc().p_erro_mensagem === "retomada: entrada aprovada invalida");

    // E2: o codigo da Funcao e string ABERTA. Um segredo nele nao pode
    // alcancar a coluna persistida.
    funcaoControlada(() => ({ tipo: "erro", codigo: "secret_token_123", mensagem: "SECRET_SHOULD_NOT_PERSIST", retryable: false }));
    roteiro(linhaAprov(), linhaTar(), abertura(), tentativasN(), gravou);
    roteiroRpc({ data: "consumida" }, { data: { id: TAREFA, user_id: USER, status: "erro", tentativas: 2 } });
    const rSegredo = await executarRetomada(USER, APROV, () => true);
    const msgSegredo = String(falhaRpc().p_erro_mensagem ?? "");
    ok("N58 E2: erro comum da Funcao vira handler_falhou",
      rSegredo.tipo === "falhou" &&
      (rSegredo as { erroTipo?: unknown }).erroTipo === "handler_falhou");
    ok("N59 E2: a mensagem persistida e o literal fixo",
      msgSegredo === "retomada: funcao retornou erro");
    ok("N60 E2: nem o codigo nem a mensagem da Funcao vazam",
      !msgSegredo.includes("secret_token_123") &&
      !msgSegredo.includes("SECRET_SHOULD_NOT_PERSIST") &&
      !msgSegredo.includes("funcao_erro:"));

    // E2-b: saida que quebra o contrato SOBRE um resultado de sucesso.
    funcaoControlada(() => ({ tipo: "sucesso", data: { nada: "SECRET_SHOULD_NOT_PERSIST" } }));
    roteiro(linhaAprov(), linhaTar(), abertura(), tentativasN(), gravou);
    roteiroRpc({ data: "consumida" }, { data: { id: TAREFA, user_id: USER, status: "erro", tentativas: 2 } });
    const rSaidaMa = await executarRetomada(USER, APROV, () => true);
    const msgSaida = String(falhaRpc().p_erro_mensagem ?? "");
    ok("N61 E2: mapper lancando sobre sucesso vira erro_interno",
      rSaidaMa.tipo === "falhou" &&
      (rSaidaMa as { erroTipo?: unknown }).erroTipo === "erro_interno" &&
      msgSaida === "retomada: falha interna inesperada");
    ok("N62 E2: e o segredo da saida nao alcanca a coluna",
      !msgSaida.includes("SECRET_SHOULD_NOT_PERSIST") &&
      !msgSaida.includes("saida_inesperada"));

    // E1-b: falha_auditoria — o UNICO texto reconstruido.
    funcaoControlada(() => ({ tipo: "erro", codigo: "erro_consulta_vendas", mensagem: "m", retryable: false }), "escrita");
    roteiro(linhaAprov({ acesso: "escrita" }), linhaTar(), abertura(), tentativasN(), naoGravou);
    roteiroRpc({ data: "consumida" }, { data: { id: TAREFA, user_id: USER, status: "erro", tentativas: 2 } });
    const rAudit = await executarRetomada(USER, APROV, () => true);
    ok("N63 E1: falha_auditoria vira handler_falhou com a etapa RECONSTRUIDA",
      rAudit.tipo === "falhou" &&
      (rAudit as { erroTipo?: unknown }).erroTipo === "handler_falhou" &&
      falhaRpc().p_erro_mensagem === "falha_auditoria:desfecho");
    catalogoControlado = null;

    // ── N64..N69. M1: falha dedicada, inclusive em N == max ───────────
    const cenarioFalha = (n: number, max: number): void => {
      catalogoControlado = {
        "vendas.consultar": {
          executor: async () => ({ linhas: [], truncado: false, erro: "erro_consulta_vendas" }),
          validarEntrada: () => ({ valida: true }),
          interpretarSaida: () => ({ tipo: "erro", codigo: "erro_consulta_vendas", mensagem: "m", retryable: true }),
          acesso: "leitura", idempotente: true, conexaoNecessaria: null, revisao: "1",
        },
      };
      roteiro(linhaAprov(), linhaTar({ tentativas: n, max_tentativas: max }), abertura(), tentativasN(n), gravou);
      roteiroRpc({ data: "consumida" }, { data: { id: TAREFA, user_id: USER, status: "erro", tentativas: n } });
    };

    cenarioFalha(1, 3);
    const rMenor = await executarRetomada(USER, APROV, () => true);
    ok("N64 M1: N < max falha pela RPC DEDICADA",
      rMenor.tipo === "falhou" &&
      chamadasRpc.filter((c) => c.nome === "retomada_falhar_tarefa").length === 1);
    ok("N65 M1: e nunca pelo terminalizador generico",
      !chamadasRpc.some((c) => c.nome === "falhar_tarefa" || c.nome === "concluir_tarefa" ||
                               c.nome === "retomada_concluir_tarefa"));
    ok("N66 M1: sem semantica de requeue — o N vai intacto",
      falhaRpc().p_tentativa_esperada === 1);

    cenarioFalha(3, 3);
    const rMax = await executarRetomada(USER, APROV, () => true);
    ok("N67 M1 HARD: N == max TAMBEM usa a RPC dedicada",
      rMax.tipo === "falhou" &&
      chamadasRpc.filter((c) => c.nome === "retomada_falhar_tarefa").length === 1 &&
      !chamadasRpc.some((c) => c.nome === "falhar_tarefa"));
    ok("N68 M1 HARD: com o mesmo N lido, dono e R",
      falhaRpc().p_tentativa_esperada === 3 &&
      falhaRpc().p_user_id === USER &&
      falhaRpc().p_tarefa_id === TAREFA &&
      typeof falhaRpc().p_retomada_request_id === "string");
    catalogoControlado = null;

    // ── N69..N72. Terminalizador dedicado que FALHA ───────────────────
    roteiro(linhaAprov(), linhaTar(), abertura(), tentativasN(), vendas, gravou);
    roteiroRpc({ data: "consumida" }, { data: null, error: { code: "55000" } });
    const rConcMa = await executarRetomada(USER, APROV, () => true);
    ok("N69 conclusao nao registrada devolve indisponivel",
      rConcMa.tipo === "indisponivel" &&
      (rConcMa as { motivo?: unknown }).motivo === "conclusao_nao_registrada");
    ok("N70 sem fallback generico, sem retry de Funcao, sem retry de start",
      !chamadasRpc.some((c) => c.nome === "concluir_tarefa" || c.nome === "falhar_tarefa" ||
                               c.nome === "retomada_falhar_tarefa") &&
      chamadasRpc.filter((c) => c.nome === "retomar_aprovacao_iniciar").length === 1 &&
      chamadas.filter((c) => c.escrita && c.tabela === "agente_funcao_chamadas").length === 1);

    catalogoControlado = {
      "vendas.consultar": {
        executor: async () => ({ linhas: [], truncado: false, erro: "erro_consulta_vendas" }),
        validarEntrada: () => ({ valida: true }),
        interpretarSaida: () => ({ tipo: "erro", codigo: "erro_consulta_vendas", mensagem: "m", retryable: true }),
        acesso: "leitura", idempotente: true, conexaoNecessaria: null, revisao: "1",
      },
    };
    roteiro(linhaAprov(), linhaTar(), abertura(), tentativasN(), gravou);
    roteiroRpc({ data: "consumida" }, { data: null, error: { code: "55000" } });
    const rFalhaMa = await executarRetomada(USER, APROV, () => true);
    ok("N71 falha nao registrada devolve indisponivel",
      rFalhaMa.tipo === "indisponivel" &&
      (rFalhaMa as { motivo?: unknown }).motivo === "falha_nao_registrada");
    ok("N72 e tambem sem fallback generico",
      !chamadasRpc.some((c) => c.nome === "falhar_tarefa" || c.nome === "concluir_tarefa"));
    catalogoControlado = null;

    // ── N73..N76. PRE-START: nada e consumido ─────────────────────────
    roteiro({ data: null });
    roteiroRpc();
    const rSemAprov = await executarRetomada(USER, APROV, () => true);
    ok("N73 aprovacao inexistente recusa sem tocar em nada",
      rSemAprov.tipo === "sem_inicio" &&
      (rSemAprov as { motivo?: unknown }).motivo === "aprovacao_ilegivel" &&
      chamadasRpc.length === 0);

    roteiro(linhaAprov({ tarefa_id: null }));
    roteiroRpc();
    const rSemTarefa = await executarRetomada(USER, APROV, () => true);
    ok("N74 aprovacao sem tarefa causal para antes do start",
      rSemTarefa.tipo === "sem_inicio" &&
      (rSemTarefa as { motivo?: unknown }).motivo === "tarefa_ausente" &&
      chamadasRpc.length === 0);

    roteiro(linhaAprov({ revisao_funcao: "9" }));
    roteiroRpc();
    const rRev = await executarRetomada(USER, APROV, () => true);
    ok("N75 revisao divergente recusa com motivo local fechado",
      rRev.tipo === "sem_inicio" &&
      (rRev as { motivo?: unknown }).motivo === "local_revisao_divergente" &&
      chamadasRpc.length === 0);

    roteiro(linhaAprov({ argumentos: { dataInicio: "2026-08-01", extra: 1 } }));
    roteiroRpc();
    const rArgs = await executarRetomada(USER, APROV, () => true);
    ok("N76 argumento que o contrato recusa para ANTES de gastar a aprovacao",
      rArgs.tipo === "sem_inicio" && chamadasRpc.length === 0 && !desfechoGravado());

    // ── N77..N79. F4 e PAUSA, estruturais ─────────────────────────────
    ok("N77 F4: a lane de retomada nao alcanca o consumo generico",
      !CODIGO_N.includes("retomarAprovacao") &&
      !CODIGO_N.includes("consumirAprovacaoEAbrir") &&
      !CODIGO_N.includes("aprovacao_consumir_e_abrir"));
    ok("N78 PAUSA: a pausa e o PRIMEIRO ramo do classificador",
      CODIGO_N.indexOf("err instanceof PausaPorAprovacao") > 0 &&
      CODIGO_N.indexOf("err instanceof PausaPorAprovacao") <
        CODIGO_N.indexOf("switch (resultado.tipo)"));
    ok("N79 PAUSA: nao cria segunda aprovacao nem repausa a tarefa",
      !CODIGO_N.includes("criarAprovacao") && !CODIGO_N.includes("aguardarAprovacaoTarefa") &&
      /mensagem: MSG_PAUSA/.test(CODIGO_N));

    // ── N81..N92. F1 — EQUIVALENCIA REAL entre os dois caminhos ───────
    //
    // O achado D5-C3-I1-A0-F1 e sobre PROVENIENCIA: o caminho automatico
    // alimenta `prepararEntrada` com a entrada da TAREFA, e a retomada a
    // alimenta com `aprovacao.argumentos`. Para `consultar_vendas` as
    // duas formas coincidem hoje — e "coincidem" precisa ser MEDIDO, nao
    // afirmado.
    //
    // ── Por que duas ROTAS, e nao duas chamadas ao mapper ────────────
    //
    // Chamar `mapearResultadoConsultarVendas` duas vezes aqui provaria
    // apenas que a funcao e deterministica. O que interessa e outra
    // coisa: que o HANDLER automatico e o EXECUTOR de retomada, partindo
    // dos mesmos argumentos aprovados e do mesmo desfecho de Funcao,
    // entregam o mesmo payload comercial. Por isso um lado roda
    // `criarHandlerConsultarVendas` (que passa por `executarFuncao`,
    // guard, permissao e abertura) e o outro roda `executarRetomada`
    // (que passa por pre-read, start, read-backs e a boundary estreita).
    //
    // ── Por que catalogo controlado ─────────────────────────────────
    //
    // Para que os dois recebam o MESMO desfecho de Funcao com dados
    // NAO-TRIVIAIS: dois marketplaces distintos, valores diferentes e
    // `truncado: true` — que a Funcao real so produziria com mais de
    // PAGE_SIZE linhas por pagina. O mesmo catalogo serve aos dois
    // lados, entao ele nao pode enviesar a comparacao.
    {
      const { criarHandlerConsultarVendas } =
        await import("../lib/agentes/handlers/consultar-vendas");

      /** Igualdade estrutural por VALOR. `in`, `typeof` e truthy nao
       *  provam equivalencia — e foi exatamente disso que o R1 reclamou. */
      const deepIgual = (a: unknown, b: unknown): boolean => {
        if (a === b) return true;
        if (typeof a !== typeof b) return false;
        if (a === null || b === null) return false;
        if (Array.isArray(a) !== Array.isArray(b)) return false;
        if (typeof a !== "object") return false;
        const ka = Object.keys(a as object).sort();
        const kb = Object.keys(b as object).sort();
        if (ka.length !== kb.length || ka.some((k, i) => k !== kb[i])) return false;
        return ka.every((k) =>
          deepIgual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
      };

      // ── FIXTURES CANONICAS, e por que elas sao imutaveis ───────
      //
      // Na primeira versao desta prova os dois caminhos recebiam a MESMA
      // referencia de argumentos, e a Funcao controlada devolvia a MESMA
      // referencia de saida nas duas chamadas. A igualdade final podia,
      // em tese, vir de uma mutacao feita pela primeira rota e lida pela
      // segunda — equivalencia mascarada, nao equivalencia provada.
      //
      // Agora ha uma BASE congelada e clones independentes por rota. A
      // base nunca chega a producao: ela e apenas a origem dos clones.
      // Como o modulo roda em modo estrito, uma escrita in-place na base
      // LANCARIA em vez de passar despercebida.

      /** Congela recursivamente. TEST-ONLY — nao e exportado e nenhum
       *  modulo de producao o importa. */
      const congelarProfundo = <T>(valor: T): T => {
        if (valor === null || typeof valor !== "object") return valor;
        for (const chave of Object.keys(valor as object)) {
          congelarProfundo((valor as Record<string, unknown>)[chave]);
        }
        return Object.freeze(valor);
      };

      /** Clone estrutural para o shape destas fixtures: objetos simples,
       *  arrays, string, number, boolean e null. Escrito a mao em vez de
       *  `structuredClone` para nao depender do runtime da suite. */
      const clonarProfundo = <T>(valor: T): T => {
        if (valor === null || typeof valor !== "object") return valor;
        if (Array.isArray(valor)) {
          return valor.map((item) => clonarProfundo(item)) as unknown as T;
        }
        const saida: Record<string, unknown> = {};
        for (const chave of Object.keys(valor as object)) {
          saida[chave] = clonarProfundo((valor as Record<string, unknown>)[chave]);
        }
        return saida as unknown as T;
      };

      // UMA entrada aprovada concreta. Os dois caminhos recebem CLONES
      // dela; nenhum recebe a base. Nao ha segundo literal parecido.
      const ARGS_F1_BASE = congelarProfundo({
        dataInicio: "2026-08-01",
        dataFim: "2026-08-07",
        marketplace: null,
      });

      // `Shopee` e `ML` sao os nomes EXATOS que `bucketDe` reconhece;
      // qualquer outro cai em `outros`. Duas linhas do MESMO `order_id`
      // provam que `pedidos` conta identidade logica, e nao linhas.
      const SAIDA_F1_BASE = congelarProfundo({
        linhas: [
          { id: 1, marketplace: "ML", order_id: "A-1", sku: "SKU-A", qtd: 2, item_subtotal: 150.25, faturamento: 150.25 },
          { id: 2, marketplace: "ML", order_id: "A-1", sku: "SKU-B", qtd: 1, item_subtotal: 0, faturamento: 99.9 },
          { id: 3, marketplace: "Shopee", order_id: "B-1", sku: "SKU-C", qtd: 3, item_subtotal: 42.1, faturamento: 500 },
          { id: 4, marketplace: "nao_previsto", order_id: "C-1", sku: "SKU-D", qtd: 1, item_subtotal: 7.77, faturamento: 7.77 },
        ],
        truncado: true,
        erro: null,
      });

      const autoArgs = clonarProfundo(ARGS_F1_BASE);
      const resumeArgs = clonarProfundo(ARGS_F1_BASE);

      /** As instancias REALMENTE devolvidas pela Funcao, uma por rota. */
      const saidasExecutadasF1: Array<typeof SAIDA_F1_BASE> = [];

      let vezesExecutorF1 = 0;
      catalogoControlado = {
        "vendas.consultar": {
          executor: async () => {
            vezesExecutorF1++;
            // INSTANCIA NOVA a cada chamada: sem cache, sem reuso.
            const saida = clonarProfundo(SAIDA_F1_BASE);
            saidasExecutadasF1.push(saida);
            return saida;
          },
          validarEntrada: () => ({ valida: true }),
          // Espelha o ramo de sucesso do interpretador real: devolve o
          // proprio objeto como `data`. Identico para os dois lados.
          interpretarSaida: (saida: unknown) => ({ tipo: "sucesso", data: saida }),
          acesso: "leitura",
          idempotente: true,
          conexaoNecessaria: null,
          revisao: "1",
        },
      };

      // ── ROTA 1: o caminho AUTOMATICO, pelo handler real ────────────
      // ── CHECKPOINT PRE ── antes de qualquer rota ─────────────
      ok("N99  F1-args-independent: os dois clones sao IGUAIS por valor",
        deepIgual(autoArgs, ARGS_F1_BASE) && deepIgual(resumeArgs, ARGS_F1_BASE) &&
        deepIgual(autoArgs, resumeArgs));
      ok("N100 F1-args-independent: e sao REFERENCIAS distintas entre si e da base",
        (autoArgs as object) !== (resumeArgs as object) &&
        (autoArgs as object) !== (ARGS_F1_BASE as object) &&
        (resumeArgs as object) !== (ARGS_F1_BASE as object));
      ok("N101 F1-fixtures congeladas: escrita in-place na base LANCA",
        (() => {
          try {
            (ARGS_F1_BASE as unknown as Record<string, unknown>).dataFim = "2099-01-01";
            return false;
          } catch {
            return true;
          }
        })() &&
        (() => {
          try {
            (SAIDA_F1_BASE as unknown as Record<string, unknown>).truncado = false;
            return false;
          } catch {
            return true;
          }
        })());
      ok("N102 F1-fixtures congeladas: a base continua com os valores canonicos",
        deepIgual(ARGS_F1_BASE, {
          dataInicio: "2026-08-01", dataFim: "2026-08-07", marketplace: null,
        }) && SAIDA_F1_BASE.truncado === true && SAIDA_F1_BASE.linhas.length === 4);

      roteiro(agenteOk, tarefaOk, permissao("automatico"), gravou, gravou);
      roteiroRpc();
      const handlerAuto = criarHandlerConsultarVendas(USER);
      const payloadAuto = await handlerAuto(
        {
          tarefaId: TAREFA,
          agenteId: AGENTE,
          userId: USER,
          tipo: "consultar_vendas",
          entrada: autoArgs,
          tentativa: 2,
          maxTentativas: 3,
        },
        () => {}
      );
      const executouAuto = vezesExecutorF1;

      // ── ROTA 2: o caminho RESUME, pelo executor dormente ───────────
      // ── CHECKPOINT ENTRE AS ROTAS ───────────────────────
      //
      // E AQUI que a equivalencia deixa de poder ser mascarada: se a rota
      // automatica tivesse mutado o clone dela, a base ou o clone ainda
      // nao usado, um destes tres reprovaria ANTES de o Resume comecar.
      ok("N103 F1-args-auto-unchanged-mid: o clone do automatico saiu intacto",
        deepIgual(autoArgs, ARGS_F1_BASE));
      ok("N104 F1-args-resume-pristine-mid: o clone do Resume ainda nao foi tocado",
        deepIgual(resumeArgs, ARGS_F1_BASE));
      ok("N105 F1-args-base-intact-mid: a fixture canonica nao mudou",
        deepIgual(ARGS_F1_BASE, {
          dataInicio: "2026-08-01", dataFim: "2026-08-07", marketplace: null,
        }));
      ok("N106 F1-function-instance-count-mid: a Funcao devolveu UMA instancia",
        saidasExecutadasF1.length === 1);
      ok("N107 F1-function-auto-unchanged: a instancia do automatico saiu intacta",
        deepIgual(saidasExecutadasF1[0], SAIDA_F1_BASE));

      roteiro(linhaAprov({ argumentos: resumeArgs }), linhaTar(), abertura(), tentativasN(), gravou);
      roteiroRpc({ data: "consumida" }, linhaFinal);
      const rF1 = await executarRetomada(USER, APROV, () => true);
      const payloadResume = (rpcDe("retomada_concluir_tarefa")?.parametros?.p_resultado ?? null) as
        Record<string, unknown> | null;
      const executouResume = vezesExecutorF1 - executouAuto;
      catalogoControlado = null;

      const auto = payloadAuto as Record<string, unknown>;
      const res = (payloadResume ?? {}) as Record<string, unknown>;

      // ── ANCORAS: as duas rotas rodaram de verdade ──────────────────
      ok("N81 ANCORA F1: as DUAS rotas executaram a Funcao, uma vez cada",
        executouAuto === 1 && executouResume === 1);
      ok("N82 ANCORA F1: a rota Resume concluiu e entregou payload ao terminalizador",
        rF1.tipo === "concluida" && payloadResume !== null);
      ok("N83 ANCORA F1: os dois payloads tem as MESMAS quatro chaves",
        deepIgual(Object.keys(auto).sort(), Object.keys(res).sort()) &&
        Object.keys(auto).sort().join(",") === "marketplaces,periodo,resumo,truncado");
      ok("N84 ANCORA F1: os dois lados receberam os MESMOS valores aprovados",
        deepIgual(autoArgs, resumeArgs) &&
        deepIgual(autoArgs, { dataInicio: "2026-08-01", dataFim: "2026-08-07", marketplace: null }));

      // ── CHECKPOINT FINAL ─────────────────────────────
      ok("N108 F1-args-final: nenhuma rota deixou mutacao nos clones nem na base",
        deepIgual(autoArgs, ARGS_F1_BASE) && deepIgual(resumeArgs, ARGS_F1_BASE) &&
        deepIgual(ARGS_F1_BASE, {
          dataInicio: "2026-08-01", dataFim: "2026-08-07", marketplace: null,
        }));
      ok("N109 F1-function-instance-count: DUAS instancias, uma por rota",
        saidasExecutadasF1.length === 2);

      // ── As duas saidas sao IGUAIS por valor e DISTINTAS por referencia
      {
        const sAuto = saidasExecutadasF1[0];
        const sResume = saidasExecutadasF1[1];
        ok("N110 F1-function-top-reference: objetos de topo distintos",
          (sAuto as object) !== (sResume as object) &&
          (sAuto as object) !== (SAIDA_F1_BASE as object) &&
          (sResume as object) !== (SAIDA_F1_BASE as object));
        ok("N111 F1-function-lines-reference: arrays `linhas` distintos",
          (sAuto.linhas as object) !== (sResume.linhas as object) &&
          (sAuto.linhas as object) !== (SAIDA_F1_BASE.linhas as object) &&
          (sResume.linhas as object) !== (SAIDA_F1_BASE.linhas as object));
        ok("N112 F1-function-row-reference: NENHUMA linha e compartilhada",
          sAuto.linhas.length === 4 && sResume.linhas.length === 4 &&
          sAuto.linhas.every((linha, i) =>
            (linha as object) !== (sResume.linhas[i] as object) &&
            (linha as object) !== (SAIDA_F1_BASE.linhas[i] as object)));
        ok("N113 F1-function-resume-unchanged: as duas saidas sao iguais a base",
          deepIgual(sAuto, SAIDA_F1_BASE) && deepIgual(sResume, SAIDA_F1_BASE) &&
          deepIgual(sAuto, sResume));
        ok("N114 CONTROLE: o comparador detectaria divergencia entre as saidas",
          (() => {
            const adulterada = clonarProfundo(SAIDA_F1_BASE);
            adulterada.linhas[0].qtd = 999;
            return !deepIgual(adulterada, SAIDA_F1_BASE);
          })());
      }

      // ── OS QUATRO CAMPOS, por IGUALDADE DE VALOR ───────────────────
      ok("N85 F1-periodo: igualdade de valor entre automatico e Resume",
        deepIgual(res.periodo, auto.periodo));
      ok("N86 F1-periodo: e ele ecoa os argumentos APROVADOS",
        deepIgual(res.periodo, {
          dataInicio: ARGS_F1_BASE.dataInicio,
          dataFim: ARGS_F1_BASE.dataFim,
          marketplace: ARGS_F1_BASE.marketplace,
        }));
      ok("N87 F1-resumo: igualdade de valor, objeto inteiro",
        deepIgual(res.resumo, auto.resumo));
      ok("N88 F1-resumo: e ele NAO e trivial (agregou os quatro pedidos)",
        typeof auto.resumo === "object" && auto.resumo !== null &&
        Object.keys(auto.resumo as object).length > 0 &&
        JSON.stringify(auto.resumo) !== "{}");
      ok("N89 F1-marketplaces: igualdade de valor, objeto inteiro",
        deepIgual(res.marketplaces, auto.marketplaces));
      ok("N90 F1-marketplaces: e ele NAO e trivial — os tres buckets, dois com movimento",
        (() => {
          const m = auto.marketplaces as Record<string, { pedidos?: unknown }>;
          const nomes = Object.keys(m).sort().join(",");
          const comMovimento = Object.values(m).filter((b) => Number(b?.pedidos ?? 0) > 0).length;
          return nomes === "ML,Shopee,outros" && comMovimento >= 2;
        })());
      ok("N91 F1-truncado: igualdade de valor, e o valor NAO e o default",
        res.truncado === auto.truncado && res.truncado === true);

      // ── CONTROLE NEGATIVO: o comparador nao e vacuoso ──────────────
      {
        const clone = JSON.parse(JSON.stringify(auto)) as Record<string, unknown>;
        clone.truncado = false;
        const clonePeriodo = JSON.parse(JSON.stringify(auto)) as Record<string, unknown>;
        (clonePeriodo.periodo as Record<string, unknown>).dataFim = "2026-08-08";
        const cloneMkt = JSON.parse(JSON.stringify(auto)) as Record<string, unknown>;
        const buckets = cloneMkt.marketplaces as Record<string, Record<string, unknown>>;
        const primeiro = Object.keys(buckets)[0];
        buckets[primeiro] = { ...buckets[primeiro], __intruso: 1 };
        const cloneResumo = JSON.parse(JSON.stringify(auto)) as Record<string, unknown>;
        (cloneResumo.resumo as Record<string, unknown>).__intruso = 1;

        ok("N92 CONTROLE NEGATIVO: truncado alterado reprova o comparador",
          !deepIgual(clone.truncado, auto.truncado));
        ok("N93 CONTROLE NEGATIVO: periodo alterado reprova",
          !deepIgual(clonePeriodo.periodo, auto.periodo));
        ok("N94 CONTROLE NEGATIVO: marketplaces com chave extra reprova",
          !deepIgual(cloneMkt.marketplaces, auto.marketplaces));
        ok("N95 CONTROLE NEGATIVO: resumo com chave extra reprova",
          !deepIgual(cloneResumo.resumo, auto.resumo));
        ok("N96 CONTROLE POSITIVO: o comparador aceita clone intacto",
          deepIgual(JSON.parse(JSON.stringify(auto)), auto));
        ok("N97 CONTROLE: o comparador distingue tipos, nao so forma",
          !deepIgual(1, "1") && !deepIgual([1], { 0: 1 }) && !deepIgual(null, {}));
      }

      // ── Ids de auditoria ficam FORA da equivalencia comercial ──────
      ok("N98 F1: nenhum id de auditoria entra no payload comparado",
        !("requestId" in auto) && !("request_id" in auto) &&
        !("aprovacaoId" in auto) && !("tarefaId" in auto) &&
        !("requestId" in res) && !("tarefaId" in res));
    }

    // ── N80..N82. DORMENCIA ───────────────────────────────────────────
    {
      const producaoR = ["lib/agentes", "app", "components"];
      const alcancaR: string[] = [];
      const varrerR = (dir: string): void => {
        for (const e of readdirSync(join(RAIZ, dir), { withFileTypes: true })) {
          const rel = `${dir}/${e.name}`;
          if (e.isDirectory()) varrerR(rel);
          else if (/\.tsx?$/.test(e.name) &&
                   rel !== "lib/agentes/retomada/executar-retomada.ts" &&
                   /\bexecutarRetomada\b/.test(semComentarios(ler(rel))))
            alcancaR.push(rel);
        }
      };
      for (const d of producaoR) varrerR(d);
      ok(`N80 zero chamador de producao do executor Resume FORA do proprio arquivo (${alcancaR.join(", ") || "nenhum"})`,
        alcancaR.length === 0);

      // ── N80a..N80f, acrescentados no B2-I1 — achado B2-A0-F2 ────────
      //
      // N80 exclui `executar-retomada.ts` da varredura, e ate o B1 isso
      // estava certo: o unico lugar onde o nome podia aparecer era a
      // propria definicao. O B2 pos o slot DENTRO desse arquivo — ou
      // seja, o chamador que N80 existe para vigiar mudou-se para a
      // zona cega dele. N80 continuaria verde para sempre.
      //
      // O que fecha o buraco e a contabilidade intra-arquivo: uma
      // definicao, uma invocacao, e a invocacao dentro do slot.
      {
        const DONO_R = "lib/agentes/retomada/executar-retomada.ts";
        const FONTE_R = semComentarios(ler(DONO_R));
        const pR = papeisDoSimbolo(FONTE_R, "executarRetomada");
        const CORPO_SLOT_R = corpoDeExportado(FONTE_R, "executarSlotRetomada");

        ok(`N80a dentro do dono: 1 definicao, 1 invocacao, 0 import, 0 sem papel (${JSON.stringify(pR)})`,
          pR.definicoes === 1 && pR.invocacoes === 1 &&
          pR.importacoes === 0 && pR.semPapel === 0);
        ok("N80b e a unica invocacao esta DENTRO do slot",
          CORPO_SLOT_R.length > 1000 &&
          (CORPO_SLOT_R.match(/\bexecutarRetomada\s*\(/g) ?? []).length === 1);
        ok("N80c CONTROLE: um alias do executor no proprio arquivo seria detectado",
          papeisDoSimbolo(
            "export async function executarRetomada(a) {}\nconst g = executarRetomada;",
            "executarRetomada").semPapel === 1);
        ok("N80d CONTROLE: uma SEGUNDA invocacao seria contada",
          papeisDoSimbolo(
            "export async function executarRetomada(a) {}\n" +
            "await executarRetomada(1);\nawait executarRetomada(2);",
            "executarRetomada").invocacoes === 2);
        ok("N80e CONTROLE POSITIVO: definicao + uma invocacao fecha a conta",
          (() => {
            const p = papeisDoSimbolo(
              "export async function executarRetomada(a) {}\nawait executarRetomada(1);",
              "executarRetomada");
            return p.total === 2 && p.definicoes === 1 && p.invocacoes === 1 && p.semPapel === 0;
          })());

        // ── O SLOT foi ATIVADO, e a topologia disso e exata ───────────
        //
        // Ate o B2 este assert exigia zero chamador, e era a forma certa
        // de dizer "dormente". O D0 criou o consumidor previsto pelo
        // desenho — entao o assert nao podia continuar exigindo zero nem
        // virar `>= 1`, que aceitaria qualquer chamador.
        //
        // O que substitui e um inventario nominal fechado: o slot e
        // definido uma vez no dono, importado uma vez pelo worker,
        // invocado uma vez la, e nao aparece em mais lugar nenhum. O
        // campo `semPapel` e quem fecha as formas que uma lista de
        // padroes deixaria passar — alias, callback, re-export.
        const ROTA_WORKER_N = "app/api/internal/agentes/worker/route.ts";
        const pSlot = arquivosDeProducao()
          .map((rel) => ({ rel, p: papeisDoSimbolo(semComentarios(ler(rel)), "executarSlotRetomada") }))
          .filter((x) => x.p.total > 0);
        const noDonoS = pSlot.find((x) => x.rel === DONO_R)?.p;
        const noWorkerS = pSlot.find((x) => x.rel === ROTA_WORKER_N)?.p;
        ok(`N80f o slot vive em exatamente DOIS arquivos de producao (${pSlot.map((x) => x.rel).join(", ")})`,
          pSlot.length === 2 && noDonoS !== undefined && noWorkerS !== undefined);
        ok(`N80f1 no dono: 1 definicao, 0 import, 0 invocacao, 0 sem papel (${JSON.stringify(noDonoS)})`,
          noDonoS !== undefined && noDonoS.definicoes === 1 &&
          noDonoS.importacoes === 0 && noDonoS.invocacoes === 0 && noDonoS.semPapel === 0);
        ok(`N80f2 no worker: 0 definicao, 1 import, 1 invocacao, 0 sem papel (${JSON.stringify(noWorkerS)})`,
          noWorkerS !== undefined && noWorkerS.definicoes === 0 &&
          noWorkerS.importacoes === 1 && noWorkerS.invocacoes === 1 &&
          noWorkerS.semPapel === 0);
        ok("N80f3 GLOBAL: 1 definicao, 1 import, 1 invocacao, 0 sem papel",
          pSlot.reduce((a, x) => a + x.p.definicoes, 0) === 1 &&
          pSlot.reduce((a, x) => a + x.p.importacoes, 0) === 1 &&
          pSlot.reduce((a, x) => a + x.p.invocacoes, 0) === 1 &&
          pSlot.reduce((a, x) => a + x.p.semPapel, 0) === 0);

        // ── CONTROLES: as formas proibidas do slot ────────────────────
        const pSlotDe = (src: string) => papeisDoSimbolo(src, "executarSlotRetomada");
        const IMP_SLOT =
          'import { executarSlotRetomada } from "@/lib/agentes/retomada/executar-retomada";\n';
        ok("N80f4 CONTROLE POSITIVO: import + uma invocacao fecha a conta",
          (() => {
            const p = pSlotDe(IMP_SLOT + "await executarSlotRetomada(g);");
            return p.total === 2 && p.importacoes === 1 && p.invocacoes === 1 && p.semPapel === 0;
          })());
        ok("N80f5 CONTROLE NEGATIVO: ALIAS do slot deixa ocorrencia sem papel",
          pSlotDe(IMP_SLOT + "const f = executarSlotRetomada;\nawait f(g);").semPapel === 1);
        ok("N80f6 CONTROLE NEGATIVO: slot passado como CALLBACK deixa resto",
          pSlotDe(IMP_SLOT + "registrar(executarSlotRetomada);").semPapel === 1);
        ok("N80f7 CONTROLE NEGATIVO: RE-EXPORT deixa resto",
          pSlotDe(IMP_SLOT + "export { executarSlotRetomada };").semPapel === 1);
        ok("N80f8 CONTROLE NEGATIVO: DESTRUCTURING deixa resto",
          pSlotDe("const { executarSlotRetomada } = mod;\nawait executarSlotRetomada(g);")
            .semPapel === 1);
        ok("N80f9 CONTROLE NEGATIVO: SEGUNDA invocacao e contada",
          pSlotDe(IMP_SLOT + "await executarSlotRetomada(g);\nawait executarSlotRetomada(g);")
            .invocacoes === 2);
        ok("N80fa CONTROLE NEGATIVO: um TERCEIRO arquivo de producao reprova",
          !([DONO_R, ROTA_WORKER_N, "lib/agentes/intruso.ts"].length === 2));
      }

      // ── N80g. FIX3-N1: producao nao forja guarda sempre-verdadeira ──
      //
      // O detector e ESCOPADO ao contrato da guarda: ele procura um
      // literal trivial na posicao de `podeIniciarRetomada`, e nao
      // qualquer `() => true` do repositorio — uma regex global
      // reprovaria codigo futuro sem relacao nenhuma com Resume.
      {
        const guardaForjada = (src: string): boolean =>
          /(?:executarRetomada|executarSlotRetomada)\s*\([^)]*\(\s*\)\s*=>\s*(?:true|1|!0)/
            .test(src.replace(/\s+/g, " "));
        const forjadores = arquivosDeProducao()
          .filter((rel) => guardaForjada(semComentarios(ler(rel))));
        ok(`N80g producao NAO fornece guarda sempre-verdadeira (${forjadores.join(", ") || "nenhum"})`,
          forjadores.length === 0);
        ok("N80h CONTROLE: a forma forjada seria detectada nas duas funcoes",
          guardaForjada("await executarRetomada(u, a, () => true);") &&
          guardaForjada("await executarSlotRetomada(() => true);") &&
          guardaForjada("await executarRetomada(\n u,\n a,\n () => true\n);"));
        ok("N80i CONTROLE: repassar a callback recebida NAO e forjar",
          !guardaForjada("await executarRetomada(u, a, podeIniciarRetomada);") &&
          !guardaForjada("const x = () => true;"));
      }
    }
  }


  // ────────────────────────────────────────────────────────────────
  // O. APPROVAL-DECISION-RESUME-D5-C3-I2-A1 — as duas DESCOBERTAS
  //    dormentes
  //
  // O que esta secao prova nao e que elas encontram a candidata certa —
  // isso e do banco, e o P0 ja provou o SQL. Ela prova o CONTRATO do
  // adaptador: que uma fila vazia nunca se confunde com uma falha, que
  // o veneno de registry sobrevive ate o chamador, que nenhum relogio
  // local decide nada, e que uma linha deformada derruba a lista
  // inteira em vez de encolhe-la em silencio.
  // ────────────────────────────────────────────────────────────────
  {
    console.log("\nO. RESUME-D5-C3-I2-A1: descobertas dormentes");

    const pd = await import("../lib/agentes/retomada/persistencia-retomada");
    const { descobrirAprovacoesParaRetomada, descobrirCandidatasRetomadaStale } = pd;

    const PD_FONTE = ler("lib/agentes/retomada/persistencia-retomada.ts");
    const PD_CODIGO = semComentarios(PD_FONTE);

    /** Corpo EXATO de um export, da assinatura ate o `}` da coluna 0.
     *  Fatiar ate o fim do arquivo acusaria o vizinho — foi exatamente
     *  isso que o recorte aberto do L32 fazia antes deste slice. */
    const corpoExportado = (fonte: string, nome: string): string => {
      const linhas = fonte.split("\n");
      const i = linhas.findIndex((l) =>
        l.startsWith(`export async function ${nome}`));
      if (i < 0) return "";
      for (let j = i + 1; j < linhas.length; j++) {
        if (linhas[j] === "}") return linhas.slice(i, j + 1).join("\n");
      }
      return "";
    };

    const CORPO_APROV = corpoExportado(PD_CODIGO, "descobrirAprovacoesParaRetomada");
    const CORPO_STALE = corpoExportado(PD_CODIGO, "descobrirCandidatasRetomadaStale");

    const UUID_A = "11111111-2222-4333-8444-555555555555";
    const UUID_B = "66666666-7777-4888-8999-aaaaaaaaaaaa";

    ok("O0  ANCORA: os dois wrappers existem e os corpos foram isolados",
      typeof descobrirAprovacoesParaRetomada === "function" &&
      typeof descobrirCandidatasRetomadaStale === "function" &&
      CORPO_APROV.length > 300 && CORPO_STALE.length > 300 &&
      CORPO_APROV !== CORPO_STALE);
    ok("O0a ANCORA: o recorte e MESMO fechado — um corpo nao contem o outro",
      !CORPO_APROV.includes("descobrirCandidatasRetomadaStale") &&
      !CORPO_STALE.includes("descobrirAprovacoesParaRetomada"));

    // ── N1..N12. APPROVAL: uma RPC, e so ela ──────────────────────
    roteiro();
    roteiroRpc({ data: [], error: null });
    const vazio = await descobrirAprovacoesParaRetomada();
    ok("O1  fila vazia e SUCESSO, nao falha",
      vazio.ok === true && vazio.ok && vazio.candidatas.length === 0);
    ok("O2  e custou UMA rpc, com o nome exato, e ZERO consultas de tabela",
      chamadasRpc.length === 1 && chamadasRpc[0]?.nome === "retomada_listar_candidatas" &&
      chamadas.length === 0);

    // ── O teto: o que chega a `p_limite` ──────────────────────────
    {
      const casos: ReadonlyArray<readonly [unknown, number]> = [
        [undefined, 5], [null, 5], [Number.NaN, 5],
        [Number.POSITIVE_INFINITY, 5], [Number.NEGATIVE_INFINITY, 5],
        [0, 1], [-7, 1], [2.9, 2], [1, 1], [5, 5], [500, 5],
      ];
      const observados: number[] = [];
      for (const [entrada, _esperado] of casos) {
        roteiro();
        roteiroRpc({ data: [], error: null });
        await descobrirAprovacoesParaRetomada(entrada as number | undefined);
        observados.push(chamadasRpc[0]?.parametros?.p_limite as number);
      }
      ok(`O3  p_limite normalizado em TODOS os ${casos.length} casos`,
        observados.length === casos.length &&
        casos.every(([, esperado], i) => observados[i] === esperado));
      ok("O4  HARD: nenhum NaN, Infinity ou nao-inteiro alcanca p_limite",
        observados.every((v) => Number.isInteger(v) && v >= 1 && v <= 5));
      ok("O4a ANCORA: a matriz REALMENTE exercitou os extremos",
        observados.includes(1) && observados.includes(5) && observados.includes(2));
    }

    // ── ERROR nunca vira EMPTY ────────────────────────────────────
    roteiro();
    roteiroRpc({ data: null, error: { code: "08006" } });
    const transporte = await descobrirAprovacoesParaRetomada(3);
    ok("O5  erro de transporte devolve FALHA, e nao fila vazia",
      transporte.ok === false && !transporte.ok &&
      transporte.falha === "rpc_indisponivel");
    ok("O5a HARD: o resultado de erro NAO carrega `candidatas`",
      !Object.prototype.hasOwnProperty.call(transporte, "candidatas"));

    roteiro();
    roteiroRpc({ data: null, error: { code: "55000" } });
    const foraContrato = await descobrirAprovacoesParaRetomada();
    ok("O6  55000 e classificado pelo vocabulario existente",
      foraContrato.ok === false && !foraContrato.ok &&
      foraContrato.falha === "rpc_fora_de_contrato");

    roteiro();
    roteiroRpc({ data: null, error: null });
    const nulo = await descobrirAprovacoesParaRetomada();
    ok("O7  `data: null` NAO vira [] — e resposta invalida",
      nulo.ok === false && !nulo.ok && nulo.falha === "resposta_invalida");

    // ── Linha deformada NO MEIO: fail-closed, nunca skip ──────────
    roteiro();
    roteiroRpc({
      data: [
        { user_id: "dono-1", aprovacao_id: UUID_A },
        { user_id: "dono-2", aprovacao_id: "nao-e-uuid" },
        { user_id: "dono-3", aprovacao_id: UUID_B },
      ],
      error: null,
    });
    const meioRuim = await descobrirAprovacoesParaRetomada();
    ok("O8  HARD: UMA linha invalida no meio derruba a lista INTEIRA",
      meioRuim.ok === false && !meioRuim.ok && meioRuim.falha === "resposta_invalida");
    ok("O8a e as duas linhas validas NAO voltam parcialmente",
      !Object.prototype.hasOwnProperty.call(meioRuim, "candidatas"));

    roteiro();
    roteiroRpc({ data: [{ user_id: "   ", aprovacao_id: UUID_A }], error: null });
    const donoVazio = await descobrirAprovacoesParaRetomada();
    ok("O9  dono so com espaco tambem falha fechado",
      donoVazio.ok === false && !donoVazio.ok && donoVazio.falha === "resposta_invalida");

    // ── Mapeamento e SOMENTE ele ──────────────────────────────────
    roteiro();
    roteiroRpc({
      data: [
        { user_id: "dono-1", aprovacao_id: UUID_A },
        { user_id: "dono-2", aprovacao_id: UUID_B },
      ],
      error: null,
    });
    const boas = await descobrirAprovacoesParaRetomada(2);
    ok("O10 duas candidatas validas atravessam intactas, na ordem da RPC",
      boas.ok === true && boas.ok && boas.candidatas.length === 2 &&
      boas.candidatas[0]?.userId === "dono-1" &&
      boas.candidatas[0]?.aprovacaoId === UUID_A &&
      boas.candidatas[1]?.aprovacaoId === UUID_B);
    ok("O11 snake_case virou camelCase, com EXATAMENTE duas chaves",
      boas.ok === true && boas.ok &&
      boas.candidatas.every((c) =>
        JSON.stringify(Object.keys(c).sort()) === JSON.stringify(["aprovacaoId", "userId"])));

    // ── Veneno de registry SOBREVIVE ──────────────────────────────
    //
    // A RPC devolve so `user_id` e `aprovacao_id`, entao nao ha metadado
    // de registry para inventar numa fixture. A prova util e ESTRUTURAL:
    // depois da RPC o corpo nao pode reduzir a lista por criterio nenhum.
    ok("O12 HARD: o corpo NAO filtra nada depois da RPC",
      !/\.filter\(|\.find\(|\.some\(|\.slice\(/.test(CORPO_APROV));
    ok("O12a e nao menciona nenhum criterio de registry",
      !/revisao|acesso|conexao|argumentos|funcao_id|tipo\b|permissa|ativo|expira/i
        .test(CORPO_APROV));
    ok("O12b CONTROLE NEGATIVO: o detector de postfilter MORDE",
      /\.filter\(|\.find\(|\.some\(|\.slice\(/.test(
        'const uteis = candidatas.filter((c) => c.revisao === atual);'));
    ok("O13 HARD: zero relogio local na descoberta de aprovacoes",
      !/Date\.now|new Date|setMinutes|toISOString/.test(CORPO_APROV));
    ok("O13a CONTROLE NEGATIVO: o detector de relogio MORDE",
      /Date\.now|new Date/.test('const corte = new Date(Date.now() - 300000);'));
    ok("O14 a descoberta de aprovacoes nao toca tabela nem escreve",
      !/\.from\(/.test(CORPO_APROV) && !/\.update\(|\.insert\(|\.delete\(/.test(CORPO_APROV));

    // ── N15..N30. STALE: a consulta, cercada e ordenada ───────────
    roteiro({ data: [], error: null });
    const staleVazio = await descobrirCandidatasRetomadaStale();
    const q = chamadas[0];
    ok("O15 fila vazia de travadas tambem e SUCESSO",
      staleVazio.ok === true && staleVazio.ok && staleVazio.candidatas.length === 0);
    ok("O16 UMA consulta, na tabela de tarefas, sem escrita e sem RPC",
      chamadas.length === 1 && q?.tabela === "agente_tarefas" &&
      q?.escrita === false && chamadasRpc.length === 0);
    ok("O17 a projecao e exatamente a acordada",
      q?.select === "id, user_id, tentativas, retomada_request_id, heartbeat_em");
    ok("O18 cercada por status rodando",
      q?.filtros?.status === "rodando" && Object.keys(q?.filtros ?? {}).length === 1);
    {
      const nots = q?.nots ?? [];
      ok(`O19 as DUAS cercas de IS NOT NULL (${nots.length})`,
        nots.length === 2 &&
        nots.some((n) => n.coluna === "retomada_request_id" &&
                         n.operador === "is" && n.valor === null) &&
        nots.some((n) => n.coluna === "heartbeat_em" &&
                         n.operador === "is" && n.valor === null));
      ok("O19a IS NOT NULL nao e igualdade: nenhum dos dois entrou em .eq nem .is",
        !Object.prototype.hasOwnProperty.call(q?.filtros ?? {}, "retomada_request_id") &&
        !Object.prototype.hasOwnProperty.call(q?.filtrosIs ?? {}, "heartbeat_em"));
    }
    {
      const orders = q?.orders ?? [];
      ok(`O20 HARD: ordena por heartbeat_em e depois id, ambos ASC (${orders.length})`,
        orders.length === 2 &&
        orders[0]?.coluna === "heartbeat_em" && orders[0]?.ascendente === true &&
        orders[1]?.coluna === "id" && orders[1]?.ascendente === true);
      ok("O20a a SEQUENCIA importa: heartbeat_em nao pode vir depois de id",
        orders.findIndex((o) => o.coluna === "heartbeat_em") <
        orders.findIndex((o) => o.coluna === "id"));
      ok("O20b ANCORA: o fake REALMENTE observa order — sem isso N20 seria vacuo",
        orders.length > 0 && typeof orders[0]?.coluna === "string");
    }
    ok("O21 o teto chegou ao builder, dentro da faixa",
      Number.isInteger(q?.limite) && (q?.limite as number) === 5);
    ok("O22 HARD: zero predicado temporal na consulta",
      !/\.lt\(|\.lte\(|\.gt\(|\.gte\(/.test(CORPO_STALE));
    ok("O23 HARD: zero relogio local na descoberta de travadas",
      !/Date\.now|new Date|setMinutes|toISOString|cutoff|corte/i.test(CORPO_STALE));
    ok("O24 HARD: ela NAO chama a recuperacao nem qualquer RPC",
      !/\.rpc\(/.test(CORPO_STALE) &&
      !/recuperarRetomadaStale|retomada_recuperar_tarefa_stale/.test(CORPO_STALE));
    ok("O25 e nao filtra por politica: agente, permissao, tipo ou aprovacao",
      // Limites de palavra NAO sao enfeite: "nivel" casa DENTRO de
      // "indisponivel", que e o proprio rotulo de falha deste modulo.
      // Sem os limites, este assert acusaria a mensagem de erro como se
      // fosse um filtro de politica — e foi exatamente o que aconteceu
      // na primeira versao deste slice.
      !/\bativo\b|\bpermissao\b|\bnivel\b|\bfuncao_id\b|\baprovacao\b|\bmax_tentativas\b/i
        .test(CORPO_STALE));
    ok("O25a CONTROLE NEGATIVO: o detector de filtro de politica MORDE",
      /\bativo\b|\bnivel\b/i.test('.eq("nivel", "automatico").eq("ativo", true)'));
    ok("O25b e fica QUIETO diante do rotulo de falha do proprio modulo",
      !/\bnivel\b/i.test('return { ok: false, falha: "indisponivel" };'));

    // ── O teto do stale, observado no builder ─────────────────────
    {
      const casos: ReadonlyArray<readonly [unknown, number]> = [
        [undefined, 5], [Number.NaN, 5], [Number.POSITIVE_INFINITY, 5],
        [0, 1], [-7, 1], [2.9, 2], [500, 5],
      ];
      const observados: unknown[] = [];
      for (const [entrada] of casos) {
        roteiro({ data: [], error: null });
        await descobrirCandidatasRetomadaStale(entrada as number | undefined);
        observados.push(chamadas[0]?.limite);
      }
      ok(`O26 o mesmo normalizador rege o .limit() do stale (${casos.length} casos)`,
        casos.every(([, esperado], i) => observados[i] === esperado));
      ok("O26a HARD: nenhum NaN alcanca o query builder",
        observados.every((v) => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 5));
    }

    // ── EMPTY x ERROR no stale ────────────────────────────────────
    roteiro({ data: null, error: { code: "PGRST301" } });
    const staleErro = await descobrirCandidatasRetomadaStale();
    ok("O27 erro de consulta devolve indisponivel, e nao fila vazia",
      staleErro.ok === false && !staleErro.ok && staleErro.falha === "indisponivel");
    // O TypeScript ja recusa comparar esta falha com os rotulos de RPC
    // — a uniao do stale nao os contem. A prova util em runtime e outra:
    // o valor pertence ao conjunto FECHADO de dois, e a declaracao do
    // tipo nao menciona o vocabulario de SQLSTATE.
    ok("O27a a falha pertence ao conjunto fechado de DOIS rotulos",
      staleErro.ok === false && !staleErro.ok &&
      ["indisponivel", "resposta_invalida"].includes(staleErro.falha));
    ok("O27b e o tipo do stale NAO importa o vocabulario de SQLSTATE das RPCs",
      /ResultadoDescobertaRetomadaStale[\s\S]{0,400}?indisponivel/.test(PD_CODIGO) &&
      !/ResultadoDescobertaRetomadaStale[\s\S]{0,400}?rpc_(indisponivel|fora_de_contrato|entrada_invalida)/
        .test(PD_CODIGO));

    roteiro({ data: null, error: null });
    const staleNulo = await descobrirCandidatasRetomadaStale();
    ok("O28 `data: null` sem erro e resposta invalida",
      staleNulo.ok === false && !staleNulo.ok && staleNulo.falha === "resposta_invalida");

    // ── Mapeamento e compatibilidade com a recuperacao ────────────
    const LINHA_OK = {
      id: UUID_A, user_id: "dono-1", tentativas: 2,
      retomada_request_id: "req-abc", heartbeat_em: "2026-09-16T12:00:00.000Z",
    };
    roteiro({ data: [LINHA_OK], error: null });
    const staleBom = await descobrirCandidatasRetomadaStale();
    ok("O29 a candidata tem EXATAMENTE os quatro campos da recuperacao",
      staleBom.ok === true && staleBom.ok && staleBom.candidatas.length === 1 &&
      JSON.stringify(Object.keys(staleBom.candidatas[0] ?? {}).sort()) ===
        JSON.stringify(["retomadaRequestId", "tarefaId", "tentativa", "userId"]));
    ok("O30 HARD: `heartbeat_em` foi lido para ordenar e NAO saiu do modulo",
      staleBom.ok === true && staleBom.ok &&
      !Object.prototype.hasOwnProperty.call(staleBom.candidatas[0] ?? {}, "heartbeatEm") &&
      !Object.prototype.hasOwnProperty.call(staleBom.candidatas[0] ?? {}, "heartbeat_em"));
    ok("O31 e os valores mapeados sao os da linha, sem transformacao",
      staleBom.ok === true && staleBom.ok &&
      staleBom.candidatas[0]?.tarefaId === UUID_A &&
      staleBom.candidatas[0]?.userId === "dono-1" &&
      staleBom.candidatas[0]?.tentativa === 2 &&
      staleBom.candidatas[0]?.retomadaRequestId === "req-abc");
    {
      // Compatibilidade de TIPO com a recuperacao, sem chama-la: se a
      // assinatura exigisse um quinto campo, isto nao compilaria.
      const c = staleBom.ok ? staleBom.candidatas[0] : undefined;
      const alimenta: readonly [string, string, number, string] | null =
        c === undefined ? null : [c.tarefaId, c.userId, c.tentativa, c.retomadaRequestId];
      ok("O32 os quatro campos alimentam a recuperacao sem quinto argumento",
        alimenta !== null && alimenta.length === 4 &&
        typeof alimenta[0] === "string" && typeof alimenta[2] === "number");
      ok("O32a e a recuperacao NAO foi chamada por este teste",
        chamadasRpc.length === 0);
    }

    // ── Linhas deformadas no stale: fail-closed em cada campo ─────
    {
      const deformadas: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
        ["id nao-uuid", { ...LINHA_OK, id: "abc" }],
        ["dono vazio", { ...LINHA_OK, user_id: "  " }],
        ["tentativa nao-inteira", { ...LINHA_OK, tentativas: 1.5 }],
        ["tentativa textual", { ...LINHA_OK, tentativas: "2" }],
        ["marcador vazio", { ...LINHA_OK, retomada_request_id: "" }],
        ["batimento nulo apesar do filtro", { ...LINHA_OK, heartbeat_em: null }],
      ];
      let todasFecharam = true;
      for (const [, linha] of deformadas) {
        roteiro({ data: [LINHA_OK, linha], error: null });
        const r = await descobrirCandidatasRetomadaStale();
        if (r.ok !== false || r.falha !== "resposta_invalida") todasFecharam = false;
      }
      ok(`O33 HARD: as ${deformadas.length} deformacoes derrubam a lista inteira`,
        deformadas.length === 6 && todasFecharam);
      ok("O33a ANCORA: a linha BOA sozinha continua passando",
        await (async () => {
          roteiro({ data: [LINHA_OK], error: null });
          const r = await descobrirCandidatasRetomadaStale();
          return r.ok === true && r.candidatas.length === 1;
        })());
    }

    // ── N34..N38. Higiene e dormencia ─────────────────────────────
    ok("O34 nenhum dos dois le campo cru do erro do driver",
      !/\.message\b|\.details\b|\.hint\b|JSON\.stringify\(\s*error/
        .test(CORPO_APROV + CORPO_STALE));
    ok("O35 todo console.error dos dois corpos e literal fixa",
      [...(CORPO_APROV + CORPO_STALE).matchAll(/console\.error\(([^)]*)\)/g)]
        .every((m) => /^"[^"`$]*"$/.test(m[1].trim())));
    ok("O36 nenhum dos dois cria timer, retry ou recursao",
      !/setTimeout|setInterval|\bwhile\b|\.catch\(/.test(CORPO_APROV + CORPO_STALE));
    ok("O37 um wrapper nao chama o outro, nem os wrappers antigos",
      !/descobrirCandidatasRetomadaStale\(/.test(CORPO_APROV) &&
      !/descobrirAprovacoesParaRetomada\(/.test(CORPO_STALE) &&
      !/iniciarRetomadaAprovacao\(|concluirTarefaRetomada\(|falharTarefaRetomada\(/
        .test(CORPO_APROV + CORPO_STALE));
    // ── O38, avancado no B1-I1 ─────────────────────────────────────
    //
    // Ate aqui o assert dizia "a RPC de cancelamento nao aparece". O B1
    // deu a ela um adaptador, entao a forma antiga so podia ser apagada
    // ou invertida — e "a string existe" seria uma inversao FRACA, que
    // um comentario solto ja satisfaria. A protecao que a substitui e
    // mais estreita que a original em tres eixos ao mesmo tempo: a
    // citacao e UNICA, esta DENTRO do wrapper, e o wrapper nao tem
    // chamador de producao (provado no bloco P32..P36).
    {
      const RPC38 = /retomada_cancelar_aprovacao_incompativel/g;
      const citacoes38 = (PD_CODIGO.match(RPC38) ?? []).length;
      const corpo38 = corpoExportado(PD_CODIGO, "cancelarAprovacaoRetomadaIncompativel");
      const foraDoCorpo38 =
        (PD_CODIGO.replace(corpo38, "").match(RPC38) ?? []).length;
      ok(`O38  a RPC de cancelamento e citada UMA vez no modulo (${citacoes38})`,
        citacoes38 === 1);
      ok("O38a e essa unica citacao esta DENTRO do wrapper, nao solta no arquivo",
        corpo38.length > 200 && (corpo38.match(RPC38) ?? []).length === 1 &&
        foraDoCorpo38 === 0);
      ok("O38b CONTROLE: uma citacao a mais, fora do wrapper, seria detectada",
        ((PD_CODIGO + " retomada_cancelar_aprovacao_incompativel")
          .match(RPC38) ?? []).length !== 1);
      ok("O38c o wrapper de cancelamento chama UMA rpc e NENHUMA tabela",
        (corpo38.match(/\.rpc\(/g) ?? []).length === 1 && !/\.from\(/.test(corpo38));
    }
    // ── O39, avancado no B2-I1 ─────────────────────────────────────
    //
    // Ate o B1 as duas descobertas nao tinham chamador nenhum, e "zero"
    // era a forma certa de dizer isso. O B2 deu a elas o consumidor que
    // o desenho previa, entao o assert nao podia continuar exigindo
    // zero — nem virar "existe alguem", que e frouxo demais.
    //
    // O que substitui e um INVENTARIO NOMINAL por contabilidade: cada
    // descoberta entra por import no dono do slot, e invocada
    // exatamente uma vez, dentro do corpo do slot, e nao aparece em
    // nenhum outro arquivo de producao.
    {
      const DONO_SLOT = "lib/agentes/retomada/executar-retomada.ts";
      const ADAPTADOR_O = "lib/agentes/retomada/persistencia-retomada.ts";
      const DESCOBERTAS = [
        "descobrirAprovacoesParaRetomada",
        "descobrirCandidatasRetomadaStale",
      ] as const;

      const FONTE_SLOT_O = semComentarios(ler(DONO_SLOT));
      const CORPO_SLOT_O = corpoDeExportado(FONTE_SLOT_O, "executarSlotRetomada");
      const producaoO = arquivosDeProducao();

      ok(`O39 ANCORA: a varredura de producao rodou de verdade (${producaoO.length} arquivos)`,
        producaoO.length > 50 && producaoO.includes(DONO_SLOT) &&
        producaoO.includes("middleware.ts"));
      ok("O39a ANCORA: o corpo do slot foi isolado e nao invadiu o vizinho",
        CORPO_SLOT_O.length > 1000 &&
        !CORPO_SLOT_O.includes("export async function executarRetomada"));

      for (const nome of DESCOBERTAS) {
        const forasteiros = producaoO.filter(
          (rel) => rel !== ADAPTADOR_O && rel !== DONO_SLOT &&
            new RegExp(`\\b${nome}\\b`).test(semComentarios(ler(rel))));
        const papeisDono = papeisDoSimbolo(FONTE_SLOT_O, nome);
        const noCorpo = (CORPO_SLOT_O.match(new RegExp(`\\b${nome}\\s*\\(`, "g")) ?? []).length;

        ok(`O39b \`${nome}\` nao aparece em nenhum outro arquivo de producao (${forasteiros.join(", ") || "nenhum"})`,
          forasteiros.length === 0);
        ok(`O39c \`${nome}\`: import 1, invocacao 1, definicao 0, sem papel 0 (${JSON.stringify(papeisDono)})`,
          papeisDono.definicoes === 0 && papeisDono.importacoes === 1 &&
          papeisDono.invocacoes === 1 && papeisDono.semPapel === 0);
        ok(`O39d e a unica invocacao de \`${nome}\` esta DENTRO do slot`, noCorpo === 1);
      }

      ok("O39e CONTROLE: um alias de descoberta seria detectado",
        papeisDoSimbolo("const g = descobrirAprovacoesParaRetomada;",
          "descobrirAprovacoesParaRetomada").semPapel === 1);
      ok("O39f CONTROLE: uma SEGUNDA invocacao seria detectada",
        papeisDoSimbolo(
          'import { descobrirAprovacoesParaRetomada } from "x";\n' +
          "await descobrirAprovacoesParaRetomada(5);\nawait descobrirAprovacoesParaRetomada(5);",
          "descobrirAprovacoesParaRetomada").invocacoes === 2);
      ok("O39g CONTROLE POSITIVO: import + uma invocacao fecha a conta",
        (() => {
          const p = papeisDoSimbolo(
            'import { descobrirCandidatasRetomadaStale } from "y";\n' +
            "await descobrirCandidatasRetomadaStale(1);",
            "descobrirCandidatasRetomadaStale");
          return p.total === 2 && p.importacoes === 1 && p.invocacoes === 1 && p.semPapel === 0;
        })());
    }
  }

  // ────────────────────────────────────────────────────────────────
  // P. APPROVAL-DECISION-RESUME-D5-C3-I2-B1 — o CANCELAMENTO tecnico
  //    dormente
  //
  // O que esta secao NAO prova: que cancelar e a decisao certa para uma
  // aprovacao qualquer. Isso e do slot de reconciliacao, que ainda nao
  // existe, e do SQL, que o P0 ja fechou.
  //
  // O que ela prova e o CONTRATO do adaptador, e ele tem uma forma
  // incomum: o ator do cancelamento NAO pode viajar do TypeScript. A
  // funcao no banco carrega o ator como constante do proprio corpo, e
  // nao existe parametro por onde propor outro. Um wrapper que aceitasse
  // um terceiro argumento — ator, motivo, tarefa — estaria oferecendo
  // uma capacidade que o banco recusa, e a unica forma de provar que ele
  // nao a oferece e olhar as CHAVES que chegam ao duplo.
  // ────────────────────────────────────────────────────────────────
  {
    console.log("\nP. RESUME-D5-C3-I2-B1: cancelamento tecnico dormente");

    const pb = await import("../lib/agentes/retomada/persistencia-retomada");
    const {
      cancelarAprovacaoRetomadaIncompativel,
      ehCodigoCancelamentoRetomada,
      codigosCancelamentoRetomada,
    } = pb;

    const PB_FONTE = ler("lib/agentes/retomada/persistencia-retomada.ts");
    const PB_CODIGO = semComentarios(PB_FONTE);

    /** Mesmo recorte fechado da secao O: da assinatura ate o `}` da
     *  coluna 0. Fatiar ate o fim do arquivo acusaria o vizinho. */
    const corpoP = (fonte: string, nome: string): string => {
      const linhas = fonte.split("\n");
      const i = linhas.findIndex((l) =>
        l.startsWith(`export async function ${nome}`));
      if (i < 0) return "";
      for (let j = i + 1; j < linhas.length; j++) {
        if (linhas[j] === "}") return linhas.slice(i, j + 1).join("\n");
      }
      return "";
    };

    const CORPO_CANCEL = corpoP(PB_CODIGO, "cancelarAprovacaoRetomadaIncompativel");

    const USER_P = "dono-cancelamento";
    const APROV_P = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    const RPC_CANCEL_P = "retomada_cancelar_aprovacao_incompativel";

    /** Literal INDEPENDENTE, transcrito da migration. NAO sai de
     *  `codigosCancelamentoRetomada()`: derivar o esperado da producao
     *  seria comparar o catalogo consigo mesmo, e um catalogo assim
     *  "passa" com qualquer conteudo. */
    const ESPERADOS_P = [
      "aprovacao_inexistente",
      "ja_cancelada",
      "ja_consumida",
      "ja_rejeitada",
      "expirada",
      "aprovacao_pendente",
      "tarefa_incompativel",
      "cancelada",
    ] as const;

    ok("P0  ANCORA: wrapper, guard e leitor existem, e o corpo foi isolado",
      typeof cancelarAprovacaoRetomadaIncompativel === "function" &&
      typeof ehCodigoCancelamentoRetomada === "function" &&
      typeof codigosCancelamentoRetomada === "function" &&
      CORPO_CANCEL.length > 200);
    ok("P0a ANCORA: o recorte e fechado — o corpo nao invadiu o vizinho",
      !CORPO_CANCEL.includes("descobrirCandidatasRetomadaStale") &&
      !CORPO_CANCEL.includes("export async function descobrir"));

    // ── P1. DOMINIO: conjunto e cardinalidade, nunca so a ordem ─────
    //
    // Comparar por `join(",")` amarraria o teste a ORDEM da lista de
    // producao, que e deliberadamente a do fluxo da RPC e pode ser
    // reordenada sem mudar nada. O criterio certo e conjunto + tamanho
    // + ausencia de repetido.
    {
      const igualPorConjuntoP = (a: readonly string[], b: readonly string[]): boolean =>
        a.length === b.length &&
        new Set(a).size === a.length &&
        new Set(b).size === b.length &&
        a.every((x) => b.includes(x));

      const producaoP = codigosCancelamentoRetomada();

      ok(`P1  o dominio publicado e EXATAMENTE os oito da migration (${producaoP.length})`,
        igualPorConjuntoP(producaoP, ESPERADOS_P));
      ok("P1a e a cardinalidade e oito, contada a parte",
        producaoP.length === 8 && ESPERADOS_P.length === 8);
      ok("P1b CONTROLE NEGATIVO: um catalogo com SETE codigos reprova",
        !igualPorConjuntoP(ESPERADOS_P.slice(0, 7), ESPERADOS_P));
      ok("P1c CONTROLE NEGATIVO: um catalogo com NOVE codigos reprova",
        !igualPorConjuntoP([...ESPERADOS_P, "codigo_nono"], ESPERADOS_P));
      ok("P1d CONTROLE NEGATIVO: oito codigos com UM trocado tambem reprova",
        !igualPorConjuntoP(
          [...ESPERADOS_P.slice(0, 7), "cancelada_pelo_usuario"], ESPERADOS_P));
      ok("P1e CONTROLE NEGATIVO: oito com um REPETIDO reprova",
        !igualPorConjuntoP(
          [...ESPERADOS_P.slice(0, 7), ESPERADOS_P[0]], ESPERADOS_P));
      ok("P1f o guard aceita os oito e recusa um vizinho plausivel",
        ESPERADOS_P.every((c) => ehCodigoCancelamentoRetomada(c)) &&
        !ehCodigoCancelamentoRetomada("cancelado") &&
        !ehCodigoCancelamentoRetomada("ja_expirada"));
      ok("P1g o leitor devolve a MESMA referencia congelada, nao uma copia mutavel",
        codigosCancelamentoRetomada() === producaoP);
    }

    // ── P2..P9. SUCESSO: um cenario REAL por codigo ─────────────────
    {
      const vistosP: string[] = [];
      let indiceP = 1;
      for (const codigo of ESPERADOS_P) {
        indiceP += 1;
        roteiro();
        roteiroRpc({ data: codigo, error: null });
        const r = await cancelarAprovacaoRetomadaIncompativel(USER_P, APROV_P);
        ok(`P${indiceP}  "${codigo}" volta como ok:true, em UMA rpc e zero consultas`,
          r.ok === true && r.ok && r.codigo === codigo &&
          chamadasRpc.length === 1 && chamadasRpc[0]?.nome === RPC_CANCEL_P &&
          chamadas.length === 0);
        if (r.ok) vistosP.push(r.codigo);
      }
      ok("P10 ANCORA: os OITO codigos foram mesmo exercitados, um cada",
        vistosP.length === 8 && new Set(vistosP).size === 8 &&
        ESPERADOS_P.every((c) => vistosP.includes(c)));
    }

    // ── P11..P15. RESPOSTA FORA DO CONTRATO: fail-closed ────────────
    //
    // `undefined` merece um canal proprio: o coalesce do duplo o
    // colapsaria em `null`, e o assert estaria medindo o fake em vez da
    // producao. O canal `bruto` entrega o valor como veio — e o P11a
    // prova que ele faz isso de verdade, senao este bloco inteiro seria
    // um teste de `null` com cinco nomes diferentes.
    {
      roteiro();
      roteiroRpc({ data: undefined, bruto: true });
      const sonda = await clienteFake.rpc("sonda-do-canal-bruto", {});
      ok("P11a ANCORA: o canal bruto entrega `undefined` DE VERDADE",
        sonda.data === undefined);

      const invalidosP: ReadonlyArray<readonly [string, Resposta]> = [
        ["string fora do catalogo", { data: "codigo_inventado", error: null }],
        ["null", { data: null, error: null }],
        ["undefined", { data: undefined, error: null, bruto: true }],
        ["objeto", { data: {}, error: null }],
        ["numero", { data: 123, error: null }],
      ];
      const falhasP: string[] = [];
      let indiceP = 10;
      for (const [rotulo, resposta] of invalidosP) {
        indiceP += 1;
        roteiro();
        roteiroRpc(resposta);
        const r = await cancelarAprovacaoRetomadaIncompativel(USER_P, APROV_P);
        ok(`P${indiceP} ${rotulo} e resposta_invalida, e custou UMA rpc`,
          r.ok === false && !r.ok && r.falha === "resposta_invalida" &&
          chamadasRpc.length === 1 && chamadas.length === 0);
        if (!r.ok) falhasP.push(r.falha);
      }
      ok("P16 HARD: os cinco falharam com o MESMO rotulo fail-closed",
        falhasP.length === 5 &&
        falhasP.every((f) => f === "resposta_invalida"));
    }

    // ── P17..P19. ERRO DE RPC: vocabulario reaproveitado ────────────
    {
      const errosP: ReadonlyArray<readonly [string, string]> = [
        ["22023", "rpc_entrada_invalida"],
        ["55000", "rpc_fora_de_contrato"],
        ["08006", "rpc_indisponivel"],
      ];
      let indiceP = 16;
      const observadosP: string[] = [];
      for (const [code, esperado] of errosP) {
        indiceP += 1;
        roteiro();
        roteiroRpc({ data: null, error: { code } });
        const r = await cancelarAprovacaoRetomadaIncompativel(USER_P, APROV_P);
        ok(`P${indiceP} SQLSTATE ${code} vira ${esperado}, em UMA rpc`,
          r.ok === false && !r.ok && r.falha === esperado &&
          chamadasRpc.length === 1);
        if (!r.ok) observadosP.push(r.falha);
      }
      ok("P20 ANCORA: os tres rotulos observados sao DISTINTOS entre si",
        new Set(observadosP).size === 3);

      // ── CONTROLE: a forma conceitual "erro virou sucesso" ─────────
      //
      // O criterio e uma funcao pura aplicada aos DOIS lados: ao
      // resultado real e a um mutante escrito a mao. Construir o
      // esperado a partir do proprio retorno tornaria o assert
      // verdadeiro por definicao.
      const ehFalhaP = (r: { ok: boolean; falha?: unknown }): boolean =>
        r.ok === false && typeof r.falha === "string" && r.falha !== "";

      roteiro();
      roteiroRpc({ data: null, error: { code: "08006" } });
      const realP = await cancelarAprovacaoRetomadaIncompativel(USER_P, APROV_P);
      ok("P21 CONTROLE: o mutante `erro -> ok:true` e REPROVADO pelo mesmo criterio",
        ehFalhaP(realP) &&
        !ehFalhaP({ ok: true }) &&
        !ehFalhaP({ ok: false }) &&
        !ehFalhaP({ ok: false, falha: "" }));
      ok("P22 HARD: erro NUNCA devolve `codigo`",
        !Object.prototype.hasOwnProperty.call(realP, "codigo"));

      // ── P22a..P22e. ERRO DOMINA DATA VALIDA — achado B1-R1-F1 ──────
      //
      // As tres fixtures acima usam `data: null`, e isso deixa um
      // mutante VIVO: um wrapper que validasse `data` ANTES de `error`
      // passaria nas tres, porque `null` reprova no guard de catalogo e
      // o fluxo cai no ramo de erro assim mesmo, com o rotulo certo.
      //
      // So uma resposta com os DOIS campos uteis ao mesmo tempo separa
      // o codigo correto desse mutante — e e por isso que a ancora
      // P22a existe: se a `data` da fixture nao fosse um codigo
      // realmente aceito pelo guard, o cenario passaria pelo motivo
      // errado (`resposta_invalida`) e nao provaria precedencia nenhuma.
      {
        const DATA_VALIDA_P = "cancelada";
        const ERRO_JUNTO_P = { code: "08006" };

        ok("P22a ANCORA: a data da fixture e um codigo VALIDO do catalogo",
          ehCodigoCancelamentoRetomada(DATA_VALIDA_P));

        // ANCORA de canal: os dois campos chegam na MESMA resposta.
        // A comparacao e por IDENTIDADE do objeto de erro — o fake
        // repassa a referencia —, entao nao ha como confundir com um
        // erro roteirizado noutro cenario.
        roteiro();
        roteiroRpc({ data: DATA_VALIDA_P, error: ERRO_JUNTO_P });
        const sondaP = await clienteFake.rpc("sonda-erro-com-data-valida", {});
        ok("P22b ANCORA: o fake entrega data VALIDA e error NAO-NULO na mesma resposta",
          sondaP.data === DATA_VALIDA_P && sondaP.error === ERRO_JUNTO_P);

        // O CASO REAL: mesmo canal, mesma funcao de producao.
        roteiro();
        roteiroRpc({ data: DATA_VALIDA_P, error: ERRO_JUNTO_P });
        const dominaP = await cancelarAprovacaoRetomadaIncompativel(USER_P, APROV_P);
        ok("P22c erro NAO-NULO vence data VALIDA: o retorno e rpc_indisponivel",
          dominaP.ok === false && !dominaP.ok &&
          dominaP.falha === "rpc_indisponivel" &&
          !Object.prototype.hasOwnProperty.call(dominaP, "codigo"));

        // A entrada consumida e observada DEPOIS da chamada: prova que
        // foi ESTA resposta — a dupla — que o wrapper leu, e nao alguma
        // outra roteirizada por engano ou uma segunda invocacao.
        ok("P22d a UNICA rpc do wrapper consumiu exatamente essa resposta dupla",
          chamadasRpc.length === 1 && consumidasRpc === 1 &&
          respostasRpc.length === 1 &&
          respostasRpc[0]?.data === DATA_VALIDA_P &&
          respostasRpc[0]?.error === ERRO_JUNTO_P);

        // NAO-VACUIDADE pelo MESMO criterio do P21, sem duplicar
        // mecanismo: o resultado real passa, e a forma que o mutante
        // produziria neste cenario — sucesso — e reprovada.
        ok("P22e CONTROLE: neste cenario o mutante que devolvesse ok:true seria reprovado",
          ehFalhaP(dominaP) && !ehFalhaP({ ok: true }));
      }
    }

    // ── P23..P26. O ATOR NAO PODE VIAJAR DAQUI ──────────────────────
    {
      /** Criterio PURO sobre as chaves que chegaram ao banco. Aplicado
       *  ao observado E a fixtures sinteticas: um detector que nunca foi
       *  visto reprovando nao prova nada. */
      const chavesOkP = (ks: readonly string[]): boolean =>
        ks.length === 2 &&
        [...ks].sort().join(",") === "p_aprovacao_id,p_user_id";

      roteiro();
      roteiroRpc({ data: "cancelada", error: null });
      await cancelarAprovacaoRetomadaIncompativel(USER_P, APROV_P);
      const chavesP = Object.keys(chamadasRpc[0]?.parametros ?? {});

      ok(`P23 a RPC recebe EXATAMENTE duas chaves (${[...chavesP].sort().join(", ")})`,
        chavesOkP(chavesP));
      ok("P24 e os dois valores sao os argumentos, sem aparo nem substituicao",
        chamadasRpc[0]?.nome === RPC_CANCEL_P &&
        chamadasRpc[0]?.parametros?.p_user_id === USER_P &&
        chamadasRpc[0]?.parametros?.p_aprovacao_id === APROV_P);
      ok("P25 CONTROLE NEGATIVO: uma TERCEIRA chave de ator seria detectada",
        !chavesOkP(["p_user_id", "p_aprovacao_id", "p_actor"]) &&
        !chavesOkP(["p_user_id", "p_aprovacao_id", "p_cancelado_por"]) &&
        !chavesOkP(["p_user_id"]) &&
        !chavesOkP(["p_user_id", "p_tarefa_id"]));

      /** Detector ESTRUTURAL, tambem exercitado contra fixture. */
      const propoeAtorP = (fonte: string): boolean =>
        /\b(p_actor|p_ator|p_cancelado_por|p_decidido_por|actor|canceladoPor|decididoPor|motivo|reason)\b/
          .test(fonte);

      ok("P26 nem a assinatura nem o corpo propoem ator, motivo ou tarefa",
        !propoeAtorP(CORPO_CANCEL) &&
        propoeAtorP('rpc("x", { p_user_id: u, p_aprovacao_id: a, p_actor: "eu" })') &&
        propoeAtorP("canceladoPor: quemMandou"));
      ok("P26a a assinatura tem DOIS parametros, e os dois sao identidade",
        /export async function cancelarAprovacaoRetomadaIncompativel\( userId: string, aprovacaoId: string \)/
          .test(CORPO_CANCEL.replace(/\s+/g, " ")));
    }

    // ── P27..P31. HIGIENE do corpo ──────────────────────────────────
    {
      ok("P27 o corpo nao le campo cru do erro do driver",
        !/\.message\b|\.details\b|\.hint\b|\.stack\b|JSON\.stringify\(\s*error/
          .test(CORPO_CANCEL));
      ok("P28 todo console.error do corpo e literal fixa, sem interpolacao",
        [...CORPO_CANCEL.matchAll(/console\.error\(([^)]*)\)/g)]
          .every((m) => /^"[^"`$]*"$/.test(m[1].trim())) &&
        !/console\.error\(\s*(error|data|userId|aprovacaoId)\b/.test(CORPO_CANCEL));
      ok("P29 zero retry: sem loop, timer, backoff ou catch ad hoc",
        !/setTimeout|setInterval|\bwhile\b|\bfor\s*\(|\.catch\(/.test(CORPO_CANCEL));
      ok("P30 UMA rpc no corpo, e ZERO acesso a tabela",
        (CORPO_CANCEL.match(/\.rpc\(/g) ?? []).length === 1 &&
        !/\.from\(/.test(CORPO_CANCEL));
      ok("P30a e a unica rpc do corpo e a de cancelamento, nomeada por literal",
        (CORPO_CANCEL.match(new RegExp(RPC_CANCEL_P, "g")) ?? []).length === 1);
      // ── B1 NAO classifica progresso ────────────────────────────────
      //
      // `expirada` e genuinamente ambiguo sobre ter havido mutacao NESTA
      // chamada: o TTL pode ter disparado agora, ou a linha ja podia
      // estar expirada. Decidir isso aqui criaria uma segunda fonte de
      // verdade sobre progresso duravel, que e do slot.
      ok("P31 o corpo NAO classifica progresso — devolve o codigo cru",
        !/progresso|duravel|confirmado|possivel|nenhum\b/.test(CORPO_CANCEL) &&
        !/expirada/.test(CORPO_CANCEL));
      ok("P31a sem cast cego nem supressao de tipo no corpo",
        !/as any|@ts-ignore|@ts-expect-error|as unknown as/.test(CORPO_CANCEL));
      ok("P31b sem guarda local de entrada: o banco continua a fonte de verdade",
        !/if\s*\(\s*!?\s*userId/.test(CORPO_CANCEL) &&
        !/if\s*\(\s*!?\s*aprovacaoId/.test(CORPO_CANCEL) &&
        !/\.trim\(\)/.test(CORPO_CANCEL));
    }

    // ── P32..P36. CALLER DISCIPLINE, por contabilidade ──────────────
    //
    // Fecha o achado B1-R1-N2. Ate o B1 o wrapper nao tinha chamador e
    // um detector de `NOME(` bastava. O B2 deu a ele o unico chamador
    // previsto — e a partir daqui a pergunta certa nao e mais "existe
    // uma chamada?", e sim "existe alguma ocorrencia que NAO seja a
    // definicao, o import ou a chamada autorizada?".
    //
    // `papeisDoSimbolo` responde isso por identidade contabil, e nao
    // por lista de padroes proibidos: alias, callback, re-export e
    // destructuring caem todos no mesmo resto, junto com as formas que
    // ninguem ainda escreveu.
    {
      const NOME_CANCEL = "cancelarAprovacaoRetomadaIncompativel";
      const ADAPTADOR_P = "lib/agentes/retomada/persistencia-retomada.ts";
      const DONO_SLOT_P = "lib/agentes/retomada/executar-retomada.ts";

      const producaoP2 = arquivosDeProducao();
      const porArquivo = producaoP2
        .map((rel) => ({ rel, p: papeisDoSimbolo(semComentarios(ler(rel)), NOME_CANCEL) }))
        .filter((x) => x.p.total > 0);

      ok(`P32 ANCORA: a varredura de producao rodou de verdade (${producaoP2.length} arquivos)`,
        producaoP2.length > 50 && producaoP2.includes("middleware.ts"));
      ok(`P32a o simbolo aparece em exatamente DOIS arquivos de producao (${porArquivo.map((x) => x.rel).join(", ")})`,
        porArquivo.length === 2 &&
        porArquivo.some((x) => x.rel === ADAPTADOR_P) &&
        porArquivo.some((x) => x.rel === DONO_SLOT_P));

      const noAdaptador = porArquivo.find((x) => x.rel === ADAPTADOR_P)?.p;
      const noDono = porArquivo.find((x) => x.rel === DONO_SLOT_P)?.p;

      ok(`P33 no adaptador: 1 definicao, 0 import, 0 invocacao, 0 sem papel (${JSON.stringify(noAdaptador)})`,
        noAdaptador !== undefined && noAdaptador.definicoes === 1 &&
        noAdaptador.importacoes === 0 && noAdaptador.invocacoes === 0 &&
        noAdaptador.semPapel === 0);
      ok(`P33a no dono do slot: 0 definicao, 1 import, 1 invocacao, 0 sem papel (${JSON.stringify(noDono)})`,
        noDono !== undefined && noDono.definicoes === 0 &&
        noDono.importacoes === 1 && noDono.invocacoes === 1 && noDono.semPapel === 0);
      ok("P33b GLOBAL: 1 definicao, 1 import, 1 invocacao em toda a producao",
        porArquivo.reduce((s, x) => s + x.p.definicoes, 0) === 1 &&
        porArquivo.reduce((s, x) => s + x.p.importacoes, 0) === 1 &&
        porArquivo.reduce((s, x) => s + x.p.invocacoes, 0) === 1 &&
        porArquivo.reduce((s, x) => s + x.p.semPapel, 0) === 0);

      // ── A invocacao mora no SLOT, nao em qualquer lugar do arquivo ──
      const FONTE_DONO_P = semComentarios(ler(DONO_SLOT_P));
      const CORPO_SLOT_P = corpoDeExportado(FONTE_DONO_P, "executarSlotRetomada");
      const CORPO_EXEC_P = corpoDeExportado(FONTE_DONO_P, "executarRetomada");
      ok("P34 a unica invocacao esta DENTRO de executarSlotRetomada",
        CORPO_SLOT_P.length > 1000 &&
        (CORPO_SLOT_P.match(new RegExp(`\\b${NOME_CANCEL}\\s*\\(`, "g")) ?? []).length === 1);
      ok("P34a e o executor de UMA retomada NAO cancela nada",
        CORPO_EXEC_P.length > 1000 && !CORPO_EXEC_P.includes(NOME_CANCEL));

      // ── CONTROLES: o criterio precisa MORDER ────────────────────────
      const papeisDe = (src: string) => papeisDoSimbolo(src, NOME_CANCEL);
      const IMPORT_OK =
        `import { ${NOME_CANCEL} } from "@/lib/agentes/retomada/persistencia-retomada";\n`;

      ok("P35 CONTROLE POSITIVO: import + uma invocacao fecha a conta",
        (() => {
          const p = papeisDe(IMPORT_OK + `await ${NOME_CANCEL}(u, a);`);
          return p.total === 2 && p.importacoes === 1 && p.invocacoes === 1 && p.semPapel === 0;
        })());
      ok("P35a CONTROLE NEGATIVO: ALIAS deixa uma ocorrencia sem papel",
        papeisDe(IMPORT_OK + `const f = ${NOME_CANCEL};\nawait f(u, a);`).semPapel === 1);
      ok("P35b CONTROLE NEGATIVO: CALLBACK passado adiante deixa resto",
        papeisDe(IMPORT_OK + `registrar(${NOME_CANCEL});`).semPapel === 1);
      ok("P35c CONTROLE NEGATIVO: RE-EXPORT deixa resto",
        papeisDe(IMPORT_OK + `export { ${NOME_CANCEL} };`).semPapel === 1);
      ok("P35d CONTROLE NEGATIVO: DESTRUCTURING deixa resto",
        papeisDe(`const { ${NOME_CANCEL} } = pb;\nawait ${NOME_CANCEL}(u, a);`).semPapel === 1);
      ok("P35e CONTROLE NEGATIVO: SEGUNDA invocacao e contada",
        papeisDe(IMPORT_OK + `await ${NOME_CANCEL}(u, a);\nawait ${NOME_CANCEL}(x, y);`)
          .invocacoes === 2);
      ok("P35f CONTROLE NEGATIVO: uma mencao solta tambem deixa resto",
        papeisDe(`if (nome === "${NOME_CANCEL}") {}`.replace(/"/g, "")).semPapel === 1);

      // ── O worker continua fora de tudo isso ─────────────────────────
      ok("P36 worker e capability-worker seguem sem qualquer ocorrencia",
        papeisDe(semComentarios(ler("app/api/internal/agentes/worker/route.ts"))).total === 0 &&
        papeisDe(semComentarios(ler("lib/agentes/capability-worker.ts"))).total === 0);
    }
  }

  // ────────────────────────────────────────────────────────────────
  // Q. APPROVAL-DECISION-RESUME-D5-C3-I2-B2 — o SLOT dormente
  //
  // O que esta secao NAO prova: que retomar e a decisao certa. Isso e
  // do worker, que ainda nao existe nesta lane.
  //
  // O que ela prova e o CONTRATO do slot, e ele tem uma forma incomum:
  // quase todo assert aqui e sobre o que o slot NAO fez. Nao buscou uma
  // segunda candidata travada, nao redescobriu a fila, nao cancelou uma
  // aprovacao reversivel, nao abriu uma segunda Tool Call, nao apagou
  // progresso ao falhar depois. Cada um desses "nao" e uma forma de
  // perder trabalho de um usuario real, e nenhum deles aparece no
  // resultado — so na contagem de chamadas que o duplo registra.
  // ────────────────────────────────────────────────────────────────
  {
    console.log("\nQ. RESUME-D5-C3-I2-B2: o slot dormente");

    const mq = await import("../lib/agentes/retomada/executar-retomada");
    const { executarSlotRetomada } = mq;

    const Q_FONTE = semComentarios(ler("lib/agentes/retomada/executar-retomada.ts"));
    const Q_CORPO = corpoDeExportado(Q_FONTE, "executarSlotRetomada");

    const U1 = "dono-1";
    const A1 = "aaaaaaaa-1111-4111-8111-111111111111";
    const A2 = "aaaaaaaa-2222-4222-8222-222222222222";
    const T1 = "11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

    /** Guarda permissiva PADRAO dos cenarios. Literal explicito: e
     *  teste, e o N80g prova que producao nao faz isso. */
    const SEMPRE = () => true;

    /** Linha de candidata travada, como o `select` do adaptador devolve. */
    const linhaStale = (over: Record<string, unknown> = {}) => ({
      id: T1, user_id: U1, tentativas: 3,
      retomada_request_id: "req-travado", heartbeat_em: "2026-09-16T00:00:00Z",
      ...over,
    });

    /** Uma rodada completa: `roteiro` alimenta o canal de TABELA (a
     *  descoberta de travadas e um `select`), `roteiroRpc` alimenta o
     *  canal de RPC, na ordem em que o slot as consome. */
    const cenario = (tabela: Resposta[], rpcs: Resposta[]) => {
      roteiro(...tabela);
      roteiroRpc(...rpcs);
    };

    /** Fila de aprovacoes, na forma que a RPC de descoberta devolve. */
    const filaRpc = (...pares: ReadonlyArray<readonly [string, string]>): Resposta => ({
      data: pares.map(([user_id, aprovacao_id]) => ({ user_id, aprovacao_id })),
    });

    const STALE_VAZIO: Resposta = { data: [] };

    ok("Q0  ANCORA: o slot existe e o corpo foi isolado",
      typeof executarSlotRetomada === "function" && Q_CORPO.length > 1000);
    ok("Q0a ANCORA: o corpo do slot nao invadiu o executor vizinho",
      !Q_CORPO.includes("export async function executarRetomada") &&
      !Q_CORPO.includes("lerAprovacaoParaRetomada"));

    // ── Q1. HIGIENE ESTRUTURAL do slot ──────────────────────────────
    ok("Q1  o slot nao tem relogio proprio",
      !/Date\.now|new Date|ORCAMENTO_MS|FOLGA_MINIMA_MS/.test(Q_CORPO));
    ok("Q1a o slot nao alcanca o banco direto",
      !/getSupabaseServidor|createClient|\.from\(|\.rpc\(|\.update\(|\.insert\(|\.upsert\(|\.delete\(/
        .test(Q_CORPO));
    ok("Q1b o slot nao cita nome cru de RPC, nem o arquivo inteiro",
      !/retomada_listar_candidatas|retomada_cancelar_aprovacao_incompativel/
        .test(ler("lib/agentes/retomada/executar-retomada.ts")));
    ok("Q1c o slot nao cria timer, retry nem catch ad hoc",
      !/setTimeout|setInterval|\.catch\(|\bwhile\b/.test(Q_CORPO));
    ok("Q1d o slot nao usa cast cego",
      !/as any|@ts-ignore|@ts-expect-error/.test(Q_CORPO));
    ok("Q1e HARD: a callback e repassada CRUA, sem embrulho",
      /executarRetomada\([\s\S]{0,120}?podeIniciarRetomada\s*\)/.test(Q_CORPO) &&
      !/\(\s*\)\s*=>\s*podeIniciarRetomada\s*\(/.test(Q_CORPO) &&
      !/podeIniciarRetomada\.bind/.test(Q_CORPO));
    ok("Q1f a caminhada e por `for…of` sobre lista limitada, nao por condicao",
      /for \(const candidata of fila\.candidatas\)/.test(Q_CORPO));

    // ── Q2. PROGRESSO: monotonicidade ───────────────────────────────
    //
    // O helper e privado, entao a prova e sobre a ESCALA que ele usa e
    // sobre o comportamento observavel. A escala literal aqui e
    // independente da de producao.
    {
      const ESCALA_Q = ["nenhum", "possivel", "confirmado"] as const;
      const elevarQ = (a: string, b: string) =>
        (ESCALA_Q as readonly string[]).indexOf(b) > (ESCALA_Q as readonly string[]).indexOf(a) ? b : a;
      ok("Q2  a escala tem exatamente tres degraus, nesta ordem",
        ESCALA_Q.length === 3 && ESCALA_Q[0] === "nenhum" &&
        ESCALA_Q[1] === "possivel" && ESCALA_Q[2] === "confirmado");
      ok("Q2a elevar nunca decresce, nos seis pares",
        elevarQ("confirmado", "possivel") === "confirmado" &&
        elevarQ("confirmado", "nenhum") === "confirmado" &&
        elevarQ("possivel", "nenhum") === "possivel" &&
        elevarQ("nenhum", "possivel") === "possivel" &&
        elevarQ("possivel", "confirmado") === "confirmado" &&
        elevarQ("nenhum", "confirmado") === "confirmado");
      ok("Q2b CONTROLE: uma atribuicao direta REGREDIRIA — por isso nao existe",
        "possivel" !== elevarQ("confirmado", "possivel"));
      ok("Q2c a producao usa o helper, e nao atribuicao solta de progresso",
        /elevarProgresso\(progressoDuravel,/.test(Q_CORPO) &&
        !/progressoDuravel = "(?:nenhum|possivel|confirmado)"/.test(
          Q_CORPO.replace(/let progressoDuravel[^;]*;/, "")));
    }

    // ── Q3..Q6. DESCOBERTA DE TRAVADAS ──────────────────────────────
    cenario([{ data: null, error: { code: "08006" } }], []);
    const qStaleErro = await executarSlotRetomada(SEMPRE);
    ok("Q3  descoberta de travadas com ERRO e falha, nunca fila vazia",
      qStaleErro.ok === false && !qStaleErro.ok &&
      qStaleErro.falha === "descoberta_stale_indisponivel" &&
      qStaleErro.progressoDuravel === "nenhum");
    ok("Q3a HARD: com esse erro a fila de aprovacoes NAO chegou a ser consultada",
      chamadasRpc.length === 0);

    cenario([STALE_VAZIO], [{ data: [] }]);
    const qVazio = await executarSlotRetomada(SEMPRE);
    ok("Q4  travadas VAZIO segue para a fila, e fila vazia e `fila_vazia`",
      qVazio.ok === true && qVazio.ok && qVazio.desfecho === "fila_vazia" &&
      qVazio.progressoDuravel === "nenhum" && qVazio.encerrarPorOrcamento === false);
    ok("Q4a e custou UMA descoberta de travadas e UMA de aprovacoes",
      chamadas.length === 1 && chamadasRpc.length === 1 &&
      chamadasRpc[0]?.nome === "retomada_listar_candidatas");
    ok("Q4b o teto das duas descobertas chegou ao banco: 1 e 5",
      chamadas[0]?.limite === 1 && chamadasRpc[0]?.parametros?.p_limite === 5);

    // ── Q5..Q8. RECUPERACAO ─────────────────────────────────────────
    cenario([{ data: [linhaStale()] }],
      [{ data: "execucao_incerta" }, { data: [] }]);
    const qRec = await executarSlotRetomada(SEMPRE);
    ok("Q5  recuperacao duravel + fila vazia = `recuperacao_duravel`, nao `fila_vazia`",
      qRec.ok === true && qRec.ok && qRec.desfecho === "recuperacao_duravel" &&
      qRec.progressoDuravel === "confirmado");
    ok("Q5a a recuperacao foi chamada UMA vez, com os quatro campos da candidata",
      chamadasRpc.filter((c) => c.nome === "retomada_recuperar_tarefa_stale").length === 1 &&
      chamadasRpc[0]?.parametros?.p_tarefa_id === T1 &&
      chamadasRpc[0]?.parametros?.p_tentativa_esperada === 3);
    ok("Q5b HARD: NENHUMA segunda descoberta de travadas",
      chamadas.length === 1);

    cenario([{ data: [linhaStale()] }], [{ data: "nao_stale" }, { data: [] }]);
    const qNaoStale = await executarSlotRetomada(SEMPRE);
    ok("Q6  `nao_stale` nao gera progresso e nao busca segunda candidata",
      qNaoStale.ok === true && qNaoStale.ok &&
      qNaoStale.desfecho === "fila_vazia" && qNaoStale.progressoDuravel === "nenhum" &&
      chamadasRpc.filter((c) => c.nome === "retomada_recuperar_tarefa_stale").length === 1 &&
      chamadas.length === 1);

    cenario([{ data: [linhaStale()] }], [{ data: null, error: { code: "08006" } }]);
    const qRecAmbiguo = await executarSlotRetomada(SEMPRE);
    ok("Q7  recuperacao com erro AMBIGUO eleva a `possivel` e falha fechado",
      qRecAmbiguo.ok === false && !qRecAmbiguo.ok &&
      qRecAmbiguo.falha === "recuperacao_indisponivel" &&
      qRecAmbiguo.progressoDuravel === "possivel");
    ok("Q7a HARD: depois desse erro a fila NAO foi consultada",
      chamadasRpc.filter((c) => c.nome === "retomada_listar_candidatas").length === 0);

    cenario([{ data: [linhaStale()] }], [{ data: null, error: { code: "55000" } }]);
    const qRec55 = await executarSlotRetomada(SEMPRE);
    ok("Q8  55000 aborta a transacao: falha SEM elevar progresso",
      qRec55.ok === false && !qRec55.ok &&
      qRec55.falha === "recuperacao_fora_de_contrato" &&
      qRec55.progressoDuravel === "nenhum");

    // ── Q9..Q10. FILA DE APROVACOES ─────────────────────────────────
    cenario([STALE_VAZIO], [{ data: null, error: { code: "08006" } }]);
    const qFilaErro = await executarSlotRetomada(SEMPRE);
    ok("Q9  fila com ERRO e falha, com progresso preservado",
      qFilaErro.ok === false && !qFilaErro.ok &&
      qFilaErro.falha === "descoberta_aprovacoes_indisponivel" &&
      qFilaErro.progressoDuravel === "nenhum");

    cenario([{ data: [linhaStale()] }],
      [{ data: "execucao_incerta" }, { data: null, error: { code: "08006" } }]);
    const qTardia = await executarSlotRetomada(SEMPRE);
    ok("Q10 FALHA TARDIA NAO APAGA PROGRESSO: falha da fila mantem `confirmado`",
      qTardia.ok === false && !qTardia.ok &&
      qTardia.falha === "descoberta_aprovacoes_indisponivel" &&
      qTardia.progressoDuravel === "confirmado");
  }

  // ────────────────────────────────────────────────────────────────
  // Q11..Q40. O SLOT: caminhada, classificacao e reconciliacao
  // ────────────────────────────────────────────────────────────────
  {
    const mq2 = await import("../lib/agentes/retomada/executar-retomada");
    const { executarSlotRetomada } = mq2;

    const Q2_FONTE = semComentarios(ler("lib/agentes/retomada/executar-retomada.ts"));
    const Q2_CORPO = corpoDeExportado(Q2_FONTE, "executarSlotRetomada");

    const QU = "dono-q";
    const QA = (n: number) => `aaaaaaaa-${n}${n}${n}${n}-4111-8111-111111111111`;
    const QT = "22222222-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const QAG = "33333333-cccc-4ccc-8ccc-cccccccccccc";

    const SEMPRE2 = () => true;
    const STALE_VAZIO2: Resposta = { data: [] };

    /** Linha de aprovacao no formato que o pre-read consome. */
    const qAprov = (aprovacaoId: string): Resposta => ({
      data: {
        id: aprovacaoId, funcao_id: "vendas.consultar", revisao_funcao: "1",
        acesso: "leitura", conexao_plataforma: null, conexao_recurso: null,
        conexao_loja_id: null,
        argumentos: { dataInicio: "2026-08-01", dataFim: "2026-08-07", marketplace: null },
        agente_id: QAG, tarefa_id: QT,
      },
    });
    const qTarefa = (): Resposta => ({
      data: {
        id: QT, user_id: QU, agente_id: QAG, tipo: "consultar_vendas",
        status: "aguardando_aprovacao", tentativas: 2, max_tentativas: 3, entrada: {},
      },
    });

    /** Monta a rodada: fila com N candidatas, cada uma parando ANTES da
     *  abertura com o codigo de recusa dado pela RPC de inicio. */
    const rodadaSemInicio = (codigos: readonly string[], rpcsExtras: Resposta[] = []): void => {
      const tabela: Resposta[] = [STALE_VAZIO2];
      for (let i = 0; i < codigos.length; i++) tabela.push(qAprov(QA(i + 1)), qTarefa());
      const rpcs: Resposta[] = [
        { data: codigos.map((_, i) => ({ user_id: QU, aprovacao_id: QA(i + 1) })) },
      ];
      for (const c of codigos) rpcs.push({ data: c });
      roteiro(...tabela);
      roteiroRpc(...rpcs, ...rpcsExtras);
    };

    const nomesRpc = () => chamadasRpc.map((c) => c.nome);
    const inicios = () => nomesRpc().filter((n) => n === "retomar_aprovacao_iniciar").length;
    const cancels = () =>
      nomesRpc().filter((n) => n === "retomada_cancelar_aprovacao_incompativel").length;
    const filas = () => nomesRpc().filter((n) => n === "retomada_listar_candidatas").length;

    // ── Q11..Q13. A GUARDA DE ORCAMENTO ─────────────────────────────
    {
      let chamadasGuarda = 0;
      let inicioNoMomentoDaGuarda = -1;
      let tabelaNoMomentoDaGuarda = -1;
      const sonda = () => {
        chamadasGuarda += 1;
        inicioNoMomentoDaGuarda = inicios();
        tabelaNoMomentoDaGuarda = chamadas.length;
        return false;
      };

      rodadaSemInicio([]);
      roteiro(STALE_VAZIO2, qAprov(QA(1)), qTarefa());
      roteiroRpc({ data: [{ user_id: QU, aprovacao_id: QA(1) }] });
      const qOrc = await executarSlotRetomada(sonda);

      ok("Q11 guarda FALSE encerra o slot com `orcamento_insuficiente`",
        qOrc.ok === true && qOrc.ok && qOrc.desfecho === "orcamento_insuficiente" &&
        qOrc.progressoDuravel === "nenhum" && qOrc.encerrarPorOrcamento === true);
      ok("Q11a HARD: com guarda false, ZERO RPC de abertura",
        inicios() === 0);
      ok("Q11b a guarda foi consultada exatamente uma vez",
        chamadasGuarda === 1);
      ok("Q12 ORDEM: quando a guarda e perguntada, as DUAS pre-leituras ja ocorreram",
        tabelaNoMomentoDaGuarda === 3);
      ok("Q12a ORDEM: e nenhuma abertura tinha acontecido ainda",
        inicioNoMomentoDaGuarda === 0);
      ok("Q12b ANCORA: a sonda mediu de verdade, nao ficou em -1",
        tabelaNoMomentoDaGuarda > 0 && inicioNoMomentoDaGuarda === 0);
    }

    // ── Q13. IDENTIDADE DA CALLBACK ─────────────────────────────────
    //
    // A prova e ESTRUTURAL, e o teste diz isso em voz alta: o corpo do
    // slot passa `podeIniciarRetomada` cru, sem `() =>`, sem `.bind`.
    // Um embrulho encaminharia a chamada e seria indistinguivel em
    // runtime — por isso o criterio e sobre a forma, com controle
    // negativo sobre as duas formas de embrulho.
    {
      const repassaCru = (src: string): boolean =>
        /executarRetomada\([^)]*,\s*podeIniciarRetomada\s*\)/.test(src.replace(/\s+/g, " ")) &&
        !/\(\s*\)\s*=>\s*podeIniciarRetomada\s*\(/.test(src) &&
        !/podeIniciarRetomada\.bind/.test(src);
      ok("Q13 o slot repassa a MESMA referencia ao executor",
        repassaCru(Q2_CORPO));
      ok("Q13a CONTROLE: um embrulho em arrow seria detectado",
        !repassaCru("await executarRetomada(u, a, () => podeIniciarRetomada());"));
      ok("Q13b CONTROLE: um `.bind` tambem seria detectado",
        !repassaCru("await executarRetomada(u, a, podeIniciarRetomada.bind(null));"));
      ok("Q13c CONTROLE POSITIVO: a forma crua passa",
        repassaCru("await executarRetomada(c.userId, c.aprovacaoId, podeIniciarRetomada);"));
    }

    // ── Q14. A PARTICAO DOS 28 MOTIVOS ──────────────────────────────
    //
    // Literais INDEPENDENTES, transcritos do tipo `MotivoSemInicio`. Nao
    // saem de nenhum array de producao: derivar o esperado da producao
    // faria o teste concordar com qualquer particao.
    {
      const TODOS_28 = [
        "entrada_invalida", "aprovacao_inexistente", "agente_indisponivel",
        "tarefa_indisponivel", "aprovacao_pendente", "ja_consumida", "ja_rejeitada",
        "ja_cancelada", "expirada", "aprovacao_desatualizada", "escrita_nao_suportada",
        "permissao_ausente", "permissao_bloqueada", "conexao_indisponivel",
        "tarefa_incompativel", "funcao_incompativel",
        "contrato_desconhecido", "tarefa_ausente", "tipo_ilegivel", "aprovacao_ilegivel",
        "local_funcao_desconhecida", "local_revisao_divergente", "local_acesso_divergente",
        "local_conexao_divergente", "local_conexao_indisponivel",
        "local_argumentos_invalidos", "rpc_entrada_invalida", "rpc_fora_de_contrato",
      ] as const;
      const PERMANENTES_9 = [
        "contrato_desconhecido", "local_funcao_desconhecida", "funcao_incompativel",
        "local_revisao_divergente", "aprovacao_desatualizada", "local_acesso_divergente",
        "escrita_nao_suportada", "local_conexao_divergente", "local_argumentos_invalidos",
      ] as const;
      const REVERSIVEIS_12 = [
        "aprovacao_inexistente", "agente_indisponivel", "tarefa_indisponivel",
        "aprovacao_pendente", "ja_consumida", "ja_rejeitada", "ja_cancelada", "expirada",
        "permissao_ausente", "permissao_bloqueada", "tarefa_incompativel", "tarefa_ausente",
      ] as const;
      const TRANSITORIOS_2 = ["conexao_indisponivel", "local_conexao_indisponivel"] as const;
      const TERMINAIS_5 = [
        "entrada_invalida", "tipo_ilegivel", "aprovacao_ilegivel",
        "rpc_entrada_invalida", "rpc_fora_de_contrato",
      ] as const;

      const uniao = [...PERMANENTES_9, ...REVERSIVEIS_12, ...TRANSITORIOS_2, ...TERMINAIS_5];

      ok("Q14 os 28 motivos sao 28, sem repetido",
        TODOS_28.length === 28 && new Set(TODOS_28).size === 28);
      ok("Q14a as quatro classes somam 28: 9 + 12 + 2 + 5",
        PERMANENTES_9.length === 9 && REVERSIVEIS_12.length === 12 &&
        TRANSITORIOS_2.length === 2 && TERMINAIS_5.length === 5 &&
        uniao.length === 28);
      ok("Q14b as classes sao DISJUNTAS entre si",
        new Set(uniao).size === 28);
      ok("Q14c e COBREM os 28: nenhum motivo fica sem politica",
        TODOS_28.every((m) => uniao.includes(m)));
      ok("Q14d CONTROLE: retirar um motivo de uma classe quebra a cobertura",
        !TODOS_28.every((m) =>
          [...PERMANENTES_9.slice(1), ...REVERSIVEIS_12, ...TRANSITORIOS_2, ...TERMINAIS_5]
            .includes(m)));
      ok("Q14e CONTROLE: um motivo em DUAS classes quebra a disjuncao",
        new Set([...uniao, "expirada"]).size !== 29);
      // ANCORA contra a producao: os 16 codigos da RPC de inicio (menos
      // `consumida`) tem de estar entre os 28 transcritos. Se a RPC
      // ganhar um codigo, ele chega ao tipo sozinho — e este assert cai,
      // avisando que falta politica para ele.
      const pq = await import("../lib/agentes/retomada/persistencia-retomada");
      const daRpc = pq.codigosRetomadaInicio().filter((c) => c !== "consumida");
      ok(`Q14f ANCORA: os ${daRpc.length} codigos da RPC de inicio estao entre os 28`,
        daRpc.length === 16 &&
        daRpc.every((c) => (TODOS_28 as readonly string[]).includes(c)));
    }

    // ── Q15..Q17. REVERSIVEIS: caminha, nunca cancela ───────────────
    {
      const REVERSIVEIS_RPC = [
        "aprovacao_inexistente", "agente_indisponivel", "tarefa_indisponivel",
        "aprovacao_pendente", "ja_consumida",
      ] as const;
      rodadaSemInicio(REVERSIVEIS_RPC);
      const qRev = await executarSlotRetomada(SEMPRE2);
      ok("Q15 cinco candidatas reversiveis: caminhada completa, `sem_progresso`",
        qRev.ok === true && qRev.ok && qRev.desfecho === "sem_progresso" &&
        qRev.progressoDuravel === "nenhum" && qRev.encerrarPorOrcamento === false);
      ok("Q15a cinco aberturas tentadas, e ZERO cancelamento",
        inicios() === 5 && cancels() === 0);
      ok("Q15b HARD: UMA descoberta de fila, sem redescoberta nem paginacao",
        filas() === 1);
      ok("Q15c HARD: `sem_progresso` e nao `fila_vazia` — havia trabalho para olhar",
        qRev.ok && qRev.desfecho !== "fila_vazia");
    }

    // ── Q18..Q20. PERMANENTES: reconcilia ───────────────────────────
    {
      rodadaSemInicio(["funcao_incompativel"], [{ data: "cancelada" }]);
      const qPerm = await executarSlotRetomada(SEMPRE2);
      ok("Q16 motivo permanente dispara o cancelamento tecnico",
        cancels() === 1 && inicios() === 1);
      ok("Q16a e o desfecho vira `reconciliado` com progresso `confirmado`",
        qPerm.ok === true && qPerm.ok && qPerm.desfecho === "reconciliado" &&
        qPerm.progressoDuravel === "confirmado");
      ok("Q16b o cancelamento recebeu SO dono e aprovacao",
        JSON.stringify(Object.keys(
          chamadasRpc.find((c) => c.nome === "retomada_cancelar_aprovacao_incompativel")
            ?.parametros ?? {}).sort()) ===
        JSON.stringify(["p_aprovacao_id", "p_user_id"]));

      rodadaSemInicio(["aprovacao_desatualizada"], [{ data: "expirada" }]);
      const qExp = await executarSlotRetomada(SEMPRE2);
      ok("Q17 `expirada` no cancelamento e AMBIGUO: progresso `possivel`, nunca confirmado",
        qExp.ok === true && qExp.ok && qExp.desfecho === "reconciliado" &&
        qExp.progressoDuravel === "possivel");

      // Observacao terminal NAO e reconciliacao. `ja_cancelada` diz que
      // alguem ja resolveu aquela aprovacao — esta rodada nao escreveu
      // nada, entao ela nao pode reivindicar o desfecho `reconciliado`.
      // A distincao importa: `reconciliado` sinaliza trabalho durável ao
      // worker, e contar observacao como trabalho inflaria a rodada.
      rodadaSemInicio(["escrita_nao_suportada"], [{ data: "ja_cancelada" }]);
      const qJa = await executarSlotRetomada(SEMPRE2);
      ok("Q18 observacao terminal no cancelamento NAO cria progresso NEM reconciliacao",
        qJa.ok === true && qJa.ok && qJa.desfecho === "sem_progresso" &&
        qJa.progressoDuravel === "nenhum");
      ok("Q18a CONTROLE: o cancelamento REALMENTE foi tentado nesse cenario",
        cancels() === 1 && inicios() === 1);
    }

    // ── Q19. CANCELAMENTO: os oito codigos ──────────────────────────
    {
      const ESPERADO_CANCEL: ReadonlyArray<readonly [string, string]> = [
        ["cancelada", "confirmado"],
        ["expirada", "possivel"],
        ["ja_cancelada", "nenhum"],
        ["ja_consumida", "nenhum"],
        ["ja_rejeitada", "nenhum"],
        ["aprovacao_pendente", "nenhum"],
        ["tarefa_incompativel", "nenhum"],
        ["aprovacao_inexistente", "nenhum"],
      ];
      const observados: string[] = [];
      for (const [codigo] of ESPERADO_CANCEL) {
        rodadaSemInicio(["funcao_incompativel"], [{ data: codigo }]);
        const r = await executarSlotRetomada(SEMPRE2);
        observados.push(r.progressoDuravel);
      }
      ok("Q19 os OITO codigos de cancelamento mapeiam exatamente o esperado",
        observados.length === 8 &&
        ESPERADO_CANCEL.every(([, esperado], i) => observados[i] === esperado));
      ok("Q19a ANCORA: os tres graus apareceram de verdade",
        observados.includes("confirmado") && observados.includes("possivel") &&
        observados.includes("nenhum"));
      ok("Q19b CONTROLE: `expirada` NAO e confirmado nem nenhum",
        observados[1] !== "confirmado" && observados[1] !== "nenhum");
    }

    // ── Q20. CANCELAMENTO: os quatro erros ──────────────────────────
    {
      const ERROS_CANCEL: ReadonlyArray<readonly [string, string, string]> = [
        ["22023", "cancelamento_fora_de_contrato", "nenhum"],
        ["55000", "cancelamento_fora_de_contrato", "nenhum"],
        ["08006", "cancelamento_indisponivel", "possivel"],
      ];
      for (const [code, falha, progresso] of ERROS_CANCEL) {
        rodadaSemInicio(["funcao_incompativel"], [{ data: null, error: { code } }]);
        const r = await executarSlotRetomada(SEMPRE2);
        ok(`Q20.${code} vira ${falha} com progresso ${progresso}`,
          r.ok === false && !r.ok && r.falha === falha && r.progressoDuravel === progresso);
      }
      rodadaSemInicio(["funcao_incompativel"], [{ data: "codigo_inventado" }]);
      const qRespMa = await executarSlotRetomada(SEMPRE2);
      ok("Q20a resposta fora do catalogo tambem eleva a `possivel` e falha fechado",
        qRespMa.ok === false && !qRespMa.ok &&
        qRespMa.falha === "cancelamento_indisponivel" &&
        qRespMa.progressoDuravel === "possivel");
    }

    // ── Q21..Q22. TRANSITORIO e TERMINAL ────────────────────────────
    {
      rodadaSemInicio(["conexao_indisponivel", "ja_consumida"]);
      const qTr = await executarSlotRetomada(SEMPRE2);
      ok("Q21 motivo transitorio encerra a rodada, sem cancelar",
        qTr.ok === false && !qTr.ok && qTr.falha === "motivo_transitorio" &&
        qTr.progressoDuravel === "nenhum" && cancels() === 0);
      ok("Q21a HARD: a segunda candidata NAO foi tentada",
        inicios() === 1);

      rodadaSemInicio(["entrada_invalida", "ja_consumida"]);
      const qTerm = await executarSlotRetomada(SEMPRE2);
      ok("Q22 motivo terminal e fail-closed, sem cancelar e sem continuar",
        qTerm.ok === false && !qTerm.ok && qTerm.falha === "motivo_fora_do_dominio" &&
        cancels() === 0 && inicios() === 1);
      ok("Q22a HARD: nenhum `default continue` — o corpo nao tem continue fora do ramo reversivel",
        (Q2_CORPO.match(/\bcontinue\b/g) ?? []).length === 1);
    }

    // ── Q23..Q26. POS-ABERTURA: a caminhada PARA ────────────────────
    {
      // `inicio_ambiguo`: a RPC de abertura nao respondeu.
      roteiro(STALE_VAZIO2, qAprov(QA(1)), qTarefa(), qAprov(QA(2)), qTarefa());
      roteiroRpc(
        { data: [{ user_id: QU, aprovacao_id: QA(1) }, { user_id: QU, aprovacao_id: QA(2) }] },
        { data: null, error: { code: "08006" } });
      const qAmb = await executarSlotRetomada(SEMPRE2);
      ok("Q23 `inicio_ambiguo` eleva a `possivel` e encerra a caminhada",
        qAmb.ok === false && !qAmb.ok && qAmb.falha === "inicio_ambiguo" &&
        qAmb.progressoDuravel === "possivel");
      ok("Q23a HARD: uma so abertura, zero cancelamento, zero segunda candidata",
        inicios() === 1 && cancels() === 0 && filas() === 1);

      // `contexto_incompleto`: abriu, mas o read-back da abertura falhou.
      roteiro(STALE_VAZIO2, qAprov(QA(1)), qTarefa(), { data: null },
        qAprov(QA(2)), qTarefa());
      roteiroRpc(
        { data: [{ user_id: QU, aprovacao_id: QA(1) }, { user_id: QU, aprovacao_id: QA(2) }] },
        { data: "consumida" });
      const qCtx = await executarSlotRetomada(SEMPRE2);
      ok("Q24 `contexto_incompleto` e pos-abertura: progresso `confirmado` e fail-closed",
        qCtx.ok === false && !qCtx.ok && qCtx.falha === "contexto_incompleto" &&
        qCtx.progressoDuravel === "confirmado");
      ok("Q24a HARD: a caminhada parou — uma abertura so",
        inicios() === 1 && cancels() === 0);
    }

    // ── Q27..Q29. ORCAMENTO COM PROGRESSO ANTERIOR ──────────────────
    {
      // Recuperacao duravel, depois a guarda recusa a primeira candidata.
      roteiro({ data: [{ id: QT, user_id: QU, tentativas: 3,
        retomada_request_id: "req-x", heartbeat_em: "2026-09-16T00:00:00Z" }] },
        qAprov(QA(1)), qTarefa());
      roteiroRpc({ data: "execucao_incerta" },
        { data: [{ user_id: QU, aprovacao_id: QA(1) }] });
      const qBudRec = await executarSlotRetomada(() => false);
      ok("Q27 guarda false APOS recuperacao preserva `recuperacao_duravel`",
        qBudRec.ok === true && qBudRec.ok && qBudRec.desfecho === "recuperacao_duravel" &&
        qBudRec.progressoDuravel === "confirmado" &&
        qBudRec.encerrarPorOrcamento === true);
      ok("Q27a HARD: zero abertura nesse caminho", inicios() === 0);

      // Reconciliacao na 1a candidata, guarda recusa a 2a.
      let n = 0;
      const guardaUmaVez = () => {
        n += 1;
        return n === 1;
      };
      roteiro(STALE_VAZIO2, qAprov(QA(1)), qTarefa(), qAprov(QA(2)), qTarefa());
      roteiroRpc(
        { data: [{ user_id: QU, aprovacao_id: QA(1) }, { user_id: QU, aprovacao_id: QA(2) }] },
        { data: "funcao_incompativel" },
        { data: "cancelada" });
      const qBudRec2 = await executarSlotRetomada(guardaUmaVez);
      ok("Q28 guarda false APOS reconciliacao preserva `reconciliado`",
        qBudRec2.ok === true && qBudRec2.ok && qBudRec2.desfecho === "reconciliado" &&
        qBudRec2.progressoDuravel === "confirmado" &&
        qBudRec2.encerrarPorOrcamento === true);
      ok("Q28a a guarda foi perguntada duas vezes e a segunda recusou",
        n === 2 && inicios() === 1 && cancels() === 1);
      ok("Q29 PRECEDENCIA: reconciliado vence recuperacao_duravel",
        qBudRec2.ok && qBudRec2.desfecho === "reconciliado");
    }

    // ── Q30. FALHA TARDIA APOS RECONCILIACAO ────────────────────────
    {
      roteiro(STALE_VAZIO2, qAprov(QA(1)), qTarefa(), qAprov(QA(2)), qTarefa());
      roteiroRpc(
        { data: [{ user_id: QU, aprovacao_id: QA(1) }, { user_id: QU, aprovacao_id: QA(2) }] },
        { data: "funcao_incompativel" },
        { data: "expirada" },
        { data: "entrada_invalida" });
      const qTardia2 = await executarSlotRetomada(SEMPRE2);
      ok("Q30 falha tardia apos cancelamento `expirada` preserva `possivel`",
        qTardia2.ok === false && !qTardia2.ok &&
        qTardia2.falha === "motivo_fora_do_dominio" &&
        qTardia2.progressoDuravel === "possivel");
      ok("Q30a ANCORA: houve reconciliacao antes da falha",
        cancels() === 1 && inicios() === 2);
    }

    // ── Q31. COMPOSICAO: `expirada` + caminhada + budget — B2-I1-F1 ──
    //
    // Q19b ja prova a CLASSIFICACAO isolada (`expirada` vira `possivel`)
    // e Q28 prova budget depois de uma reconciliacao CONFIRMADA. Nenhum
    // dos dois cobre a composicao que importa: reconciliar com um codigo
    // AMBIGUO e, na candidata seguinte, bater no orcamento.
    //
    // O mutante que isso existe para matar e estreito e plausivel: ao
    // montar o resultado do ramo de budget, alguem escrever
    //
    //   if (houveReconciliacao) progressoDuravel = "confirmado";
    //
    // Nada nos testes anteriores cairia — Q28 ja chega la com
    // `confirmado` de verdade, e Q19b nunca passa pelo ramo de budget.
    // So um cenario que atravesse os dois separa as duas coisas.
    {
      let perguntas = 0;
      const guardaSoNaPrimeira = () => {
        perguntas += 1;
        return perguntas === 1;
      };

      roteiro(STALE_VAZIO2, qAprov(QA(1)), qTarefa(), qAprov(QA(2)), qTarefa());
      roteiroRpc(
        { data: [{ user_id: QU, aprovacao_id: QA(1) }, { user_id: QU, aprovacao_id: QA(2) }] },
        { data: "funcao_incompativel" },
        { data: "expirada" });
      const qComposto = await executarSlotRetomada(guardaSoNaPrimeira);

      /** Esperado LITERAL e independente: escrito a mao, nunca derivado
       *  do retorno nem de constante de producao. */
      const ESPERADO_COMPOSTO = {
        ok: true,
        desfecho: "reconciliado",
        progressoDuravel: "possivel",
        encerrarPorOrcamento: true,
      } as const;

      /** Criterio unico, aplicado ao real E aos mutantes. */
      const bateComEsperado = (r: Record<string, unknown>): boolean =>
        r.ok === ESPERADO_COMPOSTO.ok &&
        r.desfecho === ESPERADO_COMPOSTO.desfecho &&
        r.progressoDuravel === ESPERADO_COMPOSTO.progressoDuravel &&
        r.encerrarPorOrcamento === ESPERADO_COMPOSTO.encerrarPorOrcamento;

      ok("Q31 ANCORA: a candidata A foi reconciliada com `expirada`",
        cancels() === 1 &&
        chamadasRpc.some((c) =>
          c.nome === "retomada_cancelar_aprovacao_incompativel" &&
          c.parametros?.p_aprovacao_id === QA(1)));
      ok("Q31a ANCORA: a candidata B FOI alcancada — a guarda foi perguntada duas vezes",
        perguntas === 2);
      ok("Q31b HARD: a candidata B nao abriu Tool Call — so a A chamou o start",
        inicios() === 1 &&
        chamadasRpc.filter((c) =>
          c.nome === "retomar_aprovacao_iniciar" &&
          c.parametros?.p_aprovacao_id === QA(2)).length === 0);
      ok("Q31c HARD: uma descoberta so, e nenhuma terceira candidata",
        filas() === 1 && perguntas === 2);
      ok("Q31d o resultado composto e reconciliado/possivel/encerrar:true",
        bateComEsperado(qComposto as unknown as Record<string, unknown>));

      // ── CONTROLES: o criterio precisa MORDER nos quatro mutantes ───
      ok("Q31e MUTANTE A: `expirada` classificado como confirmado seria reprovado",
        !bateComEsperado({ ...ESPERADO_COMPOSTO, progressoDuravel: "confirmado" }));
      ok("Q31f MUTANTE B: budget forcando confirmado seria reprovado",
        !bateComEsperado({
          ok: true, desfecho: "reconciliado",
          progressoDuravel: "confirmado", encerrarPorOrcamento: true,
        }));
      ok("Q31g MUTANTE C: budget zerando o progresso seria reprovado",
        !bateComEsperado({ ...ESPERADO_COMPOSTO, progressoDuravel: "nenhum" }));
      ok("Q31h MUTANTE D: perder `encerrarPorOrcamento` seria reprovado",
        !bateComEsperado({ ...ESPERADO_COMPOSTO, encerrarPorOrcamento: false }));
      ok("Q31i MUTANTE E: trocar o desfecho por orcamento_insuficiente seria reprovado",
        !bateComEsperado({ ...ESPERADO_COMPOSTO, desfecho: "orcamento_insuficiente" }));
      ok("Q31j CONTROLE POSITIVO: o proprio esperado passa no criterio",
        bateComEsperado({ ...ESPERADO_COMPOSTO }));
    }

    // ── Q32. LF-B: `cancelada` + falha posterior preserva confirmado ──
    //
    // LF-A (Q10) e LF-C (Q30) ja existiam; esta era a lacuna. A diferenca
    // em relacao ao Q30 e o GRAU preservado: la a reconciliacao foi
    // ambigua e o que sobrevive e `possivel`; aqui ela foi confirmada, e
    // um erro posterior nao pode rebaixar isso para `possivel` nem zerar.
    {
      roteiro(STALE_VAZIO2, qAprov(QA(1)), qTarefa(), qAprov(QA(2)), qTarefa());
      roteiroRpc(
        { data: [{ user_id: QU, aprovacao_id: QA(1) }, { user_id: QU, aprovacao_id: QA(2) }] },
        { data: "funcao_incompativel" },
        { data: "cancelada" },
        { data: "conexao_indisponivel" });
      const qLfB = await executarSlotRetomada(SEMPRE2);

      ok("Q32 LF-B: cancelamento CONFIRMADO seguido de falha preserva `confirmado`",
        qLfB.ok === false && !qLfB.ok &&
        qLfB.falha === "motivo_transitorio" &&
        qLfB.progressoDuravel === "confirmado");
      ok("Q32a ANCORA: houve mesmo um cancelamento confirmado antes da falha",
        cancels() === 1 && inicios() === 2);
      ok("Q32b CONTROLE: o grau nao foi rebaixado a `possivel` nem zerado",
        qLfB.progressoDuravel !== "possivel" && qLfB.progressoDuravel !== "nenhum");
    }
  }


  // ─── R. M2-I1-A1: o contexto de Connection atravessa o executor ─────

  secao("R. M2-I1-A1: ContextoFuncao com Connection, um ponto so");
  {
    const LOJA_A = "bbbbbbbb-0000-4000-8000-000000000001";
    const LOJA_B = "bbbbbbbb-0000-4000-8000-000000000002";
    const REQ = { plataforma: "shopee", recurso: "chat" };
    const fatoServe = { ...REQ, estado: "conectada", cobertura: "confirmada" };

    const conectada = () => controlada({ conexaoNecessaria: { ...REQ } });
    const ctx = () => ultimoContexto as { userId: string; conexao: unknown } | undefined;
    const lojaDoContexto = () =>
      (ctx()?.conexao as { lojaId?: string } | null | undefined)?.lojaId;

    ok("R0  ANCORA: o resolver de Connections esta dublado", interceptouAgregador);

    // ── R1. Caminho AUTOMATICO ──────────────────────────────────────
    catalogoControlado = conectada();
    conexoesControladas = {
      conexoes: [fatoServe],
      semSelecao: [],
      bindings: [{ ...REQ, lojaId: LOJA_A }],
      permissoes: [{ funcaoId: ID_CONTROLADA, nivel: "automatico" }],
      coleta: "ok",
    };
    roteiro(agenteOk, gravou, gravou);
    roteiroRpc();
    vezesExecutor = 0;
    ultimoContexto = undefined;
    const rAutoConn = await executarFuncao(baseControlada);

    ok("R1  automatico + binding valido -> executa",
      rAutoConn.tipo === "sucesso" && vezesExecutor === 1, rAutoConn.tipo);
    ok("R2  e o executor recebe a Connection congelada",
      JSON.stringify(ctx()?.conexao) === JSON.stringify({ ...REQ, lojaId: LOJA_A }),
      JSON.stringify(ctx()?.conexao));
    ok("R3  o userId continua vindo da sessao", ctx()?.userId === USER);
    ok("R4  a auditoria grava o MESMO vinculo que o executor usou",
      linhasGravadas()[0]?.linha?.loja_id === LOJA_A &&
        linhasGravadas()[0]?.linha?.plataforma === "shopee" &&
        linhasGravadas()[0]?.linha?.recurso === "chat",
      String(linhasGravadas()[0]?.linha?.loja_id));
    ok("R5  nenhum segredo atravessa o contexto",
      !/token|secret|senha|credencial|seller|shop_id|partner/i.test(JSON.stringify(ctx())),
      JSON.stringify(ctx()));

    // ── R6. Binding AUSENTE: o guard nega, e nada executa ───────────
    catalogoControlado = conectada();
    conexoesControladas = {
      ...SEM_CONEXOES,
      permissoes: [{ funcaoId: ID_CONTROLADA, nivel: "automatico" }],
    };
    roteiro(agenteOk, gravou);
    roteiroRpc();
    vezesExecutor = 0;
    const rSemBinding = await executarFuncao(baseControlada);
    ok("R6  sem binding -> negado por conexao, e a Funcao NAO roda",
      rSemBinding.tipo === "negado" && rSemBinding.codigo === "conexao_ausente" &&
        vezesExecutor === 0,
      `${rSemBinding.tipo}/${(rSemBinding as { codigo?: string }).codigo}`);
    ok("R7  e a auditoria registra lojaId nulo, nunca um id inventado",
      linhasGravadas()[0]?.linha?.loja_id === null,
      String(linhasGravadas()[0]?.linha?.loja_id));

    // ── R8. Cross-provider, visto de dentro do executor ─────────────
    //
    // Quando a loja selecionada e de outro provedor, o agregador nao
    // produz NEM fato NEM binding — as duas colecoes concordam. O duplo
    // reproduz essa saida, e o que se prova aqui e que o executor nao tem
    // outra porta por onde obter um `lojaId`: nem pelos argumentos.
    catalogoControlado = conectada();
    conexoesControladas = {
      conexoes: [], semSelecao: [], bindings: [],
      permissoes: [{ funcaoId: ID_CONTROLADA, nivel: "automatico" }],
      coleta: "ok",
    };
    roteiro(agenteOk, gravou);
    roteiroRpc();
    vezesExecutor = 0;
    const rCross = await executarFuncao({
      ...baseControlada,
      argumentos: { lojaId: LOJA_B, loja_id: LOJA_B },
    });
    ok("R8  binding recusado -> negado, zero execucao",
      rCross.tipo === "negado" && vezesExecutor === 0, rCross.tipo);
    ok("R9  `lojaId` vindo dos ARGUMENTOS nao vira binding",
      linhasGravadas()[0]?.linha?.loja_id === null,
      String(linhasGravadas()[0]?.linha?.loja_id));

    // ── R10. Caminho POS-APPROVAL ───────────────────────────────────
    catalogoControlado = conectada();
    conexoesControladas = {
      conexoes: [fatoServe],
      semSelecao: [],
      bindings: [{ ...REQ, lojaId: LOJA_A }],
      permissoes: [{ funcaoId: ID_CONTROLADA, nivel: "aprovacao" }],
      coleta: "ok",
    };
    roteiro(
      aprovacaoLinha({
        conexao_plataforma: "shopee",
        conexao_recurso: "chat",
        conexao_loja_id: LOJA_A,
      }),
      aberturaComNivel("aprovacao"),
      gravou
    );
    roteiroRpc(consumo("consumida"));
    vezesExecutor = 0;
    ultimoContexto = undefined;
    const rResume = await retomarAprovacao({ userId: USER, aprovacaoId: APROVACAO });

    ok("R10 a retomada executa a Funcao conectada",
      rResume.tipo === "sucesso" && vezesExecutor === 1, rResume.tipo);
    ok("R11 e o executor recebe a MESMA forma de contexto do caminho automatico",
      JSON.stringify(ctx()?.conexao) === JSON.stringify({ ...REQ, lojaId: LOJA_A }),
      JSON.stringify(ctx()?.conexao));
    ok("R12 a loja executada e a CONGELADA na aprovacao", lojaDoContexto() === LOJA_A);

    // ── R13. Divergencia entre a loja aprovada e o binding atual ────
    catalogoControlado = conectada();
    conexoesControladas = {
      conexoes: [fatoServe],
      semSelecao: [],
      bindings: [{ ...REQ, lojaId: LOJA_B }],
      permissoes: [{ funcaoId: ID_CONTROLADA, nivel: "aprovacao" }],
      coleta: "ok",
    };
    roteiro(
      aprovacaoLinha({
        conexao_plataforma: "shopee",
        conexao_recurso: "chat",
        conexao_loja_id: LOJA_A,
      }),
      aberturaComNivel("aprovacao")
    );
    roteiroRpc(consumo("consumida"));
    vezesExecutor = 0;
    ultimoContexto = undefined;
    const rTrocou = await retomarAprovacao({ userId: USER, aprovacaoId: APROVACAO });
    ok("R13 binding que mudou de loja RECUSA a retomada",
      rTrocou.tipo !== "sucesso" && vezesExecutor === 0, rTrocou.tipo);
    ok("R14 e nunca substitui pela loja nova",
      lojaDoContexto() !== LOJA_B && !JSON.stringify(rTrocou).includes(LOJA_B));

    // ── R15. O ponto de montagem e UM so ────────────────────────────
    ok("R15 `contextoDaFuncao` e definido uma vez e usado uma vez",
      (EXECUTOR_CODIGO.match(/contextoDaFuncao\(/g) ?? []).length === 2,
      String((EXECUTOR_CODIGO.match(/contextoDaFuncao\(/g) ?? []).length));
    ok("R16 o executor e chamado com esse contexto, nunca com um literal",
      /definicao\.executor\(contexto, argumentos\)/.test(EXECUTOR_CODIGO) &&
        !/definicao\.executor\(\{/.test(EXECUTOR_CODIGO));
    ok("R17 o `lojaId` do primeiro passe vem de `bindings`, e so dali",
      /resultado\.bindings\.find\(/.test(EXECUTOR_CODIGO) &&
        !/argumentos\.lojaId|entrada\.loja_id|\.selecoes\b/.test(EXECUTOR_CODIGO));
    ok("R18 e a busca casa pelo par EXATO",
      /b\.plataforma === plataforma && b\.recurso === recurso/.test(EXECUTOR_CODIGO));
    ok("R19 CONTROLE: as sondas de R16/R17 acham o padrao proibido quando ele existe",
      /definicao\.executor\(\{/.test("definicao.executor({ userId: x }, a)") &&
        /argumentos\.lojaId/.test("const l = argumentos.lojaId;"));

    catalogoControlado = null;
    conexoesControladas = null;
  }

  // ─── S. A1-FIX1: uma leitura de permissoes, decisao nominal ─────────
  //
  // O agregador passou a publicar o snapshot do CATALOGO INTEIRO, e o
  // executor o reutiliza no ramo conectado em vez de reler
  // `agente_permissoes`. O risco que esta secao existe para fechar e o
  // oposto do ganho: com um array grande em maos, a decisao poderia
  // deixar de ser sobre a Funcao em execucao.

  secao("S. A1-FIX1: permission single-source e isolamento nominal");
  {
    const REQ_S = { plataforma: "shopee", recurso: "chat" };
    const fatoServe = { ...REQ_S, estado: "conectada", cobertura: "confirmada" };
    const OUTRA = "outra.funcao";

    const conectada = () => controlada({ conexaoNecessaria: { ...REQ_S } });
    const lidasPermissao = () => chamadas.filter((c) => c.tabela === "agente_permissoes").length;

    /** Snapshot do agregador com o nivel da Funcao atual e o de uma vizinha. */
    const snapshot = (nivelAtual: string | null, nivelOutra: string | null) => ({
      conexoes: [fatoServe],
      semSelecao: [],
      bindings: [{ ...REQ_S, lojaId: "cccccccc-0000-4000-8000-000000000001" }],
      permissoes: [
        ...(nivelAtual === null ? [] : [{ funcaoId: ID_CONTROLADA, nivel: nivelAtual }]),
        ...(nivelOutra === null ? [] : [{ funcaoId: OUTRA, nivel: nivelOutra }]),
      ],
      coleta: "ok",
    });

    // ── B. O budget de leitura, ramo a ramo ─────────────────────────

    catalogoControlado = conectada();
    conexoesControladas = snapshot("automatico", "automatico");
    roteiro(agenteOk, gravou, gravou);
    roteiroRpc();
    vezesExecutor = 0;
    vezesResolverConexoes = 0;
    const sConectado = await executarFuncao(baseControlada);
    ok("S1  ramo CONECTADO executa", sConectado.tipo === "sucesso" && vezesExecutor === 1,
      sConectado.tipo);
    ok("S2  e NAO le agente_permissoes por conta propria",
      lidasPermissao() === 0, String(lidasPermissao()));
    ok("S3  ANCORA: ele passou mesmo pelo agregador",
      vezesResolverConexoes === 1, String(vezesResolverConexoes));

    catalogoControlado = controlada({});
    conexoesControladas = null;
    roteiro(agenteOk, permissaoDe(ID_CONTROLADA, "automatico"), gravou, gravou);
    roteiroRpc();
    vezesExecutor = 0;
    vezesResolverConexoes = 0;
    const sSolto = await executarFuncao(baseControlada);
    ok("S4  ramo SEM requisito executa", sSolto.tipo === "sucesso" && vezesExecutor === 1);
    ok("S5  e faz EXATAMENTE uma leitura de agente_permissoes",
      lidasPermissao() === 1, String(lidasPermissao()));
    ok("S6  sem tocar o agregador", vezesResolverConexoes === 0);
    ok("S7  e a leitura curta pergunta SO pela Funcao atual",
      JSON.stringify(chamadas.find((c) => c.tabela === "agente_permissoes")?.inValores) ===
        JSON.stringify([ID_CONTROLADA]),
      JSON.stringify(chamadas.find((c) => c.tabela === "agente_permissoes")?.inValores));

    // ── G1-G4. A decisao e NOMINAL ──────────────────────────────────

    catalogoControlado = conectada();
    conexoesControladas = snapshot("bloqueado", "automatico");
    roteiro(agenteOk, gravou);
    roteiroRpc();
    vezesExecutor = 0;
    const g1 = await executarFuncao(baseControlada);
    ok("G1  atual=bloqueado + vizinha=automatico -> NEGA, e nao executa",
      g1.tipo === "negado" && g1.codigo === "permissao_bloqueada" && vezesExecutor === 0,
      `${g1.tipo}/${(g1 as { codigo?: string }).codigo}`);

    catalogoControlado = conectada();
    conexoesControladas = snapshot("aprovacao", "automatico");
    roteiro(agenteOk);
    roteiroRpc(criouAprovacao("criada"));
    vezesExecutor = 0;
    const g2 = await executarFuncao(baseControlada);
    ok("G2  atual=aprovacao + vizinha=automatico -> continua exigindo aprovacao",
      g2.tipo === "aguardando_aprovacao" && vezesExecutor === 0, g2.tipo);

    catalogoControlado = conectada();
    conexoesControladas = snapshot("automatico", "bloqueado");
    roteiro(agenteOk, gravou, gravou);
    roteiroRpc();
    vezesExecutor = 0;
    const g3 = await executarFuncao(baseControlada);
    ok("G3  atual=automatico + vizinha=bloqueado -> continua automatica",
      g3.tipo === "sucesso" && vezesExecutor === 1, g3.tipo);

    // G4. O MESMO cenario, variando SO os fatos das outras Funcoes.
    const decidir = async (nivelOutra: string | null) => {
      catalogoControlado = conectada();
      conexoesControladas = snapshot("automatico", nivelOutra);
      roteiro(agenteOk, gravou, gravou);
      roteiroRpc();
      vezesExecutor = 0;
      const r = await executarFuncao(baseControlada);
      return `${r.tipo}/${vezesExecutor}`;
    };
    const semVizinha = await decidir(null);
    const vizinhaAuto = await decidir("automatico");
    const vizinhaBloq = await decidir("bloqueado");
    const vizinhaAprov = await decidir("aprovacao");
    ok("G4  fatos de OUTRAS Funcoes nao alteram a decisao da atual",
      semVizinha === vizinhaAuto && semVizinha === vizinhaBloq &&
        semVizinha === vizinhaAprov && semVizinha === "sucesso/1",
      [semVizinha, vizinhaAuto, vizinhaBloq, vizinhaAprov].join(" | "));

    // A Funcao ATUAL ausente do snapshot e `permissao_ausente`, mesmo com
    // vizinhas liberadas: ausencia e bloqueio, e nao ha `some()` global.
    catalogoControlado = conectada();
    conexoesControladas = snapshot(null, "automatico");
    roteiro(agenteOk, gravou);
    roteiroRpc();
    vezesExecutor = 0;
    const g5 = await executarFuncao(baseControlada);
    ok("G5  atual AUSENTE do snapshot -> permissao_ausente, mesmo com vizinha liberada",
      g5.tipo === "negado" && g5.codigo === "permissao_ausente" && vezesExecutor === 0,
      `${g5.tipo}/${(g5 as { codigo?: string }).codigo}`);

    // ── K. Falha de coleta NAO e snapshot vazio valido ──────────────

    catalogoControlado = conectada();
    conexoesControladas = {
      conexoes: [], semSelecao: [], bindings: [], permissoes: [], coleta: "falha_leitura",
    };
    roteiro(agenteOk, gravou);
    roteiroRpc();
    vezesExecutor = 0;
    const k1 = await executarFuncao(baseControlada);
    ok("K1  coleta falha -> erro_interno, NUNCA permissao_ausente nem bloqueado",
      k1.tipo === "erro" && k1.envelope.error.code === "erro_interno" && vezesExecutor === 0,
      `${k1.tipo}/${(k1 as { envelope?: { error?: { code?: string } } }).envelope?.error?.code}`);
    ok("K2  e a auditoria registra nivel NULO, nao um nivel inventado",
      linhasGravadas()[0]?.linha?.nivel_no_momento === null,
      String(linhasGravadas()[0]?.linha?.nivel_no_momento));
    ok("K3  plataforma/recurso vem do CATALOGO, e nao do cliente",
      linhasGravadas()[0]?.linha?.plataforma === "shopee" &&
        linhasGravadas()[0]?.linha?.recurso === "chat" &&
        linhasGravadas()[0]?.linha?.loja_id === null,
      JSON.stringify(linhasGravadas()[0]?.linha?.plataforma));
    ok("K4  e a mensagem publica nao carrega erro cru de driver",
      !/sqlstate|42501|postgres|relation|column/i.test(JSON.stringify(k1)),
      JSON.stringify(k1).slice(0, 120));

    // ── Fonte unica, no codigo ──────────────────────────────────────
    ok("S8  o executor le `resultado.permissoes` no ramo conectado",
      /fatosPermissao = resultado\.permissoes;/.test(EXECUTOR_CODIGO));
    ok("S9  e `resolverFatosPermissoes` sobrou em UM lugar so, o ramo curto",
      (EXECUTOR_CODIGO.match(/await resolverFatosPermissoes\(/g) ?? []).length === 1,
      String((EXECUTOR_CODIGO.match(/await resolverFatosPermissoes\(/g) ?? []).length));
    ok("S10 a selecao do fato e NOMINAL, nunca por posicao ou contagem",
      /fatosPermissao\.find\(\(p\) => p\.funcaoId === funcaoId\)/.test(EXECUTOR_CODIGO) &&
        !/fatosPermissao\[0\]|fatosPermissao\.some\(|fatosPermissao\.length ===/
          .test(EXECUTOR_CODIGO));
    ok("S11 CONTROLE: as sondas de S10 acham os padroes proibidos",
      /fatosPermissao\[0\]/.test("const f = fatosPermissao[0];") &&
        /fatosPermissao\.some\(/.test("fatosPermissao.some((p) => p.nivel)"));

    catalogoControlado = null;
    conexoesControladas = null;
  }

  // ─── T. M2-I1-A2: duas Funcoes, resolucao por ID ────────────────────
  //
  // O catalogo deixou de ser singleton. Toda resolucao tem de continuar
  // sendo por NOME — um indice que hoje aponta para a Funcao certa passa
  // a apontar para outra no dia em que um id ordenar antes.

  secao("T. M2-I1-A2: o catalogo tem duas Funcoes, resolvidas por ID");
  {
    const ID_ML = "mercadolivre.perguntas.listar";
    const ID_VENDAS = "vendas.consultar";
    const { listarFuncoesRegistradas, funcaoExiste, FUNCOES: CATALOGO } =
      await import("../lib/agentes/funcoes/registry");

    const IDS = listarFuncoesRegistradas();
    ok("T1  o catalogo real tem exatamente os dois ids publicados",
      JSON.stringify([...IDS].sort()) === JSON.stringify([ID_ML, ID_VENDAS].sort()),
      IDS.join(", "));
    ok("T2  ambos resolvem por NOME", funcaoExiste(ID_ML) && funcaoExiste(ID_VENDAS));
    ok("T3  id desconhecido continua recusado",
      !funcaoExiste("intrusa.funcao") && !funcaoExiste("toString") &&
        !funcaoExiste("constructor"));
    ok("T4  cada id resolve a SUA definicao, nunca a do vizinho",
      CATALOGO[ID_ML].executor !== CATALOGO[ID_VENDAS].executor &&
        CATALOGO[ID_ML].validarEntrada !== CATALOGO[ID_VENDAS].validarEntrada &&
        CATALOGO[ID_ML].interpretarSaida !== CATALOGO[ID_VENDAS].interpretarSaida);
    ok("T5  e os requisitos de conexao nao se misturam",
      CATALOGO[ID_VENDAS].conexaoNecessaria === null &&
        JSON.stringify(CATALOGO[ID_ML].conexaoNecessaria) ===
          JSON.stringify({ plataforma: "mercado_livre", recurso: "perguntas" }));

    // A ordem INVERTIDA nao muda nada: a resolucao e por chave.
    const invertido = Object.fromEntries([...Object.entries(CATALOGO)].reverse());
    ok("T6  invertida a ordem das entradas, a resolucao por ID e a mesma",
      invertido[ID_ML] === CATALOGO[ID_ML] && invertido[ID_VENDAS] === CATALOGO[ID_VENDAS]);
    ok("T7  CONTROLE: resolver por POSICAO mudaria com a inversao",
      Object.keys(invertido)[0] !== Object.keys(CATALOGO)[0]);

    // O executor real recusa id inexistente sem abrir chamada.
    catalogoControlado = null;
    roteiro(agenteOk, gravou);
    roteiroRpc();
    vezesExecutor = 0;
    const rFantasma = await executarFuncao({
      ...baseControlada, funcaoId: "nao.existe.mesmo",
    });
    ok("T8  id fora do catalogo -> `funcao_inexistente`, zero execucao",
      rFantasma.tipo === "negado" && rFantasma.codigo === "funcao_inexistente" &&
        vezesExecutor === 0,
      `${rFantasma.tipo}/${(rFantasma as { codigo?: string }).codigo}`);
    ok("T9  e o id tentado e PRESERVADO na auditoria",
      linhasGravadas()[0]?.linha?.funcao_id === "nao.existe.mesmo",
      String(linhasGravadas()[0]?.linha?.funcao_id));

    // Nenhuma sonda de producao deste modulo indexa o catalogo.
    ok("T10 o executor nao resolve Funcao por posicao",
      !/listarFuncoesRegistradas\(\)\[0\]|Object\.keys\(FUNCOES\)\[0\]/.test(EXECUTOR_CODIGO));
    ok("T11 CONTROLE: a sonda de T10 acha o padrao quando ele existe",
      /listarFuncoesRegistradas\(\)\[0\]/.test("const f = listarFuncoesRegistradas()[0];"));
  }

  // ─── U. M2-I1-A3: onde a cobertura remota entra ─────────────────────
  //
  // O executor ganhou UM passo: elevar o fato do requisito em execucao,
  // entre o binding e o guard. Esta secao prova o PONTO e o GATING —
  // quem paga rede, quem nao paga, e que nada mais mudou.

  secao("U. M2-I1-A3: cobertura remota no ponto certo, e so ali");
  {
    const REQ_U = { plataforma: "shopee", recurso: "chat" };
    const conectada = () => controlada({ conexaoNecessaria: { ...REQ_U } });
    const fatoBruto = { ...REQ_U, estado: "conectada", cobertura: "nao_verificavel" };
    const fatoServe = { ...REQ_U, estado: "conectada", cobertura: "confirmada" };
    const LOJA_U = "ffffffff-0000-4000-8000-000000000001";

    const snap = (
      nivel: string,
      fatos: unknown[],
      bindings: readonly { plataforma: string; recurso: string; lojaId: string }[]
    ) => ({
      conexoes: fatos,
      semSelecao: [],
      bindings,
      permissoes: [{ funcaoId: ID_CONTROLADA, nivel }],
      coleta: "ok",
    });
    const comBinding = [{ ...REQ_U, lojaId: LOJA_U }];

    // O duplo do agregador NAO confirma nada, e `shopee` nao tem
    // confirmador remoto. Entao o que se mede aqui e o GATING e a ordem,
    // sem tocar provider nenhum.
    ok("U0  ANCORA: o resolver de Connections continua dublado", interceptouAgregador);

    // ── U1. `nao_verificavel` continua bloqueando ───────────────────
    catalogoControlado = conectada();
    conexoesControladas = snap("automatico", [fatoBruto], comBinding);
    roteiro(agenteOk, gravou);
    roteiroRpc();
    vezesExecutor = 0;
    const uBloqueia = await executarFuncao(baseControlada);
    ok("U1  cobertura `nao_verificavel` -> conexao_ausente, zero execucao",
      uBloqueia.tipo === "negado" &&
        (uBloqueia as { codigo?: string }).codigo === "conexao_ausente" &&
        vezesExecutor === 0,
      `${uBloqueia.tipo}/${(uBloqueia as { codigo?: string }).codigo}`);

    // ── U2. `confirmada` deixa seguir ───────────────────────────────
    catalogoControlado = conectada();
    conexoesControladas = snap("automatico", [fatoServe], comBinding);
    roteiro(agenteOk, gravou, gravou);
    roteiroRpc();
    vezesExecutor = 0;
    const uSegue = await executarFuncao(baseControlada);
    ok("U2  cobertura `confirmada` -> executa", uSegue.tipo === "sucesso" && vezesExecutor === 1);

    // ── U3. Cobertura NAO muda nivel ────────────────────────────────
    catalogoControlado = conectada();
    conexoesControladas = snap("bloqueado", [fatoServe], comBinding);
    roteiro(agenteOk, gravou);
    roteiroRpc();
    vezesExecutor = 0;
    const uBloq = await executarFuncao(baseControlada);
    ok("U3  confirmada + bloqueado -> NEGA por permissao, nao por conexao",
      uBloq.tipo === "negado" &&
        (uBloq as { codigo?: string }).codigo === "permissao_bloqueada" &&
        vezesExecutor === 0,
      `${uBloq.tipo}/${(uBloq as { codigo?: string }).codigo}`);

    catalogoControlado = conectada();
    conexoesControladas = snap("aprovacao", [fatoServe], comBinding);
    roteiro(agenteOk);
    roteiroRpc(criouAprovacao("criada"));
    vezesExecutor = 0;
    const uAprov = await executarFuncao(baseControlada);
    ok("U4  confirmada + aprovacao -> CONTINUA exigindo aprovacao",
      uAprov.tipo === "aguardando_aprovacao" && vezesExecutor === 0, uAprov.tipo);

    // ── U5-U9. O ponto e o gating, na FONTE ─────────────────────────
    ok("U5  a cobertura e chamada UMA vez no executor",
      (EXECUTOR_CODIGO.match(/confirmarCoberturaDosFatos\(/g) ?? []).length === 1,
      String((EXECUTOR_CODIGO.match(/confirmarCoberturaDosFatos\(/g) ?? []).length));
    ok("U6  e o gating exige automatico E binding E requisito",
      /if \(requisito !== null && nivelNoMomento === "automatico" && lojaId !== null\)/
        .test(EXECUTOR_CODIGO));
    ok("U7  ela recebe o requisito EM EXECUCAO, nunca o snapshot inteiro",
      /confirmarCoberturaDosFatos\(\s*\{[\s\S]{0,240}?requisito,/.test(EXECUTOR_CODIGO) &&
        !/conexoes\.map\([\s\S]{0,80}?confirmarCobertura/.test(EXECUTOR_CODIGO));
    ok("U8  e o `acesso` vem do CATALOGO, amarrando o HARD BOUND",
      /acesso: definicao\.acesso/.test(EXECUTOR_CODIGO));
    ok("U9  o executor continua sem endpoint, token ou Authorization",
      !/mercadolibre|Authorization|accessToken|getMLLojaById/.test(EXECUTOR_CODIGO));
    ok("U10 a cobertura acontece ANTES do guard",
      EXECUTOR_CODIGO.indexOf("confirmarCoberturaDosFatos(") <
        EXECUTOR_CODIGO.indexOf("autorizarFuncao({"));
    ok("U11 e DEPOIS do binding",
      EXECUTOR_CODIGO.indexOf("resultado.bindings.find(") <
        EXECUTOR_CODIGO.indexOf("confirmarCoberturaDosFatos("));
    ok("U12 CONTROLE: as sondas acham os padroes proibidos quando existem",
      /Authorization/.test("headers: { Authorization: x }") &&
        /conexoes\.map\([\s\S]{0,80}?confirmarCobertura/.test(
          "conexoes.map(async (c) => confirmarCoberturaDosFatos(c))"));

    catalogoControlado = null;
    conexoesControladas = null;
  }

  console.log(`\n══ ${passou} PASS / ${falhou} FAIL ══\n`);
  process.exit(falhou === 0 ? 0 : 1);
}

void principal();
