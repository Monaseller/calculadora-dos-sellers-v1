/**
 * `agente_acao_execucoes` — prova de COMPORTAMENTO contra o Postgres.
 *
 * A suite estrutural le o SQL como texto: ela prova que o arquivo diz o
 * que deve dizer, nao que o banco se comporta como o arquivo promete.
 * Constraint, indice parcial, FK composta com coluna nula e privilegio
 * sao tudo do Postgres — so ele decide.
 *
 * ── Onde roda ───────────────────────────────────────────────────────
 *
 * SOMENTE num Postgres local descartavel. Exige
 * `QUESTION_INBOX_TEST_DATABASE_URL` apontando para host local e a flag
 * `--confirmo`: esta suite ESCREVE, e a maior parte das provas depende
 * de commitar para exercitar indice unico.
 *
 * Rodar:
 *   QUESTION_INBOX_TEST_DATABASE_URL="postgresql://.../postgres" \
 *     npx tsx scripts/testar-agentes-acao-auditoria-banco.ts --confirmo
 */
import { Client } from "pg";

const HOSTS_LOCAIS = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0"]);
const TEMPO_MAXIMO_MS = 5 * 60 * 1000;

function conexaoConferida(): { url: string; onde: string } {
  if (!process.argv.includes("--confirmo")) {
    throw new Error("falta --confirmo: esta suite escreve e commita fixtures");
  }
  const url = process.env.QUESTION_INBOX_TEST_DATABASE_URL;
  if (!url) throw new Error("QUESTION_INBOX_TEST_DATABASE_URL ausente");
  const alvo = new URL(url);
  if (!HOSTS_LOCAIS.has(alvo.hostname)) {
    throw new Error(`hospedeiro "${alvo.hostname}" nao e local`);
  }
  return { url, onde: `${alvo.hostname}:${alvo.port || "5432"}` };
}

const DONO_A = "aaaaaaaa-0000-4000-8000-00000013a001";
const DONO_B = "bbbbbbbb-0000-4000-8000-00000013b001";
const AGENTE_A = "11111111-1111-4111-8111-00000013a002";
const AGENTE_B = "22222222-2222-4222-8222-00000013b002";
const LOJA_A = "cccccccc-0000-4000-8000-00000013a003";
const LOJA_B = "dddddddd-0000-4000-8000-00000013b003";
const ACAO = "sincronizar_perguntas";

let passou = 0;
let falhou = 0;
const ok = (nome: string, cond: boolean, det = ""): void => {
  if (cond) { passou += 1; console.log(`  PASS  ${nome}`); }
  else { falhou += 1; console.log(`  FAIL  ${nome}${det ? `  — ${det}` : ""}`); }
};
const secao = (t: string) => console.log(`\n── ${t} ${"─".repeat(Math.max(2, 56 - t.length))}`);

const espera = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Executa e devolve o SQLSTATE, ou `null` quando passou. */
async function sqlstate(c: Client, sql: string, args: unknown[] = []): Promise<string | null> {
  try {
    await c.query(sql, args);
    return null;
  } catch (e) {
    return (e as { code?: string }).code ?? "SEM_CODIGO";
  }
}

const INSERIR =
  `insert into public.agente_acao_execucoes
     (user_id, agente_id, loja_id, acao_id, request_id, fase, status,
      codigo_desfecho, mensagem_desfecho, idempotency_key, entrada_resumo, latencia_ms)
   values ($1,$2,$3::uuid,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12)`;

type Linha = {
  user?: string; agente?: string; loja?: string | null; acao?: string;
  request?: string; fase?: string; status?: string; codigo?: string | null;
  mensagem?: string | null; chave?: string | null; resumo?: string; latencia?: number | null;
};
const args = (l: Linha): unknown[] => [
  l.user ?? DONO_A, l.agente ?? AGENTE_A, l.loja ?? null, l.acao ?? ACAO,
  l.request ?? "req-1", l.fase ?? "abertura", l.status ?? "executando",
  l.codigo ?? null, l.mensagem ?? null,
  l.chave === undefined ? "n8n:w5m-X-a1:sincronizar_perguntas:ag" : l.chave,
  l.resumo ?? "{}", l.latencia ?? null,
];

