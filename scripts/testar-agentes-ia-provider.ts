/**
 * Suite do provedor real (Anthropic) — AGENTES-FASE1E-d.
 *
 * SEM REDE, SEM chamada real, SEM credencial, SEM banco.
 *
 * ── A ordem dos blocos e parte da prova ─────────────────────────────
 * O modulo do adaptador NAO e importado no topo. Ele entra por
 * `await import()` no meio da suite, DEPOIS do grupo B — que verifica
 * que, com a flag de provedor real desligada, o SDK da Anthropic nem
 * chega a `require.cache`.
 *
 * Se o import fosse estatico, o SDK estaria carregado antes do primeiro
 * assert e essa verificacao viraria vacuidade. Import hoisting nao e
 * detalhe de estilo aqui: e a diferenca entre provar e fingir que
 * provou.
 *
 * ── Como o provedor e exercitado sem rede ───────────────────────────
 * `criarAdaptadorAnthropic(chamar)` aceita a funcao de texto por
 * parametro. O teste injeta um duble que registra o que recebeu e
 * devolve o que o caso precisa. O parametro existe para isso — nunca
 * para que entrada de tarefa escolha provedor.
 *
 * O que NAO da para exercitar assim, e onde a prova e estrutural: o
 * repasse do `timeoutMs` ao SDK acontece dentro de `chamarClaudeTexto`,
 * que constroi o cliente internamente. Para essa parte a suite inspeciona
 * a FONTE com bloco delimitado, ancora e controle negativo, e compara o
 * arquivo com a versao em HEAD para provar que so o que foi autorizado
 * mudou. Isso esta declarado, nao disfarcado de teste de comportamento.
 */
import { readFileSync } from "fs";
import { join } from "path";
import { execFileSync } from "child_process";

import {
  NOME_FLAG_INTERPRETACAO_VENDAS,
  NOME_FLAG_PROVEDOR_REAL,
  interpretacaoDeVendasHabilitada,
  provedorRealHabilitado,
  criarInterpretadorDeVendas,
  comInterpretacaoDeVendas,
  CHAVE_ORIGEM_INTERPRETACAO,
} from "../lib/agentes/ativacao-ia";
import { validarAnaliseVendasIA, SCHEMA_ANALISE_VENDAS_IA } from "../lib/agentes/ia/contrato-analise";
// `mapearErroAnthropic` NAO entra aqui: importa-lo estaticamente
// carregaria `@anthropic-ai/sdk` antes do primeiro assert e tornaria o
// grupo B vacuo. Ele e importado dinamicamente, DEPOIS de B. Foi
// exatamente assim que esta suite falhou na primeira execucao.
import { ErroProvedorIA } from "../lib/ai-gateway/erros";
import type { AnaliseVendasDeterministica } from "../lib/agentes/ia/interpretar-analise-vendas";
import type { ContextoTarefa, HandlerTarefa } from "../lib/agentes/tipos-execucao";
import type { ChamarTextoAnthropic } from "../lib/agentes/adaptador-anthropic";
import type { PedidoIA } from "../lib/agentes/ia/tipos";

// ── Armadilha de rede ─────────────────────────────────────────────────
let chamadasDeRede = 0;
(globalThis as unknown as { fetch: unknown }).fetch = (...args: unknown[]) => {
  chamadasDeRede++;
  throw new Error(`suite 1E-d: fetch proibido (${String(args[0]).slice(0, 60)})`);
};

const RAIZ = join(__dirname, "..");
const CAMINHO_PROVEDOR = "lib/ai-gateway/provedores/anthropic.ts";
const FONTE_PROVEDOR = readFileSync(join(RAIZ, CAMINHO_PROVEDOR), "utf8");
const FONTE_ADAPTADOR = readFileSync(join(RAIZ, "lib", "agentes", "adaptador-anthropic.ts"), "utf8");
const FONTE_WIRING = readFileSync(join(RAIZ, "lib", "agentes", "ativacao-ia.ts"), "utf8");

