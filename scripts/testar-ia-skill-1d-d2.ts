/**
 * CDS IA — SKILL-1D.d.2. Suite da fonte real de `FatoPermissao`.
 *
 * `estado.ts` e puro e por isso e IMPORTADO e EXECUTADO — a regra que
 * decide o que uma linha significa roda de verdade aqui, e o resultado
 * dela e alimentado ao motor da SKILL-1C, tambem puro. O caminho
 * completo "linha crua -> fato -> diagnostico" e exercitado sem banco.
 *
 * `fatos.ts` e `server-only` (le `agente_permissoes` com service_role) e
 * por isso e provado por leitura de fonte e analise estrutural. Nenhum
 * mock de `server-only` foi inventado — inventar um provaria o mock.
 *
 * Rodar:  npx tsx scripts/testar-ia-skill-1d-d2.ts
 * Sem rede, sem banco, sem IA, sem escrita.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import {
  filtrosPermissoesDoAgente,
  montarFatosPermissoes,
  nivelValido,
  normalizarFuncaoIds,
  type LinhaPermissao,
} from "../lib/agentes/permissoes/estado";
import { diagnosticarSkill, type EntradaDiagnostico } from "../lib/ia/skills/diagnostico";
import { NIVEIS_AUTONOMIA } from "../lib/ia/conceitos";

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

const FONTE_FATOS = ler("lib/agentes/permissoes/fatos.ts");
const CODIGO_FATOS = semComentarios(FONTE_FATOS);
const FONTE_ESTADO = ler("lib/agentes/permissoes/estado.ts");
const CODIGO_ESTADO = semComentarios(FONTE_ESTADO);

// ─── Fixtures ─────────────────────────────────────────────────────────

const L = (funcao_id: unknown, nivel: unknown): LinhaPermissao => ({ funcao_id, nivel });

const entrada = (p: Partial<EntradaDiagnostico> = {}): EntradaDiagnostico => ({
  skill: { id: "skill-de-teste", requer: { funcoes: ["vendas.consultar"] } },
  funcoes: [{ id: "vendas.consultar", existe: true }],
  permissoes: [],
  conexoes: [],
  ...p,
});

/** O caminho completo: linhas cruas -> regra pura -> motor. */
const diagnosticarComLinhas = (linhas: readonly LinhaPermissao[], p: Partial<EntradaDiagnostico> = {}) =>
  diagnosticarSkill(entrada({ permissoes: montarFatosPermissoes(linhas), ...p }));

console.log("\n══ CDS IA — SKILL-1D.d.2: fonte real de FatoPermissao ══");

// ─── A. Os dois modulos ───────────────────────────────────────────────

secao("A. Dois modulos, e so a regra e importavel");

ok("A1  estado.ts existe", existe("lib/agentes/permissoes/estado.ts"));
ok("A2  fatos.ts existe", existe("lib/agentes/permissoes/fatos.ts"));
ok("A3  a pasta tem exatamente 2 modulos",
  JSON.stringify(readdirSync(join(RAIZ, "lib/agentes/permissoes")).sort()) ===
    JSON.stringify(["estado.ts", "fatos.ts"]));
ok("A4  estado.ts NAO e server-only (por isso esta suite o executa)",
  !/server-only/.test(CODIGO_ESTADO));
