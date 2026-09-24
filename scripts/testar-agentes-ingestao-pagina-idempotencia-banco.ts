/**
 * Idempotência da PÁGINA, ponta a ponta — I3C.
 *
 * ── O que esta suite prova, e por que as outras nao provavam ────────
 *
 * As suites do I3B exercitam `sincronizarPerguntas` com um executor
 * FALSO. Isso prova a fiacao do servico e nada sobre a idempotencia de
 * Funcao: um duplo confirma o que ele mesmo definiu. Aqui a chave sai do
 * servico, atravessa o `executarFuncao` REAL, o guard REAL, a cobertura
 * remota REAL, `registrarAbertura` REAL, e termina no indice UNIQUE REAL
 * de `agente_funcao_chamadas`.
 *
 * O unico sistema falso e o EXTERNO.
 *
 * ── A fronteira, e ela e fail-closed ────────────────────────────────
 *
 * `globalThis.fetch` e substituido por um interceptador deterministico.
 * Os dois pontos que fazem rede — `confirmarCoberturaML` e o adapter de
 * perguntas — leem `fetch` no momento da CHAMADA (`portas?.buscar ??
 * fetch`), entao trocar o global alcanca os dois sem tocar em codigo de
 * producao.
 *
 * URL que nao esteja na lista curta NAO sai: o interceptador lanca e
 * conta. "Confiar que o fetch nao vai rodar" nao e cerca.
 *
 * ── Fixtures sinteticos, zero dado real ─────────────────────────────
 *
 * Dono, agente, loja ML, permissao `automatico`, binding e credencial
 * sao criados aqui, no banco local descartavel. Nenhum id de producao,
 * nenhum token real, nenhuma linha comercial. `ML_CLIENT_ID` recebe um
 * valor sintetico no processo — o de producao nunca e lido.
 *
 * Rodar:
 *   NEXT_PUBLIC_SUPABASE_URL="http://127.0.0.1:54321" \
 *   SUPABASE_SERVICE_ROLE_KEY="<local>" \
 *   QUESTION_INBOX_TEST_DATABASE_URL="postgresql://...54322/postgres" \
 *     npx tsx scripts/testar-agentes-ingestao-pagina-idempotencia-banco.ts --confirmo
 */
import "./_server-only-inerte";

import { Client } from "pg";

// ─── Cercas, ANTES de qualquer import que fale com o mundo ────────────

const HOSTS_LOCAIS = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0"]);

function conferirAmbiente(): { onde: string } {
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
  return { onde: `${alvo.hostname}:${alvo.port}` };
}

// ─── A fronteira externa ──────────────────────────────────────────────

/**
 * O app sintetico. Ele existe para que `confirmarCoberturaML` tenha o
 * que comparar com `app_id` na resposta do grant; o `ML_CLIENT_ID` de
 * producao NAO e lido, e o valor daqui nao identifica aplicacao nenhuma.
 */
const APP_SINTETICO = "app-sintetico-i3c";
process.env.ML_CLIENT_ID = APP_SINTETICO;

const BASE_ML = "https://api.mercadolibre.com";
const URL_GRANT = /^https:\/\/api\.mercadolibre\.com\/users\/[^/]+\/applications$/;
const URL_PERGUNTAS = `${BASE_ML}/my/received_questions/search`;

interface Contadores {
  grant: number;
  perguntas: number;
  /** Trafego para a propria stack local. Nao e rede externa. */
  locais: number;
  inesperadas: number;
  /** As URLs recusadas, para o detalhe do FAIL. */
  recusadas: string[];
  /** O `offset` de cada busca, na ordem — prova que a janela avancou. */
  offsets: string[];
}

const chamadas: Contadores = {
  grant: 0, perguntas: 0, locais: 0, inesperadas: 0, recusadas: [], offsets: [],
};

/** Uma pergunta bruta do provider, na forma que `normalizarPergunta` le. */
const perguntaBruta = (id: string) => ({
  id,
  item_id: "MLB-SINTETICO",
  text: "Esta pergunta e sintetica.",
  status: "UNANSWERED",
  date_created: "2026-09-20T10:00:00.000-04:00",
});

const resposta = (corpo: unknown, status = 200): Response =>
  new Response(JSON.stringify(corpo), {
    status,
    headers: { "content-type": "application/json" },
  });

