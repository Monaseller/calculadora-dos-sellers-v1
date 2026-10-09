/**
 * Runner OFFLINE único da bateria de guards (CDS V2 — Fase 0).
 *
 *   npx tsx scripts/rodar-bateria-offline.ts            → roda e classifica
 *   npx tsx scripts/rodar-bateria-offline.ts --rebaselinar-manifesto
 *                                                        → regrava o manifesto (mudança VISÍVEL no diff)
 *
 * Regras:
 *   - roda SÓ a lista explícita SUITES_OFFLINE (nenhum glob): suíte nova entra por edição deste arquivo;
 *   - suíte live/banco/produção nunca entra (nome barrado aqui e checado de novo antes de rodar);
 *   - cada falha é identificada pelo ID do teste; KNOWN_FAIL lista SÓ as baselines auditadas, com
 *     contagem (multiconjunto) — ID novo, ou o mesmo ID falhando mais vezes, é FAIL NOVO;
 *     suíte que falha sem ID reconhecível também é FAIL NOVO (nada é absorvido por padrão);
 *   - MANIFESTO: sha256 (forma LF) de todo scripts/testar-*.ts, scripts/_excecao-*.ts e deste runner.
 *     Guard alterado, criado ou apagado sem re-baseline explícito = FAIL (um guard não se
 *     auto-enfraquece sem aparecer). O próprio manifesto e este runner ficam no diff de quem muda.
 *
 * Saída: PASS / KNOWN_FAIL / FAIL NOVO por suíte, MANIFESTO, e exit 0 só sem FAIL NOVO.
 */
import { exec } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ARQUIVO_ZONAS, rebaselinarZonas, verificarZonas } from "./_guard-v2";

export const RAIZ = join(__dirname, "..");
export const ARQUIVO_MANIFESTO = "scripts/guards-manifesto.json";
export const PROIBIDO = /(^|-)(live|banco|producao)(-|$)/i;

/** A bateria offline vetada (nenhuma lê .env real, chama rede ou banco). */
export const SUITES_OFFLINE = [
  "guard-v2-nucleo", "ml-sync-skus-isolamento",
  "anuncios-shopee-multi-store", "shopee-importacao-retomavel", "anuncios-esquema", "importacao-anuncios",
  "shopee-multi-store", "shopee-ux", "shopee-multi-app", "shopee-callback", "shopee-status", "shopee-sync-cursor", "sync-shopee-recuperacao",
  "cron-sync", "reconciliacao-periodo", "status-e-protecao-financeira", "rotas-erro", "cutover-rotas-ml", "anuncios-esquema",
  "agentes-analise-vendas", "ia-ui", "ia-ui-1c", "ia-ui-1cb", "ia-ui-1d", "validacao-oficial", "s2d1-migracao",
  "shopee-ingestao", "vendas-canonico-shopee", "shopee-intraday", "shopee-token-cas", "shopee-auth-transient", "shopee-refresh-lease", "dashboard-canonico",
  "vendas-canonico-service", "vendas-canonico-parcial", "vendas-sync-cron", "vendas-sync-auth-interna", "vendas-sync-feature-flag", "vendas-sync-elegibilidade",
  "vendas-sync-worker-fairness", "vendas-sync-coordenador-tick", "vendas-sync-coordenador", "vendas-sync-worker", "vendas-sync-intraday", "sync-legacy-fence",
  "credenciais-marketplace", "lojas-anon-select", "sec3-b1-service-role", "sec3-b2-browser", "sec3-c-lockdown", "middleware",
].filter((s, i, a) => a.indexOf(s) === i);

/**
 * Baselines AUDITADAS (auditoria CDS V2, 2026-10-09) — ID do teste → quantas vezes falha.
 * Removê-las daqui exige corrigir a suíte; acrescentar exige re-baseline do manifesto (visível).
 */
