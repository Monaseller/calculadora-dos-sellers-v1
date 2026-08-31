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
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
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

const existe = (rel: string) => existsSync(join(RAIZ, rel));

/** A pasta de mocks, nome a nome — sem wildcard. */
const MOCKS_PASTA: readonly string[] = [
  "lib/ia/mocks/agentes.ts",
  "lib/ia/mocks/aprovacoes.ts",
  "lib/ia/mocks/atividade.ts",
  "lib/ia/mocks/capabilities.ts",
  "lib/ia/mocks/conexoes.ts",
  "lib/ia/mocks/index.ts",
  "lib/ia/mocks/tarefas.ts",
];

const ROTA_AGENTE = "app/(app)/ia/agentes/[id]/page.tsx";
/** O container cliente do detalhe — para onde a resolucao do agente
 *  desceu na SKILL-1D.ui-consumer-C, junto com a identidade real. */
const CONTAINER_AGENTE = "components/ia/agente/PaginaAgente.tsx";
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
  // A SKILL-1D.ui-consumer-C inverteu este assert. A rota resolvia o
  // agente na lista simulada; hoje a identidade e REAL e vem da lista
  // autenticada do dono, que so o container cliente consegue ler. A
  // pagina ficou com uma responsabilidade so: validar a aba e entregar
  // o `id`. O que se cobra agora e o contrario do que se cobrava —
  // que ela NAO resolva mock nenhum.
  ok("A3  a rota NAO resolve mais o agente no mock",
    !/MOCK_AGENTE_POR_ID|MOCK_AGENTES/.test(codigo(fonte)));
  ok("A3b a rota entrega o id da rota ao container",
    /agenteId=\{params\.id\}/.test(codigo(fonte)));
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
  // Atualizado na UI-1C.b, quando conexoes/funcoes/permissoes ganharam
  // conteudo — e de novo na SKILL-1D.ui-real-state-Bg2, quando o
  // conteudo delas se revelou simulado e foi removido. O assert continua
  // exato: ele lista QUAIS, nao quantas, e por isso acusa os dois
  // movimentos.
  ok("B4  as duas abas implementadas sao exatamente estas",
    ABAS.filter((a) => a.implementada).map((a) => a.id).join(",") ===
    "visao-geral,tarefas");
  // O rotulo dizia "6" desde a UI-1C.b, quando eram 3 — numero escrito
  // no nome do assert envelhece calado. Agora sao seis de verdade, e o
  // assert passou a cobrar a CONTAGEM tambem, para nao envelhecer de novo.
  const pendentes = ABAS.filter((a) => !a.implementada);
  ok("B5  as 6 nao implementadas declaram pendencia",
    pendentes.length === 6 &&
    pendentes.every((a) => (PENDENCIA_ABA as Record<string, string>)[a.id]?.length > 20),
    pendentes.map((a) => a.id).join(","));

  // ── A invariavel que faltava: `implementada` x o que a pagina monta ─
  //
  // Nada, ate aqui, impedia uma aba marcada como pronta cujo componente
  // so renderizasse "Em breve" — foi exatamente o estado em que
  // conexoes, funcoes e permissoes ficaram entre a ui-real-state-B e a
  // Bg2. A barra dizia "pronta", a tela dizia "em breve", e nenhum teste
  // reprovava.
  //
  // Agora reprova, nos DOIS sentidos.
  const paginaAgente = codigo(ler("components/ia/agente/PaginaAgente.tsx"));
  const montaPropria = (id: string) => new RegExp(`aba === "${id}"`).test(paginaAgente);

  const prontasSemCaminho = ABAS.filter((a) => a.implementada && !montaPropria(a.id));
  ok("B5b toda aba implementada tem caminho proprio na pagina",
    prontasSemCaminho.length === 0, prontasSemCaminho.map((a) => a.id).join(","));

  const pendentesComCaminho = ABAS.filter((a) => !a.implementada && montaPropria(a.id));
  ok("B5c nenhuma aba pendente monta componente proprio",
    pendentesComCaminho.length === 0, pendentesComCaminho.map((a) => a.id).join(","));

  const pendentesSemPendencia = ABAS.filter(
    (a) => !a.implementada && !(PENDENCIA_ABA as Record<string, string>)[a.id]);
  ok("B5d toda aba pendente declara pendencia",
    pendentesSemPendencia.length === 0, pendentesSemPendencia.map((a) => a.id).join(","));

  const prontasComPendencia = ABAS.filter(
    (a) => a.implementada && !!(PENDENCIA_ABA as Record<string, string>)[a.id]);
  ok("B5e nenhuma aba implementada carrega pendencia orfa",
    prontasComPendencia.length === 0, prontasComPendencia.map((a) => a.id).join(","));

  // O `EmBreve` das pendentes e montado UMA vez, num lugar so.
  ok("B5f o EmBreve das pendentes e centralizado, e unico",
    /abaPendente\(aba\)/.test(paginaAgente) &&
    (paginaAgente.match(/<EmBreve/g) ?? []).length === 1);

  ok("B5g CONTROLE: a sonda de caminho proprio acha e deixa de achar",
    /aba === "tarefas"/.test(paginaAgente) && !/aba === "memoria"/.test(paginaAgente));

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
  // ── C5 reconciliado na SKILL-1D.ui-real-state-B ─────────────────
  //
  // Antes: o bloco de conexoes precisava estar MARCADO como simulado.
  // A marcacao era correta e ainda assim insuficiente: com identidade
  // real do agente na mesma tela, `Loja Exemplo` e `Segunda conta`
  // deixaram de ser ilustracao e viraram configuracao aparente DESTE
  // agente. A etiqueta salvava a honestidade da tela, nao a leitura de
  // quem bate o olho.
  //
  // A invariavel agora e mais forte: o bloco nao consome mock nenhum, e
  // nada nesta tela se declara `simulado` — o que nao tem fonte e
  // `em_breve`, que e a unica coisa verdadeira a dizer sobre ele.
  ok("C5  Visao Geral nao exibe conexao nem funcao simulada",
    !/MOCK_/.test(codigo(vg)) && !/procedencia="simulado"/.test(vg));
  ok("C5b CONTROLE: a sonda acharia o consumo antigo",
    /MOCK_/.test('import { MOCK_CONEXOES } from "@/lib/ia/mocks";') &&
    /procedencia="simulado"/.test('<Bloco titulo="Conexões" procedencia="simulado">'));
  // Sobre `codigo(vg)` e nao `vg`: o cabecalho do componente EXPLICA
  // por que as frases proibidas nao foram usadas, e cita as duas. Sonda
  // que le comentario acusaria justamente a documentacao da regra.
  const FRASE_DE_VAZIO = /Nenhuma conex[aã]o atribu[ií]da|Nenhuma fun[cç][aã]o habilitada|Nenhuma permiss[aã]o configurada/i;
  ok("C5c o que nao tem fonte declara ausencia, nao vazio consultado",
    /em_breve/.test(vg) && !FRASE_DE_VAZIO.test(codigo(vg)));
  ok("C5d CONTROLE: a sonda acha o hardcode de vazio",
    FRASE_DE_VAZIO.test("<p>Nenhuma conexão atribuída</p>"));
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
  // A tela de "nao encontrado" continua existindo e continua sendo uma
  // TELA, nunca um 404 seco — o que mudou na SKILL-1D.ui-consumer-C foi
  // quem a decide: saiu da rota e foi para o container, porque a
  // conclusao agora depende da lista autenticada do dono.
  ok("H3  o container trata o inexistente com EstadoVazio",
    /EstadoVazio/.test(codigo(ler(CONTAINER_AGENTE))) &&
      /não encontrado/i.test(ler(CONTAINER_AGENTE)));
  ok("H3b e a conclusao vem da LISTA, nunca do diagnostico vazio",
    /agentes\.find\(\(a\) => a\.id === agenteId\)/.test(codigo(ler(CONTAINER_AGENTE))) &&
      !/diagnosticos\.length === 0[^\n]*nao encontrado/i.test(codigo(ler(CONTAINER_AGENTE))));
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
  const sondas: Array<[string, RegExp, string[]?]> = [
    ["supabase", /supabase|createClient|service_role/i],
    // A SKILL-1D.ui-consumer-C deu a area o seu PRIMEIRO ponto de rede
    // legitimo: a tela de agentes passou a ler a API de agentes e a de
    // diagnostico. A proibicao nao afrouxa, muda de forma — deixa de ser
    // "zero na area" e passa a ser "EXATAMENTE este arquivo", por
    // igualdade nominal de caminho. Um segundo arquivo com rede reprova,
    // e o desaparecimento do autorizado tambem. `XMLHttpRequest`, `axios`
    // e `WebSocket` seguem proibidos em TODA a area, inclusive nele.
    ["fetch/rede", /\bfetch\s*\(|XMLHttpRequest|axios|WebSocket/, ["lib/ia/agentes-http.ts"]],
    ["env", /process\.env/],
    ["provider de IA", /anthropic|@google\/genai|openai|ai-gateway/i],
    ["integracao de marketplace",
      /lib\/marketplace|lib\/(mercado-livre|shopee|ml-auth|shopee-auth|sync-ml|sync-shopee)|mercadolibre\.com|shopee\.com|partner_id|app_secret/i],
    ["n8n", /n8n/i],
    ["dados/capability de agente", /lib\/agentes\/(dados|capability|executar)/],
    ["SQL", /\bselect\b[^;\n]{0,80}\bfrom\b|\binsert\s+into\b|\bdelete\s+from\b|\bupdate\b[^;\n]{0,40}\bset\b/i],
    ["migration", /supabase\/migrations|apply_migration|create table|alter table/i],
    ["rota de API", /app\/api\/|route\.ts|NextResponse|export async function (GET|POST|PUT|PATCH|DELETE)/],
    // A sonda exige VALOR, nunca a palavra. Uma Ficha de Integracao
    // precisa poder DOCUMENTAR autenticacao ("a API usa access_token",
    // "envie Authorization: Bearer <token>") sem ser tratada como
    // vazamento — isso e requisito de produto, nao tolerancia. O que
    // reprova e a credencial em si. Semantica equivalente a de
    // `lib/ia/skills/formato.ts`, que precisou da mesma distincao.
    ["segredo", /\b(?:access_token|refresh_token|partner_key|client_secret|api[_-]?key|token|secret|senha)\b\s*[:=]\s*["']?[A-Za-z0-9_\-./+]{12,}|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.|\bsk-[A-Za-z0-9_-]{16,}|-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9_\-.]{16,}/i],
    ["identificador de dono", /\buser_id\b|\bloja_id\b|\bseller_id\b|\bshop_id\b/],
    ["viewport em JS", /window\.innerWidth|addEventListener\("resize"|matchMedia/],
  ];

  const isca = [
    'createClient(supabase)', 'fetch("/x")', 'process.env.X', 'anthropic()',
    'import x from "@/lib/marketplace/credenciais"', 'n8n webhook',
    'lib/agentes/dados/vendas', 'select * from pedidos',
    'supabase/migrations/x.sql', 'export async function GET()',
    'access_token = "aB3xK9zQ7mP2wL5tR8"', 'user_id', 'window.innerWidth',
  ].join("\n");

  let mortas = 0;
  for (const [nome, p] of sondas) {
    if (!p.test(isca)) {
      mortas++;
      console.log(`        SONDA MORTA: ${nome}`);
    }
  }
  ok("J0  controle negativo: as 13 sondas acusam a isca", mortas === 0, `${mortas} mortas`);
  // A sonda de segredo mudou de semantica nesta fase: passou a exigir
  // VALOR. Os controles abaixo provam os dois lados — que ela continua
  // viva para credencial real, e que nao reprova documentacao.
  {
    const sondaSegredo = sondas.find(([n]) => n === "segredo")![1];
    const DOC =
      "A API usa access_token e refresh_token. Envie Authorization: Bearer <token>. " +
      "A API key vem de Conexoes, nunca da Skill.";
    ok("Js1 segredo: prosa documental NAO dispara", !sondaSegredo.test(DOC));
    ok("Js2 segredo: valor atribuido dispara", sondaSegredo.test('access_token = "aB3xK9zQ7mP2wL5tR8"'));
    ok("Js3 segredo: JWT sintetico dispara", sondaSegredo.test("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.aZ"));
    ok("Js4 segredo: Bearer com valor dispara", sondaSegredo.test("Bearer " + "A".repeat(24)));
    ok("Js5 segredo: chave sk- dispara", sondaSegredo.test("sk-" + "A".repeat(20)));
    ok("Js6 segredo: bloco PRIVATE KEY dispara", sondaSegredo.test("-----BEGIN RSA PRIVATE KEY-----"));
  }


  for (const [nome, padrao, autorizados] of sondas) {
    const marcados = ARQUIVOS_AREA.filter((a) => padrao.test(codigo(ler(a))));
    const permitidos = autorizados ?? [];
    const sujos = marcados.filter((a) => !permitidos.includes(a));
    // Igualdade nos DOIS sentidos: arquivo nao autorizado que casa
    // com o padrao reprova, e autorizado que deixou de casar tambem
    // — allowlist com item obsoleto e como uma protecao morre sem
    // ninguem perceber.
    const sumidos = permitidos.filter((a) => !marcados.includes(a));
    ok(`J  ${permitidos.length === 0 ? "zero" : "so o autorizado tem"} ${nome}`,
      sujos.length === 0 && sumidos.length === 0,
      [...sujos, ...sumidos.map((a) => `${a} (sumiu)`)].join(", "));
  }
}

secao("K. Mocks centralizados");

{
  const fora = ARQUIVOS_AREA
    .filter((a) => !a.startsWith("lib/ia/mocks/"))
    .filter((a) => /const\s+[A-Z_]*(AGENTES|TAREFAS|CONEXOES|FUNCOES|PERMISSOES)\s*(:|=)/.test(codigo(ler(a))));
  ok("K1  nenhum fake fora de lib/ia/mocks/", fora.length === 0, fora.join(", "));

  const mocks = MOCKS_PASTA.map(ler).join("\n");
  const exportados = [...mocks.matchAll(/export (?:const|function) (\w+)/g)].map((m) => m[1]);
  ok("K2  todo export da pasta de mocks usa prefixo MOCK_",
    exportados.length > 0 && exportados.every((e) => e.startsWith("MOCK_")), exportados.join(","));

  // ── O tripwire que virou guarda estrutural ──────────────────────
  //
  // O antigo `mocks.ts < 400 linhas` cumpriu o papel de alarme: tocou na
  // UI-1D.a e a divisao aconteceu. Ele NAO foi apagado — virou mais
  // forte, cobrando a ausencia do arquivo antigo, o inventario exato da
  // pasta e o limite POR ARQUIVO. Apagar o assert teria sido silenciar
  // justamente o mecanismo que funcionou.
  ok("K3  o arquivo unico `lib/ia/mocks.ts` NAO existe mais",
    !existe("lib/ia/mocks.ts"));
  ok("K3b controle negativo: `existe` reconhece um arquivo que existe",
    existe("lib/ia/mocks/index.ts"));
  ok("K3c a pasta tem exatamente os 6 arquivos previstos",
    JSON.stringify(arquivosDe("lib/ia/mocks")) === JSON.stringify([...MOCKS_PASTA].sort()),
    arquivosDe("lib/ia/mocks").join(", "));
  ok("K3d cada arquivo de mock cabe em si (< 400 linhas)",
    MOCKS_PASTA.every((m) => ler(m).split("\n").length < 400),
    MOCKS_PASTA.filter((m) => ler(m).split("\n").length >= 400).join(", "));
  ok("K3e o index reexporta a API publica",
    ["MOCK_AGENTES", "MOCK_TAREFAS", "MOCK_CONEXOES", "MOCK_FUNCOES", "MOCK_APROVACOES",
     "MOCK_AVISO", "MOCK_CONTAGENS"].every((n) => new RegExp(`\\b${n}\\b`).test(ler("lib/ia/mocks/index.ts"))));
  ok("K3f consumidores importam da fronteira publica, nunca de dentro",
    ARQUIVOS_AREA.filter((a) => !a.startsWith("lib/ia/mocks/"))
      .every((a) => !/@\/lib\/ia\/mocks\//.test(ler(a))),
    ARQUIVOS_AREA.filter((a) => !a.startsWith("lib/ia/mocks/") && /@\/lib\/ia\/mocks\//.test(ler(a))).join(", "));

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
  // ── K9 reconciliado na SKILL-1D.ui-real-state-B ─────────────────
  //
  // O aviso morava no shell e valia para a area toda. Saiu de la quando
  // `/ia/agentes` passou a ler dado real: um aviso global virou falso
  // sobre as telas verdadeiras. Ele desceu para cada tela que ainda
  // simula — a allowlist nominal completa, com igualdade nos dois
  // sentidos, vive em `testar-ia-ui.ts` (F3).
  ok("K9  o aviso de simulacao saiu do shell",
    !/MOCK_AVISO/.test(codigo(ler("app/(app)/ia/layout.tsx"))));
  ok("K9b e desceu para a tela que ainda simula",
    /MOCK_AVISO/.test(codigo(ler("app/(app)/ia/page.tsx"))));
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
  // L8 reconciliado: a barra de progresso saiu da Visao Geral junto com
  // o bloco que a alimentava — ele derivava de uma lista de tarefas
  // vazia e fixa no codigo, e anunciava o resultado como dado real.
  // Onde ha progresso de verdade a exigencia continua identica.
  ok("L8  progresso acessivel onde ha progresso: tarefas e drawer",
    /role="progressbar"/.test(lista) && /aria-valuenow/.test(lista) &&
    /role="progressbar"/.test(ler(DRAWER)) && /aria-valuenow/.test(ler(DRAWER)));
  ok("L8b a Visao Geral nao desenha progresso sem fonte de tarefas",
    !/role="progressbar"/.test(vg));
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
