/**
 * SALES-SYNC-D15B2 — excecao EXATA dos guards de escopo para o patch D15B
 * (planejamento intraday) nos arquivos de sync que JA existiam:
 *   lib/vendas/sync/{coordenador-tick,coordenador,planejamento,tipos,worker}.ts
 *
 * Nao e "mudanca de intraday permitida" nem "so adicoes": o arquivo atual so
 * passa se, revertendo EXATAMENTE os hunks aprovados abaixo (gerados do diff
 * D15B contra d631748), o resultado for BYTE-IDENTICO ao blob de d631748
 * (forma canonica LF, como o git guarda). Qualquer outra linha, helper extra,
 * ou hunk alterado → falha.
 *
 * Arquivos NOVOS cobertos (so se nao existiam na base do guard):
 *   lib/vendas/sync/intraday.ts — e com o conteudo EXATO do D15B (sha256);
 *   este helper (para o guard do cron).
 * O teste scripts/testar-vendas-sync-intraday.ts ja e coberto pelas regras
 * de scripts/testar-* dos guards. Nada mais em lib/vendas/sync e liberado.
 *
 * A2-ML (vendas-sync-coordenador): planejarML so pode diferir do base
 * historico pela exclusao de intraday da cobertura fechada (HUNK_A2_ML).
 *
 * As excecoes D13 e D14 seguem independentes e nao sao ampliadas.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const BASE_D15B = "d631748";

export const D15B_EXISTING_FILES: readonly string[] = [
  "lib/vendas/sync/coordenador-tick.ts",
  "lib/vendas/sync/coordenador.ts",
  "lib/vendas/sync/planejamento.ts",
  "lib/vendas/sync/tipos.ts",
  "lib/vendas/sync/worker.ts",
];

export const D15B_NEW_FILES: readonly string[] = ["lib/vendas/sync/intraday.ts"];
/** Arquivos NOVOS fora de scripts/testar-* que os guards de escopo enxergam. */
export const ARQUIVOS_NOVOS_D15B: readonly string[] = [...D15B_NEW_FILES, "scripts/_excecao-d15b-intraday.ts"];

/** sha256 (LF) do intraday.ts aprovado no D15B. */
const SHA256_INTRADAY_D15B = "3de5fba1b0d34313b62a6e680000d96b9d81165eb00b00360378d5bcf430fb6d";

