/**
 * CDS IA — SKILL-1D.f.4-A. Suite estrutural da RPC de promocao.
 *
 * A migration ainda NAO foi aplicada: a funcao nao existe no banco. O
 * que existe e um arquivo, e e o arquivo que esta suite audita.
 *
 * ── Por que sondar o SQL sem comentarios ────────────────────────────
 *
 * O cabecalho da migration explica, em prosa, exatamente as coisas que
 * as sondas procuram: `for update`, `security definer`, `and vigente`,
 * `alter table`, `advisory`. Uma sonda ingenua leria a EXPLICACAO de
 * por que algo foi descartado e concluiria que aquilo esta presente.
 *
 * E o mesmo defeito registrado como `P7` em `testar-ia-skill-1d-d2.ts`,
 * que procura um nome de funcao no arquivo cru e reprova por causa de um
 * docblock. Nao se repete aqui: tudo abaixo varre `SQL`, ja sem
 * comentario, e `A0` ancora que a remocao tirou algo.
 *
 * Rodar:  npx tsx scripts/testar-ia-skill-1d-f4.ts
 * Sem rede, sem banco, sem IA, sem escrita. Nao exige `--confirmo`
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
const NOME_MIGRATION = "20260924_skills_promover_vigente.sql";
const CAMINHO = `supabase/migrations/${NOME_MIGRATION}`;

const BRUTO = readFileSync(join(RAIZ, CAMINHO), "utf8");

/** Remove comentario de bloco e de linha. O SQL desta migration nao tem
 *  literal contendo `--`, entao a remocao por linha e segura aqui. */
const SQL = BRUTO.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--.*$/gm, "");

/** Só o corpo da funcao, entre os `$$`. Serve as sondas que precisam
 *  distinguir o que a FUNCAO faz do que a migration faz em volta. */
const iAbre = SQL.indexOf("$$");
const iFecha = SQL.lastIndexOf("$$");
const CORPO = iAbre > 0 && iFecha > iAbre ? SQL.slice(iAbre + 2, iFecha) : "";

/** As duas UPDATEs, na ordem em que aparecem. */
const UPDATES = [...CORPO.matchAll(/update\s+public\.skills\b[\s\S]*?;/gi)].map((m) => m[0]);

console.log("\n══ CDS IA — SKILL-1D.f.4-A: RPC de promocao de vigente ══");

// ─── A. O arquivo ─────────────────────────────────────────────────────

secao("A. A migration existe e e legivel sem comentario");

ok("A0  ANCORA: a remocao de comentarios tirou algo",
  SQL.length > 200 && SQL.length < BRUTO.length - 1000);
ok("A1  a migration existe no caminho esperado", existsSync(join(RAIZ, CAMINHO)));
ok("A2  o timestamp nao colide com migration existente",
  readdirSync(join(RAIZ, "supabase/migrations")).filter((f) => f.startsWith("20260924")).length === 1);
ok("A3  ANCORA: o corpo da funcao foi isolado", CORPO.length > 200);
ok("A4  ANCORA: as duas UPDATEs foram extraidas", UPDATES.length === 2);

// ─── B. Assinatura ────────────────────────────────────────────────────

secao("B. Assinatura, retorno e propriedades da funcao");

ok("B1  create or replace, nao create simples",
  /create\s+or\s+replace\s+function\s+public\.promover_skill_vigente/i.test(SQL));
ok("B2  assinatura exata (p_user_id text, p_skill_id uuid)",
  /function\s+public\.promover_skill_vigente\s*\(\s*p_user_id\s+text\s*,\s*p_skill_id\s+uuid\s*\)/i.test(SQL));
ok("B3  RETURNS text", /\)\s*returns\s+text\b/i.test(SQL));
ok("B4  LANGUAGE plpgsql", /language\s+plpgsql/i.test(SQL));
ok("B5  SECURITY INVOKER", /security\s+invoker/i.test(SQL));
ok("B6  zero SECURITY DEFINER", !/security\s+definer/i.test(SQL));
ok("B7  CONTROLE: a sonda de DEFINER acha quando existe",
  /security\s+definer/i.test("language plpgsql security definer set search_path"));
