/**
 * `agente_perguntas_ml` — CASO 15: concorrencia REAL, duas sessoes.
 *
 * Os outros 23 casos cabem numa transacao com `rollback`. Este nao cabe:
 * o que se prova aqui e o que acontece quando duas sessoes disputam a
 * MESMA chave natural, e disputa exige transacoes separadas.
 *
 *   C1  payload IDENTICO            -> perdedora REOBSERVADA
 *   C2  mutavel DIFERENTE           -> perdedora ATUALIZADA
 *   C3A anuncio_id_externo DIVERGE  -> perdedora FALHA FECHADA (22023)
 *   C3B criada_em_provider DIVERGE  -> perdedora FALHA FECHADA (22023)
 *   C4  lote com uma divergente     -> LOTE INTEIRO falha
 *
 * ── O oraculo e EXATO, de proposito ─────────────────────────────────
 *
 * Uma versao anterior deste harness aceitava `atualizadas + reobservadas
 * === 1` na perdedora. Isso deu PASS a um defeito real: sob disputa, a
 * leitura previa nao enxergava a linha que a vencedora criara, e um
 * payload IDENTICO era classificado como `atualizada`. Um oraculo que
 * aceita duas respostas opostas nao e oraculo. Aqui cada uma das seis
 * metricas tem valor fixado.
 *
 * ── Onde roda ───────────────────────────────────────────────────────
 *
 * SOMENTE num Postgres local descartavel. A conexao vem de
 * `QUESTION_INBOX_TEST_DATABASE_URL` — nunca de `DATABASE_URL`, que e a
 * variavel de producao da aplicacao. O host precisa ser local, e a flag
 * `--confirmo` e obrigatoria. Este script ESCREVE e COMMITA fixtures:
 * sem essas cercas ele poderia gravar em producao.
 *
 * Rodar:
 *   QUESTION_INBOX_TEST_DATABASE_URL="postgresql://.../postgres" \
 *     npx tsx scripts/testar-agentes-perguntas-inbox-concorrencia.ts --confirmo
 */
import { Client } from "pg";

// ── Cercas ────────────────────────────────────────────────────────────

const VARIAVEL = "QUESTION_INBOX_TEST_DATABASE_URL";
const HOSTS_LOCAIS = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0"]);
const TEMPO_MAXIMO_MS = 5 * 60 * 1000;

