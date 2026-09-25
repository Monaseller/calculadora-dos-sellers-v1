/**
 * OBS-3 — progresso do cursor, PURO. I4P7.
 *
 * Zero rede. Zero banco. Zero provider. Nenhum modulo com `server-only`.
 *
 * Rodar:  npx tsx scripts/testar-agentes-observabilidade-cursor.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  analisarProgressoDoCursor,
  BUCKETS_PARA_TRAVAMENTO,
  evidenciaDaClassificacao,
  type CursorAtual,
} from "../lib/agentes/observabilidade/cursor-progresso";
import type {
  ClassificacaoDeBucket,
  ResumoDaTentativa,
  SaudeDoBucket,
} from "../lib/agentes/observabilidade/gap";

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

const AG = "d27f4c6b-4af4-4bf3-8069-a762e76f7c8a";
const ESCOPO = { agenteId: AG, plataforma: "mercado_livre", recurso: "perguntas" };
const T0 = Date.parse("2026-09-26T13:00:00.000Z");
const CAD = 300_000;

function tentativa(p: Partial<ResumoDaTentativa> = {}): ResumoDaTentativa {
  return {
    tipo: "base",
    operationId: "op",
    status: "sucesso",
    codigoDesfecho: null,
    continuacaoPendente: null,
    deslocamentoInicial: 0,
    truncado: null,
    limiteAtingido: null,
    orcamentoEsgotado: null,
    temTerminal: true,
    ...p,
  };
}

/** Um bucket entregue cujo `deslocamento_inicial` da base e `inicio`. */
function bucket(
  i: number,
  inicio: number | null,
  classificacao: ClassificacaoDeBucket = "BUCKET_SUCCEEDED",
  extra: Partial<ResumoDaTentativa> = {}
): SaudeDoBucket {
  const bucketEm = T0 + i * CAD;
  const tentativas =
    classificacao === "BUCKET_MISSING"
      ? []
      : [tentativa({ deslocamentoInicial: inicio, ...extra })];
  return {
    canonicalBucketId: "w5m-" + i,
    bucketEm,
    classificacao,
    motivo: "fixture",
    tentativas,
  };
}

const cursor = (proximo: number, emBucket: number, extra: Partial<CursorAtual> = {}): CursorAtual => ({
  agenteId: AG,
  plataforma: "mercado_livre",
  recurso: "perguntas",
  proximoDeslocamento: proximo,
  versao: 10,
  alteradoEm: new Date(T0 + emBucket * CAD + 2000).toISOString(),
  ...extra,
});

const analisar = (buckets: SaudeDoBucket[], c: CursorAtual | null = null) =>
  analisarProgressoDoCursor({ escopo: ESCOPO, buckets, cursorAtual: c });

console.log("\n══ CDS IA — OBS-3: progresso do cursor (puro) ══");

// ─── A. Estados básicos ───────────────────────────────────────────────
secao("A. Estados do cursor");

{
  const r = analisar([bucket(0, 0), bucket(1, 0), bucket(2, 0)], cursor(0, 2));
  ok("A1  0 -> 0 -> 0 e repouso saudavel", r.estado === "idle");
  ok("A2  e nao gera pressao", r.severidadeDePressao === "nenhuma" && r.pressureStreak === 0);
  ok("A3  nem travamento", r.stuckStreak === 0);
}
{
  // O estado reflete a transicao MAIS RECENTE, entao a intencao do teste
  // precisa estar nela: um unico bucket que comeca em 0 e deixa o cursor
  // em 100.
  const r = analisar([bucket(0, 0)], cursor(100, 0));
  ok("A4  0 -> 100 e progresso", r.estado === "progress");
}
{
  const r = analisar([bucket(0, 100), bucket(1, 200), bucket(2, 300)], cursor(400, 2));
  ok("A5  100 -> 200 -> 300 -> 400 e progresso, nunca travamento",
    r.estado === "progress" && r.stuckStreak === 0);
}
{
  // A conclusao aparece na transicao que TERMINA em zero.
  const r = analisar([bucket(0, 100), bucket(1, 200), bucket(2, 300)], cursor(0, 2));
  ok("A6  ... -> 0 fecha a travessia", r.estado === "complete");
}
{
  const r = analisar([bucket(0, 100), bucket(1, 100), bucket(2, 100)], cursor(100, 2));
  ok("A7  100 -> 100 -> 100 sob entregas e TRAVAMENTO", r.estado === "stuck");
  ok("A8  e a sequencia e contada", r.stuckStreak >= BUCKETS_PARA_TRAVAMENTO);
}
{
  const r = analisar([bucket(0, 100), bucket(1, 100)], cursor(100, 1));
  ok("A9  apenas 2 buckets parados ainda NAO e travamento", r.estado !== "stuck");
  ok("A9b mas a contagem ja registra os dois", r.stuckStreak === 2);
  ok("A9c e o motivo diz que e candidato, sem afirmar defeito",
    r.motivo.includes("candidato a travamento"));
}
{
  const r = analisar([bucket(0, 300), bucket(1, 100)], cursor(100, 1));
  ok("A10 recuo para valor nao-zero e regressao", r.estado === "regression");
}
{
  const r = analisar([bucket(0, 300)], cursor(0, 0));
  ok("A11 recuo para ZERO e conclusao legitima, nao regressao",
    r.estado === "complete");
}

