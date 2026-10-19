/**
 * P1 sync_jobs — excecao EXATA dos guards de escopo para as correcoes P1 nos arquivos de sync que a excecao D15B
 * protege. Nesta release (etapa 1) so a correcao A:
 *   A  lerJobsDasLojas paginado (lerJanelasSyncJobs) — o PostgREST cortava a leitura unica em 1000 linhas.
 * (A correcao B — sinal de nao pagos, alvo na pendencia, frescor por idade — NAO esta nesta release.)
 *
 * Mesma regra da D15B: o arquivo atual so passa se, revertendo EXATAMENTE os hunks abaixo (cada um presente uma unica
 * vez), o resultado for BYTE-IDENTICO ao blob de BASE_P1 (forma LF) — e BASE_P1 por sua vez reconstroi d631748 pela
 * excecao D15B (testado em testar-vendas-sync-coordenador.ts, CP-D15B). Qualquer outra linha → falha.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const BASE_P1 = "8978451";

export const PATCH_P1: Record<string, { base: string; p1: string }[]> = {
  "lib/vendas/sync/coordenador.ts": [
    {
      "base": "  AvaliacaoLojaSync, AvaliacaoSync, JobExistenteSync, JobPlanejado, LojaAtivaSync, MarketplaceSync, OrigemPedido, PoliticaSync, ProximaAcao, SinaisShopeeSync,\n} from \"./tipos\";\n\nexport async function lerJobsDasLojas(cliente: SupabaseClient, userId: string, lojaIds: string[]): Promise<JobExistenteSync[]> {\n  if (!lojaIds.length) return [];\n  const { data, error } = await cliente.from(\"sync_jobs\")\n    .select(\"id, loja_id, marketplace, campo_tempo, janela_inicio, janela_fim, status, listagem_completa, concluido_em, criado_em, tipo, date_from, date_to, modo:checkpoint->>modo\")\n    .eq(\"user_id\", userId).in(\"loja_id\", lojaIds);\n  if (error) throw new Error(\"leitura_falhou\");\n  return ((data ?? []) as Record<string, any>[]).map((r) => ({ id: r.id, lojaId: r.loja_id, marketplace: r.marketplace, campoTempo: r.campo_tempo ?? null,\n    janelaInicio: r.janela_inicio ?? null, janelaFim: r.janela_fim ?? null, status: r.status, listagemCompleta: r.listagem_completa ?? null,\n    concluidoEm: r.concluido_em ?? null, criadoEm: r.criado_em,\n",
      "p1": "  AvaliacaoLojaSync, AvaliacaoSync, JobExistenteSync, JobPlanejado, LojaAtivaSync, MarketplaceSync, OrigemPedido, PoliticaSync, ProximaAcao, SinaisShopeeSync,\n} from \"./tipos\";\n// P1: a MESMA leitura paginada de sync_jobs dos leitores canonicos (keyset por id, fim so na pagina vazia, falha fechada)\nimport { lerJanelasSyncJobs } from \"@/lib/vendas/canonico/shopee\";\n\nexport async function lerJobsDasLojas(cliente: SupabaseClient, userId: string, lojaIds: string[]): Promise<JobExistenteSync[]> {\n  if (!lojaIds.length) return [];\n  // P1: TODOS os jobs, paginados por id — a leitura unica era cortada em 1000 linhas pelo PostgREST (sem erro) e o\n  // planejamento via buraco de cobertura onde nao havia. Pagina com erro → leitura_falhou: nenhuma decisao com conjunto parcial.\n  const data = await lerJanelasSyncJobs<Record<string, any>>(\"coordenador_jobs\", (apos, limite) => {\n    let q = cliente.from(\"sync_jobs\")\n      .select(\"id, loja_id, marketplace, campo_tempo, janela_inicio, janela_fim, status, listagem_completa, concluido_em, criado_em, tipo, date_from, date_to, modo:checkpoint->>modo\")\n      .eq(\"user_id\", userId).in(\"loja_id\", lojaIds);\n    if (apos !== null) q = q.gt(\"id\", apos);\n    return q.order(\"id\", { ascending: true }).limit(limite);\n  });\n  return data.map((r) => ({ id: r.id, lojaId: r.loja_id, marketplace: r.marketplace, campoTempo: r.campo_tempo ?? null,\n    janelaInicio: r.janela_inicio ?? null, janelaFim: r.janela_fim ?? null, status: r.status, listagemCompleta: r.listagem_completa ?? null,\n    concluidoEm: r.concluido_em ?? null, criadoEm: r.criado_em,\n"
    }
  ]
};

const lf = (s: string) => s.replace(/\r\n/g, "\n");

/** Texto ATUAL − PATCH_P1 (null = hunk ausente ou repetido). */
export function reverterP1(raiz: string, arquivo: string): string | null {
  const hunks = PATCH_P1[arquivo];
  if (!hunks) return null;
  let s = lf(readFileSync(join(raiz, arquivo), "utf8"));
  for (const h of hunks) {
    if (s.split(h.p1).length - 1 !== 1) return null;
    s = s.replace(h.p1, () => h.base);
  }
  return s;
}

/** ATUAL − PATCH_P1 = bytes de BASE_P1? */
export function reconstruirBaseP1(raiz: string, arquivo: string): { valido: boolean; motivo: string } {
  if (!PATCH_P1[arquivo]) return { valido: false, motivo: "arquivo_fora_da_excecao_p1" };
  const s = reverterP1(raiz, arquivo);
  if (s === null) return { valido: false, motivo: "hunk_nao_encontrado_ou_repetido" };
  let base: string;
  try { base = lf(execFileSync("git", ["show", `${BASE_P1}:${arquivo}`], { cwd: raiz, encoding: "utf8" })); } catch { return { valido: false, motivo: "base_indisponivel" }; }
  return s === base ? { valido: true, motivo: "" } : { valido: false, motivo: "reconstrucao_difere_de_base_p1" };
}
