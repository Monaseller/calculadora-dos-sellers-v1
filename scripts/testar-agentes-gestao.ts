/**
 * CDS IA — F8.3-C1: pagina Agentes + configuracao de agente.
 *
 * Prova: dados reais (sem mock do v0), status pela regra canonica,
 * filtros, Funcao so leitura, Modelo de IA do catalogo real, Mercado
 * Livre apresentado em APIs e NAO repetido em Tools (sem refatorar o
 * dominio), Tools por contrato real, memoria real, e Office intocado.
 *
 * Rodar: npx tsx scripts/testar-agentes-gestao.ts
 */
import "./_server-only-inerte";

import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  CHAVES_DE_FILTRO_DA_LISTA, INTEGRACOES_CDS, PACK_API_MERCADO_LIVRE, ehPackDeApi, filtrarTools, nomeDoTipo, passaNaBusca,
  passaNoFiltro, projetarCapacidades, resumoDaIa,
} from "@/lib/ia/agentes-gestao";
import { TOOL_PACKS } from "@/lib/agentes/factory/catalogo-ui";
import type { AparenciaAgente } from "@/lib/ia/estados";

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

const ap = (estado: AparenciaAgente["estado"], fora = false): AparenciaAgente =>
  ({ estado, foraDeOperacao: fora });

const GESTAO = semComentario(ler("components/ia/agentes/GestaoDeAgentes.tsx"));
const CARTAO = semComentario(ler("components/ia/agentes/CartaoDeAgente.tsx"));
const CONFIG = semComentario(ler("components/ia/agentes/ConfiguracaoDoAgente.tsx"));
// F8.3-C1.6: a aba APIs mora no proprio componente.
const APIS = semComentario(ler("components/ia/agentes/ApisDoAgente.tsx"));
const PAGINA = semComentario(ler("app/(app)/ia/agentes/page.tsx"));
const TODOS = GESTAO + CARTAO + CONFIG + PAGINA;