ok("B8  SET search_path = public", /set\s+search_path\s*=\s*public/i.test(SQL));
ok("B9  uma unica funcao — sem overload", (SQL.match(/create\s+or\s+replace\s+function/gi) ?? []).length === 1);
ok("B10 tabela sempre qualificada como public.skills",
  /public\.skills/.test(CORPO) && !/\bfrom\s+skills\b|\bupdate\s+skills\b/i.test(CORPO));
ok("B11 variaveis locais prefixadas com v_",
  /declare[\s\S]*v_slug[\s\S]*v_vigente[\s\S]*v_linhas[\s\S]*begin/i.test(CORPO));

// ─── C. Owner-closure ─────────────────────────────────────────────────

secao("C. Owner-closure e derivacao do slug");

const RESOLUCAO = CORPO.slice(0, CORPO.search(/update\s+public\.skills/i));

ok("C1  o alvo e resolvido por id E user_id juntos",
  /skills\.id\s*=\s*p_skill_id/i.test(RESOLUCAO) && /skills\.user_id\s*=\s*p_user_id/i.test(RESOLUCAO));
ok("C2  slug NAO e parametro da funcao", !/p_slug/i.test(SQL));
ok("C3  CONTROLE: a sonda de p_slug acha quando existe",
  /p_slug/i.test("(p_user_id text, p_slug text)"));
ok("C4  o slug e DERIVADO da linha alvo", /select\s+skills\.slug[\s\S]*into\s+v_slug/i.test(RESOLUCAO));
ok("C5  alvo ausente -> nao_disponivel, antes de qualquer escrita",
  /if\s+not\s+found\s+then[\s\S]{0,80}return\s+'nao_disponivel'/i.test(RESOLUCAO));

// ─── D. Idempotencia ──────────────────────────────────────────────────

secao("D. ja_vigente antes de escrever");

const iJaVigente = CORPO.search(/return\s+'ja_vigente'/i);
const iUpdate1 = CORPO.search(/update\s+public\.skills/i);

ok("D1  existe retorno ja_vigente", iJaVigente > 0);
ok("D2  e ele acontece ANTES da primeira UPDATE", iJaVigente > 0 && iUpdate1 > iJaVigente);
ok("D3  o teste e sobre a coluna vigente do alvo",
  /if\s+v_vigente\s+then/i.test(CORPO));

// ─── E. As duas UPDATEs ───────────────────────────────────────────────

secao("E. Despromocao, promocao e o filtro ausente de proposito");

const [U1, U2] = UPDATES;

ok("E1  exatamente DUAS UPDATEs de public.skills", UPDATES.length === 2);
ok("E2  a primeira despromove (vigente = false)", /set\s+vigente\s*=\s*false/i.test(U1 ?? ""));
ok("E3  a primeira cobre user_id + slug",
  /skills\.user_id\s*=\s*p_user_id/i.test(U1 ?? "") && /skills\.slug\s*=\s*v_slug/i.test(U1 ?? ""));
ok("E4  a primeira NAO filtra por vigente — serializacao deliberada",
  !/\bvigente\s*(=|is)\s*(true|not\s+false)/i.test((U1 ?? "").replace(/set\s+vigente\s*=\s*false/i, "")));
ok("E5  CONTROLE: a sonda do filtro acha quando ele existe",
  /\bvigente\s*(=|is)\s*(true|not\s+false)/i.test("where user_id = x and slug = y and vigente = true;"));
ok("E6  a primeira NAO se restringe ao alvo",
  !/skills\.id\s*=\s*p_skill_id/i.test(U1 ?? ""));

ok("E7  a segunda promove (vigente = true)", /set\s+vigente\s*=\s*true/i.test(U2 ?? ""));
ok("E8  a segunda cobre id + user_id",
  /skills\.id\s*=\s*p_skill_id/i.test(U2 ?? "") && /skills\.user_id\s*=\s*p_user_id/i.test(U2 ?? ""));
ok("E9  a despromocao vem ANTES da promocao — nunca duas vigentes",
  CORPO.indexOf(U1 ?? "") < CORPO.indexOf(U2 ?? ""));

// Nenhuma das duas escreve qualquer coluna alem de `vigente`. Um `set`
// com virgula seria uma segunda atribuicao.
for (const [rot, u] of [["despromocao", U1], ["promocao", U2]] as const) {
  const set = (u ?? "").match(/set\s+[\s\S]*?where/i)?.[0] ?? "";
  ok(`E10 ${rot} altera SOMENTE vigente`, /^set\s+vigente\s*=\s*(true|false)\s+where$/i.test(set.replace(/\s+/g, " ").trim()));
}
ok("E11 CONTROLE: a sonda de coluna extra acha uma segunda atribuicao",
  !/^set\s+vigente\s*=\s*(true|false)\s+where$/i.test("set vigente = true, nome = 'x' where"));

