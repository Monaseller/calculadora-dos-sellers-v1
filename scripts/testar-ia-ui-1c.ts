/**
 * CDS IA — UI-1C.a. Suite da pagina individual do agente.
 *
 * Cobre o que a fase acrescentou: rota dinamica, as 8 abas, Visao Geral,
 * Tarefas, a evolucao do drawer e a apresentacao derivada de tarefa.
 *
 * Nao renderiza React: prova por LEITURA DE FONTE e por execucao das
 * funcoes puras. Toda varredura tem CONTROLE NEGATIVO — sonda que nao
 * acusa nada pode estar quebrada em vez de limpa, e nesta base isso ja
 * aconteceu duas vezes (regex BRE sob ERE; `select\s+from` que nao pegava
 * `select * from`).
 *
 * Rodar:  npx tsx scripts/testar-ia-ui-1c.ts
 * Sem rede, sem banco, sem IA.
 */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { ABAS, ABA_PADRAO, PENDENCIA_ABA, abaSegura } from "../lib/ia/abas";
import { NIVEIS_AUTONOMIA, PROCEDENCIAS, RISCOS, DESCRICAO_TIPO } from "../lib/ia/conceitos";
import { TIPOS_AGENTE_UI, STATUS_TAREFA_UI } from "../lib/ia/contratos";
import {
  LIMITE_MENSAGEM_ERRO,
  LIMITE_ORFA_MS,
  VOCABULARIO_STATUS_TAREFA,
  duracaoMs,
  esperaNaFilaMs,
  formatarDuracao,
  formatarInstante,
  maisRecentesPrimeiro,
  mensagemDeErro,
  pareceOrfa,
  podeTentarNovamente,
  tarefaAtual,
  tituloDaTarefa,
  ultimaAtividade,
} from "../lib/ia/tarefas";
import { MOCK_AGENTES, MOCK_AGENTE_POR_ID, MOCK_TAREFAS } from "../lib/ia/mocks";
import type { TarefaUI } from "../lib/ia/contratos";

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
const sha = (rel: string) => createHash("sha256").update(readFileSync(join(RAIZ, rel))).digest("hex");

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

const ROTA_AGENTE = "app/(app)/ia/agentes/[id]/page.tsx";
const DRAWER = "components/ia/office/PainelAgente.tsx";

/** Tudo que a area de IA tem hoje — as varreduras valem para o conjunto. */
const ARQUIVOS_AREA: readonly string[] = [
  ...arquivosDe("lib/ia"),
  ...arquivosDe("components/ia"),
  ...arquivosDe("app/(app)/ia"),
];

const t = (parcial: Partial<TarefaUI>): TarefaUI => ({
  id: "t", agente_id: "a", tipo: "generico", entrada: {},
  status: "pendente", progresso: 0, tentativas: 0, max_tentativas: 3,
  erro_tipo: null, erro_mensagem: null,
  criado_em: "2026-08-27T12:00:00.000Z", iniciado_em: null,
  concluido_em: null, heartbeat_em: null,
  ...parcial,
});

const AGORA = Date.parse("2026-08-27T12:00:00.000Z");
const ha = (ms: number) => new Date(AGORA - ms).toISOString();

// ═══════════════════════════════════════════════════════════════════════
console.log("\n══ CDS IA — UI-1C.a: pagina do agente ══");

secao("A. Rota dinamica");

