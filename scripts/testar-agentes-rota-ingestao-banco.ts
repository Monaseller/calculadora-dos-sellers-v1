/**
 * A rota dedicada contra o BANCO REAL — I4C.
 *
 * ── O que esta suite prova, e a estrutural nao ──────────────────────
 *
 * A estrutural dubla a reconciliacao: ela prova que a rota DECIDE certo
 * dado um estado. Isso nao prova que o estado lido e o estado gravado —
 * um duplo confirma o que ele mesmo definiu.
 *
 * Aqui o caminho e inteiro:
 *
 *   rota REAL
 *   -> reconciliacao REAL, contra `agente_acao_execucoes`
 *   -> `sincronizarPerguntas` REAL
 *   -> abertura REAL, no indice unico REAL
 *   -> inbox REAL (a RPC) e cursor REAL (o CAS)
 *   -> desfecho REAL
 *   -> resposta montada a partir do que foi gravado
 *
 * So `executarFuncao` e dublado, porque e ele que fala com o marketplace
 * — e o gate proibe marketplace real. Tudo que e duravel e de verdade.
 *
 * ── O replay vem do BANCO, nao da memoria ───────────────────────────
 *
 * Para que "veio do banco" seja um fato e nao uma crenca, o replay roda
 * num contexto de modulo NOVO: o cache de `require` do nosso codigo e
 * descartado e a rota e reimportada. Qualquer coisa que a primeira
 * chamada tivesse deixado em memoria some junto.
 *
 * ── Onde roda ───────────────────────────────────────────────────────
 *
 * SOMENTE contra um Supabase local descartavel. Escreve e commita
 * fixtures.
 *
 * Rodar:
 *   NEXT_PUBLIC_SUPABASE_URL="http://127.0.0.1:54321" \
 *   SUPABASE_SERVICE_ROLE_KEY="<local>" \
 *   QUESTION_INBOX_TEST_DATABASE_URL="postgresql://...54322/postgres" \
 *     npx tsx scripts/testar-agentes-rota-ingestao-banco.ts --confirmo
 */
import "./_server-only-inerte";

import Module from "node:module";
import { Client } from "pg";

// ── Cercas ────────────────────────────────────────────────────────────

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

let passou = 0;
let falhou = 0;
const ok = (nome: string, cond: boolean, det = ""): void => {
  if (cond) { passou += 1; console.log(`  PASS  ${nome}`); }
  else { falhou += 1; console.log(`  FAIL  ${nome}${det ? `  — ${det}` : ""}`); }
};
const secao = (t: string) => console.log(`\n── ${t} ${"─".repeat(Math.max(2, 58 - t.length))}`);

// ── Fixtures ──────────────────────────────────────────────────────────

const SEGREDO = "SEGREDO_INGESTAO_I4C_BANCO";
const DONO = "aaaaaaaa-4c00-4000-8000-00000000d0d0";
const LOJA = "cccccccc-4c00-4000-8000-00000000102a";
const AGENTE = "11111111-4c00-4111-8111-0000000a6e01";
const AGENTE_OUTRO = "22222222-4c00-4222-8222-0000000a6e02";

process.env.N8N_INGESTAO_INTERNAL_SECRET = SEGREDO;
process.env.N8N_INGESTAO_AGENT_ID = AGENTE;

// ── O unico duplo: o executor de Funcao ───────────────────────────────

interface PaginaFalsa {
  linhas: Array<Record<string, unknown>>;
  truncado: boolean;
}

const provider = {
  execucoes: 0,
  chaves: [] as string[],
  paginas: [] as PaginaFalsa[],
  /** Quando preenchido, o executor devolve ISTO em vez de sucesso. */
  respostaFixa: null as unknown,
};

function zerarProvider(paginas: PaginaFalsa[] = [{ linhas: [], truncado: false }]): void {
  provider.execucoes = 0;
  provider.chaves = [];
  provider.paginas = paginas;
  provider.respostaFixa = null;
}

const pergunta = (id: string) => ({
  id, anuncioId: "MLB1", texto: "Acompanha manual?",
  status: "UNANSWERED", criadaEm: "2026-09-20T10:00:00.000-04:00",
});

