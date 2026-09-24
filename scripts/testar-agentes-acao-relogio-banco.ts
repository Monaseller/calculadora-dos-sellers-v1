/**
 * A AÇÃO INTEIRA sob os dois relógios — I4B4.
 *
 * ── O que so este harness pode provar ───────────────────────────────
 *
 * As suites anteriores provaram o MECANISMO: que o sinal existe, que ele
 * chega ao `fetch`, que o teto e o menor dos dois. Nenhuma delas provou
 * a TRAVESSIA — que uma acao real, com o executor real, as permissoes
 * reais, a credencial real e o banco real, termina dentro do orcamento
 * mesmo quando uma fronteira qualquer trava.
 *
 * Aqui `executarFuncao` NAO e falsificado. O que se injeta e:
 *
 *   - o provider, no limite da rede (`globalThis.fetch`);
 *   - a lentidao do PostgREST, num proxy local que fica na frente do
 *     Supabase de verdade e segura o pedido que o teste mandar segurar.
 *
 * O proxy e o que torna H2..H8 possiveis: ele permite travar UMA
 * fronteira — permissao, credencial, inbox, cursor, desfecho — deixando
 * todo o resto real e rapido.
 *
 * ── Onde roda ───────────────────────────────────────────────────────
 *
 * SOMENTE contra um Supabase local descartavel. Exige `--confirmo`.
 *
 * Rodar:
 *   NEXT_PUBLIC_SUPABASE_URL="http://127.0.0.1:54321" \
 *   SUPABASE_SERVICE_ROLE_KEY="<local>" \
 *   QUESTION_INBOX_TEST_DATABASE_URL="postgresql://...54322/postgres" \
 *     npx tsx scripts/testar-agentes-acao-relogio-banco.ts --confirmo
 */
import "./_server-only-inerte";

import { createServer, request as pedirHttp, type Server } from "node:http";
import { Client } from "pg";

const HOSTS_LOCAIS = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0"]);

function conferirAmbiente(): { alvoReal: URL } {
  if (!process.argv.includes("--confirmo")) {
    throw new Error("falta --confirmo: esta suite escreve e commita fixtures");
  }
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!url) throw new Error("NEXT_PUBLIC_SUPABASE_URL ausente");
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("SUPABASE_SERVICE_ROLE_KEY ausente");
  }
  const alvo = new URL(url);
  if (!HOSTS_LOCAIS.has(alvo.hostname)) {
    throw new Error(`hospedeiro "${alvo.hostname}" nao e local`);
  }
  const direto = process.env.QUESTION_INBOX_TEST_DATABASE_URL;
  if (!direto) throw new Error("QUESTION_INBOX_TEST_DATABASE_URL ausente");
  if (!HOSTS_LOCAIS.has(new URL(direto).hostname)) {
    throw new Error("QUESTION_INBOX_TEST_DATABASE_URL nao aponta para host local");
  }
  return { alvoReal: alvo };
}

const { alvoReal } = conferirAmbiente();

// ─── O provider, no limite da rede ────────────────────────────────────

process.env.ML_CLIENT_ID = "app-sintetico-i4b4";
process.env.ML_CLIENT_SECRET = "segredo-sintetico-i4b4";

const BASE_ML = "https://api.mercadolibre.com";
const URL_GRANT = /^https:\/\/api\.mercadolibre\.com\/users\/[^/]+\/applications$/;
const URL_PERGUNTAS = `${BASE_ML}/my/received_questions/search`;

interface Provider {
  grant: number;
  perguntas: number;
  inesperadas: number;
  /** Os `offset` pedidos, na ordem. */
  offsets: string[];
  /** Quanto restava do orcamento do provider quando cada busca comecou. */
  restantes: number[];
  /** Quando `true`, a busca TRAVA ate alguem abortar. */
  travar: boolean;
  penduradas: number;
}
const prov: Provider = {
  grant: 0, perguntas: 0, inesperadas: 0,
  offsets: [], restantes: [], travar: false, penduradas: 0,
};

/**
 * Quando a acao em curso comecou, no relogio do HARNESS.
 *
 * O servico nao expoe o controle dele, e nem deve: o orcamento e
 * interno. Mas o restante compartilhado e derivavel de fora —
 * `PROVIDER_WORK_BUDGET_MS - decorrido` — e e isso que basta para provar
 * que a segunda pagina NAO ganha janela nova.
 */
