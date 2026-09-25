/**
 * OBS-1 — `agente_ingestao_estado_esperado`: invariantes ESTRUTURAIS e
 * decisao pura da camada de dominio. I4P5.
 *
 * Le o SQL sem comentario e o modulo sem comentario: um invariante nao
 * pode ser provado pela prosa do arquivo que ele audita. Esta frente ja
 * perdeu tempo com oraculos que casavam com a propria documentacao.
 *
 * Zero rede. Zero banco. Zero provider. Zero cursor.
 *
 * Rodar:  npx tsx scripts/testar-agentes-observabilidade-estado-esperado.ts
 */
import { readFileSync } from "node:fs";
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
  console.log(`\n── ${titulo} ${"─".repeat(Math.max(2, 60 - titulo.length))}`);
}

const RAIZ = join(__dirname, "..");
const ler = (rel: string) => readFileSync(join(RAIZ, rel), "utf8");

const ARQUIVO = "supabase/migrations/20261012_agente_ingestao_estado_esperado.sql";
const MODULO = "lib/agentes/observabilidade/estado-esperado.ts";

const SQL = ler(ARQUIVO);
const LISO = SQL.replace(/^\s*--.*$/gm, "").replace(/\s+/g, " ");
const CODIGO = ler(MODULO)
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^[ \t]*\/\/.*$/gm, "");

console.log("\n══ CDS IA — OBS-1: estado esperado da ingestao ══");

// ─── A. A tabela ──────────────────────────────────────────────────────
secao("A. Tabela e colunas");

ok("A1  cria `public.agente_ingestao_estado_esperado`",
  /create table public\.agente_ingestao_estado_esperado \(/i.test(LISO));
ok("A2  SEM `if not exists` — objeto de forma errada falha alto",
  !/create table if not exists/i.test(LISO));

for (const [coluna, forma] of [
  ["agente_id", "uuid not null"],
  ["user_id", "text not null"],
  ["plataforma", "text not null"],
  ["recurso", "text not null"],
  ["esperado_ativo", "boolean not null"],
  ["esperado_desde", "timestamptz null"],
  ["criado_em", "timestamptz not null default now()"],
  ["alterado_em", "timestamptz not null default now()"],
] as const) {
  ok(`A3  coluna \`${coluna}\` e \`${forma}\``,
    new RegExp(`${coluna}\\s+${forma.replace(/[()]/g, "\\$&")}`, "i").test(LISO));
}

ok("A4  `esperado_ativo` NAO tem default — intencao e declarada, nao herdada",
  !/esperado_ativo\s+boolean\s+not null\s+default/i.test(LISO));

// ─── B. Chave e cerca de dono ─────────────────────────────────────────
secao("B. Identidade e autoridade");

ok("B1  PK e `(agente_id, plataforma, recurso)` — nao e singleton global",
  /primary key \(agente_id, plataforma, recurso\)/i.test(LISO));
ok("B2  FK composta contra `agentes (id, user_id)`",
  /foreign key \(agente_id, user_id\) references public\.agentes \(id, user_id\)/i.test(LISO));
ok("B3  a FK e restritiva nos dois sentidos",
  /on update restrict on delete restrict/i.test(LISO));
ok("B4  NAO ha `loja_id` — configuracao nao e por conta",
  !/loja_id/i.test(LISO));

// ─── C. Invariantes de dominio no banco ───────────────────────────────
secao("C. Constraints");

ok("C1  ativo EXIGE fronteira",
  /check \(esperado_ativo = false or esperado_desde is not null\)/i.test(LISO));
ok("C2  tempos coerentes",
  /check \(alterado_em >= criado_em\)/i.test(LISO));
ok("C3  par canonico fechado no banco",
  /check \(plataforma = 'mercado_livre' and recurso = 'perguntas'\)/i.test(LISO));
ok("C4  NAO ha CHECK de alinhamento a cadencia — constante de dominio nao vira migration",
  !/% 300/.test(LISO) && !/date_part|extract/i.test(LISO));
ok("C5  nenhum trigger",
  !/create trigger/i.test(LISO));
ok("C6  nenhum seed/insert — o gate nao cria intencao",
  !/\binsert into\b/i.test(LISO));

// ─── D. Privilegios ───────────────────────────────────────────────────
secao("D. Privilegios");

for (const papel of ["public", "anon", "authenticated", "service_role"] as const) {
  ok(`D1  revoke all de \`${papel}\``,
    new RegExp(`revoke all on table public\\.agente_ingestao_estado_esperado from ${papel}`, "i").test(LISO));
}
ok("D2  grant de select/insert/update SOMENTE a service_role",
  /grant select, insert, update on table public\.agente_ingestao_estado_esperado to service_role/i.test(LISO));
ok("D3  delete e truncate revogados",
  /revoke delete, truncate on table public\.agente_ingestao_estado_esperado from service_role/i.test(LISO));
ok("D4  nenhum grant a anon/authenticated",
  !/grant [^;]*to (anon|authenticated)/i.test(LISO));

// ─── E. A camada de dominio ───────────────────────────────────────────
secao("E. Dominio: os tres estados");

ok("E1  a leitura distingue `configuracao_ausente`",
  /"configuracao_ausente"/.test(CODIGO));
ok("E2  e `configurado_inativo`",
  /"configurado_inativo"/.test(CODIGO));
ok("E3  e `configurado_ativo` com fronteira",
  /"configurado_ativo"/.test(CODIGO) && /esperadoDesde/.test(CODIGO));
ok("E4  falha de leitura e estado PROPRIO, nunca `ausente`",
  /"falhou_leitura"/.test(CODIGO));
ok("E5  a leitura NAO devolve booleano",
  !/Promise<boolean>/.test(CODIGO));
ok("E6  `.limit(2)` em vez de `maybeSingle` — schema quebrado denuncia",
  /\.limit\(2\)/.test(CODIGO) && !/maybeSingle/.test(CODIGO));

secao("F. Dominio: a escrita nao aceita autoridade");

ok("F1  o dono vem de `lerAgenteParaAcaoInterna`",
  /lerAgenteParaAcaoInterna/.test(CODIGO));
ok("F2  a entrada da escrita NAO tem `userId`",
  !/readonly userId/.test(CODIGO));
ok("F3  ativo sem fronteira e recusado no dominio",
  /esperado_desde_ausente/.test(CODIGO));
ok("F4  fronteira fora da grade e recusada",
  /esperado_desde_fora_da_fronteira/.test(CODIGO));
ok("F5  o escopo e filtrado por plataforma E recurso na leitura",
  /\.eq\("plataforma", PLATAFORMA\)/.test(CODIGO) && /\.eq\("recurso", RECURSO\)/.test(CODIGO));
ok("F6  plataforma/recurso vem da constante canonica, nao de literal solto",
  /CONEXAO_PERGUNTAS_ML/.test(CODIGO));

// ─── G. Fronteiras: nada comercial ────────────────────────────────────
secao("G. O que este modulo NAO pode alcancar");

for (const proibido of [
  "mercado-livre-perguntas",
  "continuacao-perguntas",
  "perguntas-inbox",
  "sincronizar-perguntas",
  "execucao-funcoes",
  "executarFuncao",
  "fetch(",
] as const) {
  ok(`G1  nao alcanca \`${proibido}\``, !CODIGO.includes(proibido));
}
ok("G2  nao escreve no cursor", !/proximo_deslocamento/.test(CODIGO));
ok("G3  nao ha rota HTTP neste slice",
  !/export async function (GET|POST|PUT|DELETE)/.test(CODIGO));
ok("G4  `server-only` declarado no modulo de banco", /import "server-only"/.test(ler(MODULO)));
// Sem tirar comentario, este oraculo casaria com a PROSA do arquivo, que
// explica justamente por que `server-only` nao entra aqui. Esta frente ja
// perdeu tempo tres vezes com oraculos que provavam a propria documentacao.
const PURO = ler("lib/agentes/observabilidade/fronteira-bucket.ts")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^[ 	]*\/\/.*$/gm, "");
ok("G5  a parte PURA nao carrega `server-only` — e por isso ela e testavel",
  !PURO.includes("server-only"));
