/**
 * CDS IA — SKILL-1D.g.2-C1. Prova REAL das constraints do write path.
 *
 *   ┌──────────────────────────────────────────────────────────────┐
 *   │  SUITE MUTANTE · BANCO REAL · 1 TRANSACAO · ROLLBACK SEMPRE  │
 *   └──────────────────────────────────────────────────────────────┘
 *
 * Rodar:
 *   npx tsx scripts/testar-ia-skill-1d-g2-banco.ts             # so audita
 *   npx tsx scripts/testar-ia-skill-1d-g2-banco.ts --confirmo  # execucao real
 *
 * ── A metade que faltava ────────────────────────────────────────────
 *
 * A suite `testar-ia-skill-1d-g2.ts` executa `selecao-escrita.ts` contra
 * um cliente duplado e prova o que o TypeScript FAZ: tabela, payload de
 * seis colunas, `onConflict` da PK, `criado_em` ausente, uma escrita so,
 * zero pre-leitura, `23503` virando `nao_disponivel`.
 *
 * Nada disso prova que o BANCO recusa o que se supoe que ele recusa. O
 * fechamento de dono do upsert nao esta no TypeScript: esta nas duas FKs
 * compostas. Enquanto elas nao forem medidas, "trocar de dono e
 * impossivel por desenho" e hipotese, nao fato.
 *
 * Esta suite mede exatamente isso, com SQL literal — nao importa o
 * modulo de producao, nao cria rota, nao e E2E.
 *
 * ── Por que SQL literal, e nao o modulo ─────────────────────────────
 *
 * O que se prova aqui e comportamento de CONSTRAINT: SQLSTATE real,
 * atomicidade do `ON CONFLICT`, preservacao de `criado_em`, `CASCADE` e
 * `RESTRICT`. Passar pelo modulo acrescentaria uma camada entre a
 * pergunta e a resposta sem responder nada a mais — e a equivalencia
 * entre o SQL daqui e o payload de la ja e provada, coluna a coluna,
 * pela suite local.
 *
 * ── Fixtures ────────────────────────────────────────────────────────
 *
 * Todas sinteticas, com UUID gerado nesta execucao, e o schema veio do
 * catalogo REAL medido no gate C0 — nao de inferencia. `lojas` exige
 * `user_id` no formato UUID canonico (`lojas_user_id_formato_uuid`), o
 * que torna o padrao textual das suites anteriores invalido aqui.
 *
 * Nenhuma credencial e escrita: `access_token`, `refresh_token` e
 * `partner_key` sao nullable e simplesmente nao entram no INSERT.
 * `seller_id` tambem fica fora — `lojas_seller_id_user_id_unique` faria
 * duas lojas do mesmo dono colidirem se recebessem o mesmo valor, e dois
 * NULL nao colidem.
 *
 * ── Nada persiste ───────────────────────────────────────────────────
 *
 * Uma transacao, `ROLLBACK` no fim mesmo com tudo verde, e uma
 * verificacao residual por UUID exato depois dela. Falha esperada usa
 * SAVEPOINT proprio, para que a transacao nunca fique abortada.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";

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

/**
 * Instrumento do arm guard: conta tentativas de abrir conexao. A prova de
 * que o guarda age ANTES da rede nao e o texto do codigo, e este contador
 * valer zero na execucao sem a flag.
 */
let tentativasDeConexao = 0;

/** Estado terminal da transacao, reportado explicitamente. */
let transacaoConfirmada = false;
let rollbackFinalExecutado = false;

// ─── Guarda de saida ──────────────────────────────────────────────────

function instalarGuardaDeSaida(segredos: string[]): void {
  const literais = segredos.filter((s) => s.length >= 4);
  const padroes: Array<[string, RegExp | string]> = [
    ...literais.map((s, i) => [`segredo literal #${i + 1}`, s] as [string, string]),
    ["esquema postgres://", /postgres(ql)?:\/\//i],
    ["password=", /password\s*=/i],
    ["DATABASE_URL=", /DATABASE_URL\s*=/i],
    ["credencial@host", /:\/\/[^\s/@]*:[^\s/@]*@/],
    ["token JWT", /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\./],
    ["chave privada PEM", /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/],
    ["service role key", /SERVICE_ROLE_KEY\s*=/i],
    ["anon key", /ANON_KEY\s*=/i],
  ];

  for (const fluxo of ["stdout", "stderr"] as const) {
    const original = process[fluxo].write.bind(process[fluxo]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process[fluxo] as any).write = (pedaco: any, ...resto: any[]): boolean => {
      const texto = typeof pedaco === "string" ? pedaco : String(pedaco);
      for (const [nome, p] of padroes) {
        const bateu = typeof p === "string" ? texto.includes(p) : p.test(texto);
        if (bateu) {
          original(`\n  ABORTADO: saida bloqueada pelo guarda (padrao: ${nome}).\n`);
          process.exit(2);
        }
      }
      return original(pedaco, ...resto);
    };
  }
}

function lerEnv(): Record<string, string> {
  const txt = readFileSync(join(__dirname, "..", ".env.local"), "utf8");
  const out: Record<string, string> = {};
  for (const m of txt.matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*"?([^"\r\n]*)"?/gm)) out[m[1]] = m[2];
  return out;
}