let inicioDaAcao = 0;
const PROVIDER_WORK_BUDGET_MS = 30_000;
const restanteDoProviderObservado = (): number =>
  PROVIDER_WORK_BUDGET_MS - (performance.now() - inicioDaAcao);

const FETCH_ORIGINAL = globalThis.fetch;

const respostaJson = (corpo: unknown): Response =>
  new Response(JSON.stringify(corpo), {
    status: 200, headers: { "content-type": "application/json" },
  });

const perguntaBruta = (id: string) => ({
  id, item_id: "MLB-I4B4", text: "Pergunta sintetica.",
  status: "UNANSWERED", date_created: "2026-09-20T10:00:00.000-04:00",
});

globalThis.fetch = (async (entrada: unknown, init?: unknown): Promise<Response> => {
  const alvo = typeof entrada === "string" ? entrada : String(entrada);
  if (alvo.startsWith("http://127.0.0.1")) {
    return FETCH_ORIGINAL(entrada as RequestInfo, init as RequestInit);
  }
  if (URL_GRANT.test(alvo)) {
    prov.grant += 1;
    return respostaJson([{ app_id: process.env.ML_CLIENT_ID, scopes: ["read"] }]);
  }
  if (alvo.startsWith(URL_PERGUNTAS)) {
    prov.perguntas += 1;
    prov.offsets.push(new URL(alvo).searchParams.get("offset") ?? "?");
    prov.restantes.push(Math.round(restanteDoProviderObservado()));
    if (prov.travar) {
      prov.penduradas += 1;
      const sinal = (init as { signal?: AbortSignal } | undefined)?.signal;
      return new Promise<Response>((_r, rejeitar) => {
        if (!sinal) return;
        const cair = () => {
          prov.penduradas -= 1;
          rejeitar(new DOMException("Aborted", "AbortError"));
        };
        if (sinal.aborted) return cair();
        sinal.addEventListener("abort", cair, { once: true });
      });
    }
    return respostaJson({ questions: [perguntaBruta(`Q-${prov.perguntas}`)], total: 1 });
  }
  prov.inesperadas += 1;
  throw new Error("FRONTEIRA: host externo inesperado");
}) as typeof fetch;

// ─── O proxy que sabe travar UMA fronteira ────────────────────────────

interface Trava {
  /** Trecho do caminho que identifica a fronteira. */
  readonly padrao: string;
  /** Qual ocorrencia travar (1 = a primeira). */
  readonly ocorrencia: number;
}

interface Proxy {
  porta: number;
  trava: Trava | null;
  vistos: Map<string, number>;
  /** Pedidos segurados agora. Tem de voltar a zero no fim de cada caso. */
  pendurados: number;
  /** Pedidos cujo cliente desistiu — a prova de que o abort chegou ao socket. */
  abortadosPeloCliente: number;
  caminhos: string[];
}
const proxy: Proxy = {
  porta: 0, trava: null, vistos: new Map(),
  pendurados: 0, abortadosPeloCliente: 0, caminhos: [],
};

function casa(caminho: string, padrao: string): boolean {
  return caminho.includes(padrao);
}

let servidorProxy: Server;

async function subirProxy(): Promise<void> {
  servidorProxy = createServer((req, res) => {
    const caminho = req.url ?? "";
    proxy.caminhos.push(`${req.method} ${caminho.slice(0, 80)}`);

    const t = proxy.trava;
    if (t !== null && casa(caminho, t.padrao)) {
      const n = (proxy.vistos.get(t.padrao) ?? 0) + 1;
      proxy.vistos.set(t.padrao, n);
      if (n === t.ocorrencia) {
        // TRAVA: nao responde, nao encaminha. O cliente so sai daqui
        // pelo proprio AbortSignal.
        proxy.pendurados += 1;
        req.socket.on("close", () => {
          proxy.pendurados -= 1;
          proxy.abortadosPeloCliente += 1;
        });
        return;
      }
    }

    const adiante = pedirHttp(
      {
        hostname: alvoReal.hostname,
        port: Number(alvoReal.port || 80),
        path: caminho,
        method: req.method,
        headers: req.headers,
      },
      (resposta) => {
        res.writeHead(resposta.statusCode ?? 502, resposta.headers);
        resposta.pipe(res);
      }
    );
    adiante.on("error", () => { res.writeHead(502); res.end(); });
    req.pipe(adiante);
  });
  // O padrao do Node e 300 s. Mantido alto — bem acima do orcamento de
  // 38 s — para que um pedido corretamente abortado nunca o alcance; mas
  // reduzido o suficiente para que um pedido que NAO foi abortado
  // apareca em segundos em vez de cinco minutos. Foi o padrao de 300 s
  // que revelou o desfecho de Funcao sem sinal.
  servidorProxy.requestTimeout = 90_000;
  servidorProxy.headersTimeout = 90_000;
  await new Promise<void>((r) => servidorProxy.listen(0, "127.0.0.1", () => r()));
  proxy.porta = (servidorProxy.address() as { port: number }).port;
  // Daqui para a frente, TODO cliente Supabase criado fala com o proxy.
  process.env.NEXT_PUBLIC_SUPABASE_URL = `http://127.0.0.1:${proxy.porta}`;
}

