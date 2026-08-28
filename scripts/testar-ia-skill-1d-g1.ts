/**
 * CDS IA — SKILL-1D.g.1-A. Suite estrutural de `agente_conexoes`.
 *
 * A migration ainda NAO foi aplicada: a tabela nao existe no banco. O
 * que existe e um arquivo, e e o arquivo que esta suite audita.
 *
 * ── Por que sondar o SQL sem comentario ─────────────────────────────
 *
 * O cabecalho da migration explica, em prosa, exatamente as coisas que
 * as sondas procuram: `skill_id`, `seller_id`, `CASCADE` na loja, `enum`,
 * `ALTER DEFAULT PRIVILEGES`, `trigger`. Uma sonda ingenua leria a
 * JUSTIFICATIVA de por que algo foi descartado e concluiria que aquilo
 * esta presente.
 *
 * E a divida `P7` de `testar-ia-skill-1d-d2.ts`, e ela nao se repete
 * aqui: tudo abaixo varre `SQL`, ja sem comentario, e `A0` ancora que a
 * remocao tirou algo.
 *
 * Rodar:  npx tsx scripts/testar-ia-skill-1d-g1.ts
 * Sem rede, sem banco, sem env, sem segredo. Nao aceita `--confirmo`
 * porque nao ha nada aqui que possa tocar o banco.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

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

const RAIZ = join(__dirname, "..");
const NOME = "20260925_agente_conexoes.sql";
const CAMINHO = `supabase/migrations/${NOME}`;

const BRUTO = readFileSync(join(RAIZ, CAMINHO), "utf8");

/** Sem comentario de bloco nem de linha. O SQL desta migration nao tem
 *  literal contendo `--`, entao a remocao por linha e segura. */
const SQL = BRUTO.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--.*$/gm, "");

/** So o corpo do CREATE TABLE — separa o que a TABELA declara do que a
 *  migration faz em volta (os grants). */
const iAbre = SQL.indexOf("create table");
const iFecha = SQL.indexOf("\n);", iAbre);
const CORPO = iAbre >= 0 && iFecha > iAbre ? SQL.slice(iAbre, iFecha) : "";

/** Normaliza espaco: as constraints quebram linha, e casar
 *  `on delete cascade` atraves de `\n      ` seria fragil. */
const PLANO = SQL.replace(/\s+/g, " ");

console.log("\n══ CDS IA — SKILL-1D.g.1-A: agente_conexoes ══");

// ─── A. O arquivo ─────────────────────────────────────────────────────

secao("A. A migration existe e e legivel sem comentario");

ok("A0  ANCORA: a remocao de comentarios tirou algo",
  SQL.length > 300 && SQL.length < BRUTO.length - 2000);
ok("A1  a migration existe no caminho esperado", existsSync(join(RAIZ, CAMINHO)));
ok("A2  o timestamp nao colide com migration existente",
  readdirSync(join(RAIZ, "supabase/migrations")).filter((f) => f.startsWith("20260925")).length === 1);
ok("A3  ANCORA: o corpo do CREATE TABLE foi isolado", CORPO.length > 200);
ok("A4  declara que ainda NAO foi aplicada", /NAO APLICADA AINDA/.test(BRUTO));

// ─── B. A tabela ──────────────────────────────────────────────────────

secao("B. Uma tabela, e apenas uma");

ok("B1  cria public.agente_conexoes",
  /create table if not exists public\.agente_conexoes/i.test(SQL));
ok("B2  nenhuma SEGUNDA tabela e criada",
  (SQL.match(/create\s+table/gi) ?? []).length === 1);
ok("B3  CONTROLE: a sonda acharia uma segunda tabela",
  ("create table a (); create table b ();".match(/create\s+table/gi) ?? []).length === 2);

const COLUNAS: readonly (readonly [string, string, boolean])[] = [
  ["agente_id", "uuid", true],
  ["user_id", "text", true],
  ["plataforma", "text", true],
  ["recurso", "text", true],
  ["loja_id", "uuid", true],
  ["criado_em", "timestamptz", true],
  ["alterado_em", "timestamptz", true],
];

for (const [col, tipo, notNull] of COLUNAS) {
  const re = new RegExp(`\\b${col}\\s+${tipo}\\s+not null`, "i");
  ok(`B4 coluna ${col} ${tipo}${notNull ? " not null" : ""}`, re.test(PLANO));
}
ok("B5  os dois timestamps tem default now()",
  (PLANO.match(/timestamptz not null default now\(\)/gi) ?? []).length === 2);
ok("B6  nenhuma coluna alem das sete declaradas",
  (CORPO.match(/^\s{2}[a-z_]+\s+(uuid|text|timestamptz|boolean|integer|jsonb)\b/gmi) ?? []).length === 7);

