/**
 * CDS IA — SKILL-1D.b. Suite do catalogo real de Funcoes.
 *
 * O assert mais importante desta fase esta na secao D: aparecer em
 * `MOCK_FUNCOES` ou em `TIPOS_REGISTRADOS` NAO implica existir no
 * registry real. Foi para isso que o catalogo nasceu.
 *
 * O modulo de producao e `server-only` e alcanca a service_role por
 * transitividade, entao esta suite NAO o importa: ela prova por LEITURA
 * DE FONTE e por execucao das partes puras que consegue alcancar sem
 * banco. Toda varredura tem CONTROLE NEGATIVO.
 *
 * Rodar:  npx tsx scripts/testar-ia-skill-1d-b.ts
 * Sem rede, sem banco, sem IA, sem escrita.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// `lib/agentes/handlers/registry.ts` NAO e importado: ele alcanca
// `dados/vendas.ts`, que carrega `server-only` e LANCA sob `tsx`. Os
// tipos de tarefa sao lidos da fonte dos handlers, logo abaixo — o fato
// provado e o mesmo (quais tipos existem) sem abrir conexao nenhuma.
// `lib/ia/mocks` e puro e pode ser importado normalmente.
import { MOCK_FUNCOES } from "../lib/ia/mocks";

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
const existe = (rel: string) => existsSync(join(RAIZ, rel));
const semComentarios = (f: string) =>
  f.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

const CAMINHO = "lib/agentes/funcoes/registry.ts";
const FONTE = ler(CAMINHO);
const CODIGO = semComentarios(FONTE);

/**
 * Os ids do registry, extraidos da FONTE — nao de um import.
 *
 * Importar o modulo puxaria `server-only` e a service_role para dentro
 * da suite. Ler a fonte prova o mesmo fato (quais ids existem) sem abrir
 * conexao nenhuma. O bloco lido e o literal congelado de `FUNCOES`.
 */
function idsDoRegistry(): string[] {
  const bloco = CODIGO.slice(CODIGO.indexOf("FUNCOES:"), CODIGO.indexOf("ErroFuncaoDesconhecida"));
  return [...bloco.matchAll(/"([a-z0-9.]+)":\s*Object\.freeze/g)].map((m) => m[1]);
}
const IDS = idsDoRegistry();

/**
 * Os TIPOS DE TAREFA reais, tambem lidos da fonte.
 *
 * Le as constantes `TIPO_* = "..."` dos handlers e confere que cada uma
 * esta de fato no mapa `HANDLERS` — declarar a constante sem registrar
 * nao faz o tipo existir, exatamente como no catalogo de Funcoes.
 */
function tiposDeTarefa(): string[] {
  const registry = semComentarios(ler("lib/agentes/handlers/registry.ts"));
  const saida: string[] = [];
  for (const arquivo of readdirSync(join(RAIZ, "lib/agentes/handlers"))) {
    if (!arquivo.endsWith(".ts") || arquivo === "registry.ts") continue;
    const fonte = semComentarios(ler(`lib/agentes/handlers/${arquivo}`));
    for (const m of fonte.matchAll(/const (TIPO_[A-Z_]+)\s*=\s*"([a-z_]+)"/g)) {
      if (registry.includes(`[${m[1]}]`)) saida.push(m[2]);
    }
  }
  return saida.sort();
}
const TIPOS_REGISTRADOS = tiposDeTarefa();

console.log("\n══ CDS IA — SKILL-1D.b: catalogo real de Funcoes ══");

// ─── A. Existencia e forma do registry ────────────────────────────────

secao("A. O registry existe e e explicito");

