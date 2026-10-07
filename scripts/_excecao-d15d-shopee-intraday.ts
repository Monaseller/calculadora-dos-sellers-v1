/**
 * SALES-SYNC-D15D2 — excecao EXATA dos guards de escopo para o patch D15D
 * (motor INTRADAY Shopee).
 *
 *   lib/vendas/sync/worker.ts  ATUAL − hunks D15D aprovados = BYTE-IDENTICO
 *                              ao worker.ts de e90557e (que ja contem D15B,
 *                              D14.1 e D15C). As camadas anteriores
 *                              (d631748 → e90557e) sao historia imutavel ja
 *                              validada pelas excecoes D15B/D15C; aqui so se
 *                              exige que a base do guard nao tenha mudado
 *                              antes delas (= d631748).
 *   lib/shopee/ingestao/intraday.ts
 *                              arquivo NOVO, path exato, conteudo pinado por
 *                              sha256 (qualquer byte a mais → falha).
 *   este helper                arquivo novo (para o guard do cron).
 *
 * Nada mais: motor.ts, transporte.ts, persistencia.ts, normalizar.ts e
 * retry.ts da Shopee e os leitores canonicos continuam travados; nenhum glob
 * em ingestao/. As excecoes D13, D14, D15B e D15C seguem independentes e nao
 * sao ampliadas.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const BASE_D15D = "e90557e";
/** O worker.ts antes do D15B (a base historica das camadas D15B/D15C/D15D). */
const ANTES_D15B = "d631748";

export const WORKER_D15D = "lib/vendas/sync/worker.ts";
export const MOTOR_INTRADAY_SHOPEE = "lib/shopee/ingestao/intraday.ts";
export const ARQUIVOS_NOVOS_D15D: readonly string[] = [MOTOR_INTRADAY_SHOPEE, "scripts/_excecao-d15d-shopee-intraday.ts"];

/** sha256 (LF) do motor intraday Shopee aprovado no D15D. */
const SHA256_MOTOR_INTRADAY_SHOPEE = "66ffcb81ab8652455788fa4ddf26a8a6ae0fece38e9af3acc9a8e26e8e7ab999";

/** Hunks APROVADOS do worker (contexto de 1 linha): `d15d` no arquivo atual ↔ `base` em e90557e. */
const HUNKS_WORKER_D15D: { base: string; d15d: string }[] = [
  {
    "base": "import type { CheckpointML, ProgressoML, RepositorioML, TransporteML } from \"@/lib/mercado-livre/ingestao/tipos\";\nimport { executarFatiaCatchUpEscrow, executarFatiaShopee } from \"@/lib/shopee/ingestao/motor\";",
    "d15d": "import type { CheckpointML, ProgressoML, RepositorioML, TransporteML } from \"@/lib/mercado-livre/ingestao/tipos\";\nimport { criarCandidatosRedetalheShopee, executarFatiaShopeeIntraday } from \"@/lib/shopee/ingestao/intraday\";\nimport { executarFatiaCatchUpEscrow, executarFatiaShopee } from \"@/lib/shopee/ingestao/motor\";"
  },
  {
    "base": "  mlIntraday?: typeof executarFatiaMLIntraday;\n  shopee: typeof executarFatiaShopee;",
    "d15d": "  mlIntraday?: typeof executarFatiaMLIntraday;\n  /** D15D: observacao intraday Shopee (so com o intraday habilitado). */\n  shopeeIntraday?: typeof executarFatiaShopeeIntraday;\n  shopee: typeof executarFatiaShopee;"
  },
  {
    "base": "  habilitado?: boolean;\n  /** D15C: executar intraday ML. Padrao: INTRADAY_CANONICO_HABILITADO (false). Shopee intraday e sempre recusado. */\n  intraday?: boolean;",
    "d15d": "  habilitado?: boolean;\n  /** D15C/D15D: executar intraday (ML e Shopee). Padrao: INTRADAY_CANONICO_HABILITADO (false). */\n  intraday?: boolean;"
  },
  {
    "base": "\nconst MOTORES_REAIS: MotoresCanonicos = { ml: executarFatiaML, mlIntraday: executarFatiaMLIntraday, shopee: executarFatiaShopee, catchup: executarFatiaCatchUpEscrow };\n",
    "d15d": "\nconst MOTORES_REAIS: MotoresCanonicos = { ml: executarFatiaML, mlIntraday: executarFatiaMLIntraday, shopee: executarFatiaShopee, shopeeIntraday: executarFatiaShopeeIntraday, catchup: executarFatiaCatchUpEscrow };\n"
  },
  {
    "base": "  if (tipo === \"NAO_CANONICO\" || tipo !== ganho.tipo) return recusar(\"tipo_mudou_apos_claim\", \"validation\");\n  // D15B/D15C (fail-closed): intraday so com o intraday habilitado E so ML (D15C); Shopee intraday\n  // nao tem motor (D15D). Nunca executar intraday como janela normal.\n  const intraday = ehJobIntraday({ tipo: r.tipo, campoTempo: r.campo_tempo, janelaInicio: r.janela_inicio, janelaFim: r.janela_fim, dateFrom: r.date_from, dateTo: r.date_to });\n  if (intraday && (!(opcoes.intraday ?? INTRADAY_CANONICO_HABILITADO) || tipo !== \"ML_DATE_CLOSED\" || !motores.mlIntraday)) return recusar(\"intraday_sem_motor\", \"validation\");\n",
    "d15d": "  if (tipo === \"NAO_CANONICO\" || tipo !== ganho.tipo) return recusar(\"tipo_mudou_apos_claim\", \"validation\");\n  // D15B/D15C/D15D (fail-closed): intraday so com o intraday habilitado, e so para o tipo com motor\n  // intraday proprio (ML → mlIntraday; Shopee create_time → shopeeIntraday). Nunca como janela normal.\n  const intraday = ehJobIntraday({ tipo: r.tipo, campoTempo: r.campo_tempo, janelaInicio: r.janela_inicio, janelaFim: r.janela_fim, dateFrom: r.date_from, dateTo: r.date_to });\n  const motorIntraday = tipo === \"ML_DATE_CLOSED\" ? motores.mlIntraday : tipo === \"SHOPEE_CREATE_TIME\" ? motores.shopeeIntraday : undefined;\n  if (intraday && (!(opcoes.intraday ?? INTRADAY_CANONICO_HABILITADO) || !motorIntraday)) return recusar(\"intraday_sem_motor\", \"validation\");\n"
  },
  {
    "base": "      }\n      res = tipo === \"SHOPEE_CREATE_TIME\"\n        ? await motores.shopee({ id: job.id, userId: job.userId, lojaId: job.lojaId, campoTempo: \"create_time\", janelaInicio: r.janela_inicio, janelaFim: r.janela_fim,",
    "d15d": "      }\n      res = tipo === \"SHOPEE_CREATE_TIME\" && intraday\n        ? await motores.shopeeIntraday!({ id: job.id, userId: job.userId, lojaId: job.lojaId, dia: String(r.date_from), alvoIso: String(r.janela_fim),\n          checkpoint: (r.checkpoint ?? null) as CheckpointShopee | null, progresso: (r.progresso ?? null) as ProgressoShopee | null },\n          { ...p, relogio, candidatos: criarCandidatosRedetalheShopee(cliente) }, opMotor)\n        : tipo === \"SHOPEE_CREATE_TIME\"\n        ? await motores.shopee({ id: job.id, userId: job.userId, lojaId: job.lojaId, campoTempo: \"create_time\", janelaInicio: r.janela_inicio, janelaFim: r.janela_fim,"
  }
];