let passou = 0;
let falhou = 0;
function ok(nome: string, condicao: boolean) {
  if (condicao) passou++;
  else {
    falhou++;
    console.error(`  x ${nome}`);
  }
}

async function capturar(acao: () => Promise<unknown>) {
  return acao().then(
    (valor) => ({ lancou: false, erro: undefined as unknown, valor }),
    (erro: unknown) => ({ lancou: true, erro, valor: undefined })
  );
}

function semComentarios(f: string): string {
  let s = "", i = 0, d: string | null = null;
  while (i < f.length) {
    const c = f[i], n = f[i + 1];
    if (d !== null) { s += c; if (c === "\\") { s += f[i + 1] ?? ""; i += 2; continue; } if (c === d) d = null; i++; continue; }
    if (c === '"' || c === "'" || c === "`") { d = c; s += c; i++; continue; }
    if (c === "/" && n === "/") { while (i < f.length && f[i] !== "\n") i++; continue; }
    if (c === "/" && n === "*") { i += 2; while (i < f.length && !(f[i] === "*" && f[i + 1] === "/")) i++; i += 2; s += " "; continue; }
    s += c; i++;
  }
  return s;
}
const COD_PROVEDOR = semComentarios(FONTE_PROVEDOR);
const COD_ADAPTADOR = semComentarios(FONTE_ADAPTADOR);
const COD_WIRING = semComentarios(FONTE_WIRING);

/** Roda com um conjunto de envs, restaurando tudo em `finally`. */
async function comEnv<T>(valores: Record<string, string | undefined>, acao: () => Promise<T> | T): Promise<T> {
  const anterior = new Map<string, { tinha: boolean; valor: string | undefined }>();
  for (const nome of Object.keys(valores)) {
    anterior.set(nome, {
      tinha: Object.prototype.hasOwnProperty.call(process.env, nome),
      valor: process.env[nome],
    });
  }
  try {
    for (const [nome, valor] of Object.entries(valores)) {
      if (valor === undefined) delete process.env[nome];
      else process.env[nome] = valor;
    }
    return await acao();
  } finally {
    for (const [nome, est] of anterior) {
      if (est.tinha) process.env[nome] = est.valor as string;
      else delete process.env[nome];
    }
  }
}

const NOME_ENV_MODELO = "AGENTES_ANTHROPIC_MODEL";

function analiseFixture(): AnaliseVendasDeterministica {
  return {
    escopo: { campoData: "data_pagamento", statusConsiderado: "paid", incluiRentabilidade: false },
    periodo: { inicio: "2026-05-01", fim: "2026-05-07", marketplace: null },
    totais: { pedidosPagos: 12, unidades: 19, faturamento: 4830.5, ticketMedio: 402.54 },
    marketplaces: [{ marketplace: "shopee", pedidos: 5, unidades: 8, faturamento: 1820.5 }],
    skus: [{ sku: "SKU-ALFA", anuncio: "Anuncio Alfa Premium", marketplace: "shopee", pedidos: 4, unidades: 6, faturamento: 1900.0, anunciosDistintos: 2 }],
    qualidadeDados: { linhas: 24, linhasSemSku: 2, linhasSemValor: 1, skusDistintos: 9, skusOmitidos: 7 },
  };
}

function contextoFalso(entrada: Record<string, unknown> = {}): ContextoTarefa {
  return {
    tarefaId: "11111111-1111-1111-1111-111111111111",
    agenteId: "22222222-2222-2222-2222-222222222222",
    userId: "33333333-3333-3333-3333-333333333333",
    tipo: "analise_vendas", entrada, tentativa: 1, maxTentativas: 3,
  };
}

function baseFalso(reg: { chamadas: number }): HandlerTarefa {
  return async function handlerAnaliseVendas(_c, relatar) {
    reg.chamadas++;
    relatar(100);
    return analiseFixture() as unknown as Record<string, unknown>;
  };
}