ok("G6  a parte pura nao importa nada do repositorio", !/^import /m.test(PURO));
ok("G6b CONTROLE: o oraculo enxerga o `server-only` REAL do modulo de banco",
  ler(MODULO)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ 	]*\/\/.*$/gm, "")
    .includes("server-only"));
ok("G7  o modulo de banco REUSA a parte pura em vez de duplicar a regra",
  /from "\.\/fronteira-bucket"/.test(CODIGO) &&
  !/export function alinhadoAoBucket/.test(CODIGO));

// ─── H. Alinhamento de fronteira (decisao PURA) ───────────────────────
secao("H. alinhadoAoBucket");

// A parte PURA vive em modulo proprio justamente para poder ser
// importada aqui: `estado-esperado.ts` carrega `server-only` e lancaria.
const mod = require("../lib/agentes/observabilidade/fronteira-bucket") as {
  alinhadoAoBucket: (iso: string) => boolean;
  CADENCIA_MS: number;
};

ok("H1  CADENCIA_MS e 300000", mod.CADENCIA_MS === 300_000);
ok("H2  fronteira exata de bucket passa", mod.alinhadoAoBucket("2026-09-26T13:05:00.000Z"));
ok("H3  um segundo depois reprova", !mod.alinhadoAoBucket("2026-09-26T13:05:01.000Z"));
ok("H4  um milissegundo depois reprova", !mod.alinhadoAoBucket("2026-09-26T13:05:00.001Z"));
ok("H5  minuto nao multiplo de 5 reprova", !mod.alinhadoAoBucket("2026-09-26T13:07:00.000Z"));
ok("H6  meia-noite exata passa", mod.alinhadoAoBucket("2026-09-26T00:00:00.000Z"));
ok("H7  texto que nao e data reprova", !mod.alinhadoAoBucket("ontem"));
ok("H8  string vazia reprova", !mod.alinhadoAoBucket(""));

console.log(`\n── placar ${"─".repeat(54)}`);
console.log(`  PASS ${passou}   FAIL ${falhou}\n`);
if (falhou > 0) process.exitCode = 1;
