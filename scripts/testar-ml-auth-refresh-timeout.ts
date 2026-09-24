/**
 * `refreshMLToken` — o limite de rede que faltava. I4B1.
 *
 * ── O que esta suite prova ──────────────────────────────────────────
 *
 * Que a renovacao de token do Mercado Livre ABORTA a requisicao HTTP de
 * verdade quando o limite estoura — e nao apenas devolve cedo deixando o
 * pedido vivo. A diferenca importa: um `Promise.race` responderia no
 * prazo e deixaria a conexao aberta, podendo gravar um token depois de
 * quem desistiu ja ter respondido.
 *
 * Por isso o duplo de `fetch` aqui NAO ignora o `signal`: ele registra
 * que recebeu um, escuta o `abort`, e so rejeita quando ele dispara. Um
 * teste que adiantasse o relogio sem exercitar o `AbortController` nao
 * provaria cancelamento nenhum.
 *
 * ── Sem rede, sem banco, sem credencial real ────────────────────────
 *
 * `globalThis.fetch` e substituido; host inesperado reprova a suite.
 * `ML_CLIENT_ID` e `ML_CLIENT_SECRET` recebem valores sinteticos no
 * processo — os de producao nunca sao lidos.
 *
 * Rodar:  npx tsx scripts/testar-ml-auth-refresh-timeout.ts
 */
import "./_server-only-inerte";

import { readFileSync } from "node:fs";
import { join } from "node:path";

// ── Ambiente sintetico, ANTES de importar o modulo ───────────────────
process.env.ML_CLIENT_ID = "app-sintetico-i4b1";
process.env.ML_CLIENT_SECRET = "segredo-sintetico-i4b1";

const URL_TOKEN = "https://api.mercadolibre.com/oauth/token";

interface Registro {
  /** Quantas vezes o `fetch` foi chamado. */
  chamadas: number;
  /** Quantas receberam um `AbortSignal`. */
  comSinal: number;
  /** Quantas viram o sinal DISPARAR. */
  abortadas: number;
  /** Requisicoes ainda pendentes quando a chamada ja respondeu. */
  pendentes: number;
  /** Hosts fora do previsto. Qualquer um reprova. */
  inesperados: string[];
}

const reg: Registro = {
  chamadas: 0, comSinal: 0, abortadas: 0, pendentes: 0, inesperados: [],
};

let passou = 0;
let falhou = 0;
const ok = (nome: string, cond: boolean, det = ""): void => {
  if (cond) { passou += 1; console.log(`  PASS  ${nome}`); }
  else { falhou += 1; console.log(`  FAIL  ${nome}${det ? `  — ${det}` : ""}`); }
};
const secao = (t: string) =>
  console.log(`\n── ${t} ${"─".repeat(Math.max(2, 58 - t.length))}`);

const corpoBom = {
  access_token: "novo-token-sintetico",
  refresh_token: "novo-refresh-sintetico",
  expires_in: 21600,
};

type Modo = "rapido" | "trava" | "erro_http" | "sem_token";
let modo: Modo = "rapido";

/**
 * O duplo. Ele HONRA o `signal`, que e o ponto: se a producao nao
 * passasse um, `comSinal` ficaria em zero e a prova de cancelamento cairia.
 */
