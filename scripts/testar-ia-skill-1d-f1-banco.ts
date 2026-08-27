/**
 * CDS IA — SKILL-1D.f.1b. Prova REAL de `skills` e `agente_skills`.
 *
 *   ┌──────────────────────────────────────────────────────────────┐
 *   │  SUITE COM ESCRITA · BANCO REAL · TRANSACAO + ROLLBACK       │
 *   └──────────────────────────────────────────────────────────────┘
 *
 * Rodar:
 *   npx tsx scripts/testar-ia-skill-1d-f1-banco.ts             # so audita, NAO conecta
 *   npx tsx scripts/testar-ia-skill-1d-f1-banco.ts --confirmo  # execucao real
 *
 * ── Por que TRANSACAO, e nao DELETE no fim ──────────────────────────
 *
 * A d.1b limpava com DELETE em `finally`. Funciona, mas depende de o
 * `finally` rodar: processo morto no meio deixa residuo. Aqui tudo roda
 * dentro de UMA transacao que termina em ROLLBACK — se o processo morrer,
 * o proprio Postgres desfaz.
 *
 * O jeito ingenuo NAO funciona: no Postgres qualquer violacao ABORTA a
 * transacao, e os comandos seguintes falham com 25P02. Como ~20 provas
 * aqui sao falhas ESPERADAS, uma transacao plana morreria no primeiro
 * 23505. Por isso cada falha esperada roda dentro de um SAVEPOINT, com
 * `rollback to savepoint` logo depois.
 *
 * ── Por que ids EXATOS, e nao `LIKE 'prefixo%'` ─────────────────────
 *
 * A d.1b apagava por prefixo. Um wildcard alcanca, por construcao,
 * qualquer linha que combine — inclusive de outra execucao concorrente,
 * ou de um prefixo digitado errado. Aqui a suite REGISTRA cada id que
 * cria e so apaga esses. O prefixo continua existindo, mas apenas como
 * PROVA de residuo zero — nunca como autorizacao de DELETE.
 *
 * ── Segredo ─────────────────────────────────────────────────────────
 *
 * A string de conexao e lida DENTRO do processo e nunca chega ao stdout.
 * `instalarGuardaDeSaida()` intercepta cada byte escrito e aborta se algo
 * com forma de credencial passar. Erro de driver nunca e ecoado bruto —
 * so o SQLSTATE.
 */
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

// ─── Guarda de saida ──────────────────────────────────────────────────

/**
 * Barreira de saida. Recebe os segredos reais para procura-los
 * literalmente — e nunca os imprime, nem quando dispara.
 */
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

// ─── Identidade sintetica ─────────────────────────────────────────────

const RUN = Math.random().toString(36).slice(2, 10);
const NS = `test-skill-1d-f1b-${RUN}`;
const DONO_A = `${NS}-a`;
const DONO_B = `${NS}-b`;
/** Slug precisa casar `^[a-z0-9]+(-[a-z0-9]+)*$`. `RUN` e [0-9a-z]. */
const SLUG_A = `teste-f1b-${RUN}-a`;
const SLUG_B = `teste-f1b-${RUN}-b`;

/**
 * Tudo que esta execucao criou, por id EXATO. O cleanup opera sobre esta
 * lista — nunca sobre um wildcard.
 */
const criados = {
  agentes: [] as string[],
  skills: [] as string[],
  associacoes: [] as Array<{ agenteId: string; skillId: string }>,
};

/**
 * Barreira de execucao, nao conferencia de revisao: LANCA se um
 * identificador que nao pertence a esta execucao chegar a uma escrita.
 */
function exigirSintetico(valor: string): string {
  if (!valor.startsWith(NS)) {
    throw new Error("GUARDA: identificador nao pertence a esta execucao");
  }
  return valor;
}

/** Para uuid gerado pelo banco: so aceita o que esta execucao registrou. */
function exigirRegistrado(id: string, lista: readonly string[]): string {
  if (!lista.includes(id)) {
    throw new Error("GUARDA: uuid nao foi criado por esta execucao");
  }
  return id;
}

// ─── Conexao ──────────────────────────────────────────────────────────

function lerConexao(): string {
  const txt = readFileSync(join(__dirname, "..", ".env.local"), "utf8");
  // Aceita valor com e SEM aspas, e exclui `\r`: em arquivo CRLF o padrao
  // sem ele engoliria o retorno de carro para dentro da credencial.
  const m = txt.match(/^DATABASE_URL\s*=\s*"?([^"\r\n]+)"?/m);
  if (!m) throw new Error("DATABASE_URL ausente em .env.local");
  return m[1];
}

