/**
 * CDS IA — SKILL-1D.f.3b. Prova REAL do write path de Skills.
 *
 *   ┌──────────────────────────────────────────────────────────────┐
 *   │  SUITE COM ESCRITA · BANCO REAL · COMMIT + CLEANUP EXATO     │
 *   └──────────────────────────────────────────────────────────────┘
 *
 * Rodar:
 *   npx tsx scripts/testar-ia-skill-1d-f3-banco.ts             # so audita, NAO conecta
 *   npx tsx scripts/testar-ia-skill-1d-f3-banco.ts --confirmo  # execucao real
 *
 * ── O que esta suite prova, e o que ela DELIBERADAMENTE nao repete ──
 *
 * A f.1b (108 asserts) ja provou o SCHEMA de forma exaustiva: `23505` da
 * identidade, `23514` de cada CHECK, `23503` das FKs compostas nos dois
 * lados, o `RESTRICT` do DELETE, os privilegios de tabela e de coluna, o
 * `SET LOCAL ROLE` em runtime, RLS e `relacl`. Repetir aquilo aqui nao
 * acrescentaria um bit de informacao.
 *
 * O que a f.1b NAO podia provar e o que esta suite existe para provar:
 * ela falava com o banco por `pg`, como superusuario, e nunca executou
 * uma linha de `escrita.ts`. Aqui o modulo REAL fala com o PostgREST
 * REAL, autenticado como `service_role`, e o que se afirma e o par
 * (envelope devolvido, linha efetivamente gravada).
 *
 * ── Por que COMMIT, e nao a transacao+rollback da f.1b ──────────────
 *
 * Nao e preferencia: e impossivel do outro jeito. `escrita.ts` escreve
 * pelo cliente Supabase, ou seja, por HTTP, numa CONEXAO DIFERENTE da
 * desta suite. Uma transacao aberta aqui no `pg` nao alcanca aquilo —
 * o PostgREST nem enxergaria as fixtures nao commitadas. Entao as
 * fixtures do bloco do modulo sao COMMITADAS e a limpeza e explicita.
 *
 * Fingir que o rollback cobre a escrita do modulo seria a mentira mais
 * cara possivel aqui: deixaria residuo real achando que nao deixou.
 *
 * ── Cleanup por identidade EXATA ────────────────────────────────────
 *
 * Como as linhas do modulo sao commitadas, o cleanup nao pode depender
 * so do uuid devolvido no envelope — um processo morto entre o INSERT e
 * o registro perderia o ponteiro. Por isso a suite registra a
 * IDENTIDADE `(user_id, slug, versao)` ANTES de chamar o modulo: ela e
 * exata, conhecida de antemao, e suficiente para apagar.
 *
 * Nunca `LIKE 'prefixo%'`. O namespace existe so como PROVA de residuo
 * zero no fim — jamais como autorizacao de DELETE.
 *
 * ── Segredo ─────────────────────────────────────────────────────────
 *
 * A string de conexao e a service role key sao lidas DENTRO do processo
 * e nunca chegam ao stdout. `instalarGuardaDeSaida()` intercepta cada
 * byte escrito e aborta pelo NOME do padrao, sem reimprimir o trecho.
 * Erro de driver nunca e ecoado bruto — so o SQLSTATE.
 */
// PRIMEIRO import, antes de qualquer coisa de `lib/`: `escrita.ts` e
// `supabase-servidor.ts` sao `server-only`, e o pacote LANCA fora da
// condicao `react-server` que o Next ativa e o tsx nao. Sem esta linha a
// suite morreria no `--confirmo` — e so no `--confirmo`, porque o modo
// inerte nunca chega a importar nenhum dos dois.
import "./_server-only-inerte";

import { createHash } from "node:crypto";
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

// ─── Identidade sintetica ─────────────────────────────────────────────

const RUN = Math.random().toString(36).slice(2, 10);
const NS = `test-skill-1d-f3b-${RUN}`;
const DONO_A = `${NS}-a`;
const DONO_B = `${NS}-b`;
/** Slug precisa casar `^[a-z0-9]+(-[a-z0-9]+)*$`. `RUN` e [0-9a-z]. */
const SLUG = `teste-f3b-${RUN}`;
const SLUG_B = `teste-f3b-${RUN}-b`;

/** Uuid que nao pertence a nada — para provar `nao_disponivel`. */
const UUID_INEXISTENTE = "00000000-0000-4000-8000-000000000000";

/**
 * Tudo que esta execucao criou.
 *
 * `identidades` e registrada ANTES da chamada ao modulo: ela nao depende
 * de o envelope voltar, e e o que o cleanup usa. `skills` e `agentes`
 * guardam os uuids para os asserts e para o cleanup das associacoes.
 */