function main(): void {
  console.log("\n══ CDS IA — F8.3-C1: Agentes + configuração ══");

  // =====================================================================
  secao("A. Lista usa agentes reais, sem mock do v0");
  ok("A1  a rota renderiza a gestao nova", /<GestaoDeAgentes \/>/.test(PAGINA));
  ok("A2  agentes vem de listarAgentesDoEscritorio (mesma leitura do Office)",
    /listarAgentesDoEscritorio\(controlador\.signal\)/.test(GESTAO));
  ok("A3  IA/APIs/Tools/memoria vem de lerAtivacaoDoAgente por agente",
    /lerAtivacaoDoAgente\(agente\.id, controlador\.signal\)/.test(GESTAO));
  ok("A3b sair da pagina cancela as leituras", /controladorRef\.current\?\.abort\(\)/.test(GESTAO));
  ok("A4  nenhum dado mock do v0 (agentes, provedores, contas)",
    !/MANAGED_AGENTS|mock-data|GPT-5|Claude Sonnet|Gemini 2|API_CATALOG|PROVIDERS\b|Loja Principal/i.test(TODOS));
  ok("A5  nenhuma quantidade escrita a mao (\"3 APIs\"); contagens vem da projecao",
    !/\d+\s+(APIs?|Tools?)/.test(ler("components/ia/agentes/CartaoDeAgente.tsx")) &&
      /plural\(cap\.totalApis/.test(CARTAO) && /plural\(cap\.tools\.length/.test(CARTAO));
  ok("A6  sem botao 'Criar agente' dentro da pagina Agentes",
    !/Criar agente|CriarAgente|setCriando/.test(GESTAO + PAGINA));
  ok("A7  falha de ativacao fica no card (sem numero inventado)",
    /IA indisponível para leitura/.test(CARTAO) && /ativacaoFalhou/.test(CARTAO));

  // =====================================================================
  secao("B. Status pela regra canonica");
  ok("B1  aparenciaDoAgente sobre os sinais reais", /aparenciaDoAgente\(item\.agente, item\.sinais, agoraMs\)/.test(GESTAO));
  ok("B2  rotulo/icone/cor do status sao os canonicos",
    /rotuloDe\(aparencia\)/.test(CARTAO) && /iconeDe\(aparencia\)/.test(CARTAO) && /corDaAparencia\(aparencia\)/.test(CARTAO));
  ok("B3  nenhuma segunda regra (sem derivar status por conta propria)",
    !/derivarStatusAgente|"idle"|"ocupado"|status ===/.test(TODOS));

  // =====================================================================
  secao("C. Filtros e busca");
  ok("C1  quatro filtros, na ordem do v0", JSON.stringify(CHAVES_DE_FILTRO_DA_LISTA) === JSON.stringify(["todos", "ativos", "atencao", "inativos"]));
  ok("C2  todos: tudo", passaNoFiltro("todos", ap("ocioso", true)) && passaNoFiltro("todos", ap("erro")));
  ok("C3  ativos: ligados, qualquer estado", passaNoFiltro("ativos", ap("trabalhando")) && !passaNoFiltro("ativos", ap("ocioso", true)));
  ok("C4  com atencao: aprovacao pendente ou erro, so ligados",
    passaNoFiltro("atencao", ap("aguardando_aprovacao")) && passaNoFiltro("atencao", ap("erro")) &&
      !passaNoFiltro("atencao", ap("ocioso")) && !passaNoFiltro("atencao", ap("erro", true)));
  ok("C5  inativos: fora de operacao", passaNoFiltro("inativos", ap("ocioso", true)) && !passaNoFiltro("inativos", ap("ocioso")));
  ok("C6  busca por nome e funcao, sem acento/caixa",
    passaNaBusca("vendas", "VENDAS MERCADO LIVRE", "personalizado") &&
      passaNaBusca("anuncio", "X", "anuncios") && !passaNaBusca("zzz", "Agente", "personalizado"));

  // =====================================================================
  secao("D. Configurar abre o agente certo");
  ok("D1  selecao por id (nunca por nome)", /a\.agente\.id === selecionado/.test(GESTAO));
  // F8.3-C1.4: a key ganhou prefixo (chat e configuracao remontam juntos).
  ok("D2  configuracao remonta por agente (key)", /<ConfiguracaoDoAgente\s+key=\{`cfg:\$\{aberto\.agente\.id\}`\}/.test(GESTAO));
  ok("D3  link direto ?agente= lido e gravado", /get\("agente"\)/.test(GESTAO) && /searchParams\.set\("agente", id\)/.test(GESTAO));
  // F8.3-C1.4: o master-detail com "Voltar/Fechar" virou o layout final do
  // v0 (lista + seletor + chat + configuracao), sempre com um selecionado.
  ok("D4  sempre ha um agente selecionado (o pedido ou o primeiro)", /resolverSelecao\(/.test(GESTAO));

  // =====================================================================
  secao("E. Geral: Funcao so leitura");
  ok("E1  Funcao readOnly com aviso", /readOnly aria-readonly="true"/.test(CONFIG) && /Não editável por enquanto/.test(ler("components/ia/agentes/ConfiguracaoDoAgente.tsx")));
  ok("E2  salvar envia SO nome e instrucoes (o PATCH real)",
    /atualizarAgenteViaApi\(agente\.id, \{ nome: nome\.trim\(\), instrucoes \}\)/.test(CONFIG) && !/tipo:/.test(CONFIG));
  ok("E3  nome do tipo e rotulo real do CHECK", nomeDoTipo("anuncios") === "Anúncios" && nomeDoTipo("personalizado") === "Personalizado");

  // =====================================================================
  secao("F. Modelo de IA real");
  ok("F1  provedores do catalogo do servidor (ativacao.modelos)", /ativacao\.modelos\.map/.test(CONFIG));
  ok("F2  escolha por definirIaDoAgente, sem modelId", /definirIaDoAgente\(agente\.id, \{/.test(CONFIG) && !/modeloId:/.test(CONFIG));
  ok("F3  modelo e exibido (do ambiente), nao escolhido", /m\.modeloId/.test(CONFIG) && /definido pelo ambiente/.test(ler("components/ia/agentes/ConfiguracaoDoAgente.tsx")));
  ok("F4  nivel so quando o provedor tem mais de um", /alvo\.niveis\.length <= 1/.test(CONFIG));
  const r = resumoDaIa({ provedor: "openai", modelo: "gpt-x", iaDesfecho: "escolhida",
    modelos: [{ provedor: "openai", nome: "OpenAI", descricao: "", modeloId: "gpt-x", ferramentas: true, niveis: [] }] });
  ok("F5  resumo da IA usa o nome do catalogo e o id real", r.provedor === "OpenAI" && r.modelo === "gpt-x" && !r.indisponivel);

  // =====================================================================
  secao("G. Mercado Livre em APIs, nao em Tools (so visual)");
  const pack = (id: string) => ({ id, nome: id, completo: true, nivel: "automatico", faltando: 0 });
  const ext = (toolkit: string, funcaoId: string) => ({ funcaoId, toolkit, acao: "X", nivel: null, risco: "leitura", nivelSugerido: null });
  const p = projetarCapacidades({
    ferramentas: [pack(PACK_API_MERCADO_LIVRE), pack("planilhas"), pack("calculadora")],
    ferramentasExternas: [ext("gmail", "a"), ext("gmail", "b"), ext("sheets", "c")],
  });
  ok("G1  ML vai para APIs", p.packsDeApi.length === 1 && p.packsDeApi[0].id === PACK_API_MERCADO_LIVRE);
  ok("G2  ML NAO aparece em Tools", !p.tools.some((t) => t.id === PACK_API_MERCADO_LIVRE) && p.tools.length === 2);
  ok("G3  total de APIs = ML + toolkits externos DISTINTOS", p.totalApis === 3);
  // F8.3-C1.6: a lista de Tools passa por `filtrarTools`, que exclui os packs de API.
  ok("G4  a lista de 'adicionar Tool' exclui packs de API",
    /filtrarTools\(termoTool, TOOL_PACKS\)/.test(CONFIG) &&
      !filtrarTools("", TOOL_PACKS).some((p) => ehPackDeApi(p.id)));
  ok("G5  DOMINIO intocado: ML continua em TOOL_PACKS", TOOL_PACKS.some((t) => t.id === PACK_API_MERCADO_LIVRE));
  ok("G6  so o ML e projetado como API", ehPackDeApi(PACK_API_MERCADO_LIVRE) && !ehPackDeApi("planilhas"));
  // F8.3-C1.6: a loja e escolhida pelos MESMOS contratos do ConexoesAgente, na aba APIs.
  ok("G7  loja pelos contratos reais de conexao do agente",
    /buscarConexoesDoAgente\(agenteId, c\.signal\)/.test(APIS) && /definirConexaoDoAgente\(agenteId, /.test(APIS));
  ok("G8  Shopee aparece como API, mas nao como funcional para agentes",
    INTEGRACOES_CDS.find((i) => i.chave === "shopee")?.packId === null &&
      /Ainda não disponível para agentes/.test(ler("components/ia/agentes/ApisDoAgente.tsx")));

  // =====================================================================
  secao("H. Tools e memoria por contrato real");
  ok("H1  adicionar/remover/nivel pelos contratos compartilhados",
    /adicionarPackAoAgente\(agente\.id, f\.id, n\)/.test(CONFIG) &&
      /removerPackDoAgente\(agente\.id, f\.id\)/.test(CONFIG) &&
      /adicionarPackAoAgente\(agente\.id, p\.id, null\)/.test(CONFIG));
  ok("H2  acao externa: nivel e remocao pelos contratos dela",
    /definirPermissaoDeFerramentaExterna\(agenteId, e\.funcaoId, n\)/.test(APIS) &&
      /desvincularFerramentaExterna\(agenteId, e\.funcaoId\)/.test(APIS));
  ok("H3  memoria: liga/desliga real e estado do motor",
    /definirMemoriaDoAgente\(agente\.id, v\)/.test(CONFIG) && /lerMemoriaDoAgente\(agente\.id, null\)/.test(CONFIG) &&
      /motorConfigurado/.test(CONFIG));
  ok("H4  status: ativar/desativar pelo contrato validado no servidor",
    /definirAtivacaoDoAgente\(agente\.id, v\)/.test(CONFIG) && /ativacao\.impedimentos\.map/.test(CONFIG));

  // =====================================================================
  secao("I. Office nao foi tocado por este gate");
  const OFFICE = ["components/ia/office/Escritorio.tsx", "components/ia/office/OfficeSceneV1.tsx",
    "components/ia/office/OfficeAgentPanelV1.tsx", "components/ia/office/VendasAoVivo.tsx",
    "components/ia/office/OfficeChatHost.tsx"];
  ok("I1  nenhum componente do Office importa a area Agentes",
    OFFICE.every((f) => !/components\/ia\/agentes\//.test(ler(f))));
  ok("I2  a area Agentes nao importa componentes do Office", !/components\/ia\/office\//.test(TODOS));

  console.log(`\n── placar ${"─".repeat(50)}\n  PASS ${passou}   FAIL ${falhou}\n`);
  if (falhou > 0) process.exit(1);
}

main();
