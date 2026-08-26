/**
 * Suite do wiring da interpretacao de IA — AGENTES-FASE1E-c.
 *
 * SEM banco real, SEM rede, SEM provedor de IA, SEM worker.
 *
 * ── Por que ESTA suite importa os shims, e as da 1E-a/1E-b nao ──────
 * As suites do contrato (1E-a) e da composicao (1E-b) provam PUREZA, e
 * por isso a ausencia de `_server-only-inerte` la e uma barreira: se um
 * daqueles modulos passar a arrastar `server-only`, a suite morre no
 * load.
 *
 * Esta aqui prova WIRING, e o alvo do wiring e o registry — que e
 * server-only por transitividade desde a 1D-d, porque ele constroi a
 * capability de vendas. Testar o registry sem shim seria impossivel, e
 * fingir que essa camada e pura seria mentira. Entao os shims entram, do
 * mesmo jeito que na suite 1C, e a compensacao vem noutra forma:
 *
 *   - `require.cache` e inspecionado atras de SDK de PROVEDOR DE IA
 *     (`@google/genai`, `@anthropic-ai`, OpenAI), nao de Supabase —
 *     Supabase E legitimo aqui, porque a capability real esta no grafo;
 *   - a fonte do modulo de wiring e varrida por termos proibidos;
 *   - `fetch` e armadilhado e tem de terminar em zero.
 *
 * ── A flag e manipulada e SEMPRE restaurada ────────────────────────
 * Cada bloco que mexe em `process.env` restaura o estado anterior em
 * `finally`, inclusive a distincao entre "ausente" e "string vazia" —
 * `delete` e diferente de `= ""`, e a politica de parsing precisa
 * enxergar os dois.
 */
import "./_server-only-inerte";
import "./_env-inerte";
import { readFileSync } from "fs";
import { join } from "path";

import {
  NOME_FLAG_INTERPRETACAO_VENDAS,
  CHAVE_INTERPRETACAO,
  CHAVE_ORIGEM_INTERPRETACAO,
  interpretacaoDeVendasHabilitada,
  criarInterpretadorDeVendas,
  comInterpretacaoDeVendas,
} from "../lib/agentes/ativacao-ia";
import { criarAdaptadorFake } from "../lib/agentes/ia/fake";
import { interpretarAnaliseVendas } from "../lib/agentes/ia/interpretar-analise-vendas";
import { validarAnaliseVendasIA, CHAVES_ANALISE_IA } from "../lib/agentes/ia/contrato-analise";
import { ErroProvedorIA } from "../lib/ai-gateway/erros";
import { ErroEntradaTarefa } from "../lib/agentes/erros";
import { ErroTipoTarefaDesconhecido, resolverHandler } from "../lib/agentes/handlers/registry";
import type { ContextoTarefa, HandlerTarefa } from "../lib/agentes/tipos-execucao";
import type { AnaliseVendasDeterministica } from "../lib/agentes/ia/interpretar-analise-vendas";
import type { InterpretarAnaliseDeVendas } from "../lib/agentes/ativacao-ia";

// ── Armadilha de rede ─────────────────────────────────────────────────
let chamadasDeRede = 0;
(globalThis as unknown as { fetch: unknown }).fetch = (...args: unknown[]) => {
  chamadasDeRede++;
  throw new Error(`suite de wiring: fetch proibido (${String(args[0]).slice(0, 60)})`);
};

const RAIZ = join(__dirname, "..");
const FONTE_WIRING = readFileSync(join(RAIZ, "lib", "agentes", "ativacao-ia.ts"), "utf8");
const FONTE_REGISTRY = readFileSync(join(RAIZ, "lib", "agentes", "handlers", "registry.ts"), "utf8");

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

/** Remove comentario preservando string (mesma tecnica das suites 1E). */
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
const CODIGO_WIRING = semComentarios(FONTE_WIRING);

/**
 * Roda `acao` com a flag num valor dado. `undefined` significa AUSENTE
 * (delete), que e diferente de string vazia — a politica precisa
 * distinguir os dois.
 */
