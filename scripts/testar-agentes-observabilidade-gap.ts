/**
 * OBS-2 — detector de gap, PURO. I4P6.
 *
 * Zero rede. Zero banco. Zero provider. Zero cursor. Nenhum modulo com
 * `server-only` e importado aqui, e isso e verificado ao final.
 *
 * Rodar:  npx tsx scripts/testar-agentes-observabilidade-gap.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  calcularSequenciaDeBucketsDegradados,
  detectarSaudeDosBuckets,
  FOLGA_DE_FECHAMENTO_MS,
  JANELA_DE_BUSCA_EM_BUCKETS,
  recomendarSeveridade,
  type EstadoEsperado,
  type LinhaDoLedger,
  type SaudeDoBucket,
} from "../lib/agentes/observabilidade/gap";
import {
  bucketDoInstante,
  instanteDoBucket,
  lerIdentidadeDeAcaoDoScheduler,
} from "../lib/agentes/observabilidade/scheduler-bucket";

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

const AG = "d27f4c6b-4af4-4bf3-8069-a762e76f7c8a";
const OUTRO_AG = "11111111-2222-4333-8444-555555555555";
const USER = "user-a";
const OUTRO_USER = "user-b";
const ACAO = "sincronizar_perguntas";

const B = (iso: string) => Date.parse(iso);
const chave = (op: string, agente = AG) => `n8n:${op}:${ACAO}:${agente}`;

let seq = 0;
function abertura(op: string, extra: Partial<LinhaDoLedger> = {}): LinhaDoLedger {
  seq++;
  return {
    userId: USER,
    requestId: "req-" + seq,
    fase: "abertura",
    status: "executando",
    idempotencyKey: chave(op),
    criadoEm: "2026-09-26T13:00:00.000Z",
    ...extra,
  };
}
function desfecho(
  req: string,
  status: string,
  extra: Partial<LinhaDoLedger> = {}
): LinhaDoLedger {
  return {
    userId: USER,
    requestId: req,
    fase: "desfecho",
    status,
    idempotencyKey: null,
    criadoEm: "2026-09-26T13:00:02.000Z",
    ...extra,
  };
}
/** Uma execucao completa: abertura + desfecho, ja pareadas. */
function execucao(op: string, status: string | null, extra: Partial<LinhaDoLedger> = {}): LinhaDoLedger[] {
  const a = abertura(op, extra);
  return status === null ? [a] : [a, desfecho(a.requestId, status, { userId: a.userId })];
}

const ATIVO = (desde: string): EstadoEsperado =>
  ({ estado: "configurado_ativo", esperadoDesde: desde });

function avaliar(linhas: LinhaDoLedger[], agora: number, desde: string, agente = AG) {
  const r = detectarSaudeDosBuckets({
    configuracao: ATIVO(desde),
    agora,
    agenteId: agente,
    linhas,
  });
  if (r.resultado !== "AVALIADO") throw new Error("esperava AVALIADO, veio " + r.resultado);
  return r;
}
const classe = (bs: readonly SaudeDoBucket[], id: string) =>
  bs.find((b) => b.canonicalBucketId === id)?.classificacao;

console.log("\n══ CDS IA — OBS-2: detector de gap (puro) ══");

// ─── A. Gramática do bucket ───────────────────────────────────────────
secao("A. Identidade e bucket canonico");

for (const [op, esperado] of [
  ["w5m-20260926T1300Z", "base"],
  ["w5m-20260926T1300Z:c1", "continuacao"],
  ["w5m-20260926T1300Z:r2", "retentativa"],
] as const) {
  const r = lerIdentidadeDeAcaoDoScheduler(chave(op));
  ok(`A1  \`${op}\` -> tipo ${esperado}`, r.ok && r.identidade.tipoDeTentativa === esperado);
  ok(`A2  \`${op}\` -> canonical w5m-20260926T1300Z`,
    r.ok && r.identidade.canonicalBucketId === "w5m-20260926T1300Z");
}

