/**
 * CDS IA — SKILL-1D.f.1. Suite de schema de `skills` e `agente_skills`.
 *
 * A migration NAO foi aplicada, e esta suite NAO toca banco. Ela prova o
 * CONTRATO DE SCHEMA por leitura do SQL — o unico artefato que existe
 * nesta fase — e as propriedades puras que dele decorrem.
 *
 * Os testes que exigem banco real (cross-tenant recusado pela FK, CASCADE
 * ao apagar agente, RESTRICT ao apagar Skill em uso, uma-vigente-so sob
 * concorrencia, duplicata de versao) pertencem a SKILL-1D.f.1b, uma suite
 * explicitamente marcada com escrita, e NAO sao executados aqui. O que
 * esta provado abaixo e que a constraint EXISTE, com a forma exata.
 *
 * Rodar:  npx tsx scripts/testar-ia-skill-1d-f1.ts
 * Sem rede, sem banco, sem IA, sem escrita.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { ORIGENS_SKILL, FORMATO_SUPORTADO } from "../lib/ia/skills/contrato";

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
const ler = (rel: string) => readFileSync(join(RAIZ, rel), "utf8");
const existe = (rel: string) => existsSync(join(RAIZ, rel));

const CAMINHO = "supabase/migrations/20260922_skills.sql";
const SQL = ler(CAMINHO);
/** Sem comentarios: `-- ...` ate o fim da linha. Um CHECK citado em
 *  comentario nao pode contar como CHECK declarado. */
const DDL = SQL.replace(/^\s*--.*$/gm, "");

/** Corpo de um `create table` especifico, para separar coluna de vizinha. */
function corpoDe(tabela: string): string {
  const i = DDL.indexOf(`create table if not exists public.${tabela}`);
  return i < 0 ? "" : DDL.slice(i, DDL.indexOf("\n);", i) + 3);
}
const T_SKILLS = corpoDe("skills");
const T_ASSOC = corpoDe("agente_skills");

console.log("\n══ CDS IA — SKILL-1D.f.1: schema de Skills ══");

// ─── A. Arquivo ───────────────────────────────────────────────────────

secao("A. A migration existe e declara que nao foi aplicada");

ok("A1  o arquivo existe", existe(CAMINHO));
ok("A2  DDL analisada nao esta vazia (ancora)", DDL.length > 800, String(DDL.length));
ok("A3  declara NAO APLICADA AINDA (convencao do projeto)", /NAO APLICADA AINDA/.test(SQL));
ok("A4  uma unica migration com este timestamp",
  readdirSync(join(RAIZ, "supabase/migrations")).filter((f) => f.startsWith("20260922")).length === 1);
ok("A5  timestamp posterior a ultima versionada (20260921)", CAMINHO.includes("20260922"));
ok("A6  os dois corpos de tabela foram isolados (ancora do parser)",
  T_SKILLS.length > 400 && T_ASSOC.length > 200);

// ─── B. Exatamente duas tabelas ───────────────────────────────────────

secao("B. Exatamente duas tabelas, e nenhuma a mais");

const tabelas = (DDL.match(/create table if not exists public\.(\w+)/g) ?? [])
  .map((s) => s.replace(/.*public\./, ""));
ok(`B1  duas tabelas: ${tabelas.join(", ")}`,
  JSON.stringify([...tabelas].sort()) === JSON.stringify(["agente_skills", "skills"]));
ok("B2  nenhuma tabela de Ficha foi criada",
  !/create table[^;]*(fichas|skill_fichas)/i.test(DDL));
ok("B3  CONTROLE: a sonda de tabela acha quando existe",
  /create table if not exists public\.(\w+)/.test("create table if not exists public.x ("));

// ─── C. Colunas de skills ─────────────────────────────────────────────

secao("C. skills — 11 colunas, tipos e NOT NULL");

const COLUNAS_SKILLS: ReadonlyArray<[string, string]> = [
  ["id", "uuid"], ["user_id", "text"], ["slug", "text"], ["versao", "text"],
  ["nome", "text"], ["origem", "text"], ["manifesto", "jsonb"], ["corpo", "text"],
  ["conteudo_hash", "text"], ["vigente", "boolean"], ["criado_em", "timestamptz"],
];
for (const [col, tipo] of COLUNAS_SKILLS) {
  ok(`C  ${col} ${tipo} not null`,
    new RegExp(`^\\s*${col}\\s+${tipo}\\s+not null`, "m").test(T_SKILLS));
}
ok("C12 exatamente 11 colunas declaradas", COLUNAS_SKILLS.length === 11);
ok("C13 NAO existe alterado_em (linha imutavel no conteudo)",
  !/\balterado_em\b/.test(T_SKILLS));
