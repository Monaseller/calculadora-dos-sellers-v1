/**
 * F9.2-A4 — API_CONNECTION != API_CAPABILITY.
 *
 * NAO chama IA, NAO chama banco. "Rede" so por um `fetch` FALSO local.
 *
 *   - a conta do provider continua visivel com TODAS as capabilities OFF;
 *   - divergencia com tudo OFF e detectada e reconciliavel;
 *   - trocar o nivel do provider NUNCA religa capability desligada;
 *   - toda tela que escolhe conta (atual ou legada alcancavel) mostra UM
 *     seletor por provider, e o ML nunca passa pelo contrato por recurso.
 *
 * Rodar:  npx tsx scripts/testar-agentes-f9-2-a4-conexao-independente.ts
 */
import "./_server-only-inerte";

import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

import { CAPACIDADES_DE_API, ehTool, provedorPorId } from "@/lib/agentes/apis/catalogo";
import {
  contaDoAgente, contaParaHerdar, planejarContaDoProvedor, projetarApisDoAgente,
  type SelecaoGravada,
} from "@/lib/agentes/apis/projecao";
import {
  INTEGRACOES_CDS, capacidadesParaMudarNivel, contaEmUsoDaApi, planoDaApi, provedorDeAgentesDaPlataforma,
} from "@/lib/ia/agentes-gestao";
import { definirNivelDasCapacidadesDaApi } from "@/lib/ia/ferramentas-do-agente";
import { agruparPorPlataforma } from "@/components/ia/agente/ConexoesAgente";
import type { ApiDoAgenteUI, ConexaoRequisitoUI } from "@/lib/ia/agentes-http";

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
const VENDAS = "mercadolivre.vendas.consultar";
const PERGUNTAS = "mercadolivre.perguntas.listar";
const ml = provedorPorId("mercado_livre")!;
const sel = (recurso: string, lojaId: string): SelecaoGravada => ({ plataforma: ML, recurso, lojaId });
const contas = [{ id: MONAMOR, nome: "Monamor", nickname: null }, { id: OUTRA, nome: "Outra", nickname: null }];

// fetch FALSO: grava o que os helpers da tela mandariam.
interface Pedido { metodo: string; url: string; corpo: Record<string, unknown> | null }
const pedidos: Pedido[] = [];
globalThis.fetch = (async (url: unknown, init?: { method?: string; body?: unknown }) => {
  const corpo = typeof init?.body === "string" ? JSON.parse(init.body) : null;
  pedidos.push({ metodo: init?.method ?? "GET", url: String(url), corpo });
  return new Response(JSON.stringify({ ok: true, permissao: corpo }), { status: 200 });
}) as typeof fetch;

/** A projecao do ML como a tela a recebe, a partir de niveis + linhas gravadas. */
function apiMl(niveis: Record<string, string>, selecoes: SelecaoGravada[], requisitos = [] as string[]): ApiDoAgenteUI {
  const p = projetarApisDoAgente({
    permissoes: Object.entries(niveis).map(([funcaoId, nivel]) => ({ funcaoId, nivel })),
    requisitos: requisitos.map((recurso) => ({ plataforma: ML, recurso,
      lojaIdSelecionada: selecoes.find((s) => s.recurso === recurso)?.lojaId ?? null, utilizavel: true })),
    contasPorProvedor: { mercado_livre: contas },
    selecoes,
  }).find((x) => x.id === "mercado_livre")!;
  return { ...p, capacidades: p.capacidades.map((c) => ({
    id: c.id, nome: c.nome, disponivel: c.disponivel, habilitadaNoAgente: c.habilitadaNoAgente, nivel: c.nivel,
  })) } as ApiDoAgenteUI;
}