ok("A3  `diag-38` NAO e do agendador",
  (() => { const r = lerIdentidadeDeAcaoDoScheduler(chave("diag-38")); return !r.ok && r.resultado === "nao_e_do_agendador"; })());
ok("A4  bucket reservado `manual` e recusado pela gramatica",
  (() => { const r = lerIdentidadeDeAcaoDoScheduler(chave("manual")); return !r.ok; })());
ok("A5  outro provedor nao conta",
  (() => { const r = lerIdentidadeDeAcaoDoScheduler(`outro:w5m-20260926T1300Z:${ACAO}:${AG}`); return !r.ok && r.resultado === "nao_e_do_agendador"; })());
ok("A6  chave sem partes suficientes e invalida",
  (() => { const r = lerIdentidadeDeAcaoDoScheduler("n8n:w5m-20260926T1300Z"); return !r.ok && r.resultado === "invalida"; })());
ok("A7  sufixo desconhecido e invalido",
  (() => { const r = lerIdentidadeDeAcaoDoScheduler(chave("w5m-20260926T1300Z:x9")); return !r.ok && r.resultado === "invalida"; })());
ok("A8  `:r1` e recusado (tentativa redundante)",
  (() => { const r = lerIdentidadeDeAcaoDoScheduler(chave("w5m-20260926T1300Z:r1")); return !r.ok; })());
ok("A9  null/vazio nao lanca",
  !lerIdentidadeDeAcaoDoScheduler(null).ok && !lerIdentidadeDeAcaoDoScheduler("").ok);
ok("A10 acao com maiuscula e invalida",
  (() => { const r = lerIdentidadeDeAcaoDoScheduler(`n8n:w5m-20260926T1300Z:Sincronizar:${AG}`); return !r.ok && r.resultado === "invalida"; })());

secao("B. instanteDoBucket, estrito");

ok("B1  bucket valido devolve o instante UTC",
  instanteDoBucket("w5m-20260926T1300Z") === B("2026-09-26T13:00:00.000Z"));
ok("B2  minuto fora da cadencia reprova", instanteDoBucket("w5m-20260926T1307Z") === null);
ok("B3  mes 13 reprova", instanteDoBucket("w5m-20261326T1300Z") === null);
ok("B4  31 de fevereiro reprova — sem normalizacao silenciosa",
  instanteDoBucket("w5m-20260231T1300Z") === null);
ok("B5  hora 24 reprova", instanteDoBucket("w5m-20260926T2400Z") === null);
ok("B6  prefixo parecido reprova", instanteDoBucket("w5m2-20260926T1300Z") === null);
ok("B7  sem o Z final reprova", instanteDoBucket("w5m-20260926T1300") === null);
ok("B8  ida e volta e estavel",
  bucketDoInstante(B("2026-09-26T13:05:00.000Z")) === "w5m-20260926T1305Z");

// ─── C. Fronteira de fechamento ───────────────────────────────────────
secao("C. OPEN x CLOSED_EXPECTED (off-by-one)");

{
  const bk = B("2026-09-26T13:00:00.000Z");
  const desde = "2026-09-26T13:00:00.000Z";
  const quase = avaliar([], bk + FOLGA_DE_FECHAMENTO_MS - 1, desde);
  ok("C1  B + 299999 ms ainda e OPEN",
    classe(quase.buckets, "w5m-20260926T1300Z") === "BUCKET_OPEN");
  const fechou = avaliar([], bk + FOLGA_DE_FECHAMENTO_MS, desde);
  ok("C2  B + 300000 ms ja e cobravel -> MISSING",
    classe(fechou.buckets, "w5m-20260926T1300Z") === "BUCKET_MISSING");
  ok("C3  a folga e 300000 ms", FOLGA_DE_FECHAMENTO_MS === 300_000);
}

secao("D. expectedFrom");

