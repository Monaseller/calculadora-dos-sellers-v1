/**
 * CDS IA — UI-1C.b. Suite das abas de configuracao do agente.
 *
 * Cobre Conexoes, Funcoes e Permissoes/Autonomia: o eixo unico de nivel,
 * a separacao entre os quatro conceitos, a ausencia de controle falso e
 * a ausencia de backend.
 *
 * Nao renderiza React: prova por LEITURA DE FONTE e por execucao das
 * funcoes puras. Toda varredura importante tem CONTROLE NEGATIVO — sonda
 * que nao acusa nada pode estar quebrada em vez de limpa, e nesta base
 * isso ja aconteceu tres vezes (regex BRE sob ERE; `select\s+from` que
 * nao pegava `select * from`; sonda de marketplace que buscava a palavra
 * em vez da integracao).
 *
 * Rodar:  npx tsx scripts/testar-ia-ui-1cb.ts
 * Sem rede, sem banco, sem IA.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { ABAS } from "../lib/ia/abas";
import {
  DIVIDA_CREDENCIAIS,
  ESTADOS_CONEXAO,
  NIVEIS_AUTONOMIA,
  PROCEDENCIA_ESTADO_CONEXAO,
  PROCEDENCIAS,
  RISCOS,
  ROTULO_ACESSO,
  VOCABULARIO_CONEXAO,
  VOCABULARIO_NIVEL,
  funcaoDisponivel,
  permitida,
} from "../lib/ia/conceitos";
import {
  MOCK_CONEXOES,
  MOCK_FUNCOES,
  MOCK_FUNCOES_DA_CONEXAO,
  MOCK_NIVEL_DA_FUNCAO,
  MOCK_PERMISSOES,
} from "../lib/ia/mocks";

let passou = 0;
let falhou = 0;

function ok(nome: string, condicao: boolean, detalhe = ""): void {
  if (condicao) {
    passou++;
    console.log(`  PASS  ${nome}`);
  } else {
    falhou++;
    console.log(`  FAIL  ${nome}${detalhe ? ` — ${detalhe}` : ""}`);
  }
}

function secao(titulo: string): void {
  console.log(`\n── ${titulo} ${"─".repeat(Math.max(0, 62 - titulo.length))}`);
}

const RAIZ = join(__dirname, "..");
const ler = (rel: string) => readFileSync(join(RAIZ, rel), "utf8");

function codigo(fonte: string): string {
  return fonte.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

function arquivosDe(dirRel: string): string[] {
  const saida: string[] = [];
  const caminhar = (rel: string) => {
    for (const nome of readdirSync(join(RAIZ, rel))) {
      const filho = `${rel}/${nome}`;
      if (statSync(join(RAIZ, filho)).isDirectory()) caminhar(filho);
      else saida.push(filho);
    }
  };
  caminhar(dirRel);
  return saida.sort();
}

/** A pasta de mocks, nome a nome — sem wildcard. */
const MOCKS_PASTA: readonly string[] = [
  "lib/ia/mocks/agentes.ts",
  "lib/ia/mocks/aprovacoes.ts",
  "lib/ia/mocks/capabilities.ts",
  "lib/ia/mocks/conexoes.ts",
  "lib/ia/mocks/index.ts",
  "lib/ia/mocks/tarefas.ts",
];

const NOVOS_1CB = [
  "components/ia/agente/AbaConexoes.tsx",
  "components/ia/agente/AbaFuncoes.tsx",
  "components/ia/agente/AbaPermissoes.tsx",
  "components/ia/conexoes/CardConexao.tsx",
  "components/ia/capabilities/CardFuncao.tsx",
  "components/ia/capabilities/SeletorAutonomia.tsx",
];

const ARQUIVOS_AREA: readonly string[] = [
  ...arquivosDe("lib/ia"),
  ...arquivosDe("components/ia"),
  ...arquivosDe("app/(app)/ia"),
];

