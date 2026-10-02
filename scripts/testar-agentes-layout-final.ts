/**
 * CDS IA — F8.3-C1.4: layout final de Agentes (v0 aprovado).
 *
 * Prova: UMA selecao controla lista, seletor, chat e configuracao; o chat
 * e o ChatDoAgente REAL num host fino (sem runtime novo) e nao vaza
 * conversa entre agentes; nada de Criar/Testar/Limpar inventados; icones
 * por registry estavel; Office intocado.
 *
 * Rodar: npx tsx scripts/testar-agentes-layout-final.ts
 */
import "./_env-inerte";
import "./_server-only-inerte";

import { readFileSync } from "node:fs";
import { join } from "node:path";

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

const GESTAO = semComentario(ler("components/ia/agentes/GestaoDeAgentes.tsx"));
const CARTAO = semComentario(ler("components/ia/agentes/CartaoDeAgente.tsx"));
const SELETOR = semComentario(ler("components/ia/agentes/SeletorDeAgentes.tsx"));
const CHAT = semComentario(ler("components/ia/agentes/ChatNaGestao.tsx"));
const CONFIG = semComentario(ler("components/ia/agentes/ConfiguracaoDoAgente.tsx"));
const ICONE = semComentario(ler("components/ia/agentes/IconeDoAgente.tsx"));
const CSS = ler("components/ia/agentes/agentes.module.css");
const TODOS = GESTAO + CARTAO + SELETOR + CHAT + CONFIG + ICONE;

const A = "aaaaaaaa-0000-4000-8000-000000000001";
const B = "bbbbbbbb-0000-4000-8000-000000000002";

