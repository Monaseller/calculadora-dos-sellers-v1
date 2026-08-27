/**
 * CDS IA — SKILL-1B. Suite do CDS Skill Format v1.
 *
 * Cobre o contrato (dominios fechados e AUSENCIAS estruturais), o
 * pipeline de importacao na ordem em que ele protege, e a distincao que
 * a microcorrecao desta fase introduziu: campo desconhecido inocente e
 * descartado, campo PROIBIDO recusa o arquivo.
 *
 * Prova por EXECUCAO das funcoes puras e por LEITURA DE FONTE. Toda
 * varredura de fonte tem CONTROLE NEGATIVO — sonda que nao acusa nada
 * pode estar quebrada em vez de limpa, e nesta base isso ja aconteceu.
 *
 * Rodar:  npx tsx scripts/testar-ia-skill-1b.ts
 * Sem rede, sem banco, sem IA, sem escrita.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import {
  FORMATO_SUPORTADO,
  ORIGENS_SKILL,
  ROTULO_ORIGEM,
  ehOrigemSkill,
  temVerificacaoPropria,
} from "../lib/ia/skills/contrato";
import {
  LIMITE_BYTES,
  LIMITE_DESCRICAO,
  MARCA_FICHA,
  MARCA_SKILL,
  MOTIVOS_RECUSA,
  acharSegredos,
  extrairBloco,
  importarFicha,
  importarSkill,
} from "../lib/ia/skills/formato";

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

/** Varredura de codigo NAO deve casar com o comentario que a documenta. */
const semComentarios = (fonte: string) =>
  fonte.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

const FONTE_CONTRATO = ler("lib/ia/skills/contrato.ts");
const FONTE_FORMATO = ler("lib/ia/skills/formato.ts");
const CODIGO_CONTRATO = semComentarios(FONTE_CONTRATO);
const CODIGO_FORMATO = semComentarios(FONTE_FORMATO);

// ─── Fixtures ─────────────────────────────────────────────────────────

const SKILL_BASE = {
  formato: 1,
  id: "atendimento-shopee",
  nome: "Atendimento Shopee",
  versao: "0.1.0",
  descricao: "Responde mensagens de compradores.",
  quando_usar: ["comprador enviou mensagem"],
  requer: {
    funcoes: ["mensagens.listar", "mensagens.responder"],
    funcoes_opcionais: ["whatsapp.enviar"],
    conexoes: [{ plataforma: "shopee", recurso: "chat", obrigatoria: true }],
  },
  fichas: ["shopee-chat"],
  origem: "gerada_ia",
};

const FICHA_BASE = {
  formato: 1,
  id: "shopee-chat",
  plataforma: "shopee",
  recurso: "chat",
  versao: "0.1.0",
  verificacao: { em: "2026-08-27", fontes: ["https://open.shopee.com/documents"] },
  requisitos_declarados: ["A plataforma exige access_token renovado periodicamente."],
};

const CORPO = "\n\n# Objetivo\nResponder com precisao, ou escalar.\n";

function arquivoSkill(o: unknown, corpo = CORPO): string {
  return "```" + MARCA_SKILL + "\n" + JSON.stringify(o, null, 2) + "\n```" + corpo;
}
function arquivoFicha(o: unknown, corpo = CORPO): string {
  return "```" + MARCA_FICHA + "\n" + JSON.stringify(o, null, 2) + "\n```" + corpo;
}
/** Copia rasa com um campo trocado — as fixtures nunca sao mutadas. */
function com(extra: Record<string, unknown>): Record<string, unknown> {
  return { ...SKILL_BASE, ...extra };
}
const motivos = (r: { recusas: readonly { motivo: string }[] }) => r.recusas.map((x) => x.motivo);

// ─── A. Inventario ────────────────────────────────────────────────────

secao("A. Inventario da fase — 3 arquivos, nem um a mais");

/**
 * A pasta inteira, nao so o que a 1B criou.
 *
 * `diagnostico.ts` e da SKILL-1C e esta declarado aqui de proposito: o
 * assert continua sendo lista EXATA, entao um arquivo surpresa segue
 * reprovando. Trocar por "contem contrato.ts e formato.ts" tornaria o
 * guarda cego para tudo o mais — que e justamente o que ele vigia.
 */