const CONCEITOS = ler("lib/ia/conceitos.ts");
const SELETOR = ler("components/ia/capabilities/SeletorAutonomia.tsx");
const CARD_CX = ler("components/ia/conexoes/CardConexao.tsx");
const CARD_FN = ler("components/ia/capabilities/CardFuncao.tsx");
const AB_CX = ler("components/ia/agente/AbaConexoes.tsx");
const AB_FN = ler("components/ia/agente/AbaFuncoes.tsx");
const AB_PM = ler("components/ia/agente/AbaPermissoes.tsx");

// ═══════════════════════════════════════════════════════════════════════
console.log("\n══ CDS IA — UI-1C.b: conexoes, funcoes e permissoes ══");

secao("A. Inventario da fase");

{
  ok("A1  os 6 componentes novos existem",
    NOVOS_1CB.every((a) => ARQUIVOS_AREA.includes(a)),
    NOVOS_1CB.filter((a) => !ARQUIVOS_AREA.includes(a)).join(", "));
  ok("A2  todos exportam default",
    NOVOS_1CB.every((a) => /export default function/.test(ler(a))));
  ok("A3  nenhum arquivo novo fora das pastas previstas",
    ARQUIVOS_AREA.every((a) =>
      a.startsWith("lib/ia/") || a.startsWith("components/ia/") || a.startsWith("app/(app)/ia/")));
}

secao("B. Eixo unico de nivel (Decisao 1)");