{
  const agora = B("2026-09-26T13:20:00.000Z");
  const r = avaliar([], agora, "2026-09-26T13:00:00.000Z");
  const ids = r.buckets.map((b) => b.canonicalBucketId);
  ok("D1  bucket anterior a esperadoDesde e IGNORADO",
    !ids.includes("w5m-20260926T1255Z"));
  ok("D2  o proprio esperadoDesde e avaliado", ids.includes("w5m-20260926T1300Z"));
  // As 13:20 o bucket 13:15 fecha EXATAMENTE na fronteira (13:15+300000),
  // entao quem ainda esta aberto e o 13:20.
  ok("D3  bucket ainda dentro da folga aparece como OPEN",
    classe(r.buckets, "w5m-20260926T1320Z") === "BUCKET_OPEN");
  ok("D3b e o bucket que fechou na fronteira ja e cobravel",
    classe(r.buckets, "w5m-20260926T1315Z") === "BUCKET_MISSING");
}

// ─── E. Classificação ─────────────────────────────────────────────────
secao("E. Classificacao por bucket");

const AGORA = B("2026-09-26T13:10:00.000Z");
const DESDE = "2026-09-26T13:00:00.000Z";
const BK = "w5m-20260926T1300Z";

{
  const r = avaliar(execucao(BK, "sucesso"), AGORA, DESDE);
  ok("E1  base com sucesso -> SUCCEEDED", classe(r.buckets, BK) === "BUCKET_SUCCEEDED");
}
{
  const r = avaliar(execucao(BK, null), AGORA, DESDE);
  ok("E2  abertura sem desfecho -> INCOMPLETE", classe(r.buckets, BK) === "BUCKET_INCOMPLETE");
}
{
  const r = avaliar(execucao(BK, "erro"), AGORA, DESDE);
  ok("E3  desfecho de erro -> FAILED", classe(r.buckets, BK) === "BUCKET_FAILED");
}
{
  const r = avaliar(execucao(BK, "negado"), AGORA, DESDE);
  ok("E4  desfecho negado -> FAILED", classe(r.buckets, BK) === "BUCKET_FAILED");
}
{
  const r = avaliar(execucao(BK, "parcial"), AGORA, DESDE);
  ok("E5  parcial conta como entregue -> SUCCEEDED", classe(r.buckets, BK) === "BUCKET_SUCCEEDED");
}
{
  const linhas = [...execucao(BK, "erro"), ...execucao(BK + ":r2", "sucesso")];
  const r = avaliar(linhas, AGORA, DESDE);
  ok("E6  base falha + r2 sucesso -> RECOVERED (um bucket, nao dois)",
    classe(r.buckets, BK) === "BUCKET_RECOVERED" &&
    r.buckets.filter((b) => b.canonicalBucketId === BK).length === 1);
}
{
  const linhas = [...execucao(BK, "parcial"), ...execucao(BK + ":c1", "sucesso")];
  const r = avaliar(linhas, AGORA, DESDE);
  ok("E7  base + c1 ambos entregues -> SUCCEEDED, um unico bucket",
    classe(r.buckets, BK) === "BUCKET_SUCCEEDED" &&
    r.buckets.find((b) => b.canonicalBucketId === BK)!.tentativas.length === 2);
}
{
  const linhas = [...execucao(BK, "sucesso"), ...execucao(BK + ":c1", "erro")];
  const r = avaliar(linhas, AGORA, DESDE);
  ok("E8  base sucesso + c1 falha -> RECOVERED (entregue, mas nao pelo caminho feliz)",
    classe(r.buckets, BK) === "BUCKET_RECOVERED");
}
{
  const linhas = execucao(BK, "sucesso", {});
  linhas[1] = { ...linhas[1], continuacaoPendente: true };
  const r = avaliar(linhas, AGORA, DESDE);
  ok("E9  sucesso com continuacao PENDENTE continua SUCCEEDED — o cursor retoma",
    classe(r.buckets, BK) === "BUCKET_SUCCEEDED");
  ok("E9b e a pendencia viaja no resumo, para o detector de backlog",
    r.buckets.find((b) => b.canonicalBucketId === BK)!.tentativas[0].continuacaoPendente === true);
}
{
  const r = avaliar(execucao(BK, "aguardando_aprovacao"), AGORA, DESDE);
  ok("E10 aguardando_aprovacao nao e entrega -> FAILED",
    classe(r.buckets, BK) === "BUCKET_FAILED");
}

