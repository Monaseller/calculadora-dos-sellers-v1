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

import { ABAS, PENDENCIA_ABA } from "../lib/ia/abas";
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
  "lib/ia/mocks/atividade.ts",
  "lib/ia/mocks/capabilities.ts",
  "lib/ia/mocks/conexoes.ts",
  "lib/ia/mocks/index.ts",
  "lib/ia/mocks/tarefas.ts",
];

/**
 * O que sobrou da UI-1C.b: os tres cards apresentacionais.
 *
 * As tres abas que os montavam foram apagadas na
 * SKILL-1D.ui-real-state-Bg2 — ver `ABAS_APAGADAS_BG2` logo abaixo.
 */
const NOVOS_1CB = [
  "components/ia/conexoes/CardConexao.tsx",
  "components/ia/capabilities/CardFuncao.tsx",
  "components/ia/capabilities/SeletorAutonomia.tsx",
];

/**
 * As cascas de aba que a Bg2 removeu. Ficam declaradas NOMINALMENTE, e
 * a suite cobra que continuem inexistentes: um arquivo com esse nome
 * reaparecendo significa que alguem recriou a aba sem passar pela
 * decisao de `implementada`.
 */
const ABAS_APAGADAS_BG2 = [
  "components/ia/agente/AbaConexoes.tsx",
  "components/ia/agente/AbaFuncoes.tsx",
  "components/ia/agente/AbaPermissoes.tsx",
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
// As frases que esta area NAO pode usar como estado dinamico: sem fonte
// que as sustente, sao hardcode hoje verdadeiro e mentira convincente no
// dia em que a fonte chegar com conteudo.
const FRASE_DE_VAZIO =
  /Nenhuma conex[aã]o atribu[ií]da|Nenhuma fun[cç][aã]o habilitada|Nenhuma permiss[aã]o configurada/i;

/** As tres abas que a Bg2 devolveu para `implementada: false`. */
const PENDENTES_BG2 = ["conexoes", "funcoes", "permissoes"] as const;

const PAGINA_AGENTE = ler("components/ia/agente/PaginaAgente.tsx");
const ABAS_TS = ler("lib/ia/abas.ts");

// ═══════════════════════════════════════════════════════════════════════
console.log("\n══ CDS IA — UI-1C.b: conexoes, funcoes e permissoes ══");

secao("A. Inventario da fase");

{
  ok("A1  os 3 cards da fase continuam existindo",
    NOVOS_1CB.every((a) => ARQUIVOS_AREA.includes(a)),
    NOVOS_1CB.filter((a) => !ARQUIVOS_AREA.includes(a)).join(", "));
  ok("A1b as 3 cascas de aba NAO existem mais",
    ABAS_APAGADAS_BG2.every((a) => !ARQUIVOS_AREA.includes(a)),
    ABAS_APAGADAS_BG2.filter((a) => ARQUIVOS_AREA.includes(a)).join(", "));
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
  // ── D3–D6 reconciliados na SKILL-1D.ui-real-state-Bg2 ───────────
  //
  // A UI-1C.b promoveu as tres a implementadas porque elas ganharam
  // componente proprio com conteudo. O conteudo era simulado, e a
  // ui-real-state-B o removeu — sobrou uma aba anunciada como pronta
  // que abria um "Em breve", sem o ponto na barra e com o placeholder
  // montado tres vezes.
  //
  // `implementada` voltou a significar uma coisa so: a funcionalidade
  // existe. Os asserts inverteram junto, e continuam nominais.
  ok("D3  conexoes, funcoes e permissoes voltaram a pendentes",
    PENDENTES_BG2.every((id) => ABAS.find((a) => a.id === id)?.implementada === false));
  ok("D4  as seis pendentes sao exatamente estas",
    ABAS.filter((a) => !a.implementada).map((a) => a.id).join(",") ===
    "chat,conexoes,funcoes,permissoes,memoria,custos");

  const pag = codigo(PAGINA_AGENTE);
  ok("D5  a pagina NAO monta componente proprio para as tres",
    !/AbaConexoes|AbaFuncoes|AbaPermissoes/.test(pag));
  ok("D6  nem por comparacao explicita com o id da aba",
    PENDENTES_BG2.every((id) => !new RegExp(`aba === "${id}"`).test(pag)));
  ok("D6b CONTROLE: a sonda acha o caminho proprio de quem TEM um",
    /aba === "tarefas"/.test(pag) && /aba === "visao-geral"/.test(pag));
  ok("D7  EmBreve continua para as pendentes, e so uma vez",
    /EmBreve/.test(pag) && (pag.match(/<EmBreve/g) ?? []).length === 1);
  ok("D8  as tres declaram pendencia e descricao para o dono",
    PENDENTES_BG2.every((id) =>
      new RegExp(`\\b${id}:`).test(ABAS_TS) && new RegExp(`\\b${id}:`).test(PAGINA_AGENTE)));
  // ── O texto e lido pelo DONO ────────────────────────────────────
  //
  // Nome de tabela, de rota ou de modulo nao dizem nada a ele e ainda
  // expoem forma interna do sistema. A sonda vale para TODAS as
  // pendencias e para TODAS as descricoes, nao so para as tres que a
  // Bg2 escreveu: a regra e do texto que aparece na tela, nao de quem o
  // escreveu por ultimo.
  const INTERNALS =
    /agente_conexoes|agente_permissoes|agente_skills|supabase|\brota\b|endpoint|\bAPI\b|autenticad[ao]|backend|user_id|agregador|\bRPC\b|\btabela\b/i;

  const sujas: string[] = ABAS.filter((a) => !a.implementada)
    .map((a) => a.id as string)
    .filter((id) => INTERNALS.test((PENDENCIA_ABA as Record<string, string>)[id] ?? ""));

  // ── A divida de copy fechou ──────────────────────────────────────
  //
  // Por dois gates esta guarda carregou uma allowlist nominal: `custos`
  // dizia "nao ha rota autenticada que as leia por dono" e `chat` dizia
  // "nao existe endpoint, provedor nem historico" — vocabulario de
  // infraestrutura em texto que o DONO le, os dois escritos na UI-1C.a.
  //
  // A allowlist cumpriu o papel dela: manteve as duas visiveis ate
  // serem corrigidas, em vez de deixa-las envelhecer caladas. `custos`
  // saiu na SKILL-1D.ui-real-state-C, `chat` na Cg — e a lista some
  // junto, porque excecao que sobrevive ao motivo vira permissao.
  //
  // A regra agora e simples e sem escapatoria: NENHUMA pendencia fala
  // de infraestrutura. `D9b` cobra a ausencia da propria allowlist,
  // para que reintroduzi-la seja uma decisao visivel e nao um remendo.
  ok("D9  nenhuma pendencia fala de infraestrutura ao dono",
    sujas.length === 0, sujas.join(", "));
  // Os nomes sao montados em pedacos de proposito: a sonda le o PROPRIO
  // arquivo, e um literal inteiro aqui casaria consigo mesmo — a guarda
  // reprovaria por existir, que e o oposto de guardar alguma coisa.
  const NOMES_DE_EXCECAO = new RegExp(
    [["VAZAMENTOS", "CONHECIDOS"].join("_"),
     ["COPY", "TOLERADA"].join("_"),
     ["PENDENCIA", "LEGADA"].join("_")].join("|"));
  ok("D9b nao existe allowlist de excecao para copy user-facing",
    !NOMES_DE_EXCECAO.test(codigo(ler("scripts/testar-ia-ui-1cb.ts"))));
  ok("D9b2 CONTROLE: a sonda acharia a allowlist de volta",
    NOMES_DE_EXCECAO.test(`const ${["VAZAMENTOS", "CONHECIDOS"].join("_")} = ["chat"];`));
  ok("D9c toda pendencia e um texto de produto, com corpo",
    ABAS.filter((a) => !a.implementada).every(
      (a) => ((PENDENCIA_ABA as Record<string, string>)[a.id] ?? "").length > 40));
  ok("D9d a descricao que o dono le tambem nao expoe internals",
    !INTERNALS.test(
      PAGINA_AGENTE.slice(PAGINA_AGENTE.indexOf("const DESCRICAO_ABA"))));
  ok("D9e CONTROLE: a sonda acha o vocabulario que as duas copies tinham",
    INTERNALS.test("falta a rota autenticada que leia agente_conexoes") &&
    INTERNALS.test("nao existe endpoint, provedor nem historico") &&
    !INTERNALS.test("falta conectar esta aba aos custos reais de uso de IA deste agente") &&
    !INTERNALS.test("falta conectar esta aba as conversas reais do agente"));
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
  // ── E12 reconciliado na SKILL-1D.ui-real-state-B ────────────────
  //
  // "Usada por" era derivado, nunca digitado — e continuava sendo uma
  // lista de contas que nao existem, exibida na aba de um agente REAL.
  // A derivacao correta de um dado ficticio permanece ficcao.
  //
  // `MOCK_FUNCOES_DA_CONEXAO` continua existindo e continua testado
  // logo abaixo (E13/E14): o que saiu foi o CONSUMO na aba do agente.
  // E12: a aba que consumia `MOCK_FUNCOES_DA_CONEXAO` nao existe mais.
  // A invariavel migrou para onde ela ainda pode ser violada — a
  // experiencia real do agente.
  ok("E12 nenhuma superficie de agente consome mock de conexao",
    !/MOCK_CONEXOES|MOCK_FUNCOES_DA_CONEXAO/.test(
      codigo(PAGINA_AGENTE) + codigo(ler("components/ia/agente/VisaoGeral.tsx"))));
  ok("E13 MOCK_FUNCOES_DA_CONEXAO filtra por conexaoNecessaria",
    MOCK_FUNCOES_DA_CONEXAO("cx-ml").every((f) => f.conexaoNecessaria === "cx-ml"));
  ok("E14 conexao sem funcao dependente nao quebra",
    MOCK_FUNCOES_DA_CONEXAO("cx-inexistente").length === 0);

  // E15 reconciliado: o Link para `/ia/conexoes` morava na aba e saiu
  // com ela. Nao foi reposto de proposito — `EmBreve` nao aceita acao
  // (C8/C10 da suite 1c existem para que nao aceite), e a tela global
  // de conexoes tambem e um `EmBreve`: o link levaria de um "em breve" a
  // outro. A pendencia diz em TEXTO onde a configuracao vai morar.
  ok("E15 a pendencia de conexoes diz onde a configuracao vai morar",
    /conta CDS/.test(ABAS_TS));
  ok("E16 NAO ha acao de conectar/reconectar/desconectar na area do agente",
    !/(Reconectar|Desconectar|Adicionar conexão|OAuth|autorizar)/i.test(codigo(PAGINA_AGENTE)));
  ok("E17 controle negativo: a sonda acharia um botao de reconectar",
    /(Reconectar|Desconectar)/i.test("<button>Reconectar</button>"));
  // E18 reconciliado: a divida de credenciais e da tela GLOBAL de
  // conexoes, que mexe em credencial — nao desta aba, que so atribuiria
  // uma conexao ja existente. Ela era citada aqui porque a aba
  // descrevia contas; sem contas descritas, a citacao virou assunto
  // alheio. A constante continua sendo a fonte unica do texto.
  ok("E18 a divida de credenciais continua declarada em constante unica",
    DIVIDA_CREDENCIAIS.length > 40 && /DIVIDA_CREDENCIAIS/.test(CONCEITOS));
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
  // ── F5 reconciliado na SKILL-1D.ui-real-state-B ─────────────────
  //
  // A legenda ensinava "Disponivel" x "Permitida" antes dos cards, e
  // era o melhor pedaco daquela tela. Ela existia PARA os cards; sem
  // funcao alguma listada, ensinar a diferenca entre dois selos que
  // ninguem vera e ruido. O conceito continua vivo e cobrado em
  // `conceitos.ts` (F3/F4) e no proprio card (F8).
  // F5: sem aba propria, a invariavel e que NENHUMA superficie do
  // agente lista funcao — nem simulada, nem o catalogo executavel real,
  // que responderia "o que o sistema sabe fazer" no lugar de "o que
  // ESTE agente pode fazer".
  ok("F5  nenhuma superficie de agente lista funcao",
    !/MOCK_FUNCOES/.test(codigo(PAGINA_AGENTE) + codigo(ler("components/ia/agente/VisaoGeral.tsx"))) &&
    !/CATALOGO|capabilities\/registry/.test(codigo(PAGINA_AGENTE)));

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
  // F17 reconciliado: nao ha o que ordenar enquanto nao ha lista. A
  // ordem "o que existe antes do que nao existe" volta com a fonte.
  // F17: nao ha o que ordenar enquanto nao ha lista. A ordem "o que
  // existe antes do que nao existe" volta com a fonte, e com a aba.
  ok("F17 nao ha catalogo ordenado na pagina do agente",
    !/sort\(/.test(codigo(PAGINA_AGENTE)));
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
  // ── G8 reconciliado na SKILL-1D.ui-real-state-B ─────────────────
  //
  // "Nenhuma decisao desta tela e gravada" era o primeiro elemento da
  // pagina, e era honesto. Deixou de ser suficiente: com um agente REAL
  // ao lado, quatro linhas dizendo `automatico`/`bloqueado` viravam a
  // resposta aparente para "o que este agente pode fazer" — a pergunta
  // mais importante que esta area inteira responde. Nao ha mais decisao
  // a gravar porque nao ha mais decisao exibida.
  ok("G8  a pagina nao exibe nivel nem autonomia sem onde grava-los",
    !/MOCK_PERMISSOES|MOCK_NIVEL_DA_FUNCAO|SeletorAutonomia/.test(codigo(PAGINA_AGENTE)));
  ok("G9  nao ha botao Salvar na pagina do agente",
    !/>\s*(Salvar|Aplicar|Confirmar)\s*</.test(codigo(PAGINA_AGENTE)));
  ok("G10 nenhum controle acionavel nas superficies pendentes",
    !/<input|<select|<textarea|onChange/.test(codigo(ler("components/ia/EmBreve.tsx"))));
  ok("G11 nem onClick", !/onClick/.test(codigo(ler("components/ia/EmBreve.tsx"))));

  // G12 reconciliado: "Exige aprovacao" era um NIVEL exibido por
  // funcao. Sem niveis, apontar para a fila daqui prometeria um fluxo
  // de aprovacao por funcao que nao existe. A fila continua sendo a
  // porta unica, e continua cobrada na suite dela.
  ok("G12 a pagina do agente nao promete fluxo de aprovacao por funcao",
    !/\/ia\/aprovacoes/.test(codigo(PAGINA_AGENTE)) && !/Exige aprova/.test(codigo(PAGINA_AGENTE)));
  ok("G13 NAO ha Aprovar/Recusar na pagina do agente",
    !/>\s*(Aprovar|Recusar)\s*</.test(PAGINA_AGENTE));
  // G14: a distincao bloqueada x indisponivel era ensinada na aba. Sem
  // aba, ela e ensinada na descricao que o dono le no "Em breve" — o
  // conceito nao pode sumir junto com o componente.
  ok("G14 a descricao pendente ainda separa 'pode' de 'existe'",
    /sozinho e o que precisa de autoriza/i.test(PAGINA_AGENTE));
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
    ["SQL", /\bselect\b[^;\n]{0,80}\bfrom\b|\binsert\s+into\b|\bdelete\s+from\b/i],
    ["migration", /supabase\/migrations|apply_migration|create table|alter table/i],
    ["rota de API", /app\/api\/|route\.ts|NextResponse|export async function (GET|POST|PUT|PATCH|DELETE)/],
    // A sonda exige VALOR, nunca a palavra. Uma Ficha de Integracao
    // precisa poder DOCUMENTAR autenticacao ("a API usa access_token",
    // "envie Authorization: Bearer <token>") sem ser tratada como
    // vazamento — isso e requisito de produto, nao tolerancia. O que
    // reprova e a credencial em si. Semantica equivalente a de
    // `lib/ia/skills/formato.ts`, que precisou da mesma distincao.
    ["segredo", /\b(?:access_token|refresh_token|partner_key|client_secret|api[_-]?key|token|secret|senha)\b\s*[:=]\s*["']?[A-Za-z0-9_\-./+]{12,}|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.|\bsk-[A-Za-z0-9_-]{16,}|-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9_\-.]{16,}/i],
    ["identificador externo", /\bseller_id\b|\bshop_id\b|\bpartner_id\b/],
    ["identificador de dono", /\buser_id\b|\bloja_id\b/],
    ["viewport em JS", /window\.innerWidth|addEventListener\("resize"|matchMedia/],
  ];

  const isca = [
    'createClient(supabase)', 'fetch("/x")', 'process.env.X', 'anthropic()',
    'import x from "@/lib/marketplace/credenciais"', 'n8n webhook',
    'lib/agentes/dados/vendas', 'select * from pedidos',
    'supabase/migrations/x.sql', 'export async function GET()',
    'access_token = "aB3xK9zQ7mP2wL5tR8"', 'seller_id', 'user_id', 'window.innerWidth',
  ].join("\n");

  let mortas = 0;
  for (const [nome, p] of sondas) {
    if (!p.test(isca)) { mortas++; console.log(`        SONDA MORTA: ${nome}`); }
  }
  ok("I0  controle negativo: as 14 sondas acusam a isca", mortas === 0, `${mortas} mortas`);
  // A sonda de segredo mudou de semantica nesta fase: passou a exigir
  // VALOR. Os controles abaixo provam os dois lados — que ela continua
  // viva para credencial real, e que nao reprova documentacao.
  {
    const sondaSegredo = sondas.find(([n]) => n === "segredo")![1];
    const DOC =
      "A API usa access_token e refresh_token. Envie Authorization: Bearer <token>. " +
      "A API key vem de Conexoes, nunca da Skill.";
    ok("Is1 segredo: prosa documental NAO dispara", !sondaSegredo.test(DOC));
    ok("Is2 segredo: valor atribuido dispara", sondaSegredo.test('access_token = "aB3xK9zQ7mP2wL5tR8"'));
    ok("Is3 segredo: JWT sintetico dispara", sondaSegredo.test("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.aZ"));
    ok("Is4 segredo: Bearer com valor dispara", sondaSegredo.test("Bearer " + "A".repeat(24)));
    ok("Is5 segredo: chave sk- dispara", sondaSegredo.test("sk-" + "A".repeat(20)));
    ok("Is6 segredo: bloco PRIVATE KEY dispara", sondaSegredo.test("-----BEGIN RSA PRIVATE KEY-----"));
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
    ok(`I  ${permitidos.length === 0 ? "zero" : "so o autorizado tem"} ${nome}`,
      sujos.length === 0 && sumidos.length === 0,
      [...sujos, ...sumidos.map((a) => `${a} (sumiu)`)].join(", "));
  }
}

secao("I2. Orfaos autorizados");

{
  // ── Por que esta secao existe ────────────────────────────────────
  //
  // A SKILL-1D.ui-real-state-B tirou os mocks das tres abas, e com isso
  // `CardConexao`, `CardFuncao` e `SeletorAutonomia` perderam o unico
  // consumidor de producao. A Bg2 apagou as abas e nao apagou os cards:
  // eles sao apresentacionais, estao testados nas secoes E, F e G desta
  // suite, e voltam quando conexoes e permissoes tiverem fonte real.
  //
  // Componente sem consumidor e uma das coisas que apodrecem em
  // silencio. Entao ele deixa de ser silencio: a lista e NOMINAL e a
  // igualdade vale nos dois sentidos — um quarto orfao reprova, e um
  // destes tres voltando a ser importado tambem reprova, para que a
  // volta seja notada e a lista, reconciliada.
  //
  // "Ser reutilizavel" nao e o mesmo que "estar ligado": nenhum destes
  // tres significa que Conexoes, Funcoes ou Permissoes existam.
  const ORFAOS_AUTORIZADOS: readonly string[] = [
    "components/ia/conexoes/CardConexao.tsx",
    "components/ia/capabilities/CardFuncao.tsx",
    "components/ia/capabilities/SeletorAutonomia.tsx",
  ];

  // Um componente e "importado" quando alguem cita o especificador dele.
  // Comparar pelo CAMINHO, e nao pelo nome exportado: nome solto casa
  // com comentario, com string e com outro simbolo homonimo.
  const importadoPor = (alvo: string) => {
    const espec = `"@/${alvo.replace(/\.tsx$/, "")}"`;
    return ARQUIVOS_AREA.filter((a) => a !== alvo && ler(a).includes(espec));
  };

  const componentes = ARQUIVOS_AREA.filter(
    (a) => a.startsWith("components/ia/") && a.endsWith(".tsx"));
  const semConsumidor = componentes.filter((a) => importadoPor(a).length === 0);

  const inesperados = semConsumidor.filter((a) => !ORFAOS_AUTORIZADOS.includes(a));
  const religados = ORFAOS_AUTORIZADOS.filter((a) => !semConsumidor.includes(a));

  ok("I2.1 nenhum componente sem consumidor alem dos autorizados",
    inesperados.length === 0, inesperados.join(", "));
  ok("I2.2 e todo autorizado continua realmente sem consumidor",
    religados.length === 0, religados.map((a) => `${a} (religado)`).join(", "));
  ok("I2.3 ANCORA: a varredura enxergou componentes de verdade",
    componentes.length > 15, String(componentes.length));
  ok("I2.4 CONTROLE: a sonda enxerga quem TEM consumidor",
    importadoPor("components/ia/EmBreve.tsx").length > 0 &&
    importadoPor("components/ia/BadgeEstado.tsx").length > 0);
  ok("I2.5 os tres orfaos seguem cobertos por assert nesta suite",
    ORFAOS_AUTORIZADOS.every((a) => ARQUIVOS_AREA.includes(a)) &&
    [CARD_CX, CARD_FN, SELETOR].every((f) => f.length > 500));
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
  // ── J7 reconciliado na SKILL-1D.ui-real-state-B ─────────────────
  //
  // Exigia a tarja nas tres abas. A exigencia INVERTEU: elas nao tem
  // mais o que simular, entao exibir "Dados simulados" anunciaria uma
  // simulacao inexistente — e o aviso so vale enquanto significa
  // alguma coisa. A allowlist nominal das superficies que AINDA avisam,
  // com igualdade nos dois sentidos, vive em `testar-ia-ui.ts` (F3).
  // ── J7 na sua terceira forma ────────────────────────────────────
  //
  // UI-1C.b: "as tres abas exibem o aviso de simulacao".
  // ui-real-state-B: "as tres abas nao consomem mock".
  // Bg2: as tres abas nao existem — a invariavel mudou de arquivo, nao
  // de conteudo. O que ela sempre protegeu foi a EXPERIENCIA do agente.
  const SUPERFICIES_DO_AGENTE = [
    "components/ia/agente/PaginaAgente.tsx",
    "components/ia/agente/VisaoGeral.tsx",
    "components/ia/office/PainelAgente.tsx",
    "components/ia/EmBreve.tsx",
  ];
  ok("J7  nenhuma superficie do agente consome mock ou avisa simulacao",
    SUPERFICIES_DO_AGENTE.every((a) => !/MOCK_/.test(codigo(ler(a)))));
  ok("J7b e nenhuma delas afirma um vazio que ninguem consultou",
    SUPERFICIES_DO_AGENTE.every((a) => !FRASE_DE_VAZIO.test(codigo(ler(a)))) &&
    !FRASE_DE_VAZIO.test(codigo(ABAS_TS)));
  ok("J7c CONTROLE: a sonda acha o consumo de mock e a frase de vazio",
    /MOCK_/.test('import { MOCK_AVISO } from "@/lib/ia/mocks";') &&
    FRASE_DE_VAZIO.test("<p>Nenhuma permissão configurada</p>"));
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
  const pendente = ler("components/ia/EmBreve.tsx");
  ok("K1  nenhuma falsa affordance nos 6 componentes",
    novos.every((f) => !/<button|<input|<select|onChange/.test(codigo(f))));
  // K2 na sua terceira forma: a exigencia e de quem TEM link, e nenhuma
  // das superficies pendentes tem — `EmBreve` nao aceita acao, de
  // proposito. A regra continua valendo para os tres cards, que voltam
  // a ter link quando voltarem a ser montados.
  const temFocoSeTemLink = (f: string) => !/<Link/.test(f) || /:focus-visible/.test(f);
  ok("K2  todo componente com Link tem foco visivel",
    [...novos, pendente].every(temFocoSeTemLink));
  ok("K2b CONTROLE: componente com Link e sem foco visivel reprovaria",
    !temFocoSeTemLink("<Link href=\"/x\">ir</Link>"));
  // K3 reconciliado: o `<h3` de cada aba continua obrigatorio. O `<h4`
  // titulava CADA FUNCAO da lista de permissoes; sem lista, exigir um
  // subnivel seria pedir heading sem conteudo debaixo dele.
  // K3: o heading das tres superficies pendentes agora vem do proprio
  // `EmBreve`, num lugar so — que e metade do motivo de as cascas terem
  // saido.
  ok("K3  a superficie pendente tem heading proprio", /<h2/.test(pendente));
  ok("K4  cards tem aria-label descritivo", /aria-label=/.test(CARD_CX));
  // K5 reconciliado: a associacao acontecia entre o seletor e o nome da
  // funcao na aba. O seletor guarda a regra e continua cobrado por ela;
  // a aba nao passa mais rotulo nenhum porque nao lista funcao.
  ok("K5  o seletor de niveis segue associado a um rotulo",
    /aria-labelledby/.test(SELETOR));
  ok("K5b nenhuma superficie de agente usa mais o seletor",
    !/SeletorAutonomia|idRotulo/.test(codigo(PAGINA_AGENTE)));
  ok("K6  estado nunca so por cor: icone + texto em conexao e funcao",
    /aria-hidden="true"/.test(CARD_CX) && /aria-hidden="true"/.test(CARD_FN));
  // K7 reconciliado: as duas abas nao tem mais grade porque nao tem
  // mais cards. A proibicao de medir viewport em JavaScript, que e a
  // parte que vale para a area inteira, continua valendo para os seis.
  ok("K7  nenhuma medicao de viewport em JavaScript nos seis componentes",
    novos.every((f) => !/innerWidth|resize|matchMedia/.test(f)));
  ok("K7b onde ainda ha grade, ela e responsiva por CSS",
    /repeat\(auto-fit/.test(SELETOR));
  ok("K8  nada na area do agente vira tabela horizontal",
    !/<table/.test(PAGINA_AGENTE) && !/<table/.test(pendente));
  ok("K9  texto longo nao estoura o container",
    /overflow-wrap:\s*anywhere/.test(CARD_FN));
}

// ═══════════════════════════════════════════════════════════════════════
console.log(`\n══ CDS IA — UI-1C.b: conexoes, funcoes e permissoes:  ${passou}/${passou + falhou} passaram ══`);
if (falhou > 0) {
  console.log(`   ${falhou} FALHARAM`);
  process.exit(1);
}