globalThis.fetch = (async (entrada: unknown, init?: unknown): Promise<Response> => {
  const alvo = typeof entrada === "string" ? entrada : String(entrada);
  if (alvo !== URL_TOKEN) {
    reg.inesperados.push(alvo.slice(0, 120));
    throw new Error("FRONTEIRA: host inesperado bloqueado");
  }

  reg.chamadas += 1;
  const sinal = (init as { signal?: AbortSignal } | undefined)?.signal;
  if (sinal) reg.comSinal += 1;

  if (modo === "erro_http") {
    return new Response("nao", { status: 401 });
  }
  if (modo === "sem_token") {
    return new Response(JSON.stringify({ expires_in: 1 }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  }
  if (modo === "rapido") {
    return new Response(JSON.stringify(corpoBom), {
      status: 200, headers: { "content-type": "application/json" },
    });
  }

  // `trava`: so termina se alguem abortar. E isto que distingue um
  // deadline REAL de um `Promise.race`.
  reg.pendentes += 1;
  return new Promise<Response>((_resolver, rejeitar) => {
    if (!sinal) return; // pendura para sempre — e a suite reprova
    if (sinal.aborted) {
      reg.abortadas += 1;
      reg.pendentes -= 1;
      rejeitar(new DOMException("Aborted", "AbortError"));
      return;
    }
    sinal.addEventListener("abort", () => {
      reg.abortadas += 1;
      reg.pendentes -= 1;
      rejeitar(new DOMException("Aborted", "AbortError"));
    }, { once: true });
  });
}) as typeof fetch;

import { refreshMLToken, TIMEOUT_REFRESH_MS } from "@/lib/ml-auth";

const REFRESH_SECRETO = "refresh-token-sintetico-nao-deve-vazar";

async function main(): Promise<void> {
  console.log("\n══ CDS — refreshMLToken: limite de rede real (I4B1) ══");

  secao("T. O caminho feliz continua igual");

  {
    modo = "rapido";
    const antes = reg.chamadas;
    const r = await refreshMLToken(REFRESH_SECRETO);
    ok("T1  resposta rapida devolve o token novo",
      r !== null && r.token === corpoBom.access_token
      && r.newRefreshToken === corpoBom.refresh_token,
      JSON.stringify(r === null ? null : { t: r.token.slice(0, 5) }));
    ok("T1b uma unica ida a rede", reg.chamadas === antes + 1);
    ok("T5  o `fetch` recebeu um AbortSignal mesmo no caminho feliz",
      reg.comSinal === reg.chamadas, `${reg.comSinal}/${reg.chamadas}`);
  }

  {
    modo = "erro_http";
    const r = await refreshMLToken(REFRESH_SECRETO);
    ok("T5b resposta nao-ok continua devolvendo `null`", r === null);
  }

  {
    modo = "sem_token";
    const r = await refreshMLToken(REFRESH_SECRETO);
    ok("T5c corpo sem `access_token` continua devolvendo `null`", r === null);
  }

  secao("U. O limite, e ele ABORTA de verdade");

  {
    modo = "trava";
    const abortadasAntes = reg.abortadas;
    const inicio = performance.now();
    // Limite curto SO nesta chamada: o padrao de 20 s tornaria a suite
    // lenta sem provar nada a mais.
    const r = await refreshMLToken(REFRESH_SECRETO, { timeoutMs: 120 });
    const gasto = performance.now() - inicio;

    ok("T2  o sinal DISPAROU no `fetch` — cancelamento real, nao corrida",
      reg.abortadas === abortadasAntes + 1, String(reg.abortadas - abortadasAntes));
    ok("T2b e a chamada voltou perto do limite, nao depois",
      gasto < 2_000, `${Math.round(gasto)} ms`);
    ok("T3  o aborto vira a falha TIPADA que os chamadores ja tratam",
      r === null);
    ok("T4  nenhuma requisicao ficou pendurada",
      reg.pendentes === 0, String(reg.pendentes));
  }

  {
    // Sinal EXTERNO — o deadline de quem orquestra. Ja abortado antes de
    // a chamada comecar e o caso de borda que um `addEventListener`
    // sozinho perderia.
    modo = "trava";
    const abortadasAntes = reg.abortadas;
    const controlador = new AbortController();
    controlador.abort();
    const r = await refreshMLToken(REFRESH_SECRETO, { signal: controlador.signal });
    ok("T2c sinal externo JA abortado cancela sem esperar o timeout",
      r === null && reg.abortadas === abortadasAntes + 1);
  }

  {
    modo = "trava";
    const abortadasAntes = reg.abortadas;
    const controlador = new AbortController();
    setTimeout(() => controlador.abort(), 80);
    const r = await refreshMLToken(REFRESH_SECRETO, { signal: controlador.signal });
    ok("T2d sinal externo que dispara DEPOIS tambem cancela",
      r === null && reg.abortadas === abortadasAntes + 1);
    ok("T4b e nada ficou pendurado", reg.pendentes === 0, String(reg.pendentes));
  }

  secao("V. Compatibilidade e higiene");

  {
    // Os tres chamadores de producao passam UM argumento. Se a assinatura
    // tivesse virado obrigatoria, isto nem compilaria.
    modo = "rapido";
    const chamadaAntiga: (t: string) => Promise<unknown> = refreshMLToken;
    const r = await chamadaAntiga(REFRESH_SECRETO);
    ok("T6  chamada com UM argumento continua valida e funcional", r !== null);

    const semComentario = (rel: string): string =>
      readFileSync(join(__dirname, "..", rel), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^[ \t]*\/\/.*$/gm, "");
    const CODIGO = semComentario("lib/ml-auth.ts");
    {
      // Os CHAMADORES, nos dois arquivos que chamam. A DECLARACAO sai
      // antes: ela tem virgula entre parametros e passaria por chamada de
      // dois argumentos — foi exatamente assim que este oraculo reprovou
      // na primeira execucao.
      const semDeclaracao = (f: string) =>
        f.replace(/export async function refreshMLToken\([^{]*\{/, "");
      const chamadas = [CODIGO, semComentario("lib/ml-conexao.ts")]
        .map(semDeclaracao)
        .flatMap((f) => [...f.matchAll(/refreshMLToken\(([^)]*)\)/g)].map((m) => m[1]));
      // QUATRO, nao tres. O primeiro levantamento deste gate disse tres
      // porque o filtro do grep escondeu `ml-auth.ts:110`. A conclusao
      // nao muda — todos passam UM argumento —, mas a contagem agora sai
      // da fonte a cada execucao, em vez de uma leitura feita uma vez.
      // Tres seguem com UM argumento. O quarto — `renovarComCas` —
      // passou a repassar o orcamento da acao no I4B3, e e justamente o
      // caminho que `getMLLojaById` alcanca a partir da ingestao. Os
      // outros tres provam que nada virou obrigatorio.
      const comOrcamento = chamadas.filter((arg) => arg.includes("limiteExterno"));
      ok("T6b tres chamadores com UM argumento; so o da ingestao repassa",
        chamadas.length === 4 && comOrcamento.length === 1
        && chamadas.filter((arg) => !arg.includes(",")).length === 3,
        `${chamadas.length}: ${chamadas.join(" | ")}`);
    }
    ok("T6c o padrao e limitado, nao `undefined`",
      /opcoes\?\.timeoutMs \?\? TIMEOUT_REFRESH_MS/.test(CODIGO)
      && TIMEOUT_REFRESH_MS === 20_000);
    ok("T6f com orcamento compartilhado, o teto e o MENOR dos dois",
      /tetoEfetivoMs\(opcoes\.timeoutMs \?\? TIMEOUT_REFRESH_MS, opcoes\.limiteExterno\)/
        .test(CODIGO));
    ok("T6g orcamento ja esgotado nao inicia ida a rede",
      /if \(limite <= 0\) return null;/.test(CODIGO));
    ok("T6d o sinal chega ao `fetch`, e nao a um `Promise.race`",
      /signal: controlador\.signal,/.test(CODIGO)
      && !/Promise\.race/.test(CODIGO));
    ok("T6e o relogio e sempre limpo, inclusive no erro",
      /finally \{\s*clearTimeout\(relogio\);/.test(CODIGO));
  }

  {
    // O modulo nao loga nada nesta funcao — e a prova e de runtime, nao
    // de leitura: qualquer escrita em console durante as chamadas acima
    // teria sido capturada.
    const capturado: string[] = [];
    const originais = { log: console.log, error: console.error, warn: console.warn };
    console.log = (...a: unknown[]) => { capturado.push(a.join(" ")); };
    console.error = (...a: unknown[]) => { capturado.push(a.join(" ")); };
    console.warn = (...a: unknown[]) => { capturado.push(a.join(" ")); };

    modo = "rapido";
    await refreshMLToken(REFRESH_SECRETO);
    modo = "erro_http";
    await refreshMLToken(REFRESH_SECRETO);
    modo = "trava";
    await refreshMLToken(REFRESH_SECRETO, { timeoutMs: 60 });

    console.log = originais.log;
    console.error = originais.error;
    console.warn = originais.warn;

    const tudo = capturado.join("\n");
    ok("T7  nem o refresh token, nem o segredo, nem o token novo vazam em log",
      !tudo.includes(REFRESH_SECRETO)
      && !tudo.includes(process.env.ML_CLIENT_SECRET ?? "@@")
      && !tudo.includes(corpoBom.access_token),
      tudo.slice(0, 120));
  }

  ok("T8  nenhuma requisicao saiu para host inesperado",
    reg.inesperados.length === 0, reg.inesperados.join(" | "));

  console.log(`\n── placar ${"─".repeat(54)}`);
  console.log(`  PASS ${passou}   FAIL ${falhou}`);
  console.log(`  fetch: ${reg.chamadas} chamadas, ${reg.comSinal} com sinal, `
    + `${reg.abortadas} abortadas, ${reg.pendentes} pendentes\n`);
  if (falhou > 0) process.exitCode = 1;
}

void main();
