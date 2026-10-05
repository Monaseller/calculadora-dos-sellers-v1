/**
 * F9.2-A — API domain foundation: provider, connection, capability,
 * acesso do agente, e Tools separadas.
 *
 * NAO chama IA, NAO chama rede, NAO chama banco.
 *
 * Prova o dominio PURO (`apis/catalogo.ts`, `apis/projecao.ts`) contra o
 * registry REAL de Funcoes, e por leitura de fonte que a rota e o servico
 * usam as cercas certas (sessao/dono, requisitos reais, contas do dono).
 *
 * Rodar:  npx tsx scripts/testar-agentes-f9-2-api-dominio.ts
 */
import "./_server-only-inerte";

import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

import { FUNCOES } from "@/lib/agentes/funcoes/registry";
import { TOOL_PACKS } from "@/lib/agentes/factory/catalogo-ui";
import {
  CAPACIDADES_DE_API, PROVEDORES_DE_API, TOOLS_INTERNAS,
  capacidadeDaFuncao, capacidadesDoProvedor, ehAliasDeApi, ehTool,
  provedorDaPlataforma, provedorDisponivelParaAgentes, provedorDoPackLegado, provedorPorId,
} from "@/lib/agentes/apis/catalogo";
import {
  contaDoAgente, planejarContaDoProvedor, projetarApisDoAgente,
  type RequisitoDoAgente,
} from "@/lib/agentes/apis/projecao";
import {
  INTEGRACOES_CDS, PACK_API_MERCADO_LIVRE, ehPackDeApi, projetarCapacidades,
} from "@/lib/ia/agentes-gestao";
import { MARKETPLACE_POR_PLATAFORMA } from "@/lib/agentes/conexoes/estado";

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
  f.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const ML = "mercado_livre";
const LOJA_ML_1 = "11111111-1111-4111-8111-111111111111";
const LOJA_ML_2 = "22222222-2222-4222-8222-222222222222";
const LOJA_OUTRO_DONO = "99999999-9999-4999-8999-999999999999";
const LOJA_SHOPEE = "33333333-3333-4333-8333-333333333333";

function req(recurso: string, loja: string | null, utilizavel = loja !== null, plataforma = ML): RequisitoDoAgente {
  return { plataforma, recurso, lojaIdSelecionada: loja, utilizavel };
}