ok("C14 defaults permitidos: id, vigente e criado_em",
  /id\s+uuid\s+not null default gen_random_uuid\(\)/.test(T_SKILLS) &&
  /vigente\s+boolean\s+not null default false/.test(T_SKILLS) &&
  /criado_em\s+timestamptz\s+not null default now\(\)/.test(T_SKILLS));
ok("C15 `vigente` NAO nasce true", !/vigente[^,]*default true/.test(T_SKILLS));

// ─── D. Identidade e versionamento ────────────────────────────────────

secao("D. Identidade: PK, unicidade e vigente");

ok("D1  PK e `id`", /constraint skills_pk primary key \(id\)/.test(T_SKILLS));
ok("D2  UNIQUE (user_id, slug, versao)",
  /constraint skills_versao_unica unique \(user_id, slug, versao\)/.test(T_SKILLS));
ok("D3  UNIQUE (user_id, id) — habilita a FK composta",
  /constraint skills_id_por_dono unique \(user_id, id\)/.test(T_SKILLS));
ok("D4  indice unico PARCIAL de vigente",
  /create unique index if not exists idx_skills_vigente_por_slug[\s\S]{0,120}on public\.skills \(user_id, slug\)[\s\S]{0,40}where vigente/.test(DDL));
ok("D5  o indice de vigente e UNIQUE (nao apenas index)",
  /create unique index[^;]*idx_skills_vigente_por_slug/.test(DDL.replace(/\n/g, " ")));
ok("D6  o indice de vigente tem WHERE (parcial, nao total)",
  /idx_skills_vigente_por_slug[\s\S]*?where vigente/.test(DDL));
ok("D7  zero troca automatica de vigente (sem trigger/rule)",
  !/create (or replace )?(trigger|rule)/i.test(DDL));
ok("D8  CONTROLE: a sonda de indice parcial acha quando existe",
  /where vigente/.test("on t (a) where vigente;"));

// ─── E. Manifesto e integridade coluna x manifesto ────────────────────

secao("E. Uma verdade: coluna espelha o manifesto");

ok("E1  manifesto e jsonb not null", /manifesto jsonb not null/.test(T_SKILLS));
ok("E2  CHECK jsonb_typeof = object",
  /constraint skills_manifesto_objeto\s*check \(jsonb_typeof\(manifesto\) = 'object'\)/.test(T_SKILLS));

for (const [col, chave] of [["slug", "id"], ["versao", "versao"], ["nome", "nome"], ["origem", "origem"]] as const) {
  const re = new RegExp(
    `constraint skills_${col}_igual_ao_manifesto\\s*check \\(manifesto->>'${chave}' is not null and ${col} = manifesto->>'${chave}'\\)`
  );
  ok(`E  ${col} = manifesto->>'${chave}', com guarda de NULL`, re.test(T_SKILLS));
}

{
  // A armadilha que estes CHECKs existem para nao ter: `col = NULL`
  // avalia como NULL, e CHECK aceita NULL — so `false` reprova. Sem o
  // `is not null`, cada um falharia ABERTO no caso que deve pegar.
  const equivalencias = T_SKILLS.match(/constraint skills_\w+_igual_ao_manifesto\s*check \([^)]*\)/g) ?? [];
  ok(`E7  as 4 equivalencias existem (${equivalencias.length})`, equivalencias.length === 4);
  // `every` sobre lista vazia devolve true: sem o teste de tamanho aqui
  // dentro, este assert passaria por VACUIDADE se a extracao falhasse.
  ok("E8  TODAS guardam contra NULL — nenhuma falha aberta",
    equivalencias.length === 4 && equivalencias.every((c) => /is not null and/.test(c)));
  ok("E9  CONTROLE: uma equivalencia sem guarda seria detectada",
    !/is not null and/.test("check (slug = manifesto->>'id')"));
}

ok("E10 formato do manifesto e checado como numero e igual a 1",
  /constraint skills_formato_suportado[\s\S]{0,200}jsonb_typeof\(manifesto->'formato'\) = 'number'[\s\S]{0,80}manifesto->>'formato' = '1'/.test(T_SKILLS));
ok("E11 o 1 do SQL bate com FORMATO_SUPORTADO da aplicacao",
  new RegExp(`manifesto->>'formato' = '${FORMATO_SUPORTADO}'`).test(T_SKILLS));
