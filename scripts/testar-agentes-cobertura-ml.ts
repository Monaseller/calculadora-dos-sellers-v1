/**
 * CDS IA — M2-I1-A3. Cobertura remota do Mercado Livre.
 *
 * ── O que esta suite prova, e o que ela nao prova ───────────────────
 *
 * Prova a regra de confirmacao, a matriz de falha, o orcamento de rede e
 * o isolamento entre lojas e donos. NAO prova que a resposta real do
 * Mercado Livre tem a forma esperada: o M2-A3 mediu 403 na documentacao
 * e nenhum gate autorizou chamada viva. Por isso o parser e fail-closed e
 * toda forma desconhecida vira `nao_verificavel`.
 *
 * ── Zero rede, zero banco ───────────────────────────────────────────
 *
 * `fetch` e a resolucao de credencial entram por PORTAS injetaveis.
 * Nenhum token real e lido, nenhum host externo e tocado, nada e gravado.
 *
 * Rodar:  npx tsx scripts/testar-agentes-cobertura-ml.ts
 */
import "./_server-only-inerte";

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

const CODIGO_CONCESSOES = semComentarios(ler("lib/mercado-livre-concessoes.ts"));
const CODIGO_COBERTURA = semComentarios(ler("lib/agentes/conexoes/cobertura-remota.ts"));
const CODIGO_ESTADO = semComentarios(ler("lib/agentes/conexoes/estado.ts"));
const CODIGO_GUARD = semComentarios(ler("lib/agentes/funcoes/guard.ts"));

// ─── Fixtures ─────────────────────────────────────────────────────────

const USER = "user-sintetico-a3";
const LOJA_A = "eeeeeeee-0000-4000-8000-00000000000a";
const LOJA_B = "eeeeeeee-0000-4000-8000-00000000000b";
const SELLER = "123456789";
const TOKEN = "token-sintetico-nunca-deve-vazar";
const APP_ID = "2563942078878801";

const REQ_PERGUNTAS = { plataforma: "mercado_livre", recurso: "perguntas" };
const fato = (plataforma: string, recurso: string, cobertura = "nao_verificavel") =>
  ({ plataforma, recurso, estado: "conectada", cobertura }) as never;

type Credencial = { accessToken: string; sellerId: string } | null;
const credOk = async (): Promise<Credencial> => ({ accessToken: TOKEN, sellerId: SELLER });
const credSemToken = async (): Promise<Credencial> => null;
const credSemSeller = async (): Promise<Credencial> => ({ accessToken: TOKEN, sellerId: "" });
const credQueLanca = async (): Promise<Credencial> => {
  throw new Error("refresh falhou: invalid_grant");
};

let requisicoes: { url: string; init?: RequestInit }[] = [];
const rede = (status: number, corpo: unknown, opcoes: { json?: boolean } = {}) =>
  (async (url: string | URL | Request, init?: RequestInit) => {
    requisicoes.push({ url: String(url), init });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => {
        if (opcoes.json === false) throw new Error("corpo nao e json");
        return corpo;
      },
    } as unknown as Response;
  }) as unknown as typeof fetch;

const redeQueCai = (async () => {
  throw new Error("ETIMEDOUT");
}) as unknown as typeof fetch;

const grantBom = { applications: [{ app_id: APP_ID, scopes: ["read", "write"] }] };

const portas = (buscar: typeof fetch, resolverCredencial = credOk) =>
  ({ buscar, resolverCredencial });

console.log("\n══ CDS IA — M2-I1-A3: cobertura remota do Mercado Livre ══");

// ─── A. Fronteiras estaticas ──────────────────────────────────────────

secao("A. Quem ve token, e quem nunca ve");

ok("A1  o network owner e server-only", /import "server-only"/.test(CODIGO_CONCESSOES));
ok("A2  e e o UNICO dos dois que resolve credencial",
  /getMLLojaById/.test(CODIGO_CONCESSOES) &&
    !/getMLLojaById|accessToken|access_token/.test(CODIGO_COBERTURA));
