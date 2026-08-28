/**
 * CDS IA — SKILL-1D.f.2. Suite da leitura real de Skills do agente.
 *
 * `estado.ts` e puro e por isso e IMPORTADO e EXECUTADO — a regra que
 * decide o que as linhas significam roda de verdade aqui, incluindo a
 * ordem canonica e o fail-closed.
 *
 * `fatos.ts` e `server-only` (le `skills` e `agente_skills` com
 * service_role) e por isso e provado por leitura de fonte e analise
 * estrutural. Nenhum mock de `server-only` foi inventado — inventar um
 * provaria o mock.
 *
 * Rodar:  npx tsx scripts/testar-ia-skill-1d-f2.ts
 * Sem rede, sem banco, sem IA, sem escrita.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import {
  filtrosAssociacoesDoAgente,
  filtrosSkillsDoDono,
  manifestoValido,
  montarSkills,
  ordenarAssociacoes,
  type Associacao,
  type LinhaAssociacao,
  type LinhaSkill,
} from "../lib/agentes/skills/estado";
import { FORMATO_SUPORTADO, ORIGENS_SKILL } from "../lib/ia/skills/contrato";

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
const semComentarios = (f: string) =>
  f.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

const FONTE_FATOS = ler("lib/agentes/skills/fatos.ts");
const CODIGO_FATOS = semComentarios(FONTE_FATOS);
const FONTE_ESTADO = ler("lib/agentes/skills/estado.ts");
const CODIGO_ESTADO = semComentarios(FONTE_ESTADO);

// ─── Fixtures ─────────────────────────────────────────────────────────

const manifesto = (p: Record<string, unknown> = {}) => ({
  formato: FORMATO_SUPORTADO,
  id: "atendimento-shopee",
  nome: "Atendimento Shopee",
  versao: "1.0.0",
  descricao: "Uma linha.",
  quando_usar: ["cliente pergunta sobre pedido"],
  origem: "importada",
  ...p,
});

const A = (skill_id: unknown, criado_em: unknown): LinhaAssociacao => ({ skill_id, criado_em });
const S = (id: unknown, man: unknown = manifesto(), corpo: unknown = "corpo"): LinhaSkill =>
  ({ id, manifesto: man, corpo });

const T0 = "2026-08-28T00:00:00.000Z";
const T1 = "2026-08-28T01:00:00.000Z";

console.log("\n══ CDS IA — SKILL-1D.f.2: leitura real de Skills do agente ══");

// ─── A. Os dois modulos ───────────────────────────────────────────────

secao("A. Dois modulos, e so a regra e importavel");

ok("A1  estado.ts existe", existe("lib/agentes/skills/estado.ts"));
ok("A2  fatos.ts existe", existe("lib/agentes/skills/fatos.ts"));
// A SKILL-1D.f.3-A acrescentou `escrita.ts`, entao "exatamente 2" virou
// falso POR DESENHO — a mesma inversao ja feita em P1/P2 quando esta fase
// criou a pasta. A sentinela nao e removida: passa a exigir os TRES
// modulos E que o caminho de LEITURA continue sem depender do de escrita,
// que e a fronteira que esta suite existe para defender.
ok("A3  a pasta tem exatamente 3 modulos",
  JSON.stringify(readdirSync(join(RAIZ, "lib/agentes/skills")).sort()) ===
    JSON.stringify(["escrita.ts", "estado.ts", "fatos.ts"]));
ok("A3b escrita.ts existe e E server-only",
  existe("lib/agentes/skills/escrita.ts") &&
    /import "server-only"/.test(ler("lib/agentes/skills/escrita.ts")));
ok("A3c a LEITURA nao importa a escrita",
  !/skills\/escrita/.test(CODIGO_FATOS) && !/skills\/escrita/.test(CODIGO_ESTADO));
ok("A4  estado.ts NAO e server-only (por isso esta suite o executa)",
  !/server-only/.test(CODIGO_ESTADO));
ok("A5  fatos.ts E server-only", /import "server-only"/.test(CODIGO_FATOS));
ok("A6  estado.ts nao le banco nem rede",
  !/createClient|getSupabaseServidor|\bfetch\s*\(/.test(CODIGO_ESTADO));
ok("A7  estado.ts nao loga", !/console\./.test(CODIGO_ESTADO));
ok("A8  CONTROLE: as sondas acusam quando o padrao existe",
  /server-only/.test('import "server-only"') && /console\./.test("console.log(1)"));

// ─── B. Autoridade ────────────────────────────────────────────────────

secao("B. Autoridade e userId + agenteId, nas DUAS queries");

{
  const f1 = filtrosAssociacoesDoAgente("ag-1", "dono-1");
  ok("B1  QUERY 1 carrega agente_id", f1.agente_id === "ag-1");
  ok("B2  QUERY 1 carrega user_id", f1.user_id === "dono-1");
  ok("B3  QUERY 1 tem exatamente duas chaves", Object.keys(f1).length === 2);

  const f2 = filtrosSkillsDoDono("dono-1");
  ok("B4  QUERY 2 carrega user_id", f2.user_id === "dono-1");
  ok("B5  QUERY 2 tem exatamente uma chave", Object.keys(f2).length === 1);

  // A coluna e TEXT; comparar sem normalizar vira recusa silenciosa.
  ok("B6  user_id normalizado com String() na QUERY 1",
    filtrosAssociacoesDoAgente("a", 42 as unknown as string).user_id === "42");
  ok("B7  user_id normalizado com String() na QUERY 2",
    filtrosSkillsDoDono(42 as unknown as string).user_id === "42");

  ok("B8  nenhum id externo nos filtros",
    !Object.keys({ ...f1, ...f2 }).some((k) => /seller|shop|partner|loja|token/i.test(k)));
}

ok("B9  fatos.ts aplica os filtros PUROS, nao copias deles",
  /filtrosAssociacoesDoAgente\(agenteId, userId\)/.test(CODIGO_FATOS) &&
  /filtrosSkillsDoDono\(userId\)/.test(CODIGO_FATOS));
ok("B10 a entrada tem exatamente userId e agenteId",
  /interface EntradaSkillsDoAgente \{\s*userId: string;\s*agenteId: string;\s*\}/
    .test(FONTE_FATOS.replace(/\/\*[\s\S]*?\*\//g, "")));
ok("B11 a entrada NAO aceita skillId, slug nem loja",
  !/skillId\s*:|slug\s*:|lojaId\s*:/.test(CODIGO_FATOS.split("export async function")[0]));

// ─── C. Ordem canonica ────────────────────────────────────────────────

secao("C. Ordem: criado_em ASC, desempate por skill_id ASC");

{
  ok("C1  zero associacoes -> lista vazia",
    ordenarAssociacoes([])?.length === 0);

  const r = ordenarAssociacoes([A("b", T1), A("a", T0)]);
  ok("C2  ordena por criado_em ASC", r?.[0].skillId === "a" && r?.[1].skillId === "b");

  // `criado_em` tem default now(), e now() e transaction_timestamp():
  // CONSTANTE dentro de uma transacao. Associar varias de uma vez produz
  // timestamps IDENTICOS — sem o desempate a ordem ficaria indefinida
  // exatamente no caso mais provavel.
  const emp = ordenarAssociacoes([A("c", T0), A("a", T0), A("b", T0)]);
  ok("C3  EMPATE de criado_em -> desempata por skill_id ASC",
    JSON.stringify(emp?.map((x) => x.skillId)) === JSON.stringify(["a", "b", "c"]));

  const inv = ordenarAssociacoes([A("z", T0), A("y", T0)]);
  ok("C4  o desempate independe da ordem de entrada",
    JSON.stringify(inv?.map((x) => x.skillId)) === JSON.stringify(["y", "z"]));

  ok("C5  a lista devolvida e congelada", Object.isFrozen(ordenarAssociacoes([A("a", T0)])));
  ok("C6  nao muta a entrada", (() => {
    const entrada = [A("b", T1), A("a", T0)];
    ordenarAssociacoes(entrada);
    return entrada[0].skill_id === "b";
  })());
}

secao("C-b. Associacao invalida derruba a coleta");

for (const [rot, l] of [
  ["skill_id nao-string", A(7, T0)],
  ["skill_id vazio", A("", T0)],
  ["skill_id nulo", A(null, T0)],
  ["criado_em nao-string", A("a", 7)],
  ["criado_em vazio", A("a", "")],
] as const) {
  ok(`C  ${rot} -> null`, ordenarAssociacoes([l]) === null);
}
ok("C12 skill_id REPETIDO -> null (mapa ambiguo)",
  ordenarAssociacoes([A("a", T0), A("a", T1)]) === null);
ok("C13 CONTROLE: uma associacao valida NAO devolve null",
  ordenarAssociacoes([A("a", T0)]) !== null);

// ─── D. Validacao do manifesto ────────────────────────────────────────

secao("D. Manifesto: obrigatorios sempre, opcionais quando presentes");

ok("D1  manifesto completo e valido", manifestoValido(manifesto()));

for (const campo of ["formato", "id", "nome", "versao", "descricao", "quando_usar", "origem"]) {
  const m = manifesto();
  delete (m as Record<string, unknown>)[campo];
  ok(`D  sem \`${campo}\` -> invalido`, !manifestoValido(m));
}

ok("D9  formato != FORMATO_SUPORTADO -> invalido",
  !manifestoValido(manifesto({ formato: 2 })));
ok("D10 formato como string -> invalido", !manifestoValido(manifesto({ formato: "1" })));
ok("D11 origem fora de ORIGENS_SKILL -> invalido",
  !manifestoValido(manifesto({ origem: "pirata" })));
for (const o of ORIGENS_SKILL) {
  ok(`D  origem '${o}' e aceita`, manifestoValido(manifesto({ origem: o })));
}
ok("D15 quando_usar VAZIO -> invalido (chave ausente, nunca [])",
  !manifestoValido(manifesto({ quando_usar: [] })));
ok("D16 quando_usar com nao-string -> invalido",
  !manifestoValido(manifesto({ quando_usar: [1] })));
ok("D17 manifesto array -> invalido", !manifestoValido([]));
ok("D18 manifesto null -> invalido", !manifestoValido(null));
ok("D19 manifesto string -> invalido", !manifestoValido("x"));

secao("D-b. Opcionais: so validados quando a chave existe");

ok("D20 sem requer/fichas/verificacao continua valido", manifestoValido(manifesto()));
ok("D21 requer valido", manifestoValido(manifesto({ requer: { funcoes: ["vendas.consultar"] } })));
ok("D22 requer VAZIO -> invalido", !manifestoValido(manifesto({ requer: { funcoes: [] } })));
ok("D23 requer.conexoes valido",
  manifestoValido(manifesto({
    requer: { conexoes: [{ plataforma: "shopee", recurso: "chat", obrigatoria: true }] },
  })));
ok("D24 conexao sem `obrigatoria` -> invalido",
  !manifestoValido(manifesto({ requer: { conexoes: [{ plataforma: "s", recurso: "c" }] } })));
ok("D25 conexoes VAZIO -> invalido", !manifestoValido(manifesto({ requer: { conexoes: [] } })));
ok("D26 fichas valido", manifestoValido(manifesto({ fichas: ["shopee-chat"] })));
ok("D27 fichas VAZIO -> invalido", !manifestoValido(manifesto({ fichas: [] })));
ok("D28 verificacao valida",
  manifestoValido(manifesto({ verificacao: { em: "2026-08-28", fontes: ["https://x"] } })));
ok("D29 verificacao com fontes VAZIO -> invalido (afirmacao sem lastro)",
  !manifestoValido(manifesto({ verificacao: { em: "2026-08-28", fontes: [] } })));
ok("D30 verificacao sem `em` -> invalido",
  !manifestoValido(manifesto({ verificacao: { fontes: ["https://x"] } })));

// ─── E. Montagem e reconstrucao ───────────────────────────────────────

secao("E. A ordem da QUERY 2 nao e autoridade");

{
  const assoc = ordenarAssociacoes([A("s1", T0), A("s2", T1)]) as readonly Associacao[];

  // QUERY 2 devolve na ORDEM INVERSA de proposito: `.in(ids)` nao promete
  // ordem, e a reconstrucao tem de seguir a QUERY 1.
  const skills = montarSkills(assoc, [
    S("s2", manifesto({ id: "segunda" })),
    S("s1", manifesto({ id: "primeira" })),
  ]);
  ok("E1  duas Skills montadas", skills?.length === 2);
  ok("E2  a ordem segue a QUERY 1, nao a QUERY 2",
    skills?.[0].manifesto.id === "primeira" && skills?.[1].manifesto.id === "segunda");
  ok("E3  o retorno tem SOMENTE manifesto e corpo",
    JSON.stringify(Object.keys(skills?.[0] ?? {}).sort()) === JSON.stringify(["corpo", "manifesto"]));
  ok("E4  nao vaza id, user_id, conteudo_hash, vigente nem criado_em",
    !("id" in (skills?.[0] as object)) && !("user_id" in (skills?.[0] as object)) &&
    !("conteudo_hash" in (skills?.[0] as object)) && !("vigente" in (skills?.[0] as object)) &&
    !("criado_em" in (skills?.[0] as object)));
  ok("E5  cada Skill e congelada", Object.isFrozen(skills?.[0]));
  ok("E6  a colecao e congelada", Object.isFrozen(skills));

  ok("E7  zero associacoes -> zero Skills", montarSkills([], [])?.length === 0);
  ok("E8  uma associacao -> uma Skill",
    montarSkills(ordenarAssociacoes([A("s1", T0)]) as readonly Associacao[], [S("s1")])?.length === 1);
}

secao("E-b. Fail-closed: nunca resultado parcial");

{
  const um = ordenarAssociacoes([A("s1", T0)]) as readonly Associacao[];
  const dois = ordenarAssociacoes([A("s1", T0), A("s2", T1)]) as readonly Associacao[];

  ok("E9  Skill FALTANTE para a associacao -> null",
    montarSkills(dois, [S("s1")]) === null);
  ok("E10 manifesto invalido -> null (colecao inteira)",
    montarSkills(um, [S("s1", manifesto({ quando_usar: [] }))]) === null);
  ok("E11 corpo nao-string -> null", montarSkills(um, [S("s1", manifesto(), 7)]) === null);
  // Sem o helper: `S(..., undefined)` cairia no DEFAULT do parametro e o
  // teste provaria o contrario do que diz. Objeto literal, sem a chave.
  ok("E12 corpo AUSENTE -> null",
    montarSkills(um, [{ id: "s1", manifesto: manifesto() } as LinhaSkill]) === null);
  ok("E12b CONTROLE: o helper aplicaria o default e mascararia o teste",
    S("s1", manifesto(), undefined).corpo === "corpo");
  ok("E13 id nao-string -> null", montarSkills(um, [S(7)]) === null);
  ok("E14 id REPETIDO -> null (mapa ambiguo)",
    montarSkills(um, [S("s1"), S("s1")]) === null);
  ok("E15 corpo VAZIO e valido — Skill pode nao ter corpo",
    montarSkills(um, [S("s1", manifesto(), "")])?.length === 1);
  ok("E16 uma Skill invalida entre duas validas derruba TUDO",
    montarSkills(dois, [S("s1"), S("s2", manifesto({ id: 7 }))]) === null);
  ok("E17 CONTROLE: as mesmas linhas validas NAO devolvem null",
    montarSkills(dois, [S("s1"), S("s2")]) !== null);
  ok("E18 Skill extra na QUERY 2 e ignorada (nao entra na saida)",
    montarSkills(um, [S("s1"), S("s9")])?.length === 1);
}

// ─── F. Contrato publico de fatos.ts ──────────────────────────────────

secao("F. Envelope de coleta com tres valores");

ok("F1  ColetaSkills tem exatamente os tres valores",
  /export type ColetaSkills = "ok" \| "falha_leitura" \| "entrada_invalida";/.test(CODIGO_FATOS));
ok("F2  o resultado carrega skills e coleta",
  /interface ResultadoSkillsDoAgente \{\s*skills: readonly Skill\[\];\s*coleta: ColetaSkills;\s*\}/
    .test(FONTE_FATOS.replace(/\/\*[\s\S]*?\*\//g, "")));
ok("F3  NAO expoe `descartadas`, warnings nem diagnostico",
  !/descartadas|warnings|diagnostico|pendencia/i.test(CODIGO_FATOS));
ok("F4  as tres constantes de retorno existem",
  /const VAZIO/.test(CODIGO_FATOS) && /const ENTRADA_INVALIDA/.test(CODIGO_FATOS) &&
  /const FALHA/.test(CODIGO_FATOS));
ok("F5  nenhuma delas concede Skill",
  (CODIGO_FATOS.match(/skills: Object\.freeze\(\[\]\)/g) ?? []).length === 3);

secao("F-b. Entrada invalida NAO toca o banco");

ok("F6  guarda de autoridade devolve ENTRADA_INVALIDA",
  /if \(!userId \|\| !agenteId\) return ENTRADA_INVALIDA;/.test(CODIGO_FATOS));
{
  const iGuarda = CODIGO_FATOS.indexOf("return ENTRADA_INVALIDA;");
  const iQ1 = CODIGO_FATOS.indexOf('.from("agente_skills")');
  const iQ2 = CODIGO_FATOS.indexOf('.from("skills")');
  ok("F7  o guarda vem ANTES da QUERY 1", iGuarda > 0 && iQ1 > 0 && iGuarda < iQ1);
  ok("F8  e antes da QUERY 2", iGuarda > 0 && iQ2 > 0 && iGuarda < iQ2);
  ok("F9  CONTROLE: a sonda de ordem acusaria inversao", "abc".indexOf("a") < "abc".indexOf("c"));
}
ok("F10 sem associacao, a QUERY 2 nao roda",
  /if \(associacoes\.length === 0\) return VAZIO;/.test(CODIGO_FATOS));
{
  const iVazio = CODIGO_FATOS.indexOf("return VAZIO;");
  const iQ2 = CODIGO_FATOS.indexOf('.from("skills")');
  ok("F11 o retorno vazio precede a QUERY 2 no fonte", iVazio > 0 && iQ2 > 0 && iVazio < iQ2);
}

// ─── G. Queries ───────────────────────────────────────────────────────

secao("G. Duas queries em lote, zero N+1");

ok("G1  QUERY 1 projeta skill_id, criado_em",
  /const COLUNAS_ASSOCIACAO = "skill_id, criado_em"/.test(CODIGO_FATOS));
ok("G2  QUERY 2 projeta id, manifesto, corpo",
  /const COLUNAS_SKILL = "id, manifesto, corpo"/.test(CODIGO_FATOS));
ok("G3  QUERY 1 le agente_skills", /\.from\("agente_skills"\)/.test(CODIGO_FATOS));
ok("G4  QUERY 2 le skills", /\.from\("skills"\)/.test(CODIGO_FATOS));
ok("G5  exatamente DUAS operacoes de leitura",
  (CODIGO_FATOS.match(/\.from\(/g) ?? []).length === 2);
ok("G6  QUERY 2 e em LOTE, com .in(\"id\")", /\.in\("id",/.test(CODIGO_FATOS));
ok("G7  ordenacao no SQL: criado_em depois skill_id",
  /\.order\("criado_em", \{ ascending: true \}\)\s*\.order\("skill_id", \{ ascending: true \}\)/
    .test(CODIGO_FATOS.replace(/\s+/g, " ").replace(/ \./g, "\n.")) ||
  /order\("criado_em"[\s\S]{0,60}order\("skill_id"/.test(CODIGO_FATOS));
ok("G8  NAO projeta timestamps nem hash em skills",
  !/conteudo_hash|vigente/.test(CODIGO_FATOS.replace(/COLUNAS_\w+/g, "")));
ok("G9  sem .single() nem .maybeSingle()",
  !/\.single\(|\.maybeSingle\(/.test(CODIGO_FATOS));
ok("G10 CONTROLE: a sonda de N+1 conta o numero real de leituras",
  ("a.from(1) b.from(2)".match(/\.from\(/g) ?? []).length === 2);

// ─── H. Fronteiras ────────────────────────────────────────────────────

secao("H. Zero escrita, zero segredo, zero vigente, zero parser");

for (const [nome, re] of [
  ["insert", /\.insert\(/], ["update", /\.update\(/], ["delete", /\.delete\(/],
  ["upsert", /\.upsert\(/], ["rpc", /\.rpc\(/],
] as const) {
  ok(`H  fatos.ts nao usa .${nome}()`, !re.test(CODIGO_FATOS));
}
ok("H6  estado.ts tambem nao escreve",
  !/\.insert\(|\.update\(|\.delete\(|\.upsert\(|\.rpc\(/.test(CODIGO_ESTADO));
ok("H7  CONTROLE: a sonda de escrita acha quando existe", /\.insert\(/.test("x.insert({})"));

ok("H8  NAO filtra por `vigente`", !/eq\("vigente"|vigente\s*[=,]/.test(CODIGO_FATOS));
ok("H9  NAO resolve por slug nem versao",
  !/\.eq\("slug"|\.eq\("versao"|order\("versao"/.test(CODIGO_FATOS));
ok("H10 NAO reutiliza o parser de importacao",
  !/importarSkill|cds-skill|acharSegredos|extrairBloco/.test(CODIGO_FATOS + CODIGO_ESTADO));
ok("H11 NAO faz cast cego do manifesto",
  !/manifesto as ManifestoSkill|as ManifestoSkill/.test(CODIGO_ESTADO));

for (const [nome, re] of [
  ["access_token", /access_token/], ["refresh_token", /refresh_token/],
  ["partner_key", /partner_key/], ["seller_id", /seller_id/], ["shop_id", /shop_id/],
  ["DATABASE_URL", /DATABASE_URL/], ["SERVICE_ROLE_KEY", /SERVICE_ROLE_KEY/],
] as const) {
  ok(`H  nenhum ${nome} nos dois modulos`, !re.test(CODIGO_FATOS + CODIGO_ESTADO));
}
ok("H19 o log nunca usa error.message", !/error\.message|\.message\b/.test(CODIGO_FATOS));
ok("H20 o log nunca imprime corpo nem manifesto",
  !/console\.error\([^)]*\b(corpo|manifesto)\b/.test(CODIGO_FATOS));
ok("H21 CONTROLE: as sondas de segredo acham quando existe",
  /access_token/.test("x.access_token") && /DATABASE_URL/.test("DATABASE_URL=1"));

// ─── I. Multiplas Skills, sem agregacao ───────────────────────────────

secao("I. Retorna TODAS — a agregacao e de outra fase");

{
  const tres = ordenarAssociacoes([A("s1", T0), A("s2", T1), A("s3", T1)]) as readonly Associacao[];
  const skills = montarSkills(tres, [S("s1"), S("s2"), S("s3")]);
  ok("I1  tres associacoes -> tres Skills", skills?.length === 3);
  ok("I2  nenhuma foi eleita principal nem descartada", skills?.length === tres.length);
}
ok("I3  nao mescla manifestos", !/merge|mesclar|unir|combinar/i.test(CODIGO_ESTADO + CODIGO_FATOS));
ok("I4  nao aplica `obrigatoria vence opcional`",
  !/obrigatoria\s*(vence|>|\|\|)/i.test(CODIGO_ESTADO));
ok("I5  nao decide Skill principal", !/principal|primaria/i.test(CODIGO_ESTADO + CODIGO_FATOS));

// ─── J. Fronteira desta fase ──────────────────────────────────────────

secao("J. Zero consumidor de producao");

ok("J1  diagnostico.ts nao foi tocado",
  !/agente_skills|resolverSkillsDoAgente/.test(ler("lib/ia/skills/diagnostico.ts")));
ok("J2  lib/ia/skills continua com 3 modulos",
  readdirSync(join(RAIZ, "lib/ia/skills")).length === 3);
ok("J3  lib/agentes/permissoes intocada — 2 modulos",
  readdirSync(join(RAIZ, "lib/agentes/permissoes")).length === 2);
// O par `selecao-*` e da 1D.g.1-C e `selecao-escrita` e da 1D.g.2-B. Esta
// fase continua provando o que lhe cabe — que a leitura de Skills nao
// criou modulo em conexoes — e pelo conjunto nominal, que nao afrouxa
// quando o total muda.
ok("J4  lib/agentes/conexoes com o conjunto exato de 5 modulos — nenhum e da 1D.f.2",
  JSON.stringify(readdirSync(join(RAIZ, "lib/agentes/conexoes")).sort()) ===
    JSON.stringify(["estado.ts", "fatos.ts", "selecao-escrita.ts", "selecao-estado.ts", "selecao-fatos.ts"]),
  readdirSync(join(RAIZ, "lib/agentes/conexoes")).sort().join(", "));
ok("J5  nenhum modulo novo importa React ou UI",
  !/from "react"|components\//.test(CODIGO_ESTADO + CODIGO_FATOS));
{
  // A fonte real ainda nao tem consumidor: `resolverSkillsDoAgente` nao e
  // chamada por producao nenhuma. Registrado como fato, nao escondido.
  const chamadores = ["lib", "app"].flatMap((raiz) => {
    const varrer = (dir: string): string[] => {
      const saida: string[] = [];
      for (const nome of readdirSync(join(RAIZ, dir), { withFileTypes: true })) {
        const rel = `${dir}/${nome.name}`;
        if (nome.isDirectory()) saida.push(...varrer(rel));
        else if (/\.tsx?$/.test(nome.name) && rel !== "lib/agentes/skills/fatos.ts") {
          if (/resolverSkillsDoAgente/.test(ler(rel))) saida.push(rel);
        }
      }
      return saida;
    };
    return varrer(raiz);
  });
  ok(`J6  zero consumidor de producao nesta fase (${chamadores.join(", ") || "nenhum"})`,
    chamadores.length === 0);
}

// ─── Placar ───────────────────────────────────────────────────────────

console.log(`\n${"═".repeat(66)}`);
console.log(`  ${passou}/${passou + falhou} passaram` + (falhou > 0 ? `  ·  ${falhou} FALHARAM` : ""));
console.log(`${"═".repeat(66)}\n`);
process.exit(falhou > 0 ? 1 : 0);
