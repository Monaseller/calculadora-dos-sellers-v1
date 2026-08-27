/**
 * CDS IA — SKILL-1D.d.1b. Prova REAL das constraints de
 * `agente_permissoes`, contra o banco de producao.
 *
 *   ┌──────────────────────────────────────────────────────────────┐
 *   │  SUITE COM ESCRITA · BANCO REAL · CLEANUP OBRIGATORIO        │
 *   └──────────────────────────────────────────────────────────────┘
 *
 * Rodar:
 *   npx tsx scripts/testar-ia-skill-1d-d1-banco.ts             # so audita, NAO conecta
 *   npx tsx scripts/testar-ia-skill-1d-d1-banco.ts --confirmo  # execucao real
 *
 * SEM `--confirmo` nao abre conexao nenhuma — mesma convencao de
 * `testar-agentes-isolamento-1de.ts`.
 *
 * ── Por que `pg` e nao o cliente do projeto ─────────────────────────
 *
 * `getSupabaseServidor()` e `server-only` e LANCA sob `tsx`. Alem disso,
 * PostgREST mapeia erro e esconderia o SQLSTATE — e o SQLSTATE E A
 * PROVA: 23503 diz que quem recusou foi a FK, 23505 a PK, 23514 o CHECK.
 * Sem ele, "deu erro" nao distingue constraint de bug de rede.
 *
 * ── Dados sinteticos, e como eles nao encostam em dado real ─────────
 *
 * Todo `user_id` criado aqui comeca com `PREFIXO`, que carrega um sufixo
 * aleatorio por execucao. Nenhum DELETE/UPDATE roda sem `WHERE` sobre
 * esse prefixo, e ha um guarda que LANCA se alguem tentar. Nao existe
 * `TRUNCATE`, nao existe `DELETE` sem `WHERE`, e nenhum agente ou loja
 * real e lido, alterado ou apagado.
 *
 * ── Segredo ─────────────────────────────────────────────────────────
 *
 * A string de conexao e lida de `.env.local` DENTRO do processo e nunca
 * chega ao stdout. O relatorio imprime somente propriedades derivadas
 * (host mascarado, porta, database) — nunca usuario completo nem senha.
 *
 * E isso NAO fica no plano da revisao: `instalarGuardaDeSaida()` abaixo
 * intercepta cada byte escrito em stdout/stderr e ABORTA o processo se
 * algo com forma de credencial passar. Existe porque a forma anterior de
 * mascarar — substituicao textual num shell, supondo valor sem aspas —
 * falhou em silencio e imprimiu a senha inteira. Suposicao sobre a FORMA
 * do segredo nao e protecao; interceptar a SAIDA e.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";

/**
 * Barreira de saida. Recebe a senha real para poder procura-la
 * literalmente — e nunca a imprime, nem quando dispara.
 */
function instalarGuardaDeSaida(segredos: string[]): void {
  const literais = segredos.filter((s) => s.length >= 4);
  const padroes: Array<[string, RegExp | string]> = [
    ...literais.map((s, i) => [`segredo literal #${i + 1}`, s] as [string, string]),
    ["esquema postgres://", /postgres(ql)?:\/\//i],
    ["password=", /password\s*=/i],
    ["DATABASE_URL=", /DATABASE_URL\s*=/i],
    ["credencial@host", /:\/\/[^\s/@]*:[^\s/@]*@/],
  ];

  for (const fluxo of ["stdout", "stderr"] as const) {
    const original = process[fluxo].write.bind(process[fluxo]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process[fluxo] as any).write = (pedaco: any, ...resto: any[]): boolean => {
      const texto = typeof pedaco === "string" ? pedaco : String(pedaco);
      for (const [nome, p] of padroes) {
        const bateu = typeof p === "string" ? texto.includes(p) : p.test(texto);
        if (bateu) {
          // O trecho ofensivo NAO e reimpresso — so o nome do padrao.
          original(`\n  ABORTADO: saida bloqueada pelo guarda (padrao: ${nome}).\n`);
          process.exit(2);
        }
      }
      return original(pedaco, ...resto);
    };
  }
}

const CONFIRMADO = process.argv.includes("--confirmo");

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

// ─── Identidade sintetica ─────────────────────────────────────────────

/**
 * Inconfundivel de proposito. Um `user_id` real do CDS e um uuid; este
 * nunca sera confundido com um, nem por engano nem por consulta.
 */
const SUFIXO = Math.random().toString(36).slice(2, 10);
const PREFIXO = `test-skill-1d-d1-${SUFIXO}`;
const DONO_A = `${PREFIXO}-a`;
const DONO_B = `${PREFIXO}-b`;

/**
 * O guarda que torna impossivel tocar dado real.
 *
 * Toda escrita passa por aqui antes de virar SQL. Nao e conferencia de
 * revisao: e barreira de execucao, e ela LANCA.
 */
function exigirSintetico(valor: string): string {
  if (!valor.startsWith(PREFIXO)) {
    throw new Error(`GUARDA: recusado id nao sintetico (nao comeca com o prefixo desta execucao)`);
  }
  return valor;
}

// ─── Conexao ──────────────────────────────────────────────────────────

function lerConexao(): string {
  const txt = readFileSync(join(__dirname, "..", ".env.local"), "utf8");
  // Aceita valor com e SEM aspas — foi supor aspas ausentes que fez a
  // mascara anterior falhar. E exclui `\r`: em arquivo CRLF, `[^"\n]+`
  // engoliria o retorno de carro para dentro da credencial, em silencio.
  const m = txt.match(/^DATABASE_URL\s*=\s*"?([^"\r\n]+)"?/m);
  if (!m) throw new Error("DATABASE_URL ausente em .env.local");
  return m[1];
}

