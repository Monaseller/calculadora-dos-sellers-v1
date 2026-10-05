/**
 * F9.2-A3 — capabilities na aba APIs + o ultimo caminho de binding.
 *
 * NAO chama IA, NAO chama banco. A unica "rede" e um `fetch` FALSO local,
 * que grava o que os helpers da tela mandariam ao servidor.
 *
 * Rodar:  npx tsx scripts/testar-agentes-f9-2-a3-capacidades.ts
 */
import "./_server-only-inerte";

import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

import { CAPACIDADES_DE_API, provedorDoPackLegado, provedorPorId } from "@/lib/agentes/apis/catalogo";
import { contaParaHerdar, projetarApisDoAgente, type RequisitoDoAgente } from "@/lib/agentes/apis/projecao";
import { aplicarComCompensacao, chaveDaLinha, type PortasDeConta } from "@/lib/agentes/apis/aplicacao";
import { herdarContaDoProvedor } from "@/lib/agentes/apis/servico";
import {
  INTEGRACOES_CDS, capacidadesVisiveisDaApi, nivelDaApi, nivelParaLigar, planoDaApi,
} from "@/lib/ia/agentes-gestao";
import { definirCapacidadeDaApi, definirNivelDasCapacidadesDaApi } from "@/lib/ia/ferramentas-do-agente";
import type { ApiDoAgenteUI } from "@/lib/ia/agentes-http";

const RAIZ = join(__dirname, "..");
let passou = 0;
let falhou = 0;
function ok(nome: string, cond: boolean, detalhe?: string): void {
  if (cond) { passou += 1; console.log(`  PASS  ${nome}`); }
  else { falhou += 1; console.log(`  FAIL  ${nome}${detalhe ? ` — ${detalhe}` : ""}`); }
}
function secao(t: string): void {
  console.log(`\n── ${t} ${"─".repeat(Math.max(2, 60 - t.length))}`);
}
const ler = (rel: string) => readFileSync(join(RAIZ, rel), "utf8");
const semComentarios = (f: string) =>
  f.replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const ML = "mercado_livre";
const MONAMOR = "11111111-1111-4111-8111-111111111111";
const OUTRA = "22222222-2222-4222-8222-222222222222";
const AGENTE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ml = provedorPorId("mercado_livre")!;
const req = (recurso: string, loja: string | null): RequisitoDoAgente =>
  ({ plataforma: ML, recurso, lojaIdSelecionada: loja, utilizavel: loja !== null });

// ── fetch FALSO: grava o pedido, responde como o servidor responderia ──
interface Pedido { metodo: string; url: string; corpo: Record<string, unknown> | null }
const pedidos: Pedido[] = [];
globalThis.fetch = (async (url: unknown, init?: { method?: string; body?: unknown }) => {
  const corpo = typeof init?.body === "string" ? JSON.parse(init.body) : null;
  pedidos.push({ metodo: init?.method ?? "GET", url: String(url), corpo });
  if (String(url).endsWith("/permissoes") && init?.method === "PATCH") {
    return new Response(JSON.stringify({ ok: true, permissao: { funcaoId: corpo.funcaoId, nivel: corpo.nivel } }),
      { status: 200 });
  }
  return new Response(JSON.stringify({ ok: false }), { status: 500 });
}) as typeof fetch;

function apiProjetada(niveis: Record<string, string>): ApiDoAgenteUI {
  const p = projetarApisDoAgente({
    permissoes: Object.entries(niveis).map(([funcaoId, nivel]) => ({ funcaoId, nivel })),
    requisitos: [], contasPorProvedor: {},
  }).find((x) => x.id === "mercado_livre")!;
  return { ...p, capacidades: p.capacidades.map((c) => ({
    id: c.id, nome: c.nome, disponivel: c.disponivel, habilitadaNoAgente: c.habilitadaNoAgente, nivel: c.nivel,
  })) } as ApiDoAgenteUI;
}