async function main(): Promise<void> {
  console.log("\n══ CDS IA — F9.2-A4: conexao independente das capabilities ══");

  // ═══════════════════════════════════════════════════════════════════
  secao("1. Todas OFF + conta consistente: a conta continua");
  // ═══════════════════════════════════════════════════════════════════
  {
    const api = apiMl({ [VENDAS]: "bloqueado", [PERGUNTAS]: "bloqueado" },
      [sel("vendas", MONAMOR), sel("perguntas", MONAMOR)]);
    ok("1a  conexao DEFINIDA com zero capabilities ligadas",
      api.contaDoAgente.estado === "definida" && "lojaId" in api.contaDoAgente && api.contaDoAgente.lojaId === MONAMOR &&
        api.capacidades.every((c) => !c.habilitadaNoAgente), JSON.stringify(api.contaDoAgente));
    ok("1b  a tela: pronta, 'Conta em uso: Monamor'",
      planoDaApi(api).tipo === "pronta" && contaEmUsoDaApi(api)?.nome === "Monamor");
    ok("1c  conta que deixou de ser elegivel do dono: definida, nao utilizavel",
      (() => { const c = contaDoAgente(ml, [], [sel("vendas", "99999999-9999-4999-8999-999999999999")], contas);
        return c.estado === "definida" && "utilizavel" in c && c.utilizavel === false; })());
    ok("1d  sem linha gravada e sem capability ligada: sem_requisito (nada inventado)",
      contaDoAgente(ml, [], [], contas).estado === "sem_requisito");
  }

  // ═══════════════════════════════════════════════════════════════════
  secao("2. Todas OFF + contas diferentes: DIVERGENTE, nao adivinha");
  // ═══════════════════════════════════════════════════════════════════
  {
    const api = apiMl({ [VENDAS]: "bloqueado", [PERGUNTAS]: "bloqueado" },
      [sel("vendas", MONAMOR), sel("perguntas", OUTRA)]);
    ok("2a  divergente", api.contaDoAgente.estado === "divergente");
    ok("2b  a tela pede UMA escolha", planoDaApi(api).tipo === "escolher" && contaEmUsoDaApi(api) === null);
    ok("2c  com a frase aprovada", /Este agente está com contas diferentes\. Escolha uma\./.test(
      ler("components/ia/agentes/ApisDoAgente.tsx")));
    const plano = planejarContaDoProvedor({ provedorId: "mercado_livre", lojaId: MONAMOR, requisitos: [],
      elegiveis: contas, selecoes: [sel("vendas", MONAMOR), sel("perguntas", OUTRA)] });
    ok("2d  a escolha unica reconcilia TODAS as linhas gravadas (mesmo com tudo OFF)",
      plano.ok && JSON.stringify(plano.gravacoes.map((g) => [g.recurso, g.tipo === "definir" ? g.lojaId : null])) ===
        JSON.stringify([["perguntas", MONAMOR], ["vendas", MONAMOR]]), JSON.stringify(plano));
    ok("2e  sem requisito E sem linha gravada: continua recusado (nao inventa recurso)",
      (() => { const r = planejarContaDoProvedor({ provedorId: "mercado_livre", lojaId: MONAMOR,
        requisitos: [], elegiveis: contas, selecoes: [] }); return !r.ok && r.codigo === "sem_requisito"; })());
    const sv = semComentarios(ler("lib/agentes/apis/servico.ts"));
    ok("2f  servico: PATCH aceita provider com conta gravada mesmo sem capability ligada",
      /gravadas\.selecoes\.some\(\(s\) => s\.plataforma === provedor\.plataforma\)/.test(sv) &&
        /selecoes: gravadas\.selecoes/.test(sv));
    ok("2g  servico: GET le as linhas gravadas para a projecao",
      /resolverSelecoesDoAgente\(\{ userId, agenteId \}\),\s*\]\)/.test(sv) && /selecoes: selecoes\.selecoes/.test(sv));
  }

  // ═══════════════════════════════════════════════════════════════════
  secao("3/4. Desligar a ultima: conta fica | religar: herda a salva");
  // ═══════════════════════════════════════════════════════════════════
  {
    const antes = apiMl({ [VENDAS]: "automatico", [PERGUNTAS]: "bloqueado" }, [sel("vendas", MONAMOR)], ["vendas"]);
    const depois = apiMl({ [VENDAS]: "bloqueado", [PERGUNTAS]: "bloqueado" }, [sel("vendas", MONAMOR)]);
    ok("3a  antes: Vendas ON, conta Monamor", antes.contaDoAgente.estado === "definida");
    ok("3b  desligada a ULTIMA: a conta continua Monamor",
      depois.contaDoAgente.estado === "definida" && "lojaId" in depois.contaDoAgente && depois.contaDoAgente.lojaId === MONAMOR);
    const h = contaParaHerdar(ml, [sel("vendas", MONAMOR)].map((s) =>
      ({ plataforma: s.plataforma, recurso: s.recurso, lojaIdSelecionada: s.lojaId, utilizavel: true })));
    ok("4a  religar: herda a conta salva", "lojaId" in h && h.lojaId === MONAMOR);
  }

  // ═══════════════════════════════════════════════════════════════════
  secao("5. Nivel do provider NUNCA religa capability desligada");
  // ═══════════════════════════════════════════════════════════════════
  {
    // A: Vendas OFF, Perguntas OFF
    const a = apiMl({ [VENDAS]: "bloqueado", [PERGUNTAS]: "bloqueado" }, [sel("vendas", MONAMOR)]);
    ok("5A1 nada a mudar com tudo OFF", capacidadesParaMudarNivel(a).length === 0);
    pedidos.length = 0;
    await definirNivelDasCapacidadesDaApi(AGENTE, capacidadesParaMudarNivel(a), "aprovacao");
    ok("5A2 alterar o nivel com tudo OFF: ZERO escrita (as duas seguem bloqueado)", pedidos.length === 0,
      JSON.stringify(pedidos));
    // B: Vendas ON, Perguntas OFF
    const b = apiMl({ [VENDAS]: "automatico", [PERGUNTAS]: "bloqueado" }, [sel("vendas", MONAMOR)], ["vendas"]);
    pedidos.length = 0;
    await definirNivelDasCapacidadesDaApi(AGENTE, capacidadesParaMudarNivel(b), "aprovacao");
    ok("5B  Vendas ON / Perguntas OFF: so Vendas muda (automatico -> aprovacao)",
      pedidos.length === 1 && JSON.stringify(pedidos[0].corpo) === JSON.stringify({ funcaoId: VENDAS, nivel: "aprovacao" }));
    // C: Vendas OFF, Perguntas ON
    const c = apiMl({ [VENDAS]: "bloqueado", [PERGUNTAS]: "aprovacao" }, [sel("perguntas", MONAMOR)], ["perguntas"]);
    pedidos.length = 0;
    await definirNivelDasCapacidadesDaApi(AGENTE, capacidadesParaMudarNivel(c), "automatico");
    ok("5C  Vendas OFF / Perguntas ON: so Perguntas muda (aprovacao -> automatico)",
      pedidos.length === 1 && JSON.stringify(pedidos[0].corpo) === JSON.stringify({ funcaoId: PERGUNTAS, nivel: "automatico" }));
    for (const arq of ["components/ia/agentes/ApisDoAgente.tsx", "components/ia/criar/EtapaApis.tsx"]) {
      const src = semComentarios(ler(arq));
      const curto = arq.split("/").pop();
      ok(`5D  ${curto}: o seletor usa SO capacidadesParaMudarNivel (sem 'todas' de reserva)`,
        /definirNivelDasCapacidadesDaApi\(agenteId, (ligadas|capacidadesParaMudarNivel\(api\)), n\)/.test(src) &&
          !/capacidades\.map\(\(c\) => c\.id\), n/.test(src) && !/ligadas\.length > 0 \? ligadas/.test(src));
      ok(`5E  ${curto}: seletor desabilitado quando nada esta ligado`,
        /desabilitado=\{ocupado \|\| \(api !== null && (ligadas|capacidadesParaMudarNivel\(api\))\.length === 0\)\}/.test(src));
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  secao("6. Telas legadas por recurso: alcancaveis -> adaptadas");
  // ═══════════════════════════════════════════════════════════════════
  {
    // Alcancabilidade REAL (rotas e links), provada pela arvore:
    ok("6a  /ia/agentes/[id]?aba=… monta PaginaAgente (com a aba Conexoes)",
      /<PaginaAgente agenteId=\{params\.id\}/.test(ler("app/(app)/ia/agentes/[id]/page.tsx")) &&
        /aba === "conexoes" && <ConexoesAgente/.test(ler("components/ia/agente/PaginaAgente.tsx")) &&
        /id: "conexoes"/.test(ler("lib/ia/abas.ts")));
    ok("6b  /ia/agentes/[id]/configurar monta o Wizard, que monta ConexoesAgente",
      /<Wizard agenteIdInicial=\{params\.id\}/.test(ler("app/(app)/ia/agentes/[id]/configurar/page.tsx")) &&
        /<ConexoesAgente agenteId=\{agenteId\}/.test(ler("components/ia/factory/Wizard.tsx")));
    ok("6c  e ha links reais para elas (Office, fila de aprovacoes)",
      /\/configurar`/.test(ler("components/ia/office/OfficeAgentPanelV1.tsx")) &&
        /\?aba=funcoes/.test(ler("components/ia/aprovacoes/FilaAprovacoes.tsx")));

    const reqs: ConexaoRequisitoUI[] = [
      { plataforma: ML, recurso: "perguntas", obrigatoria: true, marketplace: "ML", lojaIdSelecionada: MONAMOR,
        utilizavel: true, lojasElegiveis: contas } as never,
      { plataforma: ML, recurso: "vendas", obrigatoria: true, marketplace: "ML", lojaIdSelecionada: OUTRA,
        utilizavel: true, lojasElegiveis: contas } as never,
    ];
    const grupos = agruparPorPlataforma(reqs);
    ok("6d  ConexoesAgente: 2 requisitos ML viram UMA conexao do provider", grupos.length === 1 && grupos[0].plataforma === ML);
    ok("6e  e o estado antigo divergente e detectado", grupos[0].divergente && grupos[0].selecionada === null);
    const incompleto = agruparPorPlataforma([reqs[0], { ...reqs[1], lojaIdSelecionada: null } as never]);
    ok("6f  parte sem conta: aparece sem escolha (uma escolha aplica a todos)",
      incompleto[0].incompleta && incompleto[0].selecionada === null);
    const cx = semComentarios(ler("components/ia/agente/ConexoesAgente.tsx"));
    ok("6g  ConexoesAgente: rotulo so do provider (sem '· Recurso')", !/ROTULO_RECURSO|conexao\.recurso/.test(cx) &&
      /const rotulo = ROTULO_PLATAFORMA\[conexao\.plataforma\] \?\? conexao\.plataforma;/.test(cx));
    ok("6h  ConexoesAgente: provider de API grava por PATCH /apis; contrato por recurso so fora disso",
      /const provedor = provedorDeAgentesDaPlataforma\(grupo\.plataforma\);/.test(cx) &&
        /if \(provedor !== null\) \{\s*resposta = await definirContaDaApi\(agenteId, provedor, lojaId\);/.test(cx) &&
        // A fronteira da UI: o componente nao importa o dominio (lib/agentes).
        !/lib\/agentes/.test(cx));
    ok("6h2 ML e provider de agentes (vai por /apis); Shopee nao",
      provedorDeAgentesDaPlataforma("mercado_livre") === "mercado_livre" && provedorDeAgentesDaPlataforma("shopee") === null);
    // Toda tela que escolhe conta: UM <select>, e nenhum por recurso.
    for (const arq of ["components/ia/agentes/ApisDoAgente.tsx", "components/ia/criar/EtapaApis.tsx",
      "components/ia/agente/ConexoesAgente.tsx"]) {
      const src = semComentarios(ler(arq));
      ok(`6i  ${arq.split("/").pop()}: exatamente um <select> (por provider)`, (src.match(/<select\b/g) ?? []).length === 1);
    }
    // Quem ainda chama o contrato por recurso no cliente: so o ConexoesAgente (fora do ML).
    const chamadores = execFileSync("git", ["grep", "-l", "definirConexaoDoAgente(", "--", "components", "app"],
      { cwd: RAIZ, encoding: "utf8" }).trim().split(/\r?\n/).filter(Boolean);
    ok("6j  PATCH /conexoes no cliente: so ConexoesAgente (ramo sem capability de agente)",
      JSON.stringify(chamadores) === JSON.stringify(["components/ia/agente/ConexoesAgente.tsx"]), JSON.stringify(chamadores));
    ok("6k  Wizard: o aviso cita cada provider UMA vez",
      /\[\.\.\.new Set\(ativacao\.conexoesSemLoja\.map\(\(c\) => c\.nome\)\)\]/.test(ler("components/ia/factory/Wizard.tsx")));
    ok("6l  PATCH /conexoes continua existindo (compatibilidade)",
      /export async function PATCH/.test(ler("app/api/agentes/[agenteId]/conexoes/route.ts")));
  }

  // ═══════════════════════════════════════════════════════════════════
  secao("7. Shopee, Tools, migration, write externo");
  // ═══════════════════════════════════════════════════════════════════
  {
    const sh = projetarApisDoAgente({ permissoes: [], requisitos: [], contasPorProvedor: {},
      selecoes: [{ plataforma: "shopee", recurso: "pedidos", lojaId: OUTRA }] }).find((p) => p.id === "shopee")!;
    ok("7a  Shopee: indisponivel, zero capabilities, mesmo com linha gravada",
      sh.capacidades.length === 0 && sh.textoDeStatus === "Ainda não disponível para agentes" &&
        planoDaApi({ disponivelParaAgentes: false, conexoes: [], contaDoAgente: { estado: "nenhuma" } }).tipo === "indisponivel" &&
        INTEGRACOES_CDS.find((i) => i.chave === "shopee")?.packId === null);
    ok("7b  Tools seguem Tools", ["planilhas", "calculadora", "calendario", "vendas"].every(ehTool) && !ehTool("mercadolivre-perguntas"));
    ok("7c  nenhuma capability de escrita", CAPACIDADES_DE_API.every((c) => c.efeito === "leitura"));
    const mudadas = execFileSync("git", ["diff", "--name-only", "3e2de493d10193b62a26e2572b5c82124d79fa09", "--", "supabase"],
      { cwd: RAIZ, encoding: "utf8" }).trim();
    const novas = execFileSync("git", ["ls-files", "--others", "--exclude-standard", "--", "supabase"],
      { cwd: RAIZ, encoding: "utf8" }).trim();
    ok("7d  nenhuma migration", mudadas === "" && novas === "", `${mudadas} ${novas}`);
  }

  console.log(`\n── placar ${"─".repeat(54)}`);
  console.log(`  PASS ${passou}   FAIL ${falhou}`);
}

void main().then(
  () => process.exit(falhou > 0 ? 1 : 0),
  (e) => { console.error("ERRO NAO TRATADO:", e); process.exit(1); }
);