// ─── Imports que tocam `lib/` vem DEPOIS do proxy estar de pe ────────

import type { PerguntaRecebida } from "@/lib/agentes/dados/perguntas";
import {
  ORCAMENTO_TOTAL_MS,
  sincronizarPerguntas,
} from "@/lib/agentes/ingestao/sincronizar-perguntas";
import { FUNCAO_ID as FUNCAO_PERGUNTAS_ML } from "@/lib/agentes/handlers/consultar-perguntas-ml-contrato";

const DONO = "aaaaaaaa-0000-4000-8000-0000000014c1";
const AGENTE = "11111111-1111-4111-8111-0000000014c2";
const LOJA = "cccccccc-0000-4000-8000-0000000014c3";

let passou = 0;
let falhou = 0;
const ok = (nome: string, cond: boolean, det = ""): void => {
  if (cond) { passou += 1; console.log(`  PASS  ${nome}`); }
  else { falhou += 1; console.log(`  FAIL  ${nome}${det ? `  — ${det}` : ""}`); }
};
const secao = (t: string) =>
  console.log(`\n── ${t} ${"─".repeat(Math.max(2, 56 - t.length))}`);

/** A tolerancia do agendador. Pequena de proposito: grande o suficiente
 *  para esconder falha nao serve de prova. */
const TOLERANCIA_MS = 4_000;

/**
 * O `close` do socket chega DEPOIS de a chamada voltar.
 *
 * O cliente desiste, o `fetch` rejeita, e so entao o TCP e derrubado.
 * Medir os contadores do proxy no instante em que a acao retorna leria o
 * estado de um evento que ainda nao aconteceu — foi assim que a primeira
 * execucao desta suite reprovou quatro casos por corrida propria.
 */
const assentar = () => new Promise((r) => setTimeout(r, 400));

let seq = 0;
const chaveNova = () => { seq += 1; return `n8n:i4b4-${seq}:sincronizar_perguntas:ag`; };