ok("A5  fatos.ts E server-only", /import "server-only"/.test(CODIGO_FATOS));
ok("A6  a regra nao vive em lib/ia/skills", !existe("lib/ia/skills/permissoes.ts"));
ok("A7  estado.ts nao le banco nem rede",
  !/createClient|getSupabaseServidor|\bfetch\s*\(/.test(CODIGO_ESTADO));
ok("A8  CONTROLE: as sondas acusam quando o padrao existe",
  /server-only/.test('import "server-only"') && /getSupabaseServidor/.test("getSupabaseServidor()"));

// ─── B. Autoridade ────────────────────────────────────────────────────

secao("B. Autoridade e agente_id + user_id, sempre");

{
  const f = filtrosPermissoesDoAgente("ag-1", "dono-1");
  ok("B1  o filtro carrega agente_id", f.agente_id === "ag-1");
  ok("B2  o filtro carrega user_id", f.user_id === "dono-1");
  ok("B3  exatamente duas chaves, nada a mais", Object.keys(f).length === 2);

  // A coluna e TEXT; comparar sem normalizar vira recusa silenciosa por
  // tipo, que aqui se pareceria com "este agente nao tem permissao".
  const g = filtrosPermissoesDoAgente("ag-1", 42 as unknown as string);
  ok("B4  user_id e normalizado com String()", g.user_id === "42" && typeof g.user_id === "string");

  ok("B5  nenhum id externo no filtro",
    !Object.keys(f).some((k) => /seller|shop|partner|token/i.test(k)));
}

ok("B6  fatos.ts aplica o filtro PURO, nao uma copia dele",
  /filtrosPermissoesDoAgente\(agenteId, userId\)/.test(CODIGO_FATOS));
ok("B7  o filtro chega a consulta via aplicarFiltros", /aplicarFiltros\(/.test(CODIGO_FATOS));
ok("B8  a entrada declara userId e agenteId como contexto",
  /userId:\s*string/.test(CODIGO_FATOS) && /agenteId:\s*string/.test(CODIGO_FATOS));
ok("B9  a entrada NAO aceita id externo como autoridade",
  !/seller_id|shop_id|partner_id|partner_key|access_token/.test(CODIGO_FATOS));

// ─── C. Consulta e projecao ───────────────────────────────────────────

secao("C. Projecao minima, e nada alem");

ok("C1  projeta exatamente funcao_id e nivel",
  /const COLUNAS = "funcao_id, nivel"/.test(CODIGO_FATOS));
ok("C2  NAO projeta timestamps", !/criado_em|alterado_em/.test(CODIGO_FATOS));
ok("C3  le a tabela certa", /\.from\("agente_permissoes"\)/.test(CODIGO_FATOS));
ok("C4  limita ao conjunto pedido com .in(\"funcao_id\")",
  /\.in\("funcao_id"/.test(CODIGO_FATOS));
ok("C5  uma unica consulta — nao ha N+1", (CODIGO_FATOS.match(/\.from\(/g) ?? []).length === 1);
ok("C6  CONTROLE: a sonda de timestamp acha quando existe",
  /criado_em|alterado_em/.test("select criado_em"));

// ─── D. Zero escrita ──────────────────────────────────────────────────

secao("D. Fase READ-ONLY");

for (const [nome, re] of [
  ["insert", /\.insert\(/], ["update", /\.update\(/], ["delete", /\.delete\(/],
  ["upsert", /\.upsert\(/], ["rpc", /\.rpc\(/],
] as const) {
  ok(`D  fatos.ts nao usa .${nome}()`, !re.test(CODIGO_FATOS));
}
ok("D6  estado.ts tambem nao escreve",
  !/\.insert\(|\.update\(|\.delete\(|\.upsert\(|\.rpc\(/.test(CODIGO_ESTADO));
ok("D7  CONTROLE: a sonda de escrita acha quando existe", /\.insert\(/.test('x.insert({})'));
ok("D8  nao ha write path: conceder permissao nao existe nesta fase",
  !/definirPermissao|concederPermissao|revogarPermissao/.test(CODIGO_FATOS + CODIGO_ESTADO));

// ─── E. Niveis validos ────────────────────────────────────────────────

secao("E. Nivel vem de NIVEIS_AUTONOMIA, nao de string solta");

for (const n of NIVEIS_AUTONOMIA) ok(`E  '${n}' e nivel valido`, nivelValido(n));
for (const v of ["livre", "BLOQUEADO", "", null, undefined, 0, {}, ["bloqueado"]]) {
  ok(`E  ${JSON.stringify(v) ?? String(v)} NAO e nivel valido`, !nivelValido(v));
}

// ─── F. Montagem: linha valida ────────────────────────────────────────

secao("F. Linha valida vira fato");

{
  const fatos = montarFatosPermissoes([L("vendas.consultar", "automatico")]);
  ok("F1  uma linha valida produz um fato", fatos.length === 1);
  ok("F2  o fato carrega funcaoId e nivel",
    fatos[0].funcaoId === "vendas.consultar" && fatos[0].nivel === "automatico");
  ok("F3  o fato tem exatamente dois campos", Object.keys(fatos[0]).length === 2);
  ok("F4  sem procedencia — esse campo e da UI, nao do motor",
    !("procedencia" in (fatos[0] as unknown as Record<string, unknown>)));
  ok("F5  a lista devolvida e congelada", Object.isFrozen(fatos));
}

// ─── G. Nivel invalido NUNCA promove autonomia ────────────────────────

secao("G. Dado corrompido nao vira permissao");

for (const ruim of ["livre", "AUTOMATICO", "", null, 7, undefined]) {
  const fatos = montarFatosPermissoes([L("vendas.consultar", ruim)]);
  ok(`G  nivel ${JSON.stringify(ruim) ?? String(ruim)} -> linha descartada`, fatos.length === 0);
}
{
  // O ponto inteiro da regra: o pior desfecho possivel e "bloqueado".
  const d = diagnosticarComLinhas([L("vendas.consultar", "livre")]);
  ok("G7  nivel invalido chega ao motor como BLOQUEADO_POR_PERMISSAO",
    d.estadoGeral === "BLOQUEADO_POR_PERMISSAO");
  ok("G8  e a Funcao NAO fica utilizavel", d.funcoesUtilizaveis.length === 0);
}
{
  const fatos = montarFatosPermissoes([L("", "automatico"), L(null, "automatico"), L(7, "bloqueado")]);
  ok("G9  funcao_id vazio ou nao-string tambem e descartado", fatos.length === 0);
}

// ─── H. Ausencia ──────────────────────────────────────────────────────

secao("H. Ausencia nao vira fato — o motor e quem interpreta");

{
  const fatos = montarFatosPermissoes([]);
  ok("H1  zero linhas -> zero fatos", fatos.length === 0);

  const d = diagnosticarComLinhas([]);
  ok("H2  ausencia -> BLOQUEADO_POR_PERMISSAO pelo motor",
    d.estadoGeral === "BLOQUEADO_POR_PERMISSAO");
  ok("H3  e bloqueia de fato", d.pronto === false && d.bloqueios.length === 1);

  ok("H4  a regra NAO emite 'bloqueado' explicito para ausencia",
    !/nivel:\s*"bloqueado"/.test(CODIGO_ESTADO));
  ok("H5  quem aplica o padrao seguro continua sendo o diagnostico",
    /\?\?\s*"bloqueado"/.test(ler("lib/ia/skills/diagnostico.ts")));
}

// ─── I. Os tres niveis, pelo motor ────────────────────────────────────

secao("I. Os tres niveis atravessam ate o diagnostico");

{
  const b = diagnosticarComLinhas([L("vendas.consultar", "bloqueado")]);
  ok("I1  bloqueado -> BLOQUEADO_POR_PERMISSAO", b.estadoGeral === "BLOQUEADO_POR_PERMISSAO");
  ok("I2  bloqueado impede o uso", b.funcoesUtilizaveis.length === 0);

  const a = diagnosticarComLinhas([L("vendas.consultar", "aprovacao")]);
  ok("I3  aprovacao -> REQUER_APROVACAO", a.estadoGeral === "REQUER_APROVACAO");
  ok("I4  aprovacao NAO bloqueia", a.pronto === true && a.bloqueios.length === 0);
  ok("I5  aprovacao mantem a Funcao utilizavel",
    a.funcoesUtilizaveis.includes("vendas.consultar"));

  const t = diagnosticarComLinhas([L("vendas.consultar", "automatico")]);
  ok("I6  automatico -> PRONTO", t.estadoGeral === "PRONTO");
  ok("I7  automatico nao gera pendencia",
    t.bloqueios.length === 0 && t.limitacoes.length === 0);
}

// ─── J. Precedencia: existencia antes de permissao ────────────────────

secao("J. FALTA_FUNCAO continua vindo antes");

{
  const d = diagnosticarComLinhas([L("vendas.consultar", "bloqueado")], {
    funcoes: [{ id: "vendas.consultar", existe: false }],
  });
  ok("J1  Funcao inexistente + bloqueada -> FALTA_FUNCAO", d.estadoGeral === "FALTA_FUNCAO");
  ok("J2  nao manda o dono mexer em permissao de coisa que nao existe",
    !d.bloqueios.some((p) => p.estado === "BLOQUEADO_POR_PERMISSAO"));

  // Formato valido nao e existencia: `foo.bar.inventado` passa no CHECK
  // do banco e pode ter linha; quem decide existencia e o registry.
  const e = diagnosticarComLinhas([L("foo.bar.inventado", "automatico")], {
    skill: { id: "s", requer: { funcoes: ["foo.bar.inventado"] } },
    funcoes: [{ id: "foo.bar.inventado", existe: false }],
  });
  ok("J3  formato valido != Funcao existente", e.estadoGeral === "FALTA_FUNCAO");
  ok("J4  o fato foi montado assim mesmo — a permissao nao filtra existencia",
    montarFatosPermissoes([L("foo.bar.inventado", "automatico")]).length === 1);
}

ok("J5  o resolvedor NAO consulta o registry",
  !/funcaoExiste|resolverFuncao|funcoes\/registry/.test(CODIGO_FATOS + CODIGO_ESTADO));

// ─── K. Entrada vazia, invalida e duplicada ───────────────────────────

secao("K. Entrada degenerada nao concede nada e nao consulta");

{
  ok("K1  lista vazia -> conjunto vazio", normalizarFuncaoIds([]).length === 0);
  ok("K2  duplicatas colapsam",
    JSON.stringify(normalizarFuncaoIds(["a.b", "a.b", "a.b"])) === JSON.stringify(["a.b"]));
  ok("K3  ordem e estavel — a do chamador nao decide",
    JSON.stringify(normalizarFuncaoIds(["c.d", "a.b"])) ===
      JSON.stringify(normalizarFuncaoIds(["a.b", "c.d"])));
  ok("K4  nao-strings e vazios caem fora",
    normalizarFuncaoIds(["", null, 3, {}, "a.b"] as unknown[]).length === 1);
  ok("K5  o conjunto devolvido e congelado", Object.isFrozen(normalizarFuncaoIds(["a.b"])));

  // Duplicata na SAIDA tambem nao passa: `nivelDe()` resolve por
  // `.find()`, ou seja pela ordem — decisao que nao pode depender de sorte.
  const dup = montarFatosPermissoes([
    L("vendas.consultar", "bloqueado"),
    L("vendas.consultar", "automatico"),
  ]);
  ok("K6  funcao_id repetido produz UM fato", dup.length === 1);
  ok("K7  e vence o primeiro, deterministicamente", dup[0].nivel === "bloqueado");
}

// `resolverFatosPermissoes` e `server-only` e nao pode ser importado
// aqui — inventar um mock de Supabase provaria o mock. Os asserts abaixo
// sao ESTRUTURAIS, sobre o fonte real, e cada um mede uma propriedade
// que o codigo ou tem ou nao tem.

ok("K8  userId/agenteId vazio -> ENTRADA_INVALIDA (autoridade primeiro)",
  /if \(!userId \|\| !agenteId\) return ENTRADA_INVALIDA;/.test(CODIGO_FATOS));
ok("K9  funcaoIds vazio -> VAZIO, que e coleta 'ok'",
  /if \(ids\.length === 0\) return VAZIO;/.test(CODIGO_FATOS));
ok("K10 os dois casos NAO compartilham o mesmo retorno",
  !/!userId \|\| !agenteId \|\| ids\.length === 0/.test(CODIGO_FATOS));

{
  // Anti-vacuidade: os DOIS retornos antecipados tem de vir ANTES do
  // `.from(`. E onde "nao consulta o banco" deixa de ser promessa.
  const iAutoridade = CODIGO_FATOS.indexOf("return ENTRADA_INVALIDA;");
  const iRequisito = CODIGO_FATOS.indexOf("return VAZIO;");
  const iConsulta = CODIGO_FATOS.indexOf('.from("agente_permissoes")');
  ok("K11 o guarda de AUTORIDADE esta antes da consulta",
    iAutoridade > 0 && iConsulta > 0 && iAutoridade < iConsulta);
  ok("K12 o guarda de REQUISITO tambem esta antes da consulta",
    iRequisito > 0 && iConsulta > 0 && iRequisito < iConsulta);
  ok("K13 autoridade e verificada ANTES de normalizar os ids",
    iAutoridade < CODIGO_FATOS.indexOf("normalizarFuncaoIds(entrada.funcaoIds"));
}

ok("K14 VAZIO e coleta 'ok' com lista vazia",
  /const VAZIO[\s\S]{0,180}coleta: "ok"/.test(CODIGO_FATOS));
ok("K15 ENTRADA_INVALIDA e coleta 'entrada_invalida' com lista vazia",
  /const ENTRADA_INVALIDA[\s\S]{0,180}coleta: "entrada_invalida"/.test(CODIGO_FATOS));
ok("K16 os dois retornam fatos VAZIOS — nenhum concede autonomia",
  (CODIGO_FATOS.match(/fatos: Object\.freeze\(\[\]\)/g) ?? []).length >= 3);
ok("K17 CONTROLE: a sonda de ordem acusaria inversao",
  "abc".indexOf("a") < "abc".indexOf("c"));

// ─── L. Falha de leitura != ausencia ──────────────────────────────────

secao("L. Tres coletas distintas, nenhuma disfarcada de outra");

ok("L1  a coleta tem exatamente os tres valores",
  /export type ColetaPermissoes = "ok" \| "falha_leitura" \| "entrada_invalida";/.test(CODIGO_FATOS));
ok("L2  erro do driver devolve falha_leitura",
  /if \(error\)[\s\S]{0,320}coleta: "falha_leitura"/.test(CODIGO_FATOS));
ok("L3  e devolve fatos vazios junto — nunca fato inventado",
  /coleta: "falha_leitura"[\s\S]{0,40}\}|fatos: Object\.freeze\(\[\]\), coleta: "falha_leitura"/
    .test(CODIGO_FATOS.replace(/\s+/g, " ")));
ok("L4  o resultado sempre carrega a coleta",
  /interface ResultadoFatosPermissoes[\s\S]{0,200}coleta: ColetaPermissoes/.test(CODIGO_FATOS));
ok("L5  falha e ausencia NAO compartilham o mesmo valor",
  !/coleta: "ausente"/.test(CODIGO_FATOS));

{
  // Os tres desfechos produzem lista vazia. E por isso que a lista
  // sozinha nao serve de resposta: sem a coleta, sessao perdida, banco
  // fora do ar e "o dono nao liberou nada" ficariam identicos.
  const valores = (CODIGO_FATOS.match(/coleta: "(\w+)"/g) ?? [])
    .map((s) => s.replace(/coleta: "|"/g, ""));
  const distintos = Array.from(new Set(valores)).sort();
  ok(`L6  os tres valores aparecem no codigo (${distintos.join(", ")})`,
    JSON.stringify(distintos) === JSON.stringify(["entrada_invalida", "falha_leitura", "ok"]));
  ok("L7  ausencia legitima e entrada invalida NAO usam o mesmo valor",
    distintos.includes("ok") && distintos.includes("entrada_invalida"));
  ok("L8  falha de leitura continua distinta das outras duas",
    distintos.includes("falha_leitura"));
}

ok("L9  `entrada_invalida` NAO virou estado de diagnostico",
  !/ENTRADA_INVALIDA/.test(ler("lib/ia/skills/diagnostico.ts")) &&
  !/entrada_invalida/.test(ler("lib/ia/skills/diagnostico.ts")));
ok("L10 a SKILL-1C nao conhece ColetaPermissoes",
  !/ColetaPermissoes/.test(ler("lib/ia/skills/diagnostico.ts")));
ok("L11 os 8 estados de diagnostico seguem intactos",
  (ler("lib/ia/skills/diagnostico.ts").match(/"(PRONTO|FALTA_FUNCAO|FALTA_CONEXAO|CONEXAO_INVALIDA|FALTA_CONFIGURACAO|BLOQUEADO_POR_PERMISSAO|REQUER_APROVACAO|NAO_VERIFICAVEL)"/g) ?? []).length >= 8);

// ─── M. Segredo e log ─────────────────────────────────────────────────

secao("M. Nada sensivel entra, sai ou e logado");

for (const [nome, re] of [
  ["access_token", /access_token/], ["refresh_token", /refresh_token/],
  ["partner_key", /partner_key/], ["seller_id", /seller_id/],
  ["shop_id", /shop_id/], ["senha", /\bsenha\b/],
  ["DATABASE_URL", /DATABASE_URL/], ["service_role key", /SERVICE_ROLE_KEY/],
] as const) {
  ok(`M  nenhum ${nome} nos dois modulos`, !re.test(CODIGO_FATOS + CODIGO_ESTADO));
}
ok("M9  o log de erro nao usa error.message", !/error\.message/.test(CODIGO_FATOS));
ok("M10 o log de descarte conta, nao mostra valor",
  !/descartada[\s\S]{0,60}\$\{linha|nivel\}/.test(CODIGO_FATOS));
ok("M11 CONTROLE: as sondas de segredo acham quando existe",
  /access_token/.test("x.access_token") && /DATABASE_URL/.test("DATABASE_URL=1"));

// ─── N. A Skill nao concede autonomia ─────────────────────────────────

secao("N. Autoridade nao vem da Skill nem do modelo");

{
  // A Skill declara `requer.funcoes`. Isso NAO cria permissao: sem linha,
  // o resultado continua bloqueado por mais que ela peca.
  const d = diagnosticarSkill(entrada({
    skill: { id: "gulosa", requer: { funcoes: ["vendas.consultar"] } },
    permissoes: montarFatosPermissoes([]),
  }));
  ok("N1  Skill que exige Funcao nao ganha permissao", d.estadoGeral === "BLOQUEADO_POR_PERMISSAO");
}
ok("N2  o modulo nao aceita nivel vindo por parametro",
  !/nivel\s*:\s*NivelAutonomia\s*[,)]/.test(CODIGO_FATOS));
ok("N3  a entrada do resolvedor tem exatamente tres campos",
  /interface EntradaFatosPermissoes \{\s*userId: string;\s*agenteId: string;\s*funcaoIds: readonly string\[\];\s*\}/
    .test(FONTE_FATOS.replace(/\/\*[\s\S]*?\*\//g, "")));
ok("N4  so existe o resolvedor em LOTE — nenhum singular sem consumidor",
  /export async function resolverFatosPermissoes/.test(CODIGO_FATOS) &&
  !/export async function resolverFatoPermissao\b/.test(CODIGO_FATOS));

// ─── O. Determinismo ──────────────────────────────────────────────────

secao("O. Mesma entrada, mesma saida");

{
  const linhas = [L("vendas.consultar", "aprovacao"), L("outra.funcao", "automatico")];
  const a = JSON.stringify(montarFatosPermissoes(linhas));
  const b = JSON.stringify(montarFatosPermissoes(linhas));
  ok("O1  montagem e deterministica", a === b);

  const d1 = JSON.stringify(diagnosticarComLinhas(linhas));
  const d2 = JSON.stringify(diagnosticarComLinhas(linhas));
  ok("O2  o diagnostico derivado tambem", d1 === d2);

  ok("O3  sem relogio nos dois modulos",
    !/Date\.now\(\)|new Date\(\)/.test(CODIGO_ESTADO + CODIGO_FATOS));
  ok("O4  sem aleatoriedade", !/Math\.random/.test(CODIGO_ESTADO + CODIGO_FATOS));
}

// ─── P. Fronteira desta fase ──────────────────────────────────────────

secao("P. Zero UI, zero consumidor de producao, zero 1D.e");

ok("P1  diagnostico.ts continua sem mencionar agente_permissoes",
  !/agente_permissoes/.test(ler("lib/ia/skills/diagnostico.ts")));
ok("P2  lib/ia/skills continua com 3 modulos",
  readdirSync(join(RAIZ, "lib/ia/skills")).length === 3);
// O par `selecao-*` e da 1D.g.1-C, `selecao-escrita` da 1D.g.2-B e
// `agregador` da 1D.e-B2 — nenhum desta fase. Conferir o conjunto nominal — e nao o total — mantem a
// guarda dizendo o que ela sempre quis dizer: nenhum modulo DESTA fase
// foi parar em conexoes.
ok("P3  lib/agentes/conexoes com o conjunto exato de 6 modulos — nenhum e da 1D.d",
  JSON.stringify(readdirSync(join(RAIZ, "lib/agentes/conexoes")).sort()) ===
    JSON.stringify(["agregador.ts", "estado.ts", "fatos.ts", "selecao-escrita.ts", "selecao-estado.ts", "selecao-fatos.ts"]),
  readdirSync(join(RAIZ, "lib/agentes/conexoes")).sort().join(", "));
// P4 nasceu quando `registry.ts` era o unico modulo da pasta, e a
// TOOL-REGISTRY-B1 publicou mais dois: `guard.ts` (decisao pura de
// autorizacao) e `sanitizar.ts` (projecao por allowlist). O tripwire
// gemeo — H12, em `testar-ia-skill-1d-b.ts` — foi reconciliado naquele
// gate; este aqui nao, e ficou VERMELHO no HEAD publicado. A
// TOOL-CALL-A3 o alinha ao conjunto canonico.
//
// A intencao original nao mudou e nao foi afrouxada: a comparacao segue
// sendo de IGUALDADE, nunca `includes`/`some`/subconjunto. Um quarto
// modulo aparecendo nesta pasta sem passar por gate proprio continua
// reprovando — que e a unica coisa que P4 sempre quis dizer.
const FUNCOES_AUTORIZADAS = ["guard.ts", "registry.ts", "sanitizar.ts"];
const funcoesNoDisco = readdirSync(join(RAIZ, "lib/agentes/funcoes")).sort();
ok("P4  lib/agentes/funcoes com o conjunto exato de 3 modulos autorizados",
  JSON.stringify(funcoesNoDisco) === JSON.stringify(FUNCOES_AUTORIZADAS),
  funcoesNoDisco.join(", "));
ok("P4b controle: a comparacao e exata — um quarto modulo reprovaria",
  JSON.stringify([...FUNCOES_AUTORIZADAS, "executar.ts"].sort()) !==
    JSON.stringify(FUNCOES_AUTORIZADAS) &&
  JSON.stringify(["guard.ts", "registry.ts"]) !== JSON.stringify(FUNCOES_AUTORIZADAS));
ok("P5  nenhum modulo novo importa React ou UI",
  !/from "react"|components\//.test(CODIGO_ESTADO + CODIGO_FATOS));
ok("P6  MOCK_PERMISSOES nao foi tocado nem importado",
  !/MOCK_PERMISSOES/.test(CODIGO_ESTADO + CODIGO_FATOS));
{
  // `resolverFatosPermissoes` ganhou seu primeiro consumidor de producao
  // na SKILL-1D.consumer-B2. A exigencia deixa de ser ZERO e passa a ser
  // EXATAMENTE ESTE: allowlist nominal, por igualdade de caminho. O que
  // a sonda protege continua sendo o mesmo — nao ha consumidor NAO
  // autorizado —, e um segundo reprova. Prefixo ou pasta inteira, nao.
  const chamadores = ["lib", "app"].flatMap((raiz) => {
    const varrer = (dir: string): string[] => {
      const saida: string[] = [];
      for (const nome of readdirSync(join(RAIZ, dir), { withFileTypes: true })) {
        const rel = `${dir}/${nome.name}`;
        if (nome.isDirectory()) saida.push(...varrer(rel));
        else if (/\.tsx?$/.test(nome.name) && rel !== "lib/agentes/permissoes/fatos.ts") {
          if (/resolverFatosPermissoes/.test(ler(rel))) saida.push(rel);
        }
      }
      return saida;
    };
    return varrer(raiz);
  });
  // ── TOOL-EXEC-B: o segundo consumidor legitimo ─────────────────────
  //
  // O executor de Funcoes (`lib/agentes/execucao-funcoes/executar.ts`)
  // passou a resolver os fatos de permissao antes de decidir se uma Funcao pode ser
  // chamada. E o MESMO dado que o compositor usa; resolve-lo por conta
  // propria seria a duplicacao que esta guarda existe para impedir.
  //
  // A exigencia nao afrouxa: continua igualdade de conjunto, por caminho
  // NOMINAL, nos dois sentidos. Antes { compositor }, agora
  // { compositor, executar }. Prefixo, pasta ou contagem, nao.
  const EXECUTOR_FUNCOES = "lib/agentes/execucao-funcoes/executar.ts";
  const CONSUMIDORES_AUTORIZADOS: readonly string[] = [
    "lib/agentes/diagnostico/compositor.ts",
    EXECUTOR_FUNCOES,
  ];
  const COMPOSITOR = CONSUMIDORES_AUTORIZADOS[0];

  const mesmoConjunto = (a: readonly string[], b: readonly string[]): boolean =>
    JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

  ok(`P7  resolverFatosPermissoes tem exatamente os consumidores declarados (${chamadores.join(", ") || "nenhum"})`,
    mesmoConjunto(chamadores, CONSUMIDORES_AUTORIZADOS));
  ok("P7a CONTROLE: o conjunto exato dos dois autorizados passa",
    mesmoConjunto([COMPOSITOR, EXECUTOR_FUNCOES], CONSUMIDORES_AUTORIZADOS));
  ok("P7b CONTROLE: o compositor sumir reprova",
    !mesmoConjunto([EXECUTOR_FUNCOES], CONSUMIDORES_AUTORIZADOS));
  ok("P7c CONTROLE: o executor sumir reprova",
    !mesmoConjunto([COMPOSITOR], CONSUMIDORES_AUTORIZADOS));
  ok("P7d CONTROLE: um terceiro consumidor reprova",
    !mesmoConjunto([...CONSUMIDORES_AUTORIZADOS, "app/api/x/route.ts"], CONSUMIDORES_AUTORIZADOS));
}

// ─── Placar ───────────────────────────────────────────────────────────

console.log(`\n${"═".repeat(66)}`);
console.log(`  ${passou}/${passou + falhou} passaram` + (falhou > 0 ? `  ·  ${falhou} FALHARAM` : ""));
console.log(`${"═".repeat(66)}\n`);
process.exit(falhou > 0 ? 1 : 0);