async function comFlag<T>(valor: string | undefined, acao: () => Promise<T> | T): Promise<T> {
  const tinha = Object.prototype.hasOwnProperty.call(process.env, NOME_FLAG_INTERPRETACAO_VENDAS);
  const anterior = process.env[NOME_FLAG_INTERPRETACAO_VENDAS];
  try {
    if (valor === undefined) delete process.env[NOME_FLAG_INTERPRETACAO_VENDAS];
    else process.env[NOME_FLAG_INTERPRETACAO_VENDAS] = valor;
    return await acao();
  } finally {
    if (tinha) process.env[NOME_FLAG_INTERPRETACAO_VENDAS] = anterior as string;
    else delete process.env[NOME_FLAG_INTERPRETACAO_VENDAS];
  }
}

// ── Fixtures sinteticas ───────────────────────────────────────────────
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
    ],
    qualidadeDados: { linhas: 24, linhasSemSku: 2, linhasSemValor: 1, skusDistintos: 9, skusOmitidos: 7 },
  };
}

const CHAVES_DETERMINISTICAS = ["escopo", "periodo", "totais", "marketplaces", "skus", "qualidadeDados"];

/** Handler base falso: devolve a analise e conta execucoes. */
function baseFalso(registro: { chamadas: number; ultimoContexto?: ContextoTarefa }): HandlerTarefa {
  return async function handlerAnaliseVendas(contexto, relatarProgresso) {
    registro.chamadas++;
    registro.ultimoContexto = contexto;
    relatarProgresso(100);
    return analiseFixture() as unknown as Record<string, unknown>;
  };
}

function contextoFalso(entrada: Record<string, unknown> = {}): ContextoTarefa {
  return {
    tarefaId: "11111111-1111-1111-1111-111111111111",
    agenteId: "22222222-2222-2222-2222-222222222222",
    userId: "33333333-3333-3333-3333-333333333333",
    tipo: "analise_vendas",
    entrada,
    tentativa: 1,
    maxTentativas: 3,
  };
}

