/**
 * SALES-SYNC-D15C2 — excecao EXATA dos guards de escopo para o patch D15C
 * (motor INTRADAY Mercado Livre).
 *
 *   lib/vendas/sync/worker.ts  ATUAL − hunks D15C aprovados = BYTE-IDENTICO
 *                              ao worker.ts de b260583 (que ja contem o D15B
 *                              e o D14.1). A camada D15B (d631748 → b260583)
 *                              e historia imutavel ja validada pela excecao
 *                              D15B; aqui so se exige que a base do guard nao
 *                              tenha mudado antes dela (= d631748).
 *   lib/mercado-livre/ingestao/intraday.ts
 *                              arquivo NOVO, path exato, conteudo pinado por
 *                              sha256 (qualquer byte a mais → falha).
 *   este helper                arquivo novo (para o guard do cron).
 *
 * Nada mais: motor.ts, transporte.ts, persistencia.ts, normalizar.ts e os
 * leitores canonicos continuam travados; nenhum glob em ingestao/. As
 * excecoes D13, D14 e D15B seguem independentes e nao sao ampliadas.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const BASE_D15C = "b260583";
/** O worker.ts antes do D15B (a base historica que o D15B reconstroi). */
const ANTES_D15B = "d631748";

export const WORKER_D15C = "lib/vendas/sync/worker.ts";
export const MOTOR_INTRADAY_ML = "lib/mercado-livre/ingestao/intraday.ts";
export const ARQUIVOS_NOVOS_D15C: readonly string[] = [MOTOR_INTRADAY_ML, "scripts/_excecao-d15c-ml-intraday.ts"];

/** sha256 (LF) do motor intraday ML aprovado no D15C. */
const SHA256_MOTOR_INTRADAY_ML = "eaa0cb3792a2fece935c8c91f14034f416dab5c577279b51e2350d7844b6eb3d";

/** Hunks APROVADOS do worker (contexto de 1 linha): `d15c` no arquivo atual ↔ `base` em b260583. */
const HUNKS_WORKER_D15C: { base: string; d15c: string }[] = [
  {
    "base": "import { limitesDaJanela } from \"@/lib/mercado-livre/ingestao/janelas\";\nimport { executarFatiaML } from \"@/lib/mercado-livre/ingestao/motor\";",
    "d15c": "import { limitesDaJanela } from \"@/lib/mercado-livre/ingestao/janelas\";\nimport { executarFatiaMLIntraday } from \"@/lib/mercado-livre/ingestao/intraday\";\nimport { executarFatiaML } from \"@/lib/mercado-livre/ingestao/motor\";"
  },
  {
    "base": "import { classificarJobParaWorker, type TipoTrabalhoCanonico } from \"./worker-contrato\";\nimport { ehJobIntraday } from \"./intraday\";\n",
    "d15c": "import { classificarJobParaWorker, type TipoTrabalhoCanonico } from \"./worker-contrato\";\nimport { ehJobIntraday, INTRADAY_CANONICO_HABILITADO } from \"./intraday\";\n"
  },
  {
    "base": "  ml: typeof executarFatiaML;\n  shopee: typeof executarFatiaShopee;",
    "d15c": "  ml: typeof executarFatiaML;\n  /** D15C: observacao intraday ML (so com o intraday habilitado). */\n  mlIntraday?: typeof executarFatiaMLIntraday;\n  shopee: typeof executarFatiaShopee;"
  },
  {
    "base": "  habilitado?: boolean;\n}\n\nconst MOTORES_REAIS: MotoresCanonicos = { ml: executarFatiaML, shopee: executarFatiaShopee, catchup: executarFatiaCatchUpEscrow };\n",
    "d15c": "  habilitado?: boolean;\n  /** D15C: executar intraday ML. Padrao: INTRADAY_CANONICO_HABILITADO (false). Shopee intraday e sempre recusado. */\n  intraday?: boolean;\n}\n\nconst MOTORES_REAIS: MotoresCanonicos = { ml: executarFatiaML, mlIntraday: executarFatiaMLIntraday, shopee: executarFatiaShopee, catchup: executarFatiaCatchUpEscrow };\n"
  },
  {
    "base": "  if (tipo === \"NAO_CANONICO\" || tipo !== ganho.tipo) return recusar(\"tipo_mudou_apos_claim\", \"validation\");\n  // D15B (fail-closed): nenhum motor intraday existe ainda (D15C/D15D) — nunca executar como janela normal\n  if (ehJobIntraday({ tipo: r.tipo, campoTempo: r.campo_tempo, janelaInicio: r.janela_inicio, janelaFim: r.janela_fim, dateFrom: r.date_from, dateTo: r.date_to })) return recusar(\"intraday_sem_motor\", \"validation\");\n",
    "d15c": "  if (tipo === \"NAO_CANONICO\" || tipo !== ganho.tipo) return recusar(\"tipo_mudou_apos_claim\", \"validation\");\n  // D15B/D15C (fail-closed): intraday so com o intraday habilitado E so ML (D15C); Shopee intraday\n  // nao tem motor (D15D). Nunca executar intraday como janela normal.\n  const intraday = ehJobIntraday({ tipo: r.tipo, campoTempo: r.campo_tempo, janelaInicio: r.janela_inicio, janelaFim: r.janela_fim, dateFrom: r.date_from, dateTo: r.date_to });\n  if (intraday && (!(opcoes.intraday ?? INTRADAY_CANONICO_HABILITADO) || tipo !== \"ML_DATE_CLOSED\" || !motores.mlIntraday)) return recusar(\"intraday_sem_motor\", \"validation\");\n"
  },
  {
    "base": "  if (!checkpointCompativel(tipo, r.checkpoint)) return recusar(\"checkpoint_incompativel\", \"validation\");\n  if (tipo === \"ML_DATE_CLOSED\") {\n    const l = limitesDaJanela(String(r.date_from), String(r.date_to));",
    "d15c": "  if (!checkpointCompativel(tipo, r.checkpoint)) return recusar(\"checkpoint_incompativel\", \"validation\");\n  if (tipo === \"ML_DATE_CLOSED\" && !intraday) {\n    const l = limitesDaJanela(String(r.date_from), String(r.date_to));"
  },
  {
    "base": "  }\n",
    "d15c": "  }\n  if (tipo === \"ML_DATE_CLOSED\" && intraday) {\n    // D15C: o intraday ML relista o dia INTEIRO ate T — a janela comeca no inicio do dia do job\n    const l = limitesDaJanela(String(r.date_from), String(r.date_from));\n    if (!l || l.inicio.getTime() !== Date.parse(r.janela_inicio)) return recusar(\"janela_inconsistente\", \"validation\");\n  }\n"
  },
  {
    "base": "  try {\n    if (tipo === \"ML_DATE_CLOSED\") {\n      const p = await deps.portasML(job);",
    "d15c": "  try {\n    if (tipo === \"ML_DATE_CLOSED\" && intraday) {\n      const p = await deps.portasML(job);\n      res = await motores.mlIntraday!({ id: job.id, userId: job.userId, lojaId: job.lojaId, dia: String(r.date_from), alvoIso: String(r.janela_fim),\n        checkpoint: (r.checkpoint ?? null) as CheckpointML | null, progresso: (r.progresso ?? null) as ProgressoML | null }, { ...p, relogio }, opMotor);\n    } else if (tipo === \"ML_DATE_CLOSED\") {\n      const p = await deps.portasML(job);"
  }
];