export const KNOWN_FAIL: Record<string, string[]> = {
  // dívida conhecida: 8 arquivos leem `lojas` fora da capability (SELECT por dono) — unificar com lojas-anon #1
  "credenciais-marketplace": ["92"],
  "lojas-anon-select": ["1"],
  // 7 assets públicos (25427b0) sem classificação no middleware
  "middleware": ["28"],
  // UI de IA removida em 25427b0 / app/dev nunca versionado — aposentar em gate próprio
  "ia-ui": ["A1", "A2", "A6"],
  "ia-ui-1c": ["A4", "F5"],
  "ia-ui-1cb": ["I", "I2.1"],
  "ia-ui-1d": ["G"],
  // G9 exige worktree sujo; G10/G11 congelam arquivos que evoluíram — reescrever em gate próprio
  "agentes-analise-vendas": ["G9", "G10", "G10", "G10", "G10", "G10a", "G10b", "G10b2", "G10c", "G10d", "G10g3", "G10u0", "G10u1", "G11l", "G11m", "G11t", "G11u", "G11x"],
};

const lf = (s: string) => s.replace(/\r\n/g, "\n");
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/** IDs dos testes que falharam, nos formatos usados pelas suítes ("FALHA 28.", "✗ 92.", "FAIL  A1", "  x G9"). */
export function idsDeFalha(saida: string): string[] {
  const ids: string[] = [];
  for (const linha of saida.split(/\r?\n/)) {
    if (/passaram|FALHARAM|passou:/.test(linha)) continue;
    const m = /^\s*(?:FALHA|FAIL|✗)\s+(\S+)/.exec(linha) ?? /^\s+x\s+([A-Z][\w.]*)\s/.exec(linha);
    if (m) ids.push(m[1].replace(/\.$/, ""));
  }
  return ids;
}

export type Classe = "PASS" | "KNOWN_FAIL" | "FAIL_NOVO";
/** Compara a falha observada com a baseline auditada (multiconjunto). */
export function classificar(suite: string, exitCode: number, saida: string): { classe: Classe; novos: string[]; resolvidos: string[] } {
  const conhecidos = [...(KNOWN_FAIL[suite] ?? [])];
  if (exitCode === 0) return { classe: "PASS", novos: [], resolvidos: conhecidos };
  const ids = idsDeFalha(saida);
  if (ids.length === 0) return { classe: "FAIL_NOVO", novos: ["<falha sem ID reconhecivel>"], resolvidos: [] };
  const restantes = [...conhecidos];
  const novos: string[] = [];
  for (const id of ids) {
    const i = restantes.indexOf(id);
    if (i >= 0) restantes.splice(i, 1); else novos.push(id);
  }
  return { classe: novos.length ? "FAIL_NOVO" : "KNOWN_FAIL", novos, resolvidos: restantes };
}

/** Arquivos cobertos pelo manifesto (guards, exceções e o próprio runner). */
export function arquivosDoManifesto(raiz = RAIZ): string[] {
  return readdirSync(join(raiz, "scripts"))
    .filter((f) => /^testar-.*\.ts$/.test(f) || /^_excecao-.*\.ts$/.test(f) || /^_guard-v2.*\.ts$/.test(f) || f === "rodar-bateria-offline.ts")
    .map((f) => `scripts/${f}`).sort();
}
export function calcularManifesto(raiz = RAIZ): Record<string, string> {
  const m: Record<string, string> = {};
  for (const f of arquivosDoManifesto(raiz)) m[f] = sha(lf(readFileSync(join(raiz, f), "utf8")));
  return m;
}
/** Diferenças entre o manifesto gravado e o estado atual (vazio = íntegro). */
export function verificarManifesto(gravado: Record<string, string>, atual: Record<string, string>): string[] {
  const dif: string[] = [];
  for (const f of Object.keys(atual)) {
    if (!(f in gravado)) dif.push(`NOVO sem re-baseline: ${f}`);
    else if (gravado[f] !== atual[f]) dif.push(`ALTERADO sem re-baseline: ${f}`);
  }
  for (const f of Object.keys(gravado)) if (!(f in atual)) dif.push(`APAGADO sem re-baseline: ${f}`);
  return dif;
}
export function lerManifestoGravado(raiz = RAIZ): Record<string, string> | null {
  const p = join(raiz, ARQUIVO_MANIFESTO);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf8")).arquivos ?? null;
}