const criados = {
  agentes: [] as string[],
  skills: [] as string[],
  identidades: [] as Array<{ userId: string; slug: string; versao: string }>,
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

/** Registra a identidade ANTES de mandar o modulo grava-la. */
function registrarIdentidade(userId: string, slug: string, versao: string): void {
  exigirSintetico(userId);
  criados.identidades.push({ userId, slug, versao });
}

/**
 * As tres identidades que esta execucao PODE criar, declaradas antes de
 * qualquer DML para que o bloco de recuperacao possa imprimi-las.
 *
 * Elas sao a primeira das duas rotas de recuperacao: a identidade logica
 * existe e e exata mesmo quando o uuid ainda nao nasceu — ou quando o
 * processo morre antes de o envelope voltar.
 */
const IDENTIDADES_PREVISTAS: readonly (readonly [string, string, string, string])[] = [
  ["SKILL_A_V1", DONO_A, SLUG, "1.0.0"],
  ["SKILL_A_V2", DONO_A, SLUG, "2.0.0"],
  ["SKILL_B_V1", DONO_B, SLUG, "1.0.0"],
];

/**
 * Registra e ANUNCIA um uuid de Skill no instante em que o banco o
 * devolve — a segunda rota de recuperacao.
 *
 * Registrar e anunciar vivem na MESMA funcao de proposito: um uuid que
 * entrasse na lista de cleanup sem passar pelo stdout seria exatamente o
 * caso que o blocker da f.3-C apontou. Uma sentinela estrutural exige
 * que `criados.skills.push(` nao apareca em nenhum outro lugar.
 */
function anunciarSkill(rotulo: string, id: string): void {
  criados.skills.push(id);
  console.log(`  ${rotulo}_ID=${id}`);
}

// ─── Ambiente ─────────────────────────────────────────────────────────

/** Le `.env.local` uma vez. O conteudo NUNCA e impresso. */
function lerEnv(): Record<string, string> {
  const txt = readFileSync(join(__dirname, "..", ".env.local"), "utf8");
  const out: Record<string, string> = {};
  for (const m of txt.matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*"?([^"\r\n]*)"?/gm)) {
    out[m[1]] = m[2];
  }
  return out;
}

/** Campos separados, sem remontar URL — `esquema://host` seria bloqueado. */
function descreverAlvo(url: string): string {
  const u = new URL(url);
  const host = u.hostname.replace(/^([a-z]{3})[^.]*/, "$1***");
  return `host=${host}  porta=${u.port}  database=${u.pathname.replace("/", "")}`;
}

function segredosDe(env: Record<string, string>): string[] {
  const u = new URL(env.DATABASE_URL);
  const brutos = [u.password, u.username];
  const dec = brutos.map((v) => { try { return decodeURIComponent(v); } catch { return v; } });
  return Array.from(new Set([
    ...brutos, ...dec,
    env.SUPABASE_SERVICE_ROLE_KEY ?? "",
    env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "",
  ])).filter(Boolean);
}

/** O SQLSTATE, que e a prova de QUEM recusou. Nunca a mensagem. */
function sqlstate(e: unknown): string {
  return (e as { code?: string })?.code ?? "sem-codigo";
}

// ─── Fixtures textuais ────────────────────────────────────────────────

const CORPO_A = "Responda em ate 4 horas.";
const CORPO_DIFERENTE = "Responda em ate 2 horas.";

function textoSkill(p: Record<string, unknown> = {}, corpo = CORPO_A): string {
  const man = {
    formato: 1,
    id: SLUG,
    nome: "Skill sintetica f3b",
    versao: "1.0.0",
    descricao: "Fixture desta execucao.",
    quando_usar: ["cliente pergunta sobre pedido"],
    origem: "importada",
    ...p,
  };
  return "```cds-skill\n" + JSON.stringify(man, null, 2) + "\n```\n\n" + corpo + "\n";
}

const sha256 = (t: string) => createHash("sha256").update(t, "utf8").digest("hex");