async function main(): Promise<void> {
  console.log("\n══ CDS IA — a acao inteira sob os dois relogios (I4B4) ══");
  console.log(`  proxy = 127.0.0.1:${proxy.porta} -> ${alvoReal.hostname}:${alvoReal.port}`);

  const pg = new Client({ connectionString: process.env.QUESTION_INBOX_TEST_DATABASE_URL });
  await pg.connect();
  await pg.query("set statement_timeout = 60000");

  const contarInbox = async () => Number((await pg.query(
    "select count(*)::int as n from public.agente_perguntas_ml where user_id = $1",
    [DONO])).rows[0].n);
  const cursor = async () => (await pg.query(
    `select loja_id::text as loja_id, proximo_deslocamento, versao::int as versao
       from public.agente_perguntas_continuacao where agente_id = $1::uuid`,
    [AGENTE])).rows[0] ?? null;
  const linhasAcao = async () => (await pg.query(
    `select fase, status, codigo_desfecho from public.agente_acao_execucoes
      where user_id = $1 order by fase desc`, [DONO])).rows as Array<Record<string, unknown>>;
  const limpar = async () => {
    await pg.query("delete from public.agente_perguntas_continuacao where user_id = $1", [DONO]);
    await pg.query("delete from public.agente_acao_execucoes where user_id = $1", [DONO]);
    await pg.query("delete from public.agente_funcao_chamadas where user_id = $1", [DONO]);
    await pg.query("delete from public.agente_perguntas_ml where user_id = $1", [DONO]);
  };

  /** Roda a acao inteira e devolve quanto tempo ela levou de fato. */
  async function acao(): Promise<{ tipo: string; ms: number; r: unknown }> {
    const inicio = performance.now();
    inicioDaAcao = inicio;
    const r = await sincronizarPerguntas({ agenteId: AGENTE, idempotencyKey: chaveNova() });
    return { tipo: (r as { tipo: string }).tipo, ms: performance.now() - inicio, r };
  }

  function zerar(): void {
    proxy.trava = null;
    proxy.vistos.clear();
    proxy.caminhos.length = 0;
    prov.grant = 0; prov.perguntas = 0; prov.offsets.length = 0;
    prov.restantes.length = 0; prov.travar = false;
  }

  try {
    await limpar();
    await pg.query("delete from public.agente_conexoes where user_id = $1", [DONO]);
    await pg.query("delete from public.agente_permissoes where user_id = $1", [DONO]);
    await pg.query("delete from public.lojas where id = $1::uuid", [LOJA]);
    await pg.query("delete from public.agentes where id = $1::uuid", [AGENTE]);
    await pg.query(
      `insert into public.agentes (id, user_id, nome, tipo, ativo)
       values ($1::uuid, $2, 'AGENTE I4B4', 'mensagens', true)`, [AGENTE, DONO]);
    await pg.query(
      `insert into public.lojas (id, nome, marketplace, user_id, ativo, access_token,
         refresh_token, seller_id, nickname, token_expires_at)
       values ($1::uuid, 'ML I4B4', 'ML', $2, true, 'token-sintetico',
               'refresh-sintetico', '900900900', 'ML', now() + interval '30 days')`,
      [LOJA, DONO]);
    await pg.query(
      `insert into public.agente_permissoes (agente_id, user_id, funcao_id, nivel)
       values ($1::uuid, $2, $3, 'automatico')`, [AGENTE, DONO, FUNCAO_PERGUNTAS_ML]);
    await pg.query(
      `insert into public.agente_conexoes (agente_id, user_id, plataforma, recurso, loja_id)
       values ($1::uuid, $2, 'mercado_livre', 'perguntas', $3::uuid)`, [AGENTE, DONO, LOJA]);

    // =================================================================
    secao("P. A cadeia completa, rapida");
    // =================================================================

    {
      zerar();
      const { tipo, ms } = await acao();
      const linhas = await linhasAcao();
      ok("P1  a acao inteira roda com o executor REAL e termina bem",
        tipo === "sincronizado" && linhas.length === 2
        && linhas.find((l) => l.fase === "desfecho")?.status === "sucesso",
        `${tipo} / ${JSON.stringify(linhas)}`);
      ok("P1b provider consultado: grant 1, perguntas 1",
        prov.grant === 1 && prov.perguntas === 1,
        `${prov.grant}/${prov.perguntas}`);
      ok("P1c e o banco foi tocado nas fronteiras esperadas",
        proxy.caminhos.some((c) => c.includes("agente_permissoes"))
        && proxy.caminhos.some((c) => c.includes("agente_conexoes"))
        && proxy.caminhos.some((c) => c.includes("lojas"))
        && proxy.caminhos.some((c) => c.includes("agente_funcao_chamadas"))
        && proxy.caminhos.some((c) => c.includes("agente_acao_execucoes"))
        && proxy.caminhos.some((c) => c.includes("agente_perguntas_continuacao"))
        && proxy.caminhos.some((c) => c.includes("upsert_lote")),
        String(proxy.caminhos.length));
      ok("H1  e o caminho rapido cabe folgado no orcamento",
        ms < ORCAMENTO_TOTAL_MS, `${Math.round(ms)} ms`);
      ok("P1d a inbox recebeu a pergunta", (await contarInbox()) === 1);
    }

    {
      // Duas paginas na MESMA acao: o segundo `offset` nao recebe janela
      // nova. `restantes` e medido no instante de cada busca.
      await limpar();
      zerar();
      let n = 0;
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async (e: unknown, i?: unknown): Promise<Response> => {
        const alvo = typeof e === "string" ? e : String(e);
        if (alvo.startsWith(URL_PERGUNTAS)) {
          n += 1;
          prov.perguntas += 1;
          prov.offsets.push(new URL(alvo).searchParams.get("offset") ?? "?");
          prov.restantes.push(Math.round(restanteDoProviderObservado()));
          // Pagina 1 CHEIA e truncada -> obriga a segunda.
          const linhas = n === 1
            ? Array.from({ length: 50 }, (_, k) => perguntaBruta(`P6-${k}`))
            : [perguntaBruta("P6-fim")];
          return respostaJson({ questions: linhas, total: n === 1 ? 500 : 51 });
        }
        return (originalFetch as typeof fetch)(e as RequestInfo, i as RequestInit);
      }) as typeof fetch;

      const { tipo } = await acao();
      globalThis.fetch = originalFetch;

      ok("P6  as duas paginas da MESMA acao acontecem",
        prov.perguntas === 2 && prov.offsets.join(",") === "0,50",
        `${prov.perguntas} / ${prov.offsets.join(",")}`);
      ok("P6b a segunda NAO recebe janela nova — o restante so encolhe",
        prov.restantes.length === 2
        && prov.restantes[1] < prov.restantes[0]
        && prov.restantes[1] > 0,
        prov.restantes.join(" -> "));
      ok("P6c e a varredura terminou normalmente", tipo === "sincronizado", tipo);
    }

    // =================================================================
    secao("H. Uma fronteira travada por vez");
    // =================================================================

    const casos: ReadonlyArray<readonly [string, string, string, number]> = [
      // rotulo, caso, padrao no caminho, ocorrencia
      ["H2  leitura do agente, ANTES do provider", "H2", "agentes", 1],
      ["H3  permissoes, DENTRO do executor", "H3", "agente_permissoes", 1],
      ["H4  credencial/loja, DENTRO do executor", "H4", "lojas", 1],
      ["H5a abertura de Funcao", "H5a", "agente_funcao_chamadas", 1],
      ["H6  a RPC da inbox", "H6", "upsert_lote", 1],
      ["H7  a escrita do cursor", "H7", "agente_perguntas_continuacao", 2],
      ["H8  o desfecho da acao", "H8", "agente_acao_execucoes", 2],
    ];

    for (const [rotulo, caso, padrao, ocorrencia] of casos) {
      await limpar();
      zerar();
      proxy.abortadosPeloCliente = 0;
      proxy.trava = { padrao, ocorrencia };

      const providerAntes = prov.perguntas;
      const { ms } = await acao();
      await assentar();

      ok(`${rotulo}: a acao termina dentro do orcamento`,
        ms <= ORCAMENTO_TOTAL_MS + TOLERANCIA_MS, `${Math.round(ms)} ms`);
      ok(`${caso}b o pedido travado foi de fato ABORTADO no socket`,
        proxy.abortadosPeloCliente >= 1, String(proxy.abortadosPeloCliente));
      ok(`${caso}c nenhum pedido ficou pendurado no proxy`,
        proxy.pendurados === 0, String(proxy.pendurados));

      if (caso === "H2" || caso === "H3" || caso === "H4" || caso === "H5a") {
        ok(`${caso}d o provider NAO foi consultado`,
          prov.perguntas === providerAntes,
          String(prov.perguntas - providerAntes));
      }
      if (caso === "H6") {
        ok("H6d a inbox NAO gravou e o cursor NAO avancou",
          (await contarInbox()) === 0 && (await cursor()) === null);
      }
      if (caso === "H7") {
        ok("H7d a inbox permanece DURAVEL mesmo com o cursor travado",
          (await contarInbox()) === 1);
        ok("H7e e o cursor nao ficou num estado meio escrito",
          (await cursor()) === null);
      }
      if (caso === "H8") {
        const linhas = await linhasAcao();
        ok("H8d a abertura fica ORFA, e isso e evidencia",
          linhas.length === 1 && linhas[0].fase === "abertura",
          JSON.stringify(linhas));
        ok("H8e com a inbox e o cursor duraveis",
          (await contarInbox()) === 1 && (await cursor()) !== null);
      }
    }

    // =================================================================
    secao("H5b / provider ok, desfecho de Funcao travado");
    // =================================================================

    {
      await limpar();
      zerar();
      proxy.abortadosPeloCliente = 0;
      // A 2a ida a `agente_funcao_chamadas` e o DESFECHO da Funcao.
      proxy.trava = { padrao: "agente_funcao_chamadas", ocorrencia: 2 };
      const { ms } = await acao();
      await assentar();
      ok("H5b provider rodou UMA vez e nao foi repetido",
        prov.perguntas === 1, String(prov.perguntas));
      ok("H5b2 a acao termina dentro do orcamento",
        ms <= ORCAMENTO_TOTAL_MS + TOLERANCIA_MS, `${Math.round(ms)} ms`);
      ok("H5b3 e o pedido travado foi abortado no socket",
        proxy.abortadosPeloCliente >= 1);
    }

    // =================================================================
    secao("C. Ausencia de negocio NAO e prazo vencido");
    // =================================================================

    {
      // A permissao e REMOVIDA. A consulta responde, com zero linha.
      await limpar();
      zerar();
      await pg.query("delete from public.agente_permissoes where user_id = $1", [DONO]);
      const { tipo, ms } = await acao();
      const d = (await linhasAcao()).find((l) => l.fase === "desfecho") ?? {};
      ok("C1  zero linha de permissao vira `negado/permissao_ausente`",
        d.status === "negado" && d.codigo_desfecho === "permissao_ausente",
        JSON.stringify(d));
      ok("C1b e nao `orcamento_esgotado` — a diferenca e visivel",
        d.codigo_desfecho !== "orcamento_esgotado" && tipo === "negado");
      ok("C1c e foi rapido: o prazo nem chegou perto",
        ms < 5_000, `${Math.round(ms)} ms`);
      await pg.query(
        `insert into public.agente_permissoes (agente_id, user_id, funcao_id, nivel)
         values ($1::uuid, $2, $3, 'automatico')`, [AGENTE, DONO, FUNCAO_PERGUNTAS_ML]);
    }

    {
      // A MESMA fronteira, agora TRAVADA. Zero linha e prazo vencido tem
      // de produzir desfechos diferentes — e produzem.
      await limpar();
      zerar();
      proxy.abortadosPeloCliente = 0;
      proxy.trava = { padrao: "agente_permissoes", ocorrencia: 1 };
      const r = await acao();
      await assentar();
      const linhas = await linhasAcao();
      const d = linhas.find((l) => l.fase === "desfecho") ?? {};

      // ── O que este caso REALMENTE prova ──────────────────────────
      //
      // Quando a causa e o PRAZO RIGIDO, o mesmo sinal que derruba a
      // consulta travada derruba tambem a escrita do desfecho. Entao o
      // desfecho normalmente NAO cabe, e a abertura fica orfa — que e a
      // semantica congelada em §15, nao um defeito.
      //
      // O codigo `erro/orcamento_esgotado` continua existindo e
      // alcancavel: ele e o desfecho do caso em que o orcamento do
      // PROVIDER vence mas o rigido ainda tem folga. Aqui nao e esse.
      ok("C2  prazo vencido NAO vira classificacao de negocio",
        d.codigo_desfecho !== "permissao_ausente"
        && d.codigo_desfecho !== "conexao_ausente"
        && d.codigo_desfecho !== "provedor_falhou",
        JSON.stringify(d));
      ok("C2b o servico devolve a causa REAL — orcamento, nao permissao",
        r.tipo === "erro"
        && (r.r as { codigo?: string }).codigo === "orcamento_esgotado",
        `${r.tipo}/${(r.r as { codigo?: string }).codigo ?? "-"}`);
      ok("C2c e, com o prazo ja vencido, a abertura fica ORFA",
        linhas.length === 1 && linhas[0].fase === "abertura",
        JSON.stringify(linhas));
      ok("C2d o resultado admite que a auditoria ficou incompleta",
        (r.r as { auditoria?: string }).auditoria === "incompleta");
    }

    ok("H9  nenhum pedido de banco ficou pendurado no fim de tudo",
      proxy.pendurados === 0, String(proxy.pendurados));
    ok("P9  zero requisicao externa inesperada",
      prov.inesperadas === 0, String(prov.inesperadas));
    ok("P9b zero ida ao provider ficou pendurada",
      prov.penduradas === 0, String(prov.penduradas));
  } finally {
    await limpar();
    await pg.query("delete from public.agente_conexoes where user_id = $1", [DONO]);
    await pg.query("delete from public.agente_permissoes where user_id = $1", [DONO]);
    await pg.query("delete from public.lojas where id = $1::uuid", [LOJA]);
    await pg.query("delete from public.agentes where id = $1::uuid", [AGENTE]);
    await pg.end();
    servidorProxy.closeAllConnections?.();
    await new Promise<void>((r) => servidorProxy.close(() => r()));
  }

  console.log(`\n── placar ${"─".repeat(54)}`);
  console.log(`  PASS ${passou}   FAIL ${falhou}`);
  console.log(`  proxy: ${proxy.abortadosPeloCliente} abortados, ${proxy.pendurados} pendurados`);
  console.log(`  provider: grant ${prov.grant}, perguntas ${prov.perguntas}, `
    + `inesperadas ${prov.inesperadas}\n`);
  if (falhou > 0) process.exitCode = 1;
}

subirProxy()
  .then(main)
  .catch((e: unknown) => {
    console.log(`\nERRO: ${(e as { message?: string }).message ?? String(e)}`);
    process.exit(2);
  });
