/**
 * CDS IA — SKILL-1D.ui-consumer-C. Suite da primeira UI com dados reais.
 *
 * Duas coisas sao protegidas aqui, e nenhuma delas e aparencia.
 *
 * ── 1. A FRONTEIRA ──────────────────────────────────────────────────
 *
 * A area de IA passou a ter rede, e passou a ter num arquivo so. Se
 * amanha um componente visual ganhar o proprio `fetch`, o endereco e o
 * tratamento de status voltam a se espalhar — e e exatamente isso que
 * as sondas nominais desta suite (e as cinco suites historicas da area)
 * existem para impedir.
 *
 * ── 2. O QUE O TRANSPORTE FAZ COM CADA RESPOSTA ─────────────────────
 *
 * As funcoes REAIS de `lib/ia/agentes-http.ts` sao executadas contra um
 * `fetch` duplado. O que se afirma nao e "o mock devolveu o esperado",
 * e sim que 401 vira sessao expirada, que 500 vira falha, que corpo
 * torto vira falha — e que NENHUM dos tres vira lista vazia. Uma tela
 * que diz "voce nao tem agentes" quando na verdade nao conseguiu
 * perguntar e o defeito que esta suite persegue.
 *
 * Nao renderiza React: prova por leitura de fonte e por execucao das
 * funcoes puras, como as demais suites desta area.
 *
 * Rodar:  npx tsx scripts/testar-ia-agentes-ui-source.ts
 * Sem rede, sem banco, sem `--confirmo`.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
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
const codigo = (f: string) =>
  f.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

const TRANSPORTE = "lib/ia/agentes-http.ts";
const LISTA = "app/(app)/ia/agentes/page.tsx";
const ROTA_DETALHE = "app/(app)/ia/agentes/[id]/page.tsx";
const CONTAINER = "components/ia/agente/PaginaAgente.tsx";

/** A area varrida pelas cinco suites historicas, na mesma definicao. */
function arquivosDe(dirRel: string): string[] {
  const saida: string[] = [];
  const caminhar = (rel: string) => {
    for (const nome of readdirSync(join(RAIZ, rel))) {
      const filho = `${rel}/${nome}`;
      if (statSync(join(RAIZ, filho)).isDirectory()) caminhar(filho);
      else saida.push(filho);
    }
  };
  caminhar(dirRel);
  return saida.sort();
}
const AREA = [
  ...arquivosDe("lib/ia"),
  ...arquivosDe("components/ia"),
  ...arquivosDe("app/(app)/ia"),
];

const CODIGO_TRANSPORTE = codigo(ler(TRANSPORTE));

console.log("\n══ CDS IA — SKILL-1D.ui-consumer-C: a UI com fonte real ══");

// ─── A. A fronteira de rede ───────────────────────────────────────────

secao("A. Um ponto de rede, e um so");

