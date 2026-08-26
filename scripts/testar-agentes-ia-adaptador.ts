/**
 * Suite da fundacao neutra de IA dos agentes — AGENTES-FASE1E-a.
 *
 * SEM banco, SEM rede, SEM env, SEM SDK, SEM provedor real, SEM IA.
 *
 * ── Ausencia proposital no topo, de novo ────────────────────────────
 * Como a suite da 1D-c, esta NAO importa `_server-only-inerte` nem
 * `_env-inerte`. A omissao e barreira: se algum dia um dos tres modulos
 * de `lib/agentes/ia/` passar a arrastar `server-only` (por importar
 * `dados/vendas.ts`, um cliente Supabase ou um SDK), esta suite para de
 * CARREGAR — falha no load, antes do primeiro assert, e nao ha como nao
 * notar. O limite dessa barreira foi medido na 1D-c: import de valor
 * NAO USADO e apagado pela elisao do esbuild e escapa dela. Por isso a
 * varredura de fonte do grupo A existe em paralelo, e nao no lugar.
 *
 * ── Varredura de fonte ignora COMENTARIO, de proposito ──────────────
 * Os docblocks de `tipos.ts` citam `userId`, `user_id`, `projetoId`,
 * `SupabaseClient`, `tool_choice` etc. — precisam citar, porque
 * documentam exatamente o que o contrato recusa. Um scanner ingenuo
 * acusaria a propria documentacao da regra que ele existe para provar.
 * Entao a varredura roda sobre a fonte com comentario removido, e o
 * removedor tem controle negativo proprio (A0b/A0c): se ele apagasse
 * codigo junto, toda ausencia deste grupo viraria vacuidade.
 *
 * ── Anti-vacuidade ─────────────────────────────────────────────────
 * Toda afirmacao de AUSENCIA vem acompanhada de (i) prova de que o alvo
 * existe e foi lido e (ii) controle negativo que envenena a entrada e
 * verifica que o predicado passa a dizer NAO. Assert que so sabe dizer
 * "sim" nao e teste.
 */
import { readFileSync, readdirSync, existsSync } from "fs";
import { join } from "path";
import { execFileSync } from "child_process";

import {
  validarAnaliseVendasIA,
  SCHEMA_ANALISE_VENDAS_IA,
  CHAVES_ANALISE_IA,
  LIMITE_RESUMO_CARACTERES,
  LIMITE_ITEM_CARACTERES,
  LIMITE_ITENS_LISTA,
} from "../lib/agentes/ia/contrato-analise";
import {
  criarAdaptadorFake,
  montarAnaliseFake,
  MODELO_FAKE,
} from "../lib/agentes/ia/fake";
import { ErroProvedorIA } from "../lib/ai-gateway/erros";
import type { AnaliseVendasIA } from "../lib/agentes/ia/contrato-analise";
import type { PedidoIA } from "../lib/agentes/ia/tipos";

// ── Armadilha de rede ─────────────────────────────────────────────────
let chamadasDeRede = 0;
(globalThis as unknown as { fetch: unknown }).fetch = (...args: unknown[]) => {
  chamadasDeRede++;
  throw new Error(`suite pura: fetch proibido (${String(args[0]).slice(0, 60)})`);
};

const RAIZ = join(__dirname, "..");
const DIR_IA = join(RAIZ, "lib", "agentes", "ia");

let passou = 0;
let falhou = 0;
function ok(nome: string, condicao: boolean) {
  if (condicao) passou++;
  else {
    falhou++;
    console.error(`  x ${nome}`);
  }
}

/**
 * Roda `acao` e classifica o resultado. Nunca engole erro: devolve o que
 * aconteceu para o assert decidir.
 */
function capturar(acao: () => unknown): { lancou: boolean; erro: unknown; valor: unknown } {
  try {
    return { lancou: false, erro: undefined, valor: acao() };
  } catch (erro) {
    return { lancou: true, erro, valor: undefined };
  }
}

/** Recusa do contrato: precisa ser `ErroProvedorIA` com tipo `validation`. */
function ehRecusaDeContrato(erro: unknown): boolean {
  return erro instanceof ErroProvedorIA && erro.tipo === "validation";
}