/** Hunks APROVADOS (contexto de 1 linha): `d15b` no arquivo atual ↔ `base` em d631748. */
const PATCH_D15B: Record<string, { base: string; d15b: string }[]> = {
  "lib/vendas/sync/coordenador-tick.ts": [
    {
      "base": "import { avaliarNecessidadeDeSync, garantirProximaAcao, lerJobsDasLojas } from \"./coordenador\";\nimport { agregar, avaliarBootstrap, OPCOES_BACKFILL_INICIAL, POLITICA_SYNC_PROPOSTA } from \"./planejamento\";\nimport type { AvaliacaoLojaSync, AvaliacaoSync, MarketplaceSync, PoliticaSync } from \"./tipos\";",
      "d15b": "import { avaliarNecessidadeDeSync, garantirProximaAcao, lerJobsDasLojas } from \"./coordenador\";\nimport { INTRADAY_CANONICO_HABILITADO } from \"./intraday\";\nimport { agregar, avaliarBootstrap, avaliarIntradayLoja, OPCOES_BACKFILL_INICIAL, POLITICA_SYNC_PROPOSTA, type EstadoIntraday } from \"./planejamento\";\nimport type { AvaliacaoLojaSync, AvaliacaoSync, MarketplaceSync, PoliticaSync } from \"./tipos\";"
    },
    {
      "base": "  jobAtivoId?: string | null;\n}",
      "d15b": "  jobAtivoId?: string | null;\n  /** D15B: estado da necessidade intraday (so quando o intraday esta habilitado). */\n  intraday?: EstadoIntraday;\n}"
    },
    {
      "base": "  log?: (evento: Record<string, unknown>) => void;\n}",
      "d15b": "  log?: (evento: Record<string, unknown>) => void;\n  /** D15B: planejar a observacao intraday do dia corrente. Padrao: INTRADAY_CANONICO_HABILITADO (false ate D15C/D15D). */\n  intraday?: boolean;\n}"
    },
    {
      "base": "  const { fase, avaliacao: boot } = faseDoBootstrap(loja, jobs, agoraMs, politica);\n  const avaliacoes: AvaliacaoSync[] = [manutencao, ...(boot ? [agregar([boot])] : [])];\n  const lm = manutencao.lojas[0];\n  const base = { lojaId: loja.id, marketplace: loja.marketplace, faseBootstrap: fase, estado: lm ? { cobertura: lm.cobertura, frescor: lm.frescor, definitivo: lm.definitivo } : undefined };\n  const g = await garantirProximaAcao(cliente, loja.userId, avaliacoes, { habilitado: true });",
      "d15b": "  const { fase, avaliacao: boot } = faseDoBootstrap(loja, jobs, agoraMs, politica);\n  // D15B: intraday entra na MESMA escolha por prioridade (interleave), so se habilitado\n  const intraday = (deps.intraday ?? INTRADAY_CANONICO_HABILITADO)\n    ? avaliarIntradayLoja({ loja: { id: loja.id, marketplace: loja.marketplace }, agoraMs, jobs, politica }) : null;\n  const avaliacoes: AvaliacaoSync[] = [manutencao, ...(boot ? [agregar([boot])] : []), ...(intraday ? [agregar([intraday.avaliacao])] : [])];\n  const lm = manutencao.lojas[0];\n  const base = { lojaId: loja.id, marketplace: loja.marketplace, faseBootstrap: fase, estado: lm ? { cobertura: lm.cobertura, frescor: lm.frescor, definitivo: lm.definitivo } : undefined,\n    ...(intraday ? { intraday: intraday.estado } : {}) };\n  const g = await garantirProximaAcao(cliente, loja.userId, avaliacoes, { habilitado: true });"
    }
  ],
  "lib/vendas/sync/coordenador.ts": [
    {
      "base": "import { contarEscrowPendenteShopee, contarNaoPagosSemObservacaoShopee, LIMITE_POLITICA_PAGAMENTO_MS } from \"@/lib/vendas/canonico/shopee\";\nimport { agregar, avaliarLoja, proximaAcaoCombinada } from \"./planejamento\";",
      "d15b": "import { contarEscrowPendenteShopee, contarNaoPagosSemObservacaoShopee, LIMITE_POLITICA_PAGAMENTO_MS } from \"@/lib/vendas/canonico/shopee\";\nimport { ehJobIntraday } from \"./intraday\";\nimport { agregar, avaliarLoja, proximaAcaoCombinada } from \"./planejamento\";"
    },
    {
      "base": "  const { data, error } = await cliente.from(\"sync_jobs\")\n    .select(\"id, loja_id, marketplace, campo_tempo, janela_inicio, janela_fim, status, listagem_completa, concluido_em, criado_em, modo:checkpoint->>modo\")\n    .eq(\"user_id\", userId).in(\"loja_id\", lojaIds);",
      "d15b": "  const { data, error } = await cliente.from(\"sync_jobs\")\n    .select(\"id, loja_id, marketplace, campo_tempo, janela_inicio, janela_fim, status, listagem_completa, concluido_em, criado_em, tipo, date_from, date_to, modo:checkpoint->>modo\")\n    .eq(\"user_id\", userId).in(\"loja_id\", lojaIds);"
    },
    {
      "base": "    concluidoEm: r.concluido_em ?? null, criadoEm: r.criado_em,\n    catchup: r.campo_tempo == null && r.janela_inicio == null && r.modo === \"escrow_catchup\" }));\n}",
      "d15b": "    concluidoEm: r.concluido_em ?? null, criadoEm: r.criado_em,\n    catchup: r.campo_tempo == null && r.janela_inicio == null && r.modo === \"escrow_catchup\",\n    // D15B: so para classificar intraday (ehJobIntraday)\n    tipo: r.tipo ?? null, dateFrom: r.date_from ?? null, dateTo: r.date_to ?? null }));\n}"
    },
    {
      "base": "  try {\n    if (j.marketplace === \"ML\") return await criarJobFechamentoML(cliente, { userId, lojaId: j.lojaId, de: j.de, ate: j.ate });",
      "d15b": "  try {\n    if (j.proposito === \"intraday\") {\n      // D15B: tipo 'incremental' + janela de UM dia civil = intraday (ehJobIntraday). Fail-closed: so insere o que o classificador reconhece.\n      const linha = { user_id: userId, loja_id: j.lojaId, marketplace: j.marketplace, status: \"pendente\", date_from: j.de, date_to: j.ate,\n        tipo: \"incremental\", campo_tempo: j.campoTempo, janela_inicio: j.inicio, janela_fim: j.fim, listagem_completa: false };\n      if (!ehJobIntraday({ tipo: linha.tipo, campoTempo: linha.campo_tempo, janelaInicio: linha.janela_inicio, janelaFim: linha.janela_fim, dateFrom: linha.date_from, dateTo: linha.date_to })) {\n        throw new Error(\"criar_job:intraday_invalido\");\n      }\n      const { data, error } = await cliente.from(\"sync_jobs\").insert(linha).select(\"id\").single();\n      if (error) { if ((error as { code?: string }).code === \"23505\") return null; throw new Error(`criar_job:${error.message}`); }\n      return (data as { id: string }).id;\n    }\n    if (j.marketplace === \"ML\") return await criarJobFechamentoML(cliente, { userId, lojaId: j.lojaId, de: j.de, ate: j.ate });"
    }
  ],
  "lib/vendas/sync/planejamento.ts": [
    {
      "base": "import { LIMITE_POLITICA_PAGAMENTO_MS } from \"@/lib/vendas/canonico/shopee\";\nimport type {",
      "d15b": "import { LIMITE_POLITICA_PAGAMENTO_MS } from \"@/lib/vendas/canonico/shopee\";\nimport {\n  alvoIntradayMs, CADENCIA_INTRADAY_MS, chaveIntraday, ehJobIntraday, ehJobIntradayDoDia, limitesDoDiaMs, PRIORIDADE_INTRADAY,\n} from \"./intraday\";\nimport type {"
    },
    {
      "base": "function planejarML(loja: LojaAtivaSync, de: string, ate: string, agoraMs: number, jobs: JobExistenteSync[], pol: PoliticaSync, origem: OrigemPedido): Parcial {\n  const meus = jobs.filter((j) => j.lojaId === loja.id && j.marketplace === \"ML\" && j.campoTempo === \"date_closed\" && j.janelaInicio && j.janelaFim);\n  const faltam: string[] = [], velhos: string[] = [], refreshaveis: string[] = [], esgotado: string[] = [], andamento = new Set<string>();",
      "d15b": "function planejarML(loja: LojaAtivaSync, de: string, ate: string, agoraMs: number, jobs: JobExistenteSync[], pol: PoliticaSync, origem: OrigemPedido): Parcial {\n  // D15B: intraday prova so OBSERVED_THROUGH — nunca cobertura de dia fechado\n  const meus = jobs.filter((j) => j.lojaId === loja.id && j.marketplace === \"ML\" && j.campoTempo === \"date_closed\" && j.janelaInicio && j.janelaFim && !ehJobIntraday(j));\n  const faltam: string[] = [], velhos: string[] = [], refreshaveis: string[] = [], esgotado: string[] = [], andamento = new Set<string>();"
    },
    {
      "base": "  const necessario: Iv = [l.inicio.getTime() - LIMITE_POLITICA_PAGAMENTO_MS, l.fim.getTime()];\n  const meus = jobs.filter((j) => j.lojaId === loja.id && j.marketplace === \"Shopee\");\n  const descoberta = meus.filter((j) => j.campoTempo === \"create_time\" && j.janelaInicio && j.janelaFim);",
      "d15b": "  const necessario: Iv = [l.inicio.getTime() - LIMITE_POLITICA_PAGAMENTO_MS, l.fim.getTime()];\n  // D15B: intraday prova so OBSERVED_THROUGH — nunca cobertura de periodo fechado\n  const meus = jobs.filter((j) => j.lojaId === loja.id && j.marketplace === \"Shopee\" && !ehJobIntraday(j));\n  const descoberta = meus.filter((j) => j.campoTempo === \"create_time\" && j.janelaInicio && j.janelaFim);"
    },
    {
      "base": "}",
      "d15b": "}\n\n// ── Intraday (SALES-SYNC-D15B) ──\n\n/** Estado do intraday de uma loja, para relatorio (a acao continua sendo decidida por escolherProximaAcao). */\nexport type EstadoIntraday =\n  | \"NEED_INTRADAY\" | \"WAIT_INTRADAY_CADENCE\" | \"INTRADAY_ALREADY_AT_TARGET\" | \"INTRADAY_SEM_ALVO\"\n  | \"WAIT_ACTIVE_JOB\" | \"WAIT_RETRY\" | \"FAILED\";\n\n/**\n * Necessidade INTRADAY de UMA loja: observar o dia corrente ate T (grade de\n * 15 min), no maximo a cada 30 min (pelo T da ultima observacao CONCLUIDA —\n * zero linhas tambem e observacao: so o job conta, nunca as linhas). Entra na\n * MESMA fila serial (escolherProximaAcao): job ativo → espera; falhas → a\n * MESMA politica (avaliarFalhas). Nunca vira cobertura fechada.\n *\n *   ML      [inicio do dia, T]           (relista o dia ate T — check B)\n *   Shopee  [ultimo T concluido, T]      (create_time incremental; REDETAIL no D15D)\n */\nexport function avaliarIntradayLoja(args: { loja: LojaAtivaSync; agoraMs: number; jobs: JobExistenteSync[]; politica: PoliticaSync }): { estado: EstadoIntraday; avaliacao: AvaliacaoLojaSync } {\n  const { loja, agoraMs, jobs, politica } = args;\n  const hoje = diaEmSaoPaulo(isoDe(agoraMs))!;\n  const dia = limitesDoDiaMs(hoje)!;\n  const campo = loja.marketplace === \"ML\" ? \"date_closed\" : \"create_time\";\n  const alvo = alvoIntradayMs(agoraMs);\n  const meus = jobs.filter((j) => j.lojaId === loja.id && j.marketplace === loja.marketplace && j.campoTempo === campo && ehJobIntradayDoDia(j, hoje));\n  const ativo = jobs.find((j) => j.lojaId === loja.id && ATIVOS.has(j.status))?.id ?? null;\n  const concluidos = meus.filter(completo);\n  const ultimoT = Math.max(...concluidos.map((j) => t(j.janelaFim)).filter(Number.isFinite), -Infinity);\n  const ultimoSucesso = Math.max(...concluidos.map((j) => t(j.concluidoEm)).filter(Number.isFinite), -Infinity);\n\n  const resultado = (estado: EstadoIntraday, necessidades: Necessidade[], esperaAte: string | null = null, esgotado: string[] = []) => ({\n    estado: ativo && necessidades.length ? \"WAIT_ACTIVE_JOB\" as const : estado,\n    avaliacao: {\n      lojaId: loja.id, marketplace: loja.marketplace, cobertura: \"PARTIAL\" as Cobertura, frescor: \"IN_PROGRESS\" as Frescor, definitivo: false,\n      sincronizacao: (ativo ? \"SYNCING\" : esperaAte ? \"WAITING_RETRY\" : \"IDLE\") as Sincronizacao,\n      motivos: [`intraday:${estado}`], faltando: [], desatualizado: [], necessidades,\n      proximaAcao: escolherProximaAcao({ necessidades, jobAtivoDaLoja: ativo, esperaAte, esgotado }), jobsEmAndamento: ativo ? [ativo] : [],\n    },\n  });\n\n  if (alvo <= dia.inicio) return resultado(\"INTRADAY_SEM_ALVO\", []);\n  if (ultimoT >= alvo) return resultado(\"INTRADAY_ALREADY_AT_TARGET\", []);\n  if (ultimoT > alvo - CADENCIA_INTRADAY_MS) return resultado(\"WAIT_INTRADAY_CADENCE\", []);\n  const f = avaliarFalhas(meus, [dia.inicio, dia.fim], ultimoSucesso, politica, agoraMs);\n  if (f.estado === \"esgotado\") return resultado(\"FAILED\", [], null, [\"intraday_falhas_repetidas\"]);\n  if (f.estado === \"esperar\") return resultado(\"WAIT_RETRY\", [], f.ate!);\n\n  const inicio = campo === \"date_closed\" ? dia.inicio : Math.max(dia.inicio, ultimoT);\n  const job: JobPlanejado = {\n    chave: chaveIntraday(loja.marketplace, loja.id, campo, isoDe(dia.inicio), isoDe(alvo)), marketplace: loja.marketplace, lojaId: loja.id,\n    campoTempo: campo, inicio: isoDe(inicio), fim: isoDe(alvo), de: hoje, ate: hoje, proposito: \"intraday\",\n  };\n  return resultado(\"NEED_INTRADAY\", [{ job, tipo: \"refresh\", prioridade: PRIORIDADE_INTRADAY }]);\n}"
    }
  ],
  "lib/vendas/sync/tipos.ts": [
    {
      "base": "  catchup?: boolean;\n}",
      "d15b": "  catchup?: boolean;\n  /** SALES-SYNC-D15B: tipo e dias date_from/date_to — so para classificar intraday (ehJobIntraday). */\n  tipo?: string | null;\n  dateFrom?: string | null;\n  dateTo?: string | null;\n}"
    },
    {
      "base": "\nexport type PropositoJob = \"descoberta\" | \"refresh\" | \"catchup_escrow\";\n",
      "d15b": "\n/** intraday (D15B): observacao do dia corrente ate T — nunca cobertura de periodo fechado. */\nexport type PropositoJob = \"descoberta\" | \"refresh\" | \"catchup_escrow\" | \"intraday\";\n"
    }
  ],
  "lib/vendas/sync/worker.ts": [
    {
      "base": "import { classificarJobParaWorker, type TipoTrabalhoCanonico } from \"./worker-contrato\";\n",
      "d15b": "import { classificarJobParaWorker, type TipoTrabalhoCanonico } from \"./worker-contrato\";\nimport { ehJobIntraday } from \"./intraday\";\n"
    },
    {
      "base": "const COLUNAS_CANDIDATO = \"id, marketplace, campo_tempo, janela_inicio, janela_fim, criado_em, modo:checkpoint->>modo\";\nconst COLUNAS_JOB = \"id, user_id, loja_id, marketplace, campo_tempo, janela_inicio, janela_fim, date_from, date_to, checkpoint, progresso, status, tentativas, max_tentativas, heartbeat_em, iniciado_em\";\n",
      "d15b": "const COLUNAS_CANDIDATO = \"id, marketplace, campo_tempo, janela_inicio, janela_fim, criado_em, modo:checkpoint->>modo\";\nconst COLUNAS_JOB = \"id, user_id, loja_id, marketplace, tipo, campo_tempo, janela_inicio, janela_fim, date_from, date_to, checkpoint, progresso, status, tentativas, max_tentativas, heartbeat_em, iniciado_em\";\n"
    },
    {
      "base": "  if (tipo === \"NAO_CANONICO\" || tipo !== ganho.tipo) return recusar(\"tipo_mudou_apos_claim\", \"validation\");\n",
      "d15b": "  if (tipo === \"NAO_CANONICO\" || tipo !== ganho.tipo) return recusar(\"tipo_mudou_apos_claim\", \"validation\");\n  // D15B (fail-closed): nenhum motor intraday existe ainda (D15C/D15D) — nunca executar como janela normal\n  if (ehJobIntraday({ tipo: r.tipo, campoTempo: r.campo_tempo, janelaInicio: r.janela_inicio, janelaFim: r.janela_fim, dateFrom: r.date_from, dateTo: r.date_to })) return recusar(\"intraday_sem_motor\", \"validation\");\n"
    }
  ]
};