/**
 * O interceptador. FAIL-CLOSED para o que e EXTERNO.
 *
 * ── Por que trafego local ATRAVESSA ────────────────────────────────
 *
 * `supabase-js` tambem fala por `fetch`, e o PostgREST desta stack mora
 * em `127.0.0.1`. Bloquear tudo transformaria a fronteira de REDE numa
 * fronteira de BANCO, e o que precisa ser provado e o oposto: o banco e
 * real, o mundo externo e que nao existe. Entao host local delega ao
 * `fetch` original, e qualquer host de fora que nao seja uma das duas
 * URLs previstas do Mercado Livre LANCA e e contado.
 */
const FETCH_ORIGINAL = globalThis.fetch;

function ehLocal(alvo: string): boolean {
  try {
    return HOSTS_LOCAIS.has(new URL(alvo).hostname);
  } catch {
    return false;
  }
}

function instalarFronteira(): void {
  globalThis.fetch = (async (entrada: unknown, init?: unknown): Promise<Response> => {
    const alvo = typeof entrada === "string"
      ? entrada
      : entrada instanceof URL
        ? entrada.toString()
        : String((entrada as { url?: unknown })?.url ?? "");

    // A propria stack local. Nao e mundo externo, e nao e o que este
    // gate mede.
    if (ehLocal(alvo)) {
      chamadas.locais += 1;
      return FETCH_ORIGINAL(entrada as RequestInfo, init as RequestInit);
    }

    if (URL_GRANT.test(alvo)) {
      chamadas.grant += 1;
      // O grant que o confirmador espera: a NOSSA aplicacao com `read`.
      return resposta([{ app_id: APP_SINTETICO, scopes: ["read", "offline_access"] }]);
    }

    if (alvo.startsWith(URL_PERGUNTAS)) {
      chamadas.perguntas += 1;
      chamadas.offsets.push(new URL(alvo).searchParams.get("offset") ?? "?");
      return resposta({ questions: [perguntaBruta("Q-SINTETICA")], total: 1 });
    }

    chamadas.inesperadas += 1;
    chamadas.recusadas.push(alvo.slice(0, 120));
    throw new Error("FRONTEIRA: requisicao externa nao prevista foi bloqueada");
  }) as typeof fetch;
}

instalarFronteira();

// ─── Imports que tocam `lib/` vem DEPOIS da fronteira ─────────────────

import { executarFuncao } from "@/lib/agentes/execucao-funcoes/executar";
import { FUNCAO_ID as FUNCAO_PERGUNTAS_ML } from "@/lib/agentes/handlers/consultar-perguntas-ml-contrato";
import { acoesRegistradas, resolverAcao } from "@/lib/agentes/acoes/catalogo";
import {
  chaveDaPagina,
  sincronizarPerguntas,
  ACAO_SINCRONIZAR_PERGUNTAS,
  type PortasSincronizacao,
} from "@/lib/agentes/ingestao/sincronizar-perguntas";
import {
  registrarAberturaAcao,
  registrarDesfechoAcao,
} from "@/lib/agentes/acoes/auditoria-acao";
import { gravarPerguntasNaInbox } from "@/lib/agentes/dados/perguntas-inbox";
import { lerAgenteParaAcaoInterna } from "@/lib/agentes/capability-worker";

// ─── Fixtures ─────────────────────────────────────────────────────────

const DONO = "aaaaaaaa-0000-4000-8000-0000000013c1";
const AGENTE = "11111111-1111-4111-8111-0000000013c2";
const LOJA = "cccccccc-0000-4000-8000-0000000013c3";
const SELLER = "999000111";

let passou = 0;
let falhou = 0;
const ok = (nome: string, cond: boolean, det = ""): void => {
  if (cond) { passou += 1; console.log(`  PASS  ${nome}`); }
  else { falhou += 1; console.log(`  FAIL  ${nome}${det ? `  — ${det}` : ""}`); }
};
const secao = (t: string) =>
  console.log(`\n── ${t} ${"─".repeat(Math.max(2, 58 - t.length))}`);

/** A chave da tentativa, no formato CONGELADO do I3B. */
const chaveDaTentativa = (tentativa: string): string =>
  `n8n:${tentativa}:${ACAO_SINCRONIZAR_PERGUNTAS}:${AGENTE}`;