async function main(): Promise<void> {
  console.log("\n══ CDS IA — F8.3-C1.4: layout final de Agentes ══");
  const { resolverSelecao } = await import("@/components/ia/agentes/GestaoDeAgentes");
  const { identidadeDoAgente } = await import("@/components/ia/agentes/IconeDoAgente");

  // =====================================================================
  secao("A. Uma selecao controla as 4 areas");
  ok("A1  um unico estado de selecao na pagina", (GESTAO.match(/useState<string \| null>\(null\)/g) ?? []).length === 1);
  ok("A2  nenhum filho guarda selecao propria",
    !/useState/.test(SELETOR) && !/selecionad\w*\] = useState/.test(CARTAO + CONFIG + CHAT));
  ok("A3  selecionar pela ESQUERDA escreve na selecao", /aoConfigurar=\{\(\) => selecionar\(v\.agente\.id\)\}/.test(GESTAO));
  ok("A4  selecionar pelo TOPO escreve na MESMA selecao", /<SeletorDeAgentes[\s\S]{0,120}selecionado=\{selecionado\}[\s\S]{0,40}aoSelecionar=\{selecionar\}/.test(GESTAO));
  ok("A5  card e seletor marcam o mesmo id", /selecionado=\{v\.agente\.id === selecionado\}/.test(GESTAO) && /agente\.id === selecionado/.test(SELETOR));
  ok("A6  chat recebe o agente selecionado", /<ChatNaGestao[\s\S]{0,80}agenteId=\{aberto\.agente\.id\}/.test(GESTAO));
  ok("A7  configuracao recebe o agente selecionado", /<ConfiguracaoDoAgente[\s\S]{0,80}agente=\{aberto\.agente\}/.test(GESTAO));
  ok("A8  selecionado vem de um find por id", /comAparencia\.find\(\(a\) => a\.agente\.id === selecionado\)/.test(GESTAO));
  ok("A9  inicial: ?agente= valido", resolverSelecao([A, B], null, B) === B);
  ok("A10 inicial: ?agente= invalido cai no primeiro", resolverSelecao([A, B], null, "x") === A);
  ok("A11 selecionado que sumiu cai no primeiro", resolverSelecao([A], B, null) === A);
  ok("A12 selecao valida se mantem no refresh", resolverSelecao([A, B], B, null) === B);

  // =====================================================================
  secao("B. Chat REAL, sem runtime novo, sem vazamento");
  ok("B1  usa o ChatDoAgente real", /import \{ ChatDoAgente \} from "@\/components\/ia\/factory\/ChatDoAgente"/.test(CHAT));
  ok("B2  nenhum envio/polling/parser proprio no host",
    !/fetch\(|enviarNaConversaDoChat|lerConversaDoChat|setInterval|setTimeout|TextoDoAgente/.test(CHAT));
  ok("B3  semantica de Nova conversa = Workspace/Office",
    /setConversa\(null\);\s*setAbrirNova\(true\);\s*setGeracao\(\(g\) => g \+ 1\);/.test(CHAT));
  ok("B4  chat remonta por geracao", /key=\{`\$\{agenteId\}:\$\{geracao\}`\}/.test(CHAT));
  ok("B5  host remonta por AGENTE (conversa nao vaza)", /<ChatNaGestao\s+key=\{`chat:\$\{aberto\.agente\.id\}`\}/.test(GESTAO));
  ok("B6  aoTrocarConversa estavel (useCallback) e host memo", /useCallback\(\(id: string\)/.test(CHAT) && /export default memo\(ChatNaGestao\)/.test(CHAT));
  ok("B7  agente inativo nao monta chat", /\{ativo \? \(/.test(CHAT));
  ok("B8  sem 'Limpar conversa' (nao ha contrato de cliente)", !/Limpar conversa|arquivar/i.test(CHAT));
  ok("B9  chat com altura propria (scroll interno do ChatDoAgente)", /height: clamp\(480px, 50vh, 560px\)/.test(CSS));

  // =====================================================================
  secao("C. O que NAO pode aparecer");
  ok("C1  sem botao de criar agente na pagina", !/Criar agente|CriarAgente|setCriando|\/ia\/agentes\/novo/.test(TODOS));
  ok("C2  sem 'Testar agente'", !/Testar agente|modoTeste/.test(TODOS));
  ok("C3  sem mock do v0", !/MANAGED_AGENTS|mock-data|GPT-5|Claude Sonnet|Gemini 2|SEED|10:24|R\$ 1\.428/.test(TODOS));
  ok("C4  Abrir no Escritorio continua (menu do card e da configuracao)",
    /href=\{`\/ia\?agente=\$\{agente\.id\}`\}/.test(CARTAO) && /<MenuDoAgente agente=\{agente\} alinhar="abaixo" \/>/.test(CONFIG));

  // =====================================================================
  secao("D. Configuracao: contratos preservados");
  ok("D1  Funcao so leitura", /readOnly aria-readonly="true"/.test(CONFIG));
  ok("D2  contador real (sem limite inventado)", /\{instrucoes\.length\} caracteres/.test(CONFIG) && !/4000/.test(CONFIG));
  ok("D3  resumo do Geral usa a projecao real (ML em APIs, Tools internas)",
    /cap\.packsDeApi\.map/.test(CONFIG) && /cap\.tools\.map/.test(CONFIG));
  ok("D4  seis abas", /\["Geral", "Modelo de IA", "APIs", "Tools", "Memória", "Status"\]/.test(CONFIG));

  // =====================================================================
  secao("E. Icones dos agentes (registry estavel)");
  ok("E1  atendimento = headset azul", identidadeDoAgente("mensagens", false).chave === "atendimento");
  ok("E2  financeiro = carteira", identidadeDoAgente("financeiro", false).chave === "financeiro");
  ok("E3  marketing (ads) = megafone", identidadeDoAgente("ads", false).chave === "marketing");
  ok("E4  agente com ML em APIs = identidade do ML", identidadeDoAgente("personalizado", true).chave === "mercado-livre" &&
    identidadeDoAgente("personalizado", true).fundo === "#ffe600");
  ok("E5  estavel: mesma entrada, mesma identidade",
    identidadeDoAgente("fotos", false) === identidadeDoAgente("fotos", false));
  ok("E6  fallback generico (nunca letra)", identidadeDoAgente("personalizado", false).chave === "agente" &&
    // A marca do PROVEDOR (Modelo de IA) pode ser letra, como no v0; o AGENTE nao.
    !/agente\.nome\.charAt\(0\)/.test(CARTAO + SELETOR + CONFIG));

  // =====================================================================
  secao("F. Layout / scroll");
  ok("F1  lista 320px, 400px a partir de 1280 (v0)",
    /grid-template-columns: 320px minmax\(0, 1fr\)/.test(CSS) && /grid-template-columns: 400px minmax\(0, 1fr\)/.test(CSS));
  ok("F2  lista com scroll PROPRIO e presa na tela",
    /\.colunaLista \{[\s\S]*?position: sticky;[\s\S]*?max-height: calc\(100dvh - 32px\)/.test(CSS) &&
      /\.listaAgentes \{[\s\S]*?overflow-y: auto;/.test(CSS));
  ok("F3  seletor em UMA linha com scroll horizontal proprio",
    /\.seletorLista \{[\s\S]*?display: flex;[\s\S]*?overflow-x: auto;/.test(CSS) && /\.seletorLista > li \{\s*flex-shrink: 0;/.test(CSS));
  ok("F4  abaixo de 1200px: uma coluna, lista com scroll proprio",
    /@media \(max-width: 1199px\) \{[\s\S]*?grid-template-columns: minmax\(0, 1fr\);[\s\S]*?max-height: 420px;/.test(CSS));

  // =====================================================================
  secao("G. Office intocado");
  const OFFICE = ["components/ia/office/Escritorio.tsx", "components/ia/office/OfficeSceneV1.tsx",
    "components/ia/office/OfficeAgentPanelV1.tsx", "components/ia/office/OfficeChatHost.tsx",
    "components/ia/office/VendasAoVivo.tsx"];
  ok("G1  Office nao importa a area Agentes", OFFICE.every((f) => !/components\/ia\/agentes\//.test(ler(f))));
  ok("G2  a area Agentes nao importa componentes do Office", !/components\/ia\/office\//.test(TODOS));

  console.log(`\n── placar ${"─".repeat(50)}\n  PASS ${passou}   FAIL ${falhou}\n`);
  if (falhou > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