function recusa(nome: string, bruto: unknown) {
  const r = capturar(() => validarAnaliseVendasIA(bruto));
  ok(nome, r.lancou && ehRecusaDeContrato(r.erro));
}

function aceita(nome: string, bruto: unknown, conferir?: (v: AnaliseVendasIA) => boolean) {
  const r = capturar(() => validarAnaliseVendasIA(bruto));
  ok(nome, !r.lancou && (conferir ? conferir(r.valor as AnaliseVendasIA) : true));
}

/**
 * Remove comentarios de linha e de bloco. Preserva conteudo de string
 * literal simples, dupla e template — sem isso, um `//` dentro de string
 * comeria o resto da linha de codigo.
 */
function semComentarios(fonte: string): string {
  let saida = "";
  let i = 0;
  let delimitador: string | null = null;
  while (i < fonte.length) {
    const c = fonte[i];
    const prox = fonte[i + 1];
    if (delimitador !== null) {
      saida += c;
      if (c === "\\") {
        saida += fonte[i + 1] ?? "";
        i += 2;
        continue;
      }
      if (c === delimitador) delimitador = null;
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      delimitador = c;
      saida += c;
      i++;
      continue;
    }
    if (c === "/" && prox === "/") {
      while (i < fonte.length && fonte[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && prox === "*") {
      i += 2;
      while (i < fonte.length && !(fonte[i] === "*" && fonte[i + 1] === "/")) i++;
      i += 2;
      saida += " ";
      continue;
    }
    saida += c;
    i++;
  }
  return saida;
}

const MODULOS_IA = ["tipos.ts", "contrato-analise.ts", "fake.ts"] as const;

/** Fonte crua e fonte sem comentario, dos tres modulos, lidas uma vez. */
const fontes = new Map<string, { crua: string; codigo: string }>();
for (const arquivo of MODULOS_IA) {
  const crua = readFileSync(join(DIR_IA, arquivo), "utf8");
  fontes.set(arquivo, { crua, codigo: semComentarios(crua) });
}

/** Concatena o CODIGO (sem comentario) dos tres modulos. */
const codigoIA = MODULOS_IA.map((a) => fontes.get(a)!.codigo).join("\n");

async function main() {
  console.log("\nAGENTES-FASE1E-a — fundacao neutra de IA (pura)\n");

  // ═══ A. VARREDURA DE FONTE — o que o contrato NAO pode ter ════════
  console.log("A. Varredura de fonte (codigo, sem comentario)");

  // Ancoras: sem elas, todo assert de ausencia abaixo seria vacuo.
  ok("A0a os tres modulos existem e foram lidos", MODULOS_IA.every((a) => (fontes.get(a)?.crua.length ?? 0) > 0));
  ok(
    "A0b o removedor de comentario apaga comentario de verdade",
    !semComentarios("const a = 1; // marcador_de_comentario\n").includes("marcador_de_comentario")
  );
  ok(
    "A0c CONTROLE NEGATIVO: o removedor NAO apaga codigo nem string",
    (() => {
      const r = semComentarios(`const url = "a//b"; /* fora */ const x = 1;`);
      return r.includes(`"a//b"`) && r.includes("const x = 1");
    })()
  );
  ok(
    "A0d os docblocks CITAM os termos proibidos (por isso a varredura ignora comentario)",
    fontes.get("tipos.ts")!.crua.includes("user_id") && !fontes.get("tipos.ts")!.codigo.includes("user_id")
  );

  // Cada entrada: [rotulo, regex]. Ausencia esperada em TODO o codigo.
  const PROIBIDOS: ReadonlyArray<readonly [string, RegExp]> = [
    ["userId", /\buserId\b/],
    ["user_id", /\buser_id\b/],
    ["tenantId", /\btenantId\b/],
    ["projetoId", /\bprojetoId\b/],
    ["jobId", /\bjobId\b/],
    ["SupabaseClient / supabase", /\bsupabase\b/i],
    ["service_role", /service_role/i],
    ["createClient", /\bcreateClient\b/],
    ["process.env", /process\s*\.\s*env/],
    ["fetch", /\bfetch\s*\(/],
    ["SDK anthropic/google", /@anthropic-ai|@google\/genai/],
    ["server-only", /server-only/],
    ["SQL cru", /\b(select|insert|update|delete)\s+.*\bfrom\b|\bfrom\s+public\./i],
    ["rpc(", /\.\s*rpc\s*\(/],
    ["tools / tool_choice / input_schema", /\btools\s*:|\btool_choice\b|\binput_schema\b/],
    ["Date.now", /Date\s*\.\s*now/],
    ["new Date", /new\s+Date\b/],
    ["Math.random", /Math\s*\.\s*random/],
    ["writeFile", /\bwriteFile/],
    ["http:// ou https://", /https?:\/\//],
  ];

  for (const [rotulo, padrao] of PROIBIDOS) {
    ok(`A1 codigo de lib/agentes/ia nao contem ${rotulo}`, !padrao.test(codigoIA));
  }
  ok(
    "A2 CONTROLE NEGATIVO: os padroes ACHAM quando o termo esta presente",
    PROIBIDOS.every(([, padrao]) => {
      const envenenado =
        codigoIA +
        "\nconst userId = 1; const user_id = 1; const tenantId = 1; const projetoId = 1;" +
        "\nconst jobId = 1; supabase; service_role; createClient(); process.env; fetch();" +
        '\nimport "@anthropic-ai/sdk"; import "@google/genai"; import "server-only";' +
        "\nselect x from public.pedidos; a.rpc(); tools: []; tool_choice; input_schema;" +
        "\nDate.now(); new Date(); Math.random(); writeFileSync(); https://exemplo";
      return padrao.test(envenenado);
    })
  );

  // O contrato so pode expor os 4 campos previstos.
  {
    const codigoTipos = fontes.get("tipos.ts")!.codigo;
    const bloco = codigoTipos.match(/interface\s+PedidoIA<T>\s*\{([\s\S]*?)\n\}/);
    ok("A3 bloco de `PedidoIA` localizado na fonte", bloco !== null);
    if (bloco) {
      const campos = [...bloco[1].matchAll(/^\s*(\w+)\s*[?:]/gm)].map((m) => m[1]).sort();
      ok(
        "A4 `PedidoIA` tem exatamente instrucao, dados, schema, validar",
        JSON.stringify(campos) === JSON.stringify(["dados", "instrucao", "schema", "validar"])
      );
      ok("A5 CONTROLE NEGATIVO: o extrator de campos nao volta vazio", campos.length === 4);
    }
  }

  ok(
    "A6 `AdaptadorIA` e uma funcao de UM parametro (sem canal lateral)",
    /type\s+AdaptadorIA\s*=\s*<T>\(\s*pedido\s*:\s*PedidoIA<T>\s*\)\s*=>/.test(fontes.get("tipos.ts")!.codigo)
  );
  ok(
    "A7 lib/agentes/ia contem apenas os tres modulos previstos",
    JSON.stringify(readdirSync(DIR_IA).sort()) === JSON.stringify([...MODULOS_IA].sort())
  );

  // ═══ B. CONTRATO DE SAIDA — schema declarado ═════════════════════
  console.log("B. Schema declarado ao provedor");

  ok("B1 schema e objeto fechado", SCHEMA_ANALISE_VENDAS_IA.additionalProperties === false);
  ok(
    "B2 schema exige exatamente as tres chaves",
    JSON.stringify([...SCHEMA_ANALISE_VENDAS_IA.required].sort()) ===
      JSON.stringify([...CHAVES_ANALISE_IA].sort())
  );
  ok(
    "B3 schema nao declara nenhum campo numerico (numero vem de calculo, nunca de IA)",
    !JSON.stringify(SCHEMA_ANALISE_VENDAS_IA).includes('"number"') &&
      !JSON.stringify(SCHEMA_ANALISE_VENDAS_IA).includes('"integer"')
  );
  ok(
    "B4 schema nao tem campo de acao/sugestao/comando",
    !/acao|acoes|sugest|comando|executar/i.test(JSON.stringify(SCHEMA_ANALISE_VENDAS_IA))
  );
  ok(
    "B5 schema nao tem campo de identidade",
    !/user|tenant|projeto|job|loja_id/i.test(JSON.stringify(SCHEMA_ANALISE_VENDAS_IA))
  );
  ok(
    "B6 CONTROLE NEGATIVO: os predicados B3/B4/B5 acusam quando o campo existe",
    JSON.stringify({ ...SCHEMA_ANALISE_VENDAS_IA, extra: { type: "number" } }).includes('"number"') &&
      /sugest/i.test(JSON.stringify({ sugestoes: 1 })) &&
      /user/i.test(JSON.stringify({ user_id: 1 }))
  );

  // ═══ C. VALIDACAO ESTRUTURAL — aceitar o valido ══════════════════
  console.log("C. Validacao — casos validos");

  const VALIDO: AnaliseVendasIA = { resumo: "r", destaques: ["d"], alertas: ["a"] };

  aceita("C1 caso minimo valido", { ...VALIDO });
  aceita("C2 alertas vazio e valido (ausencia de problema e afirmacao)", { resumo: "r", destaques: [], alertas: [] });
  aceita("C3 resumo exatamente no limite passa", {
    resumo: "x".repeat(LIMITE_RESUMO_CARACTERES),
    destaques: [],
    alertas: [],
  });
  aceita("C4 item exatamente no limite passa", {
    resumo: "r",
    destaques: ["x".repeat(LIMITE_ITEM_CARACTERES)],
    alertas: [],
  });
  aceita("C5 lista exatamente no limite de itens passa", {
    resumo: "r",
    destaques: Array.from({ length: LIMITE_ITENS_LISTA }, (_, i) => `d${i}`),
    alertas: [],
  });
  aceita(
    "C6 objeto sem prototipo (Object.create(null)) e aceito",
    Object.assign(Object.create(null), { resumo: "r", destaques: [], alertas: [] })
  );
  aceita("C7 espaco em volta e aparado", { resumo: "  r  ", destaques: ["  d  "], alertas: [] }, (v) => v.resumo === "r" && v.destaques[0] === "d");
  aceita(
    "C8 a saida tem EXATAMENTE as tres chaves do contrato",
    { ...VALIDO },
    (v) => JSON.stringify(Object.keys(v).sort()) === JSON.stringify([...CHAVES_ANALISE_IA].sort())
  );
  {
    const entrada = { ...VALIDO };
    const saida = validarAnaliseVendasIA(entrada);
    ok("C9 a saida e um objeto NOVO, nao a entrada reaproveitada", saida !== (entrada as unknown));
    ok("C10 a entrada nao foi mutada", JSON.stringify(entrada) === JSON.stringify(VALIDO));
  }

  // ═══ D. VALIDACAO ESTRUTURAL — recusar o invalido ════════════════
  console.log("D. Validacao — recusas");

  recusa("D1 undefined", undefined);
  recusa("D2 null", null);
  recusa("D3 array", [VALIDO]);
  recusa("D4 string", JSON.stringify(VALIDO));
  recusa("D5 numero", 42);
  recusa("D6 boolean", true);
  recusa("D7 Date (prototipo nao e Object.prototype)", new Date(0));
  recusa("D8 Map", new Map());
  recusa("D9 instancia de classe", new (class { resumo = "r"; destaques = []; alertas = []; })());

  recusa("D10 chave inesperada (contrato FECHADO)", { ...VALIDO, proximas_acoes: ["fazer x"] });
  recusa("D11 chave inesperada mesmo que inofensiva", { ...VALIDO, observacao: "oi" });
  recusa("D12 resumo ausente", { destaques: [], alertas: [] });
  recusa("D13 destaques ausente", { resumo: "r", alertas: [] });
  recusa("D14 alertas ausente (chave ausente != lista vazia)", { resumo: "r", destaques: [] });

  recusa("D15 resumo null", { resumo: null, destaques: [], alertas: [] });
  recusa("D16 resumo numero", { resumo: 1, destaques: [], alertas: [] });
  recusa("D17 resumo vazio", { resumo: "", destaques: [], alertas: [] });
  recusa("D18 resumo so com espaco", { resumo: "   \n\t ", destaques: [], alertas: [] });
  recusa("D19 resumo 1 caractere acima do limite", {
    resumo: "x".repeat(LIMITE_RESUMO_CARACTERES + 1),
    destaques: [],
    alertas: [],
  });

  recusa("D20 destaques null (nao e lista vazia)", { resumo: "r", destaques: null, alertas: [] });
  recusa("D21 destaques string", { resumo: "r", destaques: "d", alertas: [] });
  recusa("D22 destaques com item nao-string", { resumo: "r", destaques: [1], alertas: [] });
  recusa("D23 destaques com item vazio", { resumo: "r", destaques: [""], alertas: [] });
  recusa("D24 destaques com item so espaco", { resumo: "r", destaques: ["  "], alertas: [] });
  recusa("D25 destaques com item acima do limite", {
    resumo: "r",
    destaques: ["x".repeat(LIMITE_ITEM_CARACTERES + 1)],
    alertas: [],
  });
  recusa("D26 destaques com itens acima do limite de lista", {
    resumo: "r",
    destaques: Array.from({ length: LIMITE_ITENS_LISTA + 1 }, (_, i) => `d${i}`),
    alertas: [],
  });
  recusa("D27 alertas null", { resumo: "r", destaques: [], alertas: null });
  recusa("D28 alertas com item vazio", { resumo: "r", destaques: [], alertas: [""] });
  recusa("D29 alertas com item nao-string", { resumo: "r", destaques: [], alertas: [{ texto: "a" }] });

  {
    const r = capturar(() => validarAnaliseVendasIA({ ...VALIDO, extra: 1 }));
    ok("D30 a recusa e ErroProvedorIA", r.erro instanceof ErroProvedorIA);
    ok("D31 a recusa tem tipo `validation`", (r.erro as ErroProvedorIA)?.tipo === "validation");
    ok(
      "D32 a mensagem diz qual foi o desvio",
      typeof (r.erro as Error)?.message === "string" && (r.erro as Error).message.includes("extra")
    );
  }
  ok(
    "D33 CONTROLE NEGATIVO: `ehRecusaDeContrato` recusa erro de outro tipo",
    !ehRecusaDeContrato(new ErroProvedorIA("auth", "x")) && !ehRecusaDeContrato(new Error("x"))
  );
  {
    // Chave ausente e recusada DUAS vezes: pela checagem de chaves
    // obrigatorias e, se ela sumisse, pelo validador do campo (undefined
    // nao e string nem array). O teste de mutacao da 1E-a mostrou que
    // remover a primeira NAO muda aceitar/recusar — muda so o
    // diagnostico. Sem este assert, a checagem de `faltantes` seria
    // codigo morto que nenhum teste distingue de ausente.
    const casos: Array<[string, unknown]> = [
      ["resumo", { destaques: [], alertas: [] }],
      ["destaques", { resumo: "r", alertas: [] }],
      ["alertas", { resumo: "r", destaques: [] }],
    ];
    ok(
      "D34 chave ausente e diagnosticada como AUSENTE (nao como tipo errado)",
      casos.every(([chave, bruto]) => {
        const msg = String((capturar(() => validarAnaliseVendasIA(bruto)).erro as Error)?.message);
        return msg.includes("ausente") && msg.includes(chave);
      })
    );
  }

  // ═══ E. FAKE — comportamento ═════════════════════════════════════
  console.log("E. Adaptador fake");

  const pedidoBase = (): PedidoIA<AnaliseVendasIA> => ({
    instrucao: "Descreva o periodo. Nao invente numero.",
    dados: JSON.stringify({ totais: { pedidosPagos: 3 } }),
    schema: SCHEMA_ANALISE_VENDAS_IA,
    validar: validarAnaliseVendasIA,
  });

  {
    const { adaptador, chamadas } = criarAdaptadorFake();
    const resposta = await adaptador(pedidoBase());
    ok("E1 modo padrao devolve resposta", resposta !== undefined);
    ok("E2 provedor e `fake`", resposta.provedor === "fake");
    ok("E3 modelo e o do fake", resposta.modelo === MODELO_FAKE);
    ok("E4 tempoMs e 0 (determinismo, nao medicao)", resposta.tempoMs === 0);
    ok("E5 tokens zerados por padrao", resposta.tokensEntrada === 0 && resposta.tokensSaida === 0);
    ok("E6 conteudo tem as tres chaves validadas", JSON.stringify(Object.keys(resposta.conteudo).sort()) === JSON.stringify([...CHAVES_ANALISE_IA].sort()));
    ok("E7 o texto se identifica como fake", resposta.conteudo.resumo.startsWith("[fake]"));
    ok("E8 o espiao registrou a chamada", chamadas.length === 1);
    ok(
      "E9 o pedido registrado tem apenas os 4 campos do contrato",
      JSON.stringify(Object.keys(chamadas[0]).sort()) === JSON.stringify(["dados", "instrucao", "schema", "validar"])
    );
    ok(
      "E10 nenhuma chave de identidade atravessou o contrato",
      !/user|tenant|projeto|job|secret|token|senha/i.test(Object.keys(chamadas[0]).join(","))
    );
  }

  {
    // Determinismo: mesma entrada, duas execucoes, dois adaptadores.
    const a = criarAdaptadorFake();
    const b = criarAdaptadorFake();
    const r1 = await a.adaptador(pedidoBase());
    const r2 = await a.adaptador(pedidoBase());
    const r3 = await b.adaptador(pedidoBase());
    ok("E11 duas chamadas iguais no mesmo adaptador dao a MESMA saida", JSON.stringify(r1) === JSON.stringify(r2));
    ok("E12 adaptadores distintos dao a MESMA saida", JSON.stringify(r1) === JSON.stringify(r3));

    const outro = pedidoBase();
    outro.dados = outro.dados + " ";
    const r4 = await a.adaptador(outro);
    ok("E13 CONTROLE NEGATIVO: entrada diferente muda a saida", JSON.stringify(r1) !== JSON.stringify(r4));
  }

  {
    // A validacao do CHAMADOR e realmente exercitada pelo fake.
    let vezes = 0;
    const sentinela = new Error("sentinela do validador");
    const { adaptador } = criarAdaptadorFake();
    const pedido: PedidoIA<AnaliseVendasIA> = {
      ...pedidoBase(),
      validar: (bruto) => {
        vezes++;
        return validarAnaliseVendasIA(bruto);
      },
    };
    await adaptador(pedido);
    ok("E14 o fake chamou `validar` do pedido, exatamente uma vez", vezes === 1);

    const { adaptador: ad2 } = criarAdaptadorFake();
    const r = await ad2({ ...pedidoBase(), validar: () => { throw sentinela; } }).then(
      () => ({ lancou: false, erro: undefined as unknown }),
      (erro: unknown) => ({ lancou: true, erro })
    );
    ok("E15 erro do validador sobe INTACTO (o fake nao converte nem engole)", r.lancou && r.erro === sentinela);
  }

  {
    // Modo erro.
    const { adaptador, chamadas } = criarAdaptadorFake({ modo: "erro", tipoErro: "rate_limit", mensagemErro: "estourou" });
    const r = await adaptador(pedidoBase()).then(
      () => ({ lancou: false, erro: undefined as unknown }),
      (erro: unknown) => ({ lancou: true, erro })
    );
    ok("E16 modo erro lanca", r.lancou);
    ok("E17 lanca ErroProvedorIA", r.erro instanceof ErroProvedorIA);
    ok("E18 com o tipo pedido pelo teste", (r.erro as ErroProvedorIA)?.tipo === "rate_limit");
    ok("E19 com a mensagem pedida", (r.erro as Error)?.message === "estourou");
    ok("E20 o espiao registrou a chamada que FALHOU", chamadas.length === 1);
  }

  {
    // Modo resposta_invalida: quem recusa e a NOSSA validacao.
    const { adaptador } = criarAdaptadorFake({ modo: "resposta_invalida", bruto: { resumo: "r", destaques: [], alertas: [], extra: 1 } });
    const r = await adaptador(pedidoBase()).then(
      () => ({ lancou: false, erro: undefined as unknown }),
      (erro: unknown) => ({ lancou: true, erro })
    );
    ok("E21 resposta invalida e recusada", r.lancou);
    ok("E22 a recusa veio da NOSSA validacao, nao de erro simulado", ehRecusaDeContrato(r.erro) && (r.erro as Error).message.includes("fora do contrato"));
  }
  {
    const { adaptador } = criarAdaptadorFake({ modo: "resposta_invalida" });
    const r = await adaptador(pedidoBase()).then(
      () => ({ lancou: false, erro: undefined as unknown }),
      (erro: unknown) => ({ lancou: true, erro })
    );
    ok("E23 modo resposta_invalida sem `bruto` lanca (nao inventa invalido padrao)", r.lancou && r.erro instanceof ErroProvedorIA);
  }
  {
    // `bruto` explicitamente valido no modo sucesso.
    const { adaptador } = criarAdaptadorFake({ bruto: { resumo: "meu", destaques: [], alertas: [] }, modelo: "m", tokensEntrada: 7, tokensSaida: 9 });
    const r = await adaptador(pedidoBase());
    ok("E24 `bruto` explicito e usado e validado", r.conteudo.resumo === "meu");
    ok("E25 modelo e tokens vem das opcoes", r.modelo === "m" && r.tokensEntrada === 7 && r.tokensSaida === 9);
  }
  {
    // `bruto: undefined` explicito NAO cai no padrao — `in` distingue.
    const { adaptador } = criarAdaptadorFake({ bruto: undefined });
    const r = await adaptador(pedidoBase()).then(
      () => ({ lancou: false }),
      () => ({ lancou: true })
    );
    ok("E26 `bruto: undefined` explicito e respeitado e recusado pela validacao", r.lancou);
  }
  {
    const saidaDireta = montarAnaliseFake(pedidoBase());
    ok("E27 `montarAnaliseFake` e pura: duas chamadas, saidas iguais", JSON.stringify(saidaDireta) === JSON.stringify(montarAnaliseFake(pedidoBase())));
    aceita("E28 a saida padrao do fake PASSA na validacao real", saidaDireta);
  }

  // ═══ F. PUREZA EM RUNTIME ════════════════════════════════════════
  console.log("F. Pureza em runtime");

  {
    const dateNowReal = Date.now;
    const randomReal = Math.random;
    const descritorEnv = Object.getOwnPropertyDescriptor(process, "env")!;
    const envReal = process.env;
    let usosDateNow = 0;
    let usosRandom = 0;
    let usosEnv = 0;

    Date.now = () => { usosDateNow++; return dateNowReal.call(Date); };
    Math.random = () => { usosRandom++; return randomReal(); };
    Object.defineProperty(process, "env", { configurable: true, get() { usosEnv++; return envReal; } });

    try {
      const { adaptador } = criarAdaptadorFake();
      await adaptador(pedidoBase());
      validarAnaliseVendasIA({ resumo: "r", destaques: [], alertas: [] });
      capturar(() => validarAnaliseVendasIA(null));
    } finally {
      Date.now = dateNowReal;
      Math.random = randomReal;
      Object.defineProperty(process, "env", descritorEnv);
    }

    ok("F1 nenhum uso de Date.now no caminho completo", usosDateNow === 0);
    ok("F2 nenhum uso de Math.random", usosRandom === 0);
    ok("F3 nenhum acesso a process.env", usosEnv === 0);

    // Controles negativos: os tres instrumentos precisam saber acusar.
    let c1 = 0, c2 = 0, c3 = 0;
    const d = Object.getOwnPropertyDescriptor(process, "env")!;
    const nowR = Date.now, randR = Math.random, envR = process.env;
    Date.now = () => { c1++; return nowR.call(Date); };
    Math.random = () => { c2++; return randR(); };
    Object.defineProperty(process, "env", { configurable: true, get() { c3++; return envR; } });
    try {
      Date.now(); Math.random(); void process.env;
    } finally {
      Date.now = nowR; Math.random = randR; Object.defineProperty(process, "env", d);
    }
    ok("F4 CONTROLE NEGATIVO: os tres instrumentos acusam quando ha uso", c1 === 1 && c2 === 1 && c3 === 1);
  }

  {
    // Prova do GRAFO REALMENTE CARREGADO, nao da fonte: o que o `tsx`
    // resolveu e executou ate aqui esta em `require.cache`. Se algum dos
    // tres modulos passar a arrastar `server-only`, Supabase ou um SDK
    // de provedor, o caminho aparece aqui — mesmo que a fonte importe
    // por um intermediario que a varredura do grupo A nao le.
    const carregados = Object.keys(require.cache).map((p) => p.replace(/\\/g, "/"));
    ok("F5a o grafo carregado foi observado e contem os modulos da fase", carregados.some((p) => p.includes("/lib/agentes/ia/fake.ts")));
    const PROIBIDOS_NO_GRAFO = /server-only|@supabase|@google\/genai|@anthropic-ai|\/lib\/agentes\/dados\/|\/lib\/supabase/;
    const intrusos = carregados.filter((p) => PROIBIDOS_NO_GRAFO.test(p));
    ok(`F5b nenhum modulo server-only/SDK/Supabase no grafo (${intrusos.length} achados)`, intrusos.length === 0);
    ok(
      "F5c CONTROLE NEGATIVO: o predicado do grafo acusa um caminho proibido",
      PROIBIDOS_NO_GRAFO.test("/x/node_modules/server-only/index.js") &&
        PROIBIDOS_NO_GRAFO.test("/x/lib/agentes/dados/vendas.ts")
    );
  }
  ok("F6 zero chamadas de rede em toda a suite", chamadasDeRede === 0);

  // ═══ G. ESCOPO — TRANSITORIO DA 1E-a ═════════════════════════════
  // ATENCAO: este grupo congela estado de VCS e expira quando uma fase
  // AUTORIZADA alterar qualquer arquivo da lista. Isso ja aconteceu
  // duas vezes nesta frente (1D-c -> 1D-d, 1D-a -> 1D-c). Ao autorizar
  // a 1E-b/1E-c, este grupo deve ser revisto junto, nao contornado.
  console.log("G. Escopo da fase (TRANSITORIO)");

  {
    const INTOCAVEIS = [
      "lib/agentes/dados/vendas.ts",
      "lib/agentes/handlers/analise-vendas.ts",
      "lib/agentes/handlers/registry.ts",
      "lib/agentes/executar-tarefa.ts",
      "lib/agentes/capability-worker.ts",
      "lib/agentes/capability.ts",
      "lib/agentes/tipos-execucao.ts",
      "lib/agentes/tipos.ts",
      "lib/agentes/erros.ts",
      "supabase/migrations/20260918_agentes_indice_vendas_id_keyset.sql",
    ];
    const sujos = execFileSync("git", ["status", "--porcelain", "--", ...INTOCAVEIS], {
      cwd: RAIZ,
      encoding: "utf8",
    }).trim();
    ok("G1 nenhum arquivo da lista NAO TOCAR foi modificado", sujos === "");
    ok(
      "G2 CONTROLE NEGATIVO: o oraculo git enxerga modificacao",
      execFileSync("git", ["status", "--porcelain", "--", "docs/NEXT_TASK.md"], { cwd: RAIZ, encoding: "utf8" }).trim() !== ""
    );
    ok(
      "G3 os arquivos da lista existem (o oraculo nao esta olhando para o vazio)",
      INTOCAVEIS.every((p) => existsSync(join(RAIZ, p)))
    );
  }

  const total = passou + falhou;
  console.log(`\n${"=".repeat(58)}`);
  console.log(`AGENTES-FASE1E-a — fundacao neutra de IA:  ${passou}/${total} passaram`);
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