// ─── F. row_count e rollback ──────────────────────────────────────────

secao("F. O alvo que some entre a resolucao e a promocao");

ok("F1  usa GET DIAGNOSTICS / ROW_COUNT", /get\s+diagnostics\s+v_linhas\s*=\s*row_count/i.test(CORPO));
ok("F2  o caminho row_count <> 1 levanta excecao",
  /if\s+v_linhas\s*<>\s*1\s+then[\s\S]{0,160}raise\s+exception/i.test(CORPO));
ok("F3  o RAISE tem SQLSTATE explicito e estavel", /using\s+errcode\s*=\s*'02000'/i.test(CORPO));
ok("F4  o RAISE acontece DEPOIS da primeira UPDATE — e o que desfaz ela",
  CORPO.search(/raise\s+exception/i) > CORPO.indexOf(U1 ?? ""));
ok("F5  a mensagem do RAISE nao carrega id, dono nem slug",
  !/raise\s+exception\s+'[^']*(p_skill_id|p_user_id|v_slug|%)/i.test(CORPO));
// Delimitar ao BLOCO, nao a uma janela de N caracteres: uma janela larga
// alcanca o `return 'promovida'` que vem DEPOIS do `end if`, e a sonda
// acusaria o retorno normal da funcao como se fosse deste caminho.
const BLOCO_ALVO_SUMIU = CORPO.match(/if\s+v_linhas\s*<>\s*1\s+then([\s\S]*?)end\s+if\s*;/i)?.[1] ?? "";
ok("F6  ANCORA: o bloco do row_count foi isolado", /raise\s+exception/i.test(BLOCO_ALVO_SUMIU));
ok("F7  esse caminho NAO retorna normalmente", !/\breturn\b/i.test(BLOCO_ALVO_SUMIU));
ok("F8  CONTROLE: a sonda acha um return dentro do bloco",
  /\breturn\b/i.test(" raise notice 'x'; return 'nao_disponivel'; "));

// ─── G. Vocabulario de retorno ────────────────────────────────────────

secao("G. Retorno fechado, sem dado de Skill");

const retornos = [...CORPO.matchAll(/return\s+'([a-z_]+)'/gi)].map((m) => m[1]);
ok("G1  exatamente 3 retornos literais", retornos.length === 3);
ok("G2  o vocabulario e o fechado da auditoria",
  JSON.stringify([...new Set(retornos)].sort()) ===
    JSON.stringify(["ja_vigente", "nao_disponivel", "promovida"]));
