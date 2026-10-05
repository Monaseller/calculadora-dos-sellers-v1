/**
 * CDS IA — F8.3-C1.6: APIs = integracoes da CDS, Tools com busca, regra
 * visual laranja e o corte da mensagem no chat.
 *
 * Rodar: npx tsx scripts/testar-agentes-apis-tools.ts
 */
import "./_env-inerte";
import "./_server-only-inerte";

import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  INTEGRACOES_CDS, PACK_API_MERCADO_LIVRE, contasDaIntegracao, filtrarTools, nomeDaConta, planoDeConexao,
} from "@/lib/ia/agentes-gestao";
import { TOOL_PACKS } from "@/lib/agentes/factory/catalogo-ui";
import type { ConexaoRequisitoUI } from "@/lib/ia/agentes-http";

let passou = 0;
let falhou = 0;
const ok = (nome: string, cond: boolean, det = ""): void => {
  if (cond) { passou += 1; console.log(`  PASS  ${nome}`); }
  else { falhou += 1; console.log(`  FAIL  ${nome}${det ? `  — ${det}` : ""}`); }
};
const secao = (t: string) =>
  console.log(`\n── ${t} ${"─".repeat(Math.max(2, 58 - t.length))}`);
const ler = (rel: string) => readFileSync(join(__dirname, "..", rel), "utf8").replace(/\r\n/g, "\n");
const semComentario = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