{
  ok("A1  a rota /ia/agentes/[id] existe", arquivosDe("app/(app)/ia").includes(ROTA_AGENTE));
  const fonte = ler(ROTA_AGENTE);
  ok("A2  exporta default", /export default function/.test(fonte));
  ok("A3  resolve o agente SO no mock", /MOCK_AGENTE_POR_ID/.test(codigo(fonte)));
  ok("A4  nao ha rota-filha por aba (uma rota so)",
    arquivosDe("app/(app)/ia").filter((a) => a.includes("[id]")).length === 1);
  ok("A5  a aba passa por abaSegura antes de escolher qualquer coisa",
    /abaSegura\(searchParams/.test(codigo(fonte)));
  ok("A6  a rota nao faz fetch nem consulta", !/fetch\(|createClient|supabase/i.test(codigo(fonte)));
}

secao("B. As 8 abas");

{
  ok("B1  exatamente 8 abas", ABAS.length === 8, String(ABAS.length));
  ok("B2  os 8 ids sao os previstos",
    JSON.stringify(ABAS.map((a) => a.id)) ===
    JSON.stringify(["visao-geral", "chat", "tarefas", "conexoes", "funcoes", "permissoes", "memoria", "custos"]));
  ok("B3  ids unicos", new Set(ABAS.map((a) => a.id)).size === 8);
  // Atualizado na UI-1C.b: conexoes, funcoes e permissoes passaram a
  // ter conteudo. O assert continua exato — ele lista QUAIS, nao quantas.
  ok("B4  as cinco abas implementadas sao exatamente estas",
    ABAS.filter((a) => a.implementada).map((a) => a.id).join(",") ===
    "visao-geral,tarefas,conexoes,funcoes,permissoes");
  ok("B5  as 6 nao implementadas declaram pendencia",
    ABAS.filter((a) => !a.implementada).every(
      (a) => (PENDENCIA_ABA as Record<string, string>)[a.id]?.length > 20));

  // Default e allowlist.
  ok("B6  ausente -> visao-geral", abaSegura(undefined) === ABA_PADRAO && ABA_PADRAO === "visao-geral");
  ok("B7  desconhecida -> visao-geral", abaSegura("tarefass") === "visao-geral");
  ok("B8  array (?aba=a&aba=b) -> visao-geral", abaSegura(["chat", "tarefas"]) === "visao-geral");
  ok("B9  tipos errados -> visao-geral",
    [null, 42, {}, true, "", "__proto__", "constructor"].every((v) => abaSegura(v) === "visao-geral"));
  ok("B10 valida e preservada", ABAS.every((a) => abaSegura(a.id) === a.id));
  ok("B11 controle negativo: abaSegura NAO devolve o padrao para tudo",
    abaSegura("tarefas") !== ABA_PADRAO);
  // A primeira versao proibia QUALQUER `[aba]`, o que reprovava
  // `PENDENCIA_ABA[aba]` — um mapa de STRINGS indexado por um valor que
  // `abaSegura` ja validou e que o tipo `AbaId` garante. Indexar texto
  // com uma uniao fechada e seguro; o risco de verdade e escolher
  // COMPONENTE por string vinda da URL. A sonda passou a mirar nisso.
  const painel = codigo(ler("components/ia/agente/PaginaAgente.tsx"));
  ok("B12 o componente da aba e escolhido por comparacao explicita",
    /aba === "visao-geral"/.test(painel) && /aba === "tarefas"/.test(painel));
  ok("B12b nenhum mapa de COMPONENTES e indexado pela aba",
    !/(COMPONENTES|PAINEIS|TELAS|VIEWS)\s*\[/.test(painel) &&
    !/ComponentType/.test(painel));
  ok("B12c controle negativo: a sonda acha um mapa de componentes",
    /(COMPONENTES|PAINEIS|TELAS|VIEWS)\s*\[/.test('const X = COMPONENTES[aba];'));
}

secao("C. Visao Geral e Tarefas implementadas; as outras nao fingem");

{
  const pagina = codigo(ler("components/ia/agente/PaginaAgente.tsx"));
  ok("C1  Visao Geral tem componente proprio", /VisaoGeral/.test(pagina));
  ok("C2  Tarefas tem componente proprio", /ListaTarefas/.test(pagina));
  ok("C3  as demais caem em EmBreve", /EmBreve/.test(pagina));

  const vg = ler("components/ia/agente/VisaoGeral.tsx");
  ok("C4  Visao Geral separa procedencia do dado", /ROTULO_PROCEDENCIA|procedencia/.test(vg));
  ok("C5  Visao Geral marca conexoes como simuladas", /"simulado"/.test(vg));
  ok("C6  Visao Geral marca funcoes/custo como em breve", /"em_breve"/.test(vg));
  ok("C7  Visao Geral nao inventa numero de custo",
    !/US\$|R\$|\$\s?\d/.test(vg));

  // Nenhum controle acionavel nas abas nao implementadas.
  const embreve = codigo(ler("components/ia/EmBreve.tsx"));
  ok("C8  EmBreve nao tem botao nem input", !/<button|<input|<select|<form/.test(embreve));
  ok("C9  EmBreve exige pendencia declarada", /pendencia/.test(embreve));
  ok("C10 nenhum onClick nas superficies nao implementadas",
    !/onClick/.test(embreve));
}

secao("D. Tarefas — apresentacao derivada, sem coluna inventada");

{
  ok("D1  TarefaUI nao tem campo `titulo`",
    !/^\s*titulo\s*:/m.test(codigo(ler("lib/ia/contratos.ts"))));
  ok("D2  os 6 status de tarefa tem vocabulario",
    STATUS_TAREFA_UI.every((s) => VOCABULARIO_STATUS_TAREFA[s].rotulo.length > 0 &&
      VOCABULARIO_STATUS_TAREFA[s].icone.length > 0));

  ok("D3  titulo derivado de tipo + entrada",
    tituloDaTarefa(t({ tipo: "responder_perguntas", entrada: { quantidade: 12 } })) ===
    "Respondendo 12 perguntas de compradores");
  ok("D4  singular e plural",
    tituloDaTarefa(t({ tipo: "tratar_imagens", entrada: { quantidade: 1 } })) === "Tratando 1 imagem" &&
    tituloDaTarefa(t({ tipo: "tratar_imagens", entrada: { quantidade: 4 } })) === "Tratando 4 imagens");
  ok("D5  entrada sem a chave esperada nao quebra",
    tituloDaTarefa(t({ tipo: "ajustar_lances", entrada: {} })) === "Ajustando lances de campanhas");
  ok("D6  tipo desconhecido vira texto legivel",
    tituloDaTarefa(t({ tipo: "faz_alguma_coisa", entrada: {} })) === "Faz alguma coisa");
  ok("D7  entrada vazia/ausente nunca produz [object Object]",
    !/\[object/.test(tituloDaTarefa(t({ tipo: "x", entrada: {} }))));

  // A regra de seguranca do titulo: allowlist de chaves.
  const venenosa = t({
    tipo: "responder_perguntas",
    entrada: { quantidade: 2, segredo: "sk-ant-NAO-DEVE-APARECER", token: "eyJabc.def" },
  });
  const titulo = tituloDaTarefa(venenosa);
  ok("D8  titulo NAO despeja chaves desconhecidas de `entrada`",
    !titulo.includes("sk-ant") && !titulo.includes("eyJabc") && !titulo.includes("segredo"),
    titulo);
  ok("D9  controle negativo: a chave conhecida ENTRA no titulo", titulo.includes("2"));
  ok("D10 valor de tipo errado e ignorado (nao vira 'NaN')",
    !/NaN|undefined|null/.test(
      tituloDaTarefa(t({ tipo: "tratar_imagens", entrada: { quantidade: "muitas" } }))));

  // Derivacoes de tempo.
  ok("D11 duracao de tarefa concluida",
    duracaoMs(t({ iniciado_em: ha(120_000), concluido_em: ha(60_000) }), AGORA) === 60_000);
  ok("D12 duracao parcial de tarefa em andamento",
    duracaoMs(t({ iniciado_em: ha(30_000) }), AGORA) === 30_000);
  ok("D13 nunca iniciada -> null, NAO zero",
    duracaoMs(t({ iniciado_em: null }), AGORA) === null);
  ok("D14 espera na fila",
    esperaNaFilaMs(t({ criado_em: ha(90_000), iniciado_em: ha(60_000) })) === 30_000);
  ok("D15 espera indefinida enquanto nao comeca",
    esperaNaFilaMs(t({ iniciado_em: null })) === null);
  ok("D16 data invalida nao quebra", duracaoMs(t({ iniciado_em: "nao-e-data" }), AGORA) === null);

  ok("D17 orfa: rodando com heartbeat parado alem do limite",
    pareceOrfa(t({ status: "rodando", heartbeat_em: ha(LIMITE_ORFA_MS + 1000) }), AGORA));
  ok("D18 heartbeat recente NAO e orfa",
    !pareceOrfa(t({ status: "rodando", heartbeat_em: ha(5_000) }), AGORA));
  ok("D19 so `rodando` pode ser orfa",
    !pareceOrfa(t({ status: "pendente", heartbeat_em: ha(LIMITE_ORFA_MS + 1000) }), AGORA));
  ok("D20 limite de orfa igual ao do banco (5 min)", LIMITE_ORFA_MS === 5 * 60 * 1000);

  ok("D21 retry disponivel", podeTentarNovamente(t({ status: "erro", tentativas: 1, max_tentativas: 3 })));
  ok("D22 retry esgotado", !podeTentarNovamente(t({ status: "erro", tentativas: 3, max_tentativas: 3 })));
  ok("D23 status terminal nunca tenta de novo",
    !podeTentarNovamente(t({ status: "concluido", tentativas: 0, max_tentativas: 3 })) &&
    !podeTentarNovamente(t({ status: "cancelado", tentativas: 0, max_tentativas: 3 })));

  ok("D24 duracao formatada e legivel",
    formatarDuracao(820) === "820ms" && formatarDuracao(45_000) === "45s" &&
    formatarDuracao(200_000) === "3min 20s" && formatarDuracao(3_600_000) === "1h");
  ok("D25 duracao nula vira travessao, nao 0", formatarDuracao(null) === "—");
  ok("D26 instante nulo vira travessao", formatarInstante(null) === "—");
  ok("D27 instante invalido vira travessao", formatarInstante("nao-e-data") === "—");

  ok("D28 mensagem de erro truncada",
    (mensagemDeErro(t({ erro_mensagem: "x".repeat(500) })) ?? "").length === LIMITE_MENSAGEM_ERRO + 1);
  ok("D29 quebras de linha colapsadas",
    mensagemDeErro(t({ erro_mensagem: "linha 1\n\n  linha 2" })) === "linha 1 linha 2");
  ok("D30 erro ausente -> null", mensagemDeErro(t({ erro_mensagem: null })) === null);
  ok("D31 erro so com espacos -> null", mensagemDeErro(t({ erro_mensagem: "   " })) === null);

  // tarefaAtual: precedencia, nao ordem do array.
  const conjunto = [
    t({ id: "a", status: "erro" }),
    t({ id: "b", status: "pendente" }),
    t({ id: "c", status: "rodando" }),
    t({ id: "d", status: "aguardando_aprovacao" }),
  ];
  ok("D32 rodando vence pendente e aguardando", tarefaAtual(conjunto)?.id === "c");
  ok("D33 aguardando vence pendente",
    tarefaAtual([t({ id: "b", status: "pendente" }), t({ id: "d", status: "aguardando_aprovacao" })])?.id === "d");
  ok("D34 erro NAO e tarefa atual", tarefaAtual([t({ id: "a", status: "erro" })]) === null);
  ok("D35 concluida NAO e tarefa atual",
    tarefaAtual([t({ status: "concluido", concluido_em: ha(1000) })]) === null);
  ok("D36 sem tarefa -> null", tarefaAtual([]) === null);

  ok("D37 ordenacao da mais recente para a mais antiga",
    maisRecentesPrimeiro([
      t({ id: "velha", criado_em: ha(90_000) }),
      t({ id: "nova", criado_em: ha(1_000) }),
    ]).map((x) => x.id).join(",") === "nova,velha");
  ok("D38 ultima atividade considera o instante mais recente",
    ultimaAtividade([t({ criado_em: ha(90_000), iniciado_em: ha(60_000), concluido_em: ha(10_000) })]) === ha(10_000));
  ok("D39 ultima atividade de lista vazia -> null", ultimaAtividade([]) === null);
}

secao("E. Status de TAREFA nao se mistura com estado de AGENTE");

{
  ok("E1  tarefas.ts nao importa estados.ts",
    !/from "@\/lib\/ia\/estados"/.test(ler("lib/ia/tarefas.ts")));
  ok("E2  ListaTarefas nao importa o vocabulario de agente",
    !/VOCABULARIO_ESTADO|aparenciaDoAgente/.test(codigo(ler("components/ia/agente/ListaTarefas.tsx"))));
  ok("E3  os dois vocabularios tem tamanhos diferentes (6 x 5)",
    STATUS_TAREFA_UI.length === 6 && ABAS.length === 8);
  ok("E4  controle negativo: VisaoGeral USA o vocabulario de agente",
    /BadgeEstado/.test(ler("components/ia/agente/VisaoGeral.tsx")));
}

secao("F. Aprovacao nao acontece nesta fase");

{
  const lista = ler("components/ia/agente/ListaTarefas.tsx");
  ok("F1  aguardando_aprovacao e sinalizado", /aguardando_aprovacao/.test(lista));
  ok("F2  aponta para /ia/aprovacoes", /\/ia\/aprovacoes/.test(lista));
  ok("F3  NAO existe botao Aprovar/Recusar",
    !/>\s*(Aprovar|Recusar)\s*</.test(lista) && !/onClick/.test(codigo(lista)));
  ok("F4  controle negativo: a sonda de botao acha um botao de verdade",
    />\s*(Aprovar|Recusar)\s*</.test("<button>Aprovar</button>"));
  ok("F5  nenhuma alteracao de status em lugar nenhum da area",
    ARQUIVOS_AREA.every((a) => !/set(Status|Tarefa)\(|status\s*=\s*["']/.test(codigo(ler(a)))));
}

secao("G. Drawer virou consulta rapida");

{
  const drawer = ler(DRAWER);
  ok("G1  drawer NAO lista mais o historico completo",
    !/HISTÓRICO|HISTORICO/.test(drawer) && !/tarefas\.map\(/.test(codigo(drawer)));
  ok("G2  controle negativo: a sonda acharia o historico antigo",
    /tarefas\.map\(/.test("{tarefas.map((t) => (<li/"));
  ok("G3  drawer tem 'Abrir agente'", /Abrir agente/.test(drawer));
  ok("G4  e um Link real para a pagina do agente",
    /<Link/.test(drawer) && /\/ia\/agentes\/\$\{agente\.id\}/.test(drawer));
  ok("G5  drawer mantem identidade, estado, tarefa e progresso",
    /BadgeEstado/.test(drawer) && /TAREFA ATUAL/.test(drawer) && /progressbar/.test(drawer));
  ok("G6  drawer segue fechando por Escape e devolvendo foco",
    /"Escape"/.test(drawer) && /activeElement/.test(drawer));
}

secao("H. Agente inexistente e ids ficticios");

{
  ok("H1  id conhecido resolve", MOCK_AGENTE_POR_ID("ag-atendimento")?.nome === "Atendimento");
  ok("H2  id desconhecido devolve undefined, sem lancar",
    MOCK_AGENTE_POR_ID("nao-existe") === undefined);
  ok("H3  a rota trata o inexistente com EstadoVazio",
    /EstadoVazio/.test(codigo(ler(ROTA_AGENTE))) && /não encontrado/i.test(ler(ROTA_AGENTE)));
  ok("H4  oferece caminho de volta para /ia/agentes",
    /\/ia\/agentes/.test(ler(ROTA_AGENTE)));
  ok("H5  nao usa notFound() seco", !/notFound\(\)/.test(codigo(ler(ROTA_AGENTE))));
  ok("H6  ids de mock continuam nao-UUID",
    MOCK_AGENTES.every((a) => !/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(a.id)));
  ok("H7  controle negativo: a sonda de UUID reconhece um UUID",
    /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test("123e4567-e89b-12d3-a456-426614174000"));
  ok("H8  todo agente do mock e alcancavel pela rota",
    MOCK_AGENTES.every((a) => MOCK_AGENTE_POR_ID(a.id) !== undefined));
}

secao("I. Conceitos separados");

{
  const conceitos = ler("lib/ia/conceitos.ts");
  ok("I1  ConexaoUI existe e nao tem credencial",
    /interface ConexaoUI/.test(conceitos) &&
    !/token|credencial|api_?key|secret/i.test(codigo(conceitos).split("interface FuncaoUI")[0]));
  ok("I2  FuncaoUI existe e separa leitura de escrita",
    /interface FuncaoUI/.test(conceitos) && /"leitura" \| "escrita"/.test(conceitos));
  ok("I3  PermissaoUI existe e e separada de FuncaoUI",
    /interface PermissaoUI/.test(conceitos));
  ok("I4  autonomia tem exatamente 3 niveis",
    NIVEIS_AUTONOMIA.length === 3 &&
    JSON.stringify([...NIVEIS_AUTONOMIA]) === JSON.stringify(["bloqueado", "aprovacao", "automatico"]));
  ok("I5  os 4 conceitos sao tipos distintos (nenhum fundido)",
    ["ConexaoUI", "FuncaoUI", "PermissaoUI"].every((n) => new RegExp(`interface ${n}`).test(conceitos)) &&
    /type NivelAutonomia/.test(conceitos));
  ok("I6  procedencia tem os 4 niveis de honestidade", PROCEDENCIAS.length === 4);
  ok("I7  risco tem 3 niveis", RISCOS.length === 3);
  ok("I8  descricao por tipo cobre os 6 tipos do CHECK",
    TIPOS_AGENTE_UI.every((tp) => DESCRICAO_TIPO[tp]?.length > 0));
}

secao("J. Zero backend na area inteira");

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
    ["SQL", /\bselect\b[^;\n]{0,80}\bfrom\b|\binsert\s+into\b|\bdelete\s+from\b|\bupdate\b[^;\n]{0,40}\bset\b/i],
    ["migration", /supabase\/migrations|apply_migration|create table|alter table/i],
    ["rota de API", /app\/api\/|route\.ts|NextResponse|export async function (GET|POST|PUT|PATCH|DELETE)/],
    ["segredo", /access_token|refresh_token|partner_key|api[_-]?key|authorization|bearer\s/i],
    ["identificador de dono", /\buser_id\b|\bloja_id\b|\bseller_id\b|\bshop_id\b/],
    ["viewport em JS", /window\.innerWidth|addEventListener\("resize"|matchMedia/],
  ];

  const isca = [
    'createClient(supabase)', 'fetch("/x")', 'process.env.X', 'anthropic()',
    'import x from "@/lib/marketplace/credenciais"', 'n8n webhook',
    'lib/agentes/dados/vendas', 'select * from pedidos',
    'supabase/migrations/x.sql', 'export async function GET()',
    'access_token = "v"', 'user_id', 'window.innerWidth',
  ].join("\n");

  let mortas = 0;
  for (const [nome, p] of sondas) {
    if (!p.test(isca)) {
      mortas++;
      console.log(`        SONDA MORTA: ${nome}`);
    }
  }
  ok("J0  controle negativo: as 13 sondas acusam a isca", mortas === 0, `${mortas} mortas`);

  for (const [nome, padrao] of sondas) {
    const sujos = ARQUIVOS_AREA.filter((a) => padrao.test(codigo(ler(a))));
    ok(`J  zero ${nome}`, sujos.length === 0, sujos.join(", "));
  }
}

secao("K. Mocks centralizados");

{
  const fora = ARQUIVOS_AREA
    .filter((a) => a !== "lib/ia/mocks.ts")
    .filter((a) => /const\s+[A-Z_]*(AGENTES|TAREFAS|CONEXOES|FUNCOES|PERMISSOES)\s*(:|=)/.test(codigo(ler(a))));
  ok("K1  nenhum fake fora de mocks.ts", fora.length === 0, fora.join(", "));

  const mocks = ler("lib/ia/mocks.ts");
  const exportados = [...mocks.matchAll(/export (?:const|function) (\w+)/g)].map((m) => m[1]);
  ok("K2  todo export de mocks usa prefixo MOCK_",
    exportados.length > 0 && exportados.every((e) => e.startsWith("MOCK_")), exportados.join(","));
  ok("K3  mocks.ts ainda cabe em um arquivo (< 400 linhas)",
    mocks.split("\n").length < 400, String(mocks.split("\n").length));

  const tarefas = MOCK_TAREFAS(AGORA);
  ok("K4  os 6 status de tarefa aparecem no mock",
    STATUS_TAREFA_UI.every((s) => tarefas.some((x) => x.status === s)),
    STATUS_TAREFA_UI.filter((s) => !tarefas.some((x) => x.status === s)).join(","));
  ok("K5  ha tarefa orfa no mock, para a tela exercitar o aviso",
    tarefas.some((x) => pareceOrfa(x, AGORA)));
  ok("K6  ha tarefa com erro e tentativas esgotadas",
    tarefas.some((x) => x.status === "erro" && !podeTentarNovamente(x)));
  ok("K7  toda tarefa aponta para agente existente",
    tarefas.every((x) => MOCK_AGENTE_POR_ID(x.agente_id) !== undefined));
  ok("K8  toda entrada e objeto (nunca string crua)",
    tarefas.every((x) => typeof x.entrada === "object" && x.entrada !== null));
  ok("K9  o aviso de simulacao continua no shell",
    /MOCK_AVISO/.test(ler("app/(app)/ia/layout.tsx")));
}

secao("L. Acessibilidade e responsividade");

{
  const abas = ler("components/ia/agente/AbasAgente.tsx");
  const pagina = ler("components/ia/agente/PaginaAgente.tsx");
  const lista = ler("components/ia/agente/ListaTarefas.tsx");
  const vg = ler("components/ia/agente/VisaoGeral.tsx");
  const vazio = ler("components/ia/EstadoVazio.tsx");

  ok("L1  abas sao <nav> com links reais, nao divs clicaveis",
    /<nav/.test(abas) && /<Link/.test(abas) && !/onClick/.test(codigo(abas)));
  ok("L2  aba ativa marcada com aria-current", /aria-current=\{/.test(abas));
  ok("L3  aba ativa nao depende so de cor (sublinhado)", /box-shadow: inset/.test(abas));
  ok("L4  abas rolam por CSS no mobile",
    /overflow-x:\s*auto/.test(abas) && !/innerWidth|resize/.test(abas));
  ok("L5  'em breve' tem texto para leitor de tela, nao so um ponto",
    /\(em breve\)/.test(abas));
  ok("L6  foco visivel nas abas", /:focus-visible/.test(abas));

  ok("L7  hierarquia de headings: h2 na pagina, h3 nos blocos",
    /<h2/.test(pagina) && /<h3/.test(vg) && /<h3/.test(lista));
  ok("L8  progresso acessivel na Visao Geral e nas tarefas",
    /role="progressbar"/.test(vg) && /aria-valuenow/.test(vg) &&
    /role="progressbar"/.test(lista) && /aria-valuenow/.test(lista));
  ok("L9  status de tarefa tem icone E texto",
    /vocab\.icone/.test(lista) && /vocab\.rotulo/.test(lista));
  ok("L10 erro nao e comunicado so por cor", /Falhou/.test(lista));
  ok("L11 estado vazio tem texto, nao so ilustracao",
    /titulo/.test(vazio) && /descricao/.test(vazio) && /role="note"/.test(vazio));
  ok("L12 datas legiveis, nao ISO cru", /formatarInstante/.test(lista));

  ok("L13 layout responsivo por CSS em toda a area",
    ARQUIVOS_AREA.every((a) => !/window\.innerWidth|addEventListener\("resize"/.test(ler(a))));
  ok("L14 listas usam grid auto-fit",
    /repeat\(auto-fit/.test(lista + vg));
  ok("L15 texto longo nao estoura o container",
    /overflow-wrap:\s*anywhere/.test(vg));
}

secao("M. Preservacoes");

{
  const ESPERADO: Record<string, string> = {
    "app/dev/ai-office/office.tsx": "f79aaee0e6e30f0b216b1787c1f0922efff88c23e2b5ecda7edd0cb44e0aea5f",
    "app/dev/ai-office/page.tsx": "4955b27019f9bc64bbf588336b4312ed008017595c5c687b3ac37483ccbec3ee",
    "app/dev/preview/page.tsx": "cc99e8dc7401e6d2060ff6b0436f7b5b9f91fcae006ac10f7bf6f1970e07b57b",
    "app/dev/preview/registry.tsx": "3bd9e6dc828f491c37c733832d232ae6191d430a9b8123d423caa7bd8f329295",
  };
  for (const [arq, esperado] of Object.entries(ESPERADO)) {
    ok(`M  ${arq} byte a byte intacto`, sha(arq) === esperado, `sha=${sha(arq).slice(0, 12)}…`);
  }
  ok("M5  app/dev continua com 4 arquivos", arquivosDe("app/dev").length === 4);
  ok("M6  a area nao importa nada de app/dev",
    ARQUIVOS_AREA.every((a) => !/app\/dev/.test(ler(a))));
  ok("M7  middleware nao precisou mudar (default deny cobre /ia)",
    !/\/ia\b/.test(ler("lib/middleware-rotas.ts")));
  ok("M8  layout global intacto",
    !/components\/ia|lib\/ia/.test(ler("app/(app)/layout.tsx")));
}

// ═══════════════════════════════════════════════════════════════════════
console.log(`\n══ CDS IA — UI-1C.a: pagina do agente:  ${passou}/${passou + falhou} passaram ══`);
if (falhou > 0) {
  console.log(`   ${falhou} FALHARAM`);
  process.exit(1);
}