function pedidoFixture(): PedidoIA<ReturnType<typeof validarAnaliseVendasIA>> {
  return {
    instrucao: "Interprete os fatos. Nao invente numero.",
    dados: JSON.stringify({ totais: { pedidosPagos: 12 } }, null, 2),
    schema: SCHEMA_ANALISE_VENDAS_IA,
    validar: validarAnaliseVendasIA,
  };
}

const RESPOSTA_VALIDA = JSON.stringify({ resumo: "periodo estavel", destaques: ["SKU-ALFA lidera"], alertas: [] });

/** Duble da funcao de texto do provedor. Registra o que recebeu. */
function chamarFalso(opcoes: {
  resultadoTexto?: string;
  erro?: unknown;
  modelo?: string;
  tokensEntrada?: number;
  tokensSaida?: number;
  tempoMs?: number;
}): { chamar: ChamarTextoAnthropic; chamadas: Parameters<ChamarTextoAnthropic>[0][] } {
  const chamadas: Parameters<ChamarTextoAnthropic>[0][] = [];
  const chamar: ChamarTextoAnthropic = async (params) => {
    chamadas.push(params);
    if (opcoes.erro !== undefined) throw opcoes.erro;
    return {
      resultadoTexto: opcoes.resultadoTexto ?? RESPOSTA_VALIDA,
      modelo: opcoes.modelo ?? "claude-modelo-resolvido-pela-api",
      tokensEntrada: opcoes.tokensEntrada ?? 1234,
      tokensSaida: opcoes.tokensSaida ?? 567,
      tempoMs: opcoes.tempoMs ?? 4321,
    };
  };
  return { chamar, chamadas };
}