const APIS = semComentario(ler("components/ia/agentes/ApisDoAgente.tsx"));
const CONFIG = semComentario(ler("components/ia/agentes/ConfiguracaoDoAgente.tsx"));
const CSS = ler("components/ia/agentes/agentes.module.css");
const CSS_SEM_COMENTARIO = CSS.replace(/\/\*[\s\S]*?\*\//g, "");

const req = (p: Partial<ConexaoRequisitoUI>): ConexaoRequisitoUI => ({
  plataforma: "mercado_livre", recurso: "perguntas", obrigatoria: true, marketplace: "ML",
  lojaIdSelecionada: null, utilizavel: false, lojasElegiveis: [], ...p,
});
const L1 = { id: "l1", nome: "LOJA TESTE", nickname: "LOJA TESTE" };
const L2 = { id: "l2", nome: "Outlet", nickname: null };

async function main(): Promise<void> {
  console.log("\n══ CDS IA — F8.3-C1.6: APIs, Tools, visual e chat ══");

  // =====================================================================
  secao("A. Conectar: plano (automatico so quando nao ha escolha)");
  ok("A1  sem requisito da plataforma -> nada a fazer", planoDeConexao([], "mercado_livre").tipo === "sem_requisito");
  ok("A2  conta escolhida e utilizavel -> pronta",
    planoDeConexao([req({ lojaIdSelecionada: "l1", utilizavel: true, lojasElegiveis: [L1] })], "mercado_livre").tipo === "pronta");
  const auto = planoDeConexao([req({ lojasElegiveis: [L1] })], "mercado_livre");
  ok("A3  UMA conta elegivel e nada escolhido -> automatico com ela",
    auto.tipo === "auto" && auto.gravar.length === 1 && auto.gravar[0].lojaId === "l1" &&
      auto.gravar[0].plataforma === "mercado_livre" && auto.gravar[0].recurso === "perguntas", JSON.stringify(auto));
  ok("A4  mais de uma conta -> o dono escolhe", planoDeConexao([req({ lojasElegiveis: [L1, L2] })], "mercado_livre").tipo === "escolher");
  ok("A5  nenhuma conta elegivel -> fluxo de conexao da CDS",
    planoDeConexao([req({ lojasElegiveis: [] })], "mercado_livre").tipo === "conectar_conta");
  ok("A6  escolha existente que NAO serve nunca e trocada sozinha",
    planoDeConexao([req({ lojaIdSelecionada: "x", utilizavel: false, lojasElegiveis: [L1] })], "mercado_livre").tipo === "escolher");
  ok("A7  outra plataforma nao interfere",
    planoDeConexao([req({ plataforma: "shopee", lojasElegiveis: [] })], "mercado_livre").tipo === "sem_requisito");
  const dois = planoDeConexao([req({ lojasElegiveis: [L1] }), req({ recurso: "vendas", lojasElegiveis: [L1] })], "mercado_livre");
  ok("A8  dois requisitos com uma conta cada -> grava os dois", dois.tipo === "auto" && dois.gravar.length === 2);
  // F9.2-A2: o plano agora e do PROVIDER — um PATCH /apis e UMA releitura.
  ok("A9  aplica o plano: UM PATCH do provider e UMA releitura de validacao",
    /gravarContaDaApi\(integracao\.chave, plano\.lojaId\)/.test(APIS) &&
      /const depois = \(await recarregar\(\)\)\?\.find/.test(APIS) &&
      !/definirConexaoDoAgente/.test(APIS));
  ok("A10 nenhuma chamada ao marketplace / rede propria no componente", !/fetch\(|window\.open|["'`]\/api\//.test(APIS));
  ok("A11 conectar conta: o fluxo da CDS em ABA NOVA (a pagina nao se perde)",
    /href=\{ENDERECO_PARA_CONECTAR_CONTA\[i\.marketplace\]\} target="_blank" rel="noopener noreferrer"/.test(APIS) &&
      /Já conectei — conferir/.test(APIS));

  // =====================================================================
  secao("B. Integracoes da CDS (nao busca generica)");
  ok("B1  Mercado Livre e Shopee, nessa ordem", INTEGRACOES_CDS.map((i) => i.chave).join(",") === "mercado_livre,shopee");
  ok("B2  ML usa o pack real de agente", INTEGRACOES_CDS[0].packId === PACK_API_MERCADO_LIVRE);
  ok("B3  Shopee: integracao/API, sem pack de agente (sem fingir capacidade)",
    INTEGRACOES_CDS[1].packId === null && /Ainda não disponível para agentes/.test(APIS));
  const CONFIGURACOES = ler("app/(app)/configuracoes/page.tsx");
  ok("B4  marketplace das contas = o que Configuracoes usa (ML / Shopee)",
    /marketplace === "ML"/.test(CONFIGURACOES) && /marketplace === "Shopee"/.test(CONFIGURACOES) &&
      INTEGRACOES_CDS[0].marketplace === "ML" && INTEGRACOES_CDS[1].marketplace === "Shopee");
  const lojas = [{ id: "a", nome: "LOJA TESTE", nickname: null, marketplace: "ML" }, { id: "b", nome: "S", nickname: null, marketplace: "Shopee" }];
  ok("B5  contas por integracao", contasDaIntegracao(INTEGRACOES_CDS[0], lojas).map((l) => l.id).join() === "a" &&
    contasDaIntegracao(INTEGRACOES_CDS[1], lojas).map((l) => l.id).join() === "b");
  ok("B6  nome de conta: apelido > nome > fallback (nunca id)",
    nomeDaConta({ nome: "N", nickname: "APELIDO" }) === "APELIDO" && nomeDaConta({ nome: "N", nickname: null }) === "N" &&
      nomeDaConta({ nome: " ", nickname: null }) === "Conta sem nome");
  ok("B7  selo 'API' em cada integracao", (APIS.match(/estilos\.seloApi/g) ?? []).length >= 2);

  // =====================================================================
  secao("C. Transporte: contas do dono e fluxo de conexao");
  const http = await import("@/lib/ia/agentes-http");
  const original = globalThis.fetch;
  let pedido = "";
  const responder = (status: number, corpo: unknown) => {
    globalThis.fetch = (async (url: string) => { pedido = String(url);
      return new Response(JSON.stringify(corpo), { status, headers: { "Content-Type": "application/json" } }); }) as typeof fetch;
  };
  try {
    responder(200, [{ id: "a", nome: "LOJA TESTE", marketplace: "ML", seller_id: "123", nickname: "CONTA TESTE", ativo: true, created_at: "x" }]);
    const r = await http.listarLojasDoDono();
    ok("C1  GET /api/lojas (a rota de Configuracoes)", pedido === "/api/lojas");
    ok("C2  so o que a tela usa — seller_id NAO passa",
      r.estado === "ok" && JSON.stringify(r.lojas) === JSON.stringify([{ id: "a", nome: "LOJA TESTE", nickname: "CONTA TESTE", marketplace: "ML" }]),
      JSON.stringify(r));
    responder(200, []);
    const vazio = await http.listarLojasDoDono();
    ok("C3  zero contas e legitimo", vazio.estado === "ok" && vazio.lojas.length === 0);
    responder(401, { erro: "x" });
    ok("C4  401 -> nao_autenticado", (await http.listarLojasDoDono()).estado === "nao_autenticado");
    responder(503, { erro: "x" });
    ok("C5  falha de infra nao vira 'nenhuma conta'", (await http.listarLojasDoDono()).estado === "falha");
  } finally {
    globalThis.fetch = original;
  }
  ok("C6  endereco de conexao = o mesmo de Configuracoes",
    http.ENDERECO_PARA_CONECTAR_CONTA.ML === "/api/auth/mercadolivre" && http.ENDERECO_PARA_CONECTAR_CONTA.Shopee === "/api/auth/shopee" &&
      /href="\/api\/auth\/mercadolivre"/.test(CONFIGURACOES) && /href="\/api\/auth\/shopee"/.test(CONFIGURACOES));
  ok("C7  a rota /api/lojas nao projeta token", !/access_token|refresh_token/.test(
    ler("lib/marketplace/credenciais.ts").match(/export async function listarLojasAtivasDoDono[\s\S]*?\n\}/)?.[0] ?? "x"));

  // =====================================================================
  secao("D. Tools: busca + adicionadas + disponiveis");
  const internos = TOOL_PACKS.filter((p) => p.id !== PACK_API_MERCADO_LIVRE).map((p) => p.id).sort().join();
  ok("D1  sem termo: todas as internas, nenhum pack de API", filtrarTools("", TOOL_PACKS).map((p) => p.id).sort().join() === internos);
  ok("D2  sem acento e sem caixa", filtrarTools("CALENDARIO", TOOL_PACKS).map((p) => p.id).join() === "calendario");
  ok("D3  busca tambem na descricao", filtrarTools("excel", TOOL_PACKS).some((p) => p.id === "planilhas"));
  ok("D4  ML nunca aparece em Tools, nem buscando por ele", filtrarTools("mercado", TOOL_PACKS).every((p) => p.id !== PACK_API_MERCADO_LIVRE));
  ok("D5  campo de busca no topo da aba", /aria-label="Buscar tools"/.test(CONFIG));
  ok("D6  lista do agente e lista de disponiveis", /aria-label="Tools neste agente"/.test(CONFIG) && /aria-label="Tools disponíveis"/.test(CONFIG));
  ok("D7  adicionar e remover inline", /\+ Adicionar/.test(CONFIG) && /removerPackDoAgente\(agente\.id, f\.id\)/.test(CONFIG));

  // =====================================================================
  secao("E. Regra visual CDS (laranja; nada escuro em fundo escuro)");
  ok("E1  controles nativos no tema escuro", /\.raiz \{[\s\S]*?color-scheme: dark;/.test(CSS));
  ok("E2  foco de TODA a tela em laranja", /\.raiz :focus-visible \{\s*outline-color: var\(--ag-acento\);/.test(CSS));
  ok("E3  nenhum destaque de hover em cinza", !/border-color: rgb\(238 241 246 \/ 0\.2\)/.test(CSS_SEM_COMENTARIO));
  ok("E4  filtro e segmento selecionados em laranja",
    /\.filtroAtivo \{\s*background: var\(--ag-acento-suave\);\s*color: var\(--ag-acento\);/.test(CSS) &&
      /\.segmentoAtivo \{\s*background: var\(--ag-acento-suave\);\s*color: var\(--ag-acento\);/.test(CSS));
  ok("E5  select: opcoes em fundo escuro e texto claro", /\.selecao option \{\s*background: var\(--ag-card\);\s*color: var\(--ag-texto\);/.test(CSS));
  ok("E6  nome da conta na cor da CDS", /\.nomeConta \{\s*color: var\(--ag-acento\);/.test(CSS));
  ok("E7  nenhuma cor de texto escura na area", !/(^|[^-])color:\s*(#0|#1|#2|black|rgb\(0)/m.test(CSS_SEM_COMENTARIO));
  ok("E8  menu ⋯ visivel (padding do botao de icone nao e sobrescrito)",
    /\.botao\.botaoIcone \{\s*padding: 0;/.test(CSS) && /\.botaoIcone svg \{\s*flex-shrink: 0;/.test(CSS));

  // =====================================================================
  secao("F. Chat: mensagem nao e mais comida pela esquerda");
  ok("F1  trilha sem rolagem horizontal", /\.chatCorpo \[data-cds-chat-trilha\] \{\s*overflow-x: hidden;/.test(CSS));
  ok("F2  texto sem espaco quebra dentro da bolha", /\.chatCorpo \[data-cds-chat-trilha\] \{[^}]*overflow-wrap: break-word;/.test(CSS));
  ok("F3  janela recorta sem virar container rolavel", /\.chat \{[\s\S]*?overflow: hidden;\s*[\s\S]*?overflow: clip;/.test(CSS));
  const CHAT = ler("components/ia/factory/ChatDoAgente.tsx");
  ok("F4  correcao so no host: ChatDoAgente segue com a trilha de sempre",
    /<div data-cds-chat-trilha="" style=\{\{\s*flex: 1, overflowY: "auto"/.test(CHAT) && !/overflowX|overflowWrap/.test(CHAT));

  console.log(`\n── placar ${"─".repeat(50)}\n  PASS ${passou}   FAIL ${falhou}\n`);
  if (falhou > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
