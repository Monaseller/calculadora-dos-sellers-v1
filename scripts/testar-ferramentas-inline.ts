/**
 * CDS IA — F8.2-A: Tools inline no Escritorio + icones.
 *
 * Prova: (1) adicionar Tool usa UM contrato (`adicionarPackAoAgente`)
 * no Wizard e no Escritorio, com o nivel sugerido pelo efeito; (2) so
 * acao EXTERNA e removida, pelo contrato dela — pack interno nao finge
 * remocao; (3) todo pack tem icone local, e o fallback e generico.
 *
 * Rodar: npx tsx scripts/testar-ferramentas-inline.ts
 */
import "./_server-only-inerte";

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { TOOL_PACKS } from "@/lib/agentes/factory/catalogo-ui";
import { adicionarPackAoAgente, removerPackDoAgente } from "@/lib/ia/ferramentas-do-agente";
import { desvincularFerramentaExterna } from "@/lib/ia/agentes-http";
import {
  ICONE_ACAO_EXTERNA, ICONE_FERRAMENTA_GENERICA, iconeDoMarketplace, iconeDoPack,
} from "@/lib/ia/icones-ferramentas";

let passou = 0;
let falhou = 0;
const ok = (nome: string, cond: boolean, det = ""): void => {
  if (cond) { passou += 1; console.log(`  PASS  ${nome}`); }
  else { falhou += 1; console.log(`  FAIL  ${nome}${det ? `  — ${det}` : ""}`); }
};
const secao = (t: string) =>
  console.log(`\n── ${t} ${"─".repeat(Math.max(2, 58 - t.length))}`);
const RAIZ = join(__dirname, "..");
const ler = (rel: string) => readFileSync(join(RAIZ, rel), "utf8").replace(/\r\n/g, "\n");
const semComentario = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

const AGENTE = "22222222-2222-4222-8222-222222222222";

/** fetch falso que registra as chamadas e responde por roteiro. */
function fetchRoteirizado(falharNa?: number) {
  const chamadas: { url: string; method: string; corpo: { funcaoId: string; nivel: string } | null }[] = [];
  const f = (async (url: string, init?: RequestInit) => {
    const corpo = init?.body ? JSON.parse(String(init.body)) : null;
    chamadas.push({ url: String(url), method: init?.method ?? "GET", corpo });
    if (falharNa !== undefined && chamadas.length === falharNa) {
      return new Response(JSON.stringify({ ok: false, erro: "x" }), { status: 500 });
    }
    if (init?.method === "DELETE") {
      return new Response(JSON.stringify({ ok: true, removida: true }), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: true, permissao: corpo }), { status: 200 });
  }) as unknown as typeof fetch;
  return { f, chamadas };
}

/** fetch falso para a remocao de pack: registra e responde `removido`. */
function fetchRoteirizadoRemocao(status = 200) {
  const chamadas: { url: string; method: string; corpo: unknown }[] = [];
  const f = (async (url: string, init?: RequestInit) => {
    const corpo = init?.body ? JSON.parse(String(init.body)) : null;
    chamadas.push({ url: String(url), method: init?.method ?? "GET", corpo });
    if (status !== 200) return new Response(JSON.stringify({ ok: false, erro: "x" }), { status });
    const packId = new URL(String(url), "http://x").searchParams.get("packId");
    return new Response(JSON.stringify({ ok: true, removido: { packId, linhas: 3 } }), { status: 200 });
  }) as unknown as typeof fetch;
  return { f, chamadas };
}

async function comFetch<T>(f: typeof fetch, corpo: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = f;
  try { return await corpo(); } finally { globalThis.fetch = original; }
}

