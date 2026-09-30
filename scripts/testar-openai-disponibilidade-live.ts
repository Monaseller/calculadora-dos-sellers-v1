/**
 * AGENT-FACTORY-F7b.4.2 — o estado real da OpenAI, classificado.
 *
 * ── O que esta suite prova, e o que ela NAO prova ───────────────────
 *
 * Ela prova que o CLASSIFICADOR separa os cinco problemas que "nao
 * configurado" juntava. Isso e verificavel hoje, sem saldo e sem custo:
 * as secoes A e B alimentam respostas sinteticas e conferem o veredito.
 *
 * Ela NAO prova que a OpenAI funciona. Nao pode: medido em 2026-09-30, a
 * chave autentica e toda inferencia responde 429
 * `credit_balance_exhausted`.
 *
 * ── Por que ela nao afirma o estado atual ───────────────────────────
 *
 * A secao C consulta a API de verdade e IMPRIME o estado. Ela nao assere
 * "billing_necessario", de proposito: uma suite que exigisse isso passaria
 * a FALHAR no dia em que alguem colocasse credito — exatamente o dia em
 * que tudo passou a funcionar. O que ela assere e o que continua verdade
 * nos dois mundos: que a chave autentica, e que o estado e um dos
 * conhecidos.
 *
 * Quando o saldo entrar, esta suite passa a imprimir `disponivel`, e e o
 * sinal de que o adaptador pode ser escrito e provado.
 *
 * Roda com: npx tsx scripts/testar-openai-disponibilidade-live.ts
 */
import "./_server-only-inerte";

import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  ACAO_POR_ESTADO, ESTADOS_DA_OPENAI, classificarRespostaDaOpenAI,
  diagnosticarOpenAI, type EstadoDaOpenAI,
} from "@/lib/ai-gateway/provedores/openai-disponibilidade";

let passou = 0;
let falhou = 0;

function valoresSensiveis(): string[] {
  const fora: string[] = [];
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === "string" && v.length >= 12 &&
        /KEY|SECRET|TOKEN|PASSWORD|SENHA|CREDENTIAL|DATABASE_URL|DIRECT_URL/i.test(k)) {
      fora.push(v);
    }
  }
  return fora;
}
function limpar(t: string): string {
  let s = t;
  for (const v of valoresSensiveis()) s = s.split(v).join("[REDIGIDO]");
  return s;
}
function log(t: string): void { console.log(limpar(t)); }
function ok(nome: string, cond: boolean, detalhe = ""): void {
  if (cond) { passou++; log(`  PASS  ${nome}`); }
  else { falhou++; log(`  FAIL  ${nome}${detalhe ? ` — ${detalhe}` : ""}`); }
}
function secao(t: string): void { log(`\n${t}`); }