const lf = (s: string) => s.replace(/\r\n/g, "\n");
const blob = (raiz: string, rev: string, arquivo: string) => {
  try { return lf(execFileSync("git", ["show", `${rev}:${arquivo}`], { cwd: raiz, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })); } catch { return null; }
};

/** worker.ts ATUAL − hunks D15C = bytes de b260583? */
export function reconstruirWorkerD15C(raiz: string): { valido: boolean; motivo: string } {
  let s = lf(readFileSync(join(raiz, WORKER_D15C), "utf8"));
  for (const h of HUNKS_WORKER_D15C) {
    if (s.split(h.d15c).length - 1 !== 1) return { valido: false, motivo: "hunk_nao_encontrado_ou_repetido" };
    s = s.replace(h.d15c, () => h.base);
  }
  const base = blob(raiz, BASE_D15C, WORKER_D15C);
  return base !== null && s === base ? { valido: true, motivo: "" } : { valido: false, motivo: "reconstrucao_difere_de_b260583" };
}

/** O motor intraday ML com o conteudo EXATO do D15C. */
export function motorIntradayMLExato(raiz: string): boolean {
  try { return createHash("sha256").update(lf(readFileSync(join(raiz, MOTOR_INTRADAY_ML), "utf8"))).digest("hex") === SHA256_MOTOR_INTRADAY_ML; }
  catch { return false; }
}

/**
 * Remove da lista de alterados SO o que a excecao D15C cobre:
 *   - worker.ts quando ATUAL − D15C = b260583 E o worker.ts na base do guard
 *     e o de antes do D15B (d631748) — nada fora do D15B/D15C mudou;
 *   - o motor intraday ML (conteudo exato) e este helper, se nao existiam na base.
 */
export function filtrarExcecaoD15C(raiz: string, base: string, alterados: string[]): string[] {
  return alterados.filter((f) => {
    if (f === WORKER_D15C) return !(reconstruirWorkerD15C(raiz).valido && blob(raiz, base, f) === blob(raiz, ANTES_D15B, f));
    if (ARQUIVOS_NOVOS_D15C.includes(f) && blob(raiz, base, f) === null) return f === MOTOR_INTRADAY_ML ? !motorIntradayMLExato(raiz) : false;
    return true;
  });
}