ok("G3  nao ha return de variavel ou expressao", !/return\s+(?!')[a-z_]/i.test(CORPO.replace(/returns\s+text/gi, "")));
ok("G4  o retorno nao devolve dado da Skill",
  !/return\s+(v_slug|p_user_id|p_skill_id|skills\.)/i.test(CORPO));

// ─── H. O que a migration NAO faz ─────────────────────────────────────

secao("H. Zero alteracao de schema, zero lock exotico, zero SQL dinamico");

for (const [rot, re, amostra] of [
  ["ALTER TABLE", /\balter\s+table\b/i, "alter table public.skills add column x int;"],
  ["CREATE TABLE", /\bcreate\s+table\b/i, "create table public.x ();"],
  ["TRIGGER", /\btrigger\b/i, "create trigger t before update on public.skills"],
  ["indice novo", /\bcreate\s+(unique\s+)?index\b/i, "create unique index i on public.skills (id);"],
  ["DROP", /\bdrop\s+(table|index|constraint|column)\b/i, "drop index idx_skills_vigente_por_slug;"],
  ["FOR UPDATE", /\bfor\s+update\b/i, "select 1 from public.skills for update;"],
  ["advisory lock", /pg_advisory/i, "select pg_advisory_xact_lock(1);"],
  ["SQL dinamico", /\bexecute\s+format\s*\(|\bexecute\s+'/i, "execute format('update %I', t);"],
  ["LOCK TABLE", /\block\s+table\b/i, "lock table public.skills in exclusive mode;"],
  ["UPDATE em agente_skills", /update\s+public\.agente_skills/i, "update public.agente_skills set user_id = x;"],
  ["retry/loop", /\bloop\b|\bexception\s+when\b/i, "begin loop end loop; exception when others then"],
] as const) {
  ok(`H1 zero ${rot}`, !re.test(SQL));
  ok(`H2 CONTROLE: a sonda de ${rot} acha na amostra`, re.test(amostra));
}

// ─── I. Privilegios ───────────────────────────────────────────────────

secao("I. REVOKE nominal e EXECUTE so para service_role");

const ASSINATURA = "public\\.promover_skill_vigente\\(text,\\s*uuid\\)";
for (const papel of ["public", "anon", "authenticated", "service_role"]) {
  ok(`I1 REVOKE ALL ... FROM ${papel}, com assinatura completa`,
    new RegExp(`revoke\\s+all\\s+on\\s+function\\s+${ASSINATURA}\\s+from\\s+${papel}\\s*;`, "i").test(SQL));
}
ok("I2  GRANT EXECUTE para service_role, com assinatura completa",
  new RegExp(`grant\\s+execute\\s+on\\s+function\\s+${ASSINATURA}\\s+to\\s+service_role\\s*;`, "i").test(SQL));
ok("I3  um unico GRANT em toda a migration", (SQL.match(/\bgrant\b/gi) ?? []).length === 1);
ok("I4  nenhum GRANT para anon/authenticated/public",
  !/grant[\s\S]{0,120}\bto\s+(anon|authenticated|public)\b/i.test(SQL));
ok("I5  CONTROLE: a sonda de grant indevido acha na amostra",
  /grant[\s\S]{0,120}\bto\s+(anon|authenticated|public)\b/i.test("grant execute on function f(text) to anon;"));
ok("I6  o REVOKE de service_role vem ANTES do GRANT",
  SQL.search(/revoke[\s\S]{0,120}from\s+service_role/i) < SQL.search(/grant\s+execute/i));
ok("I7  zero privilegio novo em tabela — a ACL publicada basta",
  !/\bon\s+table\b/i.test(SQL) && !/grant[\s\S]{0,60}public\.(skills|agente_skills)/i.test(SQL));
ok("I8  CONTROLE: a sonda de grant de tabela acha na amostra",
  /\bon\s+table\b/i.test("grant update (vigente) on table public.skills to service_role;"));

// ─── J. Fronteira temporal ────────────────────────────────────────────

secao("J. A fase seguinte ainda nao comecou");

const ESCRITA = readFileSync(join(RAIZ, "lib/agentes/skills/escrita.ts"), "utf8");
// ── J1..J3 — invertidos pela SKILL-1D.f.4-C ────────────────────────
//
// Os tres eram sentinelas TEMPORAIS: afirmavam que a f.4-C ainda nao
// tinha comecado. Ela comecou, entao passam a exigir o estado novo.
//
// Uma distincao que estes asserts precisam manter: `escrita.ts` chamar a
// RPC NAO e consumidor de producao — e a IMPLEMENTACAO da capability. O
// que continua tendo de ser zero e alguem de fora chamando
// `promoverSkillVigente`. J3 passa a medir exatamente isso, e nao mais a
// mera mencao do nome dentro da propria pasta.
const CODIGO_ESCRITA = ESCRITA.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

// A chamada usa a constante `RPC_PROMOVER`, nao um literal inline. A
// sonda liga as duas pontas: quem e chamado, e quanto vale esse nome —
// e o nome tem de casar com a funcao que ESTA migration cria.
ok("J1  escrita.ts chama a RPC pelo nome exato",
  /\.rpc\(RPC_PROMOVER,/.test(CODIGO_ESCRITA) &&
    /const RPC_PROMOVER = "promover_skill_vigente"/.test(CODIGO_ESCRITA) &&
    /create or replace function public\.promover_skill_vigente/i.test(SQL));
ok("J2  a promocao passa pela RPC, nunca por update direto de vigente",
  (CODIGO_ESCRITA.match(/\.rpc\(/g) ?? []).length === 1 &&
    !/\.update\(\s*\{[^}]*vigente/.test(CODIGO_ESCRITA));
ok("J2a o payload leva so os dois campos de autoridade",
  /p_user_id:\s*userId/.test(CODIGO_ESCRITA) && /p_skill_id:\s*skillId/.test(CODIGO_ESCRITA) &&
    !/p_slug/.test(CODIGO_ESCRITA));
ok("J2b CONTROLE: as sondas acusariam segunda RPC ou update de vigente",
  ('.rpc(a) .rpc(b)'.match(/\.rpc\(/g) ?? []).length === 2 &&
    /\.update\(\s*\{[^}]*vigente/.test('.update({ vigente: true })'));

// Consumidor de producao = uso FORA da pasta que implementa a
// capability. `escrita.ts` esta excluido de proposito.
const consumidoresProd: string[] = [];
const varrerProd = (dir: string): void => {
  for (const e of readdirSync(join(RAIZ, dir), { withFileTypes: true })) {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) {
      if (!/node_modules|\.next/.test(e.name)) varrerProd(rel);
    } else if (/\.tsx?$/.test(e.name) && rel !== "lib/agentes/skills/escrita.ts") {
      if (/promoverSkillVigente/.test(readFileSync(join(RAIZ, rel), "utf8"))) consumidoresProd.push(rel);
    }
  }
};
varrerProd("lib");
varrerProd("app");
ok("J3  zero consumidor de producao de promoverSkillVigente",
  consumidoresProd.length === 0, consumidoresProd.join(", "));
ok("J3a ANCORA: a varredura leu arquivos de verdade",
  existsSync(join(RAIZ, "lib/agentes/skills/fatos.ts")));
ok("J3b CONTROLE: a sonda de consumidor acha quando existe",
  /promoverSkillVigente/.test('await promoverSkillVigente({ userId, skillId })'));
// ── J4 — invertido pela SKILL-1D.f.4-D ─────────────────────────────
//
// Antes afirmava que a suite real de banco NAO existia. A f.4-D existe
// para cria-la, entao a negativa caiu por desenho.
//
// O que NAO se pode afirmar daqui: que `--confirmo` nunca rodou. Fonte
// nao guarda historico de execucao, e um assert estatico que alegasse
// isso estaria mentindo com cara de prova. O que se prova e a forma da
// suite; que ela ainda nao foi EXECUTADA e evidencia do gate, registrada
// no relatorio, nao deste arquivo.
const CAMINHO_BANCO = "scripts/testar-ia-skill-1d-f4-banco.ts";
const SUITE_BANCO = existsSync(join(RAIZ, CAMINHO_BANCO))
  ? readFileSync(join(RAIZ, CAMINHO_BANCO), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "")
  : "";

ok("J4  a suite real de concorrencia EXISTE", SUITE_BANCO.length > 1000);
ok("J4a ela e protegida por --confirmo", /--confirmo/.test(SUITE_BANCO));
ok("J4b env e conexao ficam DEPOIS do gate",
  SUITE_BANCO.indexOf("if (!CONFIRMADO)") > 0 &&
    SUITE_BANCO.indexOf("lerEnv()", SUITE_BANCO.indexOf("if (!CONFIRMADO)")) >
      SUITE_BANCO.indexOf("if (!CONFIRMADO)") &&
    SUITE_BANCO.indexOf("new Client(") > SUITE_BANCO.indexOf("if (!CONFIRMADO)"));
ok("J4c o bloqueio sera observado por catalogo, nao por tempo",
  /pg_blocking_pids\(/.test(SUITE_BANCO) && /pg_stat_activity/.test(SUITE_BANCO));
ok("J4d ha tres sessoes independentes preparadas",
  (SUITE_BANCO.match(/new Client\(/g) ?? []).length >= 3 && /pg_backend_pid\(\)/.test(SUITE_BANCO));
ok("J4e PREPARADO NAO E EXECUTADO: a existencia da suite nao prova " +
   "concorrencia, ausencia de deadlock nem last-writer — isso e da f.4-E",
  /DECLARADO: ausencia de deadlock vale para ESTE cenario/.test(
    readFileSync(join(RAIZ, CAMINHO_BANCO), "utf8")));
ok("J4f CONTROLE: a sonda de gate acharia uma suite sem --confirmo",
  !/--confirmo/.test("const x = 1; await client.connect();"));

console.log(`\n══ ${passou} PASS / ${falhou} FAIL ══\n`);
process.exit(falhou === 0 ? 0 : 1);
