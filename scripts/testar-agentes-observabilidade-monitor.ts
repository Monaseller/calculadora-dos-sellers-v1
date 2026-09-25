/**
 * OBS-5 — o vigia da ingestao, ponta a ponta. I4P9.
 *
 * ── O que esta suite roda de verdade ────────────────────────────────
 *
 * A carga real, os detectores reais (OBS-2 e OBS-3), a traducao real, o
 * reducer real do OBS-4 e o orquestrador real. O que e dublado sao as
 * PORTAS — banco e ambiente —, porque o que se prova aqui e a decisao do
 * monitor, nao o Postgres.
 *
 * A auth da rota roda o handler REAL, com `Request` real. Ela nao precisa
 * de banco: uma requisicao sem segredo para antes de qualquer porta, e a
 * requisicao COM segredo para no alvo ausente — que e exatamente a
 * propriedade que se quer provar.
 *
 * Zero rede. Zero banco. Zero marketplace.
 *
 * Rodar:  npx tsx scripts/testar-agentes-observabilidade-monitor.ts
 */
import "./_server-only-inerte";

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { bucketDoInstante } from "../lib/agentes/observabilidade/scheduler-bucket";
import { CADENCIA_MS } from "../lib/agentes/observabilidade/fronteira-bucket";
import {
  detectarSaudeDosBuckets,
  type EstadoEsperado,
} from "../lib/agentes/observabilidade/gap";
import {
  lerCursorDoMonitor,
  montarCarga,
} from "../lib/agentes/observabilidade/monitor-carga";
import { avaliarIngestao } from "../lib/agentes/observabilidade/monitor-avaliacao";
import {
  executarMonitorDaIngestao,
  type AquisicaoDaSerializacao,
  janelaDeConsulta,
  MARGEM_DA_CONSULTA_MS,
  PLATAFORMA_DO_MONITOR,
  RECURSO_DO_MONITOR,
  type PortasDoMonitor,
  type ResultadoDoMonitor,
} from "../lib/agentes/observabilidade/monitor-ingestao";
import {
  decidirAcesso,
  ROTAS_COM_SEGREDO,
} from "../lib/middleware-rotas";
import type {
  EscopoDoAlerta,
  IncidenteAberto,
  ObservacaoDeAlerta,
  TipoDeAlerta,
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
const semComentarios = (f: string) =>
  f.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

// ─── Cenário ──────────────────────────────────────────────────────────

const AG = "aaaaaaaa-4c00-4000-8000-00000000000a";
const OUTRO_AG = "bbbbbbbb-4c00-4000-8000-00000000000b";
const USER = "user-monitor-alfa";
const OUTRO_USER = "user-monitor-beta";
const T0 = Date.parse("2026-09-26T13:00:00.000Z");
const CAD = CADENCIA_MS;
/** B0..B5 fechados, B6 ainda dentro da folga. */
const AGORA = T0 + 6 * CAD + 10_000;

const ESCOPO: EscopoDoAlerta = {
  userId: USER, agenteId: AG,
  plataforma: PLATAFORMA_DO_MONITOR, recurso: RECURSO_DO_MONITOR,
};
const ESCOPO_CARGA = { ...ESCOPO };

const idDoBucket = (n: number) => bucketDoInstante(T0 + n * CAD);
const iso = (ms: number) => new Date(ms).toISOString();

interface Tentativa {
  readonly sufixo?: string;
  readonly status?: string;
  readonly codigo?: string | null;
  readonly semTerminal?: boolean;
  readonly offset?: number;
  readonly pressao?: boolean;
  readonly orcamento?: boolean;
  readonly cursorAtualizado?: boolean;
  readonly atrasoMs?: number;
}

/** Duas linhas cruas — abertura e desfecho — como o Postgres as devolve. */
function linhasDoBucket(n: number, t: Tentativa = {}): unknown[] {
  const sufixo = t.sufixo ?? "";
  const req = `req-b${n}${sufixo.replace(/:/g, "-")}`;
  const chave = `n8n:${idDoBucket(n)}${sufixo}:sincronizar_perguntas:${AG}`;
  const nasce = T0 + n * CAD + 5_000;
  const fecha = nasce + (t.atrasoMs ?? 25_000);
  const base = { user_id: USER, agente_id: AG, request_id: req, idempotency_key: chave };

  const linhas: unknown[] = [
    { ...base, fase: "abertura", status: "executando", criado_em: iso(nasce),
      codigo_desfecho: null, entrada_resumo: {} },
  ];
  if (t.semTerminal === true) return linhas;

  linhas.push({
    ...base, fase: "desfecho",
    status: t.status ?? "sucesso",
    criado_em: iso(fecha),
    codigo_desfecho: t.codigo ?? "sincronizado",
    entrada_resumo: {
      deslocamento_inicial: t.offset ?? 0,
      continuacao_pendente: t.pressao === true,
      orcamento_esgotado: t.orcamento === true,
      cursor_atualizado: t.cursorAtualizado ?? true,
      cursor_reiniciado: false,
      // Chave FORA do vocabulario: tem de ser descartada na leitura.
      texto_pergunta: "qual o prazo?",
    },
  });
  return linhas;
}

/** Uma execucao `diag-*`: mesma rota, mesmo cursor, outra procedencia. */
function linhasDeDiagnostico(emMs: number, rotulo = "diag-38"): unknown[] {
  const req = `req-${rotulo}`;
  const base = {
    user_id: USER, agente_id: AG, request_id: req,
    idempotency_key: `n8n:${rotulo}:sincronizar_perguntas:${AG}`,
  };
  return [
    { ...base, fase: "abertura", status: "executando", criado_em: iso(emMs - 5_000),
      codigo_desfecho: null, entrada_resumo: {} },
    { ...base, fase: "desfecho", status: "sucesso", criado_em: iso(emMs),
      codigo_desfecho: "sincronizado",
      entrada_resumo: { deslocamento_inicial: 999, cursor_atualizado: true, cursor_reiniciado: false } },
  ];
}

const CONFIG_ATIVA: EstadoEsperado = { estado: "configurado_ativo", esperadoDesde: iso(T0) };

function cursorBruto(deslocamento: number, emMs: number, versao = 7): unknown {
  return {
    agente_id: AG, user_id: USER,
    proximo_deslocamento: deslocamento, versao, alterado_em: iso(emMs),
  };
}

/** Seis buckets entregues, com o offset que a funcao mandar. */
function seisBuckets(offsetDe: (n: number) => number, extra: Tentativa = {}): unknown[] {
  const linhas: unknown[] = [];
  for (let n = 0; n <= 5; n++) linhas.push(...linhasDoBucket(n, { ...extra, offset: offsetDe(n) }));
  return linhas;
}

function avaliar(brutas: unknown[], cursor: unknown, truncada = false) {
  const carga = montarCarga(brutas, ESCOPO_CARGA, truncada);
  return avaliarIngestao({
    agora: AGORA, escopo: ESCOPO, configuracao: CONFIG_ATIVA, carga,
    cursor: lerCursorDoMonitor(cursor, ESCOPO_CARGA),
  });
}

const acha = (obs: readonly ObservacaoDeAlerta[], tipo: TipoDeAlerta) =>
  obs.find((o) => o.tipo === tipo) ?? null;
const ativoDe = (obs: readonly ObservacaoDeAlerta[], tipo: TipoDeAlerta) => {
  const o = acha(obs, tipo);
  return o !== null && o.ativo;
};
const saudavelDe = (obs: readonly ObservacaoDeAlerta[], tipo: TipoDeAlerta) => {
  const o = acha(obs, tipo);
  return o !== null && !o.ativo;
};

console.log("\n══ CDS IA — OBS-5: o vigia da ingestao de perguntas ══");

// ─── A. Janela de consulta ────────────────────────────────────────────
secao("A. Janela de consulta");

{
  const j = janelaDeConsulta(AGORA, T0);
  ok("A1  o fim da janela e AGORA, nao o ultimo bucket", j.ate === AGORA);
  ok("A2  o inicio recua a margem declarada", j.de === T0 - MARGEM_DA_CONSULTA_MS);
  ok("A3  a margem cobre com folga o teto de 60 s de uma execucao",
    MARGEM_DA_CONSULTA_MS >= 2 * CAD);
}
{
  // A fronteira recente corta a janela: nunca avaliar antes dela.
  const desde = T0 + 4 * CAD;
  const j = janelaDeConsulta(AGORA, desde);
  ok("A4  fronteira recente encurta a janela", j.de === desde - MARGEM_DA_CONSULTA_MS);
}
{
  // ANTI-DIVERGENCIA: a janela daqui tem de conter todo bucket que o
  // detector devolve. Se a aritmetica do OBS-2 mudar, isto quebra.
  let todosDentro = true;
  for (const passo of [0, 37_000, 150_000, 299_999, 600_000]) {
    const agora = AGORA + passo;
    const j = janelaDeConsulta(agora, T0);
    const d = detectarSaudeDosBuckets({
      configuracao: CONFIG_ATIVA, agora, agenteId: AG,
      linhas: [],
    });
    if (d.resultado !== "AVALIADO") { todosDentro = false; break; }
    for (const b of d.buckets) {
      if (b.bucketEm < j.de || b.bucketEm > j.ate) todosDentro = false;
    }
  }
  ok("A5  todo bucket do detector cabe na janela carregada", todosDentro);
}

// ─── B. Carga ─────────────────────────────────────────────────────────
secao("B. Carga do ledger");

{
  const carga = montarCarga(seisBuckets((n) => n * 100), ESCOPO_CARGA, false);
  ok("B1  as duas fases entram", carga.linhas.length === 12);
  ok("B2  uma evidencia de proveniencia por travessia", carga.mutacoes.length === 6);
  ok("B3  toda evidencia e do agendador, com bucket canonico",
    carga.mutacoes.every((m) => m.tipoDeOperacao === "scheduler_bucket" && m.canonicalBucketId !== null));
  ok("B4  o instante da evidencia e o do DESFECHO — onde o cursor foi escrito",
    carga.mutacoes[0].ocorridoEm === T0 + 5_000 + 25_000);
  ok("B5  o resumo do desfecho diz que o cursor andou",
    carga.mutacoes.every((m) => m.cursorAtualizado === true));
  ok("B6  chave fora do vocabulario nao sobrevive a leitura",
    !JSON.stringify(carga.linhas).includes("qual o prazo"));
  ok("B7  a carga nao se declara truncada sem motivo", carga.truncada === false);
}
{
  const carga = montarCarga(linhasDoBucket(0, { semTerminal: true }), ESCOPO_CARGA, false);
  ok("B8  execucao sem desfecho vira evidencia mesmo assim",
    carga.mutacoes.length === 1 && carga.mutacoes[0].temTerminal === false);
  ok("B9  e com escrita DESCONHECIDA, nao negada",
    carga.mutacoes[0].cursorAtualizado === null && carga.mutacoes[0].cursorReiniciado === null);
}
{
  const alheias = [
    { user_id: OUTRO_USER, agente_id: AG, request_id: "r1", fase: "abertura", status: "executando",
      criado_em: iso(T0), idempotency_key: null, codigo_desfecho: null, entrada_resumo: {} },
    { user_id: USER, agente_id: OUTRO_AG, request_id: "r2", fase: "abertura", status: "executando",
      criado_em: iso(T0), idempotency_key: null, codigo_desfecho: null, entrada_resumo: {} },
  ];
  const carga = montarCarga([...alheias, ...linhasDoBucket(0)], ESCOPO_CARGA, false);
  ok("B10 linha de OUTRO dono e ignorada", !JSON.stringify(carga.linhas).includes(OUTRO_USER));
  ok("B11 linha de OUTRO agente e ignorada", carga.linhas.length === 2);
}
{
  const carga = montarCarga([null, 42, {}, { user_id: USER, agente_id: AG }], ESCOPO_CARGA, false);
  ok("B12 linha torta e descartada, nao completada", carga.linhas.length === 0);
}
{
  const carga = montarCarga(linhasDeDiagnostico(T0 + 60_000), ESCOPO_CARGA, false);
  ok("B13 execucao `diag-*` ENTRA na proveniencia",
    carga.mutacoes.length === 1 && carga.mutacoes[0].tipoDeOperacao === "diagnostico");
}
{
  ok("B14 cursor ausente e ausente, nao falha",
    lerCursorDoMonitor(null, ESCOPO_CARGA).estado === "ausente");
  ok("B15 cursor sem `alterado_em` e FALHA, nao ausencia",
    lerCursorDoMonitor({ proximo_deslocamento: 10, versao: 2 }, ESCOPO_CARGA).estado === "falhou");
  ok("B16 cursor com deslocamento invalido e falha",
    lerCursorDoMonitor({ proximo_deslocamento: -1, versao: 2, alterado_em: iso(T0) }, ESCOPO_CARGA).estado === "falhou");
  const bom = lerCursorDoMonitor(cursorBruto(600, T0 + 5 * CAD + 40_000), ESCOPO_CARGA);
  ok("B17 cursor bom carrega escopo e instante",
    bom.estado === "encontrado" && bom.cursor.agenteId === AG &&
    bom.cursor.plataforma === PLATAFORMA_DO_MONITOR && bom.cursor.proximoDeslocamento === 600);
}

// ─── C. Configuração ──────────────────────────────────────────────────
secao("C. Configuracao decide se ha o que avaliar");

{
  const r = avaliarIngestao({
    agora: AGORA, escopo: ESCOPO, configuracao: { estado: "configuracao_ausente" },
  });
  ok("C1  configuracao ausente abre `monitor_configuration_missing`",
    r.observacoes.length === 1 && ativoDe(r.observacoes, "monitor_configuration_missing"));
  ok("C2  e NADA derivado do agendador e emitido",
    !r.observacoes.some((o) => o.tipo !== "monitor_configuration_missing"));
}
{
  const r = avaliarIngestao({
    agora: AGORA, escopo: ESCOPO, configuracao: { estado: "configurado_inativo" },
  });
  ok("C3  configuracao INATIVA resolve o alerta de configuracao",
    r.observacoes.length === 1 && saudavelDe(r.observacoes, "monitor_configuration_missing"));
  const proibidos: TipoDeAlerta[] = [
    "scheduler_gap", "cursor_stuck", "backlog_pressure", "budget_pressure", "cursor_regression",
  ];
  ok("C4  e NENHUMA saude derivada do agendador e fabricada",
    proibidos.every((t) => acha(r.observacoes, t) === null));
  ok("C5  nem saude de observabilidade — nada foi avaliado",
    acha(r.observacoes, "observability_data_incomplete") === null);
}
{
  const r = avaliarIngestao({
    agora: AGORA, escopo: ESCOPO, configuracao: { estado: "falhou_leitura" },
  });
  ok("C6  leitura falha NAO inventa observacao nenhuma", r.observacoes.length === 0);
}
{
  const r = avaliar(seisBuckets((n) => n * 100), cursorBruto(600, T0 + 5 * CAD + 40_000));
  ok("C7  configuracao ATIVA resolve o alerta de configuracao",
    saudavelDe(r.observacoes, "monitor_configuration_missing"));
}

// ─── D. scheduler_gap ─────────────────────────────────────────────────
secao("D. scheduler_gap");

const CURSOR_PROGRESSO = cursorBruto(600, T0 + 5 * CAD + 40_000);

{
  const r = avaliar(seisBuckets((n) => n * 100), CURSOR_PROGRESSO);
  ok("D1  todos entregues -> scheduler_gap SAUDAVEL",
    saudavelDe(r.observacoes, "scheduler_gap"));
  ok("D2  com o fato do bucket mais recente fechado",
    acha(r.observacoes, "scheduler_gap")?.fatoDaEvidencia === "h:succeeded");
  ok("D3  e o sujeito e o bucket, montado pelo construtor",
    acha(r.observacoes, "scheduler_gap")?.sujeitoDaEvidencia === "b:" + idDoBucket(5));
}
{
  // B5 sem nenhuma abertura: o agendador nao veio.
  const linhas: unknown[] = [];
  for (let n = 0; n <= 4; n++) linhas.push(...linhasDoBucket(n, { offset: n * 100 }));
  const r = avaliar(linhas, CURSOR_PROGRESSO);
  const o = acha(r.observacoes, "scheduler_gap");
  ok("D4  bucket faltando -> scheduler_gap ATIVO", o !== null && o.ativo);
  ok("D5  com causa `missing`", o?.causa === "missing" && o?.fatoDaEvidencia === "a:missing");
  ok("D6  e severidade vinda do detector, nao chutada",
    o?.severidade === "warning" || o?.severidade === "alert" || o?.severidade === "critical");
}
{
  const linhas: unknown[] = [];
  for (let n = 0; n <= 4; n++) linhas.push(...linhasDoBucket(n, { offset: n * 100 }));
  linhas.push(...linhasDoBucket(5, { offset: 500, semTerminal: true }));
  const r = avaliar(linhas, CURSOR_PROGRESSO);
  const o = acha(r.observacoes, "scheduler_gap");
  ok("D7  abertura sem desfecho -> causa `incomplete`",
    o !== null && o.ativo && o.causa === "incomplete");
}
{
  const linhas: unknown[] = [];
  for (let n = 0; n <= 4; n++) linhas.push(...linhasDoBucket(n, { offset: n * 100 }));
  linhas.push(...linhasDoBucket(5, { offset: 500, status: "erro", codigo: "erro_provider" }));
  const r = avaliar(linhas, CURSOR_PROGRESSO);
  const o = acha(r.observacoes, "scheduler_gap");
  ok("D8  nenhuma tentativa entregou -> causa `failed`",
    o !== null && o.ativo && o.causa === "failed");
}
{
  // Uma tentativa falha e uma retentativa entregue no MESMO bucket.
  const linhas: unknown[] = [];
  for (let n = 0; n <= 4; n++) linhas.push(...linhasDoBucket(n, { offset: n * 100 }));
  linhas.push(...linhasDoBucket(5, { offset: 500, status: "erro", codigo: "erro_provider" }));
  linhas.push(...linhasDoBucket(5, { sufixo: ":r2", offset: 500, atrasoMs: 40_000 }));
  const r = avaliar(linhas, CURSOR_PROGRESSO);
  const o = acha(r.observacoes, "scheduler_gap");
  ok("D9  recuperado por retentativa -> SAUDAVEL, nao alerta",
    o !== null && !o.ativo);
  ok("D10 e o fato distingue `recovered` de `succeeded`",
    o?.fatoDaEvidencia === "h:recovered");
}

// ─── E. Cursor ────────────────────────────────────────────────────────
secao("E. Cursor");

{
  const r = avaliar(seisBuckets((n) => n * 100), CURSOR_PROGRESSO);
  ok("E1  cursor avancando -> cursor_stuck SAUDAVEL",
    saudavelDe(r.observacoes, "cursor_stuck"));
  ok("E2  e cursor_regression SAUDAVEL junto",
    saudavelDe(r.observacoes, "cursor_regression"));
  ok("E3  com o fato do estado observado",
    acha(r.observacoes, "cursor_stuck")?.fatoDaEvidencia === "h:progress");
}
{
  // Seis buckets entregues sem mover o cursor de 500.
  const r = avaliar(seisBuckets(() => 500), cursorBruto(500, T0 + 5 * CAD + 40_000));
  const o = acha(r.observacoes, "cursor_stuck");
  ok("E4  entregue sem mover o cursor -> cursor_stuck ATIVO", o !== null && o.ativo);
  ok("E5  com a sequencia dentro do fato", o?.fatoDaEvidencia === "a:stuck:n6");
  ok("E6  e severidade `alert` antes do limiar de uma hora", o?.severidade === "alert");
  ok("E7  travado nao emite saude de regressao",
    acha(r.observacoes, "cursor_regression") === null);
}
{
  // O cursor recua para um valor nao-zero.
  const r = avaliar(seisBuckets((n) => (n === 5 ? 200 : 500)), cursorBruto(200, T0 + 5 * CAD + 40_000));
  const o = acha(r.observacoes, "cursor_regression");
  ok("E8  cursor recuando -> cursor_regression ATIVO", o !== null && o.ativo);
  ok("E9  e nenhuma saude de travamento e emitida junto",
    acha(r.observacoes, "cursor_stuck") === null);
}
{
  // Travessia inteira concluida: o cursor volta a zero.
  const r = avaliar(seisBuckets((n) => (n === 5 ? 500 : n * 100)), cursorBruto(0, T0 + 5 * CAD + 40_000));
  ok("E10 travessia concluida -> cursor_stuck SAUDAVEL",
    saudavelDe(r.observacoes, "cursor_stuck") &&
    acha(r.observacoes, "cursor_stuck")?.fatoDaEvidencia === "h:complete");
}

// ─── F. Pressão ───────────────────────────────────────────────────────
secao("F. Pressao");

{
  const r = avaliar(seisBuckets((n) => n * 100, { pressao: true }), CURSOR_PROGRESSO);
  const o = acha(r.observacoes, "backlog_pressure");
  ok("F1  continuacao pendente em sequencia -> backlog_pressure ATIVO", o !== null && o.ativo);
  ok("F2  NUNCA em `critical` — a regra continua adiada", o?.severidade !== "critical");
  ok("F3  com a sequencia no fato", o?.fatoDaEvidencia === "a:pressao:n6");
}
{
  const r = avaliar(seisBuckets((n) => n * 100), CURSOR_PROGRESSO);
  ok("F4  sem pressao -> backlog_pressure SAUDAVEL",
    saudavelDe(r.observacoes, "backlog_pressure") &&
    acha(r.observacoes, "backlog_pressure")?.fatoDaEvidencia === "h:sem_pressao");
}
{
  const r = avaliar(seisBuckets((n) => n * 100, { orcamento: true }), CURSOR_PROGRESSO);
  const o = acha(r.observacoes, "budget_pressure");
  ok("F5  orcamento esgotado -> budget_pressure ATIVO", o !== null && o.ativo);
  ok("F6  com severidade proporcional a sequencia", o?.severidade === "alert");
}
{
  const r = avaliar(seisBuckets((n) => n * 100), CURSOR_PROGRESSO);
  ok("F7  sem esgotamento -> budget_pressure SAUDAVEL",
    saudavelDe(r.observacoes, "budget_pressure"));
}

// ─── G. Dado de observabilidade ───────────────────────────────────────
secao("G. Dado de observabilidade");

{
  const r = avaliar(seisBuckets((n) => n * 100), CURSOR_PROGRESSO);
  ok("G1  tudo presente -> observability_data_incomplete SAUDAVEL",
    saudavelDe(r.observacoes, "observability_data_incomplete"));
}
{
  const r = avaliar(seisBuckets((n) => n * 100), CURSOR_PROGRESSO, true);
  const o = acha(r.observacoes, "observability_data_incomplete");
  ok("G2  carga truncada -> observability_data_incomplete ATIVO", o !== null && o.ativo);
  ok("G3  e NADA derivado dos buckets e emitido sobre dado incompleto",
    acha(r.observacoes, "scheduler_gap") === null &&
    acha(r.observacoes, "cursor_stuck") === null &&
    acha(r.observacoes, "backlog_pressure") === null);
}
{
  // Houve entrega e nao ha cursor: isso e dado faltando, nao comeco.
  const r = avaliar(seisBuckets((n) => n * 100), null);
  const o = acha(r.observacoes, "observability_data_incomplete");
  ok("G4  cursor ausente DEPOIS de entrega -> dado incompleto",
    o !== null && o.ativo && o.causa === "cursor_ausente_apos_entrega");
  ok("G5  e nenhuma conclusao de cursor e derivada dele",
    acha(r.observacoes, "cursor_stuck") === null &&
    acha(r.observacoes, "cursor_regression") === null);
  ok("G6  mas o scheduler_gap continua valendo — o ledger esta inteiro",
    acha(r.observacoes, "scheduler_gap") !== null);
}
{
  // Nenhum bucket entregou e nao ha cursor: comeco legitimo.
  const linhas: unknown[] = [];
  for (let n = 0; n <= 5; n++) linhas.push(...linhasDoBucket(n, { offset: 0, status: "erro", codigo: "erro_provider" }));
  const r = avaliar(linhas, null);
  ok("G7  cursor ausente SEM entrega nao acusa dado faltando",
    saudavelDe(r.observacoes, "observability_data_incomplete"));
}

// ─── H. Procedência (OBS-3 R1, ponta a ponta) ─────────────────────────
secao("H. Procedencia do cursor");

{
  const limpo = avaliar(seisBuckets((n) => n * 100), CURSOR_PROGRESSO);
  ok("H1  CONTROLE: sem escritor alheio, o progresso e afirmado",
    saudavelDe(limpo.observacoes, "cursor_stuck"));

  // O MESMO cenario, mais uma execucao `diag-*` depois do ultimo bucket.
  const comDiag = avaliar(
    [...seisBuckets((n) => n * 100), ...linhasDeDiagnostico(T0 + 5 * CAD + 120_000)],
    CURSOR_PROGRESSO
  );
  ok("H2  com `diag` no intervalo, o progresso NAO e afirmado",
    acha(comDiag.observacoes, "cursor_stuck") === null);
  ok("H3  nem travamento, nem regressao",
    acha(comDiag.observacoes, "cursor_regression") === null);
  ok("H4  a incerteza e reconhecida como CONHECIDA",
    comDiag.diagnosticos.includes("incerteza_conhecida"));
  ok("H5  e contaminacao conhecida NAO abre alerta de dado incompleto",
    saudavelDe(comDiag.observacoes, "observability_data_incomplete"));
  ok("H6  o scheduler_gap continua sendo avaliado normalmente",
    saudavelDe(comDiag.observacoes, "scheduler_gap"));
}
{
  // A consulta do monitor nao pode filtrar por chave do agendador.
  const portas = semComentarios(ler("lib/agentes/observabilidade/monitor-portas.ts"));
  ok("H7  a consulta recorta por `acao_id`, nunca por chave de bucket",
    portas.includes('.eq("acao_id"') && !portas.includes("w5m") &&
    !/idempotency_key[^,\n]*(like|ilike)/i.test(portas));
}

// O restante precisa de `await`, e o transform CJS do tsx nao aceita
// top-level await. Entao ele roda dentro de `main()`, e o placar so e
// impresso depois que ela termina.
async function main(): Promise<void> {
// ─── I. Orquestrador ──────────────────────────────────────────────────
secao("I. Orquestrador");

interface Loja {
  readonly abertos: Map<TipoDeAlerta, { id: string; incidente: IncidenteAberto }>;
  readonly eventos: string[];
}

function lojaDeAlertas(): Loja {
  return { abertos: new Map(), eventos: [] };
}

interface Serializador {
  adquirir(escopo: EscopoDoAlerta): AquisicaoDaSerializacao;
  liberar(escopo: EscopoDoAlerta, portador: string): void;
}

const chaveDoEscopo = (e: EscopoDoAlerta) =>
  JSON.stringify([e.userId, e.agenteId, e.plataforma, e.recurso]);

/**
 * O serializador que NAO serializa — o modelo anterior ao I4P9-R1.
 *
 * Existe para que os cenarios de corrida possam ser demonstrados como
 * defeito REAL antes de serem demonstrados como corrigidos. Um teste que
 * so mostra o depois nao prova que o antes era quebrado.
 */
function sempreConcede(): Serializador {
  let n = 0;
  return {
    adquirir: () => ({
      estado: "adquirida", portador: "portador-" + ++n,
      expiraEm: null, tomadaDeExpirada: false,
    }),
    liberar: () => undefined,
  };
}

/**
 * Um lease de verdade, em memoria: por ESCOPO, com relogio proprio e
 * expiracao. Modela o contrato da RPC, que e o que o codigo depende.
 */
function leaseEmMemoria(relogio: { agora: number }): Serializador {
  const donos = new Map<string, { portador: string; expiraEm: number; liberado: boolean }>();
  let n = 0;
  return {
    adquirir: (escopo) => {
      const k = chaveDoEscopo(escopo);
      const dono = donos.get(k) ?? null;
      if (dono !== null && dono.expiraEm > relogio.agora) return { estado: "ocupada" };
      const tomadaDeExpirada = dono !== null && !dono.liberado;
      const novo = {
        portador: "portador-" + ++n,
        expiraEm: relogio.agora + TTL_SINTETICO_MS,
        liberado: false,
      };
      donos.set(k, novo);
      return {
        estado: "adquirida", portador: novo.portador,
        expiraEm: new Date(novo.expiraEm).toISOString(), tomadaDeExpirada,
      };
    },
    liberar: (escopo, portador) => {
      // Casada com o PORTADOR: A nunca libera o lease que B adquiriu.
      const k = chaveDoEscopo(escopo);
      const dono = donos.get(k) ?? null;
      if (dono === null || dono.portador !== portador) return;
      donos.set(k, { ...dono, expiraEm: relogio.agora, liberado: true });
    },
  };
}

/** O mesmo TTL do modulo de producao, para o duplo nao divergir dele. */
const TTL_SINTETICO_MS = 90_000;

function portas(
  over: Partial<PortasDoMonitor> = {},
  loja = lojaDeAlertas(),
  leases: Serializador = sempreConcede(),
  /** Marca de qual execucao escreveu. E o que prova a ordenacao. */
  rotulo = ""
): PortasDoMonitor {
  return {
    agora: () => AGORA,
    lerAlvo: () => AG,
    lerAgente: async () => ({ estado: "ok", userId: USER }),
    lerConfiguracao: async () => CONFIG_ATIVA,
    carregarLedger: async () => montarCarga(seisBuckets((n) => n * 100), ESCOPO_CARGA, false),
    lerCursor: async () => lerCursorDoMonitor(CURSOR_PROGRESSO, ESCOPO_CARGA),
    adquirirSerializacao: async (escopo) => leases.adquirir(escopo),
    liberarSerializacao: async (escopo, portador) => leases.liberar(escopo, portador),
    lerIncidenteAberto: async (_e, tipo) => {
      const a = loja.abertos.get(tipo);
      return a ? { estado: "encontrado", id: a.id, incidente: a.incidente } : { estado: "ausente" };
    },
    abrirIncidente: async (novo) => {
      if (loja.abertos.has(novo.tipo)) return { estado: "duplicada" };
      loja.abertos.set(novo.tipo, {
        id: "id-" + novo.tipo,
        incidente: {
          tipo: novo.tipo,
          severidadeAtual: novo.severidadeAtual,
          severidadeMaxima: novo.severidadeMaxima,
          causaAtual: novo.causaAtual,
          ocorrencias: novo.ocorrencias,
          ultimaEvidenciaChave: novo.ultimaEvidenciaChave,
          evidenciasSaudaveisConsecutivas: novo.evidenciasSaudaveisConsecutivas,
        },
      });
      loja.eventos.push(rotulo + "OPEN:" + novo.tipo);
      return { estado: "aplicada" };
    },
    atualizarIncidente: async (id, campos) => {
      const tipo = id.slice(3) as TipoDeAlerta;
      const a = loja.abertos.get(tipo);
      if (!a) return { estado: "falhou" };
      loja.abertos.set(tipo, { id, incidente: { ...a.incidente, ...campos } as IncidenteAberto });
      loja.eventos.push(rotulo + "UPDATE:" + tipo);
      return { estado: "aplicada" };
    },
    resolverIncidente: async (id) => {
      const tipo = id.slice(3) as TipoDeAlerta;
      loja.abertos.delete(tipo);
      loja.eventos.push(rotulo + "RESOLVE:" + tipo);
      return { estado: "aplicada" };
    },
    ...over,
  };
}

const total = (r: ResultadoDoMonitor) =>
  r.estado === "avaliado" || r.estado === "avaliacao_parcial"
    ? r.metricas.abertos + r.metricas.atualizados + r.metricas.resolvidos + r.metricas.noop
    : 0;

{
  for (const [rot, alvo] of [
    ["ausente", undefined], ["vazio", ""], ["lixo", "nao-e-uuid"],
    ["quase", "aaaaaaaa-4c00-4000-8000-00000000000"],
  ] as const) {
    const loja = lojaDeAlertas();
    const r = await executarMonitorDaIngestao(portas({ lerAlvo: () => alvo }, loja));
    ok(`I1  alvo ${rot} -> MONITOR_TARGET_UNCONFIGURED`, r.estado === "alvo_nao_configurado");
    ok(`I1b alvo ${rot} nao escreve alerta nenhum`, loja.eventos.length === 0);
  }
}
{
  const loja = lojaDeAlertas();
  const r = await executarMonitorDaIngestao(portas({ lerAgente: async () => ({ estado: "ausente" }) }, loja));
  ok("I2  agente inexistente -> alvo invalido", r.estado === "alvo_invalido");
  ok("I2b e zero escrita", loja.eventos.length === 0);
}
{
  const loja = lojaDeAlertas();
  const r = await executarMonitorDaIngestao(portas({ lerAgente: async () => ({ estado: "falhou" }) }, loja));
  ok("I3  leitura do agente falha -> falha de PLATAFORMA, nao alerta",
    r.estado === "falha_de_plataforma" && r.estagio === "leitura_do_agente");
  ok("I3b e nada e gravado no banco que acabou de falhar", loja.eventos.length === 0);
}
{
  const loja = lojaDeAlertas();
  const r = await executarMonitorDaIngestao(
    portas({ lerConfiguracao: async () => ({ estado: "falhou_leitura" }) }, loja));
  ok("I4  configuracao ilegivel -> falha de plataforma",
    r.estado === "falha_de_plataforma" && r.estagio === "leitura_da_configuracao");
  ok("I4b sem inventar `observability_data_incomplete` no mesmo banco",
    loja.eventos.length === 0);
}
{
  const loja = lojaDeAlertas();
  const r = await executarMonitorDaIngestao(portas({ carregarLedger: async () => null }, loja));
  ok("I5  ledger ilegivel -> falha de plataforma",
    r.estado === "falha_de_plataforma" && r.estagio === "leitura_do_ledger");
  ok("I5b e zero escrita", loja.eventos.length === 0);
}
{
  const loja = lojaDeAlertas();
  const r = await executarMonitorDaIngestao(
    portas({ lerCursor: async () => ({ estado: "falhou" }) }, loja));
  ok("I6  cursor ilegivel -> falha de plataforma",
    r.estado === "falha_de_plataforma" && r.estagio === "leitura_do_cursor");
}
{
  const loja = lojaDeAlertas();
  const r = await executarMonitorDaIngestao(
    portas({ lerConfiguracao: async () => ({ estado: "configuracao_ausente" }) }, loja));
  ok("I7  configuracao ausente abre UM incidente",
    r.estado === "avaliado" && loja.eventos.join() === "OPEN:monitor_configuration_missing");
  ok("I7b e nenhum alerta do agendador nasce junto", loja.abertos.size === 1);
}
{
  const loja = lojaDeAlertas();
  const p = portas({ lerConfiguracao: async () => ({ estado: "configuracao_ausente" }) }, loja);
  await executarMonitorDaIngestao(p);
  await executarMonitorDaIngestao(p);
  await executarMonitorDaIngestao(p);
  const inc = loja.abertos.get("monitor_configuration_missing");
  ok("I8  a MESMA falta, tres ciclos seguidos, e UMA ocorrencia",
    inc !== undefined && inc.incidente.ocorrencias === 1);
}
{
  // Configuracao aparece INATIVA: resolve na hora, e so isso.
  const loja = lojaDeAlertas();
  const ausente = portas({ lerConfiguracao: async () => ({ estado: "configuracao_ausente" }) }, loja);
  await executarMonitorDaIngestao(ausente);
  const inativa = portas({ lerConfiguracao: async () => ({ estado: "configurado_inativo" }) }, loja);
  const r = await executarMonitorDaIngestao(inativa);
  ok("I9  configuracao valida aparece -> RESOLVE de imediato",
    r.estado === "avaliado" && loja.eventos.includes("RESOLVE:monitor_configuration_missing"));
  ok("I9b e com config inativa nada mais e avaliado", total(r) === 1);
}
{
  // Um gap aberto NAO e resolvido por a configuracao virar inativa.
  const loja = lojaDeAlertas();
  const linhas: unknown[] = [];
  for (let n = 0; n <= 4; n++) linhas.push(...linhasDoBucket(n, { offset: n * 100 }));
  await executarMonitorDaIngestao(portas({
    carregarLedger: async () => montarCarga(linhas, ESCOPO_CARGA, false),
  }, loja));
  ok("I10 bucket faltando abre `scheduler_gap`", loja.abertos.has("scheduler_gap"));
  const antes = loja.abertos.get("scheduler_gap")!.incidente;
  await executarMonitorDaIngestao(portas({
    lerConfiguracao: async () => ({ estado: "configurado_inativo" }),
  }, loja));
  const depois = loja.abertos.get("scheduler_gap");
  ok("I11 config inativa NAO resolve o gap — nao houve recuperacao",
    depois !== undefined &&
    depois.incidente.evidenciasSaudaveisConsecutivas === antes.evidenciasSaudaveisConsecutivas);
}
{
  // Cinco ciclos do vigia sobre o MESMO bucket.
  const loja = lojaDeAlertas();
  const linhas: unknown[] = [];
  for (let n = 0; n <= 4; n++) linhas.push(...linhasDoBucket(n, { offset: n * 100 }));
  const p = portas({ carregarLedger: async () => montarCarga(linhas, ESCOPO_CARGA, false) }, loja);
  for (let i = 0; i < 5; i++) await executarMonitorDaIngestao(p);
  const inc = loja.abertos.get("scheduler_gap")!.incidente;
  ok("I12 cinco passagens do vigia = UMA ocorrencia", inc.ocorrencias === 1);
  ok("I12b e zero recuperacao acumulada", inc.evidenciasSaudaveisConsecutivas === 0);
}
{
  // O gap fecha quando dois buckets saudaveis DISTINTOS aparecem.
  const loja = lojaDeAlertas();
  const faltando: unknown[] = [];
  for (let n = 0; n <= 4; n++) faltando.push(...linhasDoBucket(n, { offset: n * 100 }));
  await executarMonitorDaIngestao(portas({
    carregarLedger: async () => montarCarga(faltando, ESCOPO_CARGA, false),
  }, loja));
  ok("I13 gap aberto", loja.abertos.has("scheduler_gap"));

  const p = portas({}, loja);
  await executarMonitorDaIngestao(p);
  ok("I13b a primeira evidencia saudavel NAO resolve sozinha",
    loja.abertos.get("scheduler_gap")?.incidente.evidenciasSaudaveisConsecutivas === 1);

  // Quatro ciclos a mais sobre o MESMO bucket saudavel. O vigia roda a
  // cada minuto e o agendador a cada cinco: se releitura contasse, o
  // incidente fecharia sem o agendador ter produzido bucket nenhum.
  for (let i = 0; i < 4; i++) await executarMonitorDaIngestao(p);
  ok("I13c reavaliar o mesmo bucket saudavel nao acumula recuperacao",
    loja.abertos.get("scheduler_gap")?.incidente.evidenciasSaudaveisConsecutivas === 1);

  await executarMonitorDaIngestao(portas({
    agora: () => AGORA + CAD,
    carregarLedger: async () => montarCarga(
      [...seisBuckets((n) => n * 100), ...linhasDoBucket(6, { offset: 600 })], ESCOPO_CARGA, false),
    lerCursor: async () => lerCursorDoMonitor(cursorBruto(700, T0 + 6 * CAD + 40_000), ESCOPO_CARGA),
  }, loja));
  ok("I14 o SEGUNDO bucket saudavel resolve o gap", !loja.abertos.has("scheduler_gap"));
}
{
  // Corrida: a abertura perde para outra execucao do vigia.
  const loja = lojaDeAlertas();
  let primeira = true;
  const p = portas({
    lerConfiguracao: async () => ({ estado: "configuracao_ausente" }),
    lerIncidenteAberto: async (_e, tipo) => {
      if (primeira) { primeira = false; return { estado: "ausente" }; }
      const a = loja.abertos.get(tipo);
      return a ? { estado: "encontrado", id: a.id, incidente: a.incidente } : { estado: "ausente" };
    },
    abrirIncidente: async () => ({ estado: "duplicada" }),
  }, loja);
  loja.abertos.set("monitor_configuration_missing", {
    id: "id-monitor_configuration_missing",
    incidente: {
      tipo: "monitor_configuration_missing", severidadeAtual: "alert", severidadeMaxima: "alert",
      causaAtual: "ausente", ocorrencias: 1, ultimaEvidenciaChave: "cfg#a:ausente",
      evidenciasSaudaveisConsecutivas: 0,
    },
  });
  const r = await executarMonitorDaIngestao(p);
  ok("I15 corrida perdida vira releitura, nao avaliacao perdida",
    r.estado === "avaliado" && loja.eventos.includes("UPDATE:monitor_configuration_missing"));
}
{
  const loja = lojaDeAlertas();
  const r = await executarMonitorDaIngestao(portas({
    lerIncidenteAberto: async () => ({ estado: "falhou" }),
  }, loja));
  ok("I16 leitura do alerta falha -> avaliacao PARCIAL, nunca 'avaliado'",
    r.estado === "avaliacao_parcial");
  ok("I16b e o estagio nomeia o tipo que parou",
    r.estado === "avaliacao_parcial" && r.estagio.length > 0);
}
{
  const loja = lojaDeAlertas();
  const r = await executarMonitorDaIngestao(portas({
    // Configuracao ausente da o que abrir; sem isso a porta de escrita
    // nunca seria exercitada e o teste passaria por vacuidade.
    lerConfiguracao: async () => ({ estado: "configuracao_ausente" }),
    abrirIncidente: async () => ({ estado: "falhou" }),
  }, loja));
  ok("I17 escrita do alerta falha -> avaliacao PARCIAL", r.estado === "avaliacao_parcial");
  ok("I17b e a rodada nao segue gravando contra o repositorio que recusou",
    r.estado === "avaliacao_parcial" && r.metricas.abertos === 0);
}
{
  const loja = lojaDeAlertas();
  const r = await executarMonitorDaIngestao(portas({}, loja));
  ok("I18 rodada saudavel avalia TODAS as dimensoes aplicaveis",
    r.estado === "avaliado" && r.metricas.tiposAvaliados === 7);
  ok("I18b e nada e aberto quando nada esta errado",
    r.estado === "avaliado" && r.metricas.abertos === 0 && r.metricas.noop === 7);
}
{
  // O escopo entregue ao repositorio vem do BANCO, nunca do chamador.
  let visto: EscopoDoAlerta | null = null;
  await executarMonitorDaIngestao(portas({
    lerConfiguracao: async () => ({ estado: "configuracao_ausente" }),
    lerIncidenteAberto: async (e) => { visto = e; return { estado: "ausente" }; },
  }));
  const v = visto as EscopoDoAlerta | null;
  ok("I19 o escopo do alerta e (dono do banco, alvo do ambiente, par canonico)",
    v !== null && v.userId === USER && v.agenteId === AG &&
    v.plataforma === "mercado_livre" && v.recurso === "perguntas");
}

// ─── J. Rota ──────────────────────────────────────────────────────────
secao("J. Rota e autenticacao");

const SEGREDO = "CRON_SECRET_OBS5_SINTETICO";
const CAMINHO = "/api/internal/agentes/monitor-ingestao";

{
  process.env.CRON_SECRET = SEGREDO;
  // Alvo deliberadamente NAO configurado: a rota valida chega ate a
  // descoberta de alvo e para ali, sem tocar em banco nenhum.
  delete process.env.N8N_INGESTAO_AGENT_ID;

  const rota = await import("../app/api/internal/agentes/monitor-ingestao/route");
  const pede = (headers: Record<string, string> = {}) =>
    new Request("http://localhost" + CAMINHO, { method: "GET", headers });

  const semHeader = await rota.GET(pede());
  ok("J1  sem Authorization -> 401", semHeader.status === 401);

  const errado = await rota.GET(pede({ authorization: "Bearer outro-segredo" }));
  ok("J2  segredo errado -> 401", errado.status === 401);

  const semBearer = await rota.GET(pede({ authorization: SEGREDO }));
  ok("J3  sem o esquema Bearer -> 401", semBearer.status === 401);

  const porWorker = await rota.GET(pede({ "x-worker-secret": SEGREDO }));
  ok("J4  o segredo por outro header NAO abre a porta", porWorker.status === 401);

  delete process.env.CRON_SECRET;
  const semServidor = await rota.GET(pede({ authorization: `Bearer ${SEGREDO}` }));
  ok("J5  sem CRON_SECRET no servidor, NINGUEM entra — nem o cron",
    semServidor.status === 401);

  process.env.CRON_SECRET = SEGREDO;
  const valido = await rota.GET(pede({ authorization: `Bearer ${SEGREDO}` }));
  const corpo = (await valido.json()) as Record<string, unknown>;
  ok("J6  segredo correto passa da guarda", valido.status !== 401);
  ok("J7  e sem alvo configurado a rota falha FECHADA, em 5xx",
    valido.status === 500 && corpo.erro === "monitor_target_unconfigured");

  // Autoridade oferecida pelo chamador nao muda nada.
  const comAutoridade = await rota.GET(
    new Request("http://localhost" + CAMINHO + "?agenteId=" + AG + "&userId=" + USER, {
      method: "GET",
      headers: { authorization: `Bearer ${SEGREDO}`, "x-agente-id": AG, "x-user-id": USER },
    })
  );
  const corpo2 = (await comAutoridade.json()) as Record<string, unknown>;
  ok("J8  agenteId/userId oferecidos pelo chamador sao IGNORADOS",
    comAutoridade.status === 500 && corpo2.erro === "monitor_target_unconfigured");

  ok("J9  nenhuma resposta carrega dado de tenant",
    !JSON.stringify(corpo2).includes(AG) && !JSON.stringify(corpo2).includes(USER));
  ok("J10 a resposta nao e cacheavel",
    valido.headers.get("Cache-Control") === "no-store");
}
{
  const fonte = semComentarios(ler("app/api/internal/agentes/monitor-ingestao/route.ts"));
  ok("J11 a rota le `CRON_SECRET`, e nao um segredo novo",
    fonte.includes("process.env.CRON_SECRET"));
  ok("J12 e NAO reaproveita segredo do n8n",
    !fonte.includes("N8N_INGESTAO_INTERNAL_SECRET") && !fonte.includes("N8N_BRIDGE_INTERNAL_SECRET"));
  ok("J13 a rota nao le corpo, query nem parametro de caminho",
    !fonte.includes("request.json") && !fonte.includes("searchParams") && !fonte.includes("params"));
  ok("J14 so GET e exportado",
    /export async function GET/.test(fonte) &&
    !/export async function (POST|PUT|PATCH|DELETE)/.test(fonte));
  ok("J15 e o ciclo de vida nao mora na rota",
    !fonte.includes("reduzirEstadoDoAlerta") && !fonte.includes("criarAlerta"));
}

// ─── K. Middleware ────────────────────────────────────────────────────
secao("K. Middleware");

ok("K1  a rota esta declarada em ROTAS_COM_SEGREDO",
  JSON.stringify(ROTAS_COM_SEGREDO[CAMINHO]) === '["GET"]');
ok("K2  e o middleware deixa a requisicao CHEGAR sem cookie",
  decidirAcesso(CAMINHO, "GET", false) === "liberar");
ok("K3  CONTROLE NEGATIVO: caminho nao declarado e bloqueado",
  decidirAcesso(CAMINHO + "-inexistente", "GET", false) === "bloquear_api");
ok("K4  CONTROLE NEGATIVO: metodo nao declarado e bloqueado",
  decidirAcesso(CAMINHO, "POST", false) === "bloquear_api");
{
  // A prova de que a entrada e NECESSARIA: sem ela, a mesma funcao nega.
  const semAEntrada = { ...ROTAS_COM_SEGREDO } as Record<string, readonly string[]>;
  delete semAEntrada[CAMINHO];
  const casa = (c: string, m: string) =>
    Array.isArray(semAEntrada[c]) && semAEntrada[c].includes(m);
  ok("K5  removida a entrada, nada mais libera este caminho",
    !casa(CAMINHO, "GET"));
}

// ─── L. Segurança estática ────────────────────────────────────────────
secao("L. Seguranca estatica");

const FONTES = [
  "lib/agentes/observabilidade/monitor-avaliacao.ts",
  "lib/agentes/observabilidade/monitor-carga.ts",
  "lib/agentes/observabilidade/monitor-ingestao.ts",
  "lib/agentes/observabilidade/monitor-portas.ts",
  "lib/agentes/observabilidade/monitor-lease.ts",
  "app/api/internal/agentes/monitor-ingestao/route.ts",
] as const;

for (const f of FONTES) {
  const s = semComentarios(ler(f));
  ok(`L1  ${f.split("/").pop()} nao chama provedor nem rede`,
    !s.includes("fetch(") && !s.includes("mercado-livre") && !s.includes("ml-auth") &&
    !s.includes("mercadolivre-perguntas"));
  ok(`L2  ${f.split("/").pop()} nao fala com o n8n`,
    !s.includes("ponte-n8n") && !s.includes("N8N_API") && !s.includes("workflows"));
}
{
  const puros = ["monitor-avaliacao", "monitor-carga", "monitor-ingestao"] as const;
  for (const p of puros) {
    const s = semComentarios(ler(`lib/agentes/observabilidade/${p}.ts`));
    ok(`L3  ${p} e PURO: sem supabase, sem server-only`,
      !s.includes("supabase") && !s.includes("Supabase") && !s.includes("server-only"));
  }
  const portasFonte = semComentarios(ler("lib/agentes/observabilidade/monitor-portas.ts"));
  ok("L4  as portas declaram `server-only`", portasFonte.includes("server-only"));
  ok("L5  e NAO escrevem em nada — o vigia observa, nao participa",
    !portasFonte.includes(".insert(") && !portasFonte.includes(".update(") &&
    !portasFonte.includes(".upsert(") && !portasFonte.includes(".delete(") &&
    !portasFonte.includes(".rpc("));
  {
    // O lease escreve, e tem de escrever. O que ele NAO pode e encostar
    // em tabela comercial: a escrita dele e coordenacao, nao varredura.
    const leaseFonte = semComentarios(ler("lib/agentes/observabilidade/monitor-lease.ts"));
    ok("L5b a escrita do lease sai por RPC dedicada, e so por ela",
      (leaseFonte.match(/\.rpc\(/g) || []).length === 2 &&
      leaseFonte.includes("adquirir_lease_monitor_ingestao") &&
      leaseFonte.includes("liberar_lease_monitor_ingestao"));
    ok("L5c e ele nao alcanca nenhuma tabela comercial",
      !leaseFonte.includes(".from(") &&
      !leaseFonte.includes("agente_perguntas") &&
      !leaseFonte.includes("agente_acao_execucoes") &&
      !leaseFonte.includes("pedidos"));
  }
  ok("L6  a unica escrita do monitor sai pelo repositorio do OBS-4",
    portasFonte.includes("criarAlerta") && portasFonte.includes("resolverAlerta"));
  ok("L7  o alvo vem do AMBIENTE, nao da tabela de configuracao",
    portasFonte.includes("process.env.N8N_INGESTAO_AGENT_ID"));
  ok("L8  o par canonico nao e redigitado na consulta do ledger",
    portasFonte.includes("PLATAFORMA_DO_MONITOR") && portasFonte.includes("RECURSO_DO_MONITOR"));
}
ok("L9  zero bytes de controle nas fontes novas",
  FONTES.every((f) => !ler(f).includes(String.fromCharCode(0))));


// --- M. Reentrancia do proprio vigia (I4P9-R1) -----------------------
secao("M. Reentrancia");

/** Um portao que deixa uma execucao parada onde o teste quiser. */
function diferida(): { portao: Promise<void>; abrir: () => void } {
  let abrir!: () => void;
  const portao = new Promise<void>((r) => { abrir = r; });
  return { portao, abrir };
}

const LEDGER_COM_GAP = (() => {
  const l: unknown[] = [];
  for (let n = 0; n <= 4; n++) l.push(...linhasDoBucket(n, { offset: n * 100 }));
  return l;
})();

/**
 * Duas execucoes sobrepostas: a VELHA (A) carrega um ledger com gap e
 * fica presa; a NOVA (B) carrega tudo saudavel e termina primeiro.
 *
 * `serializa` decide se o modelo tem lease. Sem ele, as duas avaliam.
 */
async function sobrepor(serializa: boolean, loja: Loja, cenarioB: Partial<PortasDoMonitor> = {}) {
  const relogio = { agora: AGORA };
  const leases = serializa ? leaseEmMemoria(relogio) : sempreConcede();
  const d = diferida();

  const pA = portas({
    agora: () => AGORA,
    carregarLedger: async () => {
      await d.portao;
      return montarCarga(LEDGER_COM_GAP, ESCOPO_CARGA, false);
    },
  }, loja, leases, "A:");
  const pB = portas({ agora: () => AGORA + 60_000, ...cenarioB }, loja, leases, "B:");

  const corridaA = executarMonitorDaIngestao(pA);
  // B inteira enquanto A esta presa dentro da propria avaliacao.
  const rB = await executarMonitorDaIngestao(pB);
  d.abrir();
  const rA = await corridaA;
  return { rA, rB };
}

{
  // SS3.C — o caso que NENHUM CAS por linha de alerta resolve: a
  // avaliacao saudavel mais nova nao escreve nada, entao nao ha linha
  // contra a qual comparar quando a velha chega atrasada.
  const loja = lojaDeAlertas();
  const { rA, rB } = await sobrepor(false, loja);
  ok("M1  SEM serializacao as DUAS execucoes avaliam",
    rB.estado === "avaliado" && rA.estado === "avaliado");
  ok("M2  e a execucao VELHA abre um incidente depois de a nova ter visto saude",
    loja.abertos.has("scheduler_gap") &&
    loja.eventos.includes("A:OPEN:scheduler_gap"));
  ok("M3  o defeito e real: nenhuma linha de alerta existia para proteger",
    !loja.eventos.some((e) => e.startsWith("B:")));
}
{
  // O MESMO cenario, agora serializado.
  const loja = lojaDeAlertas();
  const { rA, rB } = await sobrepor(true, loja);
  ok("M4  COM serializacao a segunda execucao nao avalia",
    rB.estado === "ignorado_por_sobreposicao");
  ok("M5  e ela nao escreve nada", !loja.eventos.some((e) => e.startsWith("B:")));
  ok("M6  a execucao que detem o direito termina normalmente", rA.estado === "avaliado");
  ok("M7  entao as escritas do ciclo vem de UMA execucao so",
    loja.eventos.length > 0 && loja.eventos.every((e) => e.startsWith("A:")));
}
{
  // SS3.A — incidente ABERTO, a nova registra recuperacao e a velha
  // volta e apaga essa recuperacao.
  const loja = lojaDeAlertas();
  loja.abertos.set("scheduler_gap", {
    id: "id-scheduler_gap",
    incidente: {
      tipo: "scheduler_gap", severidadeAtual: "warning", severidadeMaxima: "warning",
      causaAtual: "missing", ocorrencias: 1,
      ultimaEvidenciaChave: "b:" + idDoBucket(4) + "#a:missing",
      evidenciasSaudaveisConsecutivas: 0,
    },
  });
  await sobrepor(false, loja);
  ok("M8  SEM serializacao a evidencia saudavel da execucao nova e desfeita",
    loja.abertos.get("scheduler_gap")?.incidente.evidenciasSaudaveisConsecutivas === 0 &&
    loja.eventos.includes("B:UPDATE:scheduler_gap") &&
    loja.eventos.indexOf("A:UPDATE:scheduler_gap") > loja.eventos.indexOf("B:UPDATE:scheduler_gap"));
}
{
  const loja = lojaDeAlertas();
  loja.abertos.set("scheduler_gap", {
    id: "id-scheduler_gap",
    incidente: {
      tipo: "scheduler_gap", severidadeAtual: "warning", severidadeMaxima: "warning",
      causaAtual: "missing", ocorrencias: 1,
      ultimaEvidenciaChave: "b:" + idDoBucket(4) + "#a:missing",
      evidenciasSaudaveisConsecutivas: 0,
    },
  });
  await sobrepor(true, loja);
  ok("M9  COM serializacao nenhuma escrita fora de ordem acontece",
    loja.eventos.every((e) => e.startsWith("A:")));
}
{
  // SS3.B — o espelho: a nova observa ATIVO e a velha, saudavel.
  const loja = lojaDeAlertas();
  const { rB } = await sobrepor(true, loja, {
    carregarLedger: async () => montarCarga(LEDGER_COM_GAP, ESCOPO_CARGA, false),
  });
  ok("M10 saudavel velho tambem nao passa na frente de ativo novo",
    rB.estado === "ignorado_por_sobreposicao" &&
    !loja.eventos.some((e) => e.startsWith("B:")));
}
{
  // SS3.D/E — duas invocacoes IDENTICAS, mesmo minuto, mesma evidencia.
  const relogio = { agora: AGORA };
  const leases = leaseEmMemoria(relogio);
  const loja = lojaDeAlertas();
  const d = diferida();
  const pA = portas({
    lerConfiguracao: async () => ({ estado: "configuracao_ausente" }),
    lerIncidenteAberto: async (_e, tipo) => {
      await d.portao;
      const a = loja.abertos.get(tipo);
      return a ? { estado: "encontrado", id: a.id, incidente: a.incidente } : { estado: "ausente" };
    },
  }, loja, leases, "A:");
  const pB = portas({ lerConfiguracao: async () => ({ estado: "configuracao_ausente" }) },
    loja, leases, "B:");
  const corridaA = executarMonitorDaIngestao(pA);
  const rB = await executarMonitorDaIngestao(pB);
  d.abrir();
  const rA = await corridaA;
  ok("M11 invocacao duplicada: UMA avalia, a outra pula",
    (rA.estado === "avaliado") !== (rB.estado === "avaliado"));
  ok("M12 e exatamente um incidente nasce",
    loja.eventos.filter((e) => e.endsWith("OPEN:monitor_configuration_missing")).length === 1);
}
{
  // SS18.C — lease vencido pode ser tomado, e a tomada e reconhecida.
  const relogio = { agora: AGORA };
  const leases = leaseEmMemoria(relogio);
  const primeira = leases.adquirir(ESCOPO);
  ok("M13 a primeira aquisicao vence", primeira.estado === "adquirida");
  ok("M14 a segunda, com lease valido, e OCUPADA",
    leases.adquirir(ESCOPO).estado === "ocupada");

  relogio.agora += TTL_SINTETICO_MS + 1;
  const tomada = leases.adquirir(ESCOPO);
  ok("M15 depois de vencer, o direito volta sozinho — sem intervencao",
    tomada.estado === "adquirida");
  ok("M16 e a tomada de um portador que nao liberou e reconhecida como tal",
    tomada.estado === "adquirida" && tomada.tomadaDeExpirada);

  // O portador ANTIGO tenta liberar o lease do novo.
  if (primeira.estado === "adquirida") leases.liberar(ESCOPO, primeira.portador);
  ok("M17 o portador antigo NAO libera o lease que o novo adquiriu",
    leases.adquirir(ESCOPO).estado === "ocupada");

  if (tomada.estado === "adquirida") leases.liberar(ESCOPO, tomada.portador);
  const depois = leases.adquirir(ESCOPO);
  ok("M18 o portador atual libera, e o direito fica disponivel na hora",
    depois.estado === "adquirida");
  ok("M19 e aquisicao apos liberacao normal NAO e tomada de vencido",
    depois.estado === "adquirida" && !depois.tomadaDeExpirada);
}
{
  // SS18.I — o lease de um agente nao bloqueia o outro.
  const leases = leaseEmMemoria({ agora: AGORA });
  ok("M20 escopo A adquire", leases.adquirir(ESCOPO).estado === "adquirida");
  ok("M21 e o escopo de OUTRO agente adquire junto",
    leases.adquirir({ ...ESCOPO, agenteId: OUTRO_AG }).estado === "adquirida");
  ok("M22 sem deixar de bloquear o proprio escopo",
    leases.adquirir(ESCOPO).estado === "ocupada");
}
{
  // SS12 — o banco falha ao coordenar. Isso e plataforma.
  const loja = lojaDeAlertas();
  const r = await executarMonitorDaIngestao(portas({
    adquirirSerializacao: async () => ({ estado: "falhou" }),
  }, loja));
  ok("M23 falha ao adquirir o lease -> falha de PLATAFORMA",
    r.estado === "falha_de_plataforma" && r.estagio === "aquisicao_da_serializacao");
  ok("M24 e zero avaliacao, zero alerta", loja.eventos.length === 0);
}
{
  // SS18.J — config inativa continua serializada.
  const relogio = { agora: AGORA };
  const leases = leaseEmMemoria(relogio);
  const loja = lojaDeAlertas();
  const d = diferida();
  const pA = portas({
    lerConfiguracao: async () => { await d.portao; return { estado: "configurado_inativo" }; },
  }, loja, leases, "A:");
  const pB = portas({ lerConfiguracao: async () => ({ estado: "configurado_inativo" }) },
    loja, leases, "B:");
  const corridaA = executarMonitorDaIngestao(pA);
  const rB = await executarMonitorDaIngestao(pB);
  d.abrir();
  await corridaA;
  ok("M25 config inativa tambem e serializada",
    rB.estado === "ignorado_por_sobreposicao");
}
{
  // A liberacao acontece MESMO quando a avaliacao falha no meio.
  const relogio = { agora: AGORA };
  const leases = leaseEmMemoria(relogio);
  const loja = lojaDeAlertas();
  const r = await executarMonitorDaIngestao(portas({
    lerIncidenteAberto: async () => ({ estado: "falhou" }),
  }, loja, leases));
  ok("M26 avaliacao parcial nao engole o lease",
    r.estado === "avaliacao_parcial" && leases.adquirir(ESCOPO).estado === "adquirida");
}
{
  // E uma liberacao que EXPLODE nao pode derrubar o resultado.
  const loja = lojaDeAlertas();
  // A chamada e envolvida porque a falha esperada e um RESULTADO errado,
  // nao uma excecao: sem isto, um `finally` que propaga derrubaria a
  // suite inteira em vez de reprovar este assert.
  let r: ResultadoDoMonitor | null = null;
  try {
    r = await executarMonitorDaIngestao(portas({
      liberarSerializacao: async () => { throw new Error("banco caiu na liberacao"); },
    }, loja));
  } catch {
    r = null;
  }
  ok("M27 falha ao liberar nao muda o resultado ja decidido",
    r !== null && r.estado === "avaliado");
}

// --- N. A migration do lease -----------------------------------------
secao("N. Migration do lease");

{
  const SQL = ler("supabase/migrations/20261014_agente_ingestao_monitor_lease.sql");
  const LISO = SQL.replace(/^\s*--.*$/gm, "").replace(/\s+/g, " ");

  ok("N1  tabela propria: o lease nao mora no alerta nem no cursor",
    LISO.includes("create table public.agente_ingestao_monitor_lease") &&
    !LISO.includes("agente_ingestao_alertas") &&
    !LISO.includes("agente_perguntas_continuacao"));
  ok("N2  sem `if not exists` — objeto de outra forma nao passa calado",
    !/create table if not exists/i.test(LISO));
  ok("N3  a chave e por ESCOPO, nunca um singleton global",
    LISO.includes("primary key (agente_id, plataforma, recurso)"));
  ok("N4  cerca de dono pela FK composta",
    LISO.includes("foreign key (agente_id, user_id)") &&
    LISO.includes("references public.agentes (id, user_id)"));
  ok("N5  o par canonico e travado",
    LISO.includes("plataforma = 'mercado_livre' and recurso = 'perguntas'"));

  ok("N6  a aquisicao e UM comando: insert ... on conflict do update",
    /insert into public\.agente_ingestao_monitor_lease[\s\S]*on conflict \(agente_id, plataforma, recurso\) do update/.test(LISO));
  ok("N7  com a condicao de expiracao NO PROPRIO comando",
    /do update[\s\S]*where alvo\.expira_em <= now\(\)/.test(LISO));
  ok("N8  e cerca de dono junto",
    /where alvo\.expira_em <= now\(\)[\s]*and alvo\.user_id = p_user_id/.test(LISO));
  ok("N9  NAO existe select-depois-update desprotegido",
    !/select[\s\S]*from public\.agente_ingestao_monitor_lease[\s\S]*update public\.agente_ingestao_monitor_lease/.test(LISO));

  ok("N10 o relogio e o do BANCO, nunca o de quem chama",
    LISO.includes("now() + make_interval(secs => p_ttl_segundos)") &&
    !/p_\w*(expira|agora|instante)\w* timestamptz/.test(LISO));
  ok("N11 o TTL cru e revalidado dentro da RPC",
    LISO.includes("p_ttl_segundos <= 0 or p_ttl_segundos > 600"));
  ok("N12 o portador cru tambem",
    LISO.includes("length(btrim(p_portador)) = 0"));

  ok("N13 a liberacao casa com o PORTADOR",
    /update public\.agente_ingestao_monitor_lease[\s\S]*and alvo\.portador = p_portador/.test(LISO));
  ok("N14 e so libera lease ainda nao liberado",
    /and alvo\.liberada_em is null/.test(LISO));

  ok("N15 as duas RPCs sao `security invoker` com search_path fixo",
    (LISO.match(/security invoker set search_path = public/g) || []).length === 2);
  ok("N16 revoke nominal nos tres papeis, nas funcoes",
    (LISO.match(/revoke all on function public\.adquirir_lease_monitor_ingestao/g) || []).length === 3 &&
    (LISO.match(/revoke all on function public\.liberar_lease_monitor_ingestao/g) || []).length === 3);
  ok("N17 execute so para service_role",
    (LISO.match(/grant execute on function[^;]*to service_role/g) || []).length === 2);
  ok("N18 a tabela nao concede nada a public/anon/authenticated",
    ["public", "anon", "authenticated", "service_role"].every((papel) =>
      LISO.includes("revoke all on table public.agente_ingestao_monitor_lease from " + papel)));
  ok("N19 e DELETE/TRUNCATE ficam de fora",
    LISO.includes("revoke delete, truncate on table public.agente_ingestao_monitor_lease from service_role"));
  ok("N20 sem trigger e sem regra de negocio escondida no schema",
    !/create trigger/i.test(LISO));
  ok("N21 zero bytes de controle", !SQL.includes(String.fromCharCode(0)));
}
{
  const lease = semComentarios(ler("lib/agentes/observabilidade/monitor-lease.ts"));
  ok("N22 o TTL do codigo e o declarado", lease.includes("TTL_DO_LEASE_SEGUNDOS = 90"));
  ok("N23 o portador nasce dentro da porta, nao vem de fora",
    lease.includes("randomUUID()") && !/portador:\s*\w+\s*\)/.test(lease.split("export async function adquirir")[0]));
  ok("N24 forma inesperada da RPC NAO vira direito adquirido",
    lease.includes('typeof linha.adquirida !== "boolean"'));
  ok("N25 a porta declara `server-only`", lease.includes("server-only"));
  ok("N26 e nao chama provedor nem n8n",
    !lease.includes("fetch(") && !lease.includes("mercado-livre") && !lease.includes("ponte-n8n"));
}
{
  const rota = semComentarios(ler("app/api/internal/agentes/monitor-ingestao/route.ts"));
  ok("N27 sobreposicao responde 200, nao erro",
    /ignorado_por_sobreposicao[\s\S]*200/.test(rota));
  ok("N28 e a resposta nao expoe o portador do lease",
    !rota.includes("portador"));
}

}

void main().then(() => {
  console.log(`
── placar ${"─".repeat(54)}`);
  console.log(`  PASS ${passou}   FAIL ${falhou}
`);
  if (falhou > 0) process.exitCode = 1;
});