/** O UNICO hunk tolerado dentro de planejarML pelo guard A2-ML. */
export const HUNK_A2_ML: { base: string; d15b: string } = {
  "base": "  const meus = jobs.filter((j) => j.lojaId === loja.id && j.marketplace === \"ML\" && j.campoTempo === \"date_closed\" && j.janelaInicio && j.janelaFim);",
  "d15b": "  // D15B: intraday prova so OBSERVED_THROUGH — nunca cobertura de dia fechado\n  const meus = jobs.filter((j) => j.lojaId === loja.id && j.marketplace === \"ML\" && j.campoTempo === \"date_closed\" && j.janelaInicio && j.janelaFim && !ehJobIntraday(j));"
};

const lf = (s: string) => s.replace(/\r\n/g, "\n");
const blob = (raiz: string, rev: string, arquivo: string) => {
  try { return lf(execFileSync("git", ["show", `${rev}:${arquivo}`], { cwd: raiz, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })); } catch { return null; }
};

function reverter(texto: string, hunks: { base: string; d15b: string }[]): string | null {
  let s = texto;
  for (const h of hunks) {
    if (s.split(h.d15b).length - 1 !== 1) return null;
    s = s.replace(h.d15b, () => h.base);
  }
  return s;
}

/** ATUAL − PATCH_D15B aprovado = bytes de d631748? */
export function reconstruirBaseD15B(raiz: string, arquivo: string): { valido: boolean; motivo: string } {
  const hunks = PATCH_D15B[arquivo];
  if (!hunks) return { valido: false, motivo: "arquivo_fora_da_excecao_d15b" };
  const s = reverter(lf(readFileSync(join(raiz, arquivo), "utf8")), hunks);
  if (s === null) return { valido: false, motivo: "hunk_nao_encontrado_ou_repetido" };
  const base = blob(raiz, BASE_D15B, arquivo);
  return base !== null && s === base ? { valido: true, motivo: "" } : { valido: false, motivo: "reconstrucao_difere_de_d631748" };
}