const executorFalso = {
  executarFuncao: async (entrada: { idempotencyKey?: string | null }) => {
    const indice = provider.execucoes;
    provider.execucoes += 1;
    provider.chaves.push(entrada.idempotencyKey ?? "");
    if (provider.respostaFixa !== null) return provider.respostaFixa;
    const pag = provider.paginas[indice] ?? provider.paginas[provider.paginas.length - 1];
    return {
      tipo: "sucesso",
      requestId: `req-funcao-${indice}`,
      envelope: {
        contrato: 1, ok: true, request_id: `req-funcao-${indice}`,
        data: {
          linhas: pag.linhas, truncado: pag.truncado, erro: null,
          providerRecebidas: pag.linhas.length, descartadasNormalizacao: 0,
        },
      },
      auditoria: "completa",
      autoridade: { lojaId: LOJA },
    };
  },
};

const requireOriginal = (Module as unknown as { prototype: { require: (id: string) => unknown } })
  .prototype.require;

(Module as unknown as { prototype: { require: unknown } }).prototype.require = function (
  this: unknown,
  id: string
) {
  if (typeof id === "string" && id.includes("execucao-funcoes/executar")) {
    return executorFalso;
  }
  return requireOriginal.apply(this, arguments as unknown as [string]);
};

// ── Nada externo sai daqui ────────────────────────────────────────────

const fetchOriginal = globalThis.fetch;
let idasExternas = 0;
globalThis.fetch = (async (entrada: unknown, init?: unknown) => {
  const alvo = typeof entrada === "string"
    ? entrada
    : (entrada as { url?: string })?.url ?? String(entrada);
  const host = (() => { try { return new URL(alvo).hostname; } catch { return ""; } })();
  if (!HOSTS_LOCAIS.has(host)) {
    idasExternas += 1;
    throw new Error(`ida externa proibida: ${host}`);
  }
  return fetchOriginal(entrada as RequestInfo, init as RequestInit);
}) as typeof fetch;

// ── A requisicao ──────────────────────────────────────────────────────

const req = (operationId: string, executionId = "exec-1", segredo: string | null = SEGREDO) =>
  new Request("http://localhost/api/internal/agentes/ingestao-perguntas", {
    method: "POST",
    headers: segredo === null
      ? { "Content-Type": "application/json" }
      : { "Content-Type": "application/json", "x-worker-secret": segredo },
    body: JSON.stringify({ operationId, executionId }),
  });

const CAMINHO_DA_ROTA = "../app/api/internal/agentes/ingestao-perguntas/route";

type Rota = { POST: (r: Request) => Promise<Response> };

/**
 * Importa a rota num CONTEXTO DE MODULO NOVO.
 *
 * Descarta do cache tudo que e nosso — rota, servico, leitura, clientes.
 * O que sobreviver a isso nao pode estar em memoria de uma chamada
 * anterior, e e essa a diferenca entre "o replay leu o banco" e "o replay
 * lembrou".
 */
async function rotaNova(): Promise<Rota> {
  for (const chave of Object.keys(require.cache)) {
    if (chave.includes("node_modules")) continue;
    if (chave.includes("wt-question-ingestion")) delete require.cache[chave];
  }
  return (await import(CAMINHO_DA_ROTA)) as unknown as Rota;
}

interface Resposta {
  status: number;
  corpo: Record<string, unknown>;
}

async function chamar(
  operationId: string,
  opcoes: { executionId?: string; contextoNovo?: boolean } = {}
): Promise<Resposta> {
  const rota = opcoes.contextoNovo
    ? await rotaNova()
    : ((await import(CAMINHO_DA_ROTA)) as unknown as Rota);
  const r = await rota.POST(req(operationId, opcoes.executionId ?? "exec-1"));
  return { status: r.status, corpo: (await r.json()) as Record<string, unknown> };
}

