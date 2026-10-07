/**
 * SALES-CANONICAL-D13A — excecao MINIMA e EXATA dos guards de escopo antigos
 * (vendas-sync-coordenador-tick, -cron, -auth-interna, -feature-flag).
 *
 * Autorizado SO:
 *   1. em lib/marketplace/credenciais.ts, UM bloco contiguo com
 *      `LinhaLojaParaVendasCanonicas` + `listarLojasDoDonoParaVendasCanonicas`
 *      (owner-scoped no banco, reusa classificarElegibilidadeSyncCanonico,
 *      devolve {id, marketplace, ativo, elegibilidade}, sem escrita);
 *   2. os arquivos NOVOS do D13 listados abaixo (que nao existiam na base).
 *
 * Qualquer outra mudanca em credenciais.ts — funcao extra dentro ou fora do
 * bloco, linha existente alterada — NAO e coberta: o guard continua falhando.
 * Nao e permissao generica para mudancas futuras em credenciais.ts.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const CAP_D13 = "lib/marketplace/credenciais.ts";

/**
 * SALES-CANONICAL-D13B: os arquivos NOVOS do D13 em lib/vendas/canonico —
 * lista EXATA (sem glob). Os que ja existiam (ml.ts, shopee.ts, tipos.ts)
 * nunca sao cobertos: um arquivo so e aceito se NAO existia na base do guard.
 */
export const D13_NEW_CANONICAL_FILES: readonly string[] = [
  "lib/vendas/canonico/periodo.ts",
  "lib/vendas/canonico/service/consultar-vendas-canonicas.ts",
  "lib/vendas/canonico/service/index.ts",
  "lib/vendas/canonico/service/tipos.ts",
];

/** Arquivos NOVOS do D13 (so aceitos se nao existiam na base do guard). */
export const ARQUIVOS_NOVOS_D13: readonly string[] = [
  ...D13_NEW_CANONICAL_FILES,
  "scripts/testar-vendas-canonico-service.ts",
  "scripts/_excecao-d13-vendas-canonicas.ts",
];

const INICIO_BLOCO = "/** Loja do dono vista pela consulta canonica de vendas";
const ASSINATURA = "export async function listarLojasDoDonoParaVendasCanonicas(";

const lf = (s: string) => s.replace(/\r\n/g, "\n");

/**
 * Separa o bloco D13 de credenciais.ts e o valida.
 * `semBloco` = o arquivo atual sem o bloco (igual a base se nada mais mudou).
 */
export function blocoD13Credenciais(raiz: string): { presente: boolean; valido: boolean; motivo: string; semBloco: string } {
  const atual = lf(readFileSync(join(raiz, CAP_D13), "utf8"));
  const i = atual.indexOf(INICIO_BLOCO);
  if (i < 0) return { presente: false, valido: true, motivo: "", semBloco: atual };
  const f = atual.indexOf(ASSINATURA, i);
  if (f < 0) return { presente: true, valido: false, motivo: "bloco_sem_funcao", semBloco: atual };
  const fecha = atual.indexOf("\n}\n", f);
  if (fecha < 0) return { presente: true, valido: false, motivo: "bloco_sem_fim", semBloco: atual };
  let fim = fecha + 3;
  if (atual[fim] === "\n") fim++;           // a linha em branco que separava o bloco
  const bloco = atual.slice(i, fim);
  const semBloco = atual.slice(0, i) + atual.slice(fim);
  const codigo = bloco.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");

  const exports = (codigo.match(/export\s+(?:async\s+)?(?:function|interface|const|type|class|let|var)\s+\w+/g) ?? []).map((x) => x.split(/\s+/).pop());
  const funcoes = codigo.match(/\bfunction\b|=>\s*\{|=\s*(?:async\s*)?\(/g) ?? [];
  const regras: [boolean, string][] = [
    [exports.sort().join() === "LinhaLojaParaVendasCanonicas,listarLojasDoDonoParaVendasCanonicas", `exports: ${exports.join()}`],
    [funcoes.length === 1, `declaracoes de funcao: ${funcoes.length}`],
    [(codigo.match(/\.from\(/g) ?? []).length === 1 && /\.from\("lojas"\)/.test(codigo), "uma unica query em lojas"],
    [/\.from\("lojas"\)\s*\.select\([^)]*\)\s*\.eq\("user_id", String\(userId\)\)/.test(codigo), "filtro user_id NO BANCO, logo apos o select"],
    [!/user_id"?\s*,\s*"is"|\.range\(|l\.user_id|\.filter\(/.test(codigo), "listagem global/filtro em memoria"],
    [/classificarElegibilidadeSyncCanonico\(l, agoraMs\)/.test(codigo) && !/expirado|refresh_token\s*&&|MARGEM_EXPIRACAO/.test(codigo.replace(/\.select\([^)]*\)/, "")), "classificador oficial (sem regra copiada)"],
    [/linhas\.push\(\{ id: l\.id, marketplace: l\.marketplace, ativo: l\.ativo === true, elegibilidade: classificarElegibilidadeSyncCanonico\(l, agoraMs\) \}\);/.test(codigo), "retorno minimo {id, marketplace, ativo, elegibilidade}"],
    [!/\.(update|insert|upsert|delete|rpc)\(|fetch\(/.test(codigo), "escrita/rede"],
  ];
  const falha = regras.find(([ok]) => !ok);
  return { presente: true, valido: !falha, motivo: falha ? falha[1] : "", semBloco };
}

function existeNaBase(raiz: string, base: string, arquivo: string): boolean {
  try { execFileSync("git", ["cat-file", "-e", `${base}:${arquivo}`], { cwd: raiz, stdio: "ignore" }); return true; } catch { return false; }
}

/** credenciais.ts sem o bloco D13 e IDENTICO ao da base (so vale para bases que ja tinham a listagem do tick). */
export function credenciaisIgualABaseForaDoBlocoD13(raiz: string, base: string): boolean {
  const b = blocoD13Credenciais(raiz);
  if (!b.valido) return false;
  const naBase = lf(execFileSync("git", ["show", `${base}:${CAP_D13}`], { cwd: raiz, encoding: "utf8" }));
  return b.semBloco === naBase;
}

/**
 * Remove da lista de alterados SO o que a excecao D13 cobre:
 * os arquivos novos do D13 (inexistentes na base) e — se `incluirCap` —
 * credenciais.ts quando a unica diferenca for o bloco D13 valido.
 */
export function filtrarExcecaoD13(raiz: string, base: string, alterados: string[], incluirCap = true): string[] {
  return alterados.filter((f) => {
    if (ARQUIVOS_NOVOS_D13.includes(f) && !existeNaBase(raiz, base, f)) return false;
    if (incluirCap && f === CAP_D13 && credenciaisIgualABaseForaDoBlocoD13(raiz, base)) return false;
    return true;
  });
}

/**
 * SALES-CANONICAL-D13B — para os guards que travam lib/vendas/canonico
 * (elegibilidade, worker-fairness, worker, legacy-fence): remove SO os
 * arquivos de D13_NEW_CANONICAL_FILES que nao existiam na base. Nada de
 * credenciais.ts, nada de scripts, nada de arquivo canonico ja existente.
 */
export function filtrarNovosCanonicosD13(raiz: string, base: string, alterados: string[]): string[] {
  return alterados.filter((f) => !(D13_NEW_CANONICAL_FILES.includes(f) && !existeNaBase(raiz, base, f)));
}