async function main() {
  console.log("\nAGENTES-FASE1E-c — wiring da interpretacao com flag + fake\n");

  // ═══ A. POLITICA DA FLAG ══════════════════════════════════════════
  console.log("A. Politica da feature flag");
  {
    ok("A1 o nome da flag e AGENTES_IA_INTERPRETACAO_ENABLED", NOME_FLAG_INTERPRETACAO_VENDAS === "AGENTES_IA_INTERPRETACAO_ENABLED");
    ok("A2 NAO e NEXT_PUBLIC_ (nao vaza para o bundle do cliente)", !NOME_FLAG_INTERPRETACAO_VENDAS.startsWith("NEXT_PUBLIC_"));

    // Politica ADOTADA: so a string exata "true" liga. Tudo o mais
    // desliga — inclusive "1", "TRUE" e "yes". Mesma regra ja vigente em
    // lib/ai-gateway/roteamento.ts e lib/feature-flags.ts.
    const DESLIGA: Array<[string, string | undefined]> = [
      ["ausente", undefined], ["vazia", ""], ["so espacos", "   "],
      ["0", "0"], ["false", "false"], ["FALSE", "FALSE"], ["False", "False"],
      ["1", "1"], ["TRUE", "TRUE"], ["True", "True"], ["yes", "yes"], ["on", "on"],
      ["true com espaco", " true "], ["lixo", "asdf"], ["truthy-string", "nao"],
    ];
    for (const [rotulo, valor] of DESLIGA) {
      const ligada = await comFlag(valor, () => interpretacaoDeVendasHabilitada());
      ok(`A3 "${rotulo}" => DESLIGADA`, ligada === false);
    }
    ok("A4 a string exata \"true\" => LIGADA", await comFlag("true", () => interpretacaoDeVendasHabilitada()) === true);
    ok("A5 default seguro: sem a env, desligada", await comFlag(undefined, () => interpretacaoDeVendasHabilitada()) === false);
    ok("A6 a leitura e por CHAMADA, nao congelada no import",
       (await comFlag("true", () => interpretacaoDeVendasHabilitada())) === true &&
       (await comFlag(undefined, () => interpretacaoDeVendasHabilitada())) === false);
    ok("A7 o codigo compara com a string exata (sem coercao booleana)",
       /process\.env\[NOME_FLAG_INTERPRETACAO_VENDAS\] === "true"/.test(CODIGO_WIRING));
    ok("A8 CONTROLE NEGATIVO: nenhuma verdade por 'string nao vazia'",
       !/Boolean\(process\.env|!!process\.env|process\.env\[[^\]]+\]\s*\?\s/.test(CODIGO_WIRING));
    // AGENTES-FASE1E-d: a 1E-c tinha UMA flag, e este assert exigia
    // exatamente uma leitura de env. Com a segunda flag, contar leituras
    // deixou de descrever a propriedade. A forma nova e mais forte: cada
    // flag tem exatamente UM leitor, e nenhuma leitura de env sobra sem
    // dono. Contar so o total deixaria passar duas leituras da MESMA
    // flag em lugares diferentes, que e o defeito que interessa impedir.
    const leiturasEnv = [...CODIGO_WIRING.matchAll(/process\.env\[(\w+)\]/g)].map((m) => m[1]);
    ok("A9 cada flag tem exatamente UM leitor no wiring",
       leiturasEnv.filter((n) => n === "NOME_FLAG_INTERPRETACAO_VENDAS").length === 1 &&
       leiturasEnv.filter((n) => n === "NOME_FLAG_PROVEDOR_REAL").length === 1);
    ok("A9a nenhuma leitura de env sem dono no wiring",
       leiturasEnv.length === 2 && (CODIGO_WIRING.match(/process\.env/g) ?? []).length === 2);
    ok("A9b o registry continua sem ler env", !/process\.env/.test(semComentarios(FONTE_REGISTRY)));
    ok("A9c CONTROLE NEGATIVO: o extrator acha o nome da flag lida",
       [...'process.env[FLAG_X]'.matchAll(/process\.env\[(\w+)\]/g)].map((m) => m[1])[0] === "FLAG_X");
  }

  // ═══ B. FABRICA ═══════════════════════════════════════════════════
  console.log("B. Fabrica do interpretador");
  {
    ok("B1 flag OFF => fabrica devolve null", await comFlag(undefined, () => criarInterpretadorDeVendas()) === null);
    ok("B2 flag ON => fabrica devolve funcao", typeof (await comFlag("true", () => criarInterpretadorDeVendas())) === "function");
    ok("B3 a fabrica nao aceita parametro (nao ha como passar dono)", criarInterpretadorDeVendas.length === 0);
    ok("B4 a fabrica usa o FAKE, nao um provedor", /criarAdaptadorFake\(\)/.test(CODIGO_WIRING));
    // AGENTES-FASE1E-e: o wiring passou a RESOLVER o modelo — pelo leitor
    // unico `obterModeloInterpretacao()` — para declarar provedor/modelo na
    // linha de contabilidade quando a chamada FALHA e a resposta nao chega.
    // O assert antigo casava a palavra "modelo" e reprovava isso. A forma
    // nova e mais precisa E mais estrita: continua proibindo ler chave e
    // rotear provedor, e passa a EXIGIR que a resolucao seja delegada.
    ok("B5 nao le chave nem roteia provedor", !/apiKey|API_KEY|decidirProvedor|chamarIA/i.test(CODIGO_WIRING));
    ok("B5a nenhum nome de modelo escrito a mao no wiring",
       !/["'`](claude|gemini|gpt)[a-z0-9.-]*["'`]/i.test(CODIGO_WIRING));
    ok("B5b o modelo vem do LEITOR UNICO, e a env nao e lida aqui",
       /obterModeloInterpretacao\(\)/.test(CODIGO_WIRING) && !/AGENTES_ANTHROPIC_MODEL/.test(CODIGO_WIRING));
  }

  // ═══ C. FLAG OFF — garantia de rollback ══════════════════════════
  console.log("C. Flag OFF");
  {
    const reg = { chamadas: 0 };
    const base = baseFalso(reg);
    const envolvido = await comFlag(undefined, () => comInterpretacaoDeVendas(base, criarInterpretadorDeVendas()));

    ok("C1 devolve o MESMO objeto de funcao (identidade, nao equivalencia)", envolvido === base);

    const espiao = criarAdaptadorFake();
    const resultado = await envolvido(contextoFalso(), () => {});
    ok("C2 o handler base rodou", reg.chamadas === 1);
    ok("C3 nenhum adaptador de IA foi chamado", espiao.chamadas.length === 0);
    ok("C4 a saida tem EXATAMENTE as 6 chaves deterministicas, sem campo novo",
       JSON.stringify(Object.keys(resultado).sort()) === JSON.stringify([...CHAVES_DETERMINISTICAS].sort()));
    ok("C5 nenhuma chave de interpretacao aparece",
       !(CHAVE_INTERPRETACAO in resultado) && !(CHAVE_ORIGEM_INTERPRETACAO in resultado));
    ok("C6 a saida e byte a byte igual a do handler sozinho",
       JSON.stringify(resultado) === JSON.stringify(await base(contextoFalso(), () => {})));
    ok("C7 nenhuma env de provedor foi necessaria",
       !process.env.GOOGLE_AI_ENABLED && !process.env.ANTHROPIC_REVISAO_ENABLED);
  }

  // ═══ D. FLAG ON com FAKE ═════════════════════════════════════════
  console.log("D. Flag ON (fake)");
  {
    const reg = { chamadas: 0 };
    const espiao = criarAdaptadorFake();
    const interpretar: InterpretarAnaliseDeVendas = (analise) => interpretarAnaliseVendas(analise, espiao.adaptador);
    const envolvido = comInterpretacaoDeVendas(baseFalso(reg), interpretar);

    ok("D1 devolve um handler DIFERENTE do base", envolvido !== baseFalso(reg));
    const resultado = await envolvido(contextoFalso(), () => {});

    ok("D2 a analise deterministica rodou primeiro", reg.chamadas === 1);
    ok("D3 o AdaptadorIA foi chamado EXATAMENTE uma vez", espiao.chamadas.length === 1);
    ok("D4 recebeu um PedidoIA valido (4 campos do contrato)",
       JSON.stringify(Object.keys(espiao.chamadas[0]).sort()) === JSON.stringify(["dados", "instrucao", "schema", "validar"]));
    ok("D5 `validar` do pedido e o validador estrutural publicado", espiao.chamadas[0].validar === validarAnaliseVendasIA);
    ok("D6 o resultado contem as 6 chaves deterministicas MAIS as 2 de interpretacao",
       JSON.stringify(Object.keys(resultado).sort()) ===
       JSON.stringify([...CHAVES_DETERMINISTICAS, CHAVE_INTERPRETACAO, CHAVE_ORIGEM_INTERPRETACAO].sort()));
    ok("D7 a interpretacao tem exatamente resumo/destaques/alertas",
       JSON.stringify(Object.keys(resultado[CHAVE_INTERPRETACAO] as object).sort()) === JSON.stringify([...CHAVES_ANALISE_IA].sort()));
    ok("D8 a origem traz so metadado, nunca conteudo",
       JSON.stringify(Object.keys(resultado[CHAVE_ORIGEM_INTERPRETACAO] as object).sort()) ===
       JSON.stringify(["modelo", "provedor", "tempoMs", "tokensEntrada", "tokensSaida"]));
    ok("D9 o provedor e `fake`", (resultado[CHAVE_ORIGEM_INTERPRETACAO] as { provedor: string }).provedor === "fake");
    ok("D10 nenhuma acao externa: zero rede ate aqui", chamadasDeRede === 0);

    // Determinismo do fake.
    const outro = comInterpretacaoDeVendas(baseFalso({ chamadas: 0 }), (a) => interpretarAnaliseVendas(a, criarAdaptadorFake().adaptador));
    ok("D11 duas execucoes com a mesma entrada dao a MESMA saida",
       JSON.stringify(await outro(contextoFalso(), () => {})) === JSON.stringify(resultado));
  }

  // ═══ E. NUMEROS INTACTOS ═════════════════════════════════════════
  console.log("E. Numeros continuam do CDS");
  {
    const original = analiseFixture();
    const espiao = criarAdaptadorFake();
    const envolvido = comInterpretacaoDeVendas(
      baseFalso({ chamadas: 0 }),
      (a) => interpretarAnaliseVendas(a, espiao.adaptador)
    );
    const r = await envolvido(contextoFalso(), () => {});

    for (const chave of CHAVES_DETERMINISTICAS) {
      ok(`E1 "${chave}" preservado byte a byte`,
         JSON.stringify(r[chave]) === JSON.stringify((original as unknown as Record<string, unknown>)[chave]));
    }
    ok("E2 nenhum numero da IA entrou nas chaves deterministicas",
       JSON.stringify(r.totais) === JSON.stringify(original.totais));
    ok("E3 a interpretacao NAO tem campo numerico",
       Object.values(r[CHAVE_INTERPRETACAO] as Record<string, unknown>)
         .every((v) => typeof v === "string" || (Array.isArray(v) && v.every((x) => typeof x === "string"))));
    ok("E4 CONTROLE NEGATIVO: o comparador acusa numero alterado",
       JSON.stringify({ a: 1 }) !== JSON.stringify({ a: 2 }));
    ok("E5 o decorator NAO reatribui chave deterministica alguma",
       !new RegExp(`(${CHAVES_DETERMINISTICAS.join("|")})\\s*:`).test(CODIGO_WIRING.split("return {")[1] ?? ""));
  }

  // ═══ F. ERRO DA IA — fail-closed ═════════════════════════════════
  console.log("F. Erro da IA");
  {
    const casos: Array<[string, ReturnType<typeof criarAdaptadorFake>]> = [
      ["erro do adaptador", criarAdaptadorFake({ modo: "erro", tipoErro: "auth", mensagemErro: "sem credencial" })],
      ["timeout/transient", criarAdaptadorFake({ modo: "erro", tipoErro: "transient", mensagemErro: "timeout" })],
      ["rate limit", criarAdaptadorFake({ modo: "erro", tipoErro: "rate_limit", mensagemErro: "429" })],
      ["resposta invalida", criarAdaptadorFake({ bruto: { resumo: "", destaques: [], alertas: [] } })],
      ["chave extra na resposta", criarAdaptadorFake({ bruto: { resumo: "r", destaques: [], alertas: [], acoes: ["x"] } })],
    ];
    for (const [rotulo, fake] of casos) {
      const envolvido = comInterpretacaoDeVendas(baseFalso({ chamadas: 0 }), (a) => interpretarAnaliseVendas(a, fake.adaptador));
      const r = await capturar(() => envolvido(contextoFalso(), () => {}));
      ok(`F1 ${rotulo}: a tarefa FALHA (nao devolve resultado parcial)`, r.lancou && r.valor === undefined);
      ok(`F2 ${rotulo}: o erro sobe como ErroProvedorIA`, r.erro instanceof ErroProvedorIA);
    }
    ok("F3 nao ha try/catch no decorator (nada e engolido)", !/try\s*\{|catch\s*\(/.test(CODIGO_WIRING));

    // O executor classifica por `instanceof`. Provamos a ENTRADA dele.
    const erroIa = new ErroProvedorIA("transient", "x");
    ok("F4 ErroProvedorIA e um Error => o executor o classifica `handler_falhou`", erroIa instanceof Error);
    ok("F5 e NAO e ErroEntradaTarefa nem ErroTipoTarefaDesconhecido (nao vira entrada_invalida)",
       !(erroIa instanceof ErroEntradaTarefa) && !(erroIa instanceof ErroTipoTarefaDesconhecido));
    const fonteExec = semComentarios(readFileSync(join(RAIZ, "lib", "agentes", "executar-tarefa.ts"), "utf8"));
    ok("F6 a regra do executor continua a que assumimos (Error => handler_falhou)",
       /if \(err instanceof Error\) return "handler_falhou";/.test(fonteExec));
    ok("F7 ANCORA: a fonte do executor foi lida", fonteExec.includes("classificarErro") && fonteExec.length > 1000);
  }

  // ═══ G. TENANT FORA DA IA ════════════════════════════════════════
  console.log("G. Fronteira de tenant");
  {
    const espiao = criarAdaptadorFake();
    const envolvido = comInterpretacaoDeVendas(baseFalso({ chamadas: 0 }), (a) => interpretarAnaliseVendas(a, espiao.adaptador));
    const ctx = contextoFalso({ userId: "plantado-na-entrada", user_id: "outro-dono", tenantId: "t-1" });
    await envolvido(ctx, () => {});

    const pedido = espiao.chamadas[0];
    const texto = JSON.stringify(pedido.dados) + JSON.stringify(Object.keys(pedido));
    const PROIBIDOS = ["userId", "user_id", "tenantId", "tenant_id", "projetoId", "jobId"];
    ok("G1 ANCORA: o contexto REALMENTE carrega os identificadores", ctx.userId.length > 0 && "user_id" in ctx.entrada);
    ok("G2 nenhum identificador de dono chega ao PedidoIA", PROIBIDOS.every((k) => !texto.includes(k)));
    ok("G3 o `userId` do contexto nao aparece no texto enviado", !pedido.dados.includes(ctx.userId));
    // AGENTES-FASE1E-e: o interpretador passou a receber a IDENTIDADE —
    // cinco campos DERIVADOS do contexto — para a observabilidade. O
    // contexto CRU continua fora, e agora isso e exigido item a item,
    // inclusive que a identidade nao carregue `entrada`, que e onde um
    // spoofing viveria.
    ok("G4 o `contexto` CRU nao e repassado ao interpretador",
       !/interpretar\(\s*analise[^)]*,\s*contexto\s*\)/.test(CODIGO_WIRING));
    ok("G4a o que viaja e a identidade DERIVADA", /identidadeDoContexto\(contexto\)/.test(CODIGO_WIRING));
    ok("G4b a identidade nao e montada a partir de `entrada`",
       !/entrada/.test((CODIGO_WIRING.match(/identidadeDoContexto[\s\S]{0,160}/) ?? [""])[0]));
    ok("G5 a fabrica nao tem por onde receber dono (aridade 0)", criarInterpretadorDeVendas.length === 0);
    ok("G6 o tipo do interpretador aceita analise + identidade, e nada alem",
       /InterpretarAnaliseDeVendas = \(\s*analise: AnaliseVendasDeterministica,[\s\S]{0,900}identidade: IdentidadeChamadaIA\s*\) =>/.test(CODIGO_WIRING));
    ok("G6a a identidade tem os 5 campos do claim, e nenhum a mais",
       /readonly userId: string;[\s\S]{0,400}readonly tentativa: number;/.test(
         readFileSync(join(RAIZ, "lib", "agentes", "observabilidade-ia.ts"), "utf8")));
    ok("G7 CONTROLE NEGATIVO: o detector acha identificador quando presente",
       PROIBIDOS.some((k) => JSON.stringify({ user_id: 1 }).includes(k)));
  }

  // ═══ H. REGISTRY / RUNTIME ═══════════════════════════════════════
  console.log("H. Registry e runtime");
  {
    ok("H1 `analise_vendas` continua sendo o mesmo tipo (sem tipo novo)", typeof resolverHandler("analise_vendas") === "function");
    ok("H2 a fabrica continua de aridade 1 (binding de dono preservado)", resolverHandler("analise_vendas").length === 1);
    ok("H3 tipo desconhecido continua lancando", await (async () => {
      try { resolverHandler("nao_existe"); return false; } catch (e) { return e instanceof ErroTipoTarefaDesconhecido; }
    })());

    const codigoReg = semComentarios(FONTE_REGISTRY);
    ok("H4 o registry envolve o handler com a interpretacao", /comInterpretacaoDeVendas\(\s*criarHandlerAnaliseVendas\(criarLeiturasDeVendas\(userId\)\),\s*criarInterpretadorDeVendas\(\)\s*\)/.test(codigoReg));
    ok("H5 o `userId` vai SO para a capability, nunca para a IA",
       /criarLeiturasDeVendas\(userId\)/.test(codigoReg) && !/criarInterpretadorDeVendas\(userId\)/.test(codigoReg));
    ok("H6 nenhum tipo de tarefa novo foi registrado", /TIPO_TESTE_FUNDACAO\]|TIPO_ANALISE_VENDAS\]/.test(codigoReg) &&
       (codigoReg.match(/^\s*\[TIPO_/gm) ?? []).length === 2);

    // Com flag OFF, a fabrica do registry produz o handler base cru.
    const nomeOff = await comFlag(undefined, () => resolverHandler("analise_vendas")("dono-x").name);
    const nomeOn = await comFlag("true", () => resolverHandler("analise_vendas")("dono-x").name);
    ok("H7 flag OFF: o registry entrega o handler deterministico puro", nomeOff === "handlerAnaliseVendas");
    ok("H8 flag ON: o registry entrega o handler decorado", nomeOn === "handlerAnaliseVendasComInterpretacao");
    ok("H9 CONTROLE NEGATIVO: os dois nomes sao mesmo distintos", nomeOff !== nomeOn);
  }

  // ═══ I. PUREZA / ZERO PROVEDOR REAL ══════════════════════════════
  console.log("I. Zero provedor real");
  {
    const carregados = Object.keys(require.cache).map((p) => p.replace(/\\/g, "/"));
    ok("I1 ANCORA: o modulo de wiring esta no grafo", carregados.some((p) => p.includes("/lib/agentes/ativacao-ia.ts")));
    const SDK_IA = /@google\/genai|@anthropic-ai|openai/i;
    const achados = carregados.filter((p) => SDK_IA.test(p));
    ok(`I2 nenhum SDK de provedor de IA carregado (${achados.length})`, achados.length === 0);
    ok("I3 CONTROLE NEGATIVO: o padrao acha um caminho de SDK",
       SDK_IA.test("/x/node_modules/@google/genai/index.js") && SDK_IA.test("/x/node_modules/@anthropic-ai/sdk"));
    // AGENTES-FASE1E-e: `custos` SAIU desta lista. Ele e puro (zero imports,
    // zero env, zero banco) e seu reuso como base do calculo de custo foi
    // autorizado. O que continua proibido e o gateway de EXECUCAO.
    ok("I4 o ai-gateway de EXECUCAO nao foi carregado",
       !carregados.some((p) => /\/lib\/ai-gateway\/(cliente|roteamento|registro|provedores)/.test(p)));
    ok("I4a `registro.ts` do Estudio segue fora do grafo (nada de central_ia_consumo)",
       !carregados.some((p) => /\/lib\/ai-gateway\/registro/.test(p)));

    for (const [rot, re] of [
      ["fetch", /\bfetch\s*\(/], ["SDK", /@anthropic-ai|@google\/genai|openai/i],
      ["API key", /api[_-]?key|apiKey/i], ["billing/custo", /custo|billing|estimarCusto|registrarConsumo/i],
      ["tools", /\btools\s*:|\btool_choice\b|\binput_schema\b/], ["rede", /https?:\/\/|axios|XMLHttpRequest/],
      // "banco" passou a significar ACESSO a banco, e nao a palavra
      // "Supabase" dentro de um nome de simbolo: o wiring compoe
      // `criarRegistradorSupabase()`, que e uma FABRICA. Quem fala com o
      // banco e ela, por import dinamico — este arquivo nao.
      ["acesso a banco", /\.\s*rpc\s*\(|\.\s*select\s*\(|\.\s*insert\s*\(|\.\s*from\s*\(|createClient/i],
      ["migration/SQL", /\bfrom\s+public\.|CREATE\s+TABLE/i],
      ["loop de agente", /while\s*\(|for\s*\(;;/],
    ] as const) {
      ok(`I5 wiring sem ${rot}`, !re.test(CODIGO_WIRING));
    }
    ok("I6 CONTROLE NEGATIVO: a varredura acha os termos quando presentes",
       [/\bfetch\s*\(/, /api[_-]?key/i, /\btools\s*:/, /supabase/i].every((re) =>
         re.test('fetch(); api_key; tools: []; supabase')));
    ok("I7 ANCORA: o extrator de comentario nao apagou o codigo",
       CODIGO_WIRING.includes("export function comInterpretacaoDeVendas") && CODIGO_WIRING.length > 600);
    ok("I8 zero chamadas de rede na suite inteira", chamadasDeRede === 0);
  }

  const total = passou + falhou;
  console.log(`\n${"=".repeat(60)}`);
  console.log(`AGENTES-FASE1E-c — wiring com flag + fake:  ${passou}/${total} passaram`);
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