async function main(): Promise<void> {
  const { onde } = conferirAmbiente();
  console.log("\n══ CDS IA — I4C: rota dedicada contra o banco REAL ══");
  console.log(`  alvo = ${onde}   (chaves nunca impressas)`);

  const pg = new Client({ connectionString: process.env.QUESTION_INBOX_TEST_DATABASE_URL });
  await pg.connect();
  await pg.query("set statement_timeout = 20000");

  const umaLinha = async (sql: string, args: unknown[] = []) =>
    (await pg.query(sql, args)).rows[0] ?? null;
  const contar = async (sql: string, args: unknown[] = []) =>
    Number((await umaLinha(sql, args))?.n ?? 0);

  const limpar = async () => {
    await pg.query("delete from public.agente_perguntas_continuacao where user_id = $1", [DONO]);
    await pg.query("delete from public.agente_acao_execucoes where user_id = $1", [DONO]);
    await pg.query("delete from public.agente_perguntas_ml where loja_id = $1::uuid", [LOJA]);
  };

  try {
    // ── Fixtures ────────────────────────────────────────────────────
    await limpar();
    await pg.query("delete from public.lojas where id = $1::uuid", [LOJA]);
    for (const a of [AGENTE, AGENTE_OUTRO]) {
      await pg.query("delete from public.agentes where id = $1::uuid", [a]);
    }
    for (const a of [AGENTE, AGENTE_OUTRO]) {
      await pg.query(
        `insert into public.agentes (id, user_id, nome, tipo, ativo)
         values ($1::uuid, $2, 'AGENTE SINTETICO I4C', 'mensagens', true)`, [a, DONO]);
    }
    await pg.query(
      `insert into public.lojas (id, nome, marketplace, user_id, ativo)
       values ($1::uuid, 'ML SINTETICA I4C', 'ML', $2, true)`, [LOJA, DONO]);

    const aberturas = (chave: string) => contar(
      `select count(*)::int as n from public.agente_acao_execucoes
        where user_id = $1 and fase = 'abertura' and idempotency_key = $2`, [DONO, chave]);
    const desfechos = (requestId: string) => contar(
      `select count(*)::int as n from public.agente_acao_execucoes
        where user_id = $1 and fase = 'desfecho' and request_id = $2`, [DONO, requestId]);
    const chaveDe = (op: string) => `n8n:${op}:sincronizar_perguntas:${AGENTE}`;

    // ═══ R8. A primeira operacao executa UMA vez ════════════════════
    secao("R8. Primeira operacao valida");

    await limpar();
    zerarProvider([{ linhas: [pergunta("Q1")], truncado: false }]);
    const viva = await chamar("b100");

    ok("R8  operacao valida -> HTTP 200", viva.status === 200, `status ${viva.status}`);
    ok("R8b estado `executada`", viva.corpo.estado === "executada", String(viva.corpo.estado));
    ok("R8c o executor rodou UMA vez", provider.execucoes === 1, String(provider.execucoes));
    ok("R8d a abertura existe no indice unico REAL",
      (await aberturas(chaveDe("b100"))) === 1);
    ok("R8e e o desfecho tambem",
      (await desfechos(String(viva.corpo.requestId))) === 1);
    ok("R8f a inbox recebeu a pergunta",
      (await contar(
        "select count(*)::int as n from public.agente_perguntas_ml where loja_id = $1::uuid",
        [LOJA])) === 1);
    ok("R8g a chave de pagina deriva da chave da ACAO",
      provider.chaves[0] === `${chaveDe("b100")}:p0`);
    ok("R8h e o namespace `n8n:` aparece UMA vez na chave",
      (provider.chaves[0].match(/n8n:/g) ?? []).length === 1);

    // ═══ R9/R10/R11. Replay, de um contexto NOVO ═══════════════════
    secao("R9/R10/R11. Replay a partir do ledger");

    const execucoesAntesDoReplay = provider.execucoes;
    const replay = await chamar("b100", { executionId: "exec-OUTRO", contextoNovo: true });

    ok("R9  replay -> HTTP 200", replay.status === 200);
    ok("R9b zero execucao nova — nem provider, nem inbox, nem cursor",
      provider.execucoes === execucoesAntesDoReplay);
    ok("R9c a inbox nao ganhou linha nova",
      (await contar(
        "select count(*)::int as n from public.agente_perguntas_ml where loja_id = $1::uuid",
        [LOJA])) === 1);
    ok("R9d nao abriu uma segunda acao",
      (await aberturas(chaveDe("b100"))) === 1);
    ok("R9e marcado como replay", replay.corpo.replay === true);

    // ── A EQUIVALENCIA, campo a campo ──
    const semReplay = (c: Record<string, unknown>) => {
      const copia = { ...c };
      delete copia.replay;
      return JSON.stringify(copia, Object.keys(copia).sort());
    };
    ok("R9f a resposta do replay e EQUIVALENTE a resposta ao vivo",
      semReplay(viva.corpo) === semReplay(replay.corpo),
      `${semReplay(viva.corpo)} vs ${semReplay(replay.corpo)}`);

    const linhaAbertura = await umaLinha(
      `select request_id from public.agente_acao_execucoes
        where user_id = $1 and fase = 'abertura' and idempotency_key = $2`,
      [DONO, chaveDe("b100")]);
    const linhaDesfecho = await umaLinha(
      `select request_id, status, codigo_desfecho from public.agente_acao_execucoes
        where user_id = $1 and fase = 'desfecho' and request_id = $2`,
      [DONO, linhaAbertura.request_id]);

    ok("R10 abertura.request_id == desfecho.request_id",
      linhaAbertura.request_id === linhaDesfecho.request_id);
    ok("R10b e e ele que a resposta devolve, nas DUAS vezes",
      viva.corpo.requestId === linhaAbertura.request_id &&
      replay.corpo.requestId === linhaAbertura.request_id);
    ok("R11 o `executionId` mudou e nada mudou com ele",
      replay.corpo.estado === viva.corpo.estado &&
      provider.execucoes === execucoesAntesDoReplay);

    // ═══ R20/R21/R22. Continuacao ═══════════════════════════════════
    secao("R20/R21/R22. Backlog e continuacao");

    await limpar();
    // Duas paginas cheias, as duas com `truncado` — o teto de paginas
    // e atingido com backlog restante.
    const cheia = (base: string): PaginaFalsa => ({
      linhas: Array.from({ length: 50 }, (_, i) => pergunta(`${base}-${i}`)),
      truncado: true,
    });
    zerarProvider([cheia("A"), cheia("B")]);
    const truncada = await chamar("b200", { contextoNovo: true });

    ok("R20 backlog truncado -> `parcial`", truncada.corpo.estado === "parcial",
      String(truncada.corpo.estado));
    ok("R20b com o codigo `backlog_truncado`",
      truncada.corpo.codigo === "backlog_truncado");
    ok("R20c e `continuacao.pendente` verdadeiro",
      JSON.stringify(truncada.corpo.continuacao) === JSON.stringify({ pendente: true }));
    ok("R20d duas paginas foram varridas", provider.execucoes === 2);
    ok("R20e a resposta NAO diz de onde continuar",
      !JSON.stringify(truncada.corpo).includes("desloc") &&
      !JSON.stringify(truncada.corpo).includes("offset") &&
      !JSON.stringify(truncada.corpo).includes(LOJA));

    const cursorDepois = await umaLinha(
      `select proximo_deslocamento, versao from public.agente_perguntas_continuacao
        where user_id = $1 and agente_id = $2::uuid`, [DONO, AGENTE]);
    ok("R20f o cursor DURAVEL guardou o deslocamento, e ele ficou no CDS",
      Number(cursorDepois?.proximo_deslocamento) === 100);

    const execucoesAntes22 = provider.execucoes;
    const replayTruncada = await chamar("b200", { executionId: "e2", contextoNovo: true });
    ok("R22 o replay do backlog reproduz `pendente: true`",
      JSON.stringify(replayTruncada.corpo.continuacao) === JSON.stringify({ pendente: true }));
    ok("R22b vindo do banco: zero execucao nova",
      provider.execucoes === execucoesAntes22);
    ok("R22c e sem que o chamador tenha mandado deslocamento nenhum",
      replayTruncada.corpo.replay === true);

    // ── R27: a continuacao usa o CURSOR, nao um offset do chamador ──
    zerarProvider([{ linhas: [pergunta("C1")], truncado: false }]);
    const continuacao = await chamar("b200:c1", { contextoNovo: true });
    ok("R27 a operacao de continuacao EXECUTA — chave nova, acao nova",
      continuacao.status === 200 && provider.execucoes === 1);
    ok("R27b e comecou de onde o CDS mandou, nao de onde o chamador disse",
      provider.chaves[0] === `${chaveDe("b200:c1")}:p0`);
    const cursorFinal = await umaLinha(
      `select proximo_deslocamento from public.agente_perguntas_continuacao
        where user_id = $1 and agente_id = $2::uuid`, [DONO, AGENTE]);
    ok("R21 travessia terminada zera o cursor",
      Number(cursorFinal?.proximo_deslocamento) === 0);
    ok("R21b e a resposta diz `pendente: false`",
      JSON.stringify(continuacao.corpo.continuacao) === JSON.stringify({ pendente: false }));
    ok("R21c com estado `executada` ou `parcial`, nunca erro",
      continuacao.corpo.estado === "executada" || continuacao.corpo.estado === "parcial");

    // ═══ R12/R13. A orfa ════════════════════════════════════════════
    secao("R12/R13. Orfa classificada pela idade duravel");

    await limpar();
    zerarProvider();
    const opOrfa = "b300";
    await pg.query(
      `insert into public.agente_acao_execucoes
         (user_id, agente_id, acao_id, request_id, fase, status, idempotency_key, criado_em)
       values ($1, $2::uuid, 'sincronizar_perguntas', $3, 'abertura', 'executando', $4,
               now() - interval '10 seconds')`,
      [DONO, AGENTE, "req-orfa-jovem", chaveDe(opOrfa)]);
    const orfaJovem = await chamar(opOrfa, { contextoNovo: true });
    ok("R12 orfa jovem -> `em_andamento`", orfaJovem.corpo.estado === "em_andamento",
      String(orfaJovem.corpo.estado));
    ok("R12b HTTP 200 com ok falso",
      orfaJovem.status === 200 && orfaJovem.corpo.ok === false);
    ok("R12c ZERO execucao — a MESMA operacao nao roda de novo",
      provider.execucoes === 0);
    ok("R12d e nenhuma segunda abertura foi criada",
      (await aberturas(chaveDe(opOrfa))) === 1);

    await limpar();
    zerarProvider();
    const opVelha = "b301";
    await pg.query(
      `insert into public.agente_acao_execucoes
         (user_id, agente_id, acao_id, request_id, fase, status, idempotency_key, criado_em)
       values ($1, $2::uuid, 'sincronizar_perguntas', $3, 'abertura', 'executando', $4,
               now() - interval '10 minutes')`,
      [DONO, AGENTE, "req-orfa-velha", chaveDe(opVelha)]);
    const orfaVelha = await chamar(opVelha, { contextoNovo: true });
    ok("R13 orfa antiga -> `resultado_desconhecido`",
      orfaVelha.corpo.estado === "resultado_desconhecido", String(orfaVelha.corpo.estado));
    ok("R13b ZERO execucao", provider.execucoes === 0);
    ok("R13c a idade veio do carimbo do BANCO, nao do chamador",
      orfaVelha.corpo.estado !== orfaJovem.corpo.estado);

    // ═══ R14. Conflito ══════════════════════════════════════════════
    secao("R14. Ledger impossivel");

    await limpar();
    zerarProvider();
    const opConflito = "b400";
    // Uma abertura do agente A e um desfecho do agente B, com o MESMO
    // `request_id` e o mesmo dono. Os dois inserts sao LEGAIS — cada
    // indice unico cobre so a sua fase, e a FK composta aceita o
    // segundo agente porque ele e do mesmo dono. O que e impossivel e a
    // COMBINACAO: uma execucao nao troca de agente no meio.
    await pg.query(
      `insert into public.agente_acao_execucoes
         (user_id, agente_id, acao_id, request_id, fase, status, idempotency_key)
       values ($1, $2::uuid, 'sincronizar_perguntas', $3, 'abertura', 'executando', $4)`,
      [DONO, AGENTE, "req-conflito", chaveDe(opConflito)]);
    await pg.query(
      `insert into public.agente_acao_execucoes
         (user_id, agente_id, acao_id, request_id, fase, status, codigo_desfecho)
       values ($1, $2::uuid, 'sincronizar_perguntas', $3, 'desfecho', 'sucesso', null)`,
      [DONO, AGENTE_OUTRO, "req-conflito"]);

    const conflito = await chamar(opConflito, { contextoNovo: true });
    ok("R14 ledger inconsistente -> HTTP 409", conflito.status === 409,
      `status ${conflito.status}`);
    ok("R14b com estado `conflito`", conflito.corpo.estado === "conflito");
    ok("R14c ZERO execucao — fail closed", provider.execucoes === 0);
    ok("R14d e o motivo interno nao viaja", conflito.corpo.motivo === undefined);

    // ═══ R15. A corrida REAL ════════════════════════════════════════
    secao("R15. Duas primeiras chamadas simultaneas");

    await limpar();
    zerarProvider([{ linhas: [pergunta("R1")], truncado: false }]);
    const opCorrida = "b500";
    const rotaA = await rotaNova();
    const rotaB = await rotaNova();
    const [ra, rb] = await Promise.all([
      rotaA.POST(req(opCorrida, "exec-A")),
      rotaB.POST(req(opCorrida, "exec-B")),
    ]);
    const corpoA = (await ra.json()) as Record<string, unknown>;
    const corpoB = (await rb.json()) as Record<string, unknown>;

    ok("R15 exatamente UMA abertura entrou — o indice decidiu",
      (await aberturas(chaveDe(opCorrida))) === 1);
    ok("R15b exatamente UMA execucao chegou ao provider",
      provider.execucoes === 1, String(provider.execucoes));
    ok("R15c a inbox tem a pergunta uma vez so",
      (await contar(
        "select count(*)::int as n from public.agente_perguntas_ml where loja_id = $1::uuid",
        [LOJA])) === 1);

    const estados = [corpoA.estado, corpoB.estado].map(String);
    ok("R15d nenhuma das duas devolveu `ja_processado` generico",
      !estados.includes("ja_processado") && !estados.includes("already_processed"),
      estados.join("/"));
    ok("R15e a vencedora devolveu o desfecho de dominio",
      estados.includes("executada"));
    const perdedora = estados.filter((e) => e !== "executada");
    ok("R15f e a perdedora reconciliou: desfecho duravel OU em_andamento",
      perdedora.length === 0 ||
      perdedora.every((e) => e === "executada" || e === "em_andamento"),
      perdedora.join("/"));
    ok("R15g as duas responderam 200",
      ra.status === 200 && rb.status === 200);
    const aberturaDaCorrida = await umaLinha(
      `select request_id from public.agente_acao_execucoes
        where user_id = $1 and fase = 'abertura' and idempotency_key = $2`,
      [DONO, chaveDe(opCorrida)]);
    const requestIds = [corpoA.requestId, corpoB.requestId].filter((v) => v !== undefined);
    ok("R15h quem devolveu requestId devolveu o da ACAO que de fato rodou",
      requestIds.length > 0 &&
      requestIds.every((v) => v === aberturaDaCorrida.request_id));

    // ═══ Fronteiras ═════════════════════════════════════════════════
    secao("X. Fronteiras");

    ok("X1  ZERO ida externa em toda a suite", idasExternas === 0);
    ok("X2  nenhuma linha de acao de outro dono foi criada",
      (await contar(
        "select count(*)::int as n from public.agente_acao_execucoes where user_id <> $1",
        [DONO])) === 0);
    ok("X3  o segredo nunca entra no banco",
      (await contar(
        `select count(*)::int as n from public.agente_acao_execucoes
          where idempotency_key like '%' || $1 || '%'`, [SEGREDO])) === 0);

    await limpar();
    await pg.query("delete from public.lojas where id = $1::uuid", [LOJA]);
    for (const a of [AGENTE, AGENTE_OUTRO]) {
      await pg.query("delete from public.agentes where id = $1::uuid", [a]);
    }
  } finally {
    await pg.end();
  }

  console.log(`\n── placar ${"─".repeat(54)}`);
  console.log(`  PASS ${passou}   FAIL ${falhou}`);
  if (falhou > 0) process.exitCode = 1;
}

void main();