async function main(): Promise<void> {
  const { onde } = conferirAmbiente();
  console.log("\n══ CDS IA — idempotencia da PAGINA, ponta a ponta (I3C) ══");
  console.log(`  alvo = ${onde}   (chaves nunca impressas)`);

  const pg = new Client({ connectionString: process.env.QUESTION_INBOX_TEST_DATABASE_URL });
  await pg.connect();
  await pg.query("set statement_timeout = 30000");

  /** As aberturas de FUNCAO com uma chave. E o indice que decide. */
  const aberturasCom = async (chave: string) =>
    Number((await pg.query(
      `select count(*)::int as n from public.agente_funcao_chamadas
        where idempotency_key = $1 and fase = 'abertura'`, [chave])).rows[0].n);
  const linhasCom = async (chave: string) =>
    (await pg.query(
      `select fase, status, codigo_desfecho, funcao_id, loja_id::text as loja_id
         from public.agente_funcao_chamadas where idempotency_key = $1`,
      [chave])).rows as Array<Record<string, unknown>>;
  const desfechosDoRequest = async (requestId: string) =>
    (await pg.query(
      `select fase, status from public.agente_funcao_chamadas
        where request_id = $1 order by fase desc`, [requestId])).rows as Array<Record<string, unknown>>;

  try {
    // ── Fixtures sinteticos ─────────────────────────────────────────
    await pg.query("delete from public.agente_acao_execucoes where user_id = $1", [DONO]);
    await pg.query("delete from public.agente_funcao_chamadas where user_id = $1", [DONO]);
    await pg.query("delete from public.agente_perguntas_ml where user_id = $1", [DONO]);
    await pg.query("delete from public.agente_conexoes where user_id = $1", [DONO]);
    await pg.query("delete from public.agente_permissoes where user_id = $1", [DONO]);
    await pg.query("delete from public.lojas where id = $1::uuid", [LOJA]);
    await pg.query("delete from public.agentes where id = $1::uuid", [AGENTE]);

    await pg.query(
      `insert into public.agentes (id, user_id, nome, tipo, ativo)
       values ($1::uuid, $2, 'AGENTE SINTETICO I3C', 'mensagens', true)`, [AGENTE, DONO]);

    // A credencial e sintetica e o token nao vale nada: a unica coisa
    // que ele faz e virar um header que o interceptador ignora.
    await pg.query(
      `insert into public.lojas
         (id, nome, marketplace, user_id, ativo, access_token, refresh_token,
          seller_id, nickname, token_expires_at)
       values ($1::uuid, 'ML SINTETICA I3C', 'ML', $2, true,
               'token-sintetico-sem-valor', 'refresh-sintetico',
               $3, 'ML SINTETICA', now() + interval '30 days')`,
      [LOJA, DONO, SELLER]);

    await pg.query(
      `insert into public.agente_permissoes (agente_id, user_id, funcao_id, nivel)
       values ($1::uuid, $2, $3, 'automatico')`,
      [AGENTE, DONO, FUNCAO_PERGUNTAS_ML]);

    await pg.query(
      `insert into public.agente_conexoes
         (agente_id, user_id, plataforma, recurso, loja_id)
       values ($1::uuid, $2, 'mercado_livre', 'perguntas', $3::uuid)`,
      [AGENTE, DONO, LOJA]);

    // =================================================================
    secao("E. A chave que o SERVICO deriva chega ao executor REAL");
    // =================================================================

    const TENTATIVA_1 = "i3c-tentativa-1";
    const ACTION_KEY = chaveDaTentativa(TENTATIVA_1);
    const PAGE_0 = chaveDaPagina(ACTION_KEY, 0);
    const PAGE_1 = chaveDaPagina(ACTION_KEY, 1);

    /** O que o executor REAL recebeu. Nada e substituido: o wrapper
     *  anota e delega. */
    const capturadas: string[] = [];
    const portasReais: PortasSincronizacao = {
      lerAgente: lerAgenteParaAcaoInterna,
      executar: async (entrada) => {
        capturadas.push(entrada.idempotencyKey ?? "<ausente>");
        // DELEGA ao executor de producao. E este o ponto do gate.
        return executarFuncao(entrada);
      },
      gravar: gravarPerguntasNaInbox,
      abrirAcao: registrarAberturaAcao,
      fecharAcao: registrarDesfechoAcao,
    };

    const r = await sincronizarPerguntas(
      { agenteId: AGENTE, idempotencyKey: ACTION_KEY }, portasReais);

    ok("E1  o servico entregou ao executor REAL a chave `<ACAO>:p0`",
      capturadas.length === 1 && capturadas[0] === PAGE_0,
      capturadas.join(","));
    ok("E1b e a varredura terminou pelo caminho de producao",
      r.tipo === "sincronizado" || r.tipo === "backlog_truncado",
      r.tipo);

    const linhasP0 = await linhasCom(PAGE_0);
    ok("E2  a MESMA chave esta em `agente_funcao_chamadas` como abertura",
      linhasP0.length === 1 && linhasP0[0].fase === "abertura"
      && linhasP0[0].funcao_id === FUNCAO_PERGUNTAS_ML
      && linhasP0[0].loja_id === LOJA,
      JSON.stringify(linhasP0));

    ok("E3  o provider foi consultado EXATAMENTE uma vez",
      chamadas.perguntas === 1, String(chamadas.perguntas));
    ok("E3b a cobertura remota tambem rodou de verdade",
      chamadas.grant === 1, String(chamadas.grant));

    // =================================================================
    secao("F. A MESMA pagina, de novo — o indice decide");
    // =================================================================

    const perguntasAntes = chamadas.perguntas;
    const grantAntes = chamadas.grant;

    const replay = await executarFuncao({
      userId: DONO,
      agenteId: AGENTE,
      funcaoId: FUNCAO_PERGUNTAS_ML,
      argumentos: { status: "UNANSWERED", limite: 50, deslocamento: 0 },
      idempotencyKey: PAGE_0,
    });

    ok("E4  o provider NAO foi consultado de novo",
      chamadas.perguntas === perguntasAntes, String(chamadas.perguntas - perguntasAntes));
    ok("E5  o executor REAL classificou como falha de auditoria duplicada",
      replay.tipo === "falha_auditoria"
      && replay.etapa === "abertura"
      && replay.motivo === "duplicada",
      replay.tipo === "falha_auditoria" ? `${replay.etapa}/${replay.motivo ?? "-"}` : replay.tipo);
    ok("E6  continua havendo UMA unica abertura com aquela chave",
      (await aberturasCom(PAGE_0)) === 1, String(await aberturasCom(PAGE_0)));
    ok("E6b a tentativa duplicada nao deixou desfecho proprio",
      (await desfechosDoRequest(replay.requestId)).length === 0);
    ok("E6c a cobertura remota roda ANTES da abertura, e por isso foi paga",
      chamadas.grant === grantAntes + 1,
      `grant ${grantAntes} -> ${chamadas.grant}`);

    // =================================================================
    secao("G. Pagina DIFERENTE e tentativa DIFERENTE");
    // =================================================================

    {
      const antes = chamadas.perguntas;
      const r1 = await executarFuncao({
        userId: DONO,
        agenteId: AGENTE,
        funcaoId: FUNCAO_PERGUNTAS_ML,
        argumentos: { status: "UNANSWERED", limite: 50, deslocamento: 50 },
        idempotencyKey: PAGE_1,
      });
      ok("E7  `p1` executa por conta propria", r1.tipo === "sucesso", r1.tipo);
      ok("E7b e o provider foi consultado de novo",
        chamadas.perguntas === antes + 1, String(chamadas.perguntas - antes));
      ok("E8  as duas chaves de pagina sao distintas e coexistem",
        PAGE_0 !== PAGE_1
        && (await aberturasCom(PAGE_0)) === 1 && (await aberturasCom(PAGE_1)) === 1);
      ok("E8b o deslocamento pedido chegou ao provider",
        chamadas.offsets.includes("50"), chamadas.offsets.join(","));
    }

    {
      const ACTION_KEY_2 = chaveDaTentativa("i3c-tentativa-2");
      const PAGE_0_2 = chaveDaPagina(ACTION_KEY_2, 0);
      const antes = chamadas.perguntas;
      const r2 = await executarFuncao({
        userId: DONO,
        agenteId: AGENTE,
        funcaoId: FUNCAO_PERGUNTAS_ML,
        argumentos: { status: "UNANSWERED", limite: 50, deslocamento: 0 },
        idempotencyKey: PAGE_0_2,
      });
      ok("E9  `p0` de OUTRA tentativa executa — a camada nao confunde as duas",
        r2.tipo === "sucesso" && chamadas.perguntas === antes + 1,
        `${r2.tipo} / ${chamadas.perguntas - antes}`);
      ok("E10 a chave da pagina preserva o prefixo da tentativa",
        PAGE_0_2.startsWith(`n8n:i3c-tentativa-2:${ACAO_SINCRONIZAR_PERGUNTAS}:`)
        && PAGE_0_2.endsWith(":p0")
        && PAGE_0_2 !== PAGE_0);
      ok("E10b e as tres aberturas convivem, uma por chave",
        (await aberturasCom(PAGE_0)) === 1
        && (await aberturasCom(PAGE_1)) === 1
        && (await aberturasCom(PAGE_0_2)) === 1);
    }

    // =================================================================
    secao("H. Disputa real pela MESMA pagina");
    // =================================================================

    {
      // Duas invocacoes concorrentes da mesma chave. Nao ha como
      // observar o lock aqui, e a razao e estrutural: `registrarAbertura`
      // e um INSERT autonomo, confirmado pelo PostgREST na hora, sem
      // transacao aberta que o teste possa segurar. A janela de espera
      // dura microssegundos. O que se prova entao e o DESFECHO da
      // disputa — uma vencedora, uma duplicada, UMA ida ao provider.
      const CHAVE_DISPUTA = chaveDaPagina(chaveDaTentativa("i3c-disputa"), 0);
      const antes = chamadas.perguntas;
      const pedido = () => executarFuncao({
        userId: DONO,
        agenteId: AGENTE,
        funcaoId: FUNCAO_PERGUNTAS_ML,
        argumentos: { status: "UNANSWERED", limite: 50, deslocamento: 0 },
        idempotencyKey: CHAVE_DISPUTA,
      });

      const [a, b] = await Promise.all([pedido(), pedido()]);
      const tipos = [a.tipo, b.tipo].sort().join("+");

      ok("H1  exatamente UMA das duas executou",
        [a.tipo, b.tipo].filter((t) => t === "sucesso").length === 1, tipos);
      ok("H2  a outra caiu no caminho de duplicada do executor REAL",
        [a, b].some((x) => x.tipo === "falha_auditoria" && x.motivo === "duplicada"), tipos);
      ok("H3  o provider foi consultado UMA vez pelas duas juntas",
        chamadas.perguntas === antes + 1, String(chamadas.perguntas - antes));
      ok("H4  e o banco guarda UMA abertura para aquela chave",
        (await aberturasCom(CHAVE_DISPUTA)) === 1);
    }

    // =================================================================
    secao("I. As tres camadas, e o mundo externo");
    // =================================================================

    {
      const acoes = Number((await pg.query(
        "select count(*)::int as n from public.agente_acao_execucoes where user_id = $1",
        [DONO])).rows[0].n);
      const funcoes = Number((await pg.query(
        "select count(*)::int as n from public.agente_funcao_chamadas where user_id = $1 and fase='abertura'",
        [DONO])).rows[0].n);
      const inbox = Number((await pg.query(
        "select count(*)::int as n from public.agente_perguntas_ml where user_id = $1",
        [DONO])).rows[0].n);
      ok("I1  camada ACAO: a varredura produziu abertura e desfecho",
        acoes === 2, String(acoes));
      ok("I2  camada FUNCAO: uma abertura por chave de pagina distinta",
        funcoes === 4, String(funcoes));
      ok("I3  camada DOMINIO: a mesma pergunta continua sendo UMA linha",
        inbox === 1, String(inbox));
    }

    ok("E11 NENHUMA requisicao externa inesperada saiu do processo",
      chamadas.inesperadas === 0, chamadas.recusadas.join(" | "));
    ok("E11b so as duas URLs previstas do Mercado Livre foram tocadas",
      chamadas.grant > 0 && chamadas.perguntas > 0);
    ok("E13 o MAIN generico continua sem alcancar `sincronizar_perguntas`",
      resolverAcao(ACAO_SINCRONIZAR_PERGUNTAS) === null
      && !acoesRegistradas().includes(ACAO_SINCRONIZAR_PERGUNTAS),
      acoesRegistradas().join(","));
  } finally {
    await pg.query("delete from public.agente_acao_execucoes where user_id = $1", [DONO]);
    await pg.query("delete from public.agente_funcao_chamadas where user_id = $1", [DONO]);
    await pg.query("delete from public.agente_perguntas_ml where user_id = $1", [DONO]);
    await pg.query("delete from public.agente_conexoes where user_id = $1", [DONO]);
    await pg.query("delete from public.agente_permissoes where user_id = $1", [DONO]);
    await pg.query("delete from public.lojas where id = $1::uuid", [LOJA]);
    await pg.query("delete from public.agentes where id = $1::uuid", [AGENTE]);
    await pg.end();
  }

  console.log(`\n── placar ${"─".repeat(54)}`);
  console.log(`  PASS ${passou}   FAIL ${falhou}`);
  console.log(`  provider: grant ${chamadas.grant}, perguntas ${chamadas.perguntas}`);
  console.log(`  local: ${chamadas.locais}   externas inesperadas: ${chamadas.inesperadas}`);
  if (falhou > 0) process.exitCode = 1;
}

main().catch((e: unknown) => {
  const erro = e as { code?: string; message?: string };
  console.log(`\nERRO: ${erro.code ?? ""} ${erro.message ?? String(e)}`);
  process.exit(2);
});