async function main(): Promise<void> {
  console.log("\n══ CDS IA — F9.2-A3: capabilities na aba APIs ══");
  const APIS = semComentarios(ler("components/ia/agentes/ApisDoAgente.tsx"));

  // ═══════════════════════════════════════════════════════════════════
  secao("A. A aba APIs mostra as capabilities ML REAIS");
  // ═══════════════════════════════════════════════════════════════════
  {
    const api = apiProjetada({});
    const vis = capacidadesVisiveisDaApi(api).map((c) => c.id).sort();
    ok("A1  exatamente as duas reais", JSON.stringify(vis) ===
      JSON.stringify(["mercadolivre.perguntas.listar", "mercadolivre.vendas.consultar"]), JSON.stringify(vis));
    ok("A2  nomes de gente, nao ids", capacidadesVisiveisDaApi(api).every((c) => !c.nome.includes(".")));
    ok("A3  ApisDoAgente desenha SO capacidadesVisiveisDaApi, com interruptor por capability",
      /capacidadesVisiveisDaApi\(api\)/.test(APIS) && /capacidades\.map\(\(c\) => \(/.test(APIS) &&
        /<Interruptor\s+ligado=\{c\.habilitadaNoAgente\}/.test(APIS));
    ok("A4  na tela aparece c.nome — nunca c.id, recurso ou pack como texto",
      /\{c\.nome\}/.test(APIS) && !/>\{c\.id\}</.test(APIS) && !/recurso/.test(APIS) && !/\{pack\.id\}</.test(APIS));
    ok("A5  o bloco reaproveita classes aprovadas (sem CSS novo)",
      /estilos\.integracaoDetalhe/.test(APIS) && /estilos\.blocoLinha/.test(APIS) && /estilos\.interruptor/.test(APIS));
  }

  // ═══════════════════════════════════════════════════════════════════
  secao("B/C. Ligada x desligada, pelos niveis que ja existem");
  // ═══════════════════════════════════════════════════════════════════
  {
    const api = apiProjetada({
      "mercadolivre.vendas.consultar": "automatico",
      "mercadolivre.perguntas.listar": "bloqueado",
    });
    const cap = (id: string) => api.capacidades.find((c) => c.id === id)!;
    ok("B1  automatico -> ligada", cap("mercadolivre.vendas.consultar").habilitadaNoAgente);
    ok("B2  aprovacao -> ligada", apiProjetada({ "mercadolivre.vendas.consultar": "aprovacao" })
      .capacidades.find((c) => c.id === "mercadolivre.vendas.consultar")!.habilitadaNoAgente);
    ok("C1  bloqueado -> desligada", !cap("mercadolivre.perguntas.listar").habilitadaNoAgente);
    ok("C2  sem linha -> desligada", !apiProjetada({}).capacidades.some((c) => c.habilitadaNoAgente));
    ok("C3  nivel do provider = o das LIGADAS (a desligada nao o embaralha)", nivelDaApi(api) === "automatico");
    ok("C4  nenhuma ligada -> nivel 'bloqueado'", nivelDaApi(apiProjetada({})) === "bloqueado");
    ok("C5  ligar herda o nivel do provider", nivelParaLigar(apiProjetada({
      "mercadolivre.vendas.consultar": "aprovacao" })) === "aprovacao");
    ok("C6  ...e sem nenhuma ligada, o sugerido (automatico, leitura)", nivelParaLigar(apiProjetada({})) === "automatico");
  }

  // ═══════════════════════════════════════════════════════════════════
  secao("D. Ligar depois de a conta existir: herda a conta");
  // ═══════════════════════════════════════════════════════════════════
  {
    pedidos.length = 0;
    const r = await definirCapacidadeDaApi(AGENTE, "mercadolivre.perguntas.listar", true, "automatico");
    ok("D1  ligar = PATCH /permissoes {funcaoId, nivel} do contrato de sempre",
      r.estado === "ok" && pedidos.length === 1 && pedidos[0].metodo === "PATCH" &&
        pedidos[0].url === `/api/agentes/${AGENTE}/permissoes` &&
        JSON.stringify(pedidos[0].corpo) === JSON.stringify({ funcaoId: "mercadolivre.perguntas.listar", nivel: "automatico" }));
    ok("D2  a tela NAO pede conta de novo (nenhum PATCH /apis ou /conexoes)",
      !pedidos.some((p) => /\/apis$|\/conexoes$/.test(p.url)));
    const h = contaParaHerdar(ml, [req("vendas", MONAMOR)]);
    ok("D3  o servidor herda Monamor para perguntas", "lojaId" in h && h.lojaId === MONAMOR);
    const sv = semComentarios(ler("lib/agentes/apis/servico.ts"));
    ok("D4  herda ANTES de gravar, nas duas portas de permissao, passando o nivel",
      ["app/api/agentes/[agenteId]/permissoes/route.ts", "lib/agentes/factory/ativar-capacidade.ts"].every((f) => {
        const src = semComentarios(ler(f));
        const i = src.indexOf("herdarContaDoProvedor(");
        return i > 0 && src.indexOf("definirPermissaoDeFuncaoDoAgente({") > i && /nivel/.test(src.slice(i, i + 200));
      }));
    ok("D5  todas desligadas e uma volta: a conta vem das linhas GRAVADAS",
      /resolverSelecoesDoAgente\(\{ userId, agenteId \}\)/.test(sv.slice(sv.indexOf("export async function herdarContaDoProvedor"))));
    const fallback = contaParaHerdar(ml, [
      { plataforma: ML, recurso: "perguntas", lojaIdSelecionada: MONAMOR, utilizavel: true },
      { plataforma: ML, recurso: "vendas", lojaIdSelecionada: MONAMOR, utilizavel: true },
    ]);
    ok("D6  ...e as linhas gravadas apontam Monamor", "lojaId" in fallback && fallback.lojaId === MONAMOR);
  }

  // ═══════════════════════════════════════════════════════════════════
  secao("E. Desligar uma capability nao derruba conta nem a outra");
  // ═══════════════════════════════════════════════════════════════════
  {
    pedidos.length = 0;
    const r = await definirCapacidadeDaApi(AGENTE, "mercadolivre.perguntas.listar", false, "automatico");
    ok("E1  desligar = PATCH {funcaoId, nivel: 'bloqueado'} SO daquela capability",
      r.estado === "ok" && pedidos.length === 1 &&
        JSON.stringify(pedidos[0].corpo) === JSON.stringify({ funcaoId: "mercadolivre.perguntas.listar", nivel: "bloqueado" }));
    ok("E2  sem DELETE de pack, sem /apis, sem /conexoes (a conta fica)",
      !pedidos.some((p) => p.metodo === "DELETE" || /\/apis$|\/conexoes/.test(p.url)));
    const h = await herdarContaDoProvedor({ userId: "u", agenteId: AGENTE,
      funcaoId: "mercadolivre.perguntas.listar", nivel: "bloqueado" });
    ok("E3  servidor: desligar NAO mexe em conta (nao_habilita, sem I/O)", h.estado === "nao_habilita");
    const ag = semComentarios(ler("lib/agentes/conexoes/agregador.ts"));
    ok("E4  bloqueado nao gera requisito (o agregador so conta aprovacao/automatico)",
      /p\.nivel !== "aprovacao" && p\.nivel !== "automatico"\) continue/.test(ag));
    // Vendas ON + Perguntas OFF: a conta do provider continua Monamor.
    const depois = projetarApisDoAgente({
      permissoes: [{ funcaoId: "mercadolivre.vendas.consultar", nivel: "automatico" },
        { funcaoId: "mercadolivre.perguntas.listar", nivel: "bloqueado" }],
      requisitos: [req("vendas", MONAMOR)],
      contasPorProvedor: { mercado_livre: [{ id: MONAMOR, nome: "Monamor", nickname: null }] },
    }).find((p) => p.id === "mercado_livre")!;
    ok("E5  Vendas ON, Perguntas OFF, conta Monamor", depois.contaDoAgente.estado === "definida" &&
      "lojaId" in depois.contaDoAgente && depois.contaDoAgente.lojaId === MONAMOR &&
      depois.capacidades.find((c) => c.id === "mercadolivre.vendas.consultar")!.habilitadaNoAgente &&
      !depois.capacidades.find((c) => c.id === "mercadolivre.perguntas.listar")!.habilitadaNoAgente);
    pedidos.length = 0;
    await definirNivelDasCapacidadesDaApi(AGENTE, ["mercadolivre.vendas.consultar"], "aprovacao");
    ok("E6  mudar o nivel do provider NAO religa a desligada",
      pedidos.length === 1 && pedidos[0].corpo?.funcaoId === "mercadolivre.vendas.consultar");
    // F9.2-A4: SO as ligadas — com nenhuma ligada o seletor fica
    // desabilitado e nada e gravado (nunca "todas", que religaria).
    ok("E7  a tela usa o nivel so nas ligadas (nenhuma ligada: nada a gravar)",
      /definirNivelDasCapacidadesDaApi\(agenteId, ligadas, n\)/.test(APIS) &&
        !/ligadas\.length > 0 \? ligadas/.test(APIS));
  }

  // ═══════════════════════════════════════════════════════════════════
  secao("F/G. Varias contas: um seletor | Shopee: nada falso");
  // ═══════════════════════════════════════════════════════════════════
  ok("F1  ainda exatamente UM <select> na aba", (APIS.match(/<select\b/g) ?? []).length === 1);
  ok("F2  2 contas, nada escolhido -> escolher UMA", planoDaApi({ disponivelParaAgentes: true,
    conexoes: [{ id: MONAMOR, nome: "M", nickname: null }, { id: OUTRA, nome: "O", nickname: null }],
    contaDoAgente: { estado: "nenhuma" } }).tipo === "escolher");
  ok("F3  nenhuma capability ligada -> nao cobra conta (sem_requisito)",
    planoDaApi({ disponivelParaAgentes: true, conexoes: [], contaDoAgente: { estado: "sem_requisito" } }).tipo === "sem_requisito");
  {
    const sh = projetarApisDoAgente({ permissoes: [], requisitos: [], contasPorProvedor: {
      shopee: [{ id: "33333333-3333-4333-8333-333333333333", nome: "S", nickname: null }] } })
      .find((p) => p.id === "shopee")!;
    ok("G1  Shopee: zero capabilities visiveis", capacidadesVisiveisDaApi(sh).length === 0);
    ok("G2  Shopee: 'Ainda não disponível para agentes'", sh.textoDeStatus === "Ainda não disponível para agentes" &&
      /Ainda não disponível para agentes/.test(APIS));
    ok("G3  Shopee: sem pack -> o bloco de capabilities e o seletor nem renderizam",
      INTEGRACOES_CDS.find((i) => i.chave === "shopee")?.packId === null &&
        /\{pack !== null && api !== null && capacidades\.length > 0 && \(/.test(APIS));
  }

  // ═══════════════════════════════════════════════════════════════════
  secao("H/I. Nenhum function_id arbitrario, nenhuma Tool como capability");
  // ═══════════════════════════════════════════════════════════════════
  {
    const api = apiProjetada({ "mercadolivre.mensagens.responder": "automatico", "planilha.ler": "automatico",
      "composio.gmail.enviar": "automatico" });
    ok("H1  permissao de Funcao fantasma nao aparece", !api.capacidades.some((c) => c.id === "mercadolivre.mensagens.responder"));
    ok("I1  Planilhas nao aparece como capability de API", !api.capacidades.some((c) => c.id.startsWith("planilha.")));
    ok("I2  acao externa nao aparece como capability do ML", !api.capacidades.some((c) => c.id.startsWith("composio.")));
  }

  // ═══════════════════════════════════════════════════════════════════
  secao("J/K. Chat: escolha de loja usa a aplicacao tudo-ou-nada");
  // ═══════════════════════════════════════════════════════════════════
  {
    const rota = semComentarios(ler("app/api/agentes/[agenteId]/capacidades/[pendenciaId]/conexao/route.ts"));
    ok("J1  a rota do chat usa aplicarContaAosRecursos", /aplicarContaAosRecursos\(\{/.test(rota));
    ok("J2  e nao grava mais linha a linha por conta propria", !/definirSelecaoDeLoja/.test(rota));
    ok("J3  falha na aplicacao -> resposta de erro, nunca retomada",
      /if \(!aplicado\.ok\) \{\s*return responder\(\{ ok: false/.test(rota) &&
        rota.indexOf("if (!aplicado.ok)") < rota.indexOf("concluirERetomar(porta.userId"));
    const sv = semComentarios(ler("lib/agentes/apis/servico.ts"));
    ok("J4  PATCH /apis e chat passam pela MESMA aplicacao (sem segunda volta)",
      (sv.match(/aplicarComCompensacao\(/g) ?? []).length === 1 &&
        /aplicarContaAosRecursos\(\{ userId, agenteId, gravacoes: plano\.gravacoes \}\)/.test(sv));
    // K: o formato que o chat manda (definir em todos os requisitos do pack),
    // com falha na escrita INTERMEDIARIA (segunda de tres).
    const linhas = new Map<string, string>([
      [chaveDaLinha({ plataforma: ML, recurso: "perguntas" }), MONAMOR],
      [chaveDaLinha({ plataforma: ML, recurso: "vendas" }), MONAMOR],
    ]);
    let n = 0;
    const portas: PortasDeConta = {
      async definir(g) { n += 1; if (n === 2) { linhas.set(chaveDaLinha(g), g.lojaId); return false; }
        linhas.set(chaveDaLinha(g), g.lojaId); return true; },
      async remover(g) { linhas.delete(chaveDaLinha(g)); return true; },
    };
    const gravacoes = ["perguntas", "vendas", "terceiro"].map((recurso) =>
      ({ tipo: "definir" as const, plataforma: ML, recurso, lojaId: OUTRA }));
    const r = await aplicarComCompensacao(gravacoes, new Map(linhas), portas);
    ok("K1  falha intermediaria: nao e ok", !r.ok);
    ok("K2  e nenhuma linha ficou com a loja nova (sem binding parcial)",
      [...linhas.values()].every((l) => l === MONAMOR) && !linhas.has(chaveDaLinha({ plataforma: ML, recurso: "terceiro" })),
      JSON.stringify([...linhas.entries()]));
  }

  // ═══════════════════════════════════════════════════════════════════
  secao("L/M/N. Alias, nenhum write externo, nenhuma migration");
  // ═══════════════════════════════════════════════════════════════════
  ok("L1  alias mercadolivre-perguntas -> Mercado Livre", provedorDoPackLegado("mercadolivre-perguntas")?.id === "mercado_livre");
  ok("L2  'Conectar' ainda adiciona o pack pelo alias (agentes antigos e novos iguais)",
    /adicionarPackAoAgente\(agenteId, integracao\.packId as string, null\)/.test(APIS));
  ok("M1  toda capability segue de leitura", CAPACIDADES_DE_API.every((c) => c.efeito === "leitura"));
  ok("M2  os helpers so mandam niveis existentes",
    /ligada \? nivelQuandoLigada : "bloqueado"/.test(ler("lib/ia/ferramentas-do-agente.ts")));
  {
    const mudadas = execFileSync("git", ["diff", "--name-only", "3e2de493d10193b62a26e2572b5c82124d79fa09", "--", "supabase"],
      { cwd: RAIZ, encoding: "utf8" }).trim();
    const novas = execFileSync("git", ["ls-files", "--others", "--exclude-standard", "--", "supabase"],
      { cwd: RAIZ, encoding: "utf8" }).trim();
    ok("N1  nenhuma migration", mudadas === "" && novas === "", `${mudadas} ${novas}`);
  }

  console.log(`\n── placar ${"─".repeat(54)}`);
  console.log(`  PASS ${passou}   FAIL ${falhou}`);
}

void main().then(
  () => process.exit(falhou > 0 ? 1 : 0),
  (e) => { console.error("ERRO NAO TRATADO:", e); process.exit(1); }
);
