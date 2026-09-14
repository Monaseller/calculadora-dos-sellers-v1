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
  // B3 juntava duas coisas que a criacao separou: "nenhuma credencial
  // manual" (permanente) e "nenhum header" (de fase — enquanto so havia
  // GET, header nenhum era necessario). Um corpo JSON exige
  // `Content-Type`, e so ele. A parte de credencial NAO afrouxa; a de
  // header passa a ser allowlist do proprio cabecalho.
  ok("B3  zero credencial manual em qualquer arquivo da frente",
    paraOServidor.every(
      (a) => !/Authorization|[Bb]earer|document\.cookie/.test(codigo(ler(a)))
    ));
  ok("B3b headers so no transporte nominal",
    AREA.filter((a) => /headers\s*:/.test(codigo(ler(a)))).join(",") === TRANSPORTE,
    AREA.filter((a) => /headers\s*:/.test(codigo(ler(a)))).join(", ") || "nenhum");
  // ── B3c reconciliado na AGENT-VERTICAL-SLICE-V1-I3 ──────────────
  //
  // Passaram a existir DUAS escritas, e cada corpo JSON traz o seu
  // `Content-Type`. A invariavel nao afrouxa: continua sendo "o unico
  // cabecalho enviado e o do corpo JSON" — mudou quantas vezes ele
  // aparece. TODA ocorrencia de `headers:` tem de ser exatamente aquele
  // cabecalho, e nenhuma credencial entra junto.
  //
  // ── B3c reconciliado de novo na EDITAR-AGENTE-V1 ────────────────
  //
  // TRES corpos JSON, tres `Content-Type`. A invariavel continua sendo
  // "o unico cabecalho enviado e o do corpo JSON": as duas contagens
  // sao comparadas ENTRE SI, entao um `headers:` que nao seja aquele
  // cabecalho reprova, e o veto a credencial no cabecalho nao mudou.
  ok("B3c os UNICOS cabecalhos sao os tres Content-Type do corpo JSON",
    (CODIGO_TRANSPORTE.match(/headers\s*:/g) ?? []).length === 3 &&
      (CODIGO_TRANSPORTE.match(/headers: \{ "Content-Type": "application\/json" \}/g) ?? [])
        .length === 3 &&
      !/"X-|Cookie|Api-Key|Idempotency-Key/i.test(CODIGO_TRANSPORTE));
  ok("B4  `credentials` omitido — o cookie same-origin ja viaja sozinho",
    !/credentials/.test(CODIGO_TRANSPORTE));
  // As duas LEITURAS continuam GET puro — o que mudou foi a existencia
  // de UMA escrita. `method` e `body` deixam de ser proibidos no arquivo
  // e passam a ser exclusivos de `criarAgenteViaApi`: o corpo de cada
  // funcao e recortado e medido separadamente, para que um `body` que
  // aparecesse em `listarAgentes` reprovasse.
  const corpoDaFuncao = (nome: string): string => {
    const i = CODIGO_TRANSPORTE.indexOf(`export async function ${nome}(`);
    if (i < 0) return "";
    const resto = CODIGO_TRANSPORTE.slice(i + 1);
    const j = resto.indexOf("\nexport ");
    return j < 0 ? resto : resto.slice(0, j);
  };
  // A consulta de conversa entra AQUI, entre as leituras, e nao entre as
  // escritas: ela e GET puro. Classificar toda funcao que cita
  // `/conversa` como escrita confundiria acompanhar com criar.
  ok("B5  as tres leituras continuam GET puro, sem method e sem corpo",
    ["listarAgentes", "obterDiagnostico", "consultarConversaDoAgente"].every((f) => {
      const corpo = corpoDaFuncao(f);
      return corpo.length > 50 && !/method\s*:|body\s*:/.test(corpo);
    }));
  // ── B5b reconciliado na AGENT-VERTICAL-SLICE-V1-I3 ──────────────
  //
  // ANTES: "method e body existem SO na capacidade de criacao" — UMA
  // escrita, a de agente. DEPOIS: DUAS escritas, nomeadas, e somente
  // essas duas. Nao virou `>= 2` nem contagem solta — a suite sabe
  // QUAIS sao, por igualdade de conjunto nos dois sentidos.
  //
  // ── B5b reconciliado de novo na EDITAR-AGENTE-V1 ────────────────
  //
  // A doutrina antiga era "esta area cria, nunca altera nem apaga", e o
  // filtro por `method: "POST"` a expressava. A revogacao foi ratificada
  // e e PARCIAL: entra PATCH, para UM recurso e DOIS campos.
  //
  // Trocar o filtro importa mais do que trocar a contagem. Se ele
  // continuasse so olhando POST, a funcao de PATCH ficaria INVISIVEL e
  // este assert seguiria verde afirmando "exatamente duas escritas" —
  // protecao que morre sem ninguem perceber. Agora o conjunto e de
  // VERBOS: toda funcao com `method:` e uma escrita, e cada uma tem de
  // bater com o verbo que lhe foi autorizado, nominalmente.
  const VERBOS_AUTORIZADOS: Readonly<Record<string, string>> = {
    criarAgenteViaApi: "POST",
    enviarMensagemAoAgente: "POST",
    atualizarAgenteViaApi: "PATCH",
  };
  const ESCRITAS_AUTORIZADAS = Object.keys(VERBOS_AUTORIZADOS);
  const verboDaFuncao = (nome: string): string | null =>
    /method:\s*"([A-Z]+)"/.exec(corpoDaFuncao(nome))?.[1] ?? null;

  const escritasReais = [...CODIGO_TRANSPORTE.matchAll(/export async function (\w+)\(/g)]
    .map((m) => m[1])
    .filter((nome) => verboDaFuncao(nome) !== null)
    .sort();
  const esperadas = JSON.stringify([...ESCRITAS_AUTORIZADAS].sort());

  /** O par funcao=verbo, que e o que de fato esta sendo protegido: o
   *  conjunto sozinho passaria se `atualizarAgenteViaApi` virasse PUT. */
  const pares = (mapa: Readonly<Record<string, string>>): string =>
    JSON.stringify(Object.keys(mapa).sort().map((n) => `${n}=${mapa[n]}`));
  const paresReais = JSON.stringify(escritasReais.map((n) => `${n}=${verboDaFuncao(n)}`));

  ok("B5b as escritas publicadas sao EXATAMENTE as tres nominais",
    JSON.stringify(escritasReais) === esperadas, escritasReais.join(", ") || "nenhuma");
  ok("B5b0 cada escrita usa EXATAMENTE o verbo autorizado para ela",
    paresReais === pares(VERBOS_AUTORIZADOS),
    escritasReais.map((n) => `${n}=${verboDaFuncao(n)}`).join(", ") || "nenhuma");
  ok("B5b1 cada escrita leva o seu verbo e corpo JSON",
    ESCRITAS_AUTORIZADAS.every(
      (f) =>
        verboDaFuncao(f) === VERBOS_AUTORIZADOS[f] &&
        /body: JSON\.stringify/.test(corpoDaFuncao(f))));
  ok("B5b2 o transporte tem exatamente tres method e tres body",
    (CODIGO_TRANSPORTE.match(/method\s*:/g) ?? []).length === 3 &&
      (CODIGO_TRANSPORTE.match(/body\s*:/g) ?? []).length === 3);
  ok("B5b3 a escrita de conversa vai para a rota de conversa, com corpo so de mensagem",
    /ROTA_SUFIXO_CONVERSA/.test(CODIGO_TRANSPORTE) &&
      /body: JSON\.stringify\(\{ mensagem \}\)/.test(corpoDaFuncao("enviarMensagemAoAgente")));
  // A edicao monta o corpo CHAVE A CHAVE, e nunca serializa o objeto
  // recebido: `JSON.stringify(alteracao)` deixaria uma chave nova do
  // formulario viajar sozinha para o servidor.
  ok("B5b3a a edicao monta o corpo chave a chave, sem serializar o argumento",
    /body: JSON\.stringify\(corpoEnviado\)/.test(corpoDaFuncao("atualizarAgenteViaApi")) &&
      !/JSON\.stringify\(alteracao\)/.test(CODIGO_TRANSPORTE));
  ok("B5b3b e o corpo da edicao so pode ganhar `nome` e `instrucoes`",
    /corpoEnviado\.nome = /.test(corpoDaFuncao("atualizarAgenteViaApi")) &&
      /corpoEnviado\.instrucoes = /.test(corpoDaFuncao("atualizarAgenteViaApi")) &&
      !/corpoEnviado\.(ativo|tipo|id|user_id|criado_em)/.test(CODIGO_TRANSPORTE));
  ok("B5b4 CONTROLE NEGATIVO: sumir a criacao de AGENTE reprovaria",
    JSON.stringify(["atualizarAgenteViaApi", "enviarMensagemAoAgente"].sort()) !== esperadas);
  ok("B5b5 CONTROLE NEGATIVO: sumir a criacao de CONVERSA reprovaria",
    JSON.stringify(["atualizarAgenteViaApi", "criarAgenteViaApi"].sort()) !== esperadas);
  ok("B5b5a CONTROLE NEGATIVO: sumir a EDICAO reprovaria",
    JSON.stringify(["criarAgenteViaApi", "enviarMensagemAoAgente"].sort()) !== esperadas);
  ok("B5b6 CONTROLE NEGATIVO: uma QUARTA escrita reprovaria",
    JSON.stringify([...ESCRITAS_AUTORIZADAS, "apagarAgenteViaApi"].sort()) !== esperadas);
  ok("B5b7 CONTROLE NEGATIVO: TROCA mantendo o total de tres reprovaria",
    JSON.stringify(
      ["criarAgenteViaApi", "enviarMensagemAoAgente", "outraEscritaQualquer"].sort()
    ) !== esperadas);
  // Os tres desvios de VERBO, que a igualdade de conjunto sozinha nao
  // pegaria: o conjunto de nomes continuaria identico nos tres casos.
  ok("B5b7a CONTROLE NEGATIVO: PATCH virar PUT reprovaria",
    pares({ ...VERBOS_AUTORIZADOS, atualizarAgenteViaApi: "PUT" }) !==
      pares(VERBOS_AUTORIZADOS));
  ok("B5b7b CONTROLE NEGATIVO: PATCH virar POST reprovaria",
    pares({ ...VERBOS_AUTORIZADOS, atualizarAgenteViaApi: "POST" }) !==
      pares(VERBOS_AUTORIZADOS));
  ok("B5b7c CONTROLE NEGATIVO: MOVER o PATCH para outra funcao reprovaria",
    pares({
      criarAgenteViaApi: "PATCH",
      enviarMensagemAoAgente: "POST",
      atualizarAgenteViaApi: "POST",
    }) !== pares(VERBOS_AUTORIZADOS));
  ok("B5b8 ANCORA: a varredura enxergou funcoes de verdade",
    escritasReais.length === 3 && corpoDaFuncao("criarAgenteViaApi").length > 50);
  ok("B5b8a ANCORA: a sonda de verbo le verbo de verdade",
    verboDaFuncao("atualizarAgenteViaApi") === "PATCH" &&
      verboDaFuncao("listarAgentes") === null);
  ok("B5c e nenhum outro arquivo da area escreve",
    AREA.filter((a) => /method\s*:\s*"(POST|PUT|PATCH|DELETE)"/.test(codigo(ler(a)))).join(",") ===
      TRANSPORTE);
  ok("B6  o agenteId vai escapado no caminho",
    /encodeURIComponent\(agenteId\)/.test(CODIGO_TRANSPORTE));
  // A SKILL-1D.agent-create-ui-B trouxe a criacao visual, e com ela o
  // primeiro POST legitimo da area. A exigencia nao afrouxa: deixa de
  // ser "zero POST" e passa a ser "EXATAMENTE este arquivo", por
  // igualdade de conjunto e caminho nominal — um componente que ganhe
  // POST proprio reprova, e o transporte perder o POST tambem.
  const COM_POST_AUTORIZADO = ["lib/ia/agentes-http.ts"];
  const comPost = AREA.filter((a) => /"POST"|method:\s*"POST"/.test(codigo(ler(a))));
  ok("B7  POST existe SO no transporte nominal",
    JSON.stringify(comPost.slice().sort()) === JSON.stringify(COM_POST_AUTORIZADO),
    comPost.join(", ") || "nenhum");
  // ── B7b reconciliado na EDITAR-AGENTE-V1 ────────────────────────
  //
  // ANTES: duas capacidades, ambas de CRIACAO, e a frase "esta area
  // cria, nunca altera nem apaga" vetando PUT, PATCH e DELETE em bloco.
  //
  // A revogacao foi ratificada e e PARCIAL, e e importante registrar
  // ate onde ela vai. ALTERAR entrou: uma funcao, um recurso, dois
  // campos, por PATCH. SUBSTITUIR e APAGAR continuam fora — PUT
  // reabriria por omissao os campos que o corpo da edicao fecha, e
  // apagar agente e frente propria, com tarefas, aprovacoes e auditoria
  // penduradas nele. O veto nao foi afrouxado; foi reduzido ao que
  // continua verdadeiro.
  ok("B7b duas criacoes por POST, uma edicao por PATCH — e nada alem",
    (CODIGO_TRANSPORTE.match(/method:\s*"POST"/g) ?? []).length === 2 &&
      (CODIGO_TRANSPORTE.match(/method:\s*"PATCH"/g) ?? []).length === 1 &&
      /export async function criarAgenteViaApi\(/.test(CODIGO_TRANSPORTE) &&
      /export async function enviarMensagemAoAgente\(/.test(CODIGO_TRANSPORTE) &&
      /export async function atualizarAgenteViaApi\(/.test(CODIGO_TRANSPORTE) &&
      !/"PUT"|"DELETE"/.test(CODIGO_TRANSPORTE));
  ok("B7c PUT e DELETE continuam vetados em TODA a area, nao so no transporte",
    AREA.filter((a) => /"PUT"|"DELETE"/.test(codigo(ler(a)))).length === 0,
    AREA.filter((a) => /"PUT"|"DELETE"/.test(codigo(ler(a)))).join(", ") || "nenhum");
  ok("B7d CONTROLE NEGATIVO: a sonda de PUT/DELETE acusa quando o padrao existe",
    /"PUT"|"DELETE"/.test('method: "PUT"') && /"PUT"|"DELETE"/.test('method: "DELETE"'));
  ok("B7e o PATCH mora SO no transporte nominal",
    AREA.filter((a) => /"PATCH"/.test(codigo(ler(a)))).join(",") === TRANSPORTE,
    AREA.filter((a) => /"PATCH"/.test(codigo(ler(a)))).join(", ") || "nenhum");
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

  // ─── G. A EDICAO — EDITAR-AGENTE-V1 ─────────────────────────────────

  secao("G. atualizarAgenteViaApi — cada resposta no seu lugar");

  const { atualizarAgenteViaApi } = await import("../lib/ia/agentes-http");
  const corpoEnviado = (): Record<string, unknown> =>
    JSON.parse(String(chamadas[0]?.init?.body ?? "{}"));

  responde(200, { ok: true, agente: agente(UUID_A, { nome: "Depois" }) });
  const gOk = await atualizarAgenteViaApi(UUID_A, { nome: "Depois" });
  ok("G1  200 -> ok, com a linha do servidor",
    gOk.estado === "ok" && gOk.agente.nome === "Depois", JSON.stringify(gOk));
  ok("G2  metodo PATCH", chamadas[0]?.init?.method === "PATCH", String(chamadas[0]?.init?.method));
  ok("G3  endereco e o do recurso, com o id escapado",
    chamadas[0]?.url === `/api/agentes/${UUID_A}`, String(chamadas[0]?.url));
  ok("G4  o unico cabecalho e o do corpo JSON",
    JSON.stringify(chamadas[0]?.init?.headers) ===
      JSON.stringify({ "Content-Type": "application/json" }),
    JSON.stringify(chamadas[0]?.init?.headers));
  ok("G5  zero sinal de cancelamento numa escrita",
    chamadas[0]?.init?.signal === undefined);
  ok("G6  o corpo leva SO a chave pedida",
    JSON.stringify(Object.keys(corpoEnviado()).sort()) === JSON.stringify(["nome"]),
    JSON.stringify(corpoEnviado()));

  responde(200, { ok: true, agente: agente(UUID_A, { instrucoes: null }) });
  const gLimpa = await atualizarAgenteViaApi(UUID_A, { instrucoes: null });
  ok("G7  `instrucoes: null` VIAJA — limpar e pedido explicito",
    gLimpa.estado === "ok" && corpoEnviado().instrucoes === null &&
      JSON.stringify(Object.keys(corpoEnviado()).sort()) === JSON.stringify(["instrucoes"]),
    JSON.stringify(corpoEnviado()));

  responde(200, { ok: true, agente: agente(UUID_A) });
  await atualizarAgenteViaApi(UUID_A, { nome: "N", instrucoes: "I" });
  ok("G8  os dois campos juntos viajam, e SO eles",
    JSON.stringify(Object.keys(corpoEnviado()).sort()) ===
      JSON.stringify(["instrucoes", "nome"]),
    JSON.stringify(corpoEnviado()));

  responde(400, { ok: false, erro: "nome inválido." });
  const gNome = await atualizarAgenteViaApi(UUID_A, { nome: "  " });
  ok("G9  400 conhecido -> dados_invalidos com a frase do servidor",
    gNome.estado === "dados_invalidos" && gNome.mensagem === "nome inválido.",
    JSON.stringify(gNome));

  // A frase que descreve um DEFEITO NOSSO nao chega ao usuario: ele nao
  // tem como consertar um corpo que a propria tela montou.
  responde(400, { ok: false, erro: "Alteração inválida." });
  const gGenerico = await atualizarAgenteViaApi(UUID_A, { nome: "N" });
  ok("G10 400 desconhecido -> frase generica, nunca o texto cru",
    gGenerico.estado === "dados_invalidos" &&
      gGenerico.mensagem === "Não foi possível salvar essas alterações.",
    JSON.stringify(gGenerico));

  responde(401, { ok: false, erro: "Não autenticado." });
  ok("G11 401 -> sessao expirada, nunca falha generica",
    (await atualizarAgenteViaApi(UUID_A, { nome: "N" })).estado === "nao_autenticado");

  responde(404, { ok: false, erro: "Agente não encontrado." });
  ok("G12 404 -> nao_encontrado, estado proprio",
    (await atualizarAgenteViaApi(UUID_A, { nome: "N" })).estado === "nao_encontrado");

  responde(500, { ok: false, erro: "Falha ao atualizar o agente." });
  ok("G13 500 -> falha", (await atualizarAgenteViaApi(UUID_A, { nome: "N" })).estado === "falha");

  proxima = "erro";
  chamadas = [];
  ok("G14 rede caida -> falha, nunca sucesso silencioso",
    (await atualizarAgenteViaApi(UUID_A, { nome: "N" })).estado === "falha");

  responde(200, { ok: true, agente: agente(UUID_A, { ativo: "sim" }) });
  ok("G15 200 com agente MALFORMADO -> falha, nunca linha meio montada",
    (await atualizarAgenteViaApi(UUID_A, { nome: "N" })).estado === "falha");

  responde(200, "ilegivel");
  ok("G16 200 com corpo ilegivel -> falha",
    (await atualizarAgenteViaApi(UUID_A, { nome: "N" })).estado === "falha");

  responde(200, { ok: true });
  ok("G17 200 sem `agente` -> falha",
    (await atualizarAgenteViaApi(UUID_A, { nome: "N" })).estado === "falha");

  globalThis.fetch = fetchOriginal;

  // ─── H. A tela de edicao ────────────────────────────────────────────

  secao("H. EditarAgente — o que a tela faz, e o que ela nao faz");

  {
    const EDITAR = "components/ia/agente/EditarAgente.tsx";
    const CODIGO_EDITAR = codigo(ler(EDITAR));
    const CODIGO_CONTAINER = codigo(ler(CONTAINER));

    ok("H1  a tela existe e e Client Component",
      AREA.includes(EDITAR) && /^"use client"/m.test(ler(EDITAR)));
    ok("H2  exporta default", /export default function EditarAgente\(/.test(CODIGO_EDITAR));
    ok("H3  zero rede propria: ela usa o transporte nominal",
      !/\bfetch\s*\(/.test(CODIGO_EDITAR) && !/["'`]\/api\//.test(CODIGO_EDITAR) &&
        /atualizarAgenteViaApi/.test(CODIGO_EDITAR) &&
        /from "@\/lib\/ia\/agentes-http"/.test(CODIGO_EDITAR));
    ok("H4  zero ambiente, zero banco, zero dominio do servidor",
      !/process\.env|getSupabaseServidor|createClient|lib\/agentes/.test(CODIGO_EDITAR));
    ok("H5  botao de verdade para abrir, com rotulo acessivel",
      /<button[\s\S]{0,200}onClick=\{abrir\}/.test(CODIGO_EDITAR) &&
        /aria-label=\{`Editar nome e instruções de \$\{agente\.nome\}`\}/.test(CODIGO_EDITAR));
    ok("H6  nenhum <div>/<span> fingindo botao",
      !/<span[^>]*onClick/.test(CODIGO_EDITAR) && !/<div[^>]*onClick/.test(CODIGO_EDITAR));
    ok("H7  os campos partem do valor PERSISTIDO, nao de um rascunho antigo",
      /setNome\(agente\.nome\)/.test(CODIGO_EDITAR) &&
        /setInstrucoes\(agente\.instrucoes \?\? ""\)/.test(CODIGO_EDITAR));
    // Cancelar nao pode ter caminho ate a rede: nao chama o transporte e
    // nao avisa o pai. A prova e por AUSENCIA dentro do proprio handler.
    const corpoCancelar = CODIGO_EDITAR.slice(
      CODIGO_EDITAR.indexOf("function cancelar()"),
      CODIGO_EDITAR.indexOf("const nomeValido")
    );
    ok("H8  Cancelar nao escreve e nao avisa o pai",
      corpoCancelar.length > 30 &&
        !/atualizarAgenteViaApi|onAtualizado/.test(corpoCancelar),
      corpoCancelar.slice(0, 80));
    ok("H9  envio duplo fechado em DOIS niveis: disabled E o ref",
      /disabled=\{salvando \|\| !nomeValido\}/.test(CODIGO_EDITAR) &&
        /if \(salvandoRef\.current \|\| !nomeValido\) return;/.test(CODIGO_EDITAR));
    // O ponto central da fase: a tela NAO afirma o que digitou.
    ok("H10 o sucesso usa a LINHA DO SERVIDOR, nunca o rascunho",
      /onAtualizado\(resultado\.agente\)/.test(CODIGO_EDITAR) &&
        !/onAtualizado\(\{/.test(CODIGO_EDITAR) &&
        !/onAtualizado\(nome/.test(CODIGO_EDITAR));
    ok("H11 o erro NAO fecha o formulario nem limpa o que foi digitado",
      !/setEditando\(false\)[\s\S]{0,80}setErro\(resultado/.test(CODIGO_EDITAR) &&
        (CODIGO_EDITAR.match(/setEditando\(false\)/g) ?? []).length === 2 &&
        !/setNome\(""\)|setInstrucoes\(""\)/.test(CODIGO_EDITAR));
    ok("H12 os quatro desfechos da escrita tem tratamento proprio",
      ["dados_invalidos", "nao_autenticado", "nao_encontrado"].every((e) =>
        CODIGO_EDITAR.includes(`resultado.estado === "${e}"`)) &&
        /resultado\.estado === "ok"/.test(CODIGO_EDITAR));
    ok("H13 a tela nao alcanca `ativo` nem `tipo`",
      !/\bativo\b|\btipo\b/.test(CODIGO_EDITAR));
    ok("H14 nada de HTML cru",
      !/dangerouslySetInnerHTML/.test(CODIGO_EDITAR));

    ok("H15 o container monta a edicao pelo especificador com @/",
      /from "@\/components\/ia\/agente\/EditarAgente"/.test(CODIGO_CONTAINER) &&
        /<EditarAgente agente=\{agente\} onAtualizado=\{aoAtualizarAgente\}/.test(CODIGO_CONTAINER));
    // UMA verdade sobre o agente. Um segundo estado com a linha editada
    // divergiria da lista no primeiro refetch.
    ok("H16 o container troca a linha DENTRO da lista, sem segundo estado",
      /setLista\(\(atual\) =>/.test(CODIGO_CONTAINER) &&
        /a\.id === atualizado\.id \? atualizado : a/.test(CODIGO_CONTAINER) &&
        !/setAgente\(|useState<AgenteUI/.test(CODIGO_CONTAINER));
    ok("H17 e a VisaoGeral continua recebendo o agente da lista",
      /<VisaoGeral agente=\{agente\}/.test(CODIGO_CONTAINER));
    ok("H18 ANCORA: as duas fontes foram lidas de verdade",
      CODIGO_EDITAR.length > 1500 && CODIGO_CONTAINER.length > 1500);
  }

  console.log(`\n══ ${passou} PASS / ${falhou} FAIL ══\n`);
  process.exitCode = falhou === 0 ? 0 : 1;
}

principal().catch((e) => {
  globalThis.fetch = fetchOriginal;
  console.log(`  FAIL  excecao nao tratada — ${String(e).slice(0, 300)}`);
  process.exitCode = 1;
});