// ─── C. Identidade ────────────────────────────────────────────────────

secao("C. PK — agente + requisito canonico");

ok("C1  PK e exatamente (agente_id, plataforma, recurso)",
  /primary key \(agente_id, plataforma, recurso\)/i.test(PLANO));
ok("C2  skill_id NAO entra na chave — nem existe na tabela",
  !/skill_id/i.test(SQL));
ok("C3  CONTROLE: a sonda acharia skill_id",
  /skill_id/i.test("primary key (agente_id, skill_id)"));
ok("C4  loja_id NAO faz parte da PK",
  !/primary key \([^)]*loja_id/i.test(PLANO));
ok("C5  nenhum uuid artificial de selecao",
  !/\bid\s+uuid\s+.*default gen_random_uuid/i.test(PLANO));
ok("C6  nenhum UNIQUE redundante alem da PK",
  !/\bunique\b/i.test(SQL));

// ─── D. Owner-closure ─────────────────────────────────────────────────

secao("D. As duas FKs compostas, e o ON DELETE assimetrico");

const fkAgente = /foreign key \(agente_id, user_id\) references public\.agentes \(id, user_id\) on delete cascade on update restrict/i;
const fkLoja = /foreign key \(loja_id, user_id\) references public\.lojas \(id, user_id\) on delete restrict on update restrict/i;

ok("D1  FK do agente: (agente_id, user_id) -> agentes(id, user_id)", fkAgente.test(PLANO));
ok("D2  e ela e ON DELETE CASCADE", /references public\.agentes \(id, user_id\) on delete cascade/i.test(PLANO));
ok("D3  FK da loja: (loja_id, user_id) -> lojas(id, user_id)", fkLoja.test(PLANO));
ok("D4  e ela e ON DELETE RESTRICT", /references public\.lojas \(id, user_id\) on delete restrict/i.test(PLANO));
ok("D5  a loja NAO usa CASCADE nem SET NULL",
  !/references public\.lojas[^,)]*on delete (cascade|set null)/i.test(PLANO));
ok("D6  CONTROLE: a sonda acharia CASCADE na loja",
  /references public\.lojas \(id, user_id\) on delete cascade/i.test(
    "foreign key (loja_id, user_id) references public.lojas (id, user_id) on delete cascade"));
ok("D7  exatamente DUAS foreign keys", (PLANO.match(/foreign key/gi) ?? []).length === 2);
ok("D8  nenhuma FK simples que burle owner-closure — toda FK leva user_id",
  (PLANO.match(/foreign key \([^)]*user_id[^)]*\)/gi) ?? []).length === 2);
ok("D9  CONTROLE: a sonda acharia uma FK sem user_id",
  !/foreign key \([^)]*user_id[^)]*\)/i.test("foreign key (loja_id) references public.lojas (id)"));
ok("D10 zero seller_id / shop_id", !/seller_id|shop_id/i.test(SQL));
ok("D11 CONTROLE: a sonda acharia seller_id", /seller_id/i.test("references lojas (seller_id)"));

// ─── E. CHECKs ────────────────────────────────────────────────────────

secao("E. Formato em recurso, vocabulario em nenhum lugar");

ok("E1  CHECK de formato em recurso",
  /check \(recurso ~ '\^\[a-z0-9\]\+\(-\[a-z0-9\]\+\)\*\$'\)/i.test(PLANO));