function descreverAlvo(url: string): string {
  const u = new URL(url);
  return `host=${u.hostname.replace(/^([a-z]{3})[^.]*/, "$1***")}  porta=${u.port}  database=${u.pathname.replace("/", "")}`;
}

function segredosDe(env: Record<string, string>): string[] {
  const fora: string[] = [];
  for (const chave of ["DATABASE_URL", "DIRECT_URL"]) {
    if (!env[chave]) continue;
    try {
      const u = new URL(env[chave]);
      fora.push(u.password, u.username);
      for (const v of [u.password, u.username]) {
        try { fora.push(decodeURIComponent(v)); } catch { /* valor nao-encodado */ }
      }
    } catch { /* URL invalida: nada a proteger daqui */ }
  }
  fora.push(env.SUPABASE_SERVICE_ROLE_KEY ?? "", env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
  return Array.from(new Set(fora)).filter(Boolean);
}

/** O SQLSTATE, que e a prova de QUEM recusou. Nunca a mensagem. */
function sqlstate(e: unknown): string {
  return (e as { code?: string })?.code ?? "sem-codigo";
}

// ─── Identidades sinteticas ───────────────────────────────────────────
//
// `lojas.user_id` carrega CHECK de formato UUID canonico — medido no C0.
// Por isso os tenants sao uuid, e nao o padrao textual das suites
// anteriores, que aqui seria recusado com 23514 no primeiro INSERT.

const TENANT_A = randomUUID();
const TENANT_B = randomUUID();
const AGENTE_A = randomUUID();
const AGENTE_B = randomUUID();
const LOJA_A1 = randomUUID();
const LOJA_A2 = randomUUID();
const LOJA_B1 = randomUUID();

const IDS_AGENTES = [AGENTE_A, AGENTE_B];
const IDS_LOJAS = [LOJA_A1, LOJA_A2, LOJA_B1];

const PLATAFORMA = "shopee";
const RECURSO_CHAT = "chat";
const RECURSO_PEDIDOS = "pedidos";
const RECURSO_INVALIDO = "chat_invalido";

/** Carimbos controlados: a distancia entre eles e conhecida, entao a
 *  prova de que `alterado_em` avancou nao depende de sleep nem do
 *  relogio do servidor. */
const T1 = new Date(Date.now() - 60_000);
const T2 = new Date(T1.getTime() + 1_000);

// ─── SQL ──────────────────────────────────────────────────────────────

const SQL_INSERT_AGENTE =
  "insert into public.agentes (id, user_id, nome, tipo) values ($1, $2, $3, 'gerente')";

const SQL_INSERT_LOJA =
  "insert into public.lojas (id, user_id, nome, marketplace) values ($1, $2, $3, 'Shopee')";

/** O equivalente literal do que `definirSelecaoDeLoja` produz: seis
 *  colunas, alvo de conflito na PK, e o DO UPDATE tocando apenas o que
 *  muda. `criado_em` nao aparece — nem no INSERT nem no UPDATE. */
const SQL_UPSERT_SELECAO = `
insert into public.agente_conexoes (agente_id, user_id, plataforma, recurso, loja_id, alterado_em)
values ($1, $2, $3, $4, $5, $6)
on conflict (agente_id, plataforma, recurso)
do update set user_id = excluded.user_id, loja_id = excluded.loja_id, alterado_em = excluded.alterado_em`;

const SQL_LER_SELECAO = `
select user_id, loja_id, criado_em, alterado_em
  from public.agente_conexoes
 where agente_id = $1 and plataforma = $2 and recurso = $3`;

const SQL_DELETE_SELECAO = `
delete from public.agente_conexoes
 where user_id = $1 and agente_id = $2 and plataforma = $3 and recurso = $4
returning agente_id`;

// ─── Auto-verificacao estrutural (roda SEM banco) ─────────────────────

const FONTE = readFileSync(__filename, "utf8");

/**
 * O recorte OPERACIONAL: a fonte sem o proprio bloco de sondas.
 *
 * Sem isto, cada sonda encontra a si mesma — o regex que procura
 * `seller_id` contem `seller_id`, o que procura `alter table` contem
 * `alter table`, e a suite acusa defeito que nao existe. E a mesma
 * imprecisao ja registrada como debito `P7`, e a correcao e a do
 * precedente da f.4: medir o codigo que EXECUTA, nunca o que MEDE.
 *
 * Comentario e removido DEPOIS do recorte, para que os marcadores usados
 * como fronteira ainda existam na hora de cortar.
 */
// As agulhas sao montadas por concatenacao: escritas inteiras, ELAS
// mesmas seriam a primeira ocorrencia no arquivo, e o recorte cairia
// sobre estas duas linhas em vez de sobre as funcoes.
const I_AUTO = FONTE.indexOf("function auto" + "Verificar(): void {");
const I_MAIN = FONTE.indexOf("async function " + "main(): Promise<void> {");
const OPERACIONAL = FONTE.slice(0, I_AUTO) + FONTE.slice(I_MAIN);
const CORPO = OPERACIONAL.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

function autoVerificar(): void {
  secao("0. Auto-verificacao (pura, sem banco)");

  /** Montado por concatenacao para que a propria sonda nao case consigo. */
  const AGULHA_CONFIRMAR_TX = "com" + "mit";

  const iFlag = CORPO.indexOf("if (!CONFIRMADO)");
  const iEnv = CORPO.indexOf("lerEnv()", iFlag);
  const iClient = CORPO.indexOf("new Client(");
  const iBegin = CORPO.indexOf('query("begin")');

  ok("Z0  ANCORA: o recorte tirou o bloco de sondas e sobrou codigo",
    I_AUTO > 0 && I_MAIN > I_AUTO && CORPO.length < FONTE.length - 3000 && CORPO.length > 2000);
  ok("Z1  o guarda --confirmo existe", iFlag > 0);
  ok("Z2  `lerEnv()` so e chamada DEPOIS do guarda", iFlag > 0 && iEnv > iFlag);
  ok("Z3  `new Client(` so aparece DEPOIS do guarda", iFlag > 0 && iClient > iFlag);
  ok("Z4  o BEGIN vem depois do guarda e depois do cliente",
    iBegin > iClient && iClient > iFlag);

  ok(`Z5  zero ${AGULHA_CONFIRMAR_TX.toUpperCase()} em qualquer query`,
    !CORPO.toLowerCase().includes(`"${AGULHA_CONFIRMAR_TX}`) &&
      !CORPO.toLowerCase().includes(`'${AGULHA_CONFIRMAR_TX}`));
  ok("Z6  CONTROLE: a sonda acharia se existisse",
    `query("${AGULHA_CONFIRMAR_TX}")`.toLowerCase().includes(`"${AGULHA_CONFIRMAR_TX}`));
  ok("Z7  exatamente UM begin", (CORPO.match(/query\("begin"\)/g) ?? []).length === 1);
  ok("Z8  ha rollback no corpo e no finally",
    (CORPO.match(/query\("rollback"\)/g) ?? []).length >= 2);

  // As 5 falhas esperadas passam por `esperarFalha`, que emite o trio
  // savepoint/rollback-to/release UMA vez cada, com rotulo proprio por
  // chamada. Contar os literais provaria o helper; contar as chamadas
  // prova a cobertura.
  ok("Z9  cinco falhas esperadas, cada uma isolada por savepoint",
    (CORPO.match(/esperarFalha\(/g) ?? []).length === 6 &&
      (CORPO.match(/query\(`savepoint \$\{rotulo\}`\)/g) ?? []).length === 1 &&
      (CORPO.match(/query\(`rollback to savepoint \$\{rotulo\}`\)/g) ?? []).length === 1 &&
      (CORPO.match(/query\(`release savepoint \$\{rotulo\}`\)/g) ?? []).length === 1,
    `chamadas=${(CORPO.match(/esperarFalha\(/g) ?? []).length}`);

  // As proximas sondas medem os VALORES das constantes de SQL, nao o
  // texto do arquivo: e o que efetivamente vai ao banco.
  const TODO_SQL = [SQL_INSERT_AGENTE, SQL_INSERT_LOJA, SQL_UPSERT_SELECAO, SQL_LER_SELECAO, SQL_DELETE_SELECAO].join("\n");

  ok("Z10 INSERT de agentes so com as 4 colunas autorizadas",
    SQL_INSERT_AGENTE.includes("(id, user_id, nome, tipo)"));
  ok("Z11 INSERT de lojas so com as 4 colunas autorizadas",
    SQL_INSERT_LOJA.includes("(id, user_id, nome, marketplace)"));
  ok("Z12 nenhuma credencial em SQL nenhum",
    !/access_token|refresh_token|partner_key|partner_id|token_expires_at|shop_id/.test(TODO_SQL));
  ok("Z13 seller_id nao aparece em SQL nenhum", !/seller_id/.test(TODO_SQL));
  ok("Z14 CONTROLE: a sonda de credencial acha quando existe",
    /access_token/.test("insert into lojas (access" + "_token)"));

  ok("Z15 upsert nao envia criado_em",
    /insert into public\.agente_conexoes \(agente_id, user_id, plataforma, recurso, loja_id, alterado_em\)/.test(CORPO) &&
      !/criado_em\s*=/.test(CORPO));
  ok("Z16 o alvo do conflito e a PK publicada",
    /on conflict \(agente_id, plataforma, recurso\)/.test(CORPO));
  ok("Z17 o DO UPDATE toca apenas user_id, loja_id e alterado_em",
    /do update set user_id = excluded\.user_id, loja_id = excluded\.loja_id, alterado_em = excluded\.alterado_em/.test(CORPO));

  ok("Z18 zero LIKE/ILIKE", !/\blike\b|\bilike\b/i.test(CORPO));
  ok("Z19 CONTROLE: a sonda de LIKE acha", /\blike\b/i.test("where u li" + "ke 'x%'"));
  ok("Z20 nenhum DELETE sem WHERE", !/delete\s+from\s+public\.\w+\s*(;|`|")/i.test(CORPO));
  ok("Z21 a suite nao cria tabela, funcao nem aplica migration",
    !/create\s+table|create\s+or\s+replace\s+function|apply_migration|alter\s+table/i.test(CORPO));
  ok("Z22 nenhuma mensagem bruta de erro e impressa",
    !/\.message\b|\.detail\b|\.hint\b|\.where\b/.test(CORPO));
  ok("Z23 CONTROLE: a sonda de mensagem bruta acha", /\.message\b/.test("console.log(e" + ".message)"));

  ok("Z24 os DELETE de fixture fecham por UUID sintetico",
    /delete from public\.lojas\s*\n?\s*where id = \$1 and user_id = \$2/.test(CORPO) &&
      /delete from public\.agentes\s*\n?\s*where id = \$1 and user_id = \$2/.test(CORPO));
  ok("Z25 a verificacao residual filtra por array de uuid",
    /= any\(\$1::uuid\[\]\)/.test(CORPO));
  ok("Z26 zero consumidor de producao importado",
    !/selecao-escrita|resolverFatoConexao|definirSelecaoDeLoja/.test(CORPO));
  ok("Z27 tenants sao uuid gerado, nao texto livre",
    /const TENANT_A = randomUUID\(\)/.test(CORPO) && /const TENANT_B = randomUUID\(\)/.test(CORPO));
}

// ─── Corpo ────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("\n══ CDS IA — SKILL-1D.g.2-C1: constraints reais do write path ══");

  autoVerificar();

  if (!CONFIRMADO) {
    console.log("\n  Sem `--confirmo`: nenhuma conexao foi aberta, nenhuma fixture");
    console.log("  criada e nada foi escrito. A execucao real exige autorizacao");
    console.log("  separada (SKILL-1D.g.2-C1).");
    console.log("  Para executar de verdade:");
    console.log("    npx tsx scripts/testar-ia-skill-1d-g2-banco.ts --confirmo\n");
    console.log(`  tentativas de conexao: ${tentativasDeConexao}`);
    console.log(`  ${passou}/${passou + falhou} passaram (auto-verificacao)\n`);
    // `exitCode` + `return`, nunca `process.exit`: sair abruptamente foi o
    // que fez a f.4-G reportar verde com o cenario inteiro ausente.
    process.exitCode = falhou > 0 ? 1 : 0;
    return;
  }

  const env = lerEnv();
  instalarGuardaDeSaida(segredosDe(env));

  console.log(`\n  alvo: ${descreverAlvo(env.DATABASE_URL)}`);
  console.log("\n  === RECUPERACAO DE FIXTURES 1D.g.2 ===");
  console.log(`  TENANT_A=${TENANT_A}`);
  console.log(`  TENANT_B=${TENANT_B}`);
  console.log(`  AGENTE_A=${AGENTE_A}`);
  console.log(`  AGENTE_B=${AGENTE_B}`);
  console.log(`  LOJA_A1=${LOJA_A1}`);
  console.log(`  LOJA_A2=${LOJA_A2}`);
  console.log(`  LOJA_B1=${LOJA_B1}`);
  console.log("  (tudo dentro de UMA transacao com ROLLBACK — nada deve sobreviver)");
  console.log("  === FIM DA RECUPERACAO ===");

  tentativasDeConexao++;
  const c = new Client({ connectionString: env.DATABASE_URL });
  let conectou = false;
  let transacaoAberta = false;
  let etapa = "inicio";

  /** Executa um statement que DEVE falhar, isolado por savepoint. */
  async function esperarFalha(rotulo: string, sql: string, args: unknown[]): Promise<string> {
    await c.query(`savepoint ${rotulo}`);
    let codigo = "sem-erro";
    try {
      await c.query(sql, args);
    } catch (e) {
      codigo = sqlstate(e);
    }
    await c.query(`rollback to savepoint ${rotulo}`);
    await c.query(`release savepoint ${rotulo}`);
    return codigo;
  }

  try {
    await c.connect();
    conectou = true;

    // ── A. Revalidacao do catalogo, ANTES de qualquer DML ───────────
    etapa = "revalidacao";
    secao("A. Catalogo revalidado (drift desde o C0)");

    const cols = (await c.query(
      `select table_name, column_name, data_type, udt_name, is_nullable, column_default,
              is_identity, is_generated
         from information_schema.columns
        where table_schema = 'public' and table_name = any($1)`,
      [["agentes", "lojas", "agente_conexoes"]]
    )).rows;

    const col = (t: string, n: string) => cols.find((r) => r.table_name === t && r.column_name === n);
    const obrigatorias = (t: string) =>
      cols
        .filter((r) => r.table_name === t && r.is_nullable === "NO" && r.column_default === null &&
          r.is_identity !== "YES" && r.is_generated === "NEVER")
        .map((r) => r.column_name)
        .sort();

    ok("A1  agentes: obrigatorias continuam nome, tipo, user_id",
      JSON.stringify(obrigatorias("agentes")) === JSON.stringify(["nome", "tipo", "user_id"]),
      obrigatorias("agentes").join(", "));
    ok("A2  lojas: a unica obrigatoria continua user_id",
      JSON.stringify(obrigatorias("lojas")) === JSON.stringify(["user_id"]),
      obrigatorias("lojas").join(", "));
    ok("A3  lojas.user_id continua text NOT NULL",
      col("lojas", "user_id")?.udt_name === "text" && col("lojas", "user_id")?.is_nullable === "NO");
    ok("A4  lojas.marketplace continua text NOT NULL com default",
      col("lojas", "marketplace")?.udt_name === "text" &&
        col("lojas", "marketplace")?.is_nullable === "NO" &&
        col("lojas", "marketplace")?.column_default !== null);
    ok("A5  lojas.access_token continua nullable — fixture sem credencial",
      col("lojas", "access_token")?.is_nullable === "YES");
    ok("A6  agente_conexoes: obrigatorias sao as 5 esperadas",
      JSON.stringify(obrigatorias("agente_conexoes")) ===
        JSON.stringify(["agente_id", "loja_id", "plataforma", "recurso", "user_id"]),
      obrigatorias("agente_conexoes").join(", "));
    ok("A7  criado_em e alterado_em tem default — por isso criado_em fica fora do payload",
      col("agente_conexoes", "criado_em")?.column_default !== null &&
        col("agente_conexoes", "alterado_em")?.column_default !== null);

    const cons = (await c.query(
      `select c.relname as tabela, con.conname, con.contype, con.convalidated,
              con.confupdtype, con.confdeltype, pg_get_constraintdef(con.oid) as def
         from pg_constraint con
         join pg_class c on c.oid = con.conrelid
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relname = any($1)`,
      [["agentes", "lojas", "agente_conexoes"]]
    )).rows;

    const acharCon = (t: string, nome: string) => cons.find((r) => r.tabela === t && r.conname === nome);

    const fkAgente = acharCon("agente_conexoes", "agente_conexoes_agente_do_mesmo_dono");
    ok("A8  FK do agente existe, e FOREIGN KEY e esta VALID",
      fkAgente?.contype === "f" && fkAgente?.convalidated === true);
    ok("A9  FK do agente: colunas e referencia nominais",
      /FOREIGN KEY \(agente_id, user_id\) REFERENCES agentes\(id, user_id\)/.test(String(fkAgente?.def)),
      String(fkAgente?.def));
    ok("A10 FK do agente: ON DELETE CASCADE e ON UPDATE RESTRICT",
      fkAgente?.confdeltype === "c" && fkAgente?.confupdtype === "r");

    const fkLoja = acharCon("agente_conexoes", "agente_conexoes_loja_do_mesmo_dono");
    ok("A11 FK da loja existe, e FOREIGN KEY e esta VALID",
      fkLoja?.contype === "f" && fkLoja?.convalidated === true);
    ok("A12 FK da loja: colunas e referencia nominais",
      /FOREIGN KEY \(loja_id, user_id\) REFERENCES lojas\(id, user_id\)/.test(String(fkLoja?.def)),
      String(fkLoja?.def));
    ok("A13 FK da loja: ON DELETE RESTRICT e ON UPDATE RESTRICT",
      fkLoja?.confdeltype === "r" && fkLoja?.confupdtype === "r");

    const pk = acharCon("agente_conexoes", "agente_conexoes_pk");
    ok("A14 PK viva e igual ao alvo do ON CONFLICT",
      pk?.contype === "p" && pk?.convalidated === true &&
        /PRIMARY KEY \(agente_id, plataforma, recurso\)/.test(String(pk?.def)),
      String(pk?.def));

    const chk = acharCon("agente_conexoes", "agente_conexoes_recurso_formato");
    ok("A15 CHECK de recurso vivo e VALID", chk?.contype === "c" && chk?.convalidated === true);
    ok("A16 zero CHECK de plataforma — decisao arquitetural intacta",
      cons.filter((r) => r.tabela === "agente_conexoes" && r.contype === "c" &&
        /plataforma/.test(String(r.def))).length === 0);
    ok("A17 ancoras de owner vivas nas duas tabelas referenciadas",
      acharCon("agentes", "agentes_id_por_dono")?.convalidated === true &&
        acharCon("lojas", "lojas_id_user_id_unico")?.convalidated === true);
    ok("A18 CHECK de formato uuid em lojas.user_id continua ativo",
      acharCon("lojas", "lojas_user_id_formato_uuid")?.convalidated === true);

    const trg = (await c.query(
      `select c.relname as tabela, t.tgname
         from pg_trigger t
         join pg_class c on c.oid = t.tgrelid
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relname = any($1) and not t.tgisinternal`,
      [["agentes", "lojas", "agente_conexoes"]]
    )).rows;
    ok("A19 zero trigger nao interno nas tres tabelas", trg.length === 0,
      trg.map((r) => `${r.tabela}.${r.tgname}`).join(", "));

    const semDrift = falhou === 0;
    ok("A20 PORTAO: catalogo sem drift — DML autorizado", semDrift);
    if (!semDrift) {
      console.log("\n  DRIFT DETECTADO — nenhuma transacao mutante sera aberta.\n");
      console.log(`\n  ${passou}/${passou + falhou} passaram  ·  ${falhou} FALHARAM\n`);
      process.exitCode = 1;
      return;
    }

    // ── B. Fixtures ─────────────────────────────────────────────────
    etapa = "begin";
    await c.query("begin");
    transacaoAberta = true;

    secao("B. Fixtures sinteticas");
    etapa = "fixtures";

    await c.query(SQL_INSERT_AGENTE, [AGENTE_A, TENANT_A, "Agente G2 Banco A"]);
    await c.query(SQL_INSERT_AGENTE, [AGENTE_B, TENANT_B, "Agente G2 Banco B"]);
    await c.query(SQL_INSERT_LOJA, [LOJA_A1, TENANT_A, "Loja G2 Banco A1"]);
    await c.query(SQL_INSERT_LOJA, [LOJA_A2, TENANT_A, "Loja G2 Banco A2"]);
    await c.query(SQL_INSERT_LOJA, [LOJA_B1, TENANT_B, "Loja G2 Banco B1"]);

    const nAg = (await c.query("select count(*)::int as n from public.agentes where id = any($1::uuid[])",
      [IDS_AGENTES])).rows[0].n;
    const nLj = (await c.query("select count(*)::int as n from public.lojas where id = any($1::uuid[])",
      [IDS_LOJAS])).rows[0].n;
    ok("B1  2 agentes sinteticos criados", nAg === 2, String(nAg));
    ok("B2  3 lojas sinteticas criadas", nLj === 3, String(nLj));

    // ── C. Upsert inicial ───────────────────────────────────────────
    etapa = "upsert-inicial";
    secao("C. Primeira definicao");

    await c.query(SQL_UPSERT_SELECAO,
      [AGENTE_A, TENANT_A, PLATAFORMA, RECURSO_CHAT, LOJA_A1, T1.toISOString()]);

    const r1 = (await c.query(SQL_LER_SELECAO, [AGENTE_A, PLATAFORMA, RECURSO_CHAT])).rows;
    ok("C1  exatamente 1 linha", r1.length === 1, String(r1.length));
    ok("C2  user_id = tenant A", r1[0]?.user_id === TENANT_A);
    ok("C3  loja_id = loja A1", r1[0]?.loja_id === LOJA_A1);
    ok("C4  alterado_em = t1", new Date(r1[0]?.alterado_em).getTime() === T1.getTime());
    const criadoEmInicial: Date = r1[0]?.criado_em;
    ok("C5  criado_em foi preenchido pelo DEFAULT", criadoEmInicial instanceof Date);

    // ── D. Substituicao ─────────────────────────────────────────────
    etapa = "substituicao";
    secao("D. Substituicao pela mesma identidade");

    await c.query(SQL_UPSERT_SELECAO,
      [AGENTE_A, TENANT_A, PLATAFORMA, RECURSO_CHAT, LOJA_A2, T2.toISOString()]);

    const r2 = (await c.query(SQL_LER_SELECAO, [AGENTE_A, PLATAFORMA, RECURSO_CHAT])).rows;
    ok("D1  continua exatamente 1 linha — a PK segurou", r2.length === 1, String(r2.length));
    ok("D2  loja_id agora = loja A2", r2[0]?.loja_id === LOJA_A2);
    ok("D3  user_id continua tenant A", r2[0]?.user_id === TENANT_A);
    ok("D4  criado_em preservado byte a byte",
      new Date(r2[0]?.criado_em).getTime() === criadoEmInicial.getTime());
    ok("D5  alterado_em avancou para t2", new Date(r2[0]?.alterado_em).getTime() === T2.getTime());
    ok("D6  ANCORA: t2 > t1", T2.getTime() > T1.getTime());

    // ── E. Cross-tenant e troca de dono ─────────────────────────────
    etapa = "cross-tenant";
    secao("E. As duas FKs compostas, isoladas uma a uma");

    const eLoja = await esperarFalha("cross_store", SQL_UPSERT_SELECAO,
      [AGENTE_A, TENANT_A, PLATAFORMA, RECURSO_PEDIDOS, LOJA_B1, T1.toISOString()]);
    ok("E1  loja de outro dono -> 23503 (isola a FK da LOJA)", eLoja === "23503", eLoja);

    const eAgente = await esperarFalha("cross_agent", SQL_UPSERT_SELECAO,
      [AGENTE_B, TENANT_A, PLATAFORMA, RECURSO_PEDIDOS, LOJA_A1, T1.toISOString()]);
    ok("E2  agente de outro dono -> 23503 (isola a FK do AGENTE)", eAgente === "23503", eAgente);

    const nPedidosA = (await c.query(
      "select count(*)::int as n from public.agente_conexoes where agente_id = $1 and plataforma = $2 and recurso = $3",
      [AGENTE_A, PLATAFORMA, RECURSO_PEDIDOS])).rows[0].n;
    ok("E3  nenhuma linha invalida sobreviveu aos savepoints", nPedidosA === 0, String(nPedidosA));

    // O caso critico: o ramo DO UPDATE tentando levar a linha para outro
    // dono. `LOJA_B1 + TENANT_B` e par VALIDO — entao o unico que pode
    // recusar e a FK do agente, e a recusa e o que prova que o upsert nao
    // consegue pisar em linha alheia.
    const eSwap = await esperarFalha("owner_swap", SQL_UPSERT_SELECAO,
      [AGENTE_A, TENANT_B, PLATAFORMA, RECURSO_CHAT, LOJA_B1, T2.toISOString()]);
    ok("E4  troca de dono no DO UPDATE -> 23503", eSwap === "23503", eSwap);

    const r3 = (await c.query(SQL_LER_SELECAO, [AGENTE_A, PLATAFORMA, RECURSO_CHAT])).rows;
    ok("E5  a linha original ficou intacta — dono", r3[0]?.user_id === TENANT_A);
    ok("E6  a linha original ficou intacta — loja", r3[0]?.loja_id === LOJA_A2);
    ok("E7  a linha original ficou intacta — carimbo",
      new Date(r3[0]?.alterado_em).getTime() === T2.getTime());
    ok("E8  zero atualizacao parcial", r3.length === 1);

    // ── F. CHECK de recurso ─────────────────────────────────────────
    etapa = "check-recurso";
    secao("F. CHECK de formato do recurso");

    const eCheck = await esperarFalha("recurso_invalido", SQL_UPSERT_SELECAO,
      [AGENTE_A, TENANT_A, PLATAFORMA, RECURSO_INVALIDO, LOJA_A1, T1.toISOString()]);
    ok("F1  recurso com underscore -> 23514", eCheck === "23514", eCheck);

    const nInv = (await c.query(
      "select count(*)::int as n from public.agente_conexoes where agente_id = $1 and recurso = $2",
      [AGENTE_A, RECURSO_INVALIDO])).rows[0].n;
    ok("F2  nenhuma linha criada com recurso invalido", nInv === 0, String(nInv));

    // ── G. RESTRICT da loja ─────────────────────────────────────────
    etapa = "restrict-loja";
    secao("G. ON DELETE RESTRICT protege a loja selecionada");

    const eRestrict = await esperarFalha("restrict_loja",
      "delete from public.lojas where id = $1 and user_id = $2", [LOJA_A2, TENANT_A]);
    ok("G1  apagar a loja selecionada -> 23503", eRestrict === "23503", eRestrict);

    const nLojaA2 = (await c.query("select count(*)::int as n from public.lojas where id = $1", [LOJA_A2]))
      .rows[0].n;
    ok("G2  loja A2 continua existindo", nLojaA2 === 1, String(nLojaA2));

    const r4 = (await c.query(SQL_LER_SELECAO, [AGENTE_A, PLATAFORMA, RECURSO_CHAT])).rows;
    ok("G3  a selecao continua existindo", r4.length === 1);
    ok("G4  e continua apontando para a loja A2", r4[0]?.loja_id === LOJA_A2);

    // ── H. CASCADE do agente ────────────────────────────────────────
    etapa = "cascade-agente";
    secao("H. ON DELETE CASCADE limpa a selecao do agente apagado");

    await c.query(SQL_UPSERT_SELECAO,
      [AGENTE_B, TENANT_B, PLATAFORMA, RECURSO_PEDIDOS, LOJA_B1, T1.toISOString()]);
    const nB0 = (await c.query(SQL_LER_SELECAO, [AGENTE_B, PLATAFORMA, RECURSO_PEDIDOS])).rows.length;
    ok("H1  selecao do agente B criada", nB0 === 1, String(nB0));

    const del = await c.query("delete from public.agentes where id = $1 and user_id = $2",
      [AGENTE_B, TENANT_B]);
    ok("H2  o agente B foi apagado", del.rowCount === 1, String(del.rowCount));

    const nB1 = (await c.query(SQL_LER_SELECAO, [AGENTE_B, PLATAFORMA, RECURSO_PEDIDOS])).rows.length;
    ok("H3  a selecao dele sumiu por CASCADE", nB1 === 0, String(nB1));

    const nLojaB1 = (await c.query("select count(*)::int as n from public.lojas where id = $1", [LOJA_B1]))
      .rows[0].n;
    ok("H4  a loja B1 NAO foi apagada junto", nLojaB1 === 1, String(nLojaB1));

    // ── I. DELETE ... RETURNING ─────────────────────────────────────
    etapa = "delete-returning";
    secao("I. A semantica de remocao, composta com a suite local");

    const d1 = await c.query(SQL_DELETE_SELECAO, [TENANT_A, AGENTE_A, PLATAFORMA, RECURSO_CHAT]);
    ok("I1  primeira remocao devolve 1 linha -> `removida`", d1.rows.length === 1, String(d1.rows.length));

    const d2 = await c.query(SQL_DELETE_SELECAO, [TENANT_A, AGENTE_A, PLATAFORMA, RECURSO_CHAT]);
    ok("I2  segunda remocao devolve 0 linhas -> `nao_encontrada`", d2.rows.length === 0, String(d2.rows.length));

    // ── J. Rollback ─────────────────────────────────────────────────
    etapa = "rollback";
    secao("J. Rollback obrigatorio");

    await c.query("rollback");
    transacaoAberta = false;
    rollbackFinalExecutado = true;
    ok("J1  rollback final executado", rollbackFinalExecutado);
    ok("J2  a transacao NAO foi confirmada", transacaoConfirmada === false);

    // ── K. Residuo ──────────────────────────────────────────────────
    etapa = "residuo";
    secao("K. Nada sobreviveu");

    const resAg = (await c.query("select count(*)::int as n from public.agentes where id = any($1::uuid[])",
      [IDS_AGENTES])).rows[0].n;
    const resLj = (await c.query("select count(*)::int as n from public.lojas where id = any($1::uuid[])",
      [IDS_LOJAS])).rows[0].n;
    const resSel = (await c.query(
      "select count(*)::int as n from public.agente_conexoes where agente_id = any($1::uuid[])",
      [IDS_AGENTES])).rows[0].n;

    ok("K1  zero agente residual", resAg === 0, String(resAg));
    ok("K2  zero loja residual", resLj === 0, String(resLj));
    ok("K3  zero selecao residual", resSel === 0, String(resSel));
    ok("K4  residuo total zero", resAg + resLj + resSel === 0, String(resAg + resLj + resSel));
    etapa = "fim";
  } catch (e) {
    console.error(`\n  ERRO na etapa "${etapa}" (sqlstate ${sqlstate(e)})`);
    falhou++;
  } finally {
    if (conectou && transacaoAberta) {
      await c.query("rollback").then(() => { rollbackFinalExecutado = true; }).catch(() => undefined);
    }
    if (conectou) await c.end().catch(() => undefined);
  }

  secao("L. Desfecho");
  ok(`L1  o fluxo chegou ao fim (etapa=${etapa})`, etapa === "fim", `parou em ${etapa}`);
  ok("L2  rollback ocorreu", rollbackFinalExecutado);
  ok("L3  commit nunca ocorreu", transacaoConfirmada === false);

  console.log(`\n${"═".repeat(66)}`);
  console.log(`  ${passou}/${passou + falhou} passaram` + (falhou > 0 ? `  ·  ${falhou} FALHARAM` : ""));
  console.log(`${"═".repeat(66)}\n`);

  // Status decidido DEPOIS de tudo — nunca de dentro do `finally`.
  process.exitCode = falhou > 0 ? 1 : 0;
}

main().catch((e) => {
  console.error("\n  ERRO FATAL fora do corpo instrumentado:", sqlstate(e));
  process.exitCode = 1;
});
