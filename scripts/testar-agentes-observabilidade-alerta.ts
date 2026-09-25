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
  chaveDaEvidencia,
  compararEvidencias,
  EVIDENCIAS_PARA_RESOLVER,
  fatoAtivo,
  fatoSaudavel,
  lerChaveDaEvidencia,
  LIMITE_DO_PEDACO,
  normalizarPedacoDaEvidencia,
  reduzirEstadoDoAlerta,
  SEPARADOR_DA_EVIDENCIA,
  sujeitoDoBucket,
  SUJEITO_DA_CONFIGURACAO,
  SUJEITO_DA_OBSERVABILIDADE,
  sanitizarDetalhesDoAlerta,
  severidadeMaior,
  TIPOS_DE_ALERTA,
  type IncidenteAberto,
  type IntencaoDoAlerta,
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
    sujeitoDaEvidencia: sujeitoDoBucket("w5m-A"),
    fatoDaEvidencia: fatoAtivo("missing"),
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
    ultimaEvidenciaChave: chaveDaEvidencia(sujeitoDoBucket("w5m-A"), fatoAtivo("missing")),
    evidenciasSaudaveisConsecutivas: 0,
    ...p,
  };
}

/** Atalhos: a chave nasce SEMPRE das duas partes, nunca escrita a mao. */
const ativa = (bucket: string, codigo = "missing", n?: number) => ({
  sujeitoDaEvidencia: sujeitoDoBucket(bucket),
  fatoDaEvidencia: fatoAtivo(codigo, n),
});
const saudavel = (bucket: string, codigo = "succeeded", n?: number) => ({
  sujeitoDaEvidencia: sujeitoDoBucket(bucket),
  fatoDaEvidencia: fatoSaudavel(codigo, n),
});
const chaveDe = (e: { sujeitoDaEvidencia: string; fatoDaEvidencia: string }) =>
  chaveDaEvidencia(e.sujeitoDaEvidencia, e.fatoDaEvidencia);
/** Aplica a intencao sobre o incidente, como o repositorio faria. */
const aplicar = (inc: IncidenteAberto, r: IntencaoDoAlerta): IncidenteAberto =>
  r.acao === "UPDATE" || r.acao === "RESOLVE"
    ? ({ ...inc, ...r.campos } as IncidenteAberto)
    : inc;

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
    const r = reduzirEstadoDoAlerta(inc, obs(ativa("w5m-A")));
    ok(`E-B${i + 1} releitura da mesma evidencia nao conta ocorrencia`,
      r.acao === "UPDATE" && r.campos.ocorrencias === undefined);
    if (r.acao === "UPDATE") inc = { ...inc, ...r.campos } as IncidenteAberto;
  }
  ok("E-B6 ocorrencias continua 1 depois de 5 reavaliacoes", inc.ocorrencias === 1);
}
{
  // §22.C — nova evidencia ativa.
  const r = reduzirEstadoDoAlerta(incidente(), obs(ativa("w5m-B")));
  ok("E-C nova evidencia incrementa ocorrencias",
    r.acao === "UPDATE" && r.campos.ocorrencias === 2);
  ok("E-C2 e registra a nova chave",
    r.acao === "UPDATE" && r.campos.ultimaEvidenciaChave === chaveDe(ativa("w5m-B")));
}
{
  // §22.D — escalada warning -> alert -> critical.
  let inc = incidente();
  for (const [i, sev] of (["alert", "critical"] as SeveridadeDoAlerta[]).entries()) {
    const r = reduzirEstadoDoAlerta(inc, obs({ ...ativa("w5m-" + i), severidade: sev }));
    if (r.acao === "UPDATE") inc = { ...inc, ...r.campos } as IncidenteAberto;
  }
  ok("E-D escalada leva maxima a critical", inc.severidadeMaxima === "critical");
}
{
  // §22.E — queda de severidade preserva o pico.
  const inc = incidente({ severidadeAtual: "critical", severidadeMaxima: "critical" });
  const r = reduzirEstadoDoAlerta(inc, obs({ ...ativa("w5m-Z"), severidade: "alert" }));
  ok("E-E atual cai para alert", r.acao === "UPDATE" && r.campos.severidadeAtual === "alert");
  ok("E-E2 mas a maxima permanece critical",
    r.acao === "UPDATE" && r.campos.severidadeMaxima === "critical");
}
{
  // §22.F — mesma evidencia SAUDAVEL repetida nao acumula recuperacao.
  let inc = incidente({ ultimaEvidenciaChave: chaveDe(saudavel("w5m-S")) });
  for (let i = 0; i < 5; i++) {
    const r = reduzirEstadoDoAlerta(inc, obs({ ativo: false, ...saudavel("w5m-S") }));
    ok(`E-F${i + 1} releitura saudavel nao incrementa recuperacao`,
      r.acao === "UPDATE" && r.campos.evidenciasSaudaveisConsecutivas === undefined);
    if (r.acao === "UPDATE") inc = { ...inc, ...r.campos } as IncidenteAberto;
  }
  ok("E-F6 streak saudavel continua 0", inc.evidenciasSaudaveisConsecutivas === 0);
}
{
  // §22.G — duas evidencias saudaveis DISTINTAS resolvem.
  let inc = incidente();
  const r1 = reduzirEstadoDoAlerta(inc, obs({ ativo: false, ...saudavel("w5m-S1") }));
  ok("E-G1 primeira saudavel distinta ainda NAO resolve",
    r1.acao === "UPDATE" && r1.campos.evidenciasSaudaveisConsecutivas === 1);
  if (r1.acao === "UPDATE") inc = { ...inc, ...r1.campos } as IncidenteAberto;
  const r2 = reduzirEstadoDoAlerta(inc, obs({ ativo: false, ...saudavel("w5m-S2") }));
  ok("E-G2 a segunda distinta RESOLVE", r2.acao === "RESOLVE");
}
{
  // §22.H — novo ativo depois de resolvido abre incidente NOVO.
  const r = reduzirEstadoDoAlerta(null, obs(ativa("w5m-depois")));
  ok("E-H sem incidente aberto, um novo ativo abre outra linha", r.acao === "OPEN");
}
{
  const r = reduzirEstadoDoAlerta(null, obs({ ativo: false }));
  ok("E-I nada ativo e nada aberto = NOOP", r.acao === "NOOP");
}

