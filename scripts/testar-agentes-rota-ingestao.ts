/**
 * A rota dedicada de ingestao de perguntas — I4C.
 *
 * ── O que esta suite prova ──────────────────────────────────────────
 *
 * O CONTRATO da porta: quem entra, o que pode dizer, o que nunca pode
 * dizer, e o que sai. Ela roda o handler REAL, com o parser real, a
 * gramatica real e o montador de resposta real. O que e dublado sao as
 * TRES fronteiras de fora — o agente, a reconciliacao e o servico —,
 * porque o que se prova aqui e a decisao da rota, nao o banco.
 *
 * A prova de que a reconciliacao le mesmo o ledger, de que a corrida tem
 * uma vencedora so e de que o replay sobrevive a um processo novo esta na
 * suite de banco: `testar-agentes-rota-ingestao-banco.ts`.
 *
 * Zero rede. Zero banco. Zero marketplace.
 *
 * Rodar:  npx tsx scripts/testar-agentes-rota-ingestao.ts
 */
import "./_server-only-inerte";

import Module from "node:module";
import { readFileSync } from "node:fs";
import { join } from "node:path";

let passou = 0;
let falhou = 0;

function ok(nome: string, condicao: boolean, detalhe = ""): void {
  if (condicao) {
    passou++;
    console.log(`  PASS  ${nome}`);
  } else {
    falhou++;
    console.log(`  FAIL  ${nome}${detalhe ? ` — ${detalhe}` : ""}`);
  }
}

function secao(titulo: string): void {
  console.log(`\n── ${titulo} ${"─".repeat(Math.max(0, 62 - titulo.length))}`);
}

const RAIZ = join(__dirname, "..");
const ler = (rel: string) => readFileSync(join(RAIZ, rel), "utf8");
const semComentarios = (f: string) =>
  f.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

// ─── Ambiente sintetico ───────────────────────────────────────────────
//
// Os dois segredos sao LITERAIS DIFERENTES de proposito: e a unica forma
// de provar que um nao abre a porta do outro.

const SEGREDO_INGESTAO = "SEGREDO_INGESTAO_I4C_SINTETICO";
const SEGREDO_PONTE = "SEGREDO_PONTE_GENERICA_I4C_SINTETICO";
const AGENTE = "aaaaaaaa-4c00-4000-8000-00000000000a";
const USER = "user-i4c-alpha";

process.env.N8N_INGESTAO_INTERNAL_SECRET = SEGREDO_INGESTAO;
process.env.N8N_BRIDGE_INTERNAL_SECRET = SEGREDO_PONTE;
process.env.N8N_INGESTAO_AGENT_ID = AGENTE;

// ─── Dublês das tres fronteiras ───────────────────────────────────────

interface ChamadaDoServico {
  agenteId: string;
  idempotencyKey: string;
}

const espiao = {
  lerAgente: 0,
  reconciliar: 0,
  executar: 0,
  fetch: 0,
  chamadasDoServico: [] as ChamadaDoServico[],
  chavesReconciliadas: [] as string[],
};

function zerar(): void {
  espiao.lerAgente = 0;
  espiao.reconciliar = 0;
  espiao.executar = 0;
  espiao.fetch = 0;
  espiao.chamadasDoServico = [];
  espiao.chavesReconciliadas = [];
}

/** O que o dublê do agente devolve. Trocado por caso. */
let respostaDoAgente: { agente: unknown; erro: string | null } = {
  agente: { agenteId: AGENTE, userId: USER, ativo: true },
  erro: null,
};

/** A fila de estados que a reconciliacao devolve, em ordem de chamada. */
let estadosReconciliados: unknown[] = [];

/** O que o servico devolve. */
let respostaDoServico: unknown = null;

const dublesPorCaminho: ReadonlyArray<[string, () => unknown]> = [
  ["agentes/capability-worker", () => ({
    lerAgenteParaAcaoInterna: async () => {
      espiao.lerAgente++;
      return respostaDoAgente;
    },
  })],
  ["agentes/acoes/leitura-acao", () => ({
    lerEstadoDaAcaoPorIdempotencia: async (id: { idempotencyKey: string }) => {
      espiao.reconciliar++;
      espiao.chavesReconciliadas.push(id.idempotencyKey);
      const proximo = estadosReconciliados.shift();
      return proximo ?? { estado: "nao_iniciada" };
    },
  })],
  ["agentes/ingestao/sincronizar-perguntas", () => ({
    sincronizarPerguntas: async (entrada: ChamadaDoServico) => {
      espiao.executar++;
      espiao.chamadasDoServico.push({ ...entrada });
      return respostaDoServico;
    },
  })],
];

const requireOriginal = (Module as unknown as { prototype: { require: (id: string) => unknown } })
  .prototype.require;

(Module as unknown as { prototype: { require: unknown } }).prototype.require = function (
  this: unknown,
  id: string
) {
  if (typeof id === "string") {
    for (const [trecho, fabrica] of dublesPorCaminho) {
      if (id.includes(trecho)) return fabrica();
    }
    // Qualquer ida ao cliente real e defeito do teste, nao do codigo.
    if (id.includes("supabase-servidor")) {
      return {
        getSupabaseServidor: () => {
          throw new Error("a suite estrutural nao pode tocar o banco");
        },
      };
    }
  }
  return requireOriginal.apply(this, arguments as unknown as [string]);
};