// ─── F. Falsos heartbeats ─────────────────────────────────────────────
secao("F. Nenhum heartbeat falso");

{
  const r = avaliar(execucao("diag-99", "sucesso"), AGORA, DESDE);
  ok("F1  `diag-*` nao produz bucket algum", classe(r.buckets, BK) === "BUCKET_MISSING");
}
{
  const a = abertura(BK, { userId: OUTRO_USER });
  const t = desfecho(a.requestId, "sucesso", { userId: USER });
  const r = avaliar([a, t], AGORA, DESDE);
  ok("F2  desfecho de OUTRO tenant nao fecha a abertura -> INCOMPLETE",
    classe(r.buckets, BK) === "BUCKET_INCOMPLETE");
  ok("F2b e o terminal vira desfecho orfao",
    r.achados.some((x) => x.diagnostico === "desfecho_orfao"));
}
{
  const t = desfecho("req-solto", "sucesso");
  const r = avaliar([t], AGORA, DESDE);
  ok("F3  desfecho orfao nao cria heartbeat", classe(r.buckets, BK) === "BUCKET_MISSING");
}
{
  const linhas = execucao(BK, "sucesso");
  const r = avaliar([...linhas, { ...linhas[0], requestId: linhas[0].requestId }], AGORA, DESDE);
  ok("F4  abertura duplicada e denunciada, nao contada duas vezes",
    r.achados.some((x) => x.diagnostico === "abertura_duplicada") &&
    r.buckets.find((b) => b.canonicalBucketId === BK)!.tentativas.length === 1);
}
{
  const r = avaliar(execucao(BK, "sucesso"), AGORA, DESDE, OUTRO_AG);
  ok("F5  bucket de outro AGENTE nao conta", classe(r.buckets, BK) === "BUCKET_MISSING");
}
{
  const a = abertura(BK, { idempotencyKey: "n8n::" + ACAO + ":" + AG });
  const r = avaliar([a], AGORA, DESDE);
  ok("F6  chave malformada vira achado, nao excecao",
    r.achados.some((x) => x.diagnostico === "chave_invalida"));
}

// ─── G. Sequências ────────────────────────────────────────────────────
secao("G. Sequencias por bucket canonico");

{
  // Quatro buckets fechados, todos ausentes.
  const agora = B("2026-09-26T13:25:00.000Z");
  const r = avaliar([], agora, "2026-09-26T13:00:00.000Z");
  const s = calcularSequenciaDeBucketsDegradados(r.buckets);
  ok("G1  quatro ausentes consecutivos sao contados", s.consecutiveMissing >= 3);
  ok("G2  degradados acompanham", s.consecutiveAnyDegraded === s.consecutiveMissing);
  ok("G3  severidade de 3+ ausentes e critical",
    recomendarSeveridade(s).missing === "critical");
}
{
  // 13:07 fecha SOMENTE o bucket 13:00; o 13:05 ainda esta aberto e nao
  // pode ser cobrado — usar 13:10 faria o 13:05 virar MISSING e mascarar
  // o que este teste mede.
  const agora = B("2026-09-26T13:07:00.000Z");
  const r = avaliar(execucao("w5m-20260926T1300Z", "sucesso"), agora, "2026-09-26T13:00:00.000Z");
  const s = calcularSequenciaDeBucketsDegradados(r.buckets);
  ok("G4  bucket saudavel zera a sequencia", s.consecutiveMissing === 0);
  ok("G5  e a severidade e nenhuma", recomendarSeveridade(s).missing === "nenhuma");
}
{
  // base + r2 no MESMO bucket nao viram dois degradados.
  const agora = B("2026-09-26T13:07:00.000Z");
  const linhas = [...execucao(BK, "erro"), ...execucao(BK + ":r2", "erro")];
  const r = avaliar(linhas, agora, DESDE);
  const s = calcularSequenciaDeBucketsDegradados(r.buckets);
  ok("G6  duas tentativas falhas contam UM bucket falho", s.consecutiveFailed === 1);
  ok("G7  e um unico FAILED ja e alert", recomendarSeveridade(s).failed === "alert");
}
{
  const agora = B("2026-09-26T14:00:00.000Z");
  const r = avaliar([], agora, "2026-09-26T13:00:00.000Z");
  const s = calcularSequenciaDeBucketsDegradados(r.buckets);
  ok("G8  a janela e limitada a JANELA_DE_BUSCA_EM_BUCKETS",
    r.buckets.filter((b) => b.classificacao !== "BUCKET_OPEN").length <= JANELA_DE_BUSCA_EM_BUCKETS);
  ok("G9  sequencia que preenche a janela e marcada como truncada",
    s.truncadaPelaJanela === true);
}
ok("G10 a janela cobre o limiar critico com folga de fronteira",
  JANELA_DE_BUSCA_EM_BUCKETS >= 4);

