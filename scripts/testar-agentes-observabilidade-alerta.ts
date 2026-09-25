/**
 * OBS-4 — ciclo de vida do alerta e schema. I4P8.
 *
 * O reducer e PURO e roda de verdade aqui. O schema e auditado pelo
 * texto do SQL sem comentario — um invariante nao pode ser provado pela
 * prosa do arquivo que ele audita.
 *
 * Zero rede. Zero banco. Zero provider.
 *
 * Rodar:  npx tsx scripts/testar-agentes-observabilidade-alerta.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  EVIDENCIAS_PARA_RESOLVER,
  reduzirEstadoDoAlerta,
  sanitizarDetalhesDoAlerta,
  severidadeMaior,
  TIPOS_DE_ALERTA,
  type IncidenteAberto,
  type ObservacaoDeAlerta,
  type SeveridadeDoAlerta,
  type TipoDeAlerta,
} from "../lib/agentes/observabilidade/alerta";

let passou = 0;
let falhou = 0;
function ok(nome: string, condicao: boolean, detalhe = ""): void {
  if (condicao) { passou++; console.log(`  PASS  ${nome}`); }
  else { falhou++; console.log(`  FAIL  ${nome}${detalhe ? ` — ${detalhe}` : ""}`); }
}
function secao(titulo: string): void {
  console.log(`\n── ${titulo} ${"─".repeat(Math.max(2, 60 - titulo.length))}`);
}

const RAIZ = join(__dirname, "..");
const ler = (rel: string) => readFileSync(join(RAIZ, rel), "utf8");
const ARQUIVO = "supabase/migrations/20261013_agente_ingestao_alertas.sql";
const SQL = ler(ARQUIVO);
const LISO = SQL.replace(/^\s*--.*$/gm, "").replace(/\s+/g, " ");

const ESCOPO = {
  userId: "user-a",
  agenteId: "d27f4c6b-4af4-4bf3-8069-a762e76f7c8a",
  plataforma: "mercado_livre",
  recurso: "perguntas",
};

let t = 1_700_000_000_000;
const agora = () => (t += 60_000);

function obs(p: Partial<ObservacaoDeAlerta> = {}): ObservacaoDeAlerta {
  return {
    tipo: "scheduler_gap",
    escopo: ESCOPO,
    ativo: true,
    severidade: "warning",
    causa: "missing",
    chaveDaEvidencia: "w5m-A",
    detalhes: {},
    observadoEm: agora(),
    ...p,
  };
}

function incidente(p: Partial<IncidenteAberto> = {}): IncidenteAberto {
  return {
    tipo: "scheduler_gap",
    severidadeAtual: "warning",
    severidadeMaxima: "warning",
    causaAtual: "missing",
    ocorrencias: 1,
    ultimaEvidenciaChave: "w5m-A",
    evidenciasSaudaveisConsecutivas: 0,
    ...p,
  };
}

console.log("\n══ CDS IA — OBS-4: armazenamento e ciclo de vida do alerta ══");

// ─── A. Schema ────────────────────────────────────────────────────────
secao("A. Schema");

ok("A1  cria `public.agente_ingestao_alertas`",
  /create table public\.agente_ingestao_alertas \(/i.test(LISO));
ok("A2  SEM `if not exists`", !/create table if not exists/i.test(LISO));
ok("A3  PK por `id`", /primary key \(id\)/i.test(LISO));
ok("A4  FK composta tenant-safe",
  /foreign key \(agente_id, user_id\) references public\.agentes \(id, user_id\)/i.test(LISO));
ok("A5  FK restritiva nos dois sentidos", /on update restrict on delete restrict/i.test(LISO));

for (const tipo of TIPOS_DE_ALERTA) {
  ok(`A6  tipo \`${tipo}\` aceito pelo CHECK`, LISO.includes(`'${tipo}'`));
}
ok("A7  NAO existe tipo generico `cursor_uncertain`", !/cursor_uncertain/.test(LISO));
ok("A8  estados validos sao apenas aberto/resolvido",
  /check \(estado in \('aberto', 'resolvido'\)\)/i.test(LISO));
ok("A9  severidades validas",
  /severidade_atual in \('warning', 'alert', 'critical'\)/i.test(LISO));
ok("A10 maxima nunca menor que a atual, com ordem EXPLICITA",
  /agente_ingestao_alertas_maxima_nao_menor/.test(LISO) && /case severidade_maxima/i.test(LISO));
ok("A11 resolucao coerente nos DOIS sentidos",
  /estado = 'resolvido' and resolvido_em is not null/i.test(LISO) &&
  /estado = 'aberto' and resolvido_em is null/i.test(LISO));
ok("A12 ocorrencias >= 1", /check \(ocorrencias >= 1\)/i.test(LISO));
ok("A13 sequencia saudavel >= 0", /evidencias_saudaveis_consecutivas >= 0/i.test(LISO));
ok("A14 detalhes e objeto", /jsonb_typeof\(detalhes\) = 'object'/i.test(LISO));
ok("A15 par canonico fechado",
  /plataforma = 'mercado_livre' and recurso = 'perguntas'/i.test(LISO));
ok("A16 tempos coerentes", /ultimo_visto_em >= aberto_em/i.test(LISO));
ok("A17 nenhum trigger", !/create trigger/i.test(LISO));
ok("A18 nenhum seed", !/\binsert into\b/i.test(LISO));

secao("B. Unicidade parcial");

ok("B1  indice unico PARCIAL para incidente aberto",
  /create unique index agente_ingestao_alertas_um_aberto_por_chave/i.test(LISO));
ok("B2  cobre (user, agente, plataforma, recurso, tipo)",
  /\(user_id, agente_id, plataforma, recurso, tipo\)/i.test(LISO));
ok("B3  e SO vale para abertos — resolvidos podem repetir",
  /where estado = 'aberto'/i.test(LISO));

secao("C. Privilegios");

for (const papel of ["public", "anon", "authenticated", "service_role"] as const) {
  ok(`C1  revoke all de \`${papel}\``,
    new RegExp(`revoke all on table public\\.agente_ingestao_alertas from ${papel}`, "i").test(LISO));
}
ok("C2  grant select/insert/update apenas a service_role",
  /grant select, insert, update on table public\.agente_ingestao_alertas to service_role/i.test(LISO));
ok("C3  delete e truncate revogados",
  /revoke delete, truncate on table public\.agente_ingestao_alertas from service_role/i.test(LISO));
ok("C4  nenhum grant a anon/authenticated", !/grant [^;]*to (anon|authenticated)/i.test(LISO));

// ─── D. Severidade ────────────────────────────────────────────────────
secao("D. Severidade");

ok("D1  critical > alert > warning",
  severidadeMaior("warning", "alert") === "alert" &&
  severidadeMaior("alert", "critical") === "critical" &&
  severidadeMaior("critical", "warning") === "critical");
ok("D2  a ordem NAO e lexical — 'alert' < 'critical' apesar de a < c",
  severidadeMaior("critical", "alert") === "critical");

// ─── E. Ciclo de vida ─────────────────────────────────────────────────
secao("E. Ciclo de vida");

{
  const r = reduzirEstadoDoAlerta(null, obs());
  ok("E-A primeiro ativo abre incidente", r.acao === "OPEN");
  ok("E-A2 com ocorrencias 1 e streak saudavel 0",
    r.acao === "OPEN" && r.incidente.ocorrencias === 1 &&
    r.incidente.evidenciasSaudaveisConsecutivas === 0);
}
{
  // §22.B — mesma evidencia ativa 5 vezes.
  let inc = incidente();
  for (let i = 0; i < 5; i++) {
    const r = reduzirEstadoDoAlerta(inc, obs({ chaveDaEvidencia: "w5m-A" }));
    ok(`E-B${i + 1} releitura da mesma evidencia nao conta ocorrencia`,
      r.acao === "UPDATE" && r.campos.ocorrencias === undefined);
    if (r.acao === "UPDATE") inc = { ...inc, ...r.campos } as IncidenteAberto;
  }
  ok("E-B6 ocorrencias continua 1 depois de 5 reavaliacoes", inc.ocorrencias === 1);
}
{
  // §22.C — nova evidencia ativa.
  const r = reduzirEstadoDoAlerta(incidente(), obs({ chaveDaEvidencia: "w5m-B" }));
  ok("E-C nova evidencia incrementa ocorrencias",
    r.acao === "UPDATE" && r.campos.ocorrencias === 2);
  ok("E-C2 e registra a nova chave",
    r.acao === "UPDATE" && r.campos.ultimaEvidenciaChave === "w5m-B");
}
{
  // §22.D — escalada warning -> alert -> critical.
  let inc = incidente();
  for (const [i, sev] of (["alert", "critical"] as SeveridadeDoAlerta[]).entries()) {
    const r = reduzirEstadoDoAlerta(inc, obs({ chaveDaEvidencia: "w5m-" + i, severidade: sev }));
    if (r.acao === "UPDATE") inc = { ...inc, ...r.campos } as IncidenteAberto;
  }
  ok("E-D escalada leva maxima a critical", inc.severidadeMaxima === "critical");
}
{
  // §22.E — queda de severidade preserva o pico.
  const inc = incidente({ severidadeAtual: "critical", severidadeMaxima: "critical" });
  const r = reduzirEstadoDoAlerta(inc, obs({ chaveDaEvidencia: "w5m-Z", severidade: "alert" }));
  ok("E-E atual cai para alert", r.acao === "UPDATE" && r.campos.severidadeAtual === "alert");
  ok("E-E2 mas a maxima permanece critical",
    r.acao === "UPDATE" && r.campos.severidadeMaxima === "critical");
}
{
  // §22.F — mesma evidencia SAUDAVEL repetida nao acumula recuperacao.
  let inc = incidente({ ultimaEvidenciaChave: "w5m-S" });
  for (let i = 0; i < 5; i++) {
    const r = reduzirEstadoDoAlerta(inc, obs({ ativo: false, chaveDaEvidencia: "w5m-S" }));
    ok(`E-F${i + 1} releitura saudavel nao incrementa recuperacao`,
      r.acao === "UPDATE" && r.campos.evidenciasSaudaveisConsecutivas === undefined);
    if (r.acao === "UPDATE") inc = { ...inc, ...r.campos } as IncidenteAberto;
  }
  ok("E-F6 streak saudavel continua 0", inc.evidenciasSaudaveisConsecutivas === 0);
}
{
  // §22.G — duas evidencias saudaveis DISTINTAS resolvem.
  let inc = incidente();
  const r1 = reduzirEstadoDoAlerta(inc, obs({ ativo: false, chaveDaEvidencia: "w5m-S1" }));
  ok("E-G1 primeira saudavel distinta ainda NAO resolve",
    r1.acao === "UPDATE" && r1.campos.evidenciasSaudaveisConsecutivas === 1);
  if (r1.acao === "UPDATE") inc = { ...inc, ...r1.campos } as IncidenteAberto;
  const r2 = reduzirEstadoDoAlerta(inc, obs({ ativo: false, chaveDaEvidencia: "w5m-S2" }));
  ok("E-G2 a segunda distinta RESOLVE", r2.acao === "RESOLVE");
}
{
  // §22.H — novo ativo depois de resolvido abre incidente NOVO.
  const r = reduzirEstadoDoAlerta(null, obs({ chaveDaEvidencia: "w5m-depois" }));
  ok("E-H sem incidente aberto, um novo ativo abre outra linha", r.acao === "OPEN");
}
{
  const r = reduzirEstadoDoAlerta(null, obs({ ativo: false }));
  ok("E-I nada ativo e nada aberto = NOOP", r.acao === "NOOP");
}

secao("F. Politica por tipo");

for (const [tipo, n] of Object.entries(EVIDENCIAS_PARA_RESOLVER) as [TipoDeAlerta, number][]) {
  const inc = incidente({ tipo });
  const r = reduzirEstadoDoAlerta(inc, obs({ tipo, ativo: false, chaveDaEvidencia: "nova-1" }));
  const resolveDeImediato = n === 1;
  ok(`F1  ${tipo}: exige ${n} evidencia(s) — resolve na primeira? ${resolveDeImediato}`,
    (r.acao === "RESOLVE") === resolveDeImediato);
}
ok("F2  os tipos ligados ao agendador exigem 2",
  EVIDENCIAS_PARA_RESOLVER.scheduler_gap === 2 &&
  EVIDENCIAS_PARA_RESOLVER.cursor_stuck === 2 &&
  EVIDENCIAS_PARA_RESOLVER.backlog_pressure === 2 &&
  EVIDENCIAS_PARA_RESOLVER.budget_pressure === 2 &&
  EVIDENCIAS_PARA_RESOLVER.cursor_regression === 2);
ok("F3  os do proprio vigia resolvem de imediato",
  EVIDENCIAS_PARA_RESOLVER.monitor_configuration_missing === 1 &&
  EVIDENCIAS_PARA_RESOLVER.observability_data_incomplete === 1);

// ─── G. Sanitização ───────────────────────────────────────────────────
secao("G. Sanitizacao dos detalhes");

{
  const sujo = {
    canonicalBucketId: "w5m-20260926T1300Z",
    streak: 3,
    certeza: "CONTAMINADA",
    // tudo abaixo deve sumir
    textoPergunta: "Qual o prazo de entrega?",
    id_externo: "MLB123",
    userId: "user-secreto",
    accessToken: "abc",
    body: { qualquer: "coisa" },
    argumentos: { limite: 50 },
  };
  const limpo = sanitizarDetalhesDoAlerta(sujo);
  ok("G1  mantem o diagnostico permitido",
    limpo.canonicalBucketId === "w5m-20260926T1300Z" && limpo.streak === 3 &&
    limpo.certeza === "CONTAMINADA");
  for (const proibido of ["textoPergunta", "id_externo", "userId", "accessToken", "body", "argumentos"]) {
    ok(`G2  remove \`${proibido}\``, !(proibido in limpo));
  }
}
ok("G3  texto longo nao passa — seria a porta para conteudo comercial",
  !("canonicalBucketId" in sanitizarDetalhesDoAlerta({ canonicalBucketId: "x".repeat(200) })));
ok("G4  objeto aninhado nao passa",
  Object.keys(sanitizarDetalhesDoAlerta({ certeza: { a: 1 } })).length === 0);
ok("G5  entrada nao-objeto devolve objeto vazio",
  Object.keys(sanitizarDetalhesDoAlerta("lixo")).length === 0 &&
  Object.keys(sanitizarDetalhesDoAlerta(null)).length === 0);
ok("G6  o reducer sanitiza ANTES de devolver a intencao",
  (() => {
    const r = reduzirEstadoDoAlerta(null, obs({ detalhes: { accessToken: "x", streak: 2 } }));
    return r.acao === "OPEN" && !("accessToken" in r.incidente.detalhes) &&
      r.incidente.detalhes.streak === 2;
  })());

// ─── H. Fronteiras estáticas ──────────────────────────────────────────
secao("H. Fronteiras");

{
  const puro = ler("lib/agentes/observabilidade/alerta.ts")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
  for (const proibido of ["supabase", "Supabase", "server-only", "fetch(", "process.env"] as const) {
    ok(`H1  o reducer nao alcanca \`${proibido}\``, !puro.includes(proibido));
  }
  const repo = ler("lib/agentes/observabilidade/alerta-repositorio.ts")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
  ok("H2  o repositorio declara `server-only`", repo.includes("server-only"));
  ok("H3  o repositorio NAO decide lifecycle — nao importa o reducer como valor",
    !/reduzirEstadoDoAlerta/.test(repo));
  ok("H4  e trata a corrida perdida como informacao, nao erro",
    repo.includes("duplicada") && repo.includes("23505"));
  ok("H5  so atualiza incidente ABERTO",
    (repo.match(/\.eq\("estado", "aberto"\)/g) || []).length >= 2);
}
ok("H6  zero bytes de controle",
  !ler("lib/agentes/observabilidade/alerta.ts").includes(String.fromCharCode(0)) &&
  !SQL.includes(String.fromCharCode(0)));

console.log(`\n── placar ${"─".repeat(54)}`);
console.log(`  PASS ${passou}   FAIL ${falhou}\n`);
if (falhou > 0) process.exitCode = 1;