{
  const comRede = AREA.filter((a) => /\bfetch\s*\(|XMLHttpRequest|axios|WebSocket/.test(codigo(ler(a))));
  ok("A1  exatamente UM arquivo da area tem rede",
    JSON.stringify(comRede) === JSON.stringify([TRANSPORTE]), comRede.join(", "));

  const comEndereco = AREA.filter((a) => /["'`]\/api\//.test(codigo(ler(a))));
  ok("A2  e exatamente UM constroi endereco de API",
    JSON.stringify(comEndereco) === JSON.stringify([TRANSPORTE]), comEndereco.join(", "));

  ok("A3  ANCORA: a varredura leu a area de verdade", AREA.length > 40, String(AREA.length));
  ok("A4  CONTROLE: a sonda de rede acusa quando o padrao existe",
    /\bfetch\s*\(/.test("await fetch(url)"));

  ok("A5  o transporte nao tem React nem hook",
    !/from "react"|useState|useEffect|useMemo|\.tsx/.test(CODIGO_TRANSPORTE));
  ok("A6  zero import de dominio de agentes",
    !/lib\/agentes|diagnosticarAgente|diagnosticarSkill|resolverSkillsDoAgente|resolverConexoesDoAgente|resolverFatosPermissoes/
      .test(CODIGO_TRANSPORTE));
  ok("A7  zero cliente de banco",
    !/getSupabaseServidor|createClient|service_role/i.test(CODIGO_TRANSPORTE));
  ok("A8  zero leitura de ambiente", !/process\.env/.test(CODIGO_TRANSPORTE));
}

secao("B. O que a UI NAO manda");

{
  const paraOServidor = [LISTA, ROTA_DETALHE, CONTAINER, TRANSPORTE];

  ok("B1  nenhum arquivo envia identificador de quem pergunta",
    paraOServidor.every((a) => !/\buserId\b|\buid\b/.test(codigo(ler(a)))));
  ok("B2  nenhum arquivo envia relogio do cliente",
    paraOServidor.every((a) => !/\bagoraMs\s*:/.test(codigo(ler(a)))) &&
      !/agoraMs/.test(CODIGO_TRANSPORTE));
  ok("B3  zero cabecalho de autorizacao ou cookie manual",
    !/Authorization|[Bb]earer|document\.cookie|headers\s*:/.test(CODIGO_TRANSPORTE));
  ok("B4  `credentials` omitido — o cookie same-origin ja viaja sozinho",
    !/credentials/.test(CODIGO_TRANSPORTE));
  ok("B5  zero corpo: as duas leituras sao GET puro",
    !/method\s*:|body\s*:/.test(CODIGO_TRANSPORTE));
  ok("B6  o agenteId vai escapado no caminho",
    /encodeURIComponent\(agenteId\)/.test(CODIGO_TRANSPORTE));
  ok("B7  zero POST nesta frente — criar agente e outra frente",
    !AREA.some((a) => /"POST"|method:\s*"POST"/.test(codigo(ler(a)))));
}

secao("C. As telas migradas nao voltam ao simulado");

{
  ok("C1  a lista nao importa mais os agentes simulados",
    !/MOCK_AGENTES|MOCK_AGENTE_POR_ID/.test(codigo(ler(LISTA))));
  ok("C2  a lista nao importa mais as tarefas simuladas",
    !/MOCK_TAREFAS/.test(codigo(ler(LISTA))));
  ok("C3  a rota de detalhe nao resolve mais no mock",
    !/MOCK_/.test(codigo(ler(ROTA_DETALHE))));
  ok("C4  o container nao usa mock nenhum", !/MOCK_/.test(codigo(ler(CONTAINER))));

  ok("C5  a lista consome o transporte nominal",
    /listarAgentes/.test(codigo(ler(LISTA))) &&
      /from "@\/lib\/ia\/agentes-http"/.test(codigo(ler(LISTA))));
  ok("C6  o container consome as DUAS leituras",
    /listarAgentes/.test(codigo(ler(CONTAINER))) &&
      /obterDiagnostico/.test(codigo(ler(CONTAINER))));
  ok("C7  as duas leituras sao paralelas, nao encadeadas",
    /Promise\.all\(\[\s*listarAgentes/.test(codigo(ler(CONTAINER))));
  ok("C8  as duas recebem o mesmo sinal de cancelamento",
    (codigo(ler(CONTAINER)).match(/controlador\.signal/g) ?? []).length >= 3);
  ok("C9  a lista tambem cancela ao sair",
    /new AbortController\(\)/.test(codigo(ler(LISTA))) &&
      /controlador\.abort\(\)/.test(codigo(ler(LISTA))));
  ok("C10 o container reinicia a leitura quando o agente muda",
    /\}, \[agenteId\]\)/.test(codigo(ler(CONTAINER))));

  ok("C11 os mocks continuam existindo para as telas nao migradas",
    /MOCK_AGENTES/.test(codigo(ler("components/ia/office/Escritorio.tsx"))) &&
      /MOCK_AGENTES/.test(codigo(ler("components/ia/atividade/Timeline.tsx"))));
  ok("C12 a rota de detalhe continua Server Component",
    !/^"use client"/m.test(ler(ROTA_DETALHE)));
  ok("C13 e nao faz rede por conta propria",
    !/\bfetch\s*\(/.test(codigo(ler(ROTA_DETALHE))));
}

// ─── D–G. O transporte REAL, contra um fetch duplado ──────────────────

interface Chamada { url: string; init?: RequestInit }
let chamadas: Chamada[] = [];
let proxima: { status: number; corpo: unknown } | "erro" = { status: 200, corpo: null };

const fetchOriginal = globalThis.fetch;
globalThis.fetch = (async (entrada: unknown, init?: RequestInit) => {
  chamadas.push({ url: String(entrada), init });
  if (proxima === "erro") throw new Error("rede caiu");
  return {
    status: proxima.status,
    ok: proxima.status >= 200 && proxima.status < 300,
    json: async () => {
      if (proxima !== "erro" && proxima.corpo === "ilegivel") throw new Error("json invalido");
      return proxima === "erro" ? null : proxima.corpo;
    },
  } as unknown as Response;
}) as typeof fetch;

function responde(status: number, corpo: unknown): void {
  chamadas = [];
  proxima = { status, corpo };
}

const agente = (id: string, extra: Record<string, unknown> = {}) => ({
  id, nome: `Agente ${id}`, tipo: "mensagens", instrucoes: null,
  ativo: true, criado_em: "2026-08-01T00:00:00.000Z", ...extra,
});
const item = (skillId: string, versao: string, estadoGeral = "PRONTO") =>
  ({ skillId, versao, diagnostico: { estadoGeral, pronto: estadoGeral === "PRONTO", bloqueios: [], limitacoes: [], funcoesUtilizaveis: [] } });

const UUID_A = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";

async function principal(): Promise<void> {
  const { listarAgentes, obterDiagnostico } = await import("../lib/ia/agentes-http");

  secao("D. listarAgentes — cada resposta no seu lugar");

  responde(200, { ok: true, agentes: [agente(UUID_A), agente("bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb", { ativo: false })] });
  const rOk = await listarAgentes();
  ok("D1  200 -> ok com os agentes", rOk.estado === "ok" && rOk.agentes.length === 2);
  ok("D2  o endereco e o metodo sao os publicados",
    chamadas.length === 1 && chamadas[0].url === "/api/agentes" &&
      (chamadas[0].init?.method ?? undefined) === undefined,
    chamadas[0]?.url);
  ok("D3  ativos E inativos atravessam — a tela precisa religar o desligado",
    rOk.estado === "ok" && rOk.agentes.some((a) => a.ativo === false));

  responde(200, { ok: true, agentes: [] });
  const rVazio = await listarAgentes();
  ok("D4  200 com lista vazia -> ok vazio, e nao falha",
    rVazio.estado === "ok" && rVazio.agentes.length === 0);

  responde(401, { ok: false, erro: "Não autenticado." });
  const r401 = await listarAgentes();
  ok("D5  401 -> nao_autenticado", r401.estado === "nao_autenticado");
  ok("D6  e NUNCA lista vazia", r401.estado !== "ok");

  responde(500, { ok: false, erro: "Falha ao listar os agentes." });
  const r500 = await listarAgentes();
  ok("D7  500 -> falha", r500.estado === "falha");
  ok("D8  e NUNCA lista vazia", r500.estado !== "ok");

  for (const [nome, corpo] of [
    ["D9  corpo sem `ok`", { agentes: [] }],
    ["D10 corpo com ok:false", { ok: false, agentes: [] }],
    ["D11 `agentes` que nao e lista", { ok: true, agentes: {} }],
    ["D12 agente sem id", { ok: true, agentes: [{ nome: "x", tipo: "ads", instrucoes: null, ativo: true, criado_em: "z" }] }],
    ["D13 agente com tipo fora do vocabulario", { ok: true, agentes: [agente(UUID_A, { tipo: "vendedor" })] }],
    ["D14 agente com ativo textual", { ok: true, agentes: [agente(UUID_A, { ativo: "sim" })] }],
    ["D15 corpo ilegivel", "ilegivel"],
  ] as [string, unknown][]) {
    responde(200, corpo);
    const r = await listarAgentes();
    ok(`${nome} -> falha, nunca lista parcial`, r.estado === "falha", r.estado);
  }

  proxima = "erro";
  chamadas = [];
  const rRede = await listarAgentes();
  ok("D16 rede caida -> falha, sem excecao vazando", rRede.estado === "falha");

  secao("E. obterDiagnostico — lista, versoes e semSelecao");

  responde(200, {
    ok: true, coleta: "ok",
    diagnosticos: [item("atendimento", "1.0.0"), item("atendimento", "2.0.0", "FALTA_CONEXAO"), item("ads", "1.0.0")],
    semSelecao: [{ plataforma: "shopee", recurso: "chat", obrigatoria: true }],
  });
  const dOk = await obterDiagnostico(UUID_A);
  ok("E1  200 -> ok", dOk.estado === "ok");
  ok("E2  o endereco leva o agenteId escapado",
    chamadas[0]?.url === `/api/agentes/${UUID_A}/diagnostico`, chamadas[0]?.url);
  ok("E3  os TRES itens atravessam — nada de `diagnosticos[0]`",
    dOk.estado === "ok" && dOk.diagnosticos.length === 3);
  ok("E4  duas versoes da MESMA Skill continuam duas",
    dOk.estado === "ok" &&
      dOk.diagnosticos.filter((d) => d.skillId === "atendimento").length === 2);
  ok("E5  e as versoes sao distintas, sem deduplicar",
    dOk.estado === "ok" &&
      JSON.stringify(dOk.diagnosticos.filter((d) => d.skillId === "atendimento").map((d) => d.versao)) ===
        JSON.stringify(["1.0.0", "2.0.0"]));
  ok("E6  semSelecao chega separado, intacto",
    dOk.estado === "ok" && dOk.semSelecao.length === 1);
  ok("E7  zero FALTA_SELECAO inventado",
    !/FALTA_SELECAO/.test(JSON.stringify(dOk)) && !/FALTA_SELECAO/.test(CODIGO_TRANSPORTE));

  responde(200, { ok: true, coleta: "ok", diagnosticos: [], semSelecao: [] });
  const dVazio = await obterDiagnostico(UUID_A);
  ok("E8  200 vazio -> ok vazio, e nao falha",
    dVazio.estado === "ok" && dVazio.diagnosticos.length === 0);

  responde(401, { ok: false });
  ok("E9  401 -> nao_autenticado", (await obterDiagnostico(UUID_A)).estado === "nao_autenticado");
  responde(400, { ok: false });
  ok("E10 400 -> entrada_invalida", (await obterDiagnostico(UUID_A)).estado === "entrada_invalida");
  responde(500, { ok: false });
  ok("E11 500 -> falha", (await obterDiagnostico(UUID_A)).estado === "falha");

  for (const [nome, corpo] of [
    ["E12 sem `diagnosticos`", { ok: true, semSelecao: [] }],
    ["E13 sem `semSelecao`", { ok: true, diagnosticos: [] }],
    ["E14 item sem versao", { ok: true, diagnosticos: [{ skillId: "x", diagnostico: {} }], semSelecao: [] }],
    ["E15 corpo ilegivel", "ilegivel"],
  ] as [string, unknown][]) {
    responde(200, corpo);
    const r = await obterDiagnostico(UUID_A);
    ok(`${nome} -> falha`, r.estado === "falha", r.estado);
  }

  secao("F. O sinal de cancelamento atravessa");

  responde(200, { ok: true, agentes: [] });
  const controlador = new AbortController();
  await listarAgentes(controlador.signal);
  ok("F1  listarAgentes repassa o AbortSignal",
    chamadas[0]?.init?.signal === controlador.signal);

  responde(200, { ok: true, coleta: "ok", diagnosticos: [], semSelecao: [] });
  await obterDiagnostico(UUID_A, controlador.signal);
  ok("F2  obterDiagnostico repassa o AbortSignal",
    chamadas[0]?.init?.signal === controlador.signal);

  globalThis.fetch = fetchOriginal;

  console.log(`\n══ ${passou} PASS / ${falhou} FAIL ══\n`);
  process.exitCode = falhou === 0 ? 0 : 1;
}

principal().catch((e) => {
  globalThis.fetch = fetchOriginal;
  console.log(`  FAIL  excecao nao tratada — ${String(e).slice(0, 300)}`);
  process.exitCode = 1;
});