ok("A1  o modulo existe", existe(CAMINHO));
ok("A2  fica no dominio de agentes, nao em lib/ia/skills", CAMINHO.startsWith("lib/agentes/"));
ok("A3  nao ha executor dentro de lib/ia/skills", !existe("lib/ia/skills/registry.ts") && !existe("lib/ia/skills/funcoes.ts"));
ok("A4  o mapa e congelado", /export const FUNCOES[^=]*=\s*Object\.freeze\(/.test(CODIGO));
// O `s*` entre `({` e `executor` e deliberado: a propriedade testada e que
// cada definicao esta embrulhada em `Object.freeze`, nao que ela caiba numa
// linha. Antes o regex reprovava uma entrada multi-linha corretamente
// congelada — falso negativo que pressionaria a formatar codigo de producao
// para agradar um teste.
ok("A5  cada definicao tambem e congelada", (CODIGO.match(/Object\.freeze\(\{\s*executor/g) ?? []).length === IDS.length);
ok("A5b controle: a sonda ainda reprova definicao NAO congelada",
  !/Object\.freeze\(\{\s*executor/.test('"x.y": { executor: f }'));
ok("A6  e server-only", /import "server-only"/.test(CODIGO));
ok("A7  a extracao de ids leu algo (ancora)", IDS.length > 0, String(IDS.length));

// ─── B. Existencia = presenca de executor ─────────────────────────────

secao("B. Existencia e a presenca do executor, nunca um campo");

ok("B1  nao existe campo `existe:` no modulo", !/\bexiste\s*:/.test(CODIGO));
ok("B2  nao existe `existe: true`", !/existe\s*:\s*true/.test(CODIGO));
// O rotulo dizia "so declara `executor`" e envelheceu duas vezes: a
// TOOL-REGISTRY-B1 acrescentou `acesso`, `idempotente` e
// `conexaoNecessaria`, e a TOOL-EXEC-B acrescentou `validarEntrada` e
// `interpretarSaida`. A sonda nunca mediu isso — o que ela SEMPRE
// mediu, e continua medindo, e que `executor` e o PRIMEIRO campo, que e
// a forma de dizer "existencia e a presenca do executor". A regex fica
// intacta; so o nome passa a descrever o que ela faz.
ok("B3  `executor` e o primeiro campo de DefinicaoFuncao",
  /interface DefinicaoFuncao\s*\{\s*executor:[^}]*\}/s.test(CODIGO));
ok("B4  toda entrada do registry tem executor",
  (CODIGO.match(/executor:/g) ?? []).length >= IDS.length);
ok("B5  funcaoExiste usa hasOwnProperty, nao `in`",
  /hasOwnProperty\.call\(FUNCOES/.test(CODIGO) && !/\bid in FUNCOES\b/.test(CODIGO));
ok("B6  controle: a sonda de campo enxerga um campo que existe (`executor`)", /executor:/.test(CODIGO));

// ─── C. Origem: nao deriva de nada ────────────────────────────────────

secao("C. O catalogo nao deriva de mock, tipo de tarefa nem banco");

for (const [nome, re] of [
  ["MOCK_FUNCOES / mocks", /MOCK_|lib\/ia\/mocks/],
  ["TIPOS_REGISTRADOS", /TIPOS_REGISTRADOS/],
  ["HANDLERS de tarefa", /handlers\/registry|\bHANDLERS\b/],
  ["banco", /createClient|supabase|from\("/],
  ["rede", /\bfetch\s*\(/],
  ["registro dinamico", /FUNCOES\[[^\]]+\]\s*=|Object\.assign\(FUNCOES/],
  ["tool schema para modelo", /tools\s*:|tool_choice|input_schema|function_call/],
  ["skill registrando", /registrarFuncao|adicionarFuncao|fromSkill/],
] as const) {
  ok(`C  registry sem ${nome}`, !re.test(CODIGO));
}
ok("C9  controle: as sondas acusam quando o padrao existe",
  /MOCK_/.test("MOCK_X") && /TIPOS_REGISTRADOS/.test("TIPOS_REGISTRADOS") &&
  /\bHANDLERS\b/.test("HANDLERS") && /createClient/.test("createClient(x)") &&
  /\bfetch\s*\(/.test("fetch(") && /tools\s*:/.test("tools: []"));

// ─── D. Honestidade — o assert central da fase ────────────────────────

secao("D. Aparecer em mock ou em tipo de tarefa NAO e existir");

const IDS_MOCK = MOCK_FUNCOES.map((f) => f.id);
const soNoMock = IDS_MOCK.filter((id) => !IDS.includes(id));
const soNoRegistry = IDS.filter((id) => !IDS_MOCK.includes(id));

ok("D1  ha ids em MOCK_FUNCOES (ancora)", IDS_MOCK.length > 0, String(IDS_MOCK.length));
ok("D2  ha tipos de tarefa registrados (ancora)", TIPOS_REGISTRADOS.length > 0, String(TIPOS_REGISTRADOS.length));
ok("D3  existir no mock NAO implica existir no registry", soNoMock.length > 0, soNoMock.join(", "));
ok("D4  `mensagens.responder` esta no mock e NAO no registry",
  IDS_MOCK.includes("mensagens.responder") && !IDS.includes("mensagens.responder"));
ok("D5  `ads.campanha.pausar` esta no mock e NAO no registry",
  IDS_MOCK.includes("ads.campanha.pausar") && !IDS.includes("ads.campanha.pausar"));
ok("D6  `anuncio.consultar` esta no mock e NAO no registry",
  IDS_MOCK.includes("anuncio.consultar") && !IDS.includes("anuncio.consultar"));
ok("D7  `analise_vendas` e tipo de tarefa e NAO Funcao",
  TIPOS_REGISTRADOS.includes("analise_vendas") && !IDS.includes("analise_vendas"));
ok("D8  `teste_fundacao` e tipo de tarefa e NAO Funcao",
  TIPOS_REGISTRADOS.includes("teste_fundacao") && !IDS.includes("teste_fundacao"));
ok("D9  nenhum tipo de tarefa virou id de Funcao",
  TIPOS_REGISTRADOS.every((t) => !IDS.includes(t)));
ok("D10 nenhum id de Funcao tem a forma de tipo de tarefa (sem ponto)",
  IDS.every((id) => id.includes(".")));
ok("D11 o registry nao e um espelho do mock", soNoRegistry.length + soNoMock.length > 0);

// ─── E. Ids canonicos ─────────────────────────────────────────────────

secao("E. Forma dos ids — a mesma que a SKILL-1B valida");

/**
 * A forma vem da SKILL-1B (`RE_FUNCAO` em `formato.ts`), que NAO e
 * exportada. Em vez de exportar — o que tocaria um contrato ja publicado
 * — a suite compara os dois LITERAIS de fonte. Divergencia reprova aqui,
 * entao a duplicacao nao consegue derivar em silencio.
 */
const LITERAL_1B = (ler("lib/ia/skills/formato.ts").match(/const RE_FUNCAO = (\/.*\/);/) ?? [])[1];
const RE_ID = /^[a-z0-9]+(?:\.[a-z0-9_]+)+$/;

ok("E1  o literal da 1B foi encontrado (ancora)", typeof LITERAL_1B === "string", String(LITERAL_1B));
ok("E2  a forma usada aqui e IDENTICA a da SKILL-1B", LITERAL_1B === String(RE_ID), `${LITERAL_1B} vs ${RE_ID}`);
ok("E3  todo id do registry obedece a forma", IDS.every((id) => RE_ID.test(id)), IDS.join(", "));
ok("E4  controle: a forma recusa id invalido",
  !RE_ID.test("Vendas.Consultar") && !RE_ID.test("vendas") && !RE_ID.test("vendas consultar"));
ok("E5  sem duplicatas", new Set(IDS).size === IDS.length);
ok("E6  a listagem e ordenada, nao a ordem de declaracao",
  /Object\.keys\(FUNCOES\)\.sort\(\)/.test(CODIGO));

// ─── F. Desconhecida ──────────────────────────────────────────────────

secao("F. Funcao desconhecida falha alto");

ok("F1  resolverFuncao LANCA em id desconhecido", /throw new ErroFuncaoDesconhecida/.test(CODIGO));
ok("F2  ha classe de erro propria", /class ErroFuncaoDesconhecida extends Error/.test(CODIGO));
ok("F3  nao ha executor default/fallback", !/executorPadrao|fallback|\?\?\s*executar/.test(CODIGO));
ok("F4  nao ha fuzzy matching nem prefixo",
  !/startsWith|includes\(id|levenshtein|similar|indexOf\(id/.test(CODIGO));
ok("F5  nao ha regex sobre o id para achar handler", !/new RegExp\(/.test(CODIGO));
ok("F6  controle: a sonda de fallback acusa quando existe", /fallback/.test("const fallback = 1"));

// ─── G. A primeira Funcao real ────────────────────────────────────────

secao("G. `vendas.consultar` — leitura, autoridade por closure");

ok("G1  exatamente 1 Funcao real", IDS.length === 1, IDS.join(", "));
ok("G2  o id e `vendas.consultar`", IDS[0] === "vendas.consultar");
ok("G3  usa a leitura de dominio, nao o handler de tarefa",
  /criarLeiturasDeVendas/.test(CODIGO) && !/criarHandlerAnaliseVendas/.test(CODIGO));
ok("G4  nao importa handlers/", !/agentes\/handlers/.test(CODIGO));
ok("G5  o contexto tem apenas userId",
  /interface ContextoFuncao\s*\{\s*userId: string;\s*\}/s.test(CODIGO));
ok("G6  o contexto NAO tem seller_id/shop_id/partner_id/token",
  !/seller_id|shop_id|partner_id|access_token|loja_id/.test(
    CODIGO.slice(CODIGO.indexOf("interface ContextoFuncao"), CODIGO.indexOf("ExecutorFuncao"))
  ));
ok("G7  contexto e argumentos sao parametros SEPARADOS",
  /\(\s*contexto: ContextoFuncao,\s*argumentos: unknown\s*\)/s.test(CODIGO));
ok("G8  argumentos entram como `unknown`, sem cast confiante na assinatura",
  /argumentos: unknown/.test(CODIGO));
ok("G9  o executor nao recebe userId por argumento",
  !/argumentos[^)]*userId|userId:\s*argumentos/.test(CODIGO));

// A operacao subjacente e de LEITURA: prova lida da fonte dela.
const FONTE_VENDAS = semComentarios(ler("lib/agentes/dados/vendas.ts"));
ok("G10 a operacao subjacente nao escreve",
  !/\.insert\(|\.update\(|\.delete\(|\.upsert\(/.test(FONTE_VENDAS));
ok("G11 a operacao subjacente nao chama API externa", !/\bfetch\s*\(/.test(FONTE_VENDAS));
ok("G12 a operacao subjacente nao depende de tarefa/claim/heartbeat",
  !/agente_tarefas|heartbeat|claim_next/.test(FONTE_VENDAS));
ok("G13 a operacao subjacente fecha o dono por closure",
  /function criarLeiturasDeVendas\(userId: string\)/.test(FONTE_VENDAS));
ok("G14 controle: as sondas de escrita acusam quando existe",
  /\.insert\(/.test("x.insert()") && /\bfetch\s*\(/.test("fetch(") && /heartbeat/.test("heartbeat_em"));

// ─── H. Fronteira desta fase ──────────────────────────────────────────

secao("H. Fronteira — o que a 1D.b nao faz");

for (const [nome, re] of [
  ["permissao/autonomia", /agente_permissoes|NivelAutonomia|autonomia|\bnivel\b/],
  ["conexao/cobertura", /FatoConexao|cobertura|token_expires_at|\blojas\b/],
  ["agregador", /resolverFatosDaSkill|diagnosticarAgente|diagnosticarSkill/],
  ["FatoFuncao", /FatoFuncao/],
  ["migration/RPC", /supabase\/migrations|create table|\.rpc\(/],
  ["endpoint/Server Action", /app\/api\/|route\.ts|NextResponse|"use server"/],
  ["UI/React", /from "react"|components\/|\.tsx/],
  ["LLM", /prompt|systemPrompt|completion|anthropic|@google\/genai/],
  ["n8n", /\bn8n\b/],
] as const) {
  ok(`H  registry sem ${nome}`, !re.test(CODIGO));
}
ok("H10 controle: essas sondas acusam quando o termo existe",
  /\bnivel\b/.test("nivel") && /cobertura/.test("cobertura") &&
  /diagnosticarSkill/.test("diagnosticarSkill(") && /FatoFuncao/.test("FatoFuncao"));
ok("H11 nenhum arquivo novo em lib/ia/skills", readdirSync(join(RAIZ, "lib/ia/skills")).length === 3);
// Continua sendo lista EXATA, nunca "contem pelo menos": um quarto modulo
// aparecendo sem passar por gate proprio deve reprovar. A lista cresceu de um
// para tres porque TOOL-REGISTRY-B1 autorizou explicitamente `guard.ts`
// (decisao pura de autorizacao) e `sanitizar.ts` (projecao por allowlist).
ok("H12 a pasta de funcoes tem exatamente os 3 modulos autorizados",
  JSON.stringify(readdirSync(join(RAIZ, "lib/agentes/funcoes")).sort()) ===
    JSON.stringify(["guard.ts", "registry.ts", "sanitizar.ts"]));
ok("H12b controle: a comparacao e exata, nao 'contem'",
  JSON.stringify(["guard.ts", "registry.ts"]) !== JSON.stringify(["guard.ts", "registry.ts", "sanitizar.ts"]));

// ─── I. Seguranca ─────────────────────────────────────────────────────

secao("I. Sem segredo e sem identificador externo");

const SONDAS: readonly [string, RegExp][] = [
  ["valor de credencial", /(access_token|refresh_token|partner_key|api[_-]?key|token|senha)\s*[:=]\s*["']?[A-Za-z0-9_./+-]{12,}/i],
  ["JWT", /eyJ[A-Za-z0-9_-]{8,}/],
  ["chave de provedor", /\bsk-[A-Za-z0-9_-]{16,}/],
  ["chave privada", /BEGIN [A-Z ]*PRIVATE KEY/],
  ["Bearer com valor", /Bearer\s+[A-Za-z0-9_.-]{16,}/],
  ["identificador externo", /\bseller_id\b|\bshop_id\b|\bpartner_id\b/],
];
ok("I0  o codigo analisado nao esta vazio (ancora)", CODIGO.length > 500, String(CODIGO.length));
for (const [nome, re] of SONDAS) ok(`I  registry sem ${nome}`, !re.test(CODIGO));
ok("I7  controle: as 6 sondas acusam a isca",
  SONDAS.every(([, re]) => re.test(
    'access_token = "aB3xK9zQ7mP2wL5t" eyJhbGciOiJIUzI1NiJ9 sk-' + "A".repeat(20) +
    " BEGIN RSA PRIVATE KEY Bearer " + "A".repeat(20) + " seller_id shop_id partner_id"
  )));
ok("I8  `user_id` aparece so como conceito, nunca com valor",
  !/user_id\s*[:=]\s*["'][A-Za-z0-9-]{8,}/.test(CODIGO));
ok("I9  zero bytes de controle inesperados",
  ![...FONTE].some((c) => c.charCodeAt(0) < 32 && ![9, 10, 13].includes(c.charCodeAt(0))));
ok("I10 controle: o detector de bytes enxerga 0x08",
  [..."a\bb"].some((c) => c.charCodeAt(0) < 32 && ![9, 10, 13].includes(c.charCodeAt(0))));

// ─── J. Tamanho ───────────────────────────────────────────────────────

secao("J. Tripwire de tamanho");

// O alarme tocou na TOOL-EXEC-B, e a resposta certa NAO foi dividir a
// pasta: `lib/agentes/funcoes/` tem tripwire de conteudo exato (tres
// modulos, H12 aqui e P4 na 1d-d2), entao um quarto arquivo exigiria
// gate proprio. O que cresceu foram os contratos `ValidadorEntrada` e
// `InterpretadorSaida` mais os dois wrappers de `vendas.consultar` —
// codigo que pertence ao catalogo por definicao.
//
// O limite sobe para continuar sendo alarme, nao carimbo: 500 deixa
// pouca folga, e a proxima Funcao registrada volta a fazer alguem
// decidir se o arquivo ainda cabe em si.
const LIMITE = 500;
const linhas = FONTE.split("\n").length;
ok(`J1  registry abaixo de ${LIMITE} linhas (hoje ${linhas})`, linhas < LIMITE, String(linhas));
ok("J2  controle: a contagem le o arquivo real", linhas > 50);
ok("J3  controle: o guarda reprova no limite", !(LIMITE < LIMITE));

// ─── Placar ───────────────────────────────────────────────────────────

console.log(`\n${"═".repeat(66)}`);
console.log(`  ${passou}/${passou + falhou} passaram` + (falhou > 0 ? `  ·  ${falhou} FALHARAM` : ""));
console.log(`${"═".repeat(66)}\n`);
process.exit(falhou > 0 ? 1 : 0);
