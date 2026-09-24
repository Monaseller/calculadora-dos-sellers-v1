/**
 * Os dois relogios da acao, sob prova — I4B3.
 *
 * ── O que esta suite prova, e o que ela NAO prova ───────────────────
 *
 * Prova que o orcamento do provider e UM so, compartilhado por todas as
 * idas ao Mercado Livre da mesma acao; que uma chamada com o orcamento
 * vencido nem comeca; que o sinal chega ao `fetch` e ao PostgREST; e que
 * cortar o marketplace NAO corta a persistencia.
 *
 * Nao prova latencia real de nada — ninguem mediu essas chamadas em
 * producao, e este arquivo nao inventa medida. O relogio e controlado
 * pelo teste; o CANCELAMENTO e real.
 *
 * ── A fronteira ─────────────────────────────────────────────────────
 *
 * `globalThis.fetch` e substituido. Host externo fora do previsto lanca
 * e e contado. Nenhuma chamada ao Mercado Livre acontece.
 *
 * Rodar:  npx tsx scripts/testar-agentes-deadline-ingestao.ts
 */
import "./_server-only-inerte";

import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";

process.env.ML_CLIENT_ID = "app-sintetico-i4b3";
process.env.ML_CLIENT_SECRET = "segredo-sintetico-i4b3";

let passou = 0;
let falhou = 0;
const ok = (nome: string, cond: boolean, det = ""): void => {
  if (cond) { passou += 1; console.log(`  PASS  ${nome}`); }
  else { falhou += 1; console.log(`  FAIL  ${nome}${det ? `  — ${det}` : ""}`); }
};
const secao = (t: string) =>
  console.log(`\n── ${t} ${"─".repeat(Math.max(2, 58 - t.length))}`);

// ─── Relogio sob controle do teste ────────────────────────────────────

const relogioReal = performance.now.bind(performance);
let simulado = 0;
function usarRelogioFalso(): void {
  simulado = 0;
  performance.now = () => simulado;
}
function usarRelogioReal(): void {
  performance.now = relogioReal;
}
const avancar = (ms: number) => { simulado += ms; };

// ─── A fronteira externa ──────────────────────────────────────────────

const BASE_ML = "https://api.mercadolibre.com";
interface Chamada {
  readonly url: string;
  /** O teto que a chamada recebeu, deduzido do instante do aborto. */
  tetoObservado: number | null;
  abortada: boolean;
}
const chamadas: Chamada[] = [];
let externasInesperadas = 0;

const FETCH_ORIGINAL = globalThis.fetch;

/** Toda ida externa TRAVA. Quem a termina e o `AbortSignal` — e e isso
 *  que distingue deadline real de `Promise.race`. */
function instalarFronteira(): void {
  globalThis.fetch = (async (entrada: unknown, init?: unknown): Promise<Response> => {
    const alvo = typeof entrada === "string" ? entrada : String(entrada);
    if (alvo.startsWith("http://127.0.0.1")) {
      return FETCH_ORIGINAL(entrada as RequestInfo, init as RequestInit);
    }
    if (!alvo.startsWith(BASE_ML)) {
      externasInesperadas += 1;
      throw new Error("FRONTEIRA: host externo inesperado");
    }

    const sinal = (init as { signal?: AbortSignal } | undefined)?.signal;
    const registro: Chamada = { url: alvo, tetoObservado: null, abortada: false };
    chamadas.push(registro);
    const inicio = simulado;

    return new Promise<Response>((_r, rejeitar) => {
      if (!sinal) return; // pendura — e a suite reprova
      const cair = () => {
        registro.abortada = true;
        registro.tetoObservado = simulado - inicio;
        rejeitar(new DOMException("Aborted", "AbortError"));
      };
      if (sinal.aborted) return cair();
      sinal.addEventListener("abort", cair, { once: true });
    });
  }) as typeof fetch;
}

instalarFronteira();

import {
  criarControleDeTempo,
  restanteDoProviderMs,
  restanteRigidoMs,
  tetoEfetivoMs,
} from "@/lib/controle-tempo";
import { refreshMLToken } from "@/lib/ml-auth";