// Nenhuma ida externa. A rota nao deve ter nenhuma — o servico e dublado.
globalThis.fetch = (async () => {
  espiao.fetch++;
  throw new Error("rede proibida nesta suite");
}) as typeof fetch;

// ─── Requisicao ───────────────────────────────────────────────────────

const req = (corpo: unknown, segredo: string | null = SEGREDO_INGESTAO) =>
  new Request("http://localhost/api/internal/agentes/ingestao-perguntas", {
    method: "POST",
    headers: segredo === null
      ? { "Content-Type": "application/json" }
      : { "Content-Type": "application/json", "x-worker-secret": segredo },
    body: typeof corpo === "string" ? corpo : JSON.stringify(corpo),
  });

const corpoValido = (opId = "b20260924T1200", execId = "exec-1") => ({
  executionId: execId,
  operationId: opId,
});

/** Um desfecho como o servico o devolve depois da abertura. */
function resultadoDoServico(
  status: string,
  codigo: string | null,
  resumo: Record<string, number | boolean> = {},
  tipo = "sincronizado",
  requestId = "req-vivo-1"
): unknown {
  return {
    tipo,
    requestId,
    perguntas: [],
    metricas: {},
    persistencia: {},
    providerTruncado: false,
    auditoria: "completa",
    desfechoDuravel: { status, codigo, resumo },
  };
}

