/**
 * F9.2-A2 — UMA conta por API, de ponta a ponta.
 *
 * NAO chama IA, NAO chama rede, NAO chama banco.
 *
 * Prova, com o codigo REAL e portas em memoria:
 *   - a decisao da tela (`planoDaApi`) e os componentes (um seletor por
 *     provider, nenhum conhecimento de recurso);
 *   - a heranca de conta por capability nova (`contaParaHerdar`) e o
 *     caminho de permissao que a usa ANTES de gravar;
 *   - o PATCH tudo-ou-nada (`aplicarComCompensacao`) com falha injetada
 *     na primeira, numa intermediaria e na ultima escrita.
 *
 * Rodar:  npx tsx scripts/testar-agentes-f9-2-a2-conta-unica.ts
 */
import "./_server-only-inerte";

import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

import {
  CAPACIDADES_DE_API, capacidadeDaFuncao, ehTool, provedorDoPackLegado, provedorPorId,
} from "@/lib/agentes/apis/catalogo";
import {
  contaDoAgente, contaParaHerdar, planejarContaDoProvedor, projetarApisDoAgente,
  type GravacaoDeConta, type RequisitoDoAgente,
} from "@/lib/agentes/apis/projecao";
import { aplicarComCompensacao, chaveDaLinha, type PortasDeConta } from "@/lib/agentes/apis/aplicacao";
import {
  INTEGRACOES_CDS, contaEmUsoDaApi, contaSelecionadaDaApi, planoDaApi,
} from "@/lib/ia/agentes-gestao";
import type { ApiDoAgenteUI, ContaDoAgenteNaApiUI } from "@/lib/ia/agentes-http";

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
const ALHEIA = "99999999-9999-4999-8999-999999999999";
const ml = provedorPorId("mercado_livre")!;

const conta = (id: string, nome: string) => ({ id, nome, nickname: null });
function api(conexoes: { id: string; nome: string; nickname: null }[], c: ContaDoAgenteNaApiUI,
  disponivel = true): ApiDoAgenteUI {
  return { id: "mercado_livre", nome: "Mercado Livre", disponivelParaAgentes: disponivel,
    textoDeStatus: disponivel ? null : "Ainda não disponível para agentes", conexoes, contaDoAgente: c, capacidades: [] };
}
function req(recurso: string, loja: string | null, utilizavel = loja !== null): RequisitoDoAgente {
  return { plataforma: ML, recurso, lojaIdSelecionada: loja, utilizavel };
}

/** `agente_conexoes` em memoria, por (plataforma, recurso), com falha injetavel. */
function bancoDeConexoes(inicial: Record<string, string | null>, falharNaEscrita: number[] = [],
  falharNaVolta = false) {
  const linhas = new Map<string, string>();
  for (const [r, l] of Object.entries(inicial)) if (l !== null) linhas.set(chaveDaLinha({ plataforma: ML, recurso: r }), l);
  let escrita = 0;
  let fase: "aplicar" | "voltar" = "aplicar";
  const portas: PortasDeConta = {
    async definir(g) {
      escrita += 1;
      if (fase === "aplicar" && falharNaEscrita.includes(escrita)) {
        // Falha "suja": a linha CHEGA a mudar e o retorno diz falha — o pior caso.
        linhas.set(chaveDaLinha(g), g.lojaId);
        fase = "voltar";
        return false;
      }
      if (fase === "voltar" && falharNaVolta) return false;
      linhas.set(chaveDaLinha(g), g.lojaId);
      return true;
    },
    async remover(g) {
      escrita += 1;
      if (fase === "aplicar" && falharNaEscrita.includes(escrita)) { fase = "voltar"; return false; }
      if (fase === "voltar" && falharNaVolta) return false;
      linhas.delete(chaveDaLinha(g));
      return true;
    },
  };
  const estado = (r: string) => linhas.get(chaveDaLinha({ plataforma: ML, recurso: r })) ?? null;
  return { portas, estado };
}