/** intraday.ts com o conteudo EXATO do D15B. */
export function intradayExatoD15B(raiz: string): boolean {
  try { return createHash("sha256").update(lf(readFileSync(join(raiz, "lib/vendas/sync/intraday.ts"), "utf8"))).digest("hex") === SHA256_INTRADAY_D15B; }
  catch { return false; }
}

/** planejarML sem o UNICO hunk D15B tolerado (null = hunk ausente ou repetido). */
export function planejarMLSemD15B(textoFuncao: string): string | null {
  return reverter(lf(textoFuncao), [HUNK_A2_ML]);
}

/**
 * Remove da lista de alterados SO o que a excecao D15B cobre:
 *   - os 5 arquivos de sync quando ATUAL − PATCH_D15B = d631748 E o arquivo
 *     na base do guard e o mesmo de d631748 (nada mais mudou desde ela);
 *   - intraday.ts (conteudo exato) e este helper, se nao existiam na base.
 */
export function filtrarExcecaoD15B(raiz: string, base: string, alterados: string[]): string[] {
  return alterados.filter((f) => {
    if (D15B_EXISTING_FILES.includes(f)) return !(reconstruirBaseD15B(raiz, f).valido && blob(raiz, base, f) === blob(raiz, BASE_D15B, f));
    if (ARQUIVOS_NOVOS_D15B.includes(f) && blob(raiz, base, f) === null) {
      return f === "lib/vendas/sync/intraday.ts" ? !intradayExatoD15B(raiz) : false;
    }
    return true;
  });
}