/** Campos separados, sem remontar URL — `esquema://host` seria bloqueado. */
function descreverAlvo(url: string): string {
  const u = new URL(url);
  const host = u.hostname.replace(/^([a-z]{3})[^.]*/, "$1***");
  return `host=${host}  porta=${u.port}  database=${u.pathname.replace("/", "")}`;
}

function segredosDe(url: string): string[] {
  const u = new URL(url);
  const brutos = [u.password, u.username];
  const dec = brutos.map((v) => { try { return decodeURIComponent(v); } catch { return v; } });
  return Array.from(new Set([...brutos, ...dec])).filter(Boolean);
}

/** O SQLSTATE, que e a prova de QUEM recusou. Nunca a mensagem. */
function sqlstate(e: unknown): string {
  return (e as { code?: string })?.code ?? "sem-codigo";
}

// ─── Auto-verificacao estrutural (roda SEM banco) ─────────────────────
//
// Prova, sobre o proprio fonte, que a conexao so acontece depois da
// confirmacao. E o unico jeito de afirmar isso sem executar o caminho
// que se quer provar que nao executa.
function autoVerificar(): void {
  secao("0. Auto-verificacao (pura, sem banco)");

  // Caminho EXPLICITO: derivar de `__filename` dependeria de como o
  // runner resolve o modulo, e um `readFileSync` que falha aqui derrubaria
  // a suite antes de qualquer assert.
  const fonte = readFileSync(join(__dirname, "testar-ia-skill-1d-f1-banco.ts"), "utf8");

  // ── UMA SONDA QUE VARRE O PROPRIO FONTE CASA CONSIGO MESMA ────────
  //
  // Medido: as primeiras versoes de Z5/Z7/Z8 reprovavam porque batiam nos
  // LITERAIS delas mesmas — o controle positivo da Z6, a regex da Z7 e a
  // string do rotulo da Z8. Nao era defeito da suite; era a sonda se
  // enxergando. Por isso o corpo desta funcao e RECORTADO antes de
  // qualquer varredura, e `ANCORA` prova que o recorte tirou algo.
  const iAuto = fonte.indexOf("function autoVerificar()");
  const fimAuto = fonte.indexOf("\n}\n", iAuto);
  const CORPO = fonte.slice(0, iAuto) + fonte.slice(fimAuto);

  const iFlag = CORPO.indexOf("if (!CONFIRMADO)");
  const iLer = CORPO.indexOf("lerConexao()", iFlag);
  const iClient = CORPO.indexOf("new Client(");

  ok("Z1  o guarda --confirmo existe", iFlag > 0);
  ok("Z2  `lerConexao()` so e chamada DEPOIS do guarda", iFlag > 0 && iLer > iFlag);
  ok("Z3  `new Client(` so aparece DEPOIS do guarda", iFlag > 0 && iClient > iFlag);
  ok("Z4  o guarda de saida e instalado antes de descrever o alvo",
    CORPO.indexOf("instalarGuardaDeSaida(") < CORPO.indexOf("descreverAlvo(url)"));
  ok("Z5  ANCORA: o recorte removeu o bloco de auto-verificacao",
    iAuto > 0 && fimAuto > iAuto && CORPO.length < fonte.length - 500);

  ok("Z6  nenhum DELETE por wildcard fora desta funcao",
    !/delete from[^;]*like/i.test(CORPO));
  ok("Z7  CONTROLE: a sonda de wildcard acha quando existe",
    /delete from[^;]*like/i.test("delete " + "from t where u like 'x%'"));

  ok("Z8  a suite NAO aplica migration nem cria tabela",
    !/create\s+table|apply_migration/i.test(CORPO));
  ok("Z9  CONTROLE: a sonda de DDL acha quando existe",
    /create\s+table/i.test("create table x ()"));

  ok("Z10 nenhuma mensagem de erro bruta e impressa",
    !/\.message\b/.test(CORPO));
  ok("Z11 CONTROLE: a sonda de mensagem bruta acha quando existe",
    /\.message\b/.test("console.log(e" + ".message)"));

  ok("Z12 cleanup opera por id exato — `exigirRegistrado` presente",
    /exigirRegistrado\(/.test(CORPO));
}

// ─── Execucao ─────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("\n══ CDS IA — SKILL-1D.f.1b: skills + agente_skills em BANCO REAL ══");
  console.log("   SUITE COM ESCRITA · BANCO REAL · TRANSACAO + ROLLBACK");

  autoVerificar();

  if (!CONFIRMADO) {
    console.log("\n  Sem `--confirmo`: nenhuma conexao foi aberta e nada foi escrito.");
    console.log("  Para executar de verdade:");
    console.log("    npx tsx scripts/testar-ia-skill-1d-f1-banco.ts --confirmo\n");
    console.log(`  ${passou}/${passou + falhou} passaram (auto-verificacao)\n`);
    process.exit(falhou > 0 ? 1 : 0);
  }

  const url = lerConexao();
  instalarGuardaDeSaida(segredosDe(url));

  console.log(`\n  alvo: ${descreverAlvo(url)}`);
  console.log(`  namespace desta execucao: ${NS}`);

  const c = new Client({ connectionString: url });
  await c.connect();

  let emTransacao = false;

  /** Falha ESPERADA, isolada por savepoint. */
  let nSp = 0;
  async function esperarFalha(nome: string, esperado: string, fn: () => Promise<unknown>): Promise<void> {
    const sp = `sp${++nSp}`;
    await c.query(`savepoint ${sp}`);
    let code: string | null = null;
    try { await fn(); } catch (e) { code = sqlstate(e); }
    await c.query(`rollback to savepoint ${sp}`);
    await c.query(`release savepoint ${sp}`);
    if (code === null) ok(nome, false, "NAO falhou — a operacao foi aceita");
    else ok(`${nome} (${code})`, code === esperado, `esperado ${esperado}`);
  }

  /** Operacao que deve FUNCIONAR, mas cujo efeito nao deve persistir. */
  async function isolado<T>(fn: () => Promise<T>): Promise<{ erro: string | null }> {
    const sp = `sp${++nSp}`;
    await c.query(`savepoint ${sp}`);
    let erro: string | null = null;
    try { await fn(); } catch (e) { erro = sqlstate(e); }
    await c.query(`rollback to savepoint ${sp}`);
    await c.query(`release savepoint ${sp}`);
    return { erro };
  }

  const manifesto = (slug: string, versao: string, nome: string, origem = "importada") =>
    JSON.stringify({
      formato: 1, id: slug, nome, versao,
      descricao: "Skill sintetica da suite 1D.f.1b.",
      quando_usar: ["prova automatizada"], origem,
    });
  const HASH = "a".repeat(64);

  async function criarSkill(
    dono: string, slug: string, versao: string, nome: string, origem = "importada"
  ): Promise<string> {
    const r = await c.query(
      `insert into public.skills (user_id, slug, versao, nome, origem, manifesto, corpo, conteudo_hash)
       values ($1,$2,$3,$4,$5,$6::jsonb,$7,$8) returning id`,
      [exigirSintetico(dono), slug, versao, nome, origem, manifesto(slug, versao, nome, origem), "corpo", HASH]
    );
    const id = r.rows[0].id as string;
    criados.skills.push(id);
    return id;
  }

  async function criarAgente(dono: string, nome: string): Promise<string> {
    const r = await c.query(
      `insert into public.agentes (user_id, nome, tipo) values ($1,$2,'gerente') returning id`,
      [exigirSintetico(dono), nome]
    );
    const id = r.rows[0].id as string;
    criados.agentes.push(id);
    return id;
  }

  async function associar(agenteId: string, skillId: string, dono: string): Promise<void> {
    await c.query(
      `insert into public.agente_skills (agente_id, skill_id, user_id) values ($1,$2,$3)`,
      [agenteId, skillId, exigirSintetico(dono)]
    );
    criados.associacoes.push({ agenteId, skillId });
  }

  try {
    // ── PRE-VOO ───────────────────────────────────────────────────────
    secao("A. Pre-voo (antes de qualquer fixture)");

    const viva = await c.query("select 1 as v");
    ok("A1  a conexao responde", viva.rows[0].v === 1);

    const hist = await c.query<{ version: string; name: string }>(
      `select version, name from supabase_migrations.schema_migrations where name = 'skills'`
    );
    ok(`A2  a migration 'skills' esta registrada (${hist.rowCount} entrada)`, hist.rowCount === 1);
    ok(`A3  versao gerada na aplicacao, 14 digitos (${hist.rows[0]?.version ?? "-"})`,
      /^\d{14}$/.test(hist.rows[0]?.version ?? ""));
    ok("A4  NAO se assume a versao 20260922 do nome do arquivo",
      hist.rows[0]?.version !== "20260922");

    const tabs = await c.query<{ n: string }>(
      `select relname as n from pg_class
        where relnamespace = 'public'::regnamespace and relname in ('skills','agente_skills')`
    );
    ok("A5  as duas tabelas existem",
      tabs.rows.map((r) => r.n).sort().join(",") === "agente_skills,skills");

    const cons = await c.query<{ n: number }>(
      `select count(*)::int as n from pg_constraint
        where conrelid in ('public.skills'::regclass, 'public.agente_skills'::regclass)`
    );
    ok(`A6  constraints presentes (${cons.rows[0].n})`, cons.rows[0].n >= 15);

    // SET ROLE exige associacao. Provado aqui, isolado, antes de depender disso.
    await c.query("begin");
    emTransacao = true;
    const podeSetRole = await isolado(async () => { await c.query("set local role service_role"); });
    ok("A7  `postgres` consegue SET LOCAL ROLE service_role", podeSetRole.erro === null,
      String(podeSetRole.erro));

    const linhasAntes = await c.query<{ s: number; a: number }>(
      `select (select count(*) from public.skills)::int as s,
              (select count(*) from public.agente_skills)::int as a`
    );
    console.log(`  linhas pre-existentes: skills=${linhasAntes.rows[0].s} agente_skills=${linhasAntes.rows[0].a}`);

    // ── FIXTURES ──────────────────────────────────────────────────────
    secao("B. Fixtures (dentro da transacao, desfeitos no fim)");

    const agA = await criarAgente(DONO_A, "AGENTE SINTETICO F1B A");
    const agB = await criarAgente(DONO_B, "AGENTE SINTETICO F1B B");
    const skA = await criarSkill(DONO_A, SLUG_A, "1.0.0", "Skill A");
    const skB = await criarSkill(DONO_B, SLUG_B, "1.0.0", "Skill B");

    ok("B1  agentes A e B criados", agA.length === 36 && agB.length === 36);
    ok("B2  skills A e B criadas", skA.length === 36 && skB.length === 36);
    ok("B3  os ids ficaram REGISTRADOS para o cleanup exato",
      criados.agentes.length === 2 && criados.skills.length === 2);
    ok("B4  o guarda recusa dono nao sintetico",
      await (async () => { try { exigirSintetico("dono-real"); return false; } catch { return true; } })());
    ok("B5  o guarda recusa uuid nao registrado",
      await (async () => { try { exigirRegistrado("00000000-0000-0000-0000-000000000000", criados.skills); return false; } catch { return true; } })());

    // ── C. skills, provas A–L ─────────────────────────────────────────
    secao("C. skills — INSERT valido e as recusas (A-L)");

    ok("C-A  INSERT valido foi aceito (fixtures acima)", criados.skills.length === 2);

    await esperarFalha("C-B  duplicata (user_id, slug, versao)", "23505", () =>
      criarSkill(DONO_A, SLUG_A, "1.0.0", "Skill A"));

    {
      const r = await isolado(() => criarSkill(DONO_B, SLUG_A, "1.0.0", "Mesmo slug, outro dono"));
      ok("C-C  mesmo slug/versao em OUTRO dono e aceito", r.erro === null, String(r.erro));
    }

    for (const [rot, h] of [["63 chars", "a".repeat(63)], ["65 chars", "a".repeat(65)],
                            ["maiusculo", "A".repeat(64)], ["nao-hex", "g".repeat(64)]] as const) {
      await esperarFalha(`C-D  hash ${rot}`, "23514", () =>
        c.query(
          `insert into public.skills (user_id, slug, versao, nome, origem, manifesto, corpo, conteudo_hash)
           values ($1,$2,'2.0.0','N','importada',$3::jsonb,'c',$4)`,
          [exigirSintetico(DONO_A), `${SLUG_A}-h`, manifesto(`${SLUG_A}-h`, "2.0.0", "N"), h]
        ));
    }

    await esperarFalha("C-E  origem invalida", "23514", () =>
      c.query(
        `insert into public.skills (user_id, slug, versao, nome, origem, manifesto, corpo, conteudo_hash)
         values ($1,$2,'2.0.0','N','pirata',$3::jsonb,'c',$4)`,
        [exigirSintetico(DONO_A), `${SLUG_A}-o`,
         manifesto(`${SLUG_A}-o`, "2.0.0", "N", "pirata"), HASH]
      ));

    for (const [rot, m] of [["array", "[]"], ["escalar", '"x"']] as const) {
      await esperarFalha(`C-F  manifesto ${rot}`, "23514", () =>
        c.query(
          `insert into public.skills (user_id, slug, versao, nome, origem, manifesto, corpo, conteudo_hash)
           values ($1,$2,'2.0.0','N','importada',$3::jsonb,'c',$4)`,
          [exigirSintetico(DONO_A), `${SLUG_A}-m`, m, HASH]
        ));
    }

    // A prova de que a guarda `is not null` fecha o fail-open: sem ela,
    // `slug = NULL` avaliaria NULL e o CHECK ACEITARIA a linha.
    for (const chave of ["id", "versao", "nome", "origem", "formato"]) {
      const obj: Record<string, unknown> = JSON.parse(manifesto(`${SLUG_A}-g`, "2.0.0", "N"));
      delete obj[chave];
      await esperarFalha(`C-G  manifesto SEM '${chave}' (fail-closed)`, "23514", () =>
        c.query(
          `insert into public.skills (user_id, slug, versao, nome, origem, manifesto, corpo, conteudo_hash)
           values ($1,$2,'2.0.0','N','importada',$3::jsonb,'c',$4)`,
          [exigirSintetico(DONO_A), `${SLUG_A}-g`, JSON.stringify(obj), HASH]
        ));
    }

    const divergencias: ReadonlyArray<[string, string, string[]]> = [
      ["C-H  slug divergente", "slug", [`${SLUG_A}-x`, "2.0.0", "N", "importada"]],
      ["C-I  versao divergente", "versao", [`${SLUG_A}-y`, "9.9.9", "N", "importada"]],
      ["C-J  nome divergente", "nome", [`${SLUG_A}-z`, "2.0.0", "OUTRO", "importada"]],
      ["C-K  origem divergente", "origem", [`${SLUG_A}-w`, "2.0.0", "N", "gerada_ia"]],
    ];
    for (const [rot, campo, [slug, versao, nome, origem]] of divergencias) {
      // manifesto coerente consigo; a COLUNA e que diverge dele
      const m = manifesto(slug, "2.0.0", "N", "importada");
      await esperarFalha(`${rot} (${campo})`, "23514", () =>
        c.query(
          `insert into public.skills (user_id, slug, versao, nome, origem, manifesto, corpo, conteudo_hash)
           values ($1,$2,$3,$4,$5,$6::jsonb,'c',$7)`,
          [exigirSintetico(DONO_A),
           campo === "slug" ? `${slug}-difere` : slug,
           versao, nome, origem, m, HASH]
        ));
    }

    for (const f of [2, 0]) {
      const obj = JSON.parse(manifesto(`${SLUG_A}-f`, "2.0.0", "N"));
      obj.formato = f;
      await esperarFalha(`C-L  formato ${f}`, "23514", () =>
        c.query(
          `insert into public.skills (user_id, slug, versao, nome, origem, manifesto, corpo, conteudo_hash)
           values ($1,$2,'2.0.0','N','importada',$3::jsonb,'c',$4)`,
          [exigirSintetico(DONO_A), `${SLUG_A}-f`, JSON.stringify(obj), HASH]
        ));
    }
    {
      const obj = JSON.parse(manifesto(`${SLUG_A}-fs`, "2.0.0", "N"));
      obj.formato = "1";
      await esperarFalha("C-L  formato como STRING '1'", "23514", () =>
        c.query(
          `insert into public.skills (user_id, slug, versao, nome, origem, manifesto, corpo, conteudo_hash)
           values ($1,$2,'2.0.0','N','importada',$3::jsonb,'c',$4)`,
          [exigirSintetico(DONO_A), `${SLUG_A}-fs`, JSON.stringify(obj), HASH]
        ));
    }

    // ── D. vigente ────────────────────────────────────────────────────
    secao("D. vigente — no maximo uma por (dono, slug)");

    const v = await c.query<{ vigente: boolean }>(
      `select vigente from public.skills where id = $1`, [exigirRegistrado(skA, criados.skills)]);
    ok("D1  Skill nova nasce vigente = false", v.rows[0].vigente === false);

    const skA2 = await criarSkill(DONO_A, SLUG_A, "2.0.0", "Skill A v2");
    ok("D2  duas versoes do mesmo slug coexistem", skA2.length === 36);

    await c.query(`update public.skills set vigente = true where id = $1`,
      [exigirRegistrado(skA, criados.skills)]);
    ok("D3  a primeira pode ser marcada vigente", true);

    await esperarFalha("D4  segunda vigente ao mesmo tempo", "23505", () =>
      c.query(`update public.skills set vigente = true where id = $1`,
        [exigirRegistrado(skA2, criados.skills)]));

    await c.query(`update public.skills set vigente = false where id = $1`,
      [exigirRegistrado(skA, criados.skills)]);
    await c.query(`update public.skills set vigente = true where id = $1`,
      [exigirRegistrado(skA2, criados.skills)]);
    const v2 = await c.query<{ n: number }>(
      `select count(*)::int as n from public.skills where user_id = $1 and slug = $2 and vigente`,
      [DONO_A, SLUG_A]);
    ok("D5  apos desmarcar a primeira, a segunda e aceita", v2.rows[0].n === 1);

    await c.query(`update public.skills set vigente = false where id = $1`,
      [exigirRegistrado(skA2, criados.skills)]);

    // ── E. cross-tenant ───────────────────────────────────────────────
    secao("E. A FK composta fecha por dono nos DOIS lados");

    await associar(agA, skA, DONO_A);
    ok("E1  associacao A/A funciona", criados.associacoes.length === 1);

    await esperarFalha("E2  agente A + skill B", "23503", () =>
      c.query(`insert into public.agente_skills (agente_id, skill_id, user_id) values ($1,$2,$3)`,
        [agA, skB, exigirSintetico(DONO_A)]));
    await esperarFalha("E3  agente B + skill A", "23503", () =>
      c.query(`insert into public.agente_skills (agente_id, skill_id, user_id) values ($1,$2,$3)`,
        [agB, skA, exigirSintetico(DONO_B)]));

    const nAssoc = await c.query<{ n: number }>(
      `select count(*)::int as n from public.agente_skills where user_id in ($1,$2)`, [DONO_A, DONO_B]);
    ok("E4  nenhuma associacao cross-tenant vazou", nAssoc.rows[0].n === 1);

    // ── F. Varias Skills por agente ───────────────────────────────────
    secao("F. Varias Skills no mesmo agente");

    await associar(agA, skA2, DONO_A);
    const nA = await c.query<{ n: number }>(
      `select count(*)::int as n from public.agente_skills where agente_id = $1`, [agA]);
    ok("F1  o mesmo agente carrega 2 Skills", nA.rows[0].n === 2);
    await esperarFalha("F2  a MESMA versao duas vezes no mesmo agente", "23505", () =>
      c.query(`insert into public.agente_skills (agente_id, skill_id, user_id) values ($1,$2,$3)`,
        [agA, skA, exigirSintetico(DONO_A)]));

    // ── G. CASCADE e RESTRICT ─────────────────────────────────────────
    secao("G. CASCADE no agente, RESTRICT na Skill");

    await esperarFalha("G1  apagar Skill associada e RECUSADO", "23503", () =>
      c.query(`delete from public.skills where id = $1`, [exigirRegistrado(skA, criados.skills)]));

    {
      // Fixture PROPRIO, para nao destruir o que os testes seguintes usam.
      const agC = await criarAgente(DONO_A, "AGENTE SINTETICO F1B C");
      const skC = await criarSkill(DONO_A, `${SLUG_A}-c`, "1.0.0", "Skill C");
      await associar(agC, skC, DONO_A);

      const antes = await c.query<{ n: number }>(
        `select count(*)::int as n from public.agente_skills where agente_id = $1`, [agC]);
      ok("G2  associacao criada para o fixture C", antes.rows[0].n === 1);

      await c.query(`delete from public.agentes where id = $1`, [exigirRegistrado(agC, criados.agentes)]);
      const depois = await c.query<{ n: number }>(
        `select count(*)::int as n from public.agente_skills where agente_id = $1`, [agC]);
      ok("G3  apagar o agente APAGOU a associacao (CASCADE)", depois.rows[0].n === 0);

      const skSobrou = await c.query<{ n: number }>(
        `select count(*)::int as n from public.skills where id = $1`, [skC]);
      ok("G4  a Skill NAO foi apagada junto", skSobrou.rows[0].n === 1);

      await c.query(`delete from public.skills where id = $1`, [exigirRegistrado(skC, criados.skills)]);
      const skFoi = await c.query<{ n: number }>(
        `select count(*)::int as n from public.skills where id = $1`, [skC]);
      ok("G5  sem associacao, apagar a Skill funciona", skFoi.rows[0].n === 0);
    }

    // ── H. Privilegios por catalogo ───────────────────────────────────
    secao("H. Privilegios de TABELA (has_table_privilege)");

    const TAB = ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER", "MAINTAIN"];
    for (const tabela of ["skills", "agente_skills"]) {
      const r = await c.query<Record<string, boolean>>(
        `select ${TAB.map((p) => `has_table_privilege('service_role','public.${tabela}','${p}') as "${p}"`).join(", ")}`
      );
      const p = r.rows[0];
      ok(`H  ${tabela}: SELECT/INSERT/DELETE concedidos`, p.SELECT && p.INSERT && p.DELETE);
      ok(`H  ${tabela}: UPDATE de TABELA ausente`, p.UPDATE === false);
      ok(`H  ${tabela}: sem TRUNCATE/REFERENCES/TRIGGER/MAINTAIN`,
        !p.TRUNCATE && !p.REFERENCES && !p.TRIGGER && !p.MAINTAIN);
    }

    secao("H-b. Privilegios de COLUNA (onde o grant de `vigente` mora)");

    // `relacl` NAO mostra grant de coluna — ele vive em `pg_attribute.attacl`.
    // Auditar so o relacl mostraria "sem UPDATE" e esconderia este grant.
    const anyCol = await c.query<{ s: boolean; a: boolean }>(
      `select has_any_column_privilege('service_role','public.skills','UPDATE') as s,
              has_any_column_privilege('service_role','public.agente_skills','UPDATE') as a`);
    ok("H10 ANCORA: skills TEM update em alguma coluna", anyCol.rows[0].s === true);
    ok("H11 agente_skills NAO tem update em coluna nenhuma", anyCol.rows[0].a === false);

    const COLS_SKILLS = ["id", "user_id", "slug", "versao", "nome", "origem",
                         "manifesto", "corpo", "conteudo_hash", "criado_em"];
    const colV = await c.query<{ v: boolean }>(
      `select has_column_privilege('service_role','public.skills','vigente','UPDATE') as v`);
    ok("H12 `vigente` E atualizavel", colV.rows[0].v === true);
    for (const col of COLS_SKILLS) {
      const r = await c.query<{ x: boolean }>(
        `select has_column_privilege('service_role','public.skills',$1,'UPDATE') as x`, [col]);
      ok(`H  \`${col}\` NAO e atualizavel`, r.rows[0].x === false);
    }

    // ── I. Prova OPERACIONAL sob service_role ─────────────────────────
    secao("I. Operacional: o privilegio vale em runtime");

    {
      const r = await isolado(async () => {
        await c.query("set local role service_role");
        await c.query(`update public.skills set vigente = true where id = $1`, [skA]);
      });
      ok("I1  service_role CONSEGUE atualizar `vigente`", r.erro === null, String(r.erro));
    }
    for (const col of ["corpo", "manifesto", "slug", "versao", "conteudo_hash"]) {
      const sp = `sp${++nSp}`;
      await c.query(`savepoint ${sp}`);
      let code: string | null = null;
      try {
        await c.query("set local role service_role");
        await c.query(`update public.skills set ${col} = $1 where id = $2`,
          [col === "manifesto" ? manifesto(SLUG_A, "1.0.0", "Skill A") : "x", skA]);
      } catch (e) { code = sqlstate(e); }
      await c.query(`rollback to savepoint ${sp}`);
      await c.query(`release savepoint ${sp}`);
      ok(`I  service_role NAO atualiza \`${col}\` (${code})`, code === "42501", `esperado 42501`);
    }
    {
      const sp = `sp${++nSp}`;
      await c.query(`savepoint ${sp}`);
      let code: string | null = null;
      try {
        await c.query("set local role service_role");
        await c.query(`update public.agente_skills set user_id = $1 where agente_id = $2`, [DONO_A, agA]);
      } catch (e) { code = sqlstate(e); }
      await c.query(`rollback to savepoint ${sp}`);
      await c.query(`release savepoint ${sp}`);
      ok(`I7  service_role NAO atualiza agente_skills (${code})`, code === "42501");
    }

    // ── J. public / anon / authenticated ──────────────────────────────
    secao("J. Nenhum papel de cliente alcanca as tabelas");

    for (const papel of ["anon", "authenticated"]) {
      for (const tabela of ["skills", "agente_skills"]) {
        const r = await c.query<Record<string, boolean>>(
          `select ${TAB.map((p) => `has_table_privilege('${papel}','public.${tabela}','${p}') as "${p}"`).join(", ")},
                  has_any_column_privilege('${papel}','public.${tabela}','UPDATE') as anycol,
                  has_any_column_privilege('${papel}','public.${tabela}','SELECT') as anysel`
        );
        const p = r.rows[0];
        ok(`J  ${papel} em ${tabela}: zero privilegio de tabela`,
          TAB.every((k) => p[k] === false));
        ok(`J  ${papel} em ${tabela}: zero privilegio de coluna`,
          p.anycol === false && p.anysel === false);
      }
    }
    for (const papel of ["anon", "authenticated"]) {
      const sp = `sp${++nSp}`;
      await c.query(`savepoint ${sp}`);
      let code: string | null = null;
      try {
        await c.query(`set local role ${papel}`);
        await c.query("select 1 from public.skills limit 1");
      } catch (e) { code = sqlstate(e); }
      await c.query(`rollback to savepoint ${sp}`);
      await c.query(`release savepoint ${sp}`);
      ok(`J  SELECT como \`${papel}\` e NEGADO (${code})`, code === "42501");
    }

    // ── K. RLS ────────────────────────────────────────────────────────
    secao("K. RLS desabilitada, zero policies");

    const rls = await c.query<{ t: string; r: boolean; p: number }>(
      `select c.relname as t, c.relrowsecurity as r,
              (select count(*)::int from pg_policies where tablename = c.relname) as p
         from pg_class c
        where c.relnamespace = 'public'::regnamespace and c.relname in ('skills','agente_skills')`);
    ok("K1  RLS desabilitada nas duas", rls.rows.every((x) => x.r === false));
    ok("K2  zero policies nas duas", rls.rows.every((x) => x.p === 0));

    // ── L. Estado efetivo apesar do default privilege ─────────────────
    secao("L. Estado final correto APESAR do default ruim");

    const acl = await c.query<{ t: string; acl: string }>(
      `select relname as t, coalesce(array_to_string(relacl,' | '),'(sem acl)') as acl
         from pg_class where relnamespace = 'public'::regnamespace
          and relname in ('skills','agente_skills')`);
    for (const row of acl.rows) {
      ok(`L  ${row.t}: sem entrada para anon/authenticated/PUBLIC`,
        !/(^|\|)\s*(anon|authenticated)=/.test(row.acl) && !/(^|\|)\s*=/.test(row.acl));
    }
    ok("L3  o relacl SOZINHO nao provaria o grant de coluna (por isso H-b existe)",
      !acl.rows.some((r) => /vigente/.test(r.acl)));
  } finally {
    // ── ROLLBACK + cleanup defensivo ──────────────────────────────────
    secao("Z. Rollback e prova de residuo zero");

    let rollbackOk = false;
    if (emTransacao) {
      try { await c.query("rollback"); rollbackOk = true; } catch { rollbackOk = false; }
    }
    ok("Z9  a transacao principal foi desfeita", rollbackOk);

    // Defensivo: se o rollback falhou, apaga por id EXATO — nunca wildcard.
    let erroCleanup: unknown = null;
    try {
      await c.query("rollback").catch(() => undefined); // garante sessao limpa
      for (const { agenteId, skillId } of criados.associacoes) {
        await c.query(`delete from public.agente_skills where agente_id = $1 and skill_id = $2`,
          [exigirRegistrado(agenteId, criados.agentes), exigirRegistrado(skillId, criados.skills)]);
      }
      for (const id of criados.skills) {
        await c.query(`delete from public.skills where id = $1`, [exigirRegistrado(id, criados.skills)]);
      }
      for (const id of criados.agentes) {
        await c.query(`delete from public.agentes where id = $1`, [exigirRegistrado(id, criados.agentes)]);
      }
    } catch (e) {
      erroCleanup = e;
    }
    ok("Z10 cleanup defensivo por id EXATO executou sem erro", erroCleanup === null,
      erroCleanup === null ? "" : sqlstate(erroCleanup));

    // O namespace serve como PROVA de residuo, nunca como filtro de DELETE.
    const resto = await c.query<{ s: number; a: number; g: number }>(
      `select (select count(*) from public.skills where user_id like $1)::int as s,
              (select count(*) from public.agente_skills where user_id like $1)::int as a,
              (select count(*) from public.agentes where user_id like $1)::int as g`,
      [`${NS}%`]);
    ok("Z11 zero skills residuais", resto.rows[0].s === 0, String(resto.rows[0].s));
    ok("Z12 zero associacoes residuais", resto.rows[0].a === 0, String(resto.rows[0].a));
    ok("Z13 zero agentes residuais", resto.rows[0].g === 0, String(resto.rows[0].g));

    await c.end();

    console.log(`\n${"═".repeat(66)}`);
    console.log(`  ${passou}/${passou + falhou} passaram` + (falhou > 0 ? `  ·  ${falhou} FALHARAM` : ""));
    console.log(`${"═".repeat(66)}\n`);
    process.exit(falhou > 0 ? 1 : 0);
  }
}

main().catch((e) => {
  console.error("\n  ERRO FATAL:", sqlstate(e));
  console.error("  A transacao nao foi confirmada; o banco desfaz sozinho.");
  process.exit(1);
});