const lf = (s: string) => s.replace(/\r\n/g, "\n");
const blob = (raiz: string, rev: string, arquivo: string) => {
  try { return lf(execFileSync("git", ["show", `${rev}:${arquivo}`], { cwd: raiz, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })); } catch { return null; }
};

/** worker.ts ATUAL − hunks D15D = bytes de e90557e? */
export function reconstruirWorkerD15D(raiz: string): { valido: boolean; motivo: string } {
  let s = lf(readFileSync(join(raiz, WORKER_D15D), "utf8"));
  for (const h of HUNKS_WORKER_D15D) {
    if (s.split(h.d15d).length - 1 !== 1) return { valido: false, motivo: "hunk_nao_encontrado_ou_repetido" };
    s = s.replace(h.d15d, () => h.base);
  }
  const base = blob(raiz, BASE_D15D, WORKER_D15D);
  return base !== null && s === base ? { valido: true, motivo: "" } : { valido: false, motivo: "reconstrucao_difere_de_e90557e" };
}

/** O motor intraday Shopee com o conteudo EXATO do D15D. */
export function motorIntradayShopeeExato(raiz: string): boolean {
  try { return createHash("sha256").update(lf(readFileSync(join(raiz, MOTOR_INTRADAY_SHOPEE), "utf8"))).digest("hex") === SHA256_MOTOR_INTRADAY_SHOPEE; }
  catch { return false; }
}

/**
 * Remove da lista de alterados SO o que a excecao D15D cobre:
 *   - worker.ts quando ATUAL − D15D = e90557e E o worker.ts na base do guard
 *     e o de antes do D15B (d631748) — nada fora de D15B/D15C/D15D mudou;
 *   - o motor intraday Shopee (conteudo exato) e este helper, se nao existiam na base.
 */
export function filtrarExcecaoD15D(raiz: string, base: string, alterados: string[]): string[] {
  return alterados.filter((f) => {
    if (f === WORKER_D15D) return !(reconstruirWorkerD15D(raiz).valido && blob(raiz, base, f) === blob(raiz, ANTES_D15B, f));
    if (ARQUIVOS_NOVOS_D15D.includes(f) && blob(raiz, base, f) === null) return f === MOTOR_INTRADAY_SHOPEE ? !motorIntradayShopeeExato(raiz) : false;
    return true;
  });
}