/**
 * Somente propriedades derivadas, em campos separados. Deliberadamente
 * NAO remonta uma URL: `esquema://host` e forma de connection string, e o
 * guarda de saida a bloquearia — corretamente.
 */
function descreverAlvo(url: string): string {
  const u = new URL(url);
  const host = u.hostname.replace(/^([a-z]{3})[^.]*/, "$1***");
  return `host=${host}  porta=${u.port}  database=${u.pathname.replace("/", "")}`;
}

/** As formas em que a senha pode aparecer: crua e decodificada. */
function segredosDe(url: string): string[] {
  const u = new URL(url);
  const brutos = [u.password, u.username];
  const decodificados = brutos.map((v) => {
    try { return decodeURIComponent(v); } catch { return v; }
  });
  return Array.from(new Set([...brutos, ...decodificados])).filter(Boolean);
}

/** O SQLSTATE, que e a prova de QUEM recusou. */
function sqlstate(e: unknown): string {
  return (e as { code?: string })?.code ?? "sem-codigo";
}

async function tentar(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (e) {
    return sqlstate(e);
  }
}

// ─── Execucao ─────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("\n══ CDS IA — SKILL-1D.d.1b: constraints em BANCO REAL ══");
  console.log("   SUITE COM ESCRITA · BANCO REAL · CLEANUP OBRIGATORIO");

  if (!CONFIRMADO) {
    console.log("\n  Sem `--confirmo`: nenhuma conexao foi aberta e nada foi escrito.");
    console.log("  Para executar de verdade:");
    console.log("    npx tsx scripts/testar-ia-skill-1d-d1-banco.ts --confirmo\n");
    process.exit(0);
  }

  const url = lerConexao();

  // Antes de QUALQUER coisa derivada da conexao chegar a saida.
  instalarGuardaDeSaida(segredosDe(url));

  console.log(`\n  alvo: ${descreverAlvo(url)}`);
  console.log(`  prefixo sintetico desta execucao: ${PREFIXO}`);

  const c = new Client({ connectionString: url });
  await c.connect();

  let idA = "";
  let idB = "";

  try {
    // ── Agentes sinteticos ───────────────────────────────────────────
    secao("A. Agentes sinteticos (nunca agente real)");

    const criar = async (dono: string, nome: string): Promise<string> => {
      const r = await c.query(
        `insert into public.agentes (user_id, nome, tipo) values ($1, $2, 'gerente') returning id`,
        [exigirSintetico(dono), nome]
      );
      return r.rows[0].id as string;
    };
    idA = await criar(DONO_A, "AGENTE SINTETICO 1D.d.1b (A)");
    idB = await criar(DONO_B, "AGENTE SINTETICO 1D.d.1b (B)");

    ok("A1  agente sintetico do dono A criado", idA.length === 36);
    ok("A2  agente sintetico do dono B criado", idB.length === 36);
    ok("A3  os dois donos sao distintos e sinteticos",
      DONO_A !== DONO_B && DONO_A.startsWith(PREFIXO) && DONO_B.startsWith(PREFIXO));
    ok("A4  o guarda REJEITA id nao sintetico",
      await (async () => { try { exigirSintetico("uuid-real-qualquer"); return false; } catch { return true; } })());

    // ── TESTE 1 — INSERT valido ──────────────────────────────────────
    secao("B. Teste 1 — INSERT valido");

    const e1 = await tentar(() => c.query(
      `insert into public.agente_permissoes (agente_id, user_id, funcao_id, nivel)
       values ($1, $2, 'vendas.consultar', 'automatico')`, [idA, DONO_A]));
    ok("B1  INSERT valido aceito", e1 === null, `SQLSTATE ${e1}`);

    const lido = await c.query(
      `select nivel, funcao_id from public.agente_permissoes where agente_id = $1`, [idA]);
    ok("B2  a linha existe com o nivel gravado",
      lido.rowCount === 1 && lido.rows[0].nivel === "automatico" &&
      lido.rows[0].funcao_id === "vendas.consultar");

    // ── TESTE 2 — cross-tenant ───────────────────────────────────────
    secao("C. Teste 2 — cross-tenant recusado pela FK");

    const e2 = await tentar(() => c.query(
      `insert into public.agente_permissoes (agente_id, user_id, funcao_id, nivel)
       values ($1, $2, 'vendas.consultar', 'automatico')`, [idB, DONO_A]));
    ok("C1  agente do dono B com user_id do dono A e RECUSADO", e2 !== null);
    ok(`C2  recusado pela FK — SQLSTATE ${e2}`, e2 === "23503", `esperado 23503, veio ${e2}`);

    const vazou = await c.query(
      `select count(*)::int as n from public.agente_permissoes where agente_id = $1`, [idB]);
    ok("C3  nada foi gravado para o agente do dono B", vazou.rows[0].n === 0);

    // ── TESTE 3 — duplicidade ────────────────────────────────────────
    secao("D. Teste 3 — duplicidade recusada pela PK");

    const e3 = await tentar(() => c.query(
      `insert into public.agente_permissoes (agente_id, user_id, funcao_id, nivel)
       values ($1, $2, 'vendas.consultar', 'aprovacao')`, [idA, DONO_A]));
    ok("D1  segundo INSERT do mesmo par e RECUSADO", e3 !== null);
    ok(`D2  recusado pela PK — SQLSTATE ${e3}`, e3 === "23505", `esperado 23505, veio ${e3}`);

    const naoSobrescreveu = await c.query(
      `select nivel from public.agente_permissoes where agente_id=$1 and funcao_id='vendas.consultar'`, [idA]);
    ok("D3  o nivel original NAO foi sobrescrito", naoSobrescreveu.rows[0].nivel === "automatico");

    // ── TESTE 4 — nivel invalido ─────────────────────────────────────
    secao("E. Teste 4 — nivel fora do dominio");

    const e4 = await tentar(() => c.query(
      `insert into public.agente_permissoes (agente_id, user_id, funcao_id, nivel)
       values ($1, $2, 'outra.funcao', 'livre')`, [idA, DONO_A]));
    ok("E1  nivel 'livre' e RECUSADO", e4 !== null);
    ok(`E2  recusado por CHECK — SQLSTATE ${e4}`, e4 === "23514", `esperado 23514, veio ${e4}`);

    for (const n of ["bloqueado", "aprovacao", "automatico"]) {
      const e = await tentar(() => c.query(
        `insert into public.agente_permissoes (agente_id, user_id, funcao_id, nivel)
         values ($1, $2, $3, $4)`, [idA, DONO_A, `dominio.${n}`, n]));
      ok(`E3  nivel '${n}' e ACEITO`, e === null, `SQLSTATE ${e}`);
    }

    // ── TESTE 5 — funcao_id invalido ─────────────────────────────────
    secao("F. Teste 5 — funcao_id fora da forma");

    for (const id of ["foo", "Vendas.consultar", "vendas-consultar", ".vendas", "vendas.", "vendas..consultar"]) {
      const e = await tentar(() => c.query(
        `insert into public.agente_permissoes (agente_id, user_id, funcao_id, nivel)
         values ($1, $2, $3, 'bloqueado')`, [idA, DONO_A, id]));
      ok(`F  \`${id}\` recusado por CHECK (${e})`, e === "23514", `veio ${e}`);
    }

    // ── TESTE 6 — forma valida, Funcao inexistente ───────────────────
    secao("G. Teste 6 — forma valida NAO e Funcao existente");

    const e6 = await tentar(() => c.query(
      `insert into public.agente_permissoes (agente_id, user_id, funcao_id, nivel)
       values ($1, $2, 'foo.bar.inventado', 'automatico')`, [idA, DONO_A]));
    ok("G1  `foo.bar.inventado` e ACEITO pelo banco", e6 === null, `SQLSTATE ${e6}`);
    ok("G2  isto e comportamento ESPERADO: o banco valida FORMA, o registry valida EXISTENCIA", true);

    await c.query(
      `delete from public.agente_permissoes where agente_id=$1 and funcao_id='foo.bar.inventado' and user_id=$2`,
      [idA, exigirSintetico(DONO_A)]);
    const sumiu = await c.query(
      `select count(*)::int as n from public.agente_permissoes where agente_id=$1 and funcao_id='foo.bar.inventado'`, [idA]);
    ok("G3  a linha de teste foi removida", sumiu.rows[0].n === 0);

    // ── TESTE 8 — ON UPDATE RESTRICT ─────────────────────────────────
    secao("H. Teste 8 — ON UPDATE RESTRICT (seguro: agente sintetico)");

    const e8 = await tentar(() => c.query(
      `update public.agentes set user_id = $1 where id = $2 and user_id = $3`,
      [`${PREFIXO}-c`, idA, exigirSintetico(DONO_A)]));
    ok("H1  mudar o dono do agente referenciado e RECUSADO", e8 !== null);
    ok(`H2  recusado pela FK — SQLSTATE ${e8}`, e8 === "23503", `esperado 23503, veio ${e8}`);

    const donoIntacto = await c.query(`select user_id from public.agentes where id=$1`, [idA]);
    ok("H3  o dono do agente NAO mudou", donoIntacto.rows[0].user_id === DONO_A);

    // ── TESTE 9 — privilegios ────────────────────────────────────────
    secao("I. Teste 9 — privilegios por execucao real");

    for (const papel of ["anon", "authenticated"]) {
      let code: string | null = null;
      try {
        await c.query("begin");
        await c.query(`set local role ${papel}`);
        await c.query("select 1 from public.agente_permissoes limit 1");
      } catch (e) {
        code = sqlstate(e);
      } finally {
        await c.query("rollback").catch(() => undefined);
      }
      ok(`I  SELECT como \`${papel}\` e NEGADO (${code})`, code === "42501", `esperado 42501, veio ${code}`);
    }

    const comoPostgres = await c.query("select count(*)::int as n from public.agente_permissoes");
    ok("I3  o papel do backend continua lendo (controle)", typeof comoPostgres.rows[0].n === "number");

    // ── TESTE 9b — o ACL BRUTO, que e onde `MAINTAIN` aparece ────────
    //
    // `information_schema.role_table_grants` NAO reporta MAINTAIN (PG17+),
    // e foi por isso que o primeiro gate leu sete privilegios onde havia
    // oito. A prova tem de vir do `relacl`.
    //
    // Ausencia tambem se prova por catalogo: executar TRUNCATE para
    // "verificar" que ele nao existe seria destruir dado para descobrir
    // o que uma leitura ja responde.
    secao("I-b. Teste 9b — ACL bruto (onde MAINTAIN aparece)");

    const aclRes = await c.query<{ acl: string[] }>(
      `select coalesce(relacl::text[], '{}') as acl from pg_class where oid = 'public.agente_permissoes'::regclass`
    );
    const acl = aclRes.rows[0].acl;
    const entrada = (papel: string): string | undefined =>
      acl.find((e) => e.split("=")[0] === papel);

    ok(`I4  service_role tem EXATAMENTE 'arwd' (veio: ${entrada("service_role") ?? "sem entrada"})`,
      (entrada("service_role") ?? "").split("=")[1]?.split("/")[0] === "arwd");

    ok("I5  sem entrada de ACL para anon", entrada("anon") === undefined);
    ok("I6  sem entrada de ACL para authenticated", entrada("authenticated") === undefined);
    ok("I7  sem entrada de ACL para PUBLIC (grantee vazio)", entrada("") === undefined);

    const p = await c.query<Record<string, boolean>>(
      `select
         has_table_privilege('service_role','public.agente_permissoes','SELECT')     as sel,
         has_table_privilege('service_role','public.agente_permissoes','INSERT')     as ins,
         has_table_privilege('service_role','public.agente_permissoes','UPDATE')     as upd,
         has_table_privilege('service_role','public.agente_permissoes','DELETE')     as del,
         has_table_privilege('service_role','public.agente_permissoes','TRUNCATE')   as trunc,
         has_table_privilege('service_role','public.agente_permissoes','REFERENCES') as refs,
         has_table_privilege('service_role','public.agente_permissoes','TRIGGER')    as trg,
         has_table_privilege('service_role','public.agente_permissoes','MAINTAIN')   as maint`
    );
    const priv = p.rows[0];

    ok("I8  service_role TEM os quatro do CRUD",
      priv.sel && priv.ins && priv.upd && priv.del);
    ok(`I9   service_role NAO tem TRUNCATE`, priv.trunc === false);
    ok(`I10  service_role NAO tem REFERENCES`, priv.refs === false);
    ok(`I11  service_role NAO tem TRIGGER`, priv.trg === false);
    ok(`I12  service_role NAO tem MAINTAIN`, priv.maint === false);

    // ── TESTE 10 — ausencia nao cria linha ───────────────────────────
    secao("J. Teste 10 — ausencia e o bloqueio");

    const idC = await criar(`${PREFIXO}-novo`, "AGENTE SINTETICO 1D.d.1b (novo)");
    const semLinha = await c.query(
      `select count(*)::int as n from public.agente_permissoes where agente_id=$1`, [idC]);
    ok("J1  agente novo nasce com ZERO permissoes", semLinha.rows[0].n === 0);
    ok("J2  nenhuma linha automatica foi criada por trigger/default", semLinha.rows[0].n === 0);

    // ── TESTE 7 — CASCADE ────────────────────────────────────────────
    secao("K. Teste 7 — ON DELETE CASCADE real");

    await c.query(
      `insert into public.agente_permissoes (agente_id, user_id, funcao_id, nivel)
       values ($1, $2, 'cascade.teste', 'bloqueado')`, [idC, `${PREFIXO}-novo`]);
    const antes = await c.query(
      `select count(*)::int as n from public.agente_permissoes where agente_id=$1`, [idC]);
    ok("K1  permissao criada para o agente C", antes.rows[0].n === 1);

    await c.query(`delete from public.agentes where id=$1 and user_id=$2`,
      [idC, exigirSintetico(`${PREFIXO}-novo`)]);

    const depois = await c.query(
      `select count(*)::int as n from public.agente_permissoes where agente_id=$1`, [idC]);
    ok("K2  apagar o agente APAGOU a permissao (CASCADE real)", depois.rows[0].n === 0);
    const agenteSumiu = await c.query(`select count(*)::int as n from public.agentes where id=$1`, [idC]);
    ok("K3  o agente sintetico C tambem sumiu", agenteSumiu.rows[0].n === 0);
  } finally {
    // ── CLEANUP — roda mesmo com assert falhando ──────────────────────
    secao("Z. Cleanup obrigatorio");

    let erroCleanup: unknown = null;
    try {
      // Permissoes primeiro (o CASCADE ja cobriria, mas nao se apoia nele).
      await c.query(`delete from public.agente_permissoes where user_id like $1`, [`${PREFIXO}%`]);
      await c.query(`delete from public.agentes where user_id like $1`, [`${PREFIXO}%`]);
    } catch (e) {
      erroCleanup = e;
    }

    const restPerm = await c.query(
      `select count(*)::int as n from public.agente_permissoes where user_id like $1`, [`${PREFIXO}%`]);
    const restAg = await c.query(
      `select count(*)::int as n from public.agentes where user_id like $1`, [`${PREFIXO}%`]);

    ok("Z1  cleanup executou sem erro", erroCleanup === null, String(erroCleanup));
    ok("Z2  ZERO permissoes sinteticas restantes", restPerm.rows[0].n === 0, String(restPerm.rows[0].n));
    ok("Z3  ZERO agentes sinteticos restantes", restAg.rows[0].n === 0, String(restAg.rows[0].n));

    const totalPerm = await c.query(`select count(*)::int as n from public.agente_permissoes`);
    ok("Z4  a tabela voltou a ZERO linhas no total", totalPerm.rows[0].n === 0, String(totalPerm.rows[0].n));

    await c.end();

    console.log(`\n${"═".repeat(66)}`);
    console.log(`  ${passou}/${passou + falhou} passaram` + (falhou > 0 ? `  ·  ${falhou} FALHARAM` : ""));
    console.log(`${"═".repeat(66)}\n`);
    process.exit(falhou > 0 ? 1 : 0);
  }
}

main().catch((e) => {
  console.error("\n  ERRO FATAL:", (e as Error).message);
  console.error("  ATENCAO: se a conexao caiu no meio, rode novamente para o cleanup completar.");
  process.exit(1);
});