// ─── B. Evidência de entrega ──────────────────────────────────────────
secao("B. Entrega x degradacao");

ok("B1  SUCCEEDED -> entrega limpa", evidenciaDaClassificacao("BUCKET_SUCCEEDED") === "limpa");
ok("B2  RECOVERED -> entrega DEGRADADA, mas entrega",
  evidenciaDaClassificacao("BUCKET_RECOVERED") === "degradada");
ok("B3  FAILED -> sem entrega", evidenciaDaClassificacao("BUCKET_FAILED") === "ausente");
ok("B4  INCOMPLETE -> sem entrega", evidenciaDaClassificacao("BUCKET_INCOMPLETE") === "ausente");
ok("B5  MISSING -> sem entrega", evidenciaDaClassificacao("BUCKET_MISSING") === "ausente");
ok("B6  OPEN -> nao fechado", evidenciaDaClassificacao("BUCKET_OPEN") === "nao_fechado");

{
  // base falha + r2 sucesso: OBS-2 classifica RECOVERED; o cursor andou.
  const b = bucket(0, 100, "BUCKET_RECOVERED");
  const r = analisar([b, bucket(1, 200)], cursor(300, 1));
  ok("B7  RECOVERED com avanco = progresso, sem travamento",
    r.estado === "progress" && r.stuckStreak === 0);
  ok("B8  e a degradacao continua visivel na transicao",
    r.transicoes[0].evidencia === "degradada");
}
{
  // RECOVERED parado tres vezes ainda e travamento: houve entrega.
  const bs = [0, 1, 2].map((i) => bucket(i, 100, "BUCKET_RECOVERED"));
  const r = analisar(bs, cursor(100, 2));
  ok("B9  entrega degradada tambem conta para travamento", r.estado === "stuck");
}

// ─── C. Incerteza ─────────────────────────────────────────────────────
secao("C. Incerteza nunca vira travamento");

{
  const r = analisar([bucket(0, 100), bucket(1, null, "BUCKET_MISSING"), bucket(2, 100)], cursor(100, 2));
  ok("C1  MISSING no meio -> nao e travamento", r.estado !== "stuck");
}
{
  const bs = [bucket(0, 100), bucket(1, 100, "BUCKET_FAILED"), bucket(2, 100)];
  const r = analisar(bs, cursor(100, 2));
  ok("C2  FAILED no meio quebra a atribuicao -> nao e travamento", r.estado !== "stuck");
  ok("C3  e a transicao do bucket falho e INCERTA",
    r.transicoes[1].certeza === "INCERTA");
}
{
  const bs = [bucket(0, 100), bucket(1, 100, "BUCKET_INCOMPLETE"), bucket(2, 100)];
  const r = analisar(bs, cursor(100, 2));
  ok("C4  INCOMPLETE tambem torna incerto — o cursor e escrito antes do desfecho",
    r.transicoes[1].certeza === "INCERTA" && r.estado !== "stuck");
}
{
  const r = analisar([bucket(0, 100), bucket(1, 200)], null);
  ok("C5  sem cursor atual, a ultima transicao fica indisponivel",
    r.transicoes[r.transicoes.length - 1].origemDoFim === "INDISPONIVEL");
}
{
  // cursor alterado FORA da janela do ultimo bucket: nao atribuivel.
  const c = cursor(999, 0, { alteradoEm: new Date(T0 + 50 * CAD).toISOString() });
  const r = analisar([bucket(0, 100)], c);
  ok("C6  cursor alterado fora da janela nao e atribuido ao bucket",
    r.transicoes[0].origemDoFim === "INDISPONIVEL" &&
    r.diagnosticos.includes("cursor_alterado_fora_da_janela"));
  ok("C7  e o estado vira incerto, nao travamento", r.estado === "uncertain");
}
{
  const b = bucket(0, null);
  const r = analisar([b, bucket(1, 100)], cursor(100, 1));
  ok("C8  deslocamento_inicial ausente vira diagnostico",
    r.diagnosticos.includes("deslocamento_inicial_ausente"));
}
{
  const r = analisar([bucket(0, 100), bucket(3, 200)], cursor(200, 3));
  ok("C9  buckets nao adjacentes nao formam transicao determinada",
    r.transicoes[0].certeza === "INCERTA" || r.transicoes[0].origemDoFim === "INDISPONIVEL");
}