{
  ok("B1  exatamente 3 niveis", NIVEIS_AUTONOMIA.length === 3);
  ok("B2  os 3 sao os canonicos",
    JSON.stringify([...NIVEIS_AUTONOMIA]) ===
    JSON.stringify(["bloqueado", "aprovacao", "automatico"]));

  // A duplicacao que a Decisao 1 eliminou.
  const c = codigo(CONCEITOS);
  ok("B3  PermissaoUI NAO tem campo `concedida`", !/\bconcedida\b/.test(c));
  ok("B4  PermissaoUI NAO tem campo `autonomia` paralelo", !/^\s*autonomia\s*:/m.test(c));
  ok("B5  PermissaoUI tem `nivel`", /interface PermissaoUI[\s\S]{0,220}nivel:\s*NivelAutonomia/.test(c));
  ok("B6  controle negativo: a sonda de `concedida` acha o campo antigo",
    /\bconcedida\b/.test("{ funcaoId: 'x', concedida: true }"));

  ok("B7  `permitida` e funcao derivada, nao campo",
    /export function permitida\(/.test(c));
  ok("B8  permitida(bloqueado) === false", permitida({ nivel: "bloqueado" }) === false);
  ok("B9  permitida(aprovacao) === true", permitida({ nivel: "aprovacao" }) === true);
  ok("B10 permitida(automatico) === true", permitida({ nivel: "automatico" }) === true);
  ok("B11 nenhum mock declara `concedida`",
    !/\bconcedida\b/.test(codigo(MOCKS_PASTA.map(ler).join("\n"))));
  ok("B12 toda permissao do mock tem nivel valido",
    MOCK_PERMISSOES.every((p) => (NIVEIS_AUTONOMIA as readonly string[]).includes(p.nivel)));
  ok("B13 nivel ausente cai no padrao SEGURO (bloqueado)",
    MOCK_NIVEL_DA_FUNCAO("funcao.que.nao.existe") === "bloqueado");
}

secao("C. Rotulo 'Exige aprovacao' (Decisao 2)");

{
  ok("C1  o rotulo do nivel `aprovacao` e 'Exige aprovação'",
    VOCABULARIO_NIVEL.aprovacao.rotulo === "Exige aprovação");
  ok("C2  'Com aprovação' NAO aparece em lugar nenhum da area",
    ARQUIVOS_AREA.every((a) => !/Com aprovação/.test(ler(a))));
  ok("C3  controle negativo: a sonda acharia o rotulo antigo",
    /Com aprovação/.test("rotulo: 'Com aprovação'"));
  ok("C4  cada nivel tem rotulo, explicacao e efeito",
    NIVEIS_AUTONOMIA.every((n) =>
      VOCABULARIO_NIVEL[n].rotulo.length > 0 &&
      VOCABULARIO_NIVEL[n].explicacao.length > 10 &&
      VOCABULARIO_NIVEL[n].efeito.length > 10));
  ok("C5  'automatico' NAO promete ausencia de limites",
    /idempot|valida|conex/i.test(VOCABULARIO_NIVEL.automatico.efeito));
  ok("C6  'bloqueado' diz que a ferramenta nao chega ao agente",
    /ferramenta|entregue/i.test(VOCABULARIO_NIVEL.bloqueado.efeito));
  ok("C7  'aprovacao' aponta para o fluxo unico",
    /aprova/i.test(VOCABULARIO_NIVEL.aprovacao.efeito));
}

secao("D. As 8 abas: 5 implementadas, 3 pendentes");

{
  ok("D1  continuam 8 abas, sem nona", ABAS.length === 8);
  ok("D2  ordem preservada",
    JSON.stringify(ABAS.map((a) => a.id)) ===
    JSON.stringify(["visao-geral", "chat", "tarefas", "conexoes", "funcoes", "permissoes", "memoria", "custos"]));
  ok("D3  conexoes, funcoes e permissoes agora implementadas",
    (["conexoes", "funcoes", "permissoes"] as const).every(
      (id) => ABAS.find((a) => a.id === id)?.implementada === true));
  ok("D4  chat, memoria e custos continuam pendentes",
    (["chat", "memoria", "custos"] as const).every(
      (id) => ABAS.find((a) => a.id === id)?.implementada === false));

  const pag = codigo(ler("components/ia/agente/PaginaAgente.tsx"));
  ok("D5  a pagina monta as tres abas novas",
    /AbaConexoes/.test(pag) && /AbaFuncoes/.test(pag) && /AbaPermissoes/.test(pag));
  ok("D6  escolha por comparacao explicita, nao indexacao",
    /aba === "conexoes"/.test(pag) && /aba === "funcoes"/.test(pag) && /aba === "permissoes"/.test(pag));
  ok("D7  EmBreve continua para as pendentes", /EmBreve/.test(pag));
}

secao("E. Conexoes");

{
  ok("E1  4 estados de conexao", ESTADOS_CONEXAO.length === 4);
  ok("E2  todo estado tem rotulo, icone e explicacao",
    ESTADOS_CONEXAO.every((e) =>
      VOCABULARIO_CONEXAO[e].rotulo.length > 0 &&
      VOCABULARIO_CONEXAO[e].icone.length > 0 &&
      VOCABULARIO_CONEXAO[e].explicacao.length > 10));
  ok("E3  `erro` NAO e apresentado como estado persistido",
    PROCEDENCIA_ESTADO_CONEXAO.erro === "simulado");
  ok("E4  conectada/expirada/desconectada sao derivaveis de colunas reais",
    (["conectada", "expirada", "desconectada"] as const).every(
      (e) => PROCEDENCIA_ESTADO_CONEXAO[e] === "disponivel"));

  ok("E5  ConexaoUI NAO tem campo de credencial nem de id externo",
    !/(access_token|refresh_token|partner_key|partner_id|seller_id|shop_id)/.test(
      codigo(CONCEITOS).split("interface FuncaoUI")[0]));
  ok("E6  estado e atribuicao sao campos SEPARADOS",
    /estado:\s*EstadoConexao/.test(CONCEITOS) && /atribuida:\s*boolean/.test(CONCEITOS));

  ok("E7  o mock cobre conectada, expirada e nao atribuida",
    MOCK_CONEXOES.some((c) => c.estado === "conectada" && c.atribuida) &&
    MOCK_CONEXOES.some((c) => c.estado === "expirada") &&
    MOCK_CONEXOES.some((c) => !c.atribuida));
  ok("E8  ha conexao que nunca sincronizou (null, nao zero)",
    MOCK_CONEXOES.some((c) => c.ultimaSincronizacao === null));

  ok("E9  o card distingue atribuida por moldura, nao so por texto",
    /cds-ia-cx-atribuida/.test(CARD_CX) && /border-style:\s*solid/.test(CARD_CX));
  ok("E10 o card informa a atribuicao tambem por TEXTO",
    /Não atribuída/.test(CARD_CX) && /Atribuída a este agente/.test(CARD_CX));
  ok("E11 o card usa icone + texto no estado",
    /vocab\.icone/.test(CARD_CX) && /vocab\.rotulo/.test(CARD_CX));
  ok("E12 'Usada por' vem das funcoes que dependem da conexao",
    /MOCK_FUNCOES_DA_CONEXAO/.test(AB_CX));
  ok("E13 MOCK_FUNCOES_DA_CONEXAO filtra por conexaoNecessaria",
    MOCK_FUNCOES_DA_CONEXAO("cx-ml").every((f) => f.conexaoNecessaria === "cx-ml"));
  ok("E14 conexao sem funcao dependente nao quebra",
    MOCK_FUNCOES_DA_CONEXAO("cx-inexistente").length === 0);

  ok("E15 ha Link real para /ia/conexoes", /<Link/.test(AB_CX) && /"\/ia\/conexoes"/.test(AB_CX));
  ok("E16 NAO ha acao de conectar/reconectar/desconectar",
    !/(Reconectar|Desconectar|Adicionar conexão|OAuth|autorizar)/i.test(codigo(AB_CX)));
  ok("E17 controle negativo: a sonda acharia um botao de reconectar",
    /(Reconectar|Desconectar)/i.test("<button>Reconectar</button>"));
  ok("E18 a divida de credenciais e citada da constante unica",
    /DIVIDA_CREDENCIAIS/.test(AB_CX) && DIVIDA_CREDENCIAIS.length > 40);
}

secao("F. Funcoes: Disponivel x Permitida, Leitura x Acao");

{
  ok("F1  'Disponível' e 'Permitida' sao palavras DIFERENTES no card",
    /Disponível/.test(CARD_FN) && /Permitida/.test(CARD_FN));
  ok("F2  sao dois selos separados, nao um status combinado",
    /cds-ia-selo-ok/.test(CARD_FN) && /cds-ia-selo-permitida/.test(CARD_FN));
  ok("F3  disponibilidade vem da procedencia, permissao vem do nivel",
    /funcaoDisponivel\(funcao\)/.test(CARD_FN) && /permitida\(\{ nivel \}\)/.test(CARD_FN));
  ok("F4  funcaoDisponivel so e true para procedencia disponivel",
    funcaoDisponivel({ procedencia: "disponivel" }) === true &&
    (["simulado", "nao_configurado", "em_breve"] as const).every(
      (p) => funcaoDisponivel({ procedencia: p }) === false));
  ok("F5  a aba explica a diferenca antes dos cards",
    /Disponível/.test(AB_FN) && /Permitida/.test(AB_FN) && /Bloqueada/.test(AB_FN));

  ok("F6  acesso tem rotulo Leitura e Ação",
    ROTULO_ACESSO.leitura.rotulo === "Leitura" && ROTULO_ACESSO.escrita.rotulo === "Ação");
  ok("F7  leitura e acao tem icones distintos",
    ROTULO_ACESSO.leitura.icone !== ROTULO_ACESSO.escrita.icone);
  ok("F8  o card mostra icone E texto do acesso",
    /acesso\.icone/.test(CARD_FN) && /acesso\.rotulo/.test(CARD_FN));
  ok("F9  funcao de escrita avisa sobre repeticao/idempotencia",
    /idempot|mais de uma vez|repeti/i.test(CARD_FN));

  ok("F10 3 niveis de risco com rotulo", RISCOS.length === 3);
  ok("F11 risco NAO vira permissao (eixos distintos)",
    !/risco\s*===\s*"alto"[^\n]{0,40}(bloque|permit)/i.test(codigo(CARD_FN)));

  ok("F12 catalogo cobre as 4 funcoes previstas",
    ["vendas.consultar", "anuncio.consultar", "mensagens.responder", "ads.campanha.pausar"]
      .every((id) => MOCK_FUNCOES.some((f) => f.id === id)));
  ok("F13 SO `vendas.consultar` e declarada disponivel",
    MOCK_FUNCOES.filter(funcaoDisponivel).map((f) => f.id).join(",") === "vendas.consultar");
  ok("F14 ADS e mensagens continuam `em_breve`",
    MOCK_FUNCOES.filter((f) => f.id.startsWith("ads.") || f.id.startsWith("mensagens."))
      .every((f) => f.procedencia === "em_breve"));
  ok("F15 nenhuma funcao de estoque declarada (sem evidencia)",
    !MOCK_FUNCOES.some((f) => /estoque/i.test(f.id)));
  ok("F16 o mock cobre permitida, bloqueada e em breve",
    MOCK_FUNCOES.some((f) => funcaoDisponivel(f) && permitida({ nivel: MOCK_NIVEL_DA_FUNCAO(f.id) })) &&
    MOCK_FUNCOES.some((f) => !permitida({ nivel: MOCK_NIVEL_DA_FUNCAO(f.id) })) &&
    MOCK_FUNCOES.some((f) => f.procedencia === "em_breve"));
  ok("F17 funcoes disponiveis aparecem antes das pendentes",
    /sort\(/.test(AB_FN) && /funcaoDisponivel/.test(AB_FN));
}

secao("G. Permissoes: representacao ESTATICA (Decisao 3)");

{
  const controles = /<input|<select|<textarea|<button|onChange|onClick|onInput|type="radio"|type="checkbox"/;
  ok("G1  SeletorAutonomia NAO tem controle nenhum", !controles.test(codigo(SELETOR)));
  ok("G2  controle negativo: a sonda acha um radio de verdade",
    controles.test('<input type="radio" onChange={x} />'));
  // Sobre o CODIGO, nao sobre a fonte crua: o cabecalho do componente
  // explica por que nao usa `role="radio"` — e o texto da explicacao
  // disparava a propria sonda. Comentario e documentacao, nao uso.
  ok("G3  SeletorAutonomia NAO usa role=radio/radiogroup",
    !/role="radio(group)?"/.test(codigo(SELETOR)));
  ok("G3b controle negativo: a sonda acha um radiogroup de verdade",
    /role="radio(group)?"/.test('<ul role="radiogroup">'));
  ok("G4  SeletorAutonomia NAO usa aria-checked/aria-selected",
    !/aria-checked|aria-selected/.test(SELETOR));
  ok("G5  o nivel vigente e dito por TEXTO, nao so por cor/simbolo",
    /configurado/.test(SELETOR));
  ok("G6  sem cursor: pointer (nao sugere clique)",
    !/cursor:\s*pointer/.test(codigo(SELETOR)));
  ok("G6b controle negativo: a sonda acha o cursor de clique",
    /cursor:\s*pointer/.test(".x { cursor: pointer; }"));
  ok("G7  mostra os tres niveis, nao so o vigente", /NIVEIS_AUTONOMIA\.map/.test(SELETOR));
  ok("G8  a aba avisa que nada e gravado",
    /não é gravada|nao e gravada|Nenhuma decisão/i.test(AB_PM));
  ok("G9  a aba NAO tem botao Salvar", !/Salvar|Aplicar|Confirmar/.test(codigo(AB_PM)));
  ok("G10 nenhum controle acionavel nas tres abas novas",
    [AB_CX, AB_FN, AB_PM].every((f) => !/<input|<select|<textarea|onChange/.test(codigo(f))));
  ok("G11 nenhuma das tres abas tem onClick",
    [AB_CX, AB_FN, AB_PM].every((f) => !/onClick/.test(codigo(f))));

  ok("G12 'Exige aprovação' aponta para /ia/aprovacoes", /\/ia\/aprovacoes/.test(AB_PM));
  ok("G13 NAO ha Aprovar/Recusar dentro da aba",
    !/>\s*(Aprovar|Recusar)\s*</.test(AB_PM));
  ok("G14 a aba explica que bloqueada != indisponivel",
    /não é o mesmo que indisponível|nao e o mesmo que indisponivel/i.test(AB_PM));
}

secao("H. Quatro conceitos, ainda separados");

{
  const c = codigo(CONCEITOS);
  ok("H1  ConexaoUI, FuncaoUI e PermissaoUI sao interfaces distintas",
    ["ConexaoUI", "FuncaoUI", "PermissaoUI"].every((n) => new RegExp(`interface ${n}`).test(c)));
  ok("H2  NivelAutonomia e tipo proprio", /type NivelAutonomia/.test(c));
  ok("H3  PermissaoUI referencia a funcao por id, nao a incorpora",
    /interface PermissaoUI[\s\S]{0,200}funcaoId:\s*string/.test(c) &&
    !/interface PermissaoUI[\s\S]{0,200}funcao:\s*FuncaoUI/.test(c));
  ok("H4  FuncaoUI referencia a conexao por id, nao a incorpora",
    /conexaoNecessaria:\s*string \| null/.test(c) && !/conexao:\s*ConexaoUI/.test(c));
  ok("H5  4 procedencias", PROCEDENCIAS.length === 4);
}

secao("I. Zero backend na area inteira");

{
  const sondas: Array<[string, RegExp]> = [
    ["supabase", /supabase|createClient|service_role/i],
    ["fetch/rede", /\bfetch\s*\(|XMLHttpRequest|axios|WebSocket/],
    ["env", /process\.env/],
    ["provider de IA", /anthropic|@google\/genai|openai|ai-gateway/i],
    ["integracao de marketplace",
      /lib\/marketplace|lib\/(mercado-livre|shopee|ml-auth|shopee-auth|sync-ml|sync-shopee)|mercadolibre\.com|shopee\.com|partner_id|app_secret/i],
    ["n8n", /n8n/i],
    ["dados/capability de agente", /lib\/agentes\/(dados|capability|executar)/],
    ["SQL", /\bselect\b[^;\n]{0,80}\bfrom\b|\binsert\s+into\b|\bdelete\s+from\b/i],
    ["migration", /supabase\/migrations|apply_migration|create table|alter table/i],
    ["rota de API", /app\/api\/|route\.ts|NextResponse|export async function (GET|POST|PUT|PATCH|DELETE)/],
    ["segredo", /access_token|refresh_token|partner_key|api[_-]?key|authorization|bearer\s/i],
    ["identificador externo", /\bseller_id\b|\bshop_id\b|\bpartner_id\b/],
    ["identificador de dono", /\buser_id\b|\bloja_id\b/],
    ["viewport em JS", /window\.innerWidth|addEventListener\("resize"|matchMedia/],
  ];

  const isca = [
    'createClient(supabase)', 'fetch("/x")', 'process.env.X', 'anthropic()',
    'import x from "@/lib/marketplace/credenciais"', 'n8n webhook',
    'lib/agentes/dados/vendas', 'select * from pedidos',
    'supabase/migrations/x.sql', 'export async function GET()',
    'access_token = "v"', 'seller_id', 'user_id', 'window.innerWidth',
  ].join("\n");

  let mortas = 0;
  for (const [nome, p] of sondas) {
    if (!p.test(isca)) { mortas++; console.log(`        SONDA MORTA: ${nome}`); }
  }
  ok("I0  controle negativo: as 14 sondas acusam a isca", mortas === 0, `${mortas} mortas`);

  for (const [nome, padrao] of sondas) {
    const sujos = ARQUIVOS_AREA.filter((a) => padrao.test(codigo(ler(a))));
    ok(`I  zero ${nome}`, sujos.length === 0, sujos.join(", "));
  }
}

secao("J. Mocks e procedencia");

{
  const mocks = MOCKS_PASTA.map(ler).join("\n");
  const exportados = [...mocks.matchAll(/export (?:const|function) (\w+)/g)].map((m) => m[1]);
  ok("J1  todo export da pasta de mocks usa prefixo MOCK_",
    exportados.every((e) => e.startsWith("MOCK_")), exportados.join(","));
  ok("J2  ids de conexao nao imitam UUID",
    MOCK_CONEXOES.every((c) => !/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(c.id)));
  ok("J3  nomes de conta sao ficticios e inequivocos",
    MOCK_CONEXOES.every((c) => /Exemplo|Segunda conta/i.test(c.conta)));
  ok("J4  toda conexao declara procedencia", MOCK_CONEXOES.every((c) => !!c.procedencia));
  ok("J5  toda funcao declara procedencia", MOCK_FUNCOES.every((f) => !!f.procedencia));
  ok("J6  toda permissao declara procedencia", MOCK_PERMISSOES.every((p) => !!p.procedencia));
  ok("J7  as tres abas exibem o aviso de simulacao",
    [AB_CX, AB_FN, AB_PM].every((f) => /MOCK_AVISO/.test(f)));
  ok("J8  os cards exibem a procedencia de cada item",
    /ROTULO_PROCEDENCIA/.test(CARD_CX) && /ROTULO_PROCEDENCIA/.test(CARD_FN));
  ok("J9  nenhum fake declarado fora de lib/ia/mocks/",
    ARQUIVOS_AREA.filter((a) => !a.startsWith("lib/ia/mocks/"))
      .every((a) => !/const\s+[A-Z_]*(AGENTES|TAREFAS|CONEXOES|FUNCOES|PERMISSOES)\s*(:|=)/.test(codigo(ler(a)))));

  // O antigo `mocks.ts < 400 linhas` disparou na UI-1D.a e a divisao
  // aconteceu. O guarda nao foi apagado — passou a cobrar a estrutura.
  ok("J10 o arquivo unico `lib/ia/mocks.ts` NAO existe mais",
    !existsSync(join(RAIZ, "lib/ia/mocks.ts")));
  ok("J10b a pasta tem exatamente os 6 arquivos previstos",
    JSON.stringify(arquivosDe("lib/ia/mocks")) === JSON.stringify([...MOCKS_PASTA].sort()),
    arquivosDe("lib/ia/mocks").join(", "));
  ok("J10c cada arquivo de mock cabe em si (< 400 linhas)",
    MOCKS_PASTA.every((m) => ler(m).split("\n").length < 400),
    MOCKS_PASTA.map((m) => `${m}:${ler(m).split("\n").length}`).join(" "));
}

secao("K. Acessibilidade e responsividade");

{
  const novos = NOVOS_1CB.map((a) => ler(a));
  ok("K1  nenhuma falsa affordance nos 6 componentes",
    novos.every((f) => !/<button|<input|<select|onChange/.test(codigo(f))));
  ok("K2  Links tem foco visivel",
    /:focus-visible/.test(AB_CX) && /:focus-visible/.test(AB_PM));
  ok("K3  headings hierarquicos (h3 nas abas, h4 nos itens)",
    /<h3/.test(AB_CX) && /<h3/.test(AB_FN) && /<h3/.test(AB_PM) && /<h4/.test(AB_PM));
  ok("K4  cards tem aria-label descritivo", /aria-label=/.test(CARD_CX));
  ok("K5  a lista de niveis e associada ao nome da funcao",
    /aria-labelledby/.test(SELETOR) && /idRotulo/.test(AB_PM));
  ok("K6  estado nunca so por cor: icone + texto em conexao e funcao",
    /aria-hidden="true"/.test(CARD_CX) && /aria-hidden="true"/.test(CARD_FN));
  ok("K7  grids responsivos por CSS",
    novos.every((f) => !/innerWidth|resize|matchMedia/.test(f)) &&
    /repeat\(auto-fit/.test(AB_CX) && /repeat\(auto-fit/.test(AB_FN) && /repeat\(auto-fit/.test(SELETOR));
  ok("K8  permissoes empilham em vez de virar tabela horizontal",
    !/<table/.test(AB_PM));
  ok("K9  texto longo nao estoura o container",
    /overflow-wrap:\s*anywhere/.test(CARD_FN));
}

// ═══════════════════════════════════════════════════════════════════════
console.log(`\n══ CDS IA — UI-1C.b: conexoes, funcoes e permissoes:  ${passou}/${passou + falhou} passaram ══`);
if (falhou > 0) {
  console.log(`   ${falhou} FALHARAM`);
  process.exit(1);
}