async function main(): Promise<void> {
  console.log("\n══ CDS IA — F9.2-A: API domain foundation ══");

  // ═══════════════════════════════════════════════════════════════════
  secao("A/B. Mercado Livre e Shopee sao PROVIDERS de API");
  // ═══════════════════════════════════════════════════════════════════
  const ml = provedorPorId("mercado_livre");
  const sh = provedorPorId("shopee");
  ok("A1  mercado_livre e provider", ml !== null && ml.nome === "Mercado Livre");
  ok("A2  conexao do ML = lojas do OAuth da CDS (marketplace ML)",
    ml?.origemDaConexao === "lojas_oauth_cds" && ml.marketplace === "ML");
  ok("B1  shopee e provider", sh !== null && sh.nome === "Shopee");
  ok("B2  conexao Shopee = as MESMAS lojas do OAuth da CDS (sem segunda integracao)",
    sh?.origemDaConexao === "lojas_oauth_cds" && sh.marketplace === "Shopee");
  ok("B3  plataforma/marketplace batem com o mapa canonico das conexoes",
    PROVEDORES_DE_API.every((p) => MARKETPLACE_POR_PLATAFORMA[p.plataforma] === p.marketplace));
  ok("B4  provider por plataforma resolve so os conhecidos",
    provedorDaPlataforma("shopee")?.id === "shopee" && provedorDaPlataforma("amazon") === null);

  // ═══════════════════════════════════════════════════════════════════
  secao("C/D. Planilhas e Calculadora sao TOOLS, nao API");
  // ═══════════════════════════════════════════════════════════════════
  for (const t of ["planilhas", "calculadora", "calendario", "vendas"]) {
    ok(`C   '${t}' e Tool`, ehTool(t));
    ok(`C   '${t}' NAO e alias de API`, !ehAliasDeApi(t) && provedorDoPackLegado(t) === null);
  }
  ok("D1  nenhuma Funcao de Tool e capability de API",
    TOOLS_INTERNAS.flatMap((t) => t.funcoes).every((f) => capacidadeDaFuncao(f) === null));
  ok("D2  o pack ML NAO e Tool", !ehTool("mercadolivre-perguntas"));
  ok("D3  Tools + aliases cobrem TODOS os Tool Packs, sem sobra nem sobreposicao",
    TOOL_PACKS.every((p) => ehTool(p.id) !== ehAliasDeApi(p.id)));
  ok("D4  nenhum provider e Tool", PROVEDORES_DE_API.every((p) => !ehTool(p.id)));

  // ═══════════════════════════════════════════════════════════════════
  secao("E. Capabilities ML = SO as reais, coerentes com o registry");
  // ═══════════════════════════════════════════════════════════════════
  const capsMl = capacidadesDoProvedor("mercado_livre").map((c) => c.id).sort();
  ok("E1  exatamente perguntas.listar e vendas.consultar",
    JSON.stringify(capsMl) === JSON.stringify(["mercadolivre.perguntas.listar", "mercadolivre.vendas.consultar"]),
    JSON.stringify(capsMl));
  for (const c of CAPACIDADES_DE_API) {
    const d = FUNCOES[c.funcaoId];
    ok(`E2  ${c.id}: Funcao existe no registry`, d !== undefined);
    if (!d) continue;
    const p = provedorPorId(c.provedor);
    ok(`E3  ${c.id}: plataforma/recurso = conexaoNecessaria do registry`,
      d.conexaoNecessaria !== null && d.conexaoNecessaria.plataforma === p?.plataforma &&
        d.conexaoNecessaria.recurso === c.recurso, JSON.stringify(d.conexaoNecessaria));
    ok(`E4  ${c.id}: efeito = acesso do registry`, d.acesso === c.efeito);
    ok(`E5  ${c.id}: id da capability = funcaoId (sem traducao)`, c.id === c.funcaoId);
  }
  // Toda Funcao que exige conta de provider esta catalogada: nenhuma API
  // "escondida" como Tool, e nenhuma Funcao conectada sem provider.
  const conectadas = Object.entries(FUNCOES).filter(([, d]) => d.conexaoNecessaria !== null).map(([id]) => id);
  ok("E6  toda Funcao com conexao e capability catalogada",
    conectadas.every((id) => capacidadeDaFuncao(id) !== null), JSON.stringify(conectadas));
  ok("E7  responder/mensagens/estoque/preco NAO existem como capability",
    CAPACIDADES_DE_API.every((c) => !/responder|mensage|estoque|preco|anuncio|criar/.test(c.id)));

  // ═══════════════════════════════════════════════════════════════════
  secao("F. Shopee: provider SEM capability agent-ready");
  // ═══════════════════════════════════════════════════════════════════
  ok("F1  zero capabilities Shopee", capacidadesDoProvedor("shopee").length === 0);
  ok("F2  Shopee nao esta disponivel para agentes", !provedorDisponivelParaAgentes("shopee"));
  const projVazia = projetarApisDoAgente({ permissoes: [], requisitos: [], contasPorProvedor: {
    shopee: [{ id: LOJA_SHOPEE, nome: "Loja Shopee", nickname: null }] } });
  const pSh = projVazia.find((p) => p.id === "shopee");
  ok("F3  projecao: Shopee com status 'Ainda não disponível para agentes'",
    pSh?.disponivelParaAgentes === false && pSh.textoDeStatus === "Ainda não disponível para agentes");
  ok("F4  projecao: NENHUMA capability (sem checkbox vazio)", pSh?.capacidades.length === 0);
  ok("F5  projecao: a conta Shopee existente e reconhecida como conexao",
    pSh?.conexoes.length === 1 && pSh.conexoes[0].id === LOJA_SHOPEE);
  ok("F6  escolher conta Shopee para agente e recusado (sem capability)",
    (() => { const r = planejarContaDoProvedor({ provedorId: "shopee", lojaId: LOJA_SHOPEE,
      requisitos: [req("pedidos", null, false, "shopee")], elegiveis: [{ id: LOJA_SHOPEE, nome: null, nickname: null }] });
      return !r.ok && r.codigo === "provedor_indisponivel_para_agentes"; })());
  ok("F7  a UI segue com Shopee sem pack (texto atual preservado)",
    INTEGRACOES_CDS.find((i) => i.chave === "shopee")?.packId === null);

  // ═══════════════════════════════════════════════════════════════════
  secao("G. Alias mercadolivre-perguntas continua funcionando");
  // ═══════════════════════════════════════════════════════════════════
  ok("G1  o alias resolve para o provider Mercado Livre",
    provedorDoPackLegado("mercadolivre-perguntas")?.id === "mercado_livre");
  ok("G2  o pack segue existindo em TOOL_PACKS (agentes antigos)",
    TOOL_PACKS.some((p) => p.id === "mercadolivre-perguntas"));
  const pack = TOOL_PACKS.find((p) => p.id === "mercadolivre-perguntas");
  ok("G3  funcoes do pack = capabilities do provider (sem permissao duplicada)",
    JSON.stringify([...(pack?.funcoes ?? [])].sort()) === JSON.stringify(capsMl));
  ok("G4  agentes-gestao exporta os MESMOS valores de antes",
    PACK_API_MERCADO_LIVRE === "mercadolivre-perguntas" && ehPackDeApi("mercadolivre-perguntas") &&
      !ehPackDeApi("planilhas"));
  ok("G5  INTEGRACOES_CDS identico ao contrato anterior (ordem, ids, pack)",
    JSON.stringify(INTEGRACOES_CDS.map((i) => [i.chave, i.nome, i.marketplace, i.plataforma, i.packId, i.logo])) ===
      JSON.stringify([
        ["mercado_livre", "Mercado Livre", "ML", "mercado_livre", "mercadolivre-perguntas", "/logo-ml.svg"],
        ["shopee", "Shopee", "Shopee", "shopee", null, "/logo-shopee.svg"],
      ]));
  {
    const proj = projetarCapacidades({
      ferramentas: [
        { id: "mercadolivre-perguntas" }, { id: "planilhas" }, { id: "calculadora" },
      ] as never,
      ferramentasExternas: [],
    });
    ok("G6  projecao da UI: ML na secao APIs, Planilhas/Calculadora em Tools",
      proj.packsDeApi.map((f) => f.id).join() === "mercadolivre-perguntas" &&
        proj.tools.map((f) => f.id).join() === "planilhas,calculadora");
  }

  // ═══════════════════════════════════════════════════════════════════
  secao("H. Agente EXISTENTE com permissoes antigas");
  // ═══════════════════════════════════════════════════════════════════
  {
    // Como um agente de antes do F9.2 esta no banco: linhas por Funcao do
    // pack, planilhas tambem, e agente_conexoes por recurso, mesma loja.
    const proj = projetarApisDoAgente({
      permissoes: [
        { funcaoId: "mercadolivre.perguntas.listar", nivel: "automatico" },
        { funcaoId: "mercadolivre.vendas.consultar", nivel: "aprovacao" },
        { funcaoId: "planilha.ler", nivel: "automatico" },
        { funcaoId: "composio.gmail.enviar", nivel: "aprovacao" },
      ],
      requisitos: [req("perguntas", LOJA_ML_1), req("vendas", LOJA_ML_1)],
      contasPorProvedor: { mercado_livre: [{ id: LOJA_ML_1, nome: "Monamor", nickname: "MONAMOR" }] },
    });
    const pMl = proj.find((p) => p.id === "mercado_livre");
    const cap = (id: string) => pMl?.capacidades.find((c) => c.id === id);
    ok("H1  ML habilitado com os niveis gravados",
      cap("mercadolivre.perguntas.listar")?.habilitadaNoAgente === true &&
        cap("mercadolivre.perguntas.listar")?.nivel === "automatico" &&
        cap("mercadolivre.vendas.consultar")?.nivel === "aprovacao");
    ok("H2  UMA conta para o provider", pMl?.contaDoAgente.estado === "definida" &&
      "lojaId" in pMl.contaDoAgente && pMl.contaDoAgente.lojaId === LOJA_ML_1);
    ok("H3  Planilhas e acao externa NAO aparecem como capability de provider",
      proj.every((p) => p.capacidades.every((c) => !c.id.startsWith("planilha.") && !c.id.startsWith("composio."))));
    ok("H4  capability sem permissao aparece desabilitada (nao some)",
      projetarApisDoAgente({ permissoes: [], requisitos: [], contasPorProvedor: {} })
        .find((p) => p.id === "mercado_livre")?.capacidades.every((c) => !c.habilitadaNoAgente && c.disponivel) === true);
    ok("H5  linhas antigas com contas diferentes -> 'divergente' (a tela pede UMA escolha)",
      contaDoAgente(ml!, [req("perguntas", LOJA_ML_1), req("vendas", LOJA_ML_2)]).estado === "divergente");
    ok("H6  parte dos recursos sem conta -> 'incompleta'",
      contaDoAgente(ml!, [req("perguntas", LOJA_ML_1), req("vendas", null)]).estado === "incompleta");
    ok("H7  conta escolhida que nao serve -> definida, mas nao utilizavel",
      (() => { const c = contaDoAgente(ml!, [req("perguntas", LOJA_ML_1, false), req("vendas", LOJA_ML_1, true)]);
        return c.estado === "definida" && "utilizavel" in c && c.utilizavel === false; })());
  }

  // ═══════════════════════════════════════════════════════════════════
  secao("I. UMA conta ML -> todos os recursos atuais daquela API");
  // ═══════════════════════════════════════════════════════════════════
  {
    const requisitos = [req("vendas", null), req("perguntas", null)];
    const elegiveis = [{ id: LOJA_ML_1, nome: "Monamor", nickname: null }];
    const p = planejarContaDoProvedor({ provedorId: "mercado_livre", lojaId: LOJA_ML_1, requisitos, elegiveis });
    ok("I1  uma escolha vira uma gravacao por recurso exigido",
      p.ok && JSON.stringify(p.gravacoes) === JSON.stringify([
        { tipo: "definir", plataforma: ML, recurso: "perguntas", lojaId: LOJA_ML_1 },
        { tipo: "definir", plataforma: ML, recurso: "vendas", lojaId: LOJA_ML_1 },
      ]), JSON.stringify(p));
    const so1 = planejarContaDoProvedor({ provedorId: "mercado_livre", lojaId: LOJA_ML_1,
      requisitos: [req("vendas", null)], elegiveis });
    ok("I2  so os recursos que o agente REALMENTE exige (nenhum inventado)",
      so1.ok && so1.gravacoes.length === 1 && so1.gravacoes[0].recurso === "vendas");
    const remover = planejarContaDoProvedor({ provedorId: "mercado_livre", lojaId: null, requisitos, elegiveis: [] });
    ok("I3  lojaId null remove a conta de TODOS os recursos",
      remover.ok && remover.gravacoes.every((g) => g.tipo === "remover") && remover.gravacoes.length === 2);
    ok("I4  agente sem requisito do provider: recusa (nao cria vinculo que ninguem pediu)",
      (() => { const r = planejarContaDoProvedor({ provedorId: "mercado_livre", lojaId: LOJA_ML_1,
        requisitos: [], elegiveis }); return !r.ok && r.codigo === "sem_requisito"; })());
    ok("I5  requisito de OUTRA plataforma nao e arrastado junto",
      (() => { const r = planejarContaDoProvedor({ provedorId: "mercado_livre", lojaId: LOJA_ML_1,
        requisitos: [req("vendas", null), req("pedidos", null, false, "shopee")], elegiveis });
        return r.ok && r.gravacoes.every((g) => g.plataforma === ML) && r.gravacoes.length === 1; })());
  }

  // ═══════════════════════════════════════════════════════════════════
  secao("J. Conta de outro dono nunca e vinculavel");
  // ═══════════════════════════════════════════════════════════════════
  {
    const requisitos = [req("vendas", null)];
    const elegiveisDoDono = [{ id: LOJA_ML_1, nome: null, nickname: null }];
    const r = planejarContaDoProvedor({ provedorId: "mercado_livre", lojaId: LOJA_OUTRO_DONO, requisitos, elegiveis: elegiveisDoDono });
    ok("J1  loja fora da lista do dono: conta_indisponivel", !r.ok && r.codigo === "conta_indisponivel");
    const rShopeeNoMl = planejarContaDoProvedor({ provedorId: "mercado_livre", lojaId: LOJA_SHOPEE, requisitos, elegiveis: elegiveisDoDono });
    ok("J2  loja de outro marketplace: mesma resposta", !rShopeeNoMl.ok && rShopeeNoMl.codigo === "conta_indisponivel");
    for (const lixo of [123, "", {}, ["x"], undefined]) {
      const x = planejarContaDoProvedor({ provedorId: "mercado_livre", lojaId: lixo, requisitos, elegiveis: elegiveisDoDono });
      ok(`J3  lojaId hostil ${JSON.stringify(lixo) ?? "undefined"} recusado`, !x.ok);
    }
    const sv = semComentarios(ler("lib/agentes/apis/servico.ts"));
    ok("J4  servico: contas SO de listarLojasConectadasDoDono(userId, marketplace do provider)",
      /listarLojasConectadasDoDono\(userId, marketplace\)/.test(sv) &&
        /contasDoMarketplace\(userId, provedor\.marketplace\)/.test(sv));
    ok("J5  servico: requisito provado ANTES de ler contas (sem sonda de lojas)",
      sv.indexOf("sem_requisito") < sv.indexOf("contasDoMarketplace(userId, provedor.marketplace)"));
    const rt = semComentarios(ler("app/api/agentes/[agenteId]/apis/route.ts"));
    ok("J6  rota: GET e PATCH passam pela porta (sessao + dono do agente)",
      (rt.match(/atravessarPorta\(/g) ?? []).length === 2);
    ok("J7  rota: corpo FECHADO em {provedor, lojaId} (sem recurso/plataforma/nivel/ids)",
      /\["lojaId", "provedor"\]/.test(rt) && !/corpo\.(recurso|plataforma|nivel|userId|agenteId)/.test(rt));
  }

  // ═══════════════════════════════════════════════════════════════════
  secao("K. funcao_id nao cadastrado nao vira capability");
  // ═══════════════════════════════════════════════════════════════════
  for (const id of ["mercadolivre.mensagens.responder", "mercadolivre.perguntas.responder",
    "shopee.pedidos.listar", "mercadolivre.perguntas.listar ", "MERCADOLIVRE.PERGUNTAS.LISTAR", "", null]) {
    ok(`K   '${String(id)}' nao e capability`, capacidadeDaFuncao(id) === null);
  }
  ok("K   provider spoofing: id desconhecido/variante nao resolve",
    provedorPorId("Mercado Livre") === null && provedorPorId("ml") === null && provedorPorId("mercado_livre ") === null);
  {
    const proj = projetarApisDoAgente({
      permissoes: [{ funcaoId: "mercadolivre.mensagens.responder", nivel: "automatico" }],
      requisitos: [], contasPorProvedor: {},
    });
    ok("K   permissao gravada para Funcao fantasma nao cria capability na projecao",
      proj.every((p) => p.capacidades.every((c) => c.id !== "mercadolivre.mensagens.responder")));
    const r = planejarContaDoProvedor({ provedorId: "amazon", lojaId: LOJA_ML_1, requisitos: [req("vendas", null)], elegiveis: [] });
    ok("K   provider desconhecido no PATCH: recusado", !r.ok && r.codigo === "provedor_desconhecido");
  }

  // ═══════════════════════════════════════════════════════════════════
  secao("L/M. Nenhum write habilitado, nenhuma migration");
  // ═══════════════════════════════════════════════════════════════════
  ok("L1  toda capability catalogada e de LEITURA", CAPACIDADES_DE_API.every((c) => c.efeito === "leitura"));
  ok("L2  e a Funcao real tambem", CAPACIDADES_DE_API.every((c) => FUNCOES[c.funcaoId]?.acesso === "leitura"));
  ok("L3  o dominio novo nao chama marketplace nem executa Funcao",
    ["lib/agentes/apis/catalogo.ts", "lib/agentes/apis/projecao.ts", "lib/agentes/apis/servico.ts",
      "app/api/agentes/[agenteId]/apis/route.ts"]
      .every((f) => !/fetch\(|executarFuncao|api\.mercadolibre|partner\.shopeemobile/.test(semComentarios(ler(f)))));
  ok("L4  o servico so escreve agente_conexoes pelas portas existentes",
    /definirSelecaoDeLoja\(/.test(ler("lib/agentes/apis/servico.ts")) &&
      !/\.from\(/.test(semComentarios(ler("lib/agentes/apis/servico.ts"))));
  {
    const mudadas = execFileSync("git", ["diff", "--name-only", "3e2de493d10193b62a26e2572b5c82124d79fa09", "--", "supabase"],
      { cwd: RAIZ, encoding: "utf8" }).trim();
    const novas = execFileSync("git", ["ls-files", "--others", "--exclude-standard", "--", "supabase"],
      { cwd: RAIZ, encoding: "utf8" }).trim();
    ok("M1  nenhuma migration nova ou alterada desde a base", mudadas === "" && novas === "",
      `${mudadas} ${novas}`);
  }

  console.log(`\n── placar ${"─".repeat(54)}`);
  console.log(`  PASS ${passou}   FAIL ${falhou}`);
}

void main().then(
  () => process.exit(falhou > 0 ? 1 : 0),
  (e) => { console.error("ERRO NAO TRATADO:", e); process.exit(1); }
);
