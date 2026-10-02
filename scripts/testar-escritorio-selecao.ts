/**
 * CDS IA — F8.3-C1.1: `/ia?agente=<id>` seleciona esse agente no Escritorio.
 *
 * Exercita a regra REAL (`escolherSelecao`, exportada de Escritorio.tsx) e
 * confere, pela fonte, que ela e aplicada so na selecao inicial, com a
 * lista real ja carregada, e que a URL nao passa a mandar em mais nada.
 *
 * Rodar: npx tsx scripts/testar-escritorio-selecao.ts
 */
import "./_env-inerte";
import "./_server-only-inerte";

import { readFileSync } from "node:fs";
import { join } from "node:path";

// O tsx nao carrega CSS: o modulo do Office importa um CSS Module.
// eslint-disable-next-line @typescript-eslint/no-var-requires
require.extensions[".css"] = (m: NodeJS.Module) => {
  (m as unknown as { exports: unknown }).exports = new Proxy({}, { get: (_t, k) => String(k) });
};

let passou = 0;
let falhou = 0;
const ok = (nome: string, cond: boolean, det = ""): void => {
  if (cond) { passou += 1; console.log(`  PASS  ${nome}`); }
  else { falhou += 1; console.log(`  FAIL  ${nome}${det ? `  — ${det}` : ""}`); }
};
const secao = (t: string) =>
  console.log(`\n── ${t} ${"─".repeat(Math.max(2, 58 - t.length))}`);
const ler = (rel: string) => readFileSync(join(__dirname, "..", rel), "utf8").replace(/\r\n/g, "\n");
const semComentario = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

const A = "aaaaaaaa-0000-4000-8000-000000000001";
const B = "bbbbbbbb-0000-4000-8000-000000000002";
const C = "cccccccc-0000-4000-8000-000000000003";

async function main(): Promise<void> {
  console.log("\n══ CDS IA — F8.3-C1.1: abrir agente no Escritório ══");
  const { escolherSelecao } = await import("@/components/ia/office/Escritorio");

  secao("A. A regra");
  ok("A1  /ia (sem pedido): primeiro agente, como sempre", escolherSelecao([A, B, C], null, null) === A);
  ok("A2  /ia?agente=<valido>: seleciona o pedido", escolherSelecao([A, B, C], null, C) === C);
  ok("A3  /ia?agente=<inexistente>: fallback no primeiro", escolherSelecao([A, B, C], null, "xyz") === A);
  ok("A4  /ia?agente= vazio: fallback no primeiro", escolherSelecao([A, B, C], null, "") === A);
  ok("A5  lista vazia: nada selecionado", escolherSelecao([], null, B) === null);
  ok("A6  selecao atual valida e mantida (pedido nao manda depois)", escolherSelecao([A, B, C], B, C) === B);
  ok("A7  agente atual sumiu: fallback no primeiro (nao volta ao pedido)",
    escolherSelecao([A, C], B, C) === A);
  ok("A8  troca manual: a nova selecao valida fica", escolherSelecao([A, B, C], C, null) === C);

  secao("B. Aplicacao no Escritorio (fonte)");
  const ESC = semComentario(ler("components/ia/office/Escritorio.tsx"));
  ok("B1  o pedido e lido UMA vez da URL (?agente=)",
    /useRef<string \| null>\(\s*typeof window === "undefined" \? null : new URLSearchParams\(window\.location\.search\)\.get\("agente"\)\)/.test(ESC));
  ok("B2  so com a lista REAL carregada (estado ok) — sem selecionar outro antes",
    /if \(estado !== "ok"\) return;[\s\S]{0,200}escolherSelecao\(ordenados\.map\(\(a\) => a\.agente\.id\), selecionado, pedido\.current\)/.test(ESC));
  ok("B3  o pedido e consumido na primeira selecao", /pedido\.current = null;/.test(ESC));
  ok("B4  o Escritorio NAO escreve na URL (sem sincronizar a cada troca)",
    !/pushState|replaceState|router\.(push|replace)|searchParams\.set/.test(ESC));
  ok("B5  a selecao manual continua sendo setSelecionado do hotspot",
    /onSelecionar=\{setSelecionado\}/.test(ESC));

  secao("C. A pagina Agentes pede pelo id certo");
  const CARTAO = ler("components/ia/agentes/CartaoDeAgente.tsx");
  const CONFIG = ler("components/ia/agentes/ConfiguracaoDoAgente.tsx");
  // F8.3-C1.4: a configuracao reusa o MESMO menu do card (MenuDoAgente),
  // que e quem tem o link — um lugar so.
  ok("C1  card e configuracao apontam /ia?agente=<id> (menu compartilhado)",
    /href=\{`\/ia\?agente=\$\{agente\.id\}`\}/.test(CARTAO) && /<MenuDoAgente agente=\{agente\}/.test(CONFIG));

  console.log(`\n── placar ${"─".repeat(50)}\n  PASS ${passou}   FAIL ${falhou}\n`);
  if (falhou > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