// ─── H. Configuração ──────────────────────────────────────────────────
secao("H. Estado de configuracao");

for (const [estado, esperado] of [
  ["configuracao_ausente", "MONITOR_CONFIGURATION_MISSING"],
  ["configurado_inativo", "MONITOR_NOT_EXPECTED"],
  ["falhou_leitura", "MONITOR_CONFIG_UNREADABLE"],
] as const) {
  const r = detectarSaudeDosBuckets({
    configuracao: { estado } as EstadoEsperado,
    agora: AGORA,
    agenteId: AG,
    linhas: [],
  });
  ok(`H1  ${estado} -> ${esperado}`, r.resultado === esperado);
}
{
  // O invariante que importa: as duas configuracoes produzem resultados
  // DIFERENTES. Comparar os literais seria tautologia; comparar as saidas
  // do detector prova que ele nao colapsa os dois casos.
  const ausente = detectarSaudeDosBuckets({
    configuracao: { estado: "configuracao_ausente" }, agora: AGORA, agenteId: AG, linhas: [],
  });
  const inativa = detectarSaudeDosBuckets({
    configuracao: { estado: "configurado_inativo" }, agora: AGORA, agenteId: AG, linhas: [],
  });
  ok("H2  ausente e inativa produzem resultados DIFERENTES",
    ausente.resultado !== inativa.resultado);
}

// ─── I. Fronteiras estáticas ──────────────────────────────────────────
secao("I. O que estes modulos NAO podem alcancar");

const FONTES = [
  "lib/agentes/observabilidade/gap.ts",
  "lib/agentes/observabilidade/scheduler-bucket.ts",
] as const;
for (const f of FONTES) {
  const puro = ler(f).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
  ok(`I1  ${f} nao importa Supabase`, !puro.includes("supabase") && !puro.includes("Supabase"));
  ok(`I2  ${f} nao carrega server-only`, !puro.includes("server-only"));
  ok(`I3  ${f} nao faz rede`, !puro.includes("fetch("));
  ok(`I4  ${f} nao alcanca provider nem cursor`,
    !puro.includes("mercado-livre") && !puro.includes("continuacao-perguntas"));
}
ok("I5  CONTROLE: o oraculo enxergaria `server-only` se ele existisse",
  ler("lib/agentes/observabilidade/estado-esperado.ts")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "")
    .includes("server-only"));
ok("I6  o parser de bucket REUSA a gramatica de operationId",
  ler("lib/agentes/observabilidade/scheduler-bucket.ts").includes("lerIdentidadeDaOperacao"));
ok("I7  e reusa a fronteira de OBS-1 em vez de duplicar a regra",
  ler("lib/agentes/observabilidade/scheduler-bucket.ts").includes("alinhadoAoBucket"));

console.log(`\n── placar ${"─".repeat(54)}`);
console.log(`  PASS ${passou}   FAIL ${falhou}\n`);
if (falhou > 0) process.exitCode = 1;