async function main(): Promise<void> {
  console.log("\n══ CDS IA — I4C: rota dedicada de ingestao de perguntas ══");

  const rota = await import("../app/api/internal/agentes/ingestao-perguntas/route");
  const { lerIdentidadeDaOperacao, MAX_TENTATIVAS_POR_OPERACAO } =
    await import("../lib/agentes/ingestao/identidade-operacao");
  const { chaveDeIdempotencia, acoesRegistradas } =
    await import("../lib/agentes/acoes/catalogo");

  const ROTA = semComentarios(ler("app/api/internal/agentes/ingestao-perguntas/route.ts"));
  const GRAMATICA = semComentarios(ler("lib/agentes/ingestao/identidade-operacao.ts"));
  const LEITURA = semComentarios(ler("lib/agentes/acoes/leitura-acao.ts"));

  const POST = async (corpo: unknown, segredo: string | null = SEGREDO_INGESTAO) => {
    const r = await rota.POST(req(corpo, segredo));
    return { status: r.status, corpo: (await r.json()) as Record<string, unknown>, bruta: r };
  };

  const chaveEsperada = (opId: string) =>
    chaveDeIdempotencia("n8n", opId, "sincronizar_perguntas", AGENTE);

  // ═══ G. A gramatica do operationId ═══════════════════════════════════
  secao("G. Gramatica do operationId");

  const valida = (s: string) => lerIdentidadeDaOperacao(s);
  const motivo = (s: string) => {
    const r = lerIdentidadeDaOperacao(s);
    return r.ok ? "" : r.motivo;
  };

  ok("G1  o bucket sozinho e valido e vale tentativa 1",
    valida("b20260924T1200").ok &&
    (valida("b20260924T1200") as { identidade: { tentativa: number } }).identidade.tentativa === 1);
  ok("G1b e continuacao ZERO",
    (valida("b20260924T1200") as { identidade: { continuacao: number } })
      .identidade.continuacao === 0);
  ok("G2  `:c1` e continuacao 1, tentativa 1",
    (valida("b1:c1") as { identidade: { continuacao: number; tentativa: number } })
      .identidade.continuacao === 1 &&
    (valida("b1:c1") as { identidade: { tentativa: number } }).identidade.tentativa === 1);
  ok("G3  `:r2` e tentativa 2",
    (valida("b1:r2") as { identidade: { tentativa: number } }).identidade.tentativa === 2);
  ok("G4  `:r3` e tentativa 3 — o teto",
    (valida("b1:r3") as { identidade: { tentativa: number } }).identidade.tentativa === 3);
  ok("G5  `:r4` passa do teto e e RECUSADO",
    motivo("b1:r4") === "tentativa_acima_do_teto");
  ok("G5b `:r9` tambem", motivo("b1:r9") === "tentativa_acima_do_teto");
  ok("G6  `:r1` e RECUSADO: seria um segundo nome para a tentativa 1",
    motivo("b1:r1") === "tentativa_redundante");
  ok("G6b e o teto do arquivo e o congelado no I4A",
    MAX_TENTATIVAS_POR_OPERACAO === 3);
  ok("G7  composicao `:c2:r3` e aceita, e diz as duas coisas",
    (valida("b1:c2:r3") as { identidade: { continuacao: number; tentativa: number } })
      .identidade.continuacao === 2 &&
    (valida("b1:c2:r3") as { identidade: { tentativa: number } }).identidade.tentativa === 3);
  ok("G8  a ordem INVERSA `:r2:c1` e recusada — uma ordem so",
    motivo("b1:r2:c1") === "ordem_invalida");
  ok("G9  sufixo repetido e recusado", motivo("b1:c1:c2") === "sufixo_repetido");
  ok("G10 sufixo desconhecido e recusado", motivo("b1:x2") === "sufixo_desconhecido");
  ok("G11 indice com zero a esquerda e recusado", motivo("b1:c01") === "indice_invalido");
  ok("G11b indice zero e recusado", motivo("b1:c0") === "indice_invalido");
  ok("G11c indice sem digito e recusado", motivo("b1:c") === "indice_invalido");
  ok("G12 indice de quatro digitos e recusado", motivo("b1:c1000") === "indice_invalido");
  ok("G12b tres digitos ainda cabem — o teto e de FORMA, nao politica",
    valida("b1:c999").ok);
  ok("G13 espaco nas pontas e recusado, nunca aparado",
    motivo(" b1") === "espaco_nas_pontas" && motivo("b1 ") === "espaco_nas_pontas");
  ok("G14 vazio e recusado", motivo("") === "ausente");
  ok("G15 nao-string e recusado", motivo(123 as unknown as string) === "tipo_invalido");
  ok("G16 string gigante e recusada", motivo("b".repeat(65)) === "comprimento");
  ok("G17 bucket com caractere fora do alfabeto e recusado",
    motivo("b/1") === "bucket_invalido" && motivo("b.1") === "bucket_invalido");
  ok("G17b bucket comecando por hifen e recusado", motivo("-b1") === "bucket_invalido");

  // ── O namespace duplo, que e o ponto do item A do pre-flight ──
  ok("G18 `n8n:algo` NAO e um operationId — o `:` nao entra no bucket",
    !valida("n8n:b1").ok);
  ok("G18b e o bucket exatamente `n8n` e reservado",
    motivo("n8n") === "bucket_reservado");
  ok("G19 `manual:quem-123` NAO passa pela rota agendada",
    !valida("manual:quem-123").ok);
  ok("G19b e o bucket exatamente `manual` e reservado",
    motivo("manual") === "bucket_reservado");
  ok("G20 a gramatica nao cita nenhum campo de autoridade",
    !/lojaId|sellerId|userId|agenteId|deslocamento|offset/.test(GRAMATICA));

  // ═══ R1/R2. Autenticacao ═════════════════════════════════════════════
  secao("R1/R2. Autenticacao com segredo dedicado");

  zerar();
  const semSegredo = await POST(corpoValido(), null);
  ok("R1  sem segredo -> 401", semSegredo.status === 401);
  ok("R1b e ZERO trabalho: nem agente, nem ledger, nem servico",
    espiao.lerAgente === 0 && espiao.reconciliar === 0 && espiao.executar === 0);

  zerar();
  ok("R1c segredo errado -> 401", (await POST(corpoValido(), "errado")).status === 401);
  ok("R1d e tambem ZERO trabalho",
    espiao.lerAgente === 0 && espiao.reconciliar === 0 && espiao.executar === 0);

  zerar();
  ok("R2  o segredo da PONTE generica nao abre esta porta",
    (await POST(corpoValido(), SEGREDO_PONTE)).status === 401);
  ok("R2b e zero trabalho tambem nesse caso",
    espiao.lerAgente === 0 && espiao.reconciliar === 0 && espiao.executar === 0);

  zerar();
  respostaDoServico = resultadoDoServico("sucesso", null);
  ok("R2c o segredo PROPRIO abre", (await POST(corpoValido())).status === 200);

  ok("R2d a rota le a PROPRIA variavel, e nao a da ponte",
    ROTA.includes("N8N_INGESTAO_INTERNAL_SECRET") &&
    !ROTA.includes("N8N_BRIDGE_INTERNAL_SECRET") &&
    !ROTA.includes("CRON_SECRET"));
  ok("R2e e nao ha fallback de uma variavel para a outra",
    !/N8N_INGESTAO_INTERNAL_SECRET\s*\?\?/.test(ROTA) &&
    !/\|\|\s*process\.env\.N8N/.test(ROTA));

  // ── Falta de configuracao nunca abre ──
  {
    const guardado = process.env.N8N_INGESTAO_INTERNAL_SECRET;
    delete process.env.N8N_INGESTAO_INTERNAL_SECRET;
    zerar();
    ok("R2f sem a variavel no servidor, a porta recusa TUDO — fail closed",
      (await POST(corpoValido(), SEGREDO_INGESTAO)).status === 401);
    process.env.N8N_INGESTAO_INTERNAL_SECRET = guardado;
  }

  // ═══ R3/R4. Corpo ════════════════════════════════════════════════════
  secao("R3/R4. Corpo fechado nos dois sentidos");

  zerar();
  respostaDoServico = resultadoDoServico("sucesso", null);

  const malformados: ReadonlyArray<[string, unknown]> = [
    ["sem operationId", { executionId: "e1" }],
    ["sem executionId", { operationId: "b1" }],
    ["corpo vazio", {}],
    ["array", []],
    ["nulo", null],
    ["json invalido", "{ nao e json"],
    ["executionId vazio", { operationId: "b1", executionId: "" }],
    ["executionId gigante", { operationId: "b1", executionId: "e".repeat(129) }],
    ["operationId nao-string", { operationId: 7, executionId: "e1" }],
    ["operationId com namespace duplo", { operationId: "n8n:b1", executionId: "e1" }],
    ["operationId com namespace manual", { operationId: "manual:eu-1", executionId: "e1" }],
  ];
  for (const [nome, corpo] of malformados) {
    const r = await POST(corpo);
    ok(`R3  ${nome} -> 400`, r.status === 400, `status ${r.status}`);
  }
  ok("R3b e nenhum corpo malformado chegou a executar nada",
    espiao.executar === 0 && espiao.reconciliar === 0);

  // ── R4: campos com FORMA de autoridade ──
  const autoridade = [
    "agenteId", "userId", "lojaId", "sellerId", "funcaoId", "acao",
    "offset", "deslocamento", "limite", "status", "cursor", "provider",
    "credencial", "idempotencyKey", "requestId", "tentativa", "prazoMs",
  ];
  zerar();
  let todosRecusados = true;
  for (const campo of autoridade) {
    const r = await POST({ ...corpoValido(), [campo]: "x" });
    if (r.status !== 400) {
      todosRecusados = false;
      console.log(`        ${campo} passou com ${r.status}`);
    }
  }
  ok(`R4  os ${autoridade.length} campos de autoridade sao RECUSADOS, nao ignorados`,
    todosRecusados);
  ok("R4b e nenhum deles chegou a ler agente ou ledger",
    espiao.lerAgente === 0 && espiao.reconciliar === 0 && espiao.executar === 0);

  // ═══ R5/R6/R7. O agente vem do ambiente ══════════════════════════════
  secao("R5/R6/R7. Agente do ambiente, revalidado no banco");

  {
    const guardado = process.env.N8N_INGESTAO_AGENT_ID;

    delete process.env.N8N_INGESTAO_AGENT_ID;
    zerar();
    const semAgente = await POST(corpoValido());
    ok("R5  sem N8N_INGESTAO_AGENT_ID -> fail closed 500", semAgente.status === 500);
    ok("R5b e ZERO execucao", espiao.executar === 0 && espiao.reconciliar === 0);

    process.env.N8N_INGESTAO_AGENT_ID = "nao-e-uuid";
    zerar();
    ok("R6  id malformado -> 500", (await POST(corpoValido())).status === 500);
    ok("R6b e nem chega a consultar o banco", espiao.lerAgente === 0);

    process.env.N8N_INGESTAO_AGENT_ID = guardado;
  }

  zerar();
  respostaDoAgente = { agente: null, erro: null };
  ok("R6c agente inexistente -> 500", (await POST(corpoValido())).status === 500);
  ok("R6d e ZERO execucao", espiao.executar === 0 && espiao.reconciliar === 0);

  zerar();
  respostaDoAgente = { agente: { agenteId: AGENTE, userId: USER, ativo: false }, erro: null };
  ok("R6e agente INATIVO -> 500", (await POST(corpoValido())).status === 500);
  ok("R6f e ZERO execucao", espiao.executar === 0 && espiao.reconciliar === 0);

  zerar();
  respostaDoAgente = { agente: null, erro: "erro_consulta_agente" };
  ok("R6g leitura do agente falhou -> 500", (await POST(corpoValido())).status === 500);
  ok("R6h e ZERO execucao", espiao.executar === 0 && espiao.reconciliar === 0);

  respostaDoAgente = { agente: { agenteId: AGENTE, userId: USER, ativo: true }, erro: null };

  // ── R7: nada do corpo escolhe autoridade ──
  ok("R7  a rota nao tem `resolverAcao` — nao ha seletor de acao",
    !ROTA.includes("resolverAcao"));
  ok("R7b a acao e CONSTANTE, importada de quem grava a linha",
    ROTA.includes("ACAO_SINCRONIZAR_PERGUNTAS") && !/acao:\s*corpo\./.test(ROTA));
  ok("R7c o agente sai do ambiente, nunca do corpo",
    ROTA.includes("process.env.N8N_INGESTAO_AGENT_ID") &&
    !/corpo\.(agenteId|userId|lojaId)/.test(ROTA));
  ok("R7d o dono sai do REGISTRO do agente",
    ROTA.includes("agente.userId"));
  ok("R7e o servico recebe DOIS campos, e nenhum deles e autoridade de dominio",
    /sincronizarPerguntas\(\s*\{\s*agenteId:\s*agente\.agenteId,\s*idempotencyKey:\s*chave,\s*\}\s*\)/.test(ROTA));

  // ═══ R24/R26/R27. A chave ════════════════════════════════════════════
  secao("R24/R26/R27. Composicao da chave de idempotencia");

  zerar();
  respostaDoServico = resultadoDoServico("sucesso", null);
  await POST(corpoValido("b1", "exec-A"));
  await POST(corpoValido("b1", "exec-B"));
  ok("R24 o mesmo operationId com executionId DIFERENTE da a mesma chave",
    espiao.chamadasDoServico.length === 2 &&
    espiao.chamadasDoServico[0].idempotencyKey === espiao.chamadasDoServico[1].idempotencyKey);
  ok("R24b e a chave nao contem o executionId",
    !espiao.chamadasDoServico[0].idempotencyKey.includes("exec-"));
  // `executionId` so pode aparecer onde se LE a forma do corpo. Se ele
  // reaparecesse depois de `lerCorpo`, alguem o teria transformado em decisao.
  const DEPOIS_DO_PARSER = ROTA.slice(ROTA.indexOf("export async function POST"));
  ok("R24c `executionId` nao aparece em nenhuma decisao da rota",
    !DEPOIS_DO_PARSER.includes("executionId"));

  ok("R24d a chave tem o namespace UMA vez",
    espiao.chamadasDoServico[0].idempotencyKey.startsWith("n8n:") &&
    !espiao.chamadasDoServico[0].idempotencyKey.includes("n8n:n8n:"));
  ok("R24e e ela e exatamente `n8n:<op>:sincronizar_perguntas:<agente>`",
    espiao.chamadasDoServico[0].idempotencyKey === chaveEsperada("b1"));

  zerar();
  await POST(corpoValido("b1"));
  await POST(corpoValido("b1:r2"));
  await POST(corpoValido("b1:r3"));
  const chaves = espiao.chamadasDoServico.map((c) => c.idempotencyKey);
  ok("R26 cada tentativa valida gera uma chave NOVA",
    new Set(chaves).size === 3);
  ok("R26b e todas continuam no mesmo namespace",
    chaves.every((c) => c.startsWith("n8n:") && !c.includes("n8n:n8n:")));

  zerar();
  await POST(corpoValido("b1"));
  await POST(corpoValido("b1:c1"));
  await POST(corpoValido("b1:c2"));
  const chavesC = espiao.chamadasDoServico.map((c) => c.idempotencyKey);
  ok("R27 cada continuacao gera uma chave NOVA",
    new Set(chavesC).size === 3);
  ok("R27b e a entrada do servico NAO tem deslocamento — o cursor e do CDS",
    espiao.chamadasDoServico.every(
      (c) => Object.keys(c).sort().join(",") === "agenteId,idempotencyKey"));

  zerar();
  ok("R25 `:r4` e recusado pelo CDS, nao pelo bom comportamento do n8n",
    (await POST(corpoValido("b1:r4"))).status === 400);
  ok("R25b `:r1` tambem", (await POST(corpoValido("b1:r1"))).status === 400);
  ok("R25c e nenhum dos dois executou nada", espiao.executar === 0);

  // ═══ R12/R13/R14. Reconciliacao ══════════════════════════════════════
  secao("R12/R13/R14. Estados reconciliados");

  zerar();
  estadosReconciliados = [{ estado: "aberta", requestId: "req-orfa", idadeMs: 5_000 }];
  const orfaJovem = await POST(corpoValido("b-orfa-1"));
  ok("R12 orfa com menos de 120 s -> em_andamento",
    orfaJovem.status === 200 && orfaJovem.corpo.estado === "em_andamento");
  ok("R12b `ok` e falso: nao ha resultado ainda", orfaJovem.corpo.ok === false);
  ok("R12c e ZERO execucao — a mesma operacao nao roda de novo",
    espiao.executar === 0);

  zerar();
  estadosReconciliados = [{ estado: "aberta", requestId: "req-orfa", idadeMs: 119_999 }];
  ok("R12d 119.999 ms ainda e `em_andamento` — a fronteira e exclusiva",
    (await POST(corpoValido("b-orfa-2"))).corpo.estado === "em_andamento");

  zerar();
  estadosReconciliados = [{ estado: "aberta", requestId: "req-orfa", idadeMs: 120_000 }];
  const orfaVelha = await POST(corpoValido("b-orfa-3"));
  ok("R13 orfa com 120 s ou mais -> resultado_desconhecido",
    orfaVelha.corpo.estado === "resultado_desconhecido");
  ok("R13b e ZERO execucao", espiao.executar === 0);
  ok("R13c nenhuma das duas orfas vaza o requestId da execucao perdida",
    orfaJovem.corpo.requestId === undefined && orfaVelha.corpo.requestId === undefined);

  zerar();
  estadosReconciliados = [{ estado: "conflito", motivo: "agente_divergente" }];
  const conflito = await POST(corpoValido("b-conflito"));
  ok("R14 ledger inconsistente -> 409", conflito.status === 409);
  ok("R14b com estado `conflito` e ok falso",
    conflito.corpo.estado === "conflito" && conflito.corpo.ok === false);
  ok("R14c o MOTIVO interno nao viaja na resposta",
    conflito.corpo.motivo === undefined);
  ok("R14d e ZERO execucao", espiao.executar === 0);

  zerar();
  estadosReconciliados = [{ estado: "falhou_leitura" }];
  const ilegivel = await POST(corpoValido("b-ilegivel"));
  ok("R14e ledger ilegivel -> 500, e NAO 409: um e retry, o outro nao",
    ilegivel.status === 500);
  ok("R14f e ZERO execucao", espiao.executar === 0);

  // ═══ R9/R10/R11. Replay de operacao concluida ════════════════════════
  secao("R9/R10/R11. Replay com terminal duravel");

  const resumoDuravel = {
    paginas: 2, ingeriveis: 40, novas: 40, truncado: true,
    limite_atingido: true, continuacao_pendente: true, deslocamento_inicial: 0,
  };

  zerar();
  estadosReconciliados = [{
    estado: "concluida",
    requestId: "req-original-1",
    desfecho: { status: "parcial", codigo: "backlog_truncado", resumo: resumoDuravel },
  }];
  const replay = await POST(corpoValido("b-replay", "exec-outro"));
  ok("R9  replay de operacao concluida -> 200", replay.status === 200);
  ok("R9b devolve o DESFECHO conhecido, nao um generico",
    replay.corpo.estado === "parcial" && replay.corpo.codigo === "backlog_truncado");
  ok("R9c marcado como replay", replay.corpo.replay === true);
  ok("R9d e ZERO execucao — zero provider, zero inbox, zero cursor",
    espiao.executar === 0);
  ok("R9e a palavra `ja_processado` nao aparece na resposta",
    JSON.stringify(replay.corpo).indexOf("ja_processado") === -1);
  // O `ja_processado` do SERVICO continua existindo — e o nome que o
  // indice unico da abertura devolve. O que nao pode existir e ele
  // virar ESTADO de resposta: e ai que ele deixaria de dizer o que houve.
  ok("R9f e a rota nunca o emite como estado",
    !/estado:\s*"(ja_processado|already_processed)"/.test(ROTA) &&
    !ROTA.includes("already_processed"));
  ok("R10 o requestId e o da ACAO ORIGINAL, nao um id novo",
    replay.corpo.requestId === "req-original-1");
  ok("R11 executionId diferente nao muda nada: continua replay",
    replay.corpo.replay === true && espiao.executar === 0);

  ok("R22 o replay de `backlog_truncado` reproduz `pendente: true`",
    JSON.stringify(replay.corpo.continuacao) === JSON.stringify({ pendente: true }));
  ok("R22b sem que ninguem tenha mandado deslocamento",
    espiao.chamadasDoServico.length === 0);

  // ═══ R17..R21. Desfechos de dominio ao vivo ══════════════════════════
  secao("R17..R21. Desfechos de dominio");

  const casos: ReadonlyArray<[string, string, string | null, string, boolean]> = [
    ["R17 erro de provider", "erro", "provedor_falhou", "erro", false],
    ["R17b orcamento esgotado", "erro", "orcamento_esgotado", "erro", false],
    ["R18 aguardando aprovacao", "aguardando_aprovacao", "aprovacao_necessaria",
      "aguardando_aprovacao", true],
    ["R19 negado", "negado", "permissao_ausente", "negada", false],
    ["R19b conexao ausente", "negado", "conexao_ausente", "negada", false],
    ["R21 varredura completa", "sucesso", null, "executada", true],
    ["R20 backlog truncado", "parcial", "backlog_truncado", "parcial", true],
  ];

  for (const [nome, status, codigo, estadoEsperado, okEsperado] of casos) {
    zerar();
    estadosReconciliados = [];
    respostaDoServico = resultadoDoServico(status, codigo,
      status === "parcial" ? { continuacao_pendente: true } : {});
    const r = await POST(corpoValido(`b-${status}-${codigo ?? "nulo"}`));
    ok(`${nome} -> HTTP 200`, r.status === 200, `status ${r.status}`);
    ok(`${nome} · estado=${estadoEsperado} ok=${okEsperado}`,
      r.corpo.estado === estadoEsperado && r.corpo.ok === okEsperado,
      `${String(r.corpo.estado)}/${String(r.corpo.ok)}`);
  }

  zerar();
  respostaDoServico = resultadoDoServico("parcial", "backlog_truncado",
    { continuacao_pendente: true, limite_atingido: true });
  const parcial = await POST(corpoValido("b-parcial"));
  ok("R20b `parcial` traz continuacao.pendente = true",
    JSON.stringify(parcial.corpo.continuacao) === JSON.stringify({ pendente: true }));
  ok("R20c e NAO traz replay", parcial.corpo.replay === undefined);

  zerar();
  respostaDoServico = resultadoDoServico("sucesso", null, { continuacao_pendente: false });
  const completa = await POST(corpoValido("b-completa"));
  ok("R21b travessia completa traz pendente = false",
    JSON.stringify(completa.corpo.continuacao) === JSON.stringify({ pendente: false }));

  // ═══ R16. Falha de abertura ══════════════════════════════════════════
  secao("R16. Falha tecnica ao abrir a acao");

  zerar();
  respostaDoServico = { tipo: "abertura_falhou", requestId: "req-x" };
  const abertura = await POST(corpoValido("b-abertura"));
  ok("R16 abertura que nao gravou -> 500", abertura.status === 500);
  ok("R16b com estado `abertura_falhou`", abertura.corpo.estado === "abertura_falhou");
  ok("R16c e ZERO ida externa", espiao.fetch === 0);

  zerar();
  respostaDoServico = { tipo: "agente_indisponivel", motivo: "inativo" };
  ok("R16d recusa anterior a abertura vira 500 — e defeito NOSSO",
    (await POST(corpoValido("b-indisp"))).status === 500);

  // ═══ R15. A corrida, no nivel da rota ════════════════════════════════
  secao("R15. Perdedora da corrida reconcilia de novo");

  zerar();
  estadosReconciliados = [
    { estado: "nao_iniciada" },
    {
      estado: "concluida",
      requestId: "req-da-vencedora",
      desfecho: { status: "sucesso", codigo: null, resumo: { continuacao_pendente: false } },
    },
  ];
  respostaDoServico = { tipo: "ja_processado", requestId: "req-da-perdedora" };
  const perdedora = await POST(corpoValido("b-corrida"));
  ok("R15 a perdedora NAO devolve `ja_processado` generico",
    perdedora.corpo.estado !== "ja_processado" &&
    perdedora.corpo.estado !== "already_processed");
  ok("R15b ela devolve o desfecho DURAVEL da vencedora",
    perdedora.status === 200 && perdedora.corpo.estado === "executada");
  ok("R15c com o requestId da VENCEDORA, nunca o dela",
    perdedora.corpo.requestId === "req-da-vencedora");
  ok("R15d marcada como replay", perdedora.corpo.replay === true);
  ok("R15e e reconciliou DUAS vezes: antes e depois da colisao",
    espiao.reconciliar === 2);

  zerar();
  estadosReconciliados = [
    { estado: "nao_iniciada" },
    { estado: "aberta", requestId: "req-da-vencedora", idadeMs: 1_000 },
  ];
  respostaDoServico = { tipo: "ja_processado", requestId: "req-da-perdedora" };
  const perdedoraViva = await POST(corpoValido("b-corrida-2"));
  ok("R15f se a vencedora ainda roda, a perdedora recebe `em_andamento`",
    perdedoraViva.corpo.estado === "em_andamento");

  zerar();
  estadosReconciliados = [{ estado: "nao_iniciada" }, { estado: "nao_iniciada" }];
  respostaDoServico = { tipo: "ja_processado", requestId: "req-x" };
  ok("R15g colisao sem abertura visivel e CONFLITO, nao sucesso silencioso",
    (await POST(corpoValido("b-corrida-3"))).status === 409);

  // ═══ R23/R28/R29/R30. Contrato, MAIN, log e cache ════════════════════
  secao("R23/R28/R29/R30. Superficie");

  zerar();
  respostaDoServico = resultadoDoServico("parcial", "backlog_truncado", resumoDuravel);
  const contrato = await POST(corpoValido("b-contrato"));
  const CHAVES_PERMITIDAS = new Set([
    "ok", "estado", "codigo", "requestId", "metricas", "continuacao", "replay",
  ]);
  ok("R23 a resposta so tem chaves do contrato congelado",
    Object.keys(contrato.corpo).every((c) => CHAVES_PERMITIDAS.has(c)),
    Object.keys(contrato.corpo).join(","));
  ok("R23b `metricas` so tem escalares",
    Object.values(contrato.corpo.metricas as Record<string, unknown>)
      .every((v) => typeof v === "number" || typeof v === "boolean"));
  const textoDaResposta = JSON.stringify(contrato.corpo);
  ok("R23c zero identificador de negocio ou de tenant na resposta",
    !textoDaResposta.includes(AGENTE) && !textoDaResposta.includes(USER) &&
    !/loja|seller|pergunta_id|item_id|token|credencial/i.test(textoDaResposta));
  ok("R23d `continuacao` NAO expoe deslocamento, loja nem versao",
    JSON.stringify(contrato.corpo.continuacao) === JSON.stringify({ pendente: true }));
  // O resumo DURAVEL guarda `deslocamento_inicial`; a resposta NAO pode
  // guarda-lo. A allowlist da porta e mais estreita que a do banco, e e
  // por aqui que o offset deixa de atravessar.
  ok("R23e o offset de partida NAO atravessa a porta, mesmo estando no resumo",
    resumoDuravel.deslocamento_inicial === 0 &&
    (contrato.corpo.metricas as Record<string, unknown>).deslocamento_inicial === undefined);
  ok("R23f nem o estado interno do cursor",
    (contrato.corpo.metricas as Record<string, unknown>).cursor_atualizado === undefined &&
    (contrato.corpo.metricas as Record<string, unknown>).cursor_reiniciado === undefined);
  ok("R23g mas as contagens da varredura atravessam",
    (contrato.corpo.metricas as Record<string, unknown>).paginas === 2 &&
    (contrato.corpo.metricas as Record<string, unknown>).novas === 40);
  ok("R23h e a rota nunca constroi um campo de deslocamento na saida",
    !/corpo\.(deslocamento|offset|proximoDeslocamento|lojaId|versao)/.test(ROTA));

  ok("R30 a resposta e `no-store`",
    contrato.bruta.headers.get("Cache-Control") === "no-store");
  {
    const r401 = await rota.POST(req(corpoValido(), null));
    const r400 = await rota.POST(req({}, SEGREDO_INGESTAO));
    ok("R30b inclusive no 401 e no 400",
      r401.headers.get("Cache-Control") === "no-store" &&
      r400.headers.get("Cache-Control") === "no-store");
  }

  // ── R29: o segredo nunca chega ao log ──
  {
    const capturado: string[] = [];
    const errOriginal = console.error;
    const logOriginal = console.log;
    console.error = (...a: unknown[]) => { capturado.push(a.map(String).join(" ")); };
    console.log = (...a: unknown[]) => { capturado.push(a.map(String).join(" ")); };
    zerar();
    estadosReconciliados = [{ estado: "conflito", motivo: "agente_divergente" }];
    await rota.POST(req(corpoValido("b-log"), "SEGREDO_ERRADO_PARA_LOG"));
    await rota.POST(req(corpoValido("b-log"), SEGREDO_INGESTAO));
    console.error = errOriginal;
    console.log = logOriginal;
    const tudo = capturado.join("\n");
    ok("R29 nenhum log contem o segredo", !tudo.includes(SEGREDO_INGESTAO));
    ok("R29b nem o segredo errado que alguem tentou",
      !tudo.includes("SEGREDO_ERRADO_PARA_LOG"));
    ok("R29c nem o id do agente ou o dono",
      !tudo.includes(AGENTE) && !tudo.includes(USER));
    ok("R29d e a rota nao imprime o valor de nenhuma variavel de segredo",
      !/console\.(log|error|info|warn)\([^)]*segredo/i.test(ROTA));
  }

  // ── R28: a MAIN generica continua sem alcançar a acao ──
  ok("R28 `sincronizar_perguntas` NAO esta no catalogo da ponte generica",
    !acoesRegistradas().includes("sincronizar_perguntas"));
  ok("R28b o catalogo continua com exatamente as duas acoes de consulta",
    [...acoesRegistradas()].sort().join(",") === "consultar_perguntas,consultar_vendas");
  {
    const ponte = await import("../app/api/internal/agentes/acoes/route");
    const pedido = new Request("http://localhost/api/internal/agentes/acoes", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-worker-secret": SEGREDO_PONTE },
      body: JSON.stringify({
        agenteId: AGENTE, acao: "sincronizar_perguntas", argumentos: {},
        executionId: "e1", operationId: "o1",
      }),
    });
    const r = await ponte.POST(pedido);
    // I4O2: a MAIN entrou em QUARENTENA. Ela nao recusa mais por acao
    // desconhecida — ela nao chega a olhar a acao. O invariante que
    // importa aqui continua o mesmo, e ficou mais forte: `sincronizar_perguntas`
    // nao executa pela ponte generica. Antes isso era um 400 do catalogo;
    // agora e um 410 terminal, alcancado sem ler o corpo.
    ok("R28c e a MAIN termina em 410 de aposentadoria, sem olhar a acao",
      r.status === 410);
    ok("R28d e o corpo diz qual e o estado da ponte",
      (await r.clone().json()).codigo === "main_generico_em_aposentadoria");
    const pedidoIngestao = new Request("http://localhost/api/internal/agentes/acoes", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-worker-secret": SEGREDO_INGESTAO },
      body: JSON.stringify({
        agenteId: AGENTE, acao: "consultar_perguntas", argumentos: {},
        executionId: "e1", operationId: "o1",
      }),
    });
    ok("R32 o segredo de INGESTAO nao muda a autoridade da MAIN",
      (await ponte.POST(pedidoIngestao)).status === 401);
  }

  // ── Fronteiras estruturais ──
  secao("S. Fronteiras estruturais");

  ok("S1  a rota nao grava no ledger — a porta de escrita continua sendo uma",
    !ROTA.includes("registrarAberturaAcao") && !ROTA.includes("registrarDesfechoAcao"));
  ok("S2  o leitor de reconciliacao nao escreve",
    !/\.(insert|update|upsert|delete)\(/.test(LEITURA));
  ok("S3  ele localiza a abertura por (user_id, acao_id, idempotency_key)",
    /eq\("user_id"[\s\S]{0,200}eq\("acao_id"[\s\S]{0,200}eq\("idempotency_key"/.test(LEITURA));
  ok("S4  e o desfecho por request_id, nunca por idempotency_key",
    /eq\("request_id", requestId\)[\s\S]{0,120}eq\("fase", "desfecho"\)/.test(LEITURA));
  ok("S5  ele filtra SEMPRE por user_id nas duas consultas",
    (LEITURA.match(/\.eq\("user_id"/g) ?? []).length === 2);
  ok("S6  a rota nao cria relogio nem aceita prazo",
    !ROTA.includes("criarControleDeTempo") && !/prazo|deadline|timeoutMs/i.test(
      ROTA.replace(/maxDuration/g, "").replace(/LIMITE_DA_ORFA_MS/g, "")));
  ok("S7  a janela da orfa e 120 s, e nao o orcamento de 38 s da acao",
    ROTA.includes("120_000") && !ROTA.includes("38_000"));
  ok("S8  a rota nao importa o executor de Funcoes direto",
    !ROTA.includes("executarFuncao"));
  ok("S9  zero rede saiu desta suite", espiao.fetch === 0);

  console.log(`\n── placar ${"─".repeat(54)}`);
  console.log(`  PASS ${passou}   FAIL ${falhou}`);
  if (falhou > 0) process.exitCode = 1;
}

void main();