async function main(): Promise<void> {
  console.log("\n══ CDS IA — F8.2-A: Tools inline + icones ══");

  // =====================================================================
  secao("A. Adicionar Tool: o contrato unico");
  const planilhas = TOOL_PACKS.find((p) => p.id === "planilhas")!;
  const a = fetchRoteirizado();
  const r1 = await comFetch(a.f, () => adicionarPackAoAgente(AGENTE, "planilhas", null));
  ok("A1  uma permissao por Funcao do pack",
    r1.estado === "ok" && a.chamadas.length === planilhas.funcoes.length &&
      a.chamadas.every((c, i) => c.corpo?.funcaoId === planilhas.funcoes[i]));
  ok("A2  PATCH na rota de permissoes do agente",
    a.chamadas.every((c) => c.method === "PATCH" && c.url.includes(`/api/agentes/${AGENTE}/permissoes`)));
  ok("A3  leitura sem nivel escolhido -> 'automatico' (sugerido pelo efeito, §28)",
    a.chamadas.every((c) => c.corpo?.nivel === "automatico"));
  const b = fetchRoteirizado();
  await comFetch(b.f, () => adicionarPackAoAgente(AGENTE, "planilhas", "aprovacao"));
  ok("A4  nivel explicito vence o sugerido", b.chamadas.every((c) => c.corpo?.nivel === "aprovacao"));
  const c = fetchRoteirizado(2);
  const r3 = await comFetch(c.f, () => adicionarPackAoAgente(AGENTE, "planilhas", null));
  ok("A5  para na primeira recusa (nada de pack meio gravado em silencio)",
    r3.estado === "recusado" && c.chamadas.length === 2);
  const d = fetchRoteirizado();
  const r4 = await comFetch(d.f, () => adicionarPackAoAgente(AGENTE, "inexistente", null));
  ok("A6  pack desconhecido: nenhuma escrita", r4.estado === "pack_desconhecido" && d.chamadas.length === 0);

  // =====================================================================
  secao("B. Office e Wizard compartilham o contrato");
  const WIZ = semComentario(ler("components/ia/factory/Wizard.tsx"));
  const GER = semComentario(ler("components/ia/office/GerenciarFerramentas.tsx"));
  const PAINEL = semComentario(ler("components/ia/office/OfficeAgentPanelV1.tsx"));
  ok("B1  Wizard adiciona pack por adicionarPackAoAgente",
    /adicionarPackAoAgente\(agenteId, packId, nivel\)/.test(WIZ));
  ok("B2  Wizard nao tem mais o laco proprio (sem nivelSugeridoParaEfeito)",
    !/nivelSugeridoParaEfeito|definirPermissaoDeFuncao\(/.test(WIZ));
  ok("B3  Escritorio adiciona pela MESMA funcao", /adicionarPackAoAgente\(agenteId, chave, null\)/.test(GER));
  ok("B4  Escritorio reusa o BuscaDeFerramentas do Wizard",
    /<BuscaDeFerramentas/.test(GER) && /<BuscaDeFerramentas/.test(WIZ));
  ok("B5  o + do painel abre Gerenciar ferramentas",
    /onClick=\{\(\) => setGerenciar\(true\)\}/.test(PAINEL) && /<GerenciarFerramentas/.test(PAINEL));
  ok("B6  painel rele as ferramentas apos mudar (sem reload de pagina)",
    /aoMudar=\{\(\) => setVersao\(\(v\) => v \+ 1\)\}/.test(PAINEL) && /\[agente\.id, versao\]/.test(PAINEL));

  // =====================================================================
  secao("C. Remover: cada tipo pelo seu contrato (F8.2-B)");
  const e = fetchRoteirizado();
  const r5 = await comFetch(e.f, () => desvincularFerramentaExterna(AGENTE, "gmail.enviar"));
  ok("C1  externa: DELETE da acao externa", r5.estado === "ok" && e.chamadas[0]?.method === "DELETE");
  const pk = fetchRoteirizadoRemocao();
  const r6 = await comFetch(pk.f, () => removerPackDoAgente(AGENTE, "planilhas"));
  ok("C2  pack: UMA chamada DELETE na rota de permissoes",
    r6.estado === "ok" && pk.chamadas.length === 1 && pk.chamadas[0].method === "DELETE" &&
      pk.chamadas[0].url.includes(`/api/agentes/${AGENTE}/permissoes`));
  ok("C3  pack: DELETE SEM corpo, so o packId na query (o servidor decide as linhas)",
    pk.chamadas[0]?.corpo === null && pk.chamadas[0]?.url.endsWith("?packId=planilhas"));
  const pk2 = fetchRoteirizadoRemocao();
  const r7 = await comFetch(pk2.f, () => removerPackDoAgente(AGENTE, "inexistente"));
  ok("C4  pack desconhecido: nenhuma chamada", r7.estado === "pack_desconhecido" && pk2.chamadas.length === 0);
  const pk3 = fetchRoteirizadoRemocao(500);
  const r8 = await comFetch(pk3.f, () => removerPackDoAgente(AGENTE, "planilhas"));
  ok("C5  falha do servidor -> recusado (a tela avisa)", r8.estado === "recusado");
  ok("C6  remover NUNCA vira bloqueado (nenhuma escrita de nivel no fluxo de remocao)",
    !/"bloqueado"/.test(PAINEL + GER + semComentario(ler("lib/ia/ferramentas-do-agente.ts"))));
  ok("C7  painel: pack por removerPackDoAgente, externa por desvincularFerramentaExterna",
    /removerPackDoAgente\(agente\.id, packId\)/.test(PAINEL) &&
      /desvincularFerramentaExterna\(agente\.id, funcaoId\)/.test(PAINEL));
  ok("C8  painel: botao de remover nos DOIS tipos de card",
    /chave=\{`pack:\$\{f\.id\}`\}/.test(PAINEL) && /chave=\{`externa:\$\{e\.funcaoId\}`\}/.test(PAINEL));
  ok("C9  painel: confirmacao no 2o clique",
    /if \(confirmando !== chave\) \{\s*setConfirmando\(chave\);\s*return;/.test(PAINEL));
  ok("C10 Wizard e Escritorio removem pela MESMA funcao",
    /removerPackDoAgente\(agenteId, packId\)/.test(WIZ) && /removerPackDoAgente\(agenteId, chave\)/.test(GER));
  const BUSCA = semComentario(ler("components/ia/factory/BuscaDeFerramentas.tsx"));
  ok("C11 drawer/Wizard: BuscaDeFerramentas recebe aoRemoverPack nos dois",
    /aoRemoverPack=\{/.test(WIZ) && /aoRemoverPack=\{/.test(GER) && /aoRemoverPack\?: \(chave: string\) => void/.test(BUSCA));
  ok("C12 BuscaDeFerramentas: remover pede confirmacao e e opcional",
    /confirmandoRemocao === a\.chave/.test(BUSCA) && /aoRemoverPack !== undefined/.test(BUSCA));

  // =====================================================================
  secao("C'. Dominio: DELETE estreito do pack (Supabase falso)");
  const ESC = semComentario(ler("lib/agentes/permissoes/escrita.ts"));
  ok("C'1 so UM delete no escritor, e ele e o do pack",
    (ESC.match(/\.delete\(/g) ?? []).length === 1 &&
      /export async function removerPackDoAgente/.test(ESC));
  ok("C'2 as Funcoes vem do TOOL_PACKS no servidor (packPorId), nao do cliente",
    /const pack = packPorId\(packId\);/.test(ESC));
  ok("C'3 escopo dono + agente + funcoes do pack",
    /\.eq\("user_id", userId\)\s*\.eq\("agente_id", agenteId\)\s*\.in\("funcao_id", \[\.\.\.pack\.funcoes\]\)/.test(ESC));
  const ROTA = semComentario(ler("app/api/agentes/[agenteId]/permissoes/route.ts"));
  ok("C'4 rota DELETE passa pela MESMA porta do PATCH (sessao + dono)",
    /export async function DELETE[\s\S]*atravessarPorta\(request, params\.agenteId, FALHA_REMOCAO\)/.test(ROTA));
  // Execucao real do escritor, com o cliente Supabase interceptado.
  const operacoes: { op: string; args: unknown[] }[] = [];
  const consulta: Record<string, (...a: unknown[]) => unknown> = {};
  for (const m of ["delete", "eq", "in"]) consulta[m] = (...args) => { operacoes.push({ op: m, args }); return consulta; };
  (consulta as { then?: unknown }).then = (res: (v: unknown) => unknown) => res({ error: null, count: 3 });
  const Module = require("node:module");
  const requireOriginal = Module.prototype.require;
  Module.prototype.require = function (id: string) {
    if (id.endsWith("supabase-servidor")) {
      return { getSupabaseServidor: () => ({ from: (t: string) => { operacoes.push({ op: "from", args: [t] }); return consulta; } }) };
    }
    return requireOriginal.apply(this, arguments as never);
  };
  const { removerPackDoAgente: removerNoDominio } = await import("@/lib/agentes/permissoes/escrita");
  Module.prototype.require = requireOriginal;
  const rd = await removerNoDominio({ userId: "dono", agenteId: AGENTE, packId: "planilhas" });
  const inOp = operacoes.find((o) => o.op === "in");
  ok("C'5 apaga em agente_permissoes, escopo dono+agente",
    operacoes.some((o) => o.op === "from" && o.args[0] === "agente_permissoes") &&
      operacoes.some((o) => o.op === "eq" && o.args[0] === "user_id" && o.args[1] === "dono") &&
      operacoes.some((o) => o.op === "eq" && o.args[0] === "agente_id" && o.args[1] === AGENTE));
  ok("C'6 exatamente as Funcoes do pack, e nenhuma outra",
    JSON.stringify(inOp?.args) === JSON.stringify(["funcao_id", [...planilhas.funcoes]]));
  ok("C'7 resultado: removido com a contagem de linhas", rd.estado === "removido" && rd.linhas === 3);
  const antes = operacoes.length;
  const ri = await removerNoDominio({ userId: "dono", agenteId: AGENTE, packId: "nao-existe" });
  ok("C'8 pack desconhecido: entrada invalida, sem ir ao banco", ri.estado === "entrada_invalida" && operacoes.length === antes);
  const rsem = await removerNoDominio({ userId: "", agenteId: AGENTE, packId: "planilhas" });
  ok("C'9 sem dono: entrada invalida, sem ir ao banco", rsem.estado === "entrada_invalida" && operacoes.length === antes);

  // =====================================================================
  secao("D. Icones locais");
  for (const p of TOOL_PACKS) {
    const icone = iconeDoPack(p.id);
    ok(`D1  ${p.id}: icone proprio e arquivo existe`,
      icone !== ICONE_FERRAMENTA_GENERICA && existsSync(join(RAIZ, "public", icone)), icone);
  }
  ok("D2  desconhecido -> generico de ferramenta (nunca letra)",
    iconeDoPack("xyz") === ICONE_FERRAMENTA_GENERICA &&
      existsSync(join(RAIZ, "public", ICONE_FERRAMENTA_GENERICA)));
  ok("D3  acao externa tem icone e ele existe", existsSync(join(RAIZ, "public", ICONE_ACAO_EXTERNA)));
  ok("D4  Mercado Livre usa o logo que o produto ja tem", iconeDoMarketplace("mercadolivre") === "/logo-ml.svg");
  const REG = semComentario(ler("lib/ia/icones-ferramentas.ts"));
  ok("D5  registry sem rede (nenhum http/https)", !/https?:\/\//.test(REG));
  const svgs = ["planilha", "calculadora", "calendario", "vendas", "ferramenta", "acao-externa"]
    .map((n) => ler(`public/icons/tools/${n}.svg`));
  ok("D6  SVGs sem script nem referencia externa",
    svgs.every((s) => !/<script|href=|xlink|https?:\/\/(?!www\.w3\.org)/.test(s)));
  ok("D7  painel nao desenha mais a primeira letra da Tool",
    !/f\.nome\.charAt\(0\)/.test(PAINEL));

  console.log(`\n── placar ${"─".repeat(50)}\n  PASS ${passou}   FAIL ${falhou}\n`);
  if (falhou > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
