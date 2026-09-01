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
}

interface Resposta {
  data?: unknown;
  error?: Record<string, unknown> | null;
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
  const c: Chamada = { tabela, filtros: {}, escrita: false };
  const resolver = (fn: (v: { data: unknown; error: unknown }) => void) => {
    chamadas.push(c);
    const r = respostas[consumidas++];
    fn({ data: r?.data ?? null, error: r?.error ?? null });
  };
  const b: Record<string, unknown> = {
    select() { return b; },
    eq(coluna: string, valor: unknown) { c.filtros[coluna] = valor; return b; },
    in() { return b; },
    order() { return b; },
    limit() { return b; },
    gte() { return b; },
    lte() { return b; },
    gt() { return b; },
    lt() { return b; },
    insert(linha: Record<string, unknown>) { c.escrita = true; c.linha = linha; return b; },
    update() { c.escrita = true; return b; },
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
    return Promise.resolve({ data: r?.data ?? null, error: r?.error ?? null });
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

const requireOriginal = (Module as unknown as { prototype: { require: (id: string) => unknown } }).prototype.require;
let interceptou = false;
let interceptouCatalogo = false;
(Module as unknown as { prototype: { require: unknown } }).prototype.require = function (this: unknown, id: string) {
  if (typeof id === "string" && id.includes("supabase-servidor")) {
    interceptou = true;
    return { getSupabaseServidor: () => clienteFake };
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
      JSON.stringify(ultimoContexto) === JSON.stringify({ userId: USER }));
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

  console.log(`\n══ ${passou} PASS / ${falhou} FAIL ══\n`);
  process.exit(falhou === 0 ? 0 : 1);
}

void principal();