async function main() {
  console.log("\nAGENTES-FASE1E-d — provedor real (Anthropic), sem rede\n");

  // ═══ B. FLAG REAL OFF: o SDK nem entra no processo ════════════════
  console.log("B. Provedor real DESLIGADO");
  {
    const sdkNoGrafo = () => Object.keys(require.cache).some((p) => p.replace(/\\/g, "/").includes("@anthropic-ai"));
    const modulosCarregados = () => Object.keys(require.cache).map((p) => p.replace(/\\/g, "/"));
    ok("B0 ANCORA: nem o adaptador nem o provedor foram importados ate aqui",
       !modulosCarregados().some((p) => /adaptador-anthropic\.ts|provedores\/anthropic\.ts/.test(p)));
    ok("B1 o SDK da Anthropic NAO esta no grafo", !sdkNoGrafo());

    // Interpretacao ON + real OFF => fake, e o SDK continua fora.
    const r = await comEnv(
      { [NOME_FLAG_INTERPRETACAO_VENDAS]: "true", [NOME_FLAG_PROVEDOR_REAL]: undefined },
      async () => {
        const interpretar = criarInterpretadorDeVendas();
        const envolvido = comInterpretacaoDeVendas(baseFalso({ chamadas: 0 }), interpretar);
        return envolvido(contextoFalso(), () => {});
      }
    );
    ok("B2 com real OFF, o provedor usado e o FAKE", (r[CHAVE_ORIGEM_INTERPRETACAO] as { provedor: string }).provedor === "fake");
    ok("B3 e o SDK CONTINUA fora do grafo depois de interpretar", !sdkNoGrafo());
    ok("B4 zero rede", chamadasDeRede === 0);

    // Politica da flag nova: so "true" exato.
    for (const [rot, valor] of [["ausente", undefined], ["vazia", ""], ["0", "0"], ["false", "false"],
                                ["1", "1"], ["TRUE", "TRUE"], ["yes", "yes"], [" true ", " true "], ["lixo", "zzz"]] as Array<[string, string | undefined]>) {
      ok(`B5 flag de provedor "${rot}" => OFF`, await comEnv({ [NOME_FLAG_PROVEDOR_REAL]: valor }, () => provedorRealHabilitado()) === false);
    }
    ok("B6 \"true\" exato => ON", await comEnv({ [NOME_FLAG_PROVEDOR_REAL]: "true" }, () => provedorRealHabilitado()) === true);
    ok("B7 as duas flags sao independentes",
       await comEnv({ [NOME_FLAG_INTERPRETACAO_VENDAS]: undefined, [NOME_FLAG_PROVEDOR_REAL]: "true" },
                    () => interpretacaoDeVendasHabilitada() === false && provedorRealHabilitado() === true));
    ok("B8 INTERPRETACAO OFF => interpretador nem e construido",
       await comEnv({ [NOME_FLAG_INTERPRETACAO_VENDAS]: undefined, [NOME_FLAG_PROVEDOR_REAL]: "true" },
                    () => criarInterpretadorDeVendas() === null));
    ok("B9 o import do adaptador e DINAMICO no wiring", /await import\("@\/lib\/agentes\/adaptador-anthropic"\)/.test(COD_WIRING));
    ok("B10 e NAO ha import estatico dele", !/^import[^\n]*adaptador-anthropic/m.test(COD_WIRING));
  }

  // ═══ A. PROVEDOR COMPARTILHADO — retrocompatibilidade ═════════════
  console.log("A. anthropic.ts — alteracao minima e retrocompativel");
  {
    // Import DINAMICO: so agora o SDK pode entrar no grafo — o grupo B
    // ja provou que ate aqui ele estava fora.
    const { mapearErroAnthropic } = await import("../lib/ai-gateway/provedores/anthropic");
    ok("A0 ANCORA: fonte do provedor lida e nao truncada", COD_PROVEDOR.includes("export async function chamarClaudeTexto") && COD_PROVEDOR.length > 2000);

    // O que MUDOU, comparado com HEAD, tem de ser so o autorizado.
    const emHead = execFileSync("git", ["show", `HEAD:${CAMINHO_PROVEDOR}`], { cwd: RAIZ, encoding: "utf8", maxBuffer: 20e6 });
    const codHead = semComentarios(emHead);
    const linhas = (t: string) => t.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
    const antes = new Set(linhas(codHead));
    const depois = new Set(linhas(COD_PROVEDOR));
    const adicionadas = [...depois].filter((l) => !antes.has(l));
    const removidas = [...antes].filter((l) => !depois.has(l));
    ok(`A1 apenas linhas do timeout foram acrescentadas (${adicionadas.length})`,
       adicionadas.every((l) => /timeoutMs\?: number;|const resposta = await cliente\.messages\.create\($|\{$|\} as Anthropic\.MessageCreateParamsNonStreaming,$|params\.timeoutMs === undefined \? undefined : \{ timeout: params\.timeoutMs \}$|\);$/.test(l)));
    ok(`A2 apenas a chamada antiga foi removida (${removidas.length})`,
       removidas.every((l) => /cliente\.messages\.create\(\{|\} as Anthropic\.MessageCreateParamsNonStreaming\);/.test(l)));

    ok("A3 `timeoutMs` e OPCIONAL", /timeoutMs\?: number;/.test(COD_PROVEDOR));
    ok("A4 ausente => nenhuma opcao e passada (equivalente a omitir)",
       /params\.timeoutMs === undefined \? undefined : \{ timeout: params\.timeoutMs \}/.test(COD_PROVEDOR));
    ok("A5 presente => vai como timeout POR REQUISICAO", /\{ timeout: params\.timeoutMs \}/.test(COD_PROVEDOR));
    ok("A6 o cliente NAO e recriado: construtor identico ao de HEAD",
       /clienteCache = new Anthropic\(\{ apiKey, timeout: TIMEOUT_MS_REVISAO, maxRetries: 0 \}\);/.test(COD_PROVEDOR) &&
       /clienteCache = new Anthropic\(\{ apiKey, timeout: TIMEOUT_MS_REVISAO, maxRetries: 0 \}\);/.test(codHead));
    ok("A7 maxRetries continua 0", /maxRetries: 0/.test(COD_PROVEDOR));
    ok("A8 default do Estudio intacto (TIMEOUT_MS_REVISAO = 120_000)", /const TIMEOUT_MS_REVISAO = 120_000;/.test(COD_PROVEDOR));
    ok("A9 leitura de credencial inalterada", /const apiKey = process\.env\.ANTHROPIC_API_KEY;/.test(COD_PROVEDOR) &&
       (COD_PROVEDOR.match(/ANTHROPIC_API_KEY/g) ?? []).length === (codHead.match(/ANTHROPIC_API_KEY/g) ?? []).length);
    ok("A10 modelo default do Estudio intacto", /const bruto = process\.env\.ANTHROPIC_MODEL_REVISAO;/.test(COD_PROVEDOR));
    ok("A11 o corpo da requisicao nao mudou (mesmos campos)",
       ["model: params.modelo", "max_tokens: params.maxTokens ?? 16000", "system: params.promptSistema",
        "messages: [{ role: \"user\", content: params.promptUsuario }]",
        "output_config: { format: { type: \"json_schema\", schema: params.schema } }"]
         .every((c) => COD_PROVEDOR.includes(c) && codHead.includes(c)));
    ok("A12 mapeamento de erro inalterado (bloco identico a HEAD)",
       COD_PROVEDOR.slice(COD_PROVEDOR.indexOf("export function mapearErroAnthropic")) ===
       codHead.slice(codHead.indexOf("export function mapearErroAnthropic")));
    ok("A13 nenhum chamador existente passa timeoutMs (nao precisaram mudar)",
       execFileSync("git", ["grep", "-l", "chamarClaudeTexto", "--", "lib/estudio-anuncios"], { cwd: RAIZ, encoding: "utf8" })
         .trim().split("\n").every((f) => !readFileSync(join(RAIZ, f), "utf8").includes("timeoutMs")));
    ok("A14 CONTROLE NEGATIVO: o comparador de blocos acusaria divergencia", "abc".slice(1) !== "abd".slice(1));

    // E. mapeamento de erro — comportamental, a funcao e exportada.
    const casos: Array<[string, unknown, string]> = [
      ["401", { status: 401, message: "no" }, "auth"],
      ["403", { status: 403, message: "no" }, "auth"],
      ["429", { status: 429, message: "slow" }, "rate_limit"],
      ["500", { status: 500, message: "boom" }, "transient"],
      ["400", { status: 400, message: "bad" }, "validation"],
      ["404", { status: 404, message: "no" }, "validation"],
      ["timeout sem status", { message: "Request timed out" }, "transient"],
      ["desconhecido", { message: "algo" }, "unknown"],
    ];
    for (const [rotulo, err, esperado] of casos) {
      const mapeado = mapearErroAnthropic(err);
      ok(`A15 erro ${rotulo} => ${esperado}`, mapeado instanceof ErroProvedorIA && mapeado.tipo === esperado);
    }
  }

  // ═══ C. ADAPTER REAL, com duble ═══════════════════════════════════
  console.log("C. Adaptador Anthropic (duble injetado)");
  const { criarAdaptadorAnthropic, TIMEOUT_MS_INTERPRETACAO, NOME_ENV_MODELO_INTERPRETACAO, obterModeloInterpretacao } =
    await import("../lib/agentes/adaptador-anthropic");
  {
    ok("C0 o nome da env de modelo e dos AGENTES", NOME_ENV_MODELO_INTERPRETACAO === NOME_ENV_MODELO);
    ok("C0a NAO reutiliza a env do Estudio", !/ANTHROPIC_MODEL_REVISAO|obterModeloRevisao/.test(COD_ADAPTADOR));
    ok("C0b timeout dos agentes e 25 s", TIMEOUT_MS_INTERPRETACAO === 25_000);

    const { chamar, chamadas } = chamarFalso({});
    const resposta = await comEnv({ [NOME_ENV_MODELO]: "claude-x" }, () =>
      criarAdaptadorAnthropic(chamar)(pedidoFixture()));

    ok("C1 o provedor foi chamado exatamente uma vez", chamadas.length === 1);
    ok("C2 promptSistema recebe a INSTRUCAO do pedido", chamadas[0].promptSistema === pedidoFixture().instrucao);
    ok("C3 promptUsuario recebe os DADOS do pedido", chamadas[0].promptUsuario === pedidoFixture().dados);
    ok("C4 o schema enviado E o publicado (identidade)", chamadas[0].schema === SCHEMA_ANALISE_VENDAS_IA);
    ok("C5 o modelo vem da env dos agentes", chamadas[0].modelo === "claude-x");
    ok("C6 timeoutMs = 25_000", chamadas[0].timeoutMs === 25_000);
    ok("C7 nenhum campo alem do contrato foi enviado",
       JSON.stringify(Object.keys(chamadas[0]).sort()) === JSON.stringify(["modelo", "promptSistema", "promptUsuario", "schema", "timeoutMs"]));

    ok("C8 provedor declarado e `anthropic`", resposta.provedor === "anthropic");
    ok("C9 o modelo REGISTRADO vem do retorno da API, nao da env", resposta.modelo === "claude-modelo-resolvido-pela-api");
    ok("C10 usage propagado", resposta.tokensEntrada === 1234 && resposta.tokensSaida === 567 && resposta.tempoMs === 4321);
    ok("C11 conteudo validado tem as 3 chaves", JSON.stringify(Object.keys(resposta.conteudo).sort()) === JSON.stringify(["alertas", "destaques", "resumo"]));
    ok("C12 zero rede", chamadasDeRede === 0);
  }
  {
    // A validacao do chamador roda SEMPRE, mesmo com schema declarado.
    let vezes = 0;
    const { chamar } = chamarFalso({});
    const pedido = { ...pedidoFixture(), validar: (b: unknown) => { vezes++; return validarAnaliseVendasIA(b); } };
    await comEnv({ [NOME_ENV_MODELO]: "claude-x" }, () => criarAdaptadorAnthropic(chamar)(pedido));
    ok("C13 `pedido.validar` foi chamado exatamente uma vez", vezes === 1);
  }
  {
    const { chamar } = chamarFalso({ resultadoTexto: JSON.stringify({ resumo: "r", destaques: [], alertas: [], acoes: ["x"] }) });
    const r = await capturar(() => comEnv({ [NOME_ENV_MODELO]: "claude-x" }, () => criarAdaptadorAnthropic(chamar)(pedidoFixture())));
    ok("C14 chave extra na resposta e RECUSADA", r.lancou && (r.erro as ErroProvedorIA)?.tipo === "validation");
  }
  {
    const { chamar } = chamarFalso({ resultadoTexto: "isto nao e json {{{" });
    const r = await capturar(() => comEnv({ [NOME_ENV_MODELO]: "claude-x" }, () => criarAdaptadorAnthropic(chamar)(pedidoFixture())));
    ok("C15 JSON quebrado e recusado como `validation`", r.lancou && (r.erro as ErroProvedorIA)?.tipo === "validation");
    ok("C16 a mensagem NAO ecoa o texto recebido do modelo", !String((r.erro as Error)?.message).includes("{{{"));
  }
  {
    const { chamar } = chamarFalso({ resultadoTexto: JSON.stringify({ resumo: "", destaques: [], alertas: [] }) });
    const r = await capturar(() => comEnv({ [NOME_ENV_MODELO]: "claude-x" }, () => criarAdaptadorAnthropic(chamar)(pedidoFixture())));
    ok("C17 resposta estruturalmente invalida e recusada", r.lancou && r.erro instanceof ErroProvedorIA);
  }
  {
    // Erros do provedor sobem intactos, sem virar texto nem fake.
    for (const [rot, tipo] of [["auth", "auth"], ["rate_limit", "rate_limit"], ["timeout/transient", "transient"], ["conteudo_rejeitado", "conteudo_rejeitado"]] as const) {
      const { chamar } = chamarFalso({ erro: new ErroProvedorIA(tipo, `falha ${rot}`) });
      const r = await capturar(() => comEnv({ [NOME_ENV_MODELO]: "claude-x" }, () => criarAdaptadorAnthropic(chamar)(pedidoFixture())));
      ok(`C18 ${rot} propaga como ${tipo}`, r.lancou && (r.erro as ErroProvedorIA)?.tipo === tipo && r.valor === undefined);
    }
  }
  {
    // Modelo ausente: falha ANTES de qualquer chamada.
    const { chamar, chamadas } = chamarFalso({});
    for (const [rot, valor] of [["ausente", undefined], ["vazio", ""], ["so espacos", "   "]] as Array<[string, string | undefined]>) {
      const r = await capturar(() => comEnv({ [NOME_ENV_MODELO]: valor }, () => criarAdaptadorAnthropic(chamar)(pedidoFixture())));
      ok(`C19 modelo ${rot} => falha controlada (auth)`, r.lancou && (r.erro as ErroProvedorIA)?.tipo === "auth");
    }
    ok("C20 e o provedor NAO chegou a ser chamado", chamadas.length === 0);
    ok("C21 a mensagem cita o NOME da env, nunca um valor",
       String((await capturar(() => comEnv({ [NOME_ENV_MODELO]: undefined }, () => criarAdaptadorAnthropic(chamar)(pedidoFixture())))).erro as Error)
         .includes(NOME_ENV_MODELO));
    ok("C22 `obterModeloInterpretacao` apara espacos", await comEnv({ [NOME_ENV_MODELO]: "  claude-y  " }, () => obterModeloInterpretacao()) === "claude-y");
  }

  // ═══ D. FLAGS ponta a ponta ═══════════════════════════════════════
  console.log("D. Combinacoes de flag");
  {
    const reg = { chamadas: 0 };
    const base = baseFalso(reg);
    const off = await comEnv({ [NOME_FLAG_INTERPRETACAO_VENDAS]: undefined, [NOME_FLAG_PROVEDOR_REAL]: "true" },
      () => comInterpretacaoDeVendas(base, criarInterpretadorDeVendas()));
    ok("D1 INTERPRETACAO OFF => handler base por IDENTIDADE", off === base);

    const rFake = await comEnv({ [NOME_FLAG_INTERPRETACAO_VENDAS]: "true", [NOME_FLAG_PROVEDOR_REAL]: "false" }, async () => {
      const h = comInterpretacaoDeVendas(baseFalso({ chamadas: 0 }), criarInterpretadorDeVendas());
      return h(contextoFalso(), () => {});
    });
    ok("D2 INTERPRETACAO ON + REAL OFF => fake", (rFake[CHAVE_ORIGEM_INTERPRETACAO] as { provedor: string }).provedor === "fake");

    // REAL ON sem modelo: prova que foi ao adaptador REAL (nao ao fake)
    // e que falhou fechado — sem rede, porque o modelo e checado antes.
    const rReal = await capturar(() => comEnv(
      { [NOME_FLAG_INTERPRETACAO_VENDAS]: "true", [NOME_FLAG_PROVEDOR_REAL]: "true", [NOME_ENV_MODELO]: undefined },
      async () => {
        const h = comInterpretacaoDeVendas(baseFalso({ chamadas: 0 }), criarInterpretadorDeVendas());
        return h(contextoFalso(), () => {});
      }));
    ok("D3 INTERPRETACAO ON + REAL ON => vai ao adaptador ANTHROPIC", rReal.lancou &&
       String((rReal.erro as Error)?.message).includes(NOME_ENV_MODELO));
    ok("D4 REAL ON + modelo ausente => falha controlada, NAO cai para fake",
       (rReal.erro as ErroProvedorIA)?.tipo === "auth" && rReal.valor === undefined);
    ok("D5 nenhuma resposta parcial foi devolvida", rReal.valor === undefined);
    ok("D6 zero rede em todas as combinacoes", chamadasDeRede === 0);
    ok("D7 nenhum fallback silencioso no wiring", !/catch[\s\S]{0,120}(fake|criarAdaptadorFake)/.test(COD_WIRING));
  }

  // ═══ E. TENANT / DADOS / ZERO ACAO ════════════════════════════════
  console.log("E. Fronteira de tenant e de acao");
  {
    const { chamar, chamadas } = chamarFalso({});
    const espiaoPedido: PedidoIA<ReturnType<typeof validarAnaliseVendasIA>> = {
      ...pedidoFixture(),
      dados: JSON.stringify({ totais: { pedidosPagos: 12 }, marketplaces: [] }, null, 2),
    };
    await comEnv({ [NOME_ENV_MODELO]: "claude-x" }, () => criarAdaptadorAnthropic(chamar)(espiaoPedido));
    const enviado = JSON.stringify(chamadas[0]);
    for (const k of ["userId", "user_id", "tenantId", "tenant_id", "projetoId", "jobId", "order_id", "order_sn"]) {
      ok(`E1 "${k}" nao chega ao provedor`, !enviado.includes(k));
    }
    ok("E2 CONTROLE NEGATIVO: o detector acha quando presente", JSON.stringify({ user_id: 1 }).includes("user_id"));

    for (const [rot, re] of [
      ["tools/function calling", /\btools\s*:|\btool_choice\b|\binput_schema\b|function calling/],
      ["capability de vendas", /lerVendas|criarLeiturasDeVendas|agregarVendas/],
      ["Supabase/SQL", /supabase|createClient|\.\s*rpc\s*\(|\bfrom\s+public\./i],
      ["billing/custo", /central_ia_consumo|registrarConsumo|estimarCusto|custoUsd|billing/i],
      ["credencial", /ANTHROPIC_API_KEY|apiKey|Bearer/],
      ["fetch/URL", /\bfetch\s*\(|https?:\/\//],
      ["marketplace/escrita", /shopee|mercado_?livre|INSERT|UPDATE/i],
    ] as const) {
      ok(`E3 adaptador sem ${rot}`, !re.test(COD_ADAPTADOR));
    }
    ok("E4 CONTROLE NEGATIVO: a varredura acha os termos", [/\btools\s*:/, /supabase/i, /\bfetch\s*\(/].every((re) => re.test('tools: [] supabase fetch()')));
    ok("E5 o adaptador NAO le credencial (quem le e o provedor)", !/process\.env\.ANTHROPIC_API_KEY/.test(COD_ADAPTADOR));
    ok("E6 uma unica leitura de env no adaptador (o modelo)", (COD_ADAPTADOR.match(/process\.env/g) ?? []).length === 1);
    ok("E7 o provedor nao e escolhido por entrada de tarefa",
       !/contexto|entrada|tarefa\./.test(COD_ADAPTADOR) && /chamar: ChamarTextoAnthropic = chamarClaudeTexto/.test(COD_ADAPTADOR));
    ok("E8 zero rede na suite inteira", chamadasDeRede === 0);
  }

  const total = passou + falhou;
  console.log(`\n${"=".repeat(60)}`);
  console.log(`AGENTES-FASE1E-d — provedor real (sem rede):  ${passou}/${total} passaram`);
  if (falhou > 0) {
    console.log(`${falhou} FALHARAM`);
    process.exitCode = 1;
  } else console.log("TODOS OS ASSERTS PASSARAM");
  console.log("=".repeat(60));
}

main().catch((e) => {
  console.error("ERRO NAO TRATADO:", e instanceof Error ? e.message.slice(0, 300) : "desconhecido");
  process.exitCode = 1;
});
