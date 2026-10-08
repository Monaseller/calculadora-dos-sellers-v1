/**
 * SALES-SYNC-D15F2B — excecao EXATA dos guards de escopo para o ENABLE do
 * intraday canonico em producao.
 *
 * A UNICA mudanca funcional aprovada e UMA linha em lib/vendas/sync/intraday.ts:
 *     export const INTRADAY_CANONICO_HABILITADO = false;
 *  →  export const INTRADAY_CANONICO_HABILITADO = true;
 *
 * O arquivo atual so passa se:
 *   - a linha ligada aparece EXATAMENTE uma vez;
 *   - trocando-a de volta pela linha desligada, o resultado e BYTE-IDENTICO ao
 *     blob de 34d982f (forma canonica LF, como o git guarda);
 *   - esse blob de 34d982f e o conteudo aprovado no D15B (sha256), ou seja,
 *     a cadeia D15B → D15F2 continua inteira.
 * Qualquer outra linha (cadencia, classificador, grade, prioridade, forma
 * alternativa de ligar) → falha.
 *
 * Nada mais em lib/vendas/sync e liberado. As excecoes D13/D14/D15B/D15C/D15D
 * seguem independentes e nao sao ampliadas.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const BASE_D15F2 = "34d982f";
export const ARQUIVO_ENABLE_D15F2 = "lib/vendas/sync/intraday.ts";
/** Arquivos NOVOS fora de scripts/testar-* que os guards de escopo enxergam. */
export const ARQUIVOS_NOVOS_D15F2: readonly string[] = ["scripts/_excecao-d15f2-enable-intraday.ts"];

const LINHA_DESLIGADA = "export const INTRADAY_CANONICO_HABILITADO = false;";
const LINHA_LIGADA = "export const INTRADAY_CANONICO_HABILITADO = true;";
/** sha256 (LF) do intraday.ts aprovado no D15B (= conteudo em 34d982f). */
const SHA256_INTRADAY_D15B = "3de5fba1b0d34313b62a6e680000d96b9d81165eb00b00360378d5bcf430fb6d";

const lf = (s: string) => s.replace(/\r\n/g, "\n");
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
function blob(raiz: string, rev: string, arquivo: string): string | null {
  try { return lf(execFileSync("git", ["show", `${rev}:${arquivo}`], { cwd: raiz, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })); }
  catch { return null; }
}

/** intraday.ts atual = 34d982f com SO a linha do enable trocada (false → true). */
export function enableExatoD15F2(raiz: string): { valido: boolean; motivo: string } {
  let atual: string;
  try { atual = lf(readFileSync(join(raiz, ARQUIVO_ENABLE_D15F2), "utf8")); } catch { return { valido: false, motivo: "arquivo_ausente" }; }
  if (atual.split(LINHA_LIGADA).length !== 2) return { valido: false, motivo: "linha_ligada_ausente_ou_repetida" };
  if (atual.includes(LINHA_DESLIGADA)) return { valido: false, motivo: "linha_desligada_ainda_presente" };
  const base = blob(raiz, BASE_D15F2, ARQUIVO_ENABLE_D15F2);
  if (base === null || sha(base) !== SHA256_INTRADAY_D15B) return { valido: false, motivo: "base_34d982f_difere_do_d15b" };
  return atual.replace(LINHA_LIGADA, () => LINHA_DESLIGADA) === base ? { valido: true, motivo: "" } : { valido: false, motivo: "reconstrucao_difere_de_34d982f" };
}

/**
 * Remove da lista de alterados SO o que a excecao D15F2 cobre:
 *   - lib/vendas/sync/intraday.ts quando enableExatoD15F2;
 *   - este helper, se nao existia na base do guard.
 */
export function filtrarExcecaoD15F2(raiz: string, base: string, alterados: string[]): string[] {
  return alterados.filter((f) => {
    if (f === ARQUIVO_ENABLE_D15F2) return !enableExatoD15F2(raiz).valido;
    if (ARQUIVOS_NOVOS_D15F2.includes(f) && blob(raiz, base, f) === null) return false;
    return true;
  });
}