ok("E12 NAO usa cast ::int no CHECK de formato (evita 22P02)",
  !/manifesto->>'formato'\s*\)?::int/.test(T_SKILLS));

// ─── F. Slug contra o parser real ─────────────────────────────────────

secao("F. slug: o SQL usa o dominio publicado, nao um parecido");

{
  const FONTE = ler("lib/ia/skills/formato.ts");
  const m = FONTE.match(/const RE_SLUG = \/(.+?)\/;/);
  ok("F1  RE_SLUG foi encontrado no parser (ancora)", m !== null);

  // Postgres nao precisa do grupo nao-capturante; a comparacao normaliza
  // `(?:` -> `(`, exatamente como a suite da 1D.d.1 ja fazia para RE_FUNCAO.
  const canonico = (m?.[1] ?? "").replace(/\(\?:/g, "(");
  const noSql = (T_SKILLS.match(/constraint skills_slug_formato\s*check \(slug ~ '(.+?)'\)/) ?? [])[1] ?? "";
  ok(`F2  o literal do SQL e o do parser (${noSql})`, noSql === canonico, `parser=${canonico}`);
  ok("F3  ancora de inicio e fim presentes", noSql.startsWith("^") && noSql.endsWith("$"));
  ok("F4  CONTROLE: a normalizacao nao apaga o resto",
    canonico.includes("[a-z0-9]") && canonico.length > 10);
}

// ─── G. Origem contra o contrato ──────────────────────────────────────

secao("G. origem: os tres valores publicados");

{
  const m = T_SKILLS.match(/constraint skills_origem_valida\s*check \(origem in \((.+?)\)\)/);
  ok("G1  o CHECK de origem existe", m !== null);
  const valores = (m?.[1] ?? "").split(",").map((s) => s.trim().replace(/'/g, ""));
  ok(`G2  bate com ORIGENS_SKILL (${valores.join(", ")})`,
    JSON.stringify([...valores].sort()) === JSON.stringify([...ORIGENS_SKILL].sort()));
  ok("G3  sao exatamente tres", valores.length === 3 && ORIGENS_SKILL.length === 3);
  ok("G4  ancora: ORIGENS_SKILL nao esta vazio", ORIGENS_SKILL.length > 0);
}

// ─── H. conteudo_hash ─────────────────────────────────────────────────

secao("H. conteudo_hash: 64 hex minusculos, e nao e unique");

const RE_HASH_SQL = /constraint skills_conteudo_hash_formato\s*check \(conteudo_hash ~ '(.+?)'\)/;
{
  const m = T_SKILLS.match(RE_HASH_SQL);
  ok("H1  o CHECK existe", m !== null);
  const padrao = m?.[1] ?? "";
  ok(`H2  o padrao e exatamente 64 hex lowercase (${padrao})`,
    padrao === "^[0-9a-f]{64}$");

  // A regex do SQL, exercitada de verdade em JS: um padrao que "parece"
  // certo mas aceita 63 ou maiusculas nao seria pego por comparacao de
  // texto sozinha.
  const re = new RegExp(padrao);
  const hex64 = "a".repeat(64);
  ok("H3  aceita 64 hex minusculos", re.test(hex64));
  ok("H4  recusa 63", !re.test("a".repeat(63)));
  ok("H5  recusa 65", !re.test("a".repeat(65)));
  ok("H6  recusa maiusculas", !re.test("A".repeat(64)));
  ok("H7  recusa nao-hex", !re.test("g".repeat(64)));
  ok("H8  recusa vazio", !re.test(""));
}
ok("H9  conteudo_hash e not null", /conteudo_hash text not null/.test(T_SKILLS));
ok("H10 conteudo_hash NAO e unique", !/unique[^)]*conteudo_hash/.test(T_SKILLS));
ok("H11 o banco NAO calcula o hash", !/(sha256|digest|pgcrypto)/i.test(DDL));

// ─── I. Corpo ─────────────────────────────────────────────────────────

secao("I. corpo: uma coluna, sem tabela filha");

ok("I1  corpo text not null", /corpo\s+text\s+not null/.test(T_SKILLS));
ok("I2  nenhuma tabela filha para corpo", tabelas.length === 2);
ok("I3  sem criptografia na migration", !/(encrypt|pgp_|crypt\()/i.test(DDL));
ok("I4  a migration NAO reimplementa acharSegredos",
  !/(access_token|refresh_token|partner_key|client_secret|Bearer)/i.test(DDL));

// ─── J. agente_skills ─────────────────────────────────────────────────

secao("J. agente_skills — 4 colunas e nada alem");

const COLUNAS_ASSOC: ReadonlyArray<[string, string]> = [
  ["agente_id", "uuid"], ["skill_id", "uuid"], ["user_id", "text"], ["criado_em", "timestamptz"],
];
for (const [col, tipo] of COLUNAS_ASSOC) {
  ok(`J  ${col} ${tipo} not null`,
    new RegExp(`^\\s*${col}\\s+${tipo}\\s+not null`, "m").test(T_ASSOC));
}
ok("J5  PK (agente_id, skill_id)",
  /constraint agente_skills_pk primary key \(agente_id, skill_id\)/.test(T_ASSOC));
ok("J6  varias Skills por agente: a PK restringe o PAR, nao o agente",
  !/primary key \(agente_id\)/.test(T_ASSOC) && !/unique \(agente_id\)/.test(T_ASSOC));

for (const proibida of ["ordem", "prioridade", "ativa", "ativo", "nivel", "autonomia", "obrigatoria"]) {
  ok(`J  sem coluna \`${proibida}\``, !new RegExp(`^\\s*${proibida}\\s+\\w`, "m").test(T_ASSOC));
}

// ─── K. FKs compostas ─────────────────────────────────────────────────

secao("K. FKs compostas por dono, com CASCADE e RESTRICT");

ok("K1  FK do agente por (agente_id, user_id)",
  /constraint agente_skills_agente_do_mesmo_dono\s*foreign key \(agente_id, user_id\)\s*references public\.agentes \(id, user_id\)/.test(T_ASSOC));
ok("K2  FK da Skill por (skill_id, user_id)",
  /constraint agente_skills_skill_do_mesmo_dono\s*foreign key \(skill_id, user_id\)\s*references public\.skills \(id, user_id\)/.test(T_ASSOC));

{
  const fkAgente = (T_ASSOC.match(/agente_skills_agente_do_mesmo_dono[\s\S]*?on update restrict/) ?? [""])[0];
  const fkSkill = (T_ASSOC.match(/agente_skills_skill_do_mesmo_dono[\s\S]*?on update restrict/) ?? [""])[0];
  ok("K3  agente: ON DELETE CASCADE", /on delete cascade/.test(fkAgente));
  ok("K4  Skill: ON DELETE RESTRICT", /on delete restrict/.test(fkSkill));
  ok("K5  a assimetria e real — nao sao iguais",
    /on delete cascade/.test(fkAgente) && !/on delete cascade/.test(fkSkill));
  ok("K6  agente: ON UPDATE RESTRICT", /on update restrict/.test(fkAgente));
  ok("K7  Skill: ON UPDATE RESTRICT", /on update restrict/.test(fkSkill));
  ok("K8  ANCORA: os dois trechos foram mesmo isolados",
    fkAgente.length > 60 && fkSkill.length > 60);
}
ok("K9  a FK da Skill se apoia em skills_id_por_dono",
  /constraint skills_id_por_dono unique \(user_id, id\)/.test(T_SKILLS));

// ─── L. Fronteiras: loja, segredo, autoridade, ficha ──────────────────

secao("L. O que NAO pode existir no schema de Skill");

for (const [nome, re] of [
  ["loja_id", /\bloja_id\b/], ["seller_id", /\bseller_id\b/], ["shop_id", /\bshop_id\b/],
  ["partner_id", /\bpartner_id\b/], ["token", /\btoken\b/], ["credencial", /\bcredencial\b/],
  ["api_key", /\bapi_key\b/], ["senha", /\bsenha\b/], ["handler", /\bhandler\b/],
  ["script", /\bscript\b/],
] as const) {
  ok(`L  zero \`${nome}\` no SQL executavel`, !re.test(DDL));
}
ok("L11 `nivel`/`autonomia` nao viram coluna",
  !/^\s*(nivel|autonomia)\s+\w/m.test(DDL));
ok("L12 `user_id` existe SO como coluna de posse",
  /user_id\s+text\s+not null/.test(T_SKILLS) && /user_id\s+text\s+not null/.test(T_ASSOC));
ok("L13 `agente_id` existe SO na associacao",
  !/\bagente_id\b/.test(T_SKILLS) && /\bagente_id\b/.test(T_ASSOC));
ok("L14 CONTROLE: as sondas de proibido acusam quando o termo existe",
  /\bloja_id\b/.test("x loja_id y") && /\btoken\b/.test("a token b"));

// ─── M. RLS ───────────────────────────────────────────────────────────

secao("M. RLS OFF, coerente com o padrao medido");

ok("M1  nenhuma policy criada", !/create policy/i.test(DDL));
ok("M2  nenhum enable row level security", !/enable row level security/i.test(DDL));
ok("M3  nenhum auth.uid() em linha executavel", !/auth\.uid\(\)/.test(DDL));
ok("M4  a decisao esta REGISTRADA por escrito no arquivo",
  /RLS/.test(SQL) && /auth\.uid\(\)/.test(SQL));
ok("M5  CONTROLE: a sonda de policy acha quando existe",
  /create policy/i.test("CREATE POLICY p ON t"));

// ─── N. Privilegios ───────────────────────────────────────────────────

secao("N. REVOKE antes de GRANT, nas duas tabelas");

for (const tabela of ["skills", "agente_skills"]) {
  for (const papel of ["public", "anon", "authenticated", "service_role"]) {
    ok(`N  revoke all em ${tabela} de ${papel}`,
      new RegExp(`revoke all on table public\\.${tabela} from ${papel};`).test(DDL));
  }
}
ok("N9  skills: GRANT de SELECT/INSERT/DELETE, sem UPDATE de tabela",
  /grant select, insert, delete on table public\.skills to service_role;/.test(DDL));
ok("N10 agente_skills: GRANT de SELECT/INSERT/DELETE",
  /grant select, insert, delete on table public\.agente_skills to service_role;/.test(DDL));

{
  // O REVOKE tem de vir ANTES do GRANT: GRANT e aditivo, e a ordem
  // invertida deixaria os oito privilegios do ALTER DEFAULT PRIVILEGES.
  const iRevoke = DDL.indexOf("revoke all on table public.skills from service_role;");
  const iGrant = DDL.indexOf("grant select, insert, delete on table public.skills");
  ok("N11 skills: revoke de service_role vem ANTES do grant",
    iRevoke > 0 && iGrant > 0 && iRevoke < iGrant);
  const iRevokeA = DDL.indexOf("revoke all on table public.agente_skills from service_role;");
  const iGrantA = DDL.indexOf("grant select, insert, delete on table public.agente_skills");
  ok("N12 agente_skills: revoke de service_role vem ANTES do grant",
    iRevokeA > 0 && iGrantA > 0 && iRevokeA < iGrantA);
  const iUpd = DDL.indexOf("grant update (vigente) on table public.skills");
  ok("N12b o grant de coluna tambem vem DEPOIS do revoke",
    iRevoke > 0 && iUpd > 0 && iRevoke < iUpd);
}

for (const extra of ["truncate", "references", "trigger", "maintain"]) {
  ok(`N  nenhum grant de ${extra}`, !new RegExp(`grant[^;]*\\b${extra}\\b`, "i").test(DDL));
}
ok("N17 CONTROLE: a sonda de privilegio extra acha quando existe",
  /grant[^;]*\btruncate\b/i.test("grant truncate on t to r;"));
ok("N18 NAO altera o default privilege global (causa raiz e frente propria)",
  !/alter default privileges/i.test(DDL));

// ─── N-b. UPDATE: imutabilidade garantida por privilegio ──────────────
//
// O schema DECLARA conteudo imutavel por versao. Um `grant update` de
// TABELA contradiria isso: os quatro CHECKs de equivalencia continuariam
// satisfeitos se manifesto e colunas fossem reescritos JUNTOS — eles
// provam coerencia, nao imutabilidade. Quem garante e o privilegio.
secao("N-b. UPDATE existe SO para `vigente`");

const GRANTS_UPDATE = (DDL.match(/grant[^;]*\bupdate\b[^;]*;/gi) ?? []).map((g) => g.trim());

ok(`N19 ha exatamente UM grant com update (${GRANTS_UPDATE.length})`, GRANTS_UPDATE.length === 1);
ok("N20 e ele e por COLUNA, restrito a `vigente`",
  GRANTS_UPDATE.length === 1 &&
  /^grant update \(vigente\) on table public\.skills to service_role;$/.test(GRANTS_UPDATE[0]));

ok("N21 NAO ha update de TABELA em skills",
  !/grant[^;(]*\bupdate\b[^;(]*on table public\.skills to/i.test(DDL));
ok("N22 NAO ha update, de tabela ou coluna, em agente_skills",
  !/grant[^;]*\bupdate\b[^;]*agente_skills/i.test(DDL));

{
  // Nenhuma OUTRA coluna recebe update. Extrai a lista entre parenteses
  // do unico grant de coluna e confere que so `vigente` esta la.
  const colunas = (GRANTS_UPDATE[0]?.match(/update \(([^)]*)\)/) ?? [])[1] ?? "";
  const lista = colunas.split(",").map((c) => c.trim()).filter(Boolean);
  ok(`N23 uma unica coluna atualizavel (${lista.join(", ") || "nenhuma"})`,
    lista.length === 1 && lista[0] === "vigente");

  for (const proibida of ["slug", "versao", "nome", "origem", "manifesto", "corpo", "conteudo_hash", "user_id", "id"]) {
    ok(`N  \`${proibida}\` NAO e atualizavel`, !lista.includes(proibida));
  }
}

ok("N33 CONTROLE POSITIVO: a sonda pega um update de tabela se existir",
  /grant[^;(]*\bupdate\b[^;(]*on table public\.skills to/i
    .test("grant select, update on table public.skills to r;"));
ok("N34 CONTROLE POSITIVO: a extracao de colunas pega mais de uma",
  ("grant update (a, b) on t".match(/update \(([^)]*)\)/) ?? [])[1]?.split(",").length === 2);
ok("N35 CONTROLE NEGATIVO: um segundo grant de update seria detectado",
  ("grant update (x) on t; grant update (y) on t;".match(/grant[^;]*\bupdate\b[^;]*;/gi) ?? []).length === 2);

// ─── O. Zero automacao ────────────────────────────────────────────────

secao("O. Zero trigger, zero seed, zero backfill");

ok("O1  nenhum trigger", !/create (or replace )?trigger/i.test(DDL));
ok("O2  nenhuma function/rule", !/create (or replace )?(function|rule)/i.test(DDL));
ok("O3  zero seed — nenhum INSERT", !/\binsert\s+into\b/i.test(DDL));
ok("O4  zero backfill — nenhum UPDATE/DELETE", !/\b(update|delete)\s+(public\.|from)/i.test(DDL));
ok("O5  nenhum DEFAULT que associe ou promova sozinho",
  !/default\s+true/i.test(DDL));
ok("O6  CONTROLE: a sonda de seed acha quando existe",
  /\binsert\s+into\b/i.test("INSERT INTO t VALUES (1)"));

// ─── P. Fronteira desta fase ──────────────────────────────────────────

secao("P. A fase nao tocou banco nem criou caminho de escrita");

{
  // ── SENTINELA TEMPORAL, ATUALIZADA ────────────────────────────────
  //
  // Este assert nasceu afirmando que a suite de banco da 1D.f.1b NAO
  // existia — era a fronteira desta fase, que criou a migration e nao a
  // prova em runtime. A 1D.f.1b-A criou a suite, entao a AFIRMACAO mudou;
  // o que ela guarda, nao. A fronteira que continua valendo e: quem
  // aplica a migration NAO e o teste.
  //
  // ── por que recortar antes de varrer ──────────────────────────────
  //
  // A suite alvo tem um bloco proprio de auto-verificacao com CONTROLES
  // POSITIVOS — literalmente `create table x ()` e a regex
  // `/create\s+table|apply_migration/`. Uma sonda textual ingenua
  // reprovaria por causa deles, acusando o alvo de fazer justamente o que
  // os controles existem para provar que ele NAO faz. Por isso comentario
  // e bloco de auto-verificacao saem antes, e o que se procura e
  // MECANISMO EXECUTAVEL de DDL, nao a sequencia de caracteres.
  const CAMINHO_BANCO = "scripts/testar-ia-skill-1d-f1-banco.ts";
  const existeBanco = existe(CAMINHO_BANCO);

  const bruto = existeBanco ? ler(CAMINHO_BANCO) : "";
  const semCom = bruto.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
  const iAuto = semCom.indexOf("function autoVerificar()");
  const fimAuto = semCom.indexOf("\n}\n", iAuto);
  const EXEC = iAuto < 0 ? semCom : semCom.slice(0, iAuto) + semCom.slice(fimAuto);

  const recorteValido = iAuto > 0 && fimAuto > iAuto && EXEC.length < semCom.length - 500;
  const semDDL = !/\b(create|drop|alter)\s+table\b/i.test(EXEC);
  const semAplicador = !/apply_migration|db\s+push|migration\s+up/i.test(EXEC);
  const verificaHistorico = /supabase_migrations\.schema_migrations/.test(EXEC);

  ok("P1  a suite de banco existe, NAO aplica migration e verifica a ja aplicada",
    existeBanco && recorteValido && semDDL && semAplicador && verificaHistorico,
    `existe=${existeBanco} recorte=${recorteValido} semDDL=${semDDL} semAplicador=${semAplicador} historico=${verificaHistorico}`);
}
{
  // SENTINELA TEMPORAL, ATUALIZADA — mesma historia de P1 acima.
  //
  // Nasceu afirmando que `lib/agentes/skills/` NAO existia: era a
  // fronteira da 1D.f.1, que criou o SCHEMA e nao a leitura. A 1D.f.2
  // criou a leitura, entao a afirmacao mudou; o que ela guarda, nao.
  //
  // A fronteira que continua valendo e: a fase do SCHEMA nao trouxe
  // caminho de escrita nem consumidor. Por isso o assert passa a exigir
  // que o modulo de leitura exista E continue sendo so leitura — o que e
  // mais forte que um `existsSync` negativo, porque inspeciona codigo.
  const CAMINHO_LEITURA = "lib/agentes/skills/fatos.ts";
  const existeLeitura = existe(CAMINHO_LEITURA);
  const codigo = existeLeitura
    ? ler(CAMINHO_LEITURA).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "")
    : "";

  const semEscrita = !/\.(insert|update|delete|upsert|rpc)\(/.test(codigo);
  const serverOnly = /import "server-only"/.test(codigo);
  const semDDL = !/\b(create|drop|alter)\s+table\b/i.test(codigo);

  ok("P2  o modulo de leitura da 1D.f.2 existe e continua SO leitura",
    existeLeitura && codigo.length > 500 && semEscrita && serverOnly && semDDL,
    `existe=${existeLeitura} semEscrita=${semEscrita} serverOnly=${serverOnly} semDDL=${semDDL}`);
}
ok("P3  lib/ia/skills continua com 3 modulos",
  readdirSync(join(RAIZ, "lib/ia/skills")).length === 3);
ok("P4  lib/agentes/permissoes intocada — 2 modulos",
  readdirSync(join(RAIZ, "lib/agentes/permissoes")).length === 2);
ok("P5  lib/agentes/conexoes intocada — 2 modulos",
  readdirSync(join(RAIZ, "lib/agentes/conexoes")).length === 2);
ok("P6  a migration declara o rollback na ordem correta",
  /drop table if exists public\.agente_skills;[\s\S]*drop table if exists public\.skills;/.test(SQL));

// ─── Q. Corretiva do fail-open de `formato` (1D.f.1b-D) ──────────────
//
// A prova em runtime (1D.f.1b-C) mostrou que
// `skills_formato_suportado` ACEITAVA manifesto sem a chave `formato`:
// CHECK do Postgres reprova so `false`, e a expressao avaliava NULL.
//
// A secao E acima continua provando o que a `20260922` DECLARA — ela
// nao foi editada, e continua com a forma defeituosa. O que esta secao
// prova e que a corretiva existe e fecha o buraco.

secao("Q. skills_formato_suportado agora falha FECHADO");

{
  const CAMINHO_Q = "supabase/migrations/20260923_skills_formato_fail_closed.sql";
  ok("Q1  a migration corretiva existe", existe(CAMINHO_Q));

  const SQL_Q = existe(CAMINHO_Q) ? ler(CAMINHO_Q) : "";
  const DDL_Q = SQL_Q.replace(/^\s*--.*$/gm, "");

  ok("Q2  declara NAO APLICADA AINDA (convencao do projeto)",
    /NAO APLICADA AINDA/.test(SQL_Q));
  ok("Q3  a original NAO foi editada — segue com a forma defeituosa",
    /check \(jsonb_typeof\(manifesto->'formato'\) = 'number'\s*\n?\s*and manifesto->>'formato' = '1'\)/
      .test(ler(CAMINHO)));

  ok("Q4  faz DROP da constraint defeituosa",
    /alter table public\.skills\s+drop constraint skills_formato_suportado;/.test(DDL_Q));
  ok("Q5  e RECRIA com o mesmo nome",
    /alter table public\.skills\s+add constraint skills_formato_suportado/.test(DDL_Q));

  // Expressao NOVA, extraida do arquivo e normalizada. Trabalhar sobre o
  // texto extraido — nao sobre o arquivo inteiro — impede que a sonda
  // case com comentario, com o bloco de ROLLBACK (que cita a forma
  // ANTIGA de proposito) ou consigo mesma.
  const m = DDL_Q.match(/add constraint skills_formato_suportado\s*check \(([\s\S]*?)\);/);
  const NOVA = (m?.[1] ?? "").replace(/\s+/g, " ").trim();
  ok(`Q6  ANCORA: a expressao nova foi extraida (${NOVA.length} chars)`, NOVA.length > 60);

  /**
   * O predicado. Uma expressao so e fail-closed aqui se afirmar as TRES
   * coisas — e a primeira e a que faltava.
   */
  const conjuntos = (e: string) => ({
    presenca: /manifesto->'formato'\s+is not null/i.test(e),
    tipo: /jsonb_typeof\(manifesto->'formato'\)\s*=\s*'number'/i.test(e),
    valor: /manifesto->>'formato'\s*=\s*'1'/i.test(e),
  });
  const nova = conjuntos(NOVA);

  ok("Q7  conjunto 1 — GUARDA DE PRESENCA (era o que faltava)", nova.presenca);
  ok("Q8  conjunto 2 — o tipo tem de ser `number`", nova.tipo);
  ok("Q9  conjunto 3 — o valor tem de ser 1", nova.valor);
  ok("Q10 os tres estao ligados por AND", (NOVA.match(/\band\b/gi) ?? []).length >= 2);

  // CONTROLE NEGATIVO: a forma ANTIGA, literal, tem de reprovar no
  // predicado. Sem isto, Q7 passaria por qualquer expressao que
  // mencionasse `is not null` em qualquer lugar.
  const ANTIGA = "jsonb_typeof(manifesto->'formato') = 'number' and manifesto->>'formato' = '1'";
  const antiga = conjuntos(ANTIGA);
  ok("Q11 CONTROLE NEGATIVO: a forma ANTIGA reprova no guarda de presenca",
    antiga.presenca === false);
  ok("Q12 CONTROLE: a forma antiga ainda satisfazia tipo e valor",
    antiga.tipo && antiga.valor);
  ok("Q13 e por isso o defeito passava — texto certo, semantica NULL",
    !antiga.presenca && antiga.tipo && antiga.valor);

  // Os cinco casos do contrato, cada um amarrado ao conjunto que o
  // reprova. A semantica em si e provada em runtime (`C-G` da suite de
  // banco); aqui se prova que existe a CLAUSULA capaz de reprovar cada um.
  ok("Q14 chave AUSENTE -> reprovada pelo conjunto de presenca", nova.presenca);
  ok("Q15 `formato: 1` (number) -> aceito pelos tres conjuntos",
    nova.presenca && nova.tipo && nova.valor);
  ok("Q16 `formato: 0` -> reprovado pelo conjunto de valor", nova.valor);
  ok("Q17 `formato: 2` -> reprovado pelo conjunto de valor", nova.valor);
  ok("Q18 `formato: \"1\"` (string) -> reprovado pelo conjunto de tipo", nova.tipo);

  // A corretiva tem o tamanho do defeito: uma constraint, nada mais.
  ok("Q19 nao mexe em coluna, FK, indice, RLS nem policy",
    !/\b(add|drop)\s+column\b/i.test(DDL_Q) && !/foreign key/i.test(DDL_Q) &&
    !/create\s+(unique\s+)?index/i.test(DDL_Q) && !/row level security|create policy/i.test(DDL_Q));
  ok("Q20 nao reexecuta GRANT/REVOKE", !/\b(grant|revoke)\b/i.test(DDL_Q));
  ok("Q21 nao toca agente_skills", !/agente_skills/i.test(DDL_Q));
  ok("Q22 nao toca outros CHECKs de skills",
    !/skills_(manifesto_objeto|slug_formato|origem_valida|conteudo_hash_formato|\w+_igual_ao_manifesto)/
      .test(DDL_Q));
  ok("Q23 CONTROLE: as sondas de escopo acusam quando o padrao existe",
    /\badd\s+column\b/i.test("alter table t add column x int") && /\bgrant\b/i.test("grant select on t to r"));
}

// ─── Placar ───────────────────────────────────────────────────────────

console.log(`\n${"═".repeat(66)}`);
console.log(`  ${passou}/${passou + falhou} passaram` + (falhou > 0 ? `  ·  ${falhou} FALHARAM` : ""));
console.log(`${"═".repeat(66)}\n`);
process.exit(falhou > 0 ? 1 : 0);