// ─── Auto-verificacao estrutural (roda SEM banco) ─────────────────────
//
// Prova, sobre o proprio fonte, que nada acontece antes da confirmacao.
// E o unico jeito de afirmar isso sem executar o caminho que se quer
// provar que nao executa.
function autoVerificar(): void {
  secao("0. Auto-verificacao (pura, sem banco)");

  const fonte = readFileSync(join(__dirname, "testar-ia-skill-1d-f3-banco.ts"), "utf8");

  // Uma sonda que varre o proprio fonte casa consigo mesma. O corpo desta
  // funcao e RECORTADO antes de qualquer varredura, e a ancora prova que
  // o recorte tirou algo. Licao medida na f.1b.
  const iAuto = fonte.indexOf("function autoVerificar()");
  const fimAuto = fonte.indexOf("\n}\n", iAuto);
  const CORPO = fonte.slice(0, iAuto) + fonte.slice(fimAuto);

  const iFlag = CORPO.indexOf("if (!CONFIRMADO)");
  const iEnv = CORPO.indexOf("lerEnv()", iFlag);
  const iClient = CORPO.indexOf("new Client(");
  const iModulo = CORPO.indexOf('await import("../lib/agentes/skills/escrita")');

  ok("Z1  o guarda --confirmo existe", iFlag > 0);
  ok("Z2  `lerEnv()` so e chamada DEPOIS do guarda", iFlag > 0 && iEnv > iFlag);
  ok("Z3  `new Client(` so aparece DEPOIS do guarda", iFlag > 0 && iClient > iFlag);
  ok("Z4  o modulo de escrita so e importado DEPOIS do guarda",
    iModulo > 0 && iModulo > iFlag);
  ok("Z5  o guarda de saida e instalado antes de descrever o alvo",
    CORPO.indexOf("instalarGuardaDeSaida(") < CORPO.indexOf("descreverAlvo("));
  ok("Z6  ANCORA: o recorte removeu o bloco de auto-verificacao",
    iAuto > 0 && fimAuto > iAuto && CORPO.length < fonte.length - 500);

  ok("Z7  nenhum DELETE por wildcard", !/delete from[^;]*like/i.test(CORPO));
  ok("Z8  CONTROLE: a sonda de wildcard acha quando existe",
    /delete from[^;]*like/i.test("delete " + "from t where u like 'x%'"));
  ok("Z9  nenhum DELETE sem WHERE", !/delete\s+from\s+public\.\w+\s*(;|`)/i.test(CORPO));
  ok("Z10 CONTROLE: a sonda de DELETE amplo acha quando existe",
    /delete\s+from\s+public\.\w+\s*(;|`)/i.test("delete " + "from public.skills;"));

  ok("Z11 a suite NAO aplica migration nem cria tabela",
    !/create\s+table|apply_migration/i.test(CORPO));
  ok("Z12 CONTROLE: a sonda de DDL acha quando existe", /create\s+table/i.test("create table x ()"));

  // Precisao importa aqui: a suite NAO emite UPDATE em SQL direto, mas a
  // secao K TENTA updates pelo cliente Supabase de proposito, esperando
  // 42501. Um rotulo dizendo "nenhum UPDATE" seria falso — e um assert
  // que afirma mais do que prova e pior que assert nenhum.
  ok("Z13 nenhum UPDATE em SQL direto pela conexao `pg`",
    !/\bupdate\s+public\./i.test(CORPO));
  ok("Z14 CONTROLE: a sonda de UPDATE em SQL acha quando existe",
    /\bupdate\s+public\./i.test("update " + "public.skills set vigente = true"));

  ok("Z15 nenhuma mensagem de erro bruta e impressa", !/\.message\b/.test(CORPO));
  ok("Z16 CONTROLE: a sonda de mensagem bruta acha quando existe",
    /\.message\b/.test("console.log(e" + ".message)"));

  ok("Z17 cleanup opera por id/identidade exatos", /exigirRegistrado\(/.test(CORPO));
  ok("Z18 identidade e registrada antes da escrita", /registrarIdentidade\(/.test(CORPO));
  ok("Z19 nenhuma tabela operacional e tocada",
    !/public\.(pedidos|lojas|mensagens|anuncios|perfil)\b/i.test(CORPO));
  ok("Z20 CONTROLE: a sonda de tabela operacional acha quando existe",
    /public\.(pedidos|lojas)\b/i.test("select * from public.pedidos"));

  ok("Z21 a suite nao promove vigente", !/vigente\s*=\s*true/i.test(CORPO));
  ok("Z22 a suite nao cria RPC nem chama .rpc(", !/\.rpc\(|create\s+or\s+replace\s+function/i.test(CORPO));

  // As duas ultimas nao leem o fonte: OLHAM o grafo de modulos. "Nenhum
  // modulo de escrita foi carregado" deixa de ser uma frase impressa e
  // passa a ser um fato medido no momento em que a suite inerte termina.
  const grafo = Object.keys(require.cache).map((p) => p.replace(/\\/g, "/"));
  ok("Z23 o modulo de escrita NAO esta no grafo neste ponto",
    !grafo.some((p) => p.includes("/lib/agentes/skills/escrita.ts")));
  ok("Z24 ANCORA: a sonda de grafo enxerga um modulo realmente carregado",
    grafo.some((p) => p.includes("testar-ia-skill-1d-f3-banco")));

  // ── Y. Recuperacao de fixture — a propriedade do blocker da f.3-C ───
  //
  // A propriedade a garantir: ANTES de qualquer DML que possa deixar uma
  // fixture sem cleanup automatico, o stdout ja contem uma chave EXATA
  // suficiente para localiza-la. Nao se prova matando processo — prova-se
  // pela ORDEM no fonte, que e o que determina a ordem do stdout.
  secao("Y. Recuperacao de fixtures (ordem no fonte)");

  // Uma das sondas abaixo procura `criados.skills.push(`, que aparece
  // tambem no docblock que a explica. Sem remover comentario ela contaria
  // a propria explicacao — a mesma armadilha ja medida na f.1b.
  const SEM_COM = CORPO.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
  ok("Y0  ANCORA: a remocao de comentarios tirou algo", SEM_COM.length < CORPO.length - 500);

  const iRecup = CORPO.indexOf("=== RECUPERACAO DE FIXTURES");
  const iDML1 = CORPO.indexOf("insert into public.agentes");
  const iEcoAg = CORPO.indexOf("AGENTE_${rot}_ID=");
  const iSecC = CORPO.indexOf('secao("C. Importacao');

  ok("Y1  o bloco de recuperacao existe", iRecup > 0);
  ok("Y2  ele e impresso ANTES do primeiro DML", iRecup > 0 && iDML1 > 0 && iRecup < iDML1);
  for (const chave of ["RUN=${RUN}", "NS=${NS}", "DONO_A=${DONO_A}", "DONO_B=${DONO_B}"]) {
    ok(`Y3  o bloco carrega ${chave.split("=")[0]}`, CORPO.includes(chave));
  }
  ok("Y4  as 3 identidades previstas sao declaradas antes de qualquer DML",
    CORPO.indexOf("IDENTIDADES_PREVISTAS") > 0 &&
      CORPO.indexOf("IDENTIDADES_PREVISTAS") < iDML1 &&
      ["SKILL_A_V1", "SKILL_A_V2", "SKILL_B_V1"].every((r) => CORPO.includes(r)));
  ok("Y5  e o bloco as imprime", CORPO.includes("${rotulo}: user_id=${dono}"));

  ok("Y6  o uuid do agente e anunciado DEPOIS do INSERT que o cria",
    iDML1 > 0 && iEcoAg > iDML1);
  ok("Y7  e ANTES do proximo DML (a secao C)", iEcoAg > 0 && iSecC > iEcoAg);

  // A garantia forte: nao existe caminho que registre um uuid de Skill
  // para cleanup sem passar pelo stdout, porque so ha UM push.
  ok("Y8  nenhum uuid de Skill entra no cleanup sem ser anunciado",
    (SEM_COM.match(/criados\.skills\.push\(/g) ?? []).length === 1);
  ok("Y9  e o unico push vive dentro de `anunciarSkill`",
    /function anunciarSkill\([^)]*\)[^{]*\{\s*criados\.skills\.push\(/.test(SEM_COM));
  ok("Y10 as 3 Skills sao anunciadas com rotulos inequivocos",
    (SEM_COM.match(/anunciarSkill\("/g) ?? []).length === 3);
  ok("Y11 o uuid do agente tambem tem push unico e eco imediato",
    (SEM_COM.match(/criados\.agentes\.push\(/g) ?? []).length === 1);

  // Rota 1 da recuperacao: a identidade logica, registrada antes da
  // chamada que pode criar a linha.
  for (const [rot, reg, imp] of [
    ["A_V1", 'registrarIdentidade(DONO_A, SLUG, "1.0.0")', "const rC = await importarEPersistirSkill"],
    ["A_V2", 'registrarIdentidade(DONO_A, SLUG, "2.0.0")', "const rF = await importarEPersistirSkill"],
    ["B_V1", 'registrarIdentidade(DONO_B, SLUG, "1.0.0")', "const rG = await importarEPersistirSkill"],
  ] as const) {
    const iR = CORPO.indexOf(reg);
    const iI = CORPO.indexOf(imp);
    ok(`Y12 ${rot}: identidade registrada ANTES da chamada que pode criar`, iR > 0 && iI > 0 && iR < iI);
  }

  ok("Y13 nenhum log imprime manifesto, corpo ou texto bruto",
    !/console\.log\([^)]*\b(manifesto|corpo|TEXTO|CORPO_A)\b/.test(SEM_COM));
  ok("Y14 CONTROLE: a sonda de vazamento de conteudo acha quando existe",
    /console\.log\([^)]*\b(manifesto|corpo)\b/.test("console.log(linha.corpo)"));
}

// ─── Execucao ─────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("\n══ CDS IA — SKILL-1D.f.3b: write path de Skills em BANCO REAL ══");
  console.log("   SUITE COM ESCRITA · BANCO REAL · COMMIT + CLEANUP EXATO");

  autoVerificar();

  if (!CONFIRMADO) {
    console.log("\n  Sem `--confirmo`: nenhuma conexao foi aberta, nenhum modulo de");
    console.log("  escrita foi carregado, nenhuma fixture criada e nada foi escrito.");
    console.log("  A execucao real exige autorizacao separada (SKILL-1D.f.3-C).");
    console.log("  Para executar de verdade:");
    console.log("    npx tsx scripts/testar-ia-skill-1d-f3-banco.ts --confirmo\n");
    console.log(`  ${passou}/${passou + falhou} passaram (auto-verificacao)\n`);
    process.exit(falhou > 0 ? 1 : 0);
  }

  const env = lerEnv();
  instalarGuardaDeSaida(segredosDe(env));

  // O modulo cria o cliente sob demanda lendo `process.env` — o tsx nao
  // carrega `.env.local` sozinho. Os valores entram no processo aqui e
  // nunca sao impressos.
  process.env.NEXT_PUBLIC_SUPABASE_URL = env.NEXT_PUBLIC_SUPABASE_URL;
  process.env.SUPABASE_SERVICE_ROLE_KEY = env.SUPABASE_SERVICE_ROLE_KEY;

  console.log(`\n  alvo: ${descreverAlvo(env.DATABASE_URL)}`);
  console.log(`  namespace desta execucao: ${NS}`);

  // ── RECUPERACAO DE FIXTURES ─────────────────────────────────────────
  //
  // Impresso ANTES de qualquer DML, e antes ate da conexao. Se o processo
  // morrer depois de um INSERT commitado e antes do `finally`, e este
  // bloco que permite localizar a fixture sobrevivente por chave EXATA —
  // jamais por prefixo.
  //
  // Tudo aqui e sintetico e desta execucao: nenhum segredo, nenhum
  // conteudo de Skill, nenhum manifesto, nenhum corpo.
  console.log("\n  === RECUPERACAO DE FIXTURES 1D.f.3 ===");
  console.log(`  RUN=${RUN}`);
  console.log(`  NS=${NS}`);
  console.log(`  DONO_A=${DONO_A}`);
  console.log(`  DONO_B=${DONO_B}`);
  for (const [rotulo, dono, slug, versao] of IDENTIDADES_PREVISTAS) {
    console.log(`  ${rotulo}: user_id=${dono}  slug=${slug}  versao=${versao}`);
  }
  console.log("  (uuids de agente e de Skill sao anunciados ao nascer)");
  console.log("  === FIM DA RECUPERACAO ===");

  // `server-only` e inerte em runner de teste; o import e dinamico para
  // que nem o modulo entre no grafo quando falta `--confirmo`.
  const { importarEPersistirSkill, associarSkillAoAgente, desassociarSkillDoAgente } =
    await import("../lib/agentes/skills/escrita");

  const c = new Client({ connectionString: env.DATABASE_URL });
  await c.connect();

  try {
    // ── A. Pre-voo ────────────────────────────────────────────────────
    secao("A. Pre-voo — o namespace esta limpo antes de comecar");

    const antes = await c.query<{ s: number; a: number; g: number }>(
      `select (select count(*) from public.skills where user_id like $1)::int as s,
              (select count(*) from public.agente_skills where user_id like $1)::int as a,
              (select count(*) from public.agentes where user_id like $1)::int as g`,
      [`${NS}%`]);
    ok("A1  zero skills preexistentes no namespace", antes.rows[0].s === 0);
    ok("A2  zero associacoes preexistentes", antes.rows[0].a === 0);
    ok("A3  zero agentes preexistentes", antes.rows[0].g === 0);

    // ── B. Fixtures COMMITADAS ────────────────────────────────────────
    //
    // Commitadas de proposito: o PostgREST fala por outra conexao e nao
    // enxergaria nada que ficasse dentro de uma transacao daqui.
    secao("B. Agentes sinteticos (commitados — o PostgREST precisa ve-los)");

    for (const [rot, dono] of [["A", DONO_A], ["B", DONO_B]] as const) {
      const r = await c.query<{ id: string }>(
        `insert into public.agentes (user_id, nome, tipo) values ($1, $2, 'mensagens') returning id`,
        [exigirSintetico(dono), `agente sintetico ${rot} ${RUN}`]);
      criados.agentes.push(r.rows[0].id);
      // IMEDIATAMENTE apos o INSERT que o gerou e ANTES do proximo DML.
      // Um uuid de `gen_random_uuid()` nao existe antes desta linha, e
      // esta e a unica janela em que ele pode ser anunciado.
      console.log(`  AGENTE_${rot}_ID=${r.rows[0].id}`);
      ok(`B1  agente sintetico ${rot} criado`, typeof r.rows[0].id === "string");
    }
    const AGENTE_A = criados.agentes[0];
    const AGENTE_B = criados.agentes[1];

    // ── C. Importacao real ────────────────────────────────────────────
    secao("C. Importacao — o modulo grava pelo PostgREST");

    const TEXTO = textoSkill();
    registrarIdentidade(DONO_A, SLUG, "1.0.0");
    const rC = await importarEPersistirSkill({ userId: DONO_A, texto: TEXTO });

    ok("C1  estado criada", rC.estado === "criada");
    const skillId = rC.estado === "criada" ? rC.skillId : "";
    if (skillId) anunciarSkill("SKILL_A_V1", skillId);
    ok("C2  devolveu um uuid", /^[0-9a-f-]{36}$/.test(skillId));

    const linha = await c.query<Record<string, unknown>>(
      `select user_id, slug, versao, nome, origem, manifesto, corpo, conteudo_hash, vigente
         from public.skills where id = $1`, [skillId]);
    ok("C3  a linha existe no banco", linha.rowCount === 1);

    const L = linha.rows[0] ?? {};
    ok("C4  user_id", L.user_id === DONO_A);
    ok("C5  slug", L.slug === SLUG);
    ok("C6  versao", L.versao === "1.0.0");
    ok("C7  nome", L.nome === "Skill sintetica f3b");
    ok("C8  origem preservada", L.origem === "importada");
    ok("C9  corpo saneado", L.corpo === CORPO_A);
    ok("C10 conteudo_hash e o SHA-256 do raw", L.conteudo_hash === sha256(TEXTO));
    ok("C11 hash em hex minusculo de 64", /^[0-9a-f]{64}$/.test(String(L.conteudo_hash)));
    ok("C12 VIGENTE = false (o DEFAULT do banco decidiu)", L.vigente === false);
    ok("C13 manifesto e objeto com o slug promovido",
      !!L.manifesto && (L.manifesto as Record<string, unknown>).id === SLUG);
    ok("C14 o raw text NAO foi persistido em coluna alguma",
      !Object.values(L).some((v) => typeof v === "string" && v.includes("```")));

    // ── D. Idempotencia ───────────────────────────────────────────────
    secao("D. Idempotencia — o MESMO texto de novo");

    const rD = await importarEPersistirSkill({ userId: DONO_A, texto: TEXTO });
    ok("D1  estado ja_existia", rD.estado === "ja_existia");
    ok("D2  o mesmo skillId", rD.estado === "ja_existia" && rD.skillId === skillId);

    const cont = await c.query<{ n: number }>(
      `select count(*)::int as n from public.skills
        where user_id = $1 and slug = $2 and versao = $3`, [DONO_A, SLUG, "1.0.0"]);
    ok("D3  exatamente UMA linha para a identidade", cont.rows[0].n === 1);

    // ── E. Conflito de versao ─────────────────────────────────────────
    secao("E. Conflito — mesma versao, conteudo diferente");

    const TEXTO_DIF = textoSkill({}, CORPO_DIFERENTE);
    const rE = await importarEPersistirSkill({ userId: DONO_A, texto: TEXTO_DIF });
    ok("E1  estado conflito_versao", rE.estado === "conflito_versao");
    ok("E2  o envelope nao vaza skillId", !("skillId" in rE));

    const dep = await c.query<{ n: number; h: string; corpo: string }>(
      `select (select count(*)::int from public.skills
                where user_id = $1 and slug = $2 and versao = $3) as n,
              conteudo_hash as h, corpo from public.skills where id = $4`,
      [DONO_A, SLUG, "1.0.0", skillId]);
    ok("E3  continua UMA linha — nenhuma segunda versao criada", dep.rows[0].n === 1);
    ok("E4  o hash original NAO foi sobrescrito", dep.rows[0].h === sha256(TEXTO));
    ok("E5  o corpo original NAO foi sobrescrito", dep.rows[0].corpo === CORPO_A);

    // ── F. Duas versoes coexistem ─────────────────────────────────────
    secao("F. Duas versoes do mesmo slug");

    const TEXTO_V2 = textoSkill({ versao: "2.0.0" });
    registrarIdentidade(DONO_A, SLUG, "2.0.0");
    const rF = await importarEPersistirSkill({ userId: DONO_A, texto: TEXTO_V2 });
    ok("F1  a segunda versao e criada", rF.estado === "criada");
    if (rF.estado === "criada") anunciarSkill("SKILL_A_V2", rF.skillId);

    const vs = await c.query<{ n: number; v: number }>(
      `select count(*)::int as n, count(*) filter (where vigente)::int as v
         from public.skills where user_id = $1 and slug = $2`, [DONO_A, SLUG]);
    ok("F2  duas linhas para o mesmo slug", vs.rows[0].n === 2);
    ok("F3  NENHUMA vigente — importar nao promove", vs.rows[0].v === 0);

    // ── G. Cross-tenant ───────────────────────────────────────────────
    secao("G. Dois tenants — mesmo slug, mesma versao");

    registrarIdentidade(DONO_B, SLUG, "1.0.0");
    const rG = await importarEPersistirSkill({ userId: DONO_B, texto: TEXTO });
    ok("G1  o outro tenant cria a MESMA identidade sem colidir", rG.estado === "criada");
    const skillB = rG.estado === "criada" ? rG.skillId : "";
    if (skillB) anunciarSkill("SKILL_B_V1", skillB);
    ok("G2  sao linhas distintas", skillB !== "" && skillB !== skillId);

    // ── H. Associacao ─────────────────────────────────────────────────
    secao("H. Associacao — pin exato e idempotencia");

    const h1 = await associarSkillAoAgente({ userId: DONO_A, agenteId: AGENTE_A, skillId });
    ok("H1  associada", h1.estado === "associada");

    const assoc = await c.query<{ n: number }>(
      `select count(*)::int as n from public.agente_skills
        where agente_id = $1 and skill_id = $2 and user_id = $3`, [AGENTE_A, skillId, DONO_A]);
    ok("H2  a linha exata existe", assoc.rows[0].n === 1);

    const h2 = await associarSkillAoAgente({ userId: DONO_A, agenteId: AGENTE_A, skillId });
    ok("H3  repetir -> ja_associada", h2.estado === "ja_associada");

    const assoc2 = await c.query<{ n: number }>(
      `select count(*)::int as n from public.agente_skills where agente_id = $1`, [AGENTE_A]);
    ok("H4  continua exatamente UMA associacao", assoc2.rows[0].n === 1);

    // ── I. nao_disponivel, sem oraculo ────────────────────────────────
    secao("I. As quatro causas caem num estado so");

    for (const [rot, ent] of [
      ["agente de outro tenant", { userId: DONO_A, agenteId: AGENTE_B, skillId }],
      ["Skill de outro tenant", { userId: DONO_A, agenteId: AGENTE_A, skillId: skillB }],
      ["agente inexistente", { userId: DONO_A, agenteId: UUID_INEXISTENTE, skillId }],
      ["Skill inexistente", { userId: DONO_A, agenteId: AGENTE_A, skillId: UUID_INEXISTENTE }],
    ] as const) {
      const r = await associarSkillAoAgente(ent);
      ok(`I1 ${rot} -> nao_disponivel`, r.estado === "nao_disponivel");
    }

    const semLixo = await c.query<{ n: number }>(
      `select count(*)::int as n from public.agente_skills where user_id like $1`, [`${NS}%`]);
    ok("I2  nenhuma associacao indevida foi criada", semLixo.rows[0].n === 1);

    // ── J. Desassociacao ──────────────────────────────────────────────
    secao("J. Desassociacao — exata, idempotente, Skill sobrevive");

    const j1 = await desassociarSkillDoAgente({ userId: DONO_A, agenteId: AGENTE_A, skillId });
    ok("J1  desassociada", j1.estado === "desassociada");

    const dep2 = await c.query<{ a: number; s: number }>(
      `select (select count(*)::int from public.agente_skills where skill_id = $1) as a,
              (select count(*)::int from public.skills where id = $1) as s`, [skillId]);
    ok("J2  a associacao sumiu", dep2.rows[0].a === 0);
    ok("J3  a Skill CONTINUA existindo", dep2.rows[0].s === 1);

    const j2 = await desassociarSkillDoAgente({ userId: DONO_A, agenteId: AGENTE_A, skillId });
    ok("J4  repetir -> nao_associada (idempotente)", j2.estado === "nao_associada");

    // ── K. ACL pelo caminho do PostgREST ──────────────────────────────
    //
    // A f.1b provou os privilegios por catalogo e em runtime sob
    // `SET LOCAL ROLE service_role`, na conexao `pg`. O que ela nao podia
    // provar e se o caminho que o MODULO usa — HTTP, PostgREST — esta
    // sujeito a mesma ACL. Se o PostgREST conectasse por outro papel, o
    // grant de coluna nao transferiria e a imutabilidade do conteudo
    // seria uma crenca, nao uma garantia.
    //
    // A tentativa e segura: alvo sintetico desta execucao, recusa
    // esperada, e o cleanup apaga por uuid mesmo que algo mude.
    secao("K. A ACL vale tambem pelo cliente Supabase (nao so por `pg`)");

    const { getSupabaseServidor } = await import("../lib/estudio-anuncios/supabase-servidor");
    const sb = getSupabaseServidor();

    for (const [col, valor] of [
      ["corpo", "alterado"],
      ["manifesto", {}],
      ["slug", "outro-slug"],
      ["versao", "9.9.9"],
      ["nome", "outro nome"],
      ["origem", "oficial_cds"],
      ["conteudo_hash", "0".repeat(64)],
    ] as const) {
      const r = await sb.from("skills").update({ [col]: valor }).eq("id", exigirRegistrado(skillId, criados.skills));
      const codigo = (r.error as { code?: string } | null)?.code ?? "sem-erro";
      ok(`K1 UPDATE de ${col} recusado (42501)`, codigo === "42501", codigo);
    }

    const intacta = await c.query<{ h: string; c: string; s: string }>(
      `select conteudo_hash as h, corpo as c, slug as s from public.skills where id = $1`, [skillId]);
    ok("K2  a linha continua intacta depois das tentativas",
      intacta.rows[0]?.h === sha256(TEXTO) && intacta.rows[0]?.c === CORPO_A && intacta.rows[0]?.s === SLUG);

    const rVig = await sb.from("skills").update({ vigente: false }).eq("id", skillId);
    ok("K3  CONTROLE: `vigente` e a UNICA coluna que o grant permite",
      (rVig.error as { code?: string } | null)?.code === undefined);

    const rAssoc = await sb.from("agente_skills").update({ user_id: DONO_A }).eq("skill_id", skillId);
    ok("K4  agente_skills nao aceita UPDATE de coluna nenhuma",
      (rAssoc.error as { code?: string } | null)?.code === "42501");

    // ── L. O que esta suite NAO prova ─────────────────────────────────
    secao("L. Limites declarados, nao simulados");

    ok("L1  DECLARADO: a corrida 23505 do modulo NAO e exercitada aqui — " +
       "ela exige duas sessoes simultaneas; esta suite e single-session", true);
    ok("L2  DECLARADO: 23514/23503/RESTRICT/RLS nao sao reprovados aqui — " +
       "a f.1b ja os cobre em 108 asserts sobre o mesmo schema", true);
  } finally {
    // ── Z. Cleanup EXATO e prova de residuo ───────────────────────────
    //
    // Nada de rollback: as linhas do modulo foram COMMITADAS por outra
    // conexao. A limpeza e explicita, por identidade e por uuid — nunca
    // por wildcard.
    secao("Z. Cleanup exato e prova de residuo zero");

    let erroCleanup: unknown = null;
    try {
      await c.query("rollback").catch(() => undefined); // garante sessao limpa

      for (const id of criados.skills) {
        await c.query(`delete from public.agente_skills where skill_id = $1`,
          [exigirRegistrado(id, criados.skills)]);
      }
      for (const id of criados.agentes) {
        await c.query(`delete from public.agente_skills where agente_id = $1`,
          [exigirRegistrado(id, criados.agentes)]);
      }
      // Por uuid: nao depende de `slug`/`versao` continuarem os mesmos.
      for (const id of criados.skills) {
        await c.query(`delete from public.skills where id = $1`,
          [exigirRegistrado(id, criados.skills)]);
      }
      // Identidade EXATA: cobre ate uma linha cujo uuid nao tenha voltado.
      for (const { userId, slug, versao } of criados.identidades) {
        await c.query(
          `delete from public.skills where user_id = $1 and slug = $2 and versao = $3`,
          [exigirSintetico(userId), slug, versao]);
      }
      for (const id of criados.agentes) {
        await c.query(`delete from public.agentes where id = $1`,
          [exigirRegistrado(id, criados.agentes)]);
      }
    } catch (e) {
      erroCleanup = e;
    }
    ok("Z23 cleanup por identidade/uuid EXATOS executou sem erro", erroCleanup === null,
      erroCleanup === null ? "" : sqlstate(erroCleanup));

    // O namespace serve como PROVA de residuo, nunca como filtro de DELETE.
    const resto = await c.query<{ s: number; a: number; g: number }>(
      `select (select count(*) from public.skills where user_id like $1)::int as s,
              (select count(*) from public.agente_skills where user_id like $1)::int as a,
              (select count(*) from public.agentes where user_id like $1)::int as g`,
      [`${NS}%`]);
    ok("Z24 zero skills residuais", resto.rows[0].s === 0, String(resto.rows[0].s));
    ok("Z25 zero associacoes residuais", resto.rows[0].a === 0, String(resto.rows[0].a));
    ok("Z26 zero agentes residuais", resto.rows[0].g === 0, String(resto.rows[0].g));

    await c.end();

    console.log(`\n${"═".repeat(66)}`);
    console.log(`  ${passou}/${passou + falhou} passaram` + (falhou > 0 ? `  ·  ${falhou} FALHARAM` : ""));
    console.log(`${"═".repeat(66)}\n`);
    process.exit(falhou > 0 ? 1 : 0);
  }
}

main().catch((e) => {
  console.error("\n  ERRO FATAL:", sqlstate(e));
  console.error("  Se havia fixtures commitadas, o bloco `finally` ja tentou remove-las.");
  process.exit(1);
});