async function main(): Promise<void> {
  console.log("\n══ CDS IA — F9.2-A2: uma conta por API ══");

  // ═══════════════════════════════════════════════════════════════════
  secao("A/B. Tela: UM seletor por provider, com 1 ou varias contas");
  // ═══════════════════════════════════════════════════════════════════
  ok("A1  1 conta ML, nada escolhido -> auto com essa conta (sem seletor)",
    JSON.stringify(planoDaApi(api([conta(MONAMOR, "Monamor")], { estado: "nenhuma" }))) ===
      JSON.stringify({ tipo: "auto", lojaId: MONAMOR }));
  ok("A2  1 conta ML ja escolhida e utilizavel -> pronta",
    planoDaApi(api([conta(MONAMOR, "Monamor")], { estado: "definida", lojaId: MONAMOR, utilizavel: true })).tipo === "pronta");
  ok("B1  2 contas ML, nada escolhido -> escolher (o dono escolhe UMA)",
    planoDaApi(api([conta(MONAMOR, "Monamor"), conta(OUTRA, "Outra")], { estado: "nenhuma" })).tipo === "escolher");
  ok("B2  conta escolhida que nao serve -> escolher (nunca troca sem o dono)",
    planoDaApi(api([conta(MONAMOR, "Monamor")], { estado: "definida", lojaId: MONAMOR, utilizavel: false })).tipo === "escolher");
  ok("B3  sem conta na CDS -> conectar_conta",
    planoDaApi(api([], { estado: "nenhuma" })).tipo === "conectar_conta");
  ok("B4  select mostra a conta do provider", contaSelecionadaDaApi(api([], { estado: "definida", lojaId: MONAMOR, utilizavel: true })) === MONAMOR);
  ok("B5  'Conta em uso' so com conta utilizavel",
    contaEmUsoDaApi(api([conta(MONAMOR, "Monamor")], { estado: "definida", lojaId: MONAMOR, utilizavel: true }))?.nome === "Monamor" &&
      contaEmUsoDaApi(api([conta(MONAMOR, "Monamor")], { estado: "definida", lojaId: MONAMOR, utilizavel: false })) === null);

  for (const arq of ["components/ia/agentes/ApisDoAgente.tsx", "components/ia/criar/EtapaApis.tsx"]) {
    const src = semComentarios(ler(arq));
    const curto = arq.split("/").pop();
    ok(`B6  ${curto}: exatamente UM <select> (o da conta do provider)`, (src.match(/<select\b/g) ?? []).length === 1,
      String((src.match(/<select\b/g) ?? []).length));
    ok(`B7  ${curto}: o seletor nao e por recurso`, !/\.recurso|recurso\b|doAgente/.test(src));
    ok(`B8  ${curto}: usa o contrato de provider (GET/PATCH /apis)`,
      /buscarApisDoAgente\(/.test(src) && /definirContaDaApi\(/.test(src));
    ok(`B9  ${curto}: nao usa mais o contrato por requisito`,
      !/buscarConexoesDoAgente|definirConexaoDoAgente|planoDeConexao|ConexaoRequisitoUI|ROTULO_RECURSO/.test(src));
  }
  {
    // Recorte pelo texto CRU (o marcador final e um comentario), e so
    // depois sem comentarios.
    const cru = ler("lib/ia/agentes-http.ts");
    const inicio = cru.indexOf("F9.2-A2 — APIs do agente");
    const fim = cru.indexOf("AGENT-FACTORY-F7b.1 — o transporte");
    const trecho = semComentarios(cru.slice(inicio, fim));
    ok("B10a recorte do bloco de APIs encontrado", inicio > 0 && fim > inicio);
    ok("B10 transporte: corpo FECHADO { provedor, lojaId }", /JSON\.stringify\(\{ provedor, lojaId \}\)/.test(trecho));
    ok("B11 transporte: nenhum campo `recurso` no contrato de APIs", !/recurso/.test(trecho));
  }

  // ═══════════════════════════════════════════════════════════════════
  secao("C. Escolher a conta ML -> todos os recursos com a MESMA loja");
  // ═══════════════════════════════════════════════════════════════════
  {
    const requisitos = [req("perguntas", null), req("vendas", null)];
    const plano = planejarContaDoProvedor({ provedorId: "mercado_livre", lojaId: MONAMOR, requisitos,
      elegiveis: [conta(MONAMOR, "Monamor")] });
    const banco = bancoDeConexoes({ perguntas: null, vendas: null });
    const r = plano.ok ? await aplicarComCompensacao(plano.gravacoes, new Map(), banco.portas) : null;
    ok("C1  aplicado com sucesso", r?.ok === true);
    ok("C2  perguntas e vendas com a mesma loja", banco.estado("perguntas") === MONAMOR && banco.estado("vendas") === MONAMOR);
    ok("C3  projecao volta UMA conta definida",
      contaDoAgente(ml, [req("perguntas", MONAMOR), req("vendas", MONAMOR)]).estado === "definida");
  }

  // ═══════════════════════════════════════════════════════════════════
  secao("D. Capability adicionada DEPOIS herda a conta do provider");
  // ═══════════════════════════════════════════════════════════════════
  {
    // T0: so vendas, com Monamor. T1: perguntas entra (requisito novo, sem loja).
    const t1 = [req("vendas", MONAMOR), req("perguntas", null)];
    const h = contaParaHerdar(ml, t1);
    ok("D1  perguntas herda Monamor", "lojaId" in h && h.lojaId === MONAMOR, JSON.stringify(h));
    // Uma capability FUTURA do mesmo provider (ex.: mensagens.ler): a regra
    // e por provider, nao por recurso — o recurso novo herda igual.
    const futura = contaParaHerdar(ml, [req("vendas", MONAMOR), req("perguntas", MONAMOR), req("mensagens", null)]);
    ok("D2  recurso futuro (mensagens) herda a mesma conta", "lojaId" in futura && futura.lojaId === MONAMOR);
    ok("D3  provider sem conta -> sem_conta (fica sem cobertura ate escolher)",
      JSON.stringify(contaParaHerdar(ml, [req("perguntas", null)])) === JSON.stringify({ motivo: "sem_conta" }));
    ok("D4  provider divergente -> NAO adivinha",
      JSON.stringify(contaParaHerdar(ml, [req("perguntas", MONAMOR), req("vendas", OUTRA)])) === JSON.stringify({ motivo: "divergente" }));
    ok("D5  conta de OUTRA plataforma nao conta para o ML",
      JSON.stringify(contaParaHerdar(ml, [{ plataforma: "shopee", recurso: "pedidos", lojaIdSelecionada: OUTRA, utilizavel: true }])) ===
        JSON.stringify({ motivo: "sem_conta" }));

    // O caminho REAL de permissao: heranca ANTES da gravacao, e falha bloqueia.
    for (const arq of ["app/api/agentes/[agenteId]/permissoes/route.ts", "lib/agentes/factory/ativar-capacidade.ts"]) {
      const src = semComentarios(ler(arq));
      const iH = src.indexOf("herdarContaDoProvedor(");
      const iP = src.indexOf("definirPermissaoDeFuncaoDoAgente({");
      ok(`D6  ${arq.split("/").slice(-2).join("/")}: herda conta ANTES de gravar a permissao`,
        iH > 0 && iP > iH, `${iH} < ${iP}`);
      ok(`D7  ${arq.split("/").slice(-2).join("/")}: falha na heranca impede a permissao`,
        /heranca\.estado === "falha"/.test(src));
    }
    const sv = semComentarios(ler("lib/agentes/apis/servico.ts"));
    const herdar = sv.slice(sv.indexOf("export async function herdarContaDoProvedor"));
    ok("D8  heranca: Tool/acao externa passam direto (nao_e_api)", /capacidadeDaFuncao\(entrada\.funcaoId\)/.test(herdar) && /"nao_e_api"/.test(herdar));
    ok("D9  heranca: conta herdada SO se ainda for elegivel do dono",
      /contasDoMarketplace\(userId, provedor\.marketplace\)/.test(herdar) && /conta_indisponivel/.test(herdar));
    ok("D10 heranca: recurso ja com conta nao e regravado", /ja_vinculada/.test(herdar));
    ok("D11 heranca: Tools nao mudam (capacidadeDaFuncao de Tool e null)",
      capacidadeDaFuncao("planilha.ler") === null && capacidadeDaFuncao("calculadora.calcular") === null);
  }

  // ═══════════════════════════════════════════════════════════════════
  secao("E. Estado DIVERGENTE antigo: detectado e reconciliado");
  // ═══════════════════════════════════════════════════════════════════
  {
    const antes = [req("perguntas", MONAMOR), req("vendas", OUTRA)];
    ok("E1  projecao detecta divergente", contaDoAgente(ml, antes).estado === "divergente");
    ok("E2  a tela pede UMA escolha",
      planoDaApi(api([conta(MONAMOR, "Monamor"), conta(OUTRA, "Outra")], { estado: "divergente" })).tipo === "escolher");
    const plano = planejarContaDoProvedor({ provedorId: "mercado_livre", lojaId: OUTRA, requisitos: antes,
      elegiveis: [conta(MONAMOR, "Monamor"), conta(OUTRA, "Outra")] });
    const banco = bancoDeConexoes({ perguntas: MONAMOR, vendas: OUTRA });
    const r = plano.ok ? await aplicarComCompensacao(plano.gravacoes,
      new Map(antes.map((x) => [chaveDaLinha(x), x.lojaIdSelecionada])), banco.portas) : null;
    ok("E3  a escolha unica reconcilia todos os recursos",
      r?.ok === true && banco.estado("perguntas") === OUTRA && banco.estado("vendas") === OUTRA);
    ok("E4  depois: definida", contaDoAgente(ml, [req("perguntas", OUTRA), req("vendas", OUTRA)]).estado === "definida");
  }

  // ═══════════════════════════════════════════════════════════════════
  secao("F. Falha no meio do PATCH -> nenhum sucesso parcial");
  // ═══════════════════════════════════════════════════════════════════
  {
    // TRES recursos para haver primeira, intermediaria e ultima escrita.
    const gravacoes: GravacaoDeConta[] = ["a_rec", "b_rec", "c_rec"].map((recurso) =>
      ({ tipo: "definir", plataforma: ML, recurso, lojaId: OUTRA }));
    const anteriores = new Map<string, string | null>([
      [chaveDaLinha({ plataforma: ML, recurso: "a_rec" }), MONAMOR],
      [chaveDaLinha({ plataforma: ML, recurso: "b_rec" }), null],
      [chaveDaLinha({ plataforma: ML, recurso: "c_rec" }), MONAMOR],
    ]);
    for (const [rotulo, n] of [["primeira", 1], ["intermediaria", 2], ["ultima", 3]] as const) {
      const banco = bancoDeConexoes({ a_rec: MONAMOR, b_rec: null, c_rec: MONAMOR }, [n]);
      const r = await aplicarComCompensacao(gravacoes, anteriores, banco.portas);
      ok(`F1  falha na ${rotulo}: resultado NAO e ok`, r.ok === false);
      ok(`F2  falha na ${rotulo}: revertida`, !r.ok && r.codigo === "falha_revertida", JSON.stringify(r));
      ok(`F3  falha na ${rotulo}: estado volta EXATAMENTE ao anterior`,
        banco.estado("a_rec") === MONAMOR && banco.estado("b_rec") === null && banco.estado("c_rec") === MONAMOR,
        `${banco.estado("a_rec")} ${banco.estado("b_rec")} ${banco.estado("c_rec")}`);
    }
    // A volta tambem falha: resultado explicito, nunca ok.
    const erros: string[] = [];
    const original = console.error;
    console.error = (...a: unknown[]) => { erros.push(a.map(String).join(" ")); };
    let r: Awaited<ReturnType<typeof aplicarComCompensacao>>;
    try {
      const banco = bancoDeConexoes({ a_rec: MONAMOR, b_rec: null, c_rec: MONAMOR }, [2], true);
      r = await aplicarComCompensacao(gravacoes, anteriores, banco.portas);
    } finally { console.error = original; }
    ok("F4  compensacao falha -> 'inconsistente' explicito", !r.ok && r.codigo === "inconsistente");
    ok("F5  e registro tecnico sem ids de loja/dono",
      erros.length === 1 && !erros[0].includes(MONAMOR) && !erros[0].includes(OUTRA), JSON.stringify(erros));
    const rt = semComentarios(ler("app/api/agentes/[agenteId]/apis/route.ts"));
    ok("F6  rota: inconsistente vira erro 500 com codigo, nunca ok",
      /case "inconsistente":[\s\S]*?codigo: "inconsistente"[\s\S]*?500/.test(rt));
    const sv = semComentarios(ler("lib/agentes/apis/servico.ts"));
    ok("F7  servico: PATCH usa a aplicacao com compensacao e o estado anterior real",
      /aplicarComCompensacao\(plano\.gravacoes, anteriores/.test(sv) && /r\.lojaIdSelecionada/.test(sv));
  }

  // ═══════════════════════════════════════════════════════════════════
  secao("G. Loja de outro usuario: impossivel vincular");
  // ═══════════════════════════════════════════════════════════════════
  {
    const r = planejarContaDoProvedor({ provedorId: "mercado_livre", lojaId: ALHEIA,
      requisitos: [req("vendas", null)], elegiveis: [conta(MONAMOR, "Monamor")] });
    ok("G1  loja fora das elegiveis do dono: recusada antes de escrever", !r.ok && r.codigo === "conta_indisponivel");
    ok("G2  heranca nunca usa loja fora das elegiveis (D9)", true);
  }

  // ═══════════════════════════════════════════════════════════════════
  secao("H. Shopee: 0 capabilities -> 'Ainda não disponível para agentes'");
  // ═══════════════════════════════════════════════════════════════════
  {
    const proj = projetarApisDoAgente({ permissoes: [], requisitos: [], contasPorProvedor: {
      shopee: [conta("33333333-3333-4333-8333-333333333333", "Loja Shopee")] } });
    const sh = proj.find((p) => p.id === "shopee");
    ok("H1  status 'Ainda não disponível para agentes'", sh?.textoDeStatus === "Ainda não disponível para agentes");
    ok("H2  plano da tela: indisponivel (sem seletor utilizavel)",
      planoDaApi({ disponivelParaAgentes: false, conexoes: sh?.conexoes ?? [], contaDoAgente: { estado: "nenhuma" } }).tipo === "indisponivel");
    ok("H3  sem pack de agente na tela (o seletor so existe com pack)",
      INTEGRACOES_CDS.find((i) => i.chave === "shopee")?.packId === null);
    ok("H4  PATCH /apis para Shopee recusado",
      (() => { const r = planejarContaDoProvedor({ provedorId: "shopee", lojaId: "33333333-3333-4333-8333-333333333333",
        requisitos: [], elegiveis: [] }); return !r.ok && r.codigo === "provedor_indisponivel_para_agentes"; })());
  }

  // ═══════════════════════════════════════════════════════════════════
  secao("I/J/K. Tools x APIs e alias");
  // ═══════════════════════════════════════════════════════════════════
  for (const t of ["planilhas", "calculadora", "calendario", "vendas"]) ok(`I   '${t}' continua Tool`, ehTool(t));
  ok("J   Mercado Livre nao e Tool", !ehTool("mercadolivre-perguntas") && !ehTool("mercado_livre"));
  ok("K   alias mercadolivre-perguntas -> provider Mercado Livre",
    provedorDoPackLegado("mercadolivre-perguntas")?.id === "mercado_livre" &&
      INTEGRACOES_CDS.find((i) => i.chave === "mercado_livre")?.packId === "mercadolivre-perguntas");
  {
    const etapa = ler("components/ia/criar/EtapaApis.tsx");
    ok("K2  '+ Adicionar API' preservado como acao (sem 'Pesquisar API')",
      /Adicionar API/.test(etapa) && !/Pesquisar API/.test(etapa));
  }

  // ═══════════════════════════════════════════════════════════════════
  secao("L/M. Nenhum write externo, nenhuma migration");
  // ═══════════════════════════════════════════════════════════════════
  ok("L1  toda capability segue de leitura", CAPACIDADES_DE_API.every((c) => c.efeito === "leitura"));
  ok("L2  a heranca e o PATCH so escrevem agente_conexoes (portas existentes)",
    (() => { const sv = semComentarios(ler("lib/agentes/apis/servico.ts"));
      return !/\.from\(|fetch\(|executarFuncao/.test(sv) && /definirSelecaoDeLoja\(/.test(sv); })());
  ok("L3  a aplicacao nao tem I/O proprio", !/fetch\(|getSupabase|\.from\(/.test(semComentarios(ler("lib/agentes/apis/aplicacao.ts"))));
  {
    const mudadas = execFileSync("git", ["diff", "--name-only", "3e2de493d10193b62a26e2572b5c82124d79fa09", "--", "supabase"],
      { cwd: RAIZ, encoding: "utf8" }).trim();
    const novas = execFileSync("git", ["ls-files", "--others", "--exclude-standard", "--", "supabase"],
      { cwd: RAIZ, encoding: "utf8" }).trim();
    ok("M1  nenhuma migration nova ou alterada", mudadas === "" && novas === "", `${mudadas} ${novas}`);
  }

  console.log(`\n── placar ${"─".repeat(54)}`);
  console.log(`  PASS ${passou}   FAIL ${falhou}`);
}

void main().then(
  () => process.exit(falhou > 0 ? 1 : 0),
  (e) => { console.error("ERRO NAO TRATADO:", e); process.exit(1); }
);