async function main(): Promise<void> {
  const { url, onde } = conexaoConferida();
  console.log("\n══ CDS IA — agente_acao_execucoes: comportamento real ══");
  console.log(`  alvo = ${onde}   (a URL nunca e impressa)`);

  const c = new Client({ connectionString: url });
  await c.connect();
  await c.query("set statement_timeout = 20000");

  try {
    // Fixtures sinteticos: dois donos, dois agentes, duas lojas.
    await c.query("delete from public.agente_acao_execucoes where user_id in ($1,$2)", [DONO_A, DONO_B]);
    for (const [dono, agente, loja] of [
      [DONO_A, AGENTE_A, LOJA_A], [DONO_B, AGENTE_B, LOJA_B],
    ] as const) {
      await c.query("delete from public.lojas where id = $1::uuid", [loja]);
      await c.query("delete from public.agentes where id = $1::uuid", [agente]);
      await c.query(
        `insert into public.agentes (id, user_id, nome, tipo, ativo)
         values ($1::uuid, $2, 'AGENTE SINTETICO', 'mensagens', true)`, [agente, dono]);
      await c.query(
        `insert into public.lojas (id, nome, marketplace, user_id, ativo)
         values ($1::uuid, 'ML SINTETICA', 'ML', $2, true)`, [loja, dono]);
    }

    secao("M. Abertura e desfecho");

    ok("M1  abertura com `loja_id` NULL e aceita",
      (await sqlstate(c, INSERIR, args({ request: "r-m1" }))) === null);
    ok("M2  desfecho com a loja autoritativa e aceito",
      (await sqlstate(c, INSERIR, args({
        request: "r-m1", fase: "desfecho", status: "sucesso", loja: LOJA_A,
        chave: null, resumo: '{"paginas":1,"novas":1}', latencia: 1200,
      }))) === null);
    {
      const r = await c.query<{ n: string }>(
        "select count(*)::int as n from public.agente_acao_execucoes where user_id=$1 and request_id='r-m1'",
        [DONO_A]);
      ok("M3  abertura e desfecho compartilham o `request_id`", Number(r.rows[0].n) === 2);
    }

    secao("N. Idempotencia da tentativa");

    ok("M4  mesma tentativa abrindo de novo e recusada (23505)",
      (await sqlstate(c, INSERIR, args({ request: "r-m4" }))) === "23505");
    ok("M6  tentativa DIFERENTE, mesmo bucket, e permitida",
      (await sqlstate(c, INSERIR, args({
        request: "r-m6", chave: "n8n:w5m-X-a2:sincronizar_perguntas:ag",
      }))) === null);
    ok("M7  segundo desfecho para o mesmo request e recusado (23505)",
      (await sqlstate(c, INSERIR, args({
        request: "r-m1", fase: "desfecho", status: "erro", codigo: "erro_interno",
        chave: null, mensagem: "outro desfecho",
      }))) === "23505");
    ok("M4b abertura SEM chave de tentativa e recusada (23514)",
      (await sqlstate(c, INSERIR, args({ request: "r-m4b", chave: null }))) === "23514");

    secao("O. Fase, status e vocabulario");

    ok("M8  abertura com status != executando e recusada",
      (await sqlstate(c, INSERIR, args({
        request: "r-m8", status: "sucesso", chave: "k-m8",
      }))) === "23514");
    ok("M9  desfecho com status executando e recusado",
      (await sqlstate(c, INSERIR, args({
        request: "r-m9", fase: "desfecho", status: "executando", chave: null,
      }))) === "23514");

    // ── O vocabulario INTEIRO, contra o banco ─────────────────────
    //
    // Nao basta o SQL dizer: o CHECK e do Postgres, e so ele decide.
    // Cada par canonico entra; cada par cruzado — codigo de um status
    // usado sob outro — tem de ser recusado com 23514.
    const VOCABULARIO: ReadonlyArray<readonly [string, readonly (string | null)[]]> = [
      ["sucesso", [null]],
      ["parcial", ["backlog_truncado", "descartes_na_varredura"]],
      ["aguardando_aprovacao", ["aprovacao_necessaria"]],
      ["negado", [
        "funcao_inexistente", "permissao_ausente",
        "permissao_bloqueada", "conexao_ausente",
      ]],
      ["erro", [
        "provedor_falhou", "contrato_violado",
        "autoridade_divergente", "autoridade_indisponivel",
        "persistencia_negada", "persistencia_recusada", "persistencia_falhou",
        "auditoria_funcao_falhou", "erro_interno",
      ]],
    ];

    let seq = 0;
    for (const [status, codigos] of VOCABULARIO) {
      for (const codigo of codigos) {
        seq += 1;
        ok(`V1  ${status}/${codigo ?? "NULL"} e aceito`,
          (await sqlstate(c, INSERIR, args({
            request: `r-v1-${seq}`, fase: "desfecho", status, codigo, chave: null,
            mensagem: status === "sucesso" ? null : "resumo curto",
          }))) === null);
      }
    }

    ok("V1b as 17 combinacoes canonicas foram exercitadas", seq === 17, String(seq));

    // ── Cruzamento: codigo do status errado ───────────────────────
    const TODOS = VOCABULARIO.flatMap(([, cs]) => cs).filter((x): x is string => x !== null);
    for (const [status, proprios] of VOCABULARIO) {
      const alheios = TODOS.filter((cd) => !proprios.includes(cd));
      const aceitos: string[] = [];
      for (const codigo of alheios) {
        seq += 1;
        const estado = await sqlstate(c, INSERIR, args({
          request: `r-v2-${seq}`, fase: "desfecho", status, codigo, chave: null,
          mensagem: "resumo curto",
        }));
        if (estado !== "23514") aceitos.push(`${codigo}:${estado ?? "ACEITO"}`);
      }
      ok(`V2  \`${status}\` recusa os ${alheios.length} codigos alheios`,
        aceitos.length === 0, aceitos.join(","));
    }

    // ── O buraco do NULL, que CHECK nao pega sozinho ──────────────
    //
    // CHECK e satisfeito por TRUE **e por NULL**. `codigo in (...)` com
    // a coluna nula avalia NULL, entao sem `is not null` explicito um
    // `erro` sem codigo entraria calado. Esta e a prova de que a guarda
    // esta la e funciona.
    for (const status of ["parcial", "aguardando_aprovacao", "negado", "erro"]) {
      seq += 1;
      ok(`V3  \`${status}\` SEM codigo e recusado`,
        (await sqlstate(c, INSERIR, args({
          request: `r-v3-${seq}`, fase: "desfecho", status, codigo: null, chave: null,
          mensagem: "resumo curto",
        }))) === "23514");
    }

    // ── Status fora do conjunto ───────────────────────────────────
    for (const status of ["concluido", "SUCESSO", "pendente", "ja_processado"]) {
      seq += 1;
      ok(`V4  status \`${status}\` e recusado`,
        (await sqlstate(c, INSERIR, args({
          request: `r-v4-${seq}`, fase: "desfecho", status, codigo: null, chave: null,
        }))) === "23514");
    }

    ok("M12b `backlog_truncado` e distinguivel de sucesso limpo",
      Number((await c.query<{ n: string }>(
        `select count(*)::int as n from public.agente_acao_execucoes
          where user_id=$1 and status='parcial' and codigo_desfecho='backlog_truncado'`,
        [DONO_A])).rows[0].n) === 1);
    ok("O1  `sucesso` com codigo e recusado",
      (await sqlstate(c, INSERIR, args({
        request: "r-o1", fase: "desfecho", status: "sucesso",
        codigo: "backlog_truncado", chave: null,
      }))) === "23514");
    ok("O2  codigo fora do vocabulario e recusado",
      (await sqlstate(c, INSERIR, args({
        request: "r-o2", fase: "desfecho", status: "erro", codigo: "qualquer_coisa", chave: null,
      }))) === "23514");
    ok("O3  `aguardando_aprovacao` na ABERTURA e recusado",
      (await sqlstate(c, INSERIR, args({
        request: "r-o3", fase: "abertura", status: "aguardando_aprovacao",
        codigo: "aprovacao_necessaria", chave: "k-o3",
      }))) === "23514");
    ok("O4  `aguardando_aprovacao` aceita mensagem e latencia no desfecho",
      (await sqlstate(c, INSERIR, args({
        request: "r-o4", fase: "desfecho", status: "aguardando_aprovacao",
        codigo: "aprovacao_necessaria", chave: null,
        mensagem: "o dono precisa aprovar a leitura de perguntas", latencia: 340,
      }))) === null);

    secao("P. Identidade, tenancy e resumo");

    ok("M18 `acao_id` com ponto (forma de Funcao) e recusado",
      (await sqlstate(c, INSERIR, args({
        request: "r-m18", acao: "mercadolivre.perguntas.listar", chave: "k-m18",
      }))) === "23514");
    ok("M18b `acao_id` em MAIUSCULA e recusado",
      (await sqlstate(c, INSERIR, args({
        request: "r-m18b", acao: "SINCRONIZAR", chave: "k-m18b",
      }))) === "23514");
    ok("M19 loja de OUTRO dono e recusada pela FK composta (23503)",
      (await sqlstate(c, INSERIR, args({
        request: "r-m19", fase: "desfecho", status: "sucesso", loja: LOJA_B, chave: null,
      }))) === "23503");
    ok("M20 agente de OUTRO dono e recusado pela FK composta (23503)",
      (await sqlstate(c, INSERIR, args({
        request: "r-m20", agente: AGENTE_B, chave: "k-m20",
      }))) === "23503");
    ok("M21 `entrada_resumo` array e recusado",
      (await sqlstate(c, INSERIR, args({
        request: "r-m21", chave: "k-m21", resumo: "[1,2]",
      }))) === "23514");
    ok("M21b `entrada_resumo` string e recusado",
      (await sqlstate(c, INSERIR, args({
        request: "r-m21b", chave: "k-m21b", resumo: '"texto"',
      }))) === "23514");
    ok("M22 resumo de escalares e aceito",
      (await sqlstate(c, INSERIR, args({
        request: "r-m22", chave: "k-m22",
        resumo: '{"paginas":2,"truncado":true,"ingeriveis":52}',
      }))) === null);
    ok("M23 mensagem na abertura e recusada",
      (await sqlstate(c, INSERIR, args({
        request: "r-m23", chave: "k-m23", mensagem: "nao deveria",
      }))) === "23514");
    ok("M23b mensagem acima de 300 e recusada",
      (await sqlstate(c, INSERIR, args({
        request: "r-m23b", fase: "desfecho", status: "erro", codigo: "erro_interno",
        chave: null, mensagem: "x".repeat(301),
      }))) === "23514");
    // O CONTROLE de M23b. Sem ele, um codigo invalido no fixture faria a
    // linha ser recusada pelo CHECK errado — com o MESMO 23514 — e o
    // limite de 300 passaria vacuo. Foi exatamente o que aconteceu antes
    // de o vocabulario mudar, e o par so passa quando a UNICA diferenca
    // entre as duas linhas e o comprimento da mensagem.
    ok("M23c a mesma linha com 300 caracteres e aceita",
      (await sqlstate(c, INSERIR, args({
        request: "r-m23c", fase: "desfecho", status: "erro", codigo: "erro_interno",
        chave: null, mensagem: "x".repeat(300),
      }))) === null);
    ok("M24 latencia negativa e recusada",
      (await sqlstate(c, INSERIR, args({
        request: "r-m24", fase: "desfecho", status: "sucesso", chave: null, latencia: -1,
      }))) === "23514");
    ok("M24b latencia na abertura e recusada",
      (await sqlstate(c, INSERIR, args({
        request: "r-m24b", chave: "k-m24b", latencia: 10,
      }))) === "23514");

    secao("Q. Orfas e isolamento da auditoria de Funcao");

    {
      await c.query(INSERIR, args({ request: "r-orfa", chave: "k-orfa" }));
      const r = await c.query<{ n: string }>(
        `select count(*)::int as n
           from public.agente_acao_execucoes a
          where a.fase = 'abertura' and a.user_id = $1
            and not exists (
              select 1 from public.agente_acao_execucoes d
               where d.fase = 'desfecho' and d.user_id = a.user_id
                 and d.request_id = a.request_id)`, [DONO_A]);
      ok("M29 abertura sem desfecho continua representavel e localizavel",
        Number(r.rows[0].n) >= 1, r.rows[0].n);
    }
    {
      const r = await c.query<{ n: string }>(
        "select count(*)::int as n from public.agente_funcao_chamadas where user_id in ($1,$2)",
        [DONO_A, DONO_B]);
      ok("M30 nenhuma linha foi criada em `agente_funcao_chamadas`",
        Number(r.rows[0].n) === 0, r.rows[0].n);
    }

    secao("R. Privilegios efetivos");

    for (const [papel, rotulo] of [["anon", "M25"], ["authenticated", "M26"]] as const) {
      const r = await c.query<{ s: boolean; i: boolean }>(
        `select has_table_privilege($1,'public.agente_acao_execucoes','select') as s,
                has_table_privilege($1,'public.agente_acao_execucoes','insert') as i`, [papel]);
      ok(`${rotulo} \`${papel}\` nao tem SELECT nem INSERT`,
        r.rows[0].s === false && r.rows[0].i === false);
    }
    {
      const r = await c.query<{ s: boolean; i: boolean; u: boolean; d: boolean; t: boolean }>(
        `select has_table_privilege('service_role','public.agente_acao_execucoes','select') as s,
                has_table_privilege('service_role','public.agente_acao_execucoes','insert') as i,
                has_table_privilege('service_role','public.agente_acao_execucoes','update') as u,
                has_table_privilege('service_role','public.agente_acao_execucoes','delete') as d,
                has_table_privilege('service_role','public.agente_acao_execucoes','truncate') as t`);
      const p = r.rows[0];
      ok("M27 `service_role` tem SELECT e INSERT", p.s === true && p.i === true);
      ok("M28 `service_role` NAO tem UPDATE/DELETE/TRUNCATE",
        p.u === false && p.d === false && p.t === false);
    }
    {
      const r = await c.query<{ dono: string; rls: boolean }>(
        `select pg_get_userbyid(relowner) as dono, relrowsecurity as rls
           from pg_class where oid = 'public.agente_acao_execucoes'::regclass`);
      ok("R1  dono e `postgres`, RLS off (padrao congelado)",
        r.rows[0].dono === "postgres" && r.rows[0].rls === false);
    }

    // ── M5: disputa REAL pelo mesmo indice unico ─────────────────────
    secao("S. Concorrencia real na abertura");

    const A = new Client({ connectionString: url });
    const B = new Client({ connectionString: url });
    const O = new Client({ connectionString: url });
    await Promise.all([A.connect(), B.connect(), O.connect()]);
    try {
      for (const cli of [A, B, O]) {
        await cli.query("set statement_timeout = 30000");
        await cli.query("set lock_timeout = 25000");
        await cli.query("set idle_in_transaction_session_timeout = 60000");
      }
      const pidB = (await B.query<{ p: number }>("select pg_backend_pid() as p")).rows[0].p;
      const disputada = args({ request: "r-m5", chave: "n8n:w5m-DISPUTA-a1:sincronizar_perguntas:ag" });

      await A.query("begin");
      await A.query(INSERIR, disputada);

      await B.query("begin");
      const promessaB = B.query(INSERIR, args({
        request: "r-m5-b", chave: "n8n:w5m-DISPUTA-a1:sincronizar_perguntas:ag",
      }));
      let erroB: { code?: string } | null = null;
      promessaB.catch((e) => { erroB = e as { code?: string }; });

      let espiado = "";
      for (let i = 0; i < 40; i += 1) {
        await espera(250);
        const r = await O.query<{ wait_event_type: string | null }>(
          "select wait_event_type from pg_stat_activity where pid = $1", [pidB]);
        if (r.rows[0]?.wait_event_type === "Lock") { espiado = "Lock"; break; }
        if (erroB) break;
      }
      ok("M5a B espera de fato no indice unico (lock observado)", espiado === "Lock", espiado);

      await A.query("commit");
      let codigoB: string | null = null;
      try { await promessaB; } catch (e) { codigoB = (e as { code?: string }).code ?? "SEM_CODIGO"; }
      try { await B.query("rollback"); } catch { /* ja abortada */ }

      ok("M5b a perdedora recebe violacao de unicidade (23505)", codigoB === "23505");
      ok("M5c exatamente UMA abertura sobreviveu",
        Number((await O.query<{ n: string }>(
          `select count(*)::int as n from public.agente_acao_execucoes
            where idempotency_key = 'n8n:w5m-DISPUTA-a1:sincronizar_perguntas:ag'`)).rows[0].n) === 1);

      // ── A mesma disputa, agora no DESFECHO ────────────────────────
      //
      // A abertura tem chave de tentativa; o desfecho nao tem chave
      // NENHUMA, e a unicidade dele depende so de
      // `idx_..._desfecho_unico`. Provar isso em sequencia nao bastaria:
      // duas sessoes fechando a MESMA varredura ao mesmo tempo e o caso
      // real — dois workers reagindo ao mesmo processo.
      const DISPUTADO = "r-t1-desfecho-disputado";
      await A.query("begin");
      await A.query(INSERIR, args({
        request: DISPUTADO, fase: "desfecho", status: "sucesso", chave: null,
        loja: LOJA_A, latencia: 900,
      }));

      await B.query("begin");
      const promessaT = B.query(INSERIR, args({
        request: DISPUTADO, fase: "desfecho", status: "erro",
        codigo: "provedor_falhou", chave: null, mensagem: "o outro worker",
      }));
      let erroT: { code?: string } | null = null;
      promessaT.catch((e) => { erroT = e as { code?: string }; });

      let espiadoT = "";
      for (let i = 0; i < 40; i += 1) {
        await espera(250);
        const r = await O.query<{ wait_event_type: string | null }>(
          "select wait_event_type from pg_stat_activity where pid = $1", [pidB]);
        if (r.rows[0]?.wait_event_type === "Lock") { espiadoT = "Lock"; break; }
        if (erroT) break;
      }
      ok("T1  o segundo desfecho espera de fato no indice (lock observado)",
        espiadoT === "Lock", espiadoT);

      await A.query("commit");
      let codigoT: string | null = null;
      try { await promessaT; } catch (e) { codigoT = (e as { code?: string }).code ?? "SEM_CODIGO"; }
      try { await B.query("rollback"); } catch { /* ja abortada */ }

      ok("T2  a perdedora do desfecho recebe 23505", codigoT === "23505");
      {
        const r = await O.query<{ n: string; st: string }>(
          `select count(*)::int as n, max(status) as st
             from public.agente_acao_execucoes
            where request_id = $1 and fase = 'desfecho'`, [DISPUTADO]);
        ok("T3  exatamente UM desfecho sobreviveu, e e o do vencedor",
          Number(r.rows[0].n) === 1 && r.rows[0].st === "sucesso",
          `${r.rows[0].n}/${r.rows[0].st}`);
      }
    } finally {
      for (const cli of [A, B]) { try { await cli.query("rollback"); } catch { /* fim */ } }
      await Promise.all([A.end(), B.end(), O.end()]);
    }
  } finally {
    await c.query("delete from public.agente_acao_execucoes where user_id in ($1,$2)", [DONO_A, DONO_B]);
    for (const loja of [LOJA_A, LOJA_B]) {
      await c.query("delete from public.lojas where id = $1::uuid", [loja]);
    }
    for (const agente of [AGENTE_A, AGENTE_B]) {
      await c.query("delete from public.agentes where id = $1::uuid", [agente]);
    }
    await c.end();
  }

  console.log(`\n── placar ${"─".repeat(54)}`);
  console.log(`  PASS ${passou}   FAIL ${falhou}\n`);
  if (falhou > 0) process.exitCode = 1;
}

const relogio = setTimeout(() => {
  console.log("\nESTOUROU O TEMPO MAXIMO — nenhuma sessao pode ficar presa.");
  process.exit(2);
}, TEMPO_MAXIMO_MS);
relogio.unref();

main().catch((e: unknown) => {
  const erro = e as { code?: string; message?: string };
  console.log(`\nERRO: ${erro.code ?? ""} ${erro.message ?? String(e)}`);
  process.exit(2);
});