ok("E2  o CHECK NAO enumera recursos conhecidos",
  !/recurso in \(|recurso = '/i.test(PLANO));
ok("E3  CONTROLE: a sonda acharia um vocabulario de recurso",
  /recurso in \(/i.test("check (recurso in ('chat','pedidos'))"));
ok("E4  plataforma NAO tem CHECK de vocabulario",
  !/plataforma in \(|plataforma = '|check \(plataforma/i.test(PLANO));
ok("E5  CONTROLE: a sonda acharia um CHECK de plataforma",
  /plataforma in \(/i.test("check (plataforma in ('shopee','mercado_livre'))"));
ok("E6  nenhum tipo enum criado", !/create\s+type|as\s+enum/i.test(SQL));
ok("E7  exatamente UM check na tabela", (PLANO.match(/\bcheck \(/gi) ?? []).length === 1);

// A regex do CHECK precisa aceitar/recusar o que o contrato aceita e
// recusa. Prova comportamental do MESMO padrao, sem banco.
const RE_RECURSO = /^[a-z0-9]+(-[a-z0-9]+)*$/;
for (const [valor, esperado] of [
  ["chat", true], ["pedidos", true], ["mercado-livre", true], ["a1", true],
  ["", false], ["Chat", false], ["full_control", false], ["com espaco", false],
  ["-inicio", false], ["fim-", false],
] as const) {
  ok(`E8 recurso ${JSON.stringify(valor)} -> ${esperado ? "valido" : "invalido"}`,
    RE_RECURSO.test(valor) === esperado);
}

// ─── F. RLS ───────────────────────────────────────────────────────────

secao("F. Sem RLS — o precedente de todas as tabelas deste projeto");

ok("F1  zero ENABLE ROW LEVEL SECURITY", !/row level security/i.test(SQL));
ok("F2  zero CREATE POLICY", !/create\s+policy/i.test(SQL));
ok("F3  CONTROLE: as sondas achariam RLS/policy",
  /row level security/i.test("alter table x enable row level security") &&
  /create\s+policy/i.test("create policy p on x"));

// ─── G. ACL ───────────────────────────────────────────────────────────

secao("G. Quatro REVOKEs nominais e um GRANT de CRUD");

for (const papel of ["public", "anon", "authenticated", "service_role"]) {
  ok(`G1 REVOKE ALL ... FROM ${papel}`,
    new RegExp(`revoke all on table public\\.agente_conexoes from ${papel};`, "i").test(SQL));
}
ok("G2  sao QUATRO revokes, nem um a menos",
  (SQL.match(/revoke all on table public\.agente_conexoes from/gi) ?? []).length === 4);
ok("G3  GRANT para service_role com exatamente SELECT/INSERT/UPDATE/DELETE",
  /grant select, insert, update, delete on table public\.agente_conexoes to service_role;/i.test(PLANO));
ok("G4  um unico GRANT em toda a migration", (SQL.match(/\bgrant\b/gi) ?? []).length === 1);
ok("G5  zero grant para anon", !/grant[^;]*\bto\s+anon\b/i.test(PLANO));
ok("G6  zero grant para authenticated", !/grant[^;]*\bto\s+authenticated\b/i.test(PLANO));
ok("G7  zero grant para public", !/grant[^;]*\bto\s+public\b/i.test(PLANO));
ok("G8  CONTROLE: a sonda acharia um grant indevido",
  /grant[^;]*\bto\s+anon\b/i.test("grant select on table t to anon;"));
// A sonda olha o GRANT, nao o arquivo. Varrer tudo casava com o
// `references` das PROPRIAS FKs — e um strip por `[^,]*` nem chega la,
// porque para na virgula de `(agente_id, user_id)`. Medido, nao suposto.
const GRANT = (SQL.match(/grant[^;]*;/i) ?? [""])[0].replace(/\s+/g, " ");
ok("G9a ANCORA: a instrucao de GRANT foi isolada", /grant select/i.test(GRANT));
ok("G9  o GRANT nao concede TRUNCATE/REFERENCES/TRIGGER/MAINTAIN",
  !/\b(truncate|references|trigger|maintain|all)\b/i.test(GRANT));
ok("G10 CONTROLE: a sonda acharia um grant amplo",
  /\b(truncate|all)\b/i.test("grant all on table t to service_role;"));
ok("G11 o revoke de service_role vem ANTES do grant",
  SQL.search(/revoke all on table public\.agente_conexoes from service_role/i) <
    SQL.search(/grant select/i));
ok("G12 zero ALTER DEFAULT PRIVILEGES", !/alter\s+default\s+privileges/i.test(SQL));
ok("G13 CONTROLE: a sonda acharia ALTER DEFAULT PRIVILEGES",
  /alter\s+default\s+privileges/i.test("alter default privileges in schema public"));

// ─── H. O que a migration NAO faz ─────────────────────────────────────

secao("H. Zero DML, zero objeto adjacente, zero alteracao de tabela existente");

for (const [rot, re, amostra] of [
  ["INSERT", /\binsert\s+into\b/i, "insert into public.t values (1);"],
  ["UPDATE", /\bupdate\s+public\./i, "update public.t set x = 1;"],
  ["DELETE", /\bdelete\s+from\b/i, "delete from public.t;"],
  ["MERGE", /\bmerge\s+into\b/i, "merge into public.t using s on ..."],
  ["TRUNCATE", /\btruncate\b/i, "truncate table public.t;"],
  ["FUNCTION", /create\s+(or\s+replace\s+)?function/i, "create or replace function f()"],
  ["TRIGGER", /create\s+trigger/i, "create trigger t before update on x"],
  ["VIEW", /create\s+(materialized\s+)?view/i, "create view v as select 1;"],
  ["TYPE/DOMAIN", /create\s+(type|domain)/i, "create type t as enum ('a');"],
  ["SEQUENCE", /create\s+sequence/i, "create sequence s;"],
  ["INDEX extra", /create\s+(unique\s+)?index/i, "create index i on t (a);"],
  ["DROP", /\bdrop\s+(table|column|constraint|index)\b/i, "drop table public.t;"],
] as const) {
  ok(`H1 zero ${rot}`, !re.test(SQL));
  ok(`H2 CONTROLE: a sonda de ${rot} acha na amostra`, re.test(amostra));
}

for (const tabela of ["agentes", "lojas", "agente_permissoes", "agente_skills", "skills"]) {
  ok(`H3 zero ALTER TABLE em ${tabela}`,
    !new RegExp(`alter\\s+table\\s+(if exists\\s+)?public\\.${tabela}\\b`, "i").test(SQL));
}
ok("H4  CONTROLE: a sonda de ALTER acharia",
  /alter\s+table\s+public\.agentes\b/i.test("alter table public.agentes add column x int;"));
ok("H5  as tabelas alcancadas sao SO as tres esperadas",
  JSON.stringify([...new Set((SQL.match(/public\.[a-z_]+/gi) ?? []).map((s) => s.toLowerCase()))].sort()) ===
    JSON.stringify(["public.agente_conexoes", "public.agentes", "public.lojas"]));

// ─── I. Fronteira da fase ─────────────────────────────────────────────

secao("I. Nada de producao nesta subfase");

/**
 * A allowlist — EXATA e MINIMA.
 *
 * Ate a 1D.g.1-C esta guarda exigia zero referencias, porque nao havia
 * camada nenhuma. Agora ha uma, e a exigencia correta nao e mais "zero":
 * e que a UNICA porta de leitura da tabela seja a que esta frente
 * autorizou, e que nenhum consumidor externo tenha aparecido.
 *
 * Um arquivo so: `selecao-fatos.ts`, onde vive o `.from(...)`.
 * `selecao-estado.ts` NAO entra — ele e puro, nao toca banco, e cita o
 * nome da tabela apenas em docblock. Colocar um arquivo na allowlist
 * "porque e da mesma pasta" ampliaria a autorizacao alem do que ela
 * precisa cobrir.
 *
 * A comparacao e de CONJUNTO, nao de subconjunto: se a referencia sumir
 * de `selecao-fatos.ts`, a guarda cai tambem — o arquivo autorizado
 * deixaria de ser a porta que a allowlist afirma que ele e.
 */
const REFERENCIA_AUTORIZADA: readonly string[] = ["lib/agentes/conexoes/selecao-fatos.ts"];

/**
 * Comentario nao e consumidor.
 *
 * A varredura anterior lia o arquivo cru e por isso acusava docblock como
 * se fosse acesso ao banco. Aqui o texto e limpo antes de procurar, e so
 * em dois casos: bloco delimitado, e barra-barra iniciando a linha. Um
 * comentario de fim de linha, depois de codigo, PERMANECE — a limpeza
 * erra para o lado de acusar demais, nunca de acusar de menos.
 */
const semComentarios = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

const varrer = (dir: string, achados: string[]): string[] => {
  for (const e of readdirSync(join(RAIZ, dir), { withFileTypes: true })) {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) {
      if (!/node_modules|\.next/.test(e.name)) varrer(rel, achados);
    } else if (/\.tsx?$/.test(e.name)) {
      const codigo = semComentarios(readFileSync(join(RAIZ, rel), "utf8"));
      if (/agente_conexoes|agenteConexoes/.test(codigo)) achados.push(rel);
    }
  }
  return achados;
};
const consumidores = varrer("lib", varrer("app", [])).sort();
ok("I1  so a camada autorizada referencia agente_conexoes — zero consumidor externo",
  JSON.stringify(consumidores) === JSON.stringify([...REFERENCIA_AUTORIZADA].sort()),
  consumidores.join(", "));
ok("I1b CONTROLE: a limpeza tira comentario e preserva codigo",
  semComentarios('/** agente_conexoes */\n// agente_conexoes\nfrom("agente_conexoes");') ===
    '\n\nfrom("agente_conexoes");');
ok("I2  ANCORA: a varredura leu arquivos de verdade",
  existsSync(join(RAIZ, "lib/agentes/conexoes/fatos.ts")));
ok("I3  a camada de conexoes segue sem selecao — resolverFatoConexao ainda exige lojaId",
  /lojaId: string/.test(readFileSync(join(RAIZ, "lib/agentes/conexoes/fatos.ts"), "utf8")));
ok("I4  nenhuma suite de banco desta frente existe ainda",
  !existsSync(join(RAIZ, "scripts/testar-ia-skill-1d-g1-banco.ts")));

console.log(`\n══ ${passou} PASS / ${falhou} FAIL ══\n`);
process.exitCode = falhou === 0 ? 0 : 1;