/** Allowlist, nao blocklist: hospedeiro desconhecido e recusado. */
function conexaoConferida(): { url: string; onde: string } {
  if (!process.argv.includes("--confirmo")) {
    throw new Error("falta --confirmo: este script escreve e commita fixtures");
  }
  const url = process.env[VARIAVEL];
  if (!url) {
    throw new Error(
      `${VARIAVEL} ausente. NAO existe fallback para DATABASE_URL: ` +
      "essa e a variavel de producao da aplicacao.");
  }
  let alvo: URL;
  try {
    alvo = new URL(url);
  } catch {
    throw new Error(`${VARIAVEL} nao e uma URL valida`);
  }
  if (!HOSTS_LOCAIS.has(alvo.hostname)) {
    // O valor NUNCA e impresso; so o hospedeiro, que nao e segredo.
    throw new Error(
      `hospedeiro "${alvo.hostname}" nao e local. Este harness so roda ` +
      "contra banco efemero local.");
  }
  const banco = alvo.pathname.replace(/^\//, "") || "(padrao)";
  return { url, onde: `${alvo.hostname}:${alvo.port || "5432"}/${banco}` };
}

// ── Fixtures sinteticos ───────────────────────────────────────────────

const DONO = "aaaaaaaa-0000-4000-8000-00000000c115";
const LOJA = "cccccccc-0000-4000-8000-00000000c115";

type Pergunta = {
  id_externo: string;
  anuncio_id_externo: string;
  texto: string;
  provider_status: string;
  criada_em_provider: string;
};

const q = (
  id: string, anuncio: string, texto: string,
  criada = "2026-09-23T12:00:00Z", status = "UNANSWERED",
): Pergunta => ({
  id_externo: id, anuncio_id_externo: anuncio, texto,
  provider_status: status, criada_em_provider: criada,
});

type Metricas = Record<string, number>;
type Falha = { code: string; message: string };

const espera = (ms: number) => new Promise((r) => setTimeout(r, ms));

let passou = 0;
let falhou = 0;
function ok(nome: string, condicao: boolean, detalhe = ""): void {
  if (condicao) { passou += 1; console.log(`  PASS  ${nome}`); }
  else { falhou += 1; console.log(`  FAIL  ${nome}${detalhe ? `  — ${detalhe}` : ""}`); }
}

async function comTimeouts(c: Client, statementMs: number, lockMs: number): Promise<void> {
  await c.query(`set statement_timeout = ${statementMs}`);
  await c.query(`set lock_timeout = ${lockMs}`);
  await c.query("set idle_in_transaction_session_timeout = 60000");
}

const chamar = (c: Client, lote: Pergunta[]) =>
  c.query<{ m: Metricas }>(
    "select public.agente_perguntas_ml_upsert_lote($1, $2::uuid, $3::jsonb) as m",
    [DONO, LOJA, JSON.stringify(lote)]);

type Disputa = {
  lock: boolean;
  esperaVista: string;
  mA: Metricas | null;
  mB: Metricas | null;
  falhaB: Falha | null;
};

/**
 * A abre a transacao e NAO commita; B tenta a mesma chave natural. Uma
 * terceira conexao observa `pg_stat_activity`: sem espera de `Lock`
 * observada, nao houve disputa e o caso e INVALIDO — nunca PASS.
 */
async function disputar(
  rotulo: string, A: Client, B: Client, C: Client, pidB: number,
  loteA: Pergunta[], loteB: Pergunta[],
): Promise<Disputa> {
  console.log(`\n── ${rotulo} ${"─".repeat(Math.max(2, 52 - rotulo.length))}`);

  await A.query("begin");
  const mA = (await chamar(A, loteA)).rows[0].m;
  console.log(`  A (transacao ABERTA): ${JSON.stringify(mA)}`);

  await B.query("begin");
  const promessaB = chamar(B, loteB);
  let erroB: unknown = null;
  promessaB.catch((e) => { erroB = e; });

  let esperaVista = "";
  for (let i = 0; i < 40; i += 1) {
    await espera(250);
    const r = await C.query<{ wait_event_type: string | null; wait_event: string | null }>(
      "select wait_event_type, wait_event from pg_stat_activity where pid = $1", [pidB]);
    const l = r.rows[0];
    if (l && l.wait_event_type === "Lock") {
      esperaVista = `${l.wait_event_type}/${l.wait_event}`;
      break;
    }
    if (erroB) break;
  }
  console.log(esperaVista
    ? `  B BLOQUEADA: ${esperaVista}`
    : "  B NAO foi observada em espera de Lock");

  await A.query("commit");

  let mB: Metricas | null = null;
  let falhaB: Falha | null = null;
  try {
    mB = (await promessaB).rows[0].m;
    console.log(`  B destravou OK:       ${JSON.stringify(mB)}`);
    await B.query("commit");
  } catch (e) {
    const erro = e as { code?: string; message?: string };
    falhaB = { code: erro.code ?? "", message: String(erro.message ?? "").slice(0, 120) };
    console.log(`  B FALHOU: SQLSTATE=${falhaB.code} ${falhaB.message}`);
    try { await B.query("rollback"); } catch { /* transacao ja abortada */ }
  }
  return { lock: esperaVista !== "", esperaVista, mA, mB, falhaB };
}

/** Todas as seis metricas fixadas. Nada de "uma das duas serve". */
function metricasSao(m: Metricas | null, esperado: Metricas): boolean {
  if (m === null) return false;
  return Object.entries(esperado).every(([k, v]) => Number(m[k]) === v);
}

const DIVERGENCIA = "identidade_do_provider_divergente";
const falhouPorIdentidade = (d: Disputa): boolean =>
  d.falhaB !== null && d.falhaB.code === "22023" && d.falhaB.message.includes(DIVERGENCIA);

async function main(): Promise<void> {
  const { url, onde } = conexaoConferida();
  console.log("\n══ CDS IA — agente_perguntas_ml: CASO 15, concorrencia real ══");
  console.log(`  alvo = ${onde}   (valor de ${VARIAVEL} nunca e impresso)`);

  const A = new Client({ connectionString: url });
  const B = new Client({ connectionString: url });
  const C = new Client({ connectionString: url });
  await Promise.all([A.connect(), B.connect(), C.connect()]);

  try {
    await comTimeouts(A, 20000, 5000);
    await comTimeouts(B, 40000, 30000);   // B precisa poder ESPERAR por A
    await comTimeouts(C, 10000, 5000);

    const pidB = (await B.query<{ p: number }>("select pg_backend_pid() as p")).rows[0].p;

    const linhaDe = async (id: string) => {
      const r = await C.query<{
        anuncio_id_externo: string; texto: string;
        provider_status: string; criada_em_provider: Date; estado_interno: string;
      }>(`select anuncio_id_externo, texto, provider_status, criada_em_provider, estado_interno
            from public.agente_perguntas_ml where loja_id = $1::uuid and id_externo = $2`,
        [LOJA, id]);
      return r.rows[0] ?? null;
    };
    const quantas = async (id: string) =>
      (await C.query<{ n: string }>(
        "select count(*) as n from public.agente_perguntas_ml where loja_id = $1::uuid and id_externo = $2",
        [LOJA, id])).rows[0].n;

    // A loja precisa estar COMMITADA: as duas sessoes tem de enxergar o
    // mesmo tenant antes da corrida.
    await C.query("delete from public.agente_perguntas_ml where loja_id = $1::uuid", [LOJA]);
    await C.query("delete from public.lojas where id = $1::uuid", [LOJA]);
    await C.query(
      `insert into public.lojas (id, nome, marketplace, user_id, ativo)
       values ($1::uuid, 'ML CONCORRENCIA', 'ML', $2, true)`, [LOJA, DONO]);

    try {
      // ── C1 ──────────────────────────────────────────────────────────
      const c1 = await disputar("C1 · payload IDENTICO", A, B, C, pidB,
        [q("Q-C1", "MLB-C1", "Texto igual nos dois lados.")],
        [q("Q-C1", "MLB-C1", "Texto igual nos dois lados.")]);
      ok("C1  disputa real observada", c1.lock, c1.esperaVista);
      ok("C1  vencedora insere", metricasSao(c1.mA,
        { recebidas: 1, unicas: 1, duplicadas_no_lote: 0, novas: 1, atualizadas: 0, reobservadas: 0 }),
        JSON.stringify(c1.mA));
      ok("C1  perdedora e REOBSERVADA, nunca atualizada", metricasSao(c1.mB,
        { recebidas: 1, unicas: 1, duplicadas_no_lote: 0, novas: 0, atualizadas: 0, reobservadas: 1 }),
        JSON.stringify(c1.mB));
      ok("C1  uma unica linha final", (await quantas("Q-C1")) === "1");

      // ── C2 ──────────────────────────────────────────────────────────
      const c2 = await disputar("C2 · mutavel DIFERENTE", A, B, C, pidB,
        [q("Q-C2", "MLB-C2", "Texto A")],
        [q("Q-C2", "MLB-C2", "Texto B")]);
      ok("C2  disputa real observada", c2.lock, c2.esperaVista);
      ok("C2  vencedora insere", metricasSao(c2.mA,
        { recebidas: 1, unicas: 1, duplicadas_no_lote: 0, novas: 1, atualizadas: 0, reobservadas: 0 }),
        JSON.stringify(c2.mA));
      ok("C2  perdedora e ATUALIZADA, nunca reobservada", metricasSao(c2.mB,
        { recebidas: 1, unicas: 1, duplicadas_no_lote: 0, novas: 0, atualizadas: 1, reobservadas: 0 }),
        JSON.stringify(c2.mB));
      ok("C2  o valor mutavel da perdedora prevalece",
        (await linhaDe("Q-C2"))?.texto === "Texto B");
      ok("C2  uma unica linha final", (await quantas("Q-C2")) === "1");

      // ── C3A ─────────────────────────────────────────────────────────
      const c3a = await disputar("C3A · anuncio_id_externo DIVERGE", A, B, C, pidB,
        [q("Q-C3A", "ITEM-A", "Texto A")],
        [q("Q-C3A", "ITEM-B", "Texto B")]);
      const l3a = await linhaDe("Q-C3A");
      ok("C3A disputa real observada", c3a.lock, c3a.esperaVista);
      ok("C3A perdedora FALHA FECHADA com 22023", falhouPorIdentidade(c3a),
        JSON.stringify(c3a.falhaB));
      ok("C3A a identidade gravada continua a da vencedora",
        l3a?.anuncio_id_externo === "ITEM-A");
      ok("C3A ZERO contaminacao do conteudo da perdedora", l3a?.texto === "Texto A");
      ok("C3A uma unica linha final", (await quantas("Q-C3A")) === "1");

      // ── C3B ─────────────────────────────────────────────────────────
      const c3b = await disputar("C3B · criada_em_provider DIVERGE", A, B, C, pidB,
        [q("Q-C3B", "MLB-C3B", "Texto A", "2026-09-23T12:00:00Z")],
        [q("Q-C3B", "MLB-C3B", "Texto B", "2026-09-23T13:00:00Z")]);
      const l3b = await linhaDe("Q-C3B");
      ok("C3B disputa real observada", c3b.lock, c3b.esperaVista);
      ok("C3B perdedora FALHA FECHADA com 22023", falhouPorIdentidade(c3b),
        JSON.stringify(c3b.falhaB));
      ok("C3B `criada_em_provider` continua a da vencedora",
        l3b?.criada_em_provider?.toISOString() === "2026-09-23T12:00:00.000Z");
      ok("C3B ZERO contaminacao do conteudo da perdedora", l3b?.texto === "Texto A");

      // ── C4 ──────────────────────────────────────────────────────────
      const c4 = await disputar("C4 · LOTE com divergente + valida", A, B, C, pidB,
        [q("Q-C4-CONF", "ITEM-A", "Texto A")],
        [q("Q-C4-CONF", "ITEM-B", "Texto B"),
         q("Q-C4-VALID", "MLB-C4V", "Entraria sozinha, sem problema.")]);
      ok("C4  disputa real observada", c4.lock, c4.esperaVista);
      ok("C4  o LOTE inteiro falha com 22023", falhouPorIdentidade(c4),
        JSON.stringify(c4.falhaB));
      ok("C4  a linha em conflito segue integralmente da vencedora",
        (await linhaDe("Q-C4-CONF"))?.texto === "Texto A");
      ok("C4  a linha VALIDA do mesmo lote tambem nao entrou",
        (await linhaDe("Q-C4-VALID")) === null);
    } finally {
      for (const c of [A, B]) {
        try { await c.query("rollback"); } catch { /* transacao ja encerrada */ }
      }
      await C.query("delete from public.agente_perguntas_ml where loja_id = $1::uuid", [LOJA]);
      await C.query("delete from public.lojas where id = $1::uuid", [LOJA]);
    }
  } finally {
    await Promise.all([A.end(), B.end(), C.end()]);
  }

  console.log(`\n── placar ${"─".repeat(54)}`);
  console.log(`  PASS ${passou}   FAIL ${falhou}`);
  console.log(`  CASO 15 = ${falhou === 0 ? "PASS" : "FAIL"}\n`);
  if (falhou > 0) process.exitCode = 1;
}

const relogio = setTimeout(() => {
  console.log("\nESTOUROU O TEMPO MAXIMO DO PROCESSO — nenhuma sessao pode ficar presa.");
  process.exit(2);
}, TEMPO_MAXIMO_MS);
relogio.unref();

main().catch((e: unknown) => {
  const erro = e as { code?: string; message?: string };
  console.log(`\nERRO: ${erro.code ?? ""} ${erro.message ?? String(e)}`);
  process.exit(2);
});