const ESPERADOS_SKILLS = ["contrato.ts", "diagnostico.ts", "formato.ts"];
const NA_PASTA = existe("lib/ia/skills")
  ? readdirSync(join(RAIZ, "lib/ia/skills")).sort()
  : [];

ok("A1  lib/ia/skills/contrato.ts existe", existe("lib/ia/skills/contrato.ts"));
ok("A2  lib/ia/skills/formato.ts existe", existe("lib/ia/skills/formato.ts"));
ok("A3  a suite existe", existe("scripts/testar-ia-skill-1b.ts"));
ok(
  "A4  a pasta tem EXATAMENTE os 2 modulos autorizados",
  JSON.stringify(NA_PASTA) === JSON.stringify(ESPERADOS_SKILLS),
  NA_PASTA.join(",")
);
ok("A5  nao ha index.ts (nao autorizado nesta fase)", !existe("lib/ia/skills/index.ts"));
ok("A5b controle: a sonda de ausencia enxerga arquivo que existe", existe("lib/ia/skills/formato.ts"));

// ─── B. Pureza dos modulos ────────────────────────────────────────────

secao("B. Pureza — sem I/O, sem rede, sem banco, sem eval");

const PROIBIDOS_EM_LIB: readonly [string, RegExp][] = [
  ["node:fs / readFile", /require\(["']fs["']\)|from ["']node:fs["']|readFileSync/],
  ["rede", /\bfetch\s*\(|XMLHttpRequest|https?:\/\/[a-z]+\.[a-z]+\/\S*["']\s*\)/],
  ["supabase", /createClient|supabase/i],
  ["server-only", /server-only/],
  ["eval/Function", /\beval\s*\(|new Function\s*\(/],
  ["YAML", /\byaml\b|js-yaml|gray-matter/i],
  ["escrita", /\.insert\(|\.update\(|\.delete\(|writeFileSync/],
  ["process.env", /process\.env/],
];

for (const [rotulo, re] of PROIBIDOS_EM_LIB) {
  ok(
    `B   contrato.ts sem ${rotulo}`,
    !re.test(CODIGO_CONTRATO),
    "encontrado em contrato.ts"
  );
  ok(`B   formato.ts sem ${rotulo}`, !re.test(CODIGO_FORMATO), "encontrado em formato.ts");
}
ok(
  "B9  controle: as sondas acima ACUSAM quando o padrao existe",
  PROIBIDOS_EM_LIB.every(([, re]) => re.test("createClient fetch( eval( yaml process.env .insert( readFileSync server-only"))
);
ok("B10 formato.ts usa JSON.parse", /JSON\.parse\(/.test(CODIGO_FORMATO));
ok("B11 contrato.ts nao importa formato.ts", !/skills\/formato/.test(CODIGO_CONTRATO));
ok("B12 formato.ts importa o contrato", /skills\/contrato/.test(CODIGO_FORMATO));

// ─── C. Contrato ──────────────────────────────────────────────────────

secao("C. Contrato — dominios fechados e ausencias estruturais");

ok("C1  FORMATO_SUPORTADO e 1", FORMATO_SUPORTADO === 1);
ok(
  "C2  tres origens, exatamente",
  ORIGENS_SKILL.length === 3 &&
    ["oficial_cds", "importada", "gerada_ia"].every((o) => (ORIGENS_SKILL as readonly string[]).includes(o))
);
ok("C3  toda origem tem rotulo", ORIGENS_SKILL.every((o) => typeof ROTULO_ORIGEM[o] === "string" && ROTULO_ORIGEM[o].length > 0));
ok("C4  ehOrigemSkill aceita valida", ehOrigemSkill("importada"));
ok("C5  ehOrigemSkill recusa invalida", !ehOrigemSkill("qualquer") && !ehOrigemSkill(null) && !ehOrigemSkill(1));
ok("C6  temVerificacaoPropria: ausente -> false", temVerificacaoPropria({ verificacao: undefined }) === false);
ok(
  "C7  temVerificacaoPropria: presente -> true",
  temVerificacaoPropria({ verificacao: { em: "2026-08-27", fontes: ["https://x.com"] } }) === true
);

// As ausencias sao provadas no CODIGO, nao no comentario que as explica.
const CAMPOS_QUE_NAO_EXISTEM = [
  "permissao", "permissoes", "autonomia", "nivel",
  "credencial", "api_key", "handler", "script", "user_id", "agente_id",
];
for (const campo of CAMPOS_QUE_NAO_EXISTEM) {
  ok(
    `C8  contrato nao declara campo \`${campo}\``,
    !new RegExp("^\\s*(readonly\\s+)?" + campo + "\\??\\s*:", "m").test(CODIGO_CONTRATO)
  );
}
ok(
  "C9  controle: a sonda de campo ENXERGA um campo que existe (`descricao`)",
  /^\s*(readonly\s+)?descricao\??\s*:/m.test(CODIGO_CONTRATO)
);
ok(
  "C10 fontesEfetivas NAO existe nesta fase (decisao explicita)",
  !/fontesEfetivas/.test(CODIGO_CONTRATO) && !/fontesEfetivas/.test(CODIGO_FORMATO)
);

// ─── D. Pipeline ──────────────────────────────────────────────────────

secao("D. Pipeline — caminho feliz e cada motivo de recusa");

const rSkill = importarSkill(arquivoSkill(SKILL_BASE));
ok("D1  skill valida e aceita", rSkill.aceito !== null, motivos(rSkill).join(","));
ok("D2  sem recusas e sem descartados", rSkill.recusas.length === 0 && rSkill.descartados.length === 0);
ok("D3  manifesto preserva o id", rSkill.aceito?.manifesto.id === "atendimento-shopee");
ok("D4  corpo capturado depois da cerca", rSkill.aceito?.corpo.startsWith("# Objetivo") === true);
ok("D5  corpo nao inclui o JSON do manifesto", rSkill.aceito?.corpo.includes("\"formato\"") === false);

const rFicha = importarFicha(arquivoFicha(FICHA_BASE));
ok("D6  ficha valida e aceita", rFicha.aceito !== null, motivos(rFicha).join(","));
ok("D7  ficha preserva plataforma/recurso", rFicha.aceito?.manifesto.plataforma === "shopee" && rFicha.aceito?.manifesto.recurso === "chat");

ok("D8  marca errada -> manifesto_ausente", motivos(importarFicha(arquivoSkill(SKILL_BASE)))[0] === "manifesto_ausente");
ok("D9  sem cerca -> manifesto_ausente", motivos(importarSkill("# so prosa"))[0] === "manifesto_ausente");
ok(
  "D10 duas cercas -> manifesto_duplicado (nunca escolhe uma)",
  motivos(importarSkill(arquivoSkill(SKILL_BASE) + "\n" + arquivoSkill(SKILL_BASE)))[0] === "manifesto_duplicado"
);
ok("D11 JSON quebrado -> json_invalido", motivos(importarSkill("```" + MARCA_SKILL + "\n{ x ,\n```"))[0] === "json_invalido");
ok("D12 manifesto array -> json_invalido", motivos(importarSkill("```" + MARCA_SKILL + "\n[1,2]\n```"))[0] === "json_invalido");
ok("D13 formato 2 -> formato_desconhecido", motivos(importarSkill(arquivoSkill(com({ formato: 2 }))))[0] === "formato_desconhecido");
ok("D14 formato ausente -> formato_desconhecido", motivos(importarSkill("```" + MARCA_SKILL + "\n{}\n```"))[0] === "formato_desconhecido");
ok(
  "D15 tamanho acima do limite -> tamanho_excedido",
  motivos(importarSkill(arquivoSkill(SKILL_BASE, "\n" + "x".repeat(LIMITE_BYTES))))[0] === "tamanho_excedido"
);
ok("D16 aceito e null em QUALQUER recusa", importarSkill(arquivoSkill(com({ versao: "1" }))).aceito === null);
ok(
  "D17 recusas ACUMULAM (nao para na primeira)",
  importarSkill(arquivoSkill(com({ versao: "1", descricao: "" }))).recusas.length >= 2
);
ok("D18 todo MotivoRecusa e um valor distinto", new Set(MOTIVOS_RECUSA).size === MOTIVOS_RECUSA.length);
ok("D19 extrairBloco devolve motivo quando falta cerca", extrairBloco("nada", MARCA_SKILL) === "manifesto_ausente");
ok("D20 cerca aberta e nao fechada -> manifesto_ausente", extrairBloco("```" + MARCA_SKILL + "\n{}", MARCA_SKILL) === "manifesto_ausente");

// ─── E. Proibido x desconhecido ───────────────────────────────────────

secao("E. Campo proibido RECUSA; desconhecido inocente e descartado");

const rInocente = importarSkill(arquivoSkill(com({ cor_favorita: "azul" })));
ok("E1  desconhecido inocente: aceito", rInocente.aceito !== null);
ok("E2  desconhecido inocente: reportado em descartados", rInocente.descartados.includes("cor_favorita"));
ok("E3  desconhecido inocente: NAO gera recusa", rInocente.recusas.length === 0);
ok("E4  desconhecido inocente: nao entra no manifesto", !Object.prototype.hasOwnProperty.call(rInocente.aceito?.manifesto ?? {}, "cor_favorita"));

const PROIBIDOS = ["nivel", "autonomia", "permissoes", "permissao", "credencial", "token",
  "access_token", "api_key", "apiKey", "partner_key", "senha", "handler", "script", "codigo",
  "user_id", "userId", "USER_ID", "agente_id", "agenteId"];
for (const campo of PROIBIDOS) {
  const r = importarSkill(arquivoSkill(com({ [campo]: "x" })));
  ok(
    `E5  \`${campo}\` recusa o arquivo`,
    r.aceito === null && motivos(r).includes("campo_proibido"),
    motivos(r).join(",")
  );
}
ok(
  "E6  proibido ANINHADO em requer tambem recusa",
  importarSkill(arquivoSkill(com({ requer: { funcoes: ["a.b"], nivel: "automatico" } }))).aceito === null
);
ok(
  "E7  proibido tem detalhe explicativo, sem valor do campo",
  importarSkill(arquivoSkill(com({ nivel: "automatico" }))).recusas.some(
    (x) => x.motivo === "campo_proibido" && x.detalhe.includes("nivel") && !x.detalhe.includes("automatico")
  )
);
ok(
  "E8  comparacao e por nome NORMALIZADO, nao por substring",
  importarSkill(arquivoSkill(com({ tokens_estimados: 10 }))).aceito !== null
);
ok(
  "E8b controle: `tokens_estimados` ainda e reportado como descartado",
  importarSkill(arquivoSkill(com({ tokens_estimados: 10 }))).descartados.includes("tokens_estimados")
);
ok("E9  a ficha aplica a mesma regra", importarFicha(arquivoFicha({ ...FICHA_BASE, nivel: "x" })).aceito === null);
ok(
  "E10 ficha aceita desconhecido inocente",
  importarFicha(arquivoFicha({ ...FICHA_BASE, observacao: "livre" })).aceito !== null
);

// ─── F. Segredo ───────────────────────────────────────────────────────

secao("F. Segredo — acusa o VALOR, nunca a palavra");

const PROSA = "O recurso usa access_token e refresh_token; a senha do lojista nunca aparece aqui.";
const rProsa = importarFicha(arquivoFicha(FICHA_BASE, "\n\n# Notas\n" + PROSA));
ok("F1  Ficha citando access_token em PROSA e aceita", rProsa.aceito !== null, motivos(rProsa).join(","));
ok("F1b controle: a prosa realmente contem o termo", PROSA.includes("access_token"));

const VALOR = "aB3xK9zQ7mP2wL5tR8";
const AMOSTRAS: readonly [string, string][] = [
  ["atribuicao", `access_token = "${VALOR}"`],
  ["atribuicao com dois pontos", `partner_key: ${VALOR}`],
  ["JWT", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc"],
  ["chave de provedor", "sk-" + "A".repeat(20)],
  ["chave privada", "-----BEGIN RSA PRIVATE KEY-----"],
  ["Authorization", "Bearer " + "A".repeat(24)],
];
for (const [rotulo, amostra] of AMOSTRAS) {
  const r = importarFicha(arquivoFicha(FICHA_BASE, "\n\n# Notas\n" + amostra));
  ok(`F2  ${rotulo} no corpo recusa`, r.aceito === null && motivos(r).includes("segredo_detectado"), motivos(r).join(","));
}
const rEco = importarFicha(arquivoFicha(FICHA_BASE, "\n\n# Notas\n" + `access_token = "${VALOR}"`));
ok("F3  a recusa NAO ecoa o valor encontrado", !JSON.stringify(rEco.recusas).includes(VALOR));
ok("F4  a recusa nomeia o TIPO do achado", rEco.recusas.some((x) => x.detalhe.includes("credencial")));
ok("F5  segredo dentro do MANIFESTO tambem e visto", importarSkill(arquivoSkill(com({ descricao: `token: ${VALOR}` }))).aceito === null);
ok("F6  acharSegredos: controle positivo", acharSegredos("sk-" + "A".repeat(20)).length === 1);
ok("F7  acharSegredos: controle negativo em prosa limpa", acharSegredos(PROSA).length === 0);
// `token`/`secret` isolados entraram na lista de gatilhos. Os tres
// controles abaixo existem para que essa ampliacao nao vire falso
// positivo em texto que uma Ficha legitimamente escreve.
ok("F8  `token` seguido de explicacao NAO e segredo", acharSegredos("token: obtido via OAuth pela CDS").length === 0);
ok("F9  `token` seguido de URL NAO e segredo", acharSegredos("token: https://open.shopee.com/docs").length === 0);
ok("F10 `token: <valor opaco>` E segredo", acharSegredos(`token: ${VALOR}`).length === 1);

// ─── G. Verificacao ───────────────────────────────────────────────────

secao("G. Verificacao — obrigatoria na Ficha, opcional na Skill");

const semVerif = com({});
delete (semVerif as Record<string, unknown>).verificacao;
ok("G1  Skill SEM verificacao e valida", importarSkill(arquivoSkill(semVerif)).aceito !== null);
ok(
  "G2  Skill sem verificacao nao ganha a chave",
  importarSkill(arquivoSkill(semVerif)).aceito?.manifesto.verificacao === undefined
);
ok(
  "G3  Skill COM verificacao valida e aceita",
  importarSkill(arquivoSkill(com({ verificacao: { em: "2026-08-27", fontes: ["https://a.com/b"] } }))).aceito !== null
);
ok(
  "G4  fontes: [] e INVALIDO (afirmacao sem lastro)",
  importarSkill(arquivoSkill(com({ verificacao: { em: "2026-08-27", fontes: [] } }))).aceito === null
);
ok(
  "G5  fonte http:// e recusada (so https)",
  importarSkill(arquivoSkill(com({ verificacao: { em: "2026-08-27", fontes: ["http://a.com"] } }))).aceito === null
);
ok(
  "G6  data fora de AAAA-MM-DD e recusada",
  importarSkill(arquivoSkill(com({ verificacao: { em: "27/08/2026", fontes: ["https://a.com"] } }))).aceito === null
);
const fichaSemVerif: Record<string, unknown> = { ...FICHA_BASE };
delete fichaSemVerif.verificacao;
ok("G7  Ficha SEM verificacao e recusada", importarFicha(arquivoFicha(fichaSemVerif)).aceito === null);
ok(
  "G8  a Skill NAO precisa repetir as fontes da Ficha que referencia",
  importarSkill(arquivoSkill(semVerif)).aceito?.manifesto.fichas?.includes("shopee-chat") === true
);
ok(
  "G9  requisitos_declarados: [] e VALIDO (assimetria proposital com fontes)",
  importarFicha(arquivoFicha({ ...FICHA_BASE, requisitos_declarados: [] })).aceito !== null
);
const fichaSemReq: Record<string, unknown> = { ...FICHA_BASE };
delete fichaSemReq.requisitos_declarados;
ok("G10 requisitos_declarados AUSENTE e recusado", importarFicha(arquivoFicha(fichaSemReq)).aceito === null);

// ─── H. Campos e ids ──────────────────────────────────────────────────

secao("H. Slugs, SemVer e ids de funcao");

const INVALIDOS: readonly [string, Record<string, unknown>][] = [
  ["id com maiuscula", { id: "Atendimento" }],
  ["id com espaco", { id: "atendimento shopee" }],
  ["versao sem patch", { versao: "1.0" }],
  ["versao com prefixo v", { versao: "v1.0.0" }],
  ["nome vazio", { nome: "  " }],
  ["descricao multilinha", { descricao: "linha\nlinha" }],
  ["descricao acima do limite", { descricao: "x".repeat(LIMITE_DESCRICAO + 1) }],
  ["quando_usar vazio", { quando_usar: [] }],
  ["quando_usar nao-array", { quando_usar: "texto" }],
  ["origem invalida", { origem: "inventada" }],
  ["funcao sem ponto", { requer: { funcoes: ["mensagens"] } }],
  ["funcao com maiuscula", { requer: { funcoes: ["Mensagens.listar"] } }],
  ["conexao sem recurso", { requer: { conexoes: [{ plataforma: "shopee", obrigatoria: true }] } }],
  ["conexao sem obrigatoria", { requer: { conexoes: [{ plataforma: "shopee", recurso: "chat" }] } }],
  ["ficha com id invalido", { fichas: ["Shopee Chat"] }],
];
for (const [rotulo, patch] of INVALIDOS) {
  ok(`H   recusa: ${rotulo}`, importarSkill(arquivoSkill(com(patch))).aceito === null);
}
ok(
  "H2  controle: o manifesto base — sem patch — continua ACEITO",
  importarSkill(arquivoSkill(SKILL_BASE)).aceito !== null
);
ok(
  "H3  requer ausente e valido (Skill puramente operacional)",
  importarSkill(arquivoSkill({ ...SKILL_BASE, requer: undefined })).aceito !== null
);
ok(
  "H4  conexao valida sobrevive com os 3 campos",
  importarSkill(arquivoSkill(SKILL_BASE)).aceito?.manifesto.requer?.conexoes?.[0].recurso === "chat"
);

// ─── I. Fronteira desta fase ──────────────────────────────────────────

secao("I. Fronteira — o que a SKILL-1B nao faz");

for (const [rotulo, re] of [
  ["diagnostico de prontidao", /PRONTO|FALTA_FUNCAO|NAO_VERIFICAVEL|BLOQUEADO_POR/],
  ["leitura de conexao real", /\blojas\b|access_token\s*:/],
  ["montagem de prompt", /instrucao\s*:|systemPrompt|montarPrompt/],
  ["biblioteca/persistencia", /\bstorage\b|upload|\bbucket\b/i],
] as const) {
  ok(`I   formato.ts sem ${rotulo}`, !re.test(CODIGO_FORMATO));
  ok(`I   contrato.ts sem ${rotulo}`, !re.test(CODIGO_CONTRATO));
}
ok(
  "I5  controle: essas sondas acusam quando o termo existe",
  /PRONTO|FALTA_FUNCAO/.test("estado PRONTO") && /\bstorage\b/i.test("usa storage")
);

// ─── J. Tripwire de tamanho ───────────────────────────────────────────

secao("J. Tripwire — formato.ts abaixo de 600 linhas");

/**
 * 548 linhas foram aceitas CONSCIENTEMENTE nesta fase, depois que a
 * microcorrecao de campos proibidos cresceu o arquivo. O teto de 600 nao
 * e permissao para encher ate 599: e o ponto em que a divisao de
 * responsabilidade volta a mesa, com gate proprio.
 *
 * O numero e literal, e nao derivado do arquivo, pelo mesmo motivo do
 * inventario de `testar-ia-ui.ts`: um limite calculado a partir do que
 * existe nunca reprova nada.
 */
const LINHAS_FORMATO = FONTE_FORMATO.split("\n").length;
const LINHAS_CONTRATO = FONTE_CONTRATO.split("\n").length;

ok(`J1  formato.ts abaixo de 600 linhas (hoje ${LINHAS_FORMATO})`, LINHAS_FORMATO < 600, String(LINHAS_FORMATO));
ok("J2  controle: o tripwire reprovaria um arquivo de 600", !(600 < 600));
ok("J3  controle: a contagem le o arquivo real, nao um numero fixo", LINHAS_FORMATO > 100);
ok(`J4  contrato.ts permanece o menor dos dois (${LINHAS_CONTRATO})`, LINHAS_CONTRATO < LINHAS_FORMATO);
ok("J5  nao surgiu validacao.ts nem quarto modulo", !existe("lib/ia/skills/validacao.ts"));

// ─── Placar ───────────────────────────────────────────────────────────

console.log(`\n${"═".repeat(66)}`);
console.log(`  ${passou}/${passou + falhou} passaram` + (falhou > 0 ? `  ·  ${falhou} FALHARAM` : ""));
console.log(`${"═".repeat(66)}\n`);
process.exit(falhou > 0 ? 1 : 0);