ok("A3  so ele tem rede",
  /buscar\(/.test(CODIGO_CONCESSOES) && !/fetch\s*\(|buscar\(/.test(CODIGO_COBERTURA));
ok("A4  nenhum dos dois escreve em banco",
  !/\.(insert|update|upsert|delete|rpc)\(/.test(CODIGO_CONCESSOES) &&
    !/\.(insert|update|upsert|delete|rpc)\(/.test(CODIGO_COBERTURA));
ok("A5  zero metodo de escrita HTTP",
  !/method:\s*"(POST|PUT|PATCH|DELETE)"/i.test(CODIGO_CONCESSOES));
ok("A6  o endereco e literal do modulo, nunca do chamador",
  /const BASE_ML = "https:\/\/api\.mercadolibre\.com"/.test(CODIGO_CONCESSOES) &&
    !/baseUrl|endpoint\?/.test(CODIGO_CONCESSOES));
ok("A7  zero retry", !/withRetry|retry|tentativas/i.test(CODIGO_CONCESSOES));
ok("A8  zero cache global",
  !/new Map\(\)/.test(CODIGO_CONCESSOES) &&
    (CODIGO_COBERTURA.match(/new Map</g) ?? []).length === 1);
ok("A9  `estado.ts` NAO foi tocado: cobertura segue constante",
  /export function coberturaDoRecurso\(_recurso: string\): CoberturaRecurso \{\s*return "nao_verificavel";/s
    .test(CODIGO_ESTADO));
ok("A10 `guard.ts` NAO foi afrouxado",
  /fato\.estado === "conectada" && fato\.cobertura === "confirmada"/.test(CODIGO_GUARD));
ok("A11 o HARD BOUND de leitura esta em CODIGO, nao em comentario",
  /if \(acesso !== "leitura"\) return recusa\("configuracao_ausente"\);/.test(CODIGO_CONCESSOES));
ok("A12 e a evidencia humana carrega procedencia",
  /verificadoEm: "2026-09-18"/.test(CODIGO_CONCESSOES) &&
    /appIdVerificado: "2563942078878801"/.test(CODIGO_CONCESSOES));
ok("A13 o coverage owner nao decide permissao nem nivel",
  !/nivel|permissao|automatico|aprovacao|bloqueado/i.test(
    CODIGO_COBERTURA.replace(/acesso/g, "")));
ok("A14 CONTROLE: as sondas acham os padroes quando existem",
  /\.insert\(/.test("q.insert({})") && /method:\s*"POST"/i.test('method: "POST"'));

// ─── B–H. Comportamento ───────────────────────────────────────────────

async function principal(): Promise<void> {
  const anterior = process.env.ML_CLIENT_ID;
  process.env.ML_CLIENT_ID = APP_ID;

  const { confirmarCoberturaML } = await import("../lib/mercado-livre-concessoes");
  const { confirmarCoberturaDosFatos } = await import("../lib/agentes/conexoes/cobertura-remota");

  const entradaLeitura = { userId: USER, lojaId: LOJA_A, acesso: "leitura" as const };
  const chamar = async (
    buscar: typeof fetch,
    cred = credOk,
    entrada = entradaLeitura
  ) => {
    requisicoes = [];
    return confirmarCoberturaML(entrada, portas(buscar, cred));
  };

  secao("B. COV-1 — o caminho feliz");

  const cov1 = await chamar(rede(200, grantBom));
  ok("COV-1  ML + token + app correto + read + permissao congelada -> confirmada",
    cov1.cobertura === "confirmada" && cov1.motivo === null, JSON.stringify(cov1));
  ok("COV-1a UMA chamada, nunca retry", requisicoes.length === 1, String(requisicoes.length));
  ok("COV-1b o endereco carrega o sellerId RESOLVIDO internamente",
    requisicoes[0]?.url === `https://api.mercadolibre.com/users/${SELLER}/applications`,
    requisicoes[0]?.url);
  ok("COV-1c o token viaja no header, e so nele",
    (requisicoes[0]?.init?.headers as Record<string, string>)?.Authorization ===
      `Bearer ${TOKEN}` && !requisicoes[0]!.url.includes(TOKEN));
  ok("COV-1d ha timeout declarado", requisicoes[0]?.init?.signal !== undefined);
  ok("COV-1e a lista tambem e aceita sem envelope",
    (await chamar(rede(200, [{ app_id: APP_ID, scopes: ["read"] }]))).cobertura === "confirmada");

  secao("C. COV-2..COV-4 — grant e configuracao");

  const cov2 = await chamar(rede(200, { applications: [{ app_id: "999", scopes: ["read"] }] }));
  ok("COV-2  app_id diferente -> nao_verificavel / grant_ausente",
    cov2.cobertura === "nao_verificavel" && cov2.motivo === "grant_ausente", JSON.stringify(cov2));
  ok("COV-2a app_id ausente -> grant_ausente",
    (await chamar(rede(200, { applications: [{ scopes: ["read"] }] }))).motivo === "grant_ausente");
  ok("COV-2b a comparacao NAO e por prefixo nem por `includes`",
    (await chamar(rede(200, { applications: [{ app_id: APP_ID + "0", scopes: ["read"] }] })))
      .motivo === "grant_ausente");
  ok("COV-2c app_id numerico equivalente AINDA confirma (String+trim)",
    (await chamar(rede(200, { applications: [{ app_id: Number(APP_ID), scopes: ["read"] }] })))
      .cobertura === "confirmada");

  const cov3 = await chamar(rede(200, { applications: [{ app_id: APP_ID, scopes: ["write"] }] }));
  ok("COV-3  sem `read` -> nao_verificavel / grant_ausente",
    cov3.cobertura === "nao_verificavel" && cov3.motivo === "grant_ausente", JSON.stringify(cov3));
  ok("COV-3a `scopes` ausente -> grant_ausente",
    (await chamar(rede(200, { applications: [{ app_id: APP_ID }] }))).motivo === "grant_ausente");
  ok("COV-3b `scopes` como STRING nao e adaptada — resposta_invalida",
    (await chamar(rede(200, { applications: [{ app_id: APP_ID, scopes: "read write" }] })))
      .motivo === "resposta_invalida");
  ok("COV-3c array misto nao passa",
    (await chamar(rede(200, { applications: [{ app_id: APP_ID, scopes: ["read", 7] }] })))
      .motivo === "resposta_invalida");

  process.env.ML_CLIENT_ID = "";
  requisicoes = [];
  const semApp = await confirmarCoberturaML(entradaLeitura, portas(rede(200, grantBom)));
  ok("COV-4  ML_CLIENT_ID ausente -> configuracao_ausente, ZERO rede",
    semApp.motivo === "configuracao_ausente" && requisicoes.length === 0,
    `${semApp.motivo} / ${requisicoes.length}`);
  process.env.ML_CLIENT_ID = APP_ID;

  secao("D. COV-5..COV-6 — credencial");

  requisicoes = [];
  const cov5 = await confirmarCoberturaML(entradaLeitura, portas(rede(200, grantBom), credSemToken));
  ok("COV-5  token ausente -> credencial_ausente, ZERO rede",
    cov5.motivo === "credencial_ausente" && requisicoes.length === 0,
    `${cov5.motivo} / ${requisicoes.length}`);

  requisicoes = [];
  const semSeller = await confirmarCoberturaML(entradaLeitura, portas(rede(200, grantBom), credSemSeller));
  ok("COV-5a sellerId vazio -> credencial_ausente, ZERO rede",
    semSeller.motivo === "credencial_ausente" && requisicoes.length === 0);

  const cov6 = await chamar(rede(200, grantBom), credQueLanca);
  ok("COV-6  refresh que lanca -> indisponivel, sem segundo mecanismo",
    cov6.cobertura === "nao_verificavel" && cov6.motivo === "indisponivel", JSON.stringify(cov6));

  secao("E. COV-7..COV-10 — a matriz de falha remota");

  const matriz: [string, number | "rede" | "json", string][] = [
    ["COV-7  401 -> nao_autorizado", 401, "nao_autorizado"],
    ["COV-7a 403 -> nao_autorizado (ambiguo demais para diagnostico proprio)", 403, "nao_autorizado"],
    ["COV-7b 404 -> nao_autorizado", 404, "nao_autorizado"],
    ["COV-8  429 -> limite_excedido", 429, "limite_excedido"],
    ["COV-9  500 -> indisponivel", 500, "indisponivel"],
    ["COV-9a rede caiu/timeout -> indisponivel", "rede", "indisponivel"],
    ["COV-10 corpo nao-json -> resposta_invalida", "json", "resposta_invalida"],
  ];
  for (const [nome, caso, esperado] of matriz) {
    const r = await chamar(
      caso === "rede" ? redeQueCai
        : caso === "json" ? rede(200, {}, { json: false })
        : rede(caso, { message: "erro do provider" })
    );
    ok(nome, r.cobertura === "nao_verificavel" && r.motivo === esperado, String(r.motivo));
  }
  ok("COV-10a corpo sem lista -> resposta_invalida",
    (await chamar(rede(200, { qualquer: "coisa" }))).motivo === "resposta_invalida");
  ok("COV-10b corpo que e string -> resposta_invalida",
    (await chamar(rede(200, "ok"))).motivo === "resposta_invalida");

  secao("F. COV-11 — zero segredo, zero erro cru");

  const corpoMalicioso = {
    applications: [{ app_id: "999", scopes: ["read"], access_token: TOKEN }],
    message: `invalid token ${TOKEN}`,
    hint: "column lojas.access_token",
    stack: "Error: at fetch (/lib/ml-auth.ts:164)",
  };
  const cov11 = await chamar(rede(401, corpoMalicioso));
  const serializado = JSON.stringify(cov11);
  ok("COV-11  nenhum token no resultado", !serializado.includes(TOKEN), serializado);
  ok("COV-11a nenhum corpo nem mensagem do provider",
    !/invalid token|message|hint|stack|column/i.test(serializado), serializado);
  ok("COV-11b nenhum status HTTP no resultado",
    !/401|403|429|500/.test(serializado), serializado);
  ok("COV-11c o resultado tem EXATAMENTE dois campos",
    JSON.stringify(Object.keys(cov11).sort()) === JSON.stringify(["cobertura", "motivo"]));

  secao("G. COV-16 — o HARD BOUND de leitura");

  requisicoes = [];
  const cov16 = await confirmarCoberturaML(
    { userId: USER, lojaId: LOJA_A, acesso: "escrita" },
    portas(rede(200, grantBom))
  );
  ok("COV-16  acesso `escrita` NUNCA confirma, com todo o resto valido",
    cov16.cobertura === "nao_verificavel" && cov16.motivo === "configuracao_ausente",
    JSON.stringify(cov16));
  ok("COV-16a e nem paga rede para descobrir isso", requisicoes.length === 0);
  ok("COV-16b ANTI-VACUIDADE: o MESMO cenario em leitura confirma",
    (await chamar(rede(200, grantBom))).cobertura === "confirmada");

  // ─── H. O dono do ESTADO ───────────────────────────────────────────

  secao("H. COV-12/17 — elevacao do fato, isolamento e orcamento");

  const base = {
    userId: USER,
    requisito: REQ_PERGUNTAS,
    lojaId: LOJA_A,
    acesso: "leitura" as const,
  };

  requisicoes = [];
  const um = await confirmarCoberturaDosFatos(
    { ...base, conexoes: [fato("mercado_livre", "perguntas")] },
    portas(rede(200, grantBom))
  );
  ok("H1  o fato do requisito e elevado a `confirmada`",
    um.conexoes[0]?.cobertura === "confirmada" && um.motivo === null,
    JSON.stringify(um.conexoes));
  ok("H2  UMA chamada de grant", um.chamadasRemotas === 1 && requisicoes.length === 1);
  ok("H3  `estado` e o par saem intactos",
    um.conexoes[0]?.estado === "conectada" &&
      um.conexoes[0]?.plataforma === "mercado_livre" &&
      um.conexoes[0]?.recurso === "perguntas");

  // COV-12: outro recurso da MESMA plataforma nao herda a prova.
  requisicoes = [];
  const misto = await confirmarCoberturaDosFatos(
    {
      ...base,
      conexoes: [
        fato("mercado_livre", "perguntas"),
        fato("mercado_livre", "ads"),
        fato("shopee", "chat"),
      ],
    },
    portas(rede(200, grantBom))
  );
  ok("COV-12  so o fato do requisito muda",
    misto.conexoes[0]?.cobertura === "confirmada" &&
      misto.conexoes[1]?.cobertura === "nao_verificavel" &&
      misto.conexoes[2]?.cobertura === "nao_verificavel",
    JSON.stringify(misto.conexoes.map((c) => c.cobertura)));
  ok("COV-12a e continua sendo UMA chamada", misto.chamadasRemotas === 1);

  // COV-12b: a prova e por (plataforma, recurso, lojaId) — loja diferente
  // resolve seu proprio grant, e o veredito de uma nao vale para a outra.
  requisicoes = [];
  const recusaLojaB = await confirmarCoberturaDosFatos(
    { ...base, lojaId: LOJA_B, conexoes: [fato("mercado_livre", "perguntas")] },
    portas(rede(200, { applications: [{ app_id: "999", scopes: ["read"] }] }))
  );
  ok("COV-12b loja B com grant de outro app nao e elevada",
    recusaLojaB.conexoes[0]?.cobertura === "nao_verificavel" &&
      recusaLojaB.motivo === "grant_ausente");
  ok("COV-12c e nada da loja A sobreviveu entre as chamadas — zero cache global",
    requisicoes.length === 1);

  // COV-17: cinco fatos ML da MESMA loja -> 1 grant.
  requisicoes = [];
  const cinco = await confirmarCoberturaDosFatos(
    {
      ...base,
      conexoes: [
        fato("mercado_livre", "perguntas"),
        fato("mercado_livre", "ads"),
        fato("mercado_livre", "mensagens"),
        fato("mercado_livre", "pedidos"),
        fato("shopee", "chat"),
      ],
    },
    portas(rede(200, grantBom))
  );
  ok("COV-17  cinco requisitos, mesma loja -> UMA chamada de grant",
    cinco.chamadasRemotas === 1 && requisicoes.length === 1,
    `${cinco.chamadasRemotas} / ${requisicoes.length}`);
  ok("COV-17a e apenas o requisito EM EXECUCAO foi elevado",
    cinco.conexoes.filter((c) => c.cobertura === "confirmada").length === 1 &&
      cinco.conexoes[0]?.cobertura === "confirmada",
    JSON.stringify(cinco.conexoes.map((c) => c.cobertura)));

  // Sem fato para o requisito: nada a elevar, e nada a perguntar.
  requisicoes = [];
  const semFato = await confirmarCoberturaDosFatos(
    { ...base, conexoes: [fato("shopee", "chat")] },
    portas(rede(200, grantBom))
  );
  ok("H4  requisito sem fato -> ZERO rede", requisicoes.length === 0 &&
    semFato.chamadasRemotas === 0);
  ok("H5  e as conexoes saem intactas", semFato.conexoes[0]?.cobertura === "nao_verificavel");

  requisicoes = [];
  const semLoja = await confirmarCoberturaDosFatos(
    { ...base, lojaId: "", conexoes: [fato("mercado_livre", "perguntas")] },
    portas(rede(200, grantBom))
  );
  ok("H6  sem binding -> ZERO rede, credencial_ausente",
    requisicoes.length === 0 && semLoja.motivo === "credencial_ausente");

  requisicoes = [];
  const semConfirmador = await confirmarCoberturaDosFatos(
    {
      ...base,
      requisito: { plataforma: "shopee", recurso: "chat" },
      conexoes: [fato("shopee", "chat")],
    },
    portas(rede(200, grantBom))
  );
  ok("H7  plataforma SEM confirmador -> zero rede, fato intacto, sem motivo",
    requisicoes.length === 0 && semConfirmador.motivo === null &&
      semConfirmador.conexoes[0]?.cobertura === "nao_verificavel");

  process.env.ML_CLIENT_ID = anterior;

  console.log(`\n══ ${passou} PASS / ${falhou} FAIL ══\n`);
  process.exitCode = falhou === 0 ? 0 : 1;
}

principal().catch((e) => {
  console.log(`  FAIL  excecao nao tratada — ${String(e).slice(0, 300)}`);
  process.exitCode = 1;
});