function carregarEnvLocal(): boolean {
  for (const caminho of [
    join(__dirname, "..", ".env.local"),
    join("C:", "Users", "USER", "Desktop", "calculadora-dos-sellers-v1", ".env.local"),
  ]) {
    try {
      for (const linha of readFileSync(caminho, "utf-8").split("\n")) {
        const l = linha.trim();
        if (!l || l.startsWith("#")) continue;
        const i = l.indexOf("=");
        if (i <= 0) continue;
        const k = l.slice(0, i).trim();
        if (!process.env[k]) process.env[k] = l.slice(i + 1).trim().replace(/^["']|["']$/g, "");
      }
      return true;
    } catch { /* proximo */ }
  }
  return false;
}

/** Os corpos REAIS que a API devolve, abreviados. */
const CORPO_SEM_CREDITO =
  '{"error":{"message":"You have no credits remaining. Add credits to continue using the API at ' +
  'https://platform.openai.com/settings/organization/billing/.","type":"insufficient_quota",' +
  '"param":null,"code":"credit_balance_exhausted"}}';
const CORPO_CHAVE_INVALIDA =
  '{"error":{"message":"Incorrect API key provided.","type":"invalid_request_error",' +
  '"code":"invalid_api_key"}}';
const CORPO_RATE_LIMIT =
  '{"error":{"message":"Rate limit reached for gpt-5 in organization org-x on requests per min",' +
  '"type":"requests","code":"rate_limit_exceeded"}}';
const CORPO_SEM_MODELO =
  '{"error":{"message":"The model `gpt-9` does not exist or you do not have access to it.",' +
  '"type":"invalid_request_error","code":"model_not_found"}}';
const CORPO_SEM_PERMISSAO =
  '{"error":{"message":"Project does not have access to model","type":"invalid_request_error",' +
  '"code":"model_not_found"}}';
const CORPO_ROTA_ERRADA = '{"error":{"message":"Invalid URL (POST /v1/nada)"}}';

async function main(): Promise<void> {
  log("\n== CDS IA — AGENT-FACTORY-F7b.4.2: estado real da OpenAI ==");
  log(`env carregado: ${carregarEnvLocal() ? "sim" : "NAO"}`);

  // ─── A. O classificador separa os cinco problemas ──────────────────

  secao("A. Cinco problemas diferentes, cinco vereditos diferentes");
  {
    ok("A1  200 e `disponivel`",
      classificarRespostaDaOpenAI(200, "{}") === "disponivel");
    ok("A2  401 e problema de CHAVE",
      classificarRespostaDaOpenAI(401, CORPO_CHAVE_INVALIDA) === "auth_falhou");
    ok("A3  402 e problema de SALDO",
      classificarRespostaDaOpenAI(402, "{}") === "billing_necessario");

    // O caso que importa: 429 significa DUAS coisas opostas.
    ok("A4  429 com `insufficient_quota` e SALDO — nao rate limit",
      classificarRespostaDaOpenAI(429, CORPO_SEM_CREDITO) === "billing_necessario");
    ok("A5  429 de rate limit NAO e saldo",
      classificarRespostaDaOpenAI(429, CORPO_RATE_LIMIT) === "api_falhou");
    ok("A6  e os dois 429 dao vereditos DIFERENTES",
      classificarRespostaDaOpenAI(429, CORPO_SEM_CREDITO) !==
        classificarRespostaDaOpenAI(429, CORPO_RATE_LIMIT));

    ok("A7  403 e PERMISSAO",
      classificarRespostaDaOpenAI(403, CORPO_SEM_PERMISSAO) === "permissao_negada");

    // 404 tambem e ambiguo: modelo inexistente vs rota errada.
    ok("A8  404 falando de modelo e MODELO",
      classificarRespostaDaOpenAI(404, CORPO_SEM_MODELO) === "modelo_indisponivel");
    ok("A9  404 de rota errada NAO manda trocar de modelo",
      classificarRespostaDaOpenAI(404, CORPO_ROTA_ERRADA) === "api_falhou");
    ok("A10 e os dois 404 dao vereditos DIFERENTES",
      classificarRespostaDaOpenAI(404, CORPO_SEM_MODELO) !==
        classificarRespostaDaOpenAI(404, CORPO_ROTA_ERRADA));

    ok("A11 500 e falha de API",
      classificarRespostaDaOpenAI(500, "{}") === "api_falhou");
    ok("A12 todo veredito e um estado declarado",
      [200, 401, 402, 403, 404, 429, 500, 503].every((s) =>
        (ESTADOS_DA_OPENAI as readonly string[])
          .includes(classificarRespostaDaOpenAI(s, CORPO_SEM_CREDITO))));
  }

  // ─── B. Cada estado diz o que FAZER ────────────────────────────────

  secao("B. Um diagnostico que nao diz o que fazer nao serve");
  {
    const mortos = ESTADOS_DA_OPENAI.filter(
      (e) => (ACAO_POR_ESTADO[e] ?? "").trim().length < 10);
    ok("B1  TODO estado tem uma acao escrita", mortos.length === 0, mortos.join(","));
    ok("B2  e as acoes sao DIFERENTES entre si",
      new Set(ESTADOS_DA_OPENAI.map((e) => ACAO_POR_ESTADO[e])).size ===
        ESTADOS_DA_OPENAI.length);
    ok("B3  saldo manda por credito, e nao trocar a chave",
      /credito/i.test(ACAO_POR_ESTADO.billing_necessario) &&
        !/chave/i.test(ACAO_POR_ESTADO.billing_necessario));
    ok("B4  chave invalida manda trocar a chave, e nao por credito",
      /chave/i.test(ACAO_POR_ESTADO.auth_falhou) &&
        !/credito/i.test(ACAO_POR_ESTADO.auth_falhou));
  }

  // ─── C. O estado REAL, hoje ────────────────────────────────────────

  secao("C. O que esta chave alcanca agora (rede real)");
  {
    const d = await diagnosticarOpenAI();

    log(`        estado          : ${d.estado}`);
    log(`        acao            : ${d.acao}`);
    log(`        autentica       : ${d.autentica}`);
    log(`        modelos visiveis: ${d.modelosVisiveis}`);
    log(`        candidatos      : ${d.candidatos.slice(0, 6).join(", ") || "(nenhum)"}`);
    if (d.evidencia !== null) log(`        evidencia       : ${d.evidencia}`);

    // Estas duas assercoes continuam verdadeiras com OU sem saldo. Uma
    // suite que exigisse `billing_necessario` passaria a falhar no dia em
    // que o problema fosse resolvido — o que e o oposto de util.
    ok("C1  o estado e um dos conhecidos",
      (ESTADOS_DA_OPENAI as readonly string[]).includes(d.estado), d.estado);
    ok("C2  e vem acompanhado do que fazer",
      d.acao === ACAO_POR_ESTADO[d.estado as EstadoDaOpenAI]);

    if (d.estado === "sem_chave") {
      ok("C3  sem chave, nao ha o que diagnosticar", true);
    } else {
      ok("C3  a chave AUTENTICA — `GET /v1/models` responde",
        d.autentica, d.evidencia ?? "");
      ok("C4  e a conta enxerga modelos",
        d.modelosVisiveis > 0, String(d.modelosVisiveis));
      ok("C5  ha modelo com function calling visivel",
        d.candidatos.length > 0, d.candidatos.join(","));
    }

    // A evidencia nunca pode carregar a chave.
    const k = process.env.OPENAI_API_KEY ?? "";
    ok("C6  a evidencia NAO contem a credencial",
      d.evidencia === null || k === "" || !d.evidencia.includes(k));

    // O que este estado LIBERA, dito sem rodeio.
    if (d.estado === "disponivel") {
      log("");
      log("        >> A OpenAI esta alcancavel. O adaptador pode ser escrito");
      log("           e PROVADO com o roundtrip de 46719.65.");
    } else {
      log("");
      log(`        >> Runtime de agente com OpenAI BLOQUEADO: ${d.estado}.`);
      log(`           ${d.acao}`);
    }
  }

  // ─── D. Nada foi prometido sem prova ───────────────────────────────

  // ── Secao D reconciliada na F7b.4.2 ────────────────────────────
  //
  // ANTES ela cobrava a AUSENCIA de adaptador e de entrada no catalogo,
  // porque a conta nao tinha saldo e nada havia sido provado. Com a prova
  // feita, o adaptador existe e a entrada entrou.
  //
  // O que continua sendo cobrado e o que nunca mudou: a entrada tem de
  // apontar para uma prova QUE EXISTE, e o diagnostico nao pode virar
  // runtime.
  secao("D. O catalogo so oferece o que tem endereco de prova");
  {
    const cat = readFileSync(join(__dirname, "..", "lib", "agentes", "factory",
      "catalogo-de-modelos.ts"), "utf-8");
    const semCom = cat.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

    ok("D1  ha entrada de OpenAI no catalogo",
      /provedor:\s*"openai"/.test(semCom));
    ok("D2  e ela aponta para a suite que a provou",
      /provadoEm:\s*"scripts\/testar-openai-runtime-live\.ts"/.test(semCom));
    ok("D2a e essa suite EXISTE no disco", (() => {
      try {
        return readFileSync(join(__dirname, "testar-openai-runtime-live.ts"),
          "utf-8").length > 2000;
      } catch { return false; }
    })());
    ok("D2b o catalogo nao carrega id de modelo em literal",
      !/gpt-[a-z0-9.-]+/.test(semCom.replace(/"scripts\/[^"]*"/g, '""')));

    const ad = readFileSync(join(__dirname, "..", "lib", "ai-gateway", "provedores",
      "openai-ferramentas.ts"), "utf-8");
    ok("D3  o adaptador existe e e server-only",
      /^import "server-only";/m.test(ad));
    ok("D4  e o SDK da OpenAI continua NAO instalado — REST basta",
      !/"openai"/.test(readFileSync(join("C:", "Users", "USER", "Desktop",
        "calculadora-dos-sellers-v1", "package.json"), "utf-8")));

    const diag = readFileSync(join(__dirname, "..", "lib", "ai-gateway", "provedores",
      "openai-disponibilidade.ts"), "utf-8");
    ok("D5  o diagnostico e server-only",
      /^import "server-only";/m.test(diag));
    ok("D6  e a chave e lida de UM lugar so, em cada arquivo",
      (diag.match(/process\.env\.OPENAI_API_KEY/g) ?? []).length === 1 &&
        (ad.match(/process\.env\.OPENAI_API_KEY/g) ?? []).length === 1);
    ok("D7  o diagnostico nao participa do runtime do agente",
      !/conversarComFerramentas|AdaptadorIAComFerramentas|declararFerramentas/.test(diag));
  }

  log("\n-- placar ------------------------------------------------------");
  log(`  PASS ${passou}   FAIL ${falhou}`);
  if (falhou > 0) process.exitCode = 1;
}

void main().catch((e) => {
  log(`erro fatal: ${limpar(String((e as Error).message ?? "")).slice(0, 260)}`);
  process.exitCode = 1;
});