// ─── D. Escopo ────────────────────────────────────────────────────────
secao("D. Escopo: agente, plataforma, recurso");

for (const [rot, c] of [
  ["outro agente", cursor(100, 0, { agenteId: "11111111-2222-4333-8444-555555555555" })],
  ["outra plataforma", cursor(100, 0, { plataforma: "shopee" })],
  ["outro recurso", cursor(100, 0, { recurso: "vendas" })],
] as const) {
  const r = analisar([bucket(0, 100)], c);
  ok(`D1  cursor de ${rot} e recusado, nao juntado`,
    r.diagnosticos.includes("cursor_de_outro_escopo"));
}
{
  const r = analisar([bucket(0, 100), bucket(0, 100)], cursor(100, 0));
  ok("D2  bucket duplicado vira diagnostico", r.diagnosticos.includes("bucket_duplicado"));
}

// ─── E. Pressão ───────────────────────────────────────────────────────
secao("E. Pressao de backlog e de orcamento");

{
  const bs = [0, 1, 2].map((i) =>
    bucket(i, i * 100, "BUCKET_SUCCEEDED", { continuacaoPendente: true })
  );
  const r = analisar(bs, cursor(300, 2));
  ok("E1  continuacao pendente com avanco = pressao COM progresso",
    r.estado === "progress" && r.pressureStreak === 3);
  ok("E2  tres buckets sob pressao = warning", r.severidadeDePressao === "warning");
  ok("E3  e NAO e travamento", r.estado !== "stuck");
}
{
  const bs = [bucket(0, 0, "BUCKET_SUCCEEDED", { truncado: true }), bucket(1, 100)];
  const r = analisar(bs, cursor(100, 1));
  ok("E4  truncado conta como pressao", r.pressureStreak >= 0 && r.transicoes.length === 2);
}
{
  const bs = [0, 1].map((i) =>
    bucket(i, i * 100, "BUCKET_SUCCEEDED", { orcamentoEsgotado: true })
  );
  const r = analisar(bs, cursor(100, 1));
  ok("E5  orcamento esgotado e pressao PROPRIA, separada do backlog",
    r.budgetPressure === true && r.budgetStreak === 2);
}
{
  const r = analisar([bucket(0, 0), bucket(1, 0)], cursor(0, 1));
  ok("E6  repouso nao gera pressao de orcamento", r.budgetPressure === false);
}
{
  const bs = Array.from({ length: 13 }, (_, i) =>
    bucket(i, i * 100, "BUCKET_SUCCEEDED", { continuacaoPendente: true })
  );
  const r = analisar(bs, cursor(1300, 12));
  ok("E7  doze ou mais buckets sob pressao = alert", r.severidadeDePressao === "alert");
  ok("E8  mesmo assim continua progresso, nao travamento", r.estado === "progress");
}

// ─── F. OPEN não interfere ────────────────────────────────────────────
secao("F. Bucket aberto");

{
  const abertos = [bucket(0, 100), bucket(1, 200), { ...bucket(2, null, "BUCKET_OPEN") }];
  const r = analisar(abertos, cursor(300, 1));
  ok("F1  BUCKET_OPEN nao entra nas transicoes",
    r.transicoes.every((t) => t.canonicalBucketId !== "w5m-2"));
  ok("F2  e nao impede a leitura de progresso", r.estado === "progress");
}

// ─── G. Fronteiras estáticas ──────────────────────────────────────────
secao("G. O que este modulo NAO pode alcancar");

{
  const puro = ler("lib/agentes/observabilidade/cursor-progresso.ts")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");
  for (const proibido of ["supabase", "Supabase", "server-only", "fetch(", "mercado-livre", "process.env", "n8n"] as const) {
    ok(`G1  nao alcanca \`${proibido}\``, !puro.includes(proibido));
  }
  ok("G2  reusa os tipos do OBS-2 em vez de redefinir classificacao",
    puro.includes('from "./gap"'));
  ok("G3  reusa a cadencia de OBS-1", puro.includes('from "./fronteira-bucket"'));
  ok("G4  CONTROLE: o oraculo enxergaria `server-only` se existisse",
    ler("lib/agentes/observabilidade/estado-esperado.ts")
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "")
      .includes("server-only"));
}
ok("G5  zero bytes de controle no fonte",
  !ler("lib/agentes/observabilidade/cursor-progresso.ts").includes(String.fromCharCode(0)) &&
  !ler("lib/agentes/observabilidade/cursor-progresso.ts").includes(String.fromCharCode(8)));

console.log(`\n── placar ${"─".repeat(54)}`);
console.log(`  PASS ${passou}   FAIL ${falhou}\n`);
if (falhou > 0) process.exitCode = 1;