secao("F. Politica por tipo");

for (const [tipo, n] of Object.entries(EVIDENCIAS_PARA_RESOLVER) as [TipoDeAlerta, number][]) {
  const inc = incidente({ tipo });
  const r = reduzirEstadoDoAlerta(inc, obs({ tipo, ativo: false, ...saudavel("w5m-nova") }));
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

// --- I. Identidade da evidencia (I4P8-R1) ----------------------------
secao("I. Identidade da evidencia");

ok("I1  a chave e sujeito + separador + fato",
  chaveDaEvidencia("b:w5m-A", "a:missing") ===
    "b:w5m-A" + SEPARADOR_DA_EVIDENCIA + "a:missing");
{
  const l = lerChaveDaEvidencia(chaveDe(ativa("w5m-A")));
  ok("I2  e volta a ser decomponivel nas duas partes",
    l !== null && l.sujeito === sujeitoDoBucket("w5m-A") && l.fato === fatoAtivo("missing"));
  ok("I3  com a classe ATIVA legivel", l !== null && l.classe === "ativa");
}
ok("I4  fato saudavel carrega classe propria",
  lerChaveDaEvidencia(chaveDe(saudavel("w5m-A")))?.classe === "saudavel");
ok("I5  fato sem marca conhecida e INDEFINIDO, nao adivinhado",
  lerChaveDaEvidencia("b:x" + SEPARADOR_DA_EVIDENCIA + "z:qualquer")?.classe === "indefinida");
ok("I6  chave sem separador nao e legivel", lerChaveDaEvidencia("w5m-A") === null);
ok("I7  chave que nao e texto nao e legivel",
  lerChaveDaEvidencia(null) === null && lerChaveDaEvidencia(42) === null);

// SS18 — o que NAO pode entrar numa chave.
{
  const pedaco = normalizarPedacoDaEvidencia("Qual o prazo de entrega? - comprador 123");
  ok("I8  texto livre nao sobrevive ao alfabeto da chave",
    !/[^A-Za-z0-9_.:-]/.test(pedaco));
  ok("I9  e o tamanho e limitado",
    normalizarPedacoDaEvidencia("x".repeat(500)).length === LIMITE_DO_PEDACO);
}
ok("I10 o separador nunca sobrevive dentro de um pedaco - a chave continua decomponivel",
  !normalizarPedacoDaEvidencia("a" + SEPARADOR_DA_EVIDENCIA + "b").includes(SEPARADOR_DA_EVIDENCIA));
ok("I11 pedaco vazio nao apaga a parte",
  normalizarPedacoDaEvidencia("") === "_" && normalizarPedacoDaEvidencia(undefined) === "_");
ok("I12 contador invalido fica VISIVEL, nao sumido em silencio",
  fatoAtivo("stuck", 1.5).endsWith(":n?") && fatoAtivo("stuck", -1).endsWith(":n?"));
ok("I13 contador valido entra no fato", fatoAtivo("stuck", 3) === "a:stuck:n3");
ok("I14 a mesma chave nao pode nascer de fatos diferentes",
  chaveDe(ativa("w5m-A")) !== chaveDe(ativa("w5m-A", "incomplete")) &&
  chaveDe(ativa("w5m-A")) !== chaveDe(saudavel("w5m-A")));

ok("I15 mesma chave = repeticao",
  compararEvidencias(chaveDe(ativa("w5m-A")), chaveDe(ativa("w5m-A"))) === "repeticao");
ok("I16 mesmo sujeito, mesma classe, fato outro = refinamento",
  compararEvidencias(chaveDe(ativa("w5m-A")), chaveDe(ativa("w5m-A", "incomplete"))) === "refinamento");
ok("I17 sujeito outro = unidade nova",
  compararEvidencias(chaveDe(ativa("w5m-A")), chaveDe(ativa("w5m-B"))) === "nova_unidade");
ok("I18 classe virada no MESMO sujeito = unidade nova - e a recuperacao",
  compararEvidencias(chaveDe(ativa("w5m-A")), chaveDe(saudavel("w5m-A"))) === "nova_unidade");
ok("I19 sem chave anterior = unidade nova (erra para cima, nunca esconde reincidencia)",
  compararEvidencias(null, chaveDe(ativa("w5m-A"))) === "nova_unidade");
ok("I20 chave anterior ilegivel = unidade nova",
  compararEvidencias("w5m-A", chaveDe(ativa("w5m-A"))) === "nova_unidade");
ok("I21 classe indefinida nunca e tratada como igual",
  compararEvidencias("b:x#z:um", "b:x#z:dois") === "nova_unidade");

{
  const puroAlerta = ler("lib/agentes/observabilidade/alerta.ts")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
  ok("I22 a observacao exige as DUAS partes, nunca uma chave pronta",
    !/readonly chaveDaEvidencia/.test(puroAlerta) &&
    /readonly sujeitoDaEvidencia: string;/.test(puroAlerta) &&
    /readonly fatoDaEvidencia: string;/.test(puroAlerta));
  ok("I23 e a chave guardada nasce sempre do construtor",
    /chaveDaEvidencia\(obs\.sujeitoDaEvidencia, obs\.fatoDaEvidencia\)/.test(puroAlerta));
}
ok("I24 nenhuma coluna nova: a chave composta cabe em `ultima_evidencia_chave`",
  LISO.includes("ultima_evidencia_chave text null") && !/sujeito/i.test(LISO));

// --- J. Evolucao factual do mesmo bucket -----------------------------
secao("J. Evolucao factual do mesmo bucket");

{
  // SS17.A-E numa linha do tempo unica: o gap nasce, se detalha, recebe
  // o terminal atrasado e so fecha com um SEGUNDO bucket saudavel.
  let inc = incidente({ ultimaEvidenciaChave: chaveDe(ativa("w5m-B1")) });

  for (let i = 0; i < 5; i++) {
    const r = reduzirEstadoDoAlerta(inc, obs(ativa("w5m-B1")));
    ok(`J-A${i + 1} B1 MISSING relido nao conta ocorrencia`,
      r.acao === "UPDATE" && r.campos.ocorrencias === undefined);
    inc = aplicar(inc, r);
  }
  ok("J-A6 ocorrencias continua 1 depois de 5 reavaliacoes", inc.ocorrencias === 1);

  const rB = reduzirEstadoDoAlerta(inc,
    obs({ ...ativa("w5m-B1", "incomplete"), causa: "incomplete" }));
  ok("J-B  MISSING -> INCOMPLETE no MESMO bucket nao vira incidente novo",
    rB.acao === "UPDATE" && rB.campos.ocorrencias === undefined);
  ok("J-B2 mas a chave e a causa acompanham o fato novo",
    rB.acao === "UPDATE" &&
    rB.campos.ultimaEvidenciaChave === chaveDe(ativa("w5m-B1", "incomplete")) &&
    rB.campos.causaAtual === "incomplete");
  ok("J-B3 e a condicao conta como vista de novo",
    rB.acao === "UPDATE" && rB.campos.ultimoVistoEm !== undefined);
  inc = aplicar(inc, rB);
  ok("J-B4 ocorrencias segue 1 depois do refinamento", inc.ocorrencias === 1);

  const rC = reduzirEstadoDoAlerta(inc, obs({ ativo: false, ...saudavel("w5m-B1") }));
  ok("J-C  terminal tardio do PROPRIO B1 vale como 1a evidencia saudavel",
    rC.acao === "UPDATE" && rC.campos.evidenciasSaudaveisConsecutivas === 1);
  inc = aplicar(inc, rC);

  for (let i = 0; i < 5; i++) {
    const r = reduzirEstadoDoAlerta(inc, obs({ ativo: false, ...saudavel("w5m-B1") }));
    ok(`J-D${i + 1} B1 saudavel relido nao acumula recuperacao`,
      r.acao === "UPDATE" && r.campos.evidenciasSaudaveisConsecutivas === undefined);
    inc = aplicar(inc, r);
  }
  ok("J-D6 streak saudavel continua 1", inc.evidenciasSaudaveisConsecutivas === 1);

  const rE = reduzirEstadoDoAlerta(inc, obs({ ativo: false, ...saudavel("w5m-B2") }));
  ok("J-E  o SEGUNDO bucket saudavel resolve o scheduler_gap", rE.acao === "RESOLVE");
}
{
  // Contraprova de J-E: dois FATOS saudaveis sobre o mesmo bucket nao
  // podem fechar um alerta cuja politica exige dois BUCKETS.
  let inc = incidente({ ultimaEvidenciaChave: chaveDe(ativa("w5m-B1")) });
  inc = aplicar(inc, reduzirEstadoDoAlerta(inc, obs({ ativo: false, ...saudavel("w5m-B1") })));
  const r = reduzirEstadoDoAlerta(inc, obs({ ativo: false, ...saudavel("w5m-B1", "recuperado") }));
  ok("J-F  segundo fato saudavel do MESMO bucket nao resolve sozinho",
    r.acao === "UPDATE" && r.campos.evidenciasSaudaveisConsecutivas === undefined);
}
{
  // Recaida: o bucket ja contado saudavel volta a ficar ativo.
  const inc = incidente({
    ultimaEvidenciaChave: chaveDe(saudavel("w5m-B1")),
    evidenciasSaudaveisConsecutivas: 1,
  });
  const r = reduzirEstadoDoAlerta(inc, obs(ativa("w5m-B1", "failed")));
  ok("J-G  recaida no mesmo bucket e ocorrencia nova, nao refinamento",
    r.acao === "UPDATE" && r.campos.ocorrencias === 2);
  ok("J-G2 e zera a recuperacao",
    r.acao === "UPDATE" && r.campos.evidenciasSaudaveisConsecutivas === 0);
}

// --- K. Condicoes que nao dependem do agendador ----------------------
secao("K. Condicoes fora do agendador");

for (const [rot, tipo, sujeito, ausente, presente] of [
  ["configuracao", "monitor_configuration_missing", SUJEITO_DA_CONFIGURACAO, "ausente", "presente"],
  ["observabilidade", "observability_data_incomplete", SUJEITO_DA_OBSERVABILIDADE, "incompleto", "completo"],
] as const) {
  let inc = incidente({
    tipo,
    causaAtual: ausente,
    ultimaEvidenciaChave: chaveDaEvidencia(sujeito, fatoAtivo(ausente)),
  });
  for (let i = 0; i < 4; i++) {
    const r = reduzirEstadoDoAlerta(inc, obs({
      tipo, causa: ausente,
      sujeitoDaEvidencia: sujeito, fatoDaEvidencia: fatoAtivo(ausente),
    }));
    ok(`K-${rot}${i + 1} ${ausente} relido nao conta ocorrencia`,
      r.acao === "UPDATE" && r.campos.ocorrencias === undefined);
    inc = aplicar(inc, r);
  }
  ok(`K-${rot}5 ocorrencias continua 1`, inc.ocorrencias === 1);

  const r = reduzirEstadoDoAlerta(inc, obs({
    tipo, ativo: false,
    sujeitoDaEvidencia: sujeito, fatoDaEvidencia: fatoSaudavel(presente),
  }));
  ok(`K-${rot}6 ${presente} e fato NOVO e RESOLVE de imediato`, r.acao === "RESOLVE");
}

// --- L. Pressao que cede ---------------------------------------------
secao("L. Pressao que cede");

for (const tipo of ["backlog_pressure", "budget_pressure"] as const) {
  let inc = incidente({
    tipo, causaAtual: "pressao",
    ultimaEvidenciaChave: chaveDe(ativa("w5m-P1", "pressao", 5)),
  });
  for (let i = 0; i < 3; i++) {
    const r = reduzirEstadoDoAlerta(inc, obs({ tipo, causa: "pressao", ...ativa("w5m-P1", "pressao", 5) }));
    ok(`L-${tipo}${i + 1} mesma pressao no mesmo bucket nao acumula`,
      r.acao === "UPDATE" && r.campos.ocorrencias === undefined);
    inc = aplicar(inc, r);
  }
  ok(`L-${tipo}4 ocorrencias continua 1`, inc.ocorrencias === 1);

  const r1 = reduzirEstadoDoAlerta(inc, obs({ tipo, ativo: false, ...saudavel("w5m-P1", "sem_pressao") }));
  ok(`L-${tipo}5 a pressao cedendo no proprio P1 e a 1a evidencia saudavel`,
    r1.acao === "UPDATE" && r1.campos.evidenciasSaudaveisConsecutivas === 1);
  inc = aplicar(inc, r1);

  const r2 = reduzirEstadoDoAlerta(inc, obs({ tipo, ativo: false, ...saudavel("w5m-P2", "sem_pressao") }));
  ok(`L-${tipo}6 e P2 sem pressao RESOLVE`, r2.acao === "RESOLVE");
}

// --- M. Severidade sobre a mesma evidencia ---------------------------
secao("M. Severidade sobre a mesma evidencia");

{
  const inc = incidente({
    severidadeAtual: "critical", severidadeMaxima: "critical",
    ultimaEvidenciaChave: chaveDe(ativa("w5m-B1")),
  });
  const r = reduzirEstadoDoAlerta(inc, obs({ ...ativa("w5m-B1"), severidade: "warning" }));
  ok("M1  severidade pode CAIR na mesma evidencia factual",
    r.acao === "UPDATE" && r.campos.severidadeAtual === "warning");
  ok("M2  mas a maxima permanece critical",
    r.acao === "UPDATE" && r.campos.severidadeMaxima === "critical");
  ok("M3  e nada disso conta ocorrencia",
    r.acao === "UPDATE" && r.campos.ocorrencias === undefined);
}
{
  const inc = incidente({ ultimaEvidenciaChave: chaveDe(ativa("w5m-B1")) });
  const r = reduzirEstadoDoAlerta(inc, obs({ ...ativa("w5m-B1"), severidade: "critical" }));
  ok("M4  subida na mesma evidencia leva a maxima junto",
    r.acao === "UPDATE" && r.campos.severidadeMaxima === "critical" &&
    r.campos.ocorrencias === undefined);
}
{
  // SS10 — cursor_stuck: dois estados factualmente diferentes da streak
  // dentro do MESMO bucket sao fatos distintos, nao incidentes distintos.
  const inc = incidente({ tipo: "cursor_stuck", ultimaEvidenciaChave: chaveDe(ativa("w5m-B3", "stuck", 2)) });
  const r = reduzirEstadoDoAlerta(inc, obs({
    tipo: "cursor_stuck", severidade: "alert", ...ativa("w5m-B3", "stuck", 3),
  }));
  ok("M5  streak diferente no mesmo bucket e fato novo, nao ocorrencia nova",
    r.acao === "UPDATE" && r.campos.ocorrencias === undefined &&
    r.campos.ultimaEvidenciaChave === chaveDe(ativa("w5m-B3", "stuck", 3)));
  ok("M6  e a severidade do fato novo entra",
    r.acao === "UPDATE" && r.campos.severidadeAtual === "alert");
}

console.log(`\n── placar ${"─".repeat(54)}`);
console.log(`  PASS ${passou}   FAIL ${falhou}\n`);
if (falhou > 0) process.exitCode = 1;