const RAIZ = join(__dirname, "..");
const ler = (rel: string) => readFileSync(join(RAIZ, rel), "utf8");
const semComentario = (rel: string) =>
  ler(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

async function main(): Promise<void> {
  console.log("\n══ CDS IA — os dois relogios da acao (I4B3) ══");

  // =================================================================
  secao("P. O orcamento do provider e UM so");
  // =================================================================

  {
    usarRelogioFalso();
    const { controle, encerrar } = criarControleDeTempo({
      orcamentoRigidoMs: 38_000, orcamentoDoProviderMs: 30_000,
    });
    ok("P0  os dois relogios nascem do MESMO instante monotonico",
      controle.limiteDoProviderEm === 30_000 && controle.limiteRigidoEm === 38_000);
    ok("P0b a reserva de finalizacao e a diferenca entre eles",
      controle.limiteRigidoEm - controle.limiteDoProviderEm === 8_000);

    avancar(12_000);
    ok("P2  gasto o tempo, o restante do provider ENCOLHE",
      restanteDoProviderMs(controle) === 18_000, String(restanteDoProviderMs(controle)));
    ok("P2b e o rigido encolhe junto, sempre a frente",
      restanteRigidoMs(controle) === 26_000);
    ok("P3  o teto EFETIVO de uma chamada e o menor dos dois",
      tetoEfetivoMs(20_000, controle.limiteDoProvider) === 18_000);

    avancar(15_000);
    ok("P8  o limite LOCAL continua sendo teto quando ele e o menor",
      restanteDoProviderMs(controle) === 3_000
      && tetoEfetivoMs(20_000, controle.limiteDoProvider) === 3_000);
    ok("P8b e o local vence quando o compartilhado e maior",
      tetoEfetivoMs(1_000, controle.limiteDoProvider) === 1_000);

    avancar(5_000);
    ok("P4  orcamento vencido devolve teto NAO positivo — nao se comeca",
      tetoEfetivoMs(20_000, controle.limiteDoProvider) <= 0);
    encerrar();
    usarRelogioReal();
  }

  {
    // Orcamento ja vencido: a renovacao NAO vai a rede.
    usarRelogioFalso();
    const { controle, encerrar } = criarControleDeTempo({
      orcamentoRigidoMs: 38_000, orcamentoDoProviderMs: 30_000,
    });
    avancar(31_000);
    const antes = chamadas.length;
    const r = await refreshMLToken("refresh-sintetico", {
      limiteExterno: controle.limiteDoProvider,
    });
    ok("P4b com o orcamento vencido, o refresh nem chega ao `fetch`",
      r === null && chamadas.length === antes, String(chamadas.length - antes));
    encerrar();
    usarRelogioReal();
  }

  {
    // Orcamento vivo: a chamada comeca, trava, e o RELOGIO do provider
    // a derruba — cancelamento real, nao corrida.
    usarRelogioReal();
    const { controle, encerrar } = criarControleDeTempo({
      orcamentoRigidoMs: 400, orcamentoDoProviderMs: 120,
    });
    const antes = chamadas.length;
    const inicio = performance.now();
    const r = await refreshMLToken("refresh-sintetico", {
      limiteExterno: controle.limiteDoProvider,
    });
    const gasto = performance.now() - inicio;
    const nova = chamadas[chamadas.length - 1];
    ok("P5  a chamada em voo e ABORTADA quando o orcamento do provider vence",
      chamadas.length === antes + 1 && nova.abortada === true && r === null);
    ok("P5b e ela volta perto do limite, nao depois",
      gasto < 2_000, `${Math.round(gasto)} ms`);
    ok("F1  o sinal RIGIDO continua vivo depois do corte do provider",
      controle.sinalRigido.aborted === false);
    encerrar();
  }

  {
    // A RESERVA, isolada de qualquer corrida com o timeout proprio da
    // chamada: espera-se passar do limite do provider e ficar longe do
    // rigido. A primeira versao deste caso media os dois no instante em
    // que o refresh voltava, e o timer do proprio refresh podia chegar
    // antes do timer do controle — corrida no teste, nao no codigo.
    usarRelogioReal();
    const { controle, encerrar } = criarControleDeTempo({
      orcamentoRigidoMs: 4_000, orcamentoDoProviderMs: 60,
    });
    await new Promise((r) => setTimeout(r, 250));
    ok("F1c passado o limite do provider, ele caiu",
      controle.limiteDoProvider.signal.aborted === true);
    ok("F2  e o RIGIDO segue vivo — a reserva de finalizacao existe",
      controle.sinalRigido.aborted === false
      && restanteRigidoMs(controle) > 0,
      String(Math.round(restanteRigidoMs(controle))));
    {
      // E, dentro da reserva, uma escrita de banco AINDA e possivel: o
      // sinal que ela usaria nao esta abortado.
      const aindaPode = !controle.sinalRigido.aborted;
      ok("F3  dentro da reserva, a persistencia ainda pode acontecer", aindaPode);
    }
    ok("F6  mas uma ida NOVA ao provider nao comeca",
      tetoEfetivoMs(20_000, controle.limiteDoProvider) <= 0);
    encerrar();
  }

  {
    // O rigido IMPLICA o do provider.
    usarRelogioReal();
    const { controle, encerrar } = criarControleDeTempo({
      orcamentoRigidoMs: 60, orcamentoDoProviderMs: 50_000,
    });
    await new Promise((r) => setTimeout(r, 160));
    ok("F1b quando o rigido cai, o do provider cai junto",
      controle.sinalRigido.aborted === true
      && controle.limiteDoProvider.signal.aborted === true);
    encerrar();
  }

  ok("P7  nenhuma ida externa ficou pendurada",
    chamadas.every((c) => c.abortada || c.tetoObservado !== null)
    || chamadas.length === 0);

  // =================================================================
  secao("S. O sinal RIGIDO alcanca o PostgREST — de verdade");
  // =================================================================

  {
    // Um servidor local que NUNCA responde. Se o `abortSignal` do
    // postgrest-js nao chegasse ao `fetch`, esta chamada pendurava.
    usarRelogioReal();
    let pedidosRecebidos = 0;
    const servidor: Server = createServer((_req, _res) => {
      pedidosRecebidos += 1;
      // sem `res.end()`: trava de proposito
    });
    await new Promise<void>((r) => servidor.listen(0, "127.0.0.1", () => r()));
    const porta = (servidor.address() as { port: number }).port;

    const { createClient } = await import("@supabase/supabase-js");
    const cliente = createClient(`http://127.0.0.1:${porta}`, "chave-local-sintetica", {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const controlador = new AbortController();
    setTimeout(() => controlador.abort(), 150);
    const inicio = performance.now();
    const { error } = await cliente
      .from("agente_acao_execucoes")
      .select("id")
      .abortSignal(controlador.signal)
      .limit(1);
    const gasto = performance.now() - inicio;

    ok("S1  a consulta ACEITA um AbortSignal por chamada", true);
    ok("S2  uma consulta pendurada ABORTA no sinal, e nao espera para sempre",
      error !== null && gasto < 3_000, `${Math.round(gasto)} ms`);
    ok("S2b o servidor chegou a receber o pedido — o aborto e de rede, nao de guarda",
      pedidosRecebidos >= 1, String(pedidosRecebidos));

    // Mesmo cliente, SEM sinal: o comportamento antigo continua inteiro.
    const semSinal = cliente.from("agente_acao_execucoes").select("id").limit(1);
    const corrida = await Promise.race([
      semSinal.then(() => "respondeu"),
      new Promise((r) => setTimeout(() => r("ainda pendurada"), 400)),
    ]);
    ok("S4  a MESMA consulta sem sinal segue sem limite — nada virou global",
      corrida === "ainda pendurada", String(corrida));

    servidor.closeAllConnections?.();
    await new Promise<void>((r) => servidor.close(() => r()));
  }

  {
    const FONTE = semComentario("lib/estudio-anuncios/supabase-servidor.ts");
    ok("S6  o cliente GLOBAL nao ganhou `fetch` nem timeout proprio",
      !/global:\s*\{[\s\S]{0,200}fetch/.test(FONTE)
      && !/AbortSignal|timeout/i.test(FONTE),
      FONTE.length > 0 ? "lido" : "arquivo vazio");
  }

  // =================================================================
  secao("D. A fiacao: quem recebe qual relogio");
  // =================================================================

  {
    const SERV = semComentario("lib/agentes/ingestao/sincronizar-perguntas.ts");
    const EXEC = semComentario("lib/agentes/execucao-funcoes/executar.ts");
    const REG = semComentario("lib/agentes/funcoes/registry.ts");

    ok("D1  o servico cria os dois relogios e os encerra no `finally`",
      /criarControleDeTempo\(\{/.test(SERV) && /\} finally \{\s*encerrar\(\);/.test(SERV));
    ok("D2  a persistencia usa o sinal RIGIDO",
      (SERV.match(/controle\.sinalRigido/g) ?? []).length >= 6,
      String((SERV.match(/controle\.sinalRigido/g) ?? []).length));
    ok("D3  o servico NUNCA entrega o sinal do provider ao banco",
      !/sinalRigido: controle\.limiteDoProvider|signal: controle\.limiteDoProvider/.test(SERV));
    ok("D4  o executor recebe o controle INTEIRO",
      /controleTempo\?: ControleDeTempo;/.test(EXEC)
      && /controleTempo: controle,/.test(SERV));
    ok("D5  mas so o limite do PROVIDER chega ao contexto da Funcao",
      /const limiteDoProvider = controle\?\.limiteDoProvider;/.test(EXEC)
      && !/sinalRigido/.test(REG));
    ok("D6  a cobertura remota divide o MESMO orcamento",
      /entrada\.controleTempo\?\.limiteDoProvider/.test(EXEC));
    ok("D7  o campo do contexto e OPCIONAL — nenhuma Funcao e obrigada a ve-lo",
      /readonly limiteDoProvider\?: LimiteExterno;/.test(REG));
    ok("D8  `vendas.consultar` segue sem saber que relogios existem",
      !/limiteDoProvider|controleTempo|AbortSignal/.test(
        semComentario("lib/agentes/handlers/consultar-vendas-contrato.ts")));
  }

  ok("P9  NENHUMA requisicao externa inesperada saiu do processo",
    externasInesperadas === 0, String(externasInesperadas));

  usarRelogioReal();
  console.log(`\n── placar ${"─".repeat(54)}`);
  console.log(`  PASS ${passou}   FAIL ${falhou}`);
  console.log(`  idas externas: ${chamadas.length}, abortadas ${chamadas.filter((c) => c.abortada).length}, `
    + `inesperadas ${externasInesperadas}\n`);
  if (falhou > 0) process.exitCode = 1;
}

main().catch((e: unknown) => {
  usarRelogioReal();
  console.log(`\nERRO: ${(e as { message?: string }).message ?? String(e)}`);
  process.exit(2);
});