function rodarSuite(suite: string): Promise<{ suite: string; exitCode: number; saida: string }> {
  return new Promise((ok) => exec(`npx tsx scripts/testar-${suite}.ts`, { cwd: RAIZ, encoding: "utf8", timeout: 900_000, maxBuffer: 64 * 1024 * 1024 },
    (err, so, se) => ok({ suite, exitCode: err ? (typeof (err as any).code === "number" ? (err as any).code : 1) : 0, saida: `${so ?? ""}${se ?? ""}` })));
}

async function principal() {
  if (process.argv.includes("--rebaselinar-manifesto")) {
    writeFileSync(join(RAIZ, ARQUIVO_MANIFESTO), JSON.stringify({ versao: 1, arquivos: calcularManifesto() }, null, 2) + "\n");
    console.log(`manifesto regravado: ${ARQUIVO_MANIFESTO} (commitar junto com a mudança de guard)`);
    return;
  }
  if (process.argv.includes("--rebaselinar-zonas")) {
    rebaselinarZonas();
    console.log(`zonas regravadas: ${ARQUIVO_ZONAS} (commitar junto com a mudança — revisar a lista de arquivos alterados)`);
    return;
  }
  let falhou = false;
  const gravado = lerManifestoGravado();
  const dif = gravado ? verificarManifesto(gravado, calcularManifesto()) : ["manifesto ausente"];
  console.log(`MANIFESTO\t${dif.length ? "FAIL\t" + dif.join(" | ") : "OK"}`);
  if (dif.length) falhou = true;
  const difZonas = verificarZonas();
  console.log(`ZONAS\t${difZonas.length ? "FAIL\t" + difZonas.join(" | ") : "OK"}`);
  if (difZonas.length) falhou = true;

  for (const s of SUITES_OFFLINE) {
    if (PROIBIDO.test(s)) throw new Error(`suite real na bateria offline: ${s}`);
    if (!existsSync(join(RAIZ, "scripts", `testar-${s}.ts`))) { console.log(`FAIL_NOVO\t${s}\tsuite inexistente`); falhou = true; }
  }
  const fila = SUITES_OFFLINE.filter((s) => existsSync(join(RAIZ, "scripts", `testar-${s}.ts`)));
  const resultados: { suite: string; exitCode: number; saida: string }[] = [];
  await Promise.all(Array.from({ length: 4 }, async () => { for (let s = fila.shift(); s; s = fila.shift()) resultados.push(await rodarSuite(s)); }));
  const cont = { PASS: 0, KNOWN_FAIL: 0, FAIL_NOVO: 0 };
  for (const r of resultados.sort((a, b) => a.suite.localeCompare(b.suite))) {
    const c = classificar(r.suite, r.exitCode, r.saida);
    cont[c.classe]++;
    if (c.classe === "FAIL_NOVO") falhou = true;
    const extra = [c.novos.length ? `novos=${c.novos.join(",")}` : "", c.resolvidos.length ? `resolvidos=${c.resolvidos.join(",")}` : ""].filter(Boolean).join(" ");
    console.log(`${c.classe}\t${r.suite}${extra ? "\t" + extra : ""}`);
  }
  console.log(`RESUMO\tPASS=${cont.PASS} KNOWN_FAIL=${cont.KNOWN_FAIL} FAIL_NOVO=${cont.FAIL_NOVO} MANIFESTO=${dif.length ? "FAIL" : "OK"} ZONAS=${difZonas.length ? "FAIL" : "OK"}`);
  process.exit(falhou ? 1 : 0);
}

if (require.main === module) principal().catch((e) => { console.error("ERRO FATAL", e?.message ?? e); process.exit(1); });
