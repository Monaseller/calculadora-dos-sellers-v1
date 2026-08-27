/**
 * CDS IA — SKILL-1D.c. Suite dos fatos reais de conexao.
 *
 * Diferente da SKILL-1D.b: aqui a REGRA e importada e EXECUTADA de
 * verdade. `estado.ts` e puro de proposito justamente para isso — foi a
 * limitacao registrada na fase anterior que motivou a separacao.
 *
 * `fatos.ts` continua `server-only` (le `lojas` com service_role) e por
 * isso e provado por leitura de fonte e analise estrutural. Nenhum mock
 * de `server-only` foi inventado.
 *
 * Rodar:  npx tsx scripts/testar-ia-skill-1d-c.ts
 * Sem rede, sem banco, sem IA, sem escrita.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import {
  MARGEM_EXPIRACAO_MS,
  MARKETPLACE_POR_PLATAFORMA,
  coberturaDoRecurso,
  derivarEstadoConexao,
  montarFatoConexao,
  plataformaDeMarketplace,
  type LinhaConexao,
} from "../lib/agentes/conexoes/estado";
import { diagnosticarSkill } from "../lib/ia/skills/diagnostico";

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

const FONTE_FATOS = ler("lib/agentes/conexoes/fatos.ts");
const CODIGO_FATOS = semComentarios(FONTE_FATOS);
const FONTE_ESTADO = ler("lib/agentes/conexoes/estado.ts");
const CODIGO_ESTADO = semComentarios(FONTE_ESTADO);

// ─── Fixtures ─────────────────────────────────────────────────────────

const AGORA = Date.parse("2026-08-27T12:00:00.000Z");
const emMs = (ms: number) => new Date(AGORA + ms).toISOString();

const linha = (p: Partial<LinhaConexao> = {}): LinhaConexao => ({
  marketplace: "Shopee",
  ativo: true,
  temAccessToken: true,
  token_expires_at: emMs(24 * 3600_000),
  ...p,
});

console.log("\n══ CDS IA — SKILL-1D.c: fatos reais de conexao ══");

// ─── A. Modulos ───────────────────────────────────────────────────────

secao("A. Dois modulos, e so a regra e importavel");

ok("A1  estado.ts existe", existe("lib/agentes/conexoes/estado.ts"));
ok("A2  fatos.ts existe", existe("lib/agentes/conexoes/fatos.ts"));
ok("A3  a pasta tem exatamente 2 modulos",
  JSON.stringify(readdirSync(join(RAIZ, "lib/agentes/conexoes")).sort()) ===
    JSON.stringify(["estado.ts", "fatos.ts"]));
ok("A4  estado.ts NAO e server-only (por isso esta suite o executa)",
  !/server-only/.test(CODIGO_ESTADO));
ok("A5  fatos.ts E server-only", /import "server-only"/.test(CODIGO_FATOS));
ok("A6  a regra nao vive em lib/ia/skills", !existe("lib/ia/skills/conexoes.ts"));
ok("A7  estado.ts nao le banco nem rede",
  !/createClient|getSupabaseServidor|\bfetch\s*\(/.test(CODIGO_ESTADO));
ok("A8  controle: as sondas acusam quando o padrao existe",
  /server-only/.test('import "server-only"') && /getSupabaseServidor/.test("getSupabaseServidor()"));

// ─── B. Plataforma ────────────────────────────────────────────────────

secao("B. Plataforma vem do dado autorizado");

ok("B1  mapa fechado com as duas plataformas reais",
  JSON.stringify(MARKETPLACE_POR_PLATAFORMA) ===
    JSON.stringify({ mercado_livre: "ML", shopee: "Shopee" }));
ok("B2  ML -> mercado_livre", plataformaDeMarketplace("ML") === "mercado_livre");
ok("B3  Shopee -> shopee", plataformaDeMarketplace("Shopee") === "shopee");
ok("B4  marketplace desconhecido -> null", plataformaDeMarketplace("Amazon") === null);
ok("B5  nao-string -> null",
  plataformaDeMarketplace(null) === null && plataformaDeMarketplace(7) === null);
ok("B6  fatos.ts confere a plataforma contra o dado real",
  /linhaBruta\.marketplace !== marketplaceEsperado/.test(CODIGO_FATOS));
ok("B7  plataforma divergente devolve AUSENTE, nao um fato",
  /marketplace !== marketplaceEsperado\) return AUSENTE/.test(CODIGO_FATOS));
ok("B8  plataforma desconhecida nem toca o banco",
  CODIGO_FATOS.indexOf("marketplaceEsperado === null") < CODIGO_FATOS.indexOf(".from(\"lojas\")"));

// ─── C. Estado ────────────────────────────────────────────────────────

secao("C. Estado — regra derivada e executada");

ok("C1  loja valida -> conectada", derivarEstadoConexao(linha(), AGORA) === "conectada");
ok("C2  ativo=false -> desconectada",
  derivarEstadoConexao(linha({ ativo: false }), AGORA) === "desconectada");
ok("C3  sem access_token -> desconectada",
  derivarEstadoConexao(linha({ temAccessToken: false }), AGORA) === "desconectada");
ok("C4  ativo=false vence token valido",
  derivarEstadoConexao(linha({ ativo: false, temAccessToken: true }), AGORA) === "desconectada");
ok("C5  token_expires_at nulo -> expirada (FAIL-CLOSED)",
  derivarEstadoConexao(linha({ token_expires_at: null }), AGORA) === "expirada");
ok("C6  token_expires_at ilegivel -> expirada",
  derivarEstadoConexao(linha({ token_expires_at: "ontem" }), AGORA) === "expirada");
ok("C7  vencido no passado -> expirada",
  derivarEstadoConexao(linha({ token_expires_at: emMs(-1) }), AGORA) === "expirada");
ok("C8  dentro da margem -> expirada",
  derivarEstadoConexao(linha({ token_expires_at: emMs(MARGEM_EXPIRACAO_MS - 1000) }), AGORA) === "expirada");
ok("C9  fora da margem -> conectada",
  derivarEstadoConexao(linha({ token_expires_at: emMs(MARGEM_EXPIRACAO_MS + 1000) }), AGORA) === "conectada");
ok("C10 margem e 300000 ms, como ml-auth e shopee-auth", MARGEM_EXPIRACAO_MS === 300_000);
ok("C11 `erro` NUNCA e produzido",
  (["conectada", "expirada", "desconectada"] as const).includes(
    derivarEstadoConexao(linha({ ativo: null }), AGORA) as "conectada"
  ) && !/["']erro["']/.test(CODIGO_ESTADO));
ok("C12 ativo=null nao e tratado como desconectada",
  derivarEstadoConexao(linha({ ativo: null }), AGORA) === "conectada");

// ─── D. Cobertura ─────────────────────────────────────────────────────

secao("D. Cobertura — sempre nao_verificavel nesta fase");

for (const r of ["chat", "pedidos", "ads", "anuncios", "qualquer_coisa"]) {
  ok(`D  recurso "${r}" -> nao_verificavel`, coberturaDoRecurso(r) === "nao_verificavel");
}
ok("D6  nenhuma regra especial por recurso no codigo",
  !/recurso === ["']|recurso\.includes|switch \(recurso/.test(CODIGO_ESTADO));
ok("D7  controle: a sonda acusa `if (recurso === ...)` quando existe",
  /recurso === ["']/.test('if (recurso === "chat")'));
ok("D8  cobertura nunca e `confirmada`", !/["']confirmada["']/.test(CODIGO_ESTADO));
ok("D9  cobertura nunca e `ausente` sem evidencia", !/["']ausente["']/.test(CODIGO_ESTADO));

// ─── E. Fato montado ──────────────────────────────────────────────────

secao("E. FatoConexao — quatro campos, nem um a mais");

{
  const f = montarFatoConexao("shopee", "chat", linha(), AGORA);
  ok("E1  campos exatos",
    JSON.stringify(Object.keys(f).sort()) ===
      JSON.stringify(["cobertura", "estado", "plataforma", "recurso"]));
  ok("E2  plataforma e recurso preservados", f.plataforma === "shopee" && f.recurso === "chat");
  ok("E3  estado derivado", f.estado === "conectada");
  ok("E4  cobertura nao_verificavel", f.cobertura === "nao_verificavel");

  const bruto = JSON.stringify(f);
  for (const [nome, re] of [
    ["seller_id", /seller_?id/i], ["shop_id", /shop_?id/i], ["partner_id", /partner_?id/i],
    ["partner_key", /partner_?key/i], ["access_token", /access_?token/i],
    ["refresh_token", /refresh_?token/i], ["user_id", /user_?id/i], ["loja_id", /loja_?id/i],
  ] as const) {
    ok(`E5  saida sem ${nome}`, !re.test(bruto));
  }
  ok("E6  controle: a saida serializada nao esta vazia", bruto.length > 40);
  ok("E7  controle: as sondas acusam a isca",
    /seller_?id/i.test("seller_id") && /access_?token/i.test("accessToken"));
}

// ─── F. Determinismo ──────────────────────────────────────────────────

secao("F. Determinismo — o relogio entra por parametro");

ok("F1  estado.ts sem Date.now/Math.random/new Date()",
  !/Date\.now|Math\.random|new Date\(\s*\)/.test(CODIGO_ESTADO));
ok("F2  fatos.ts sem Date.now", !/Date\.now/.test(CODIGO_FATOS));
ok("F3  `agoraMs` e parametro da regra", /agoraMs: number/.test(CODIGO_ESTADO));
ok("F4  `agoraMs` e parametro da entrada", /agoraMs: number/.test(CODIGO_FATOS));
ok("F5  mesmo input + mesmo agora -> saida identica",
  JSON.stringify(montarFatoConexao("shopee", "chat", linha(), AGORA)) ===
    JSON.stringify(montarFatoConexao("shopee", "chat", linha(), AGORA)));
ok("F6  controle: relogio diferente MUDA o resultado (a sonda nao e vacua)",
  derivarEstadoConexao(linha({ token_expires_at: emMs(3600_000) }), AGORA) === "conectada" &&
    derivarEstadoConexao(linha({ token_expires_at: emMs(3600_000) }), AGORA + 7200_000) === "expirada");
ok("F7  recurso diferente nao altera o estado",
  montarFatoConexao("shopee", "chat", linha(), AGORA).estado ===
    montarFatoConexao("shopee", "pedidos", linha(), AGORA).estado);

// ─── G. Autoridade e cross-tenant ─────────────────────────────────────

secao("G. Autoridade — (id, user_id) na propria instrucao");

ok("G1  filtra por id E user_id", /\.eq\("id", lojaId\)/.test(CODIGO_FATOS) && /\.eq\("user_id", String\(userId\)\)/.test(CODIGO_FATOS));
ok("G2  loja de outro dono some na consulta, nao em memoria",
  !/\.user_id ===|linhaBruta\.user_id/.test(CODIGO_FATOS));
ok("G3  user_id nem e projetado", !/COLUNAS = "[^"]*user_id/.test(CODIGO_FATOS));
ok("G4  ausencia de linha -> AUSENTE", /data === null\) return AUSENTE/.test(CODIGO_FATOS));
ok("G5  nao ha mensagem distinguindo dono", !/outro dono|pertence a|nao autorizado/i.test(CODIGO_FATOS));
ok("G6  seller_id/shop_id nao sao projetados",
  !/COLUNAS = "[^"]*(seller_id|shop_id|partner)/.test(CODIGO_FATOS));
ok("G7  a projecao tem 5 colunas",
  (CODIGO_FATOS.match(/const COLUNAS = "([^"]*)"/) ?? ["", ""])[1].split(",").length === 5);
ok("G8  entrada nao aceita segredo nem id externo",
  !/(access_token|refresh_token|partner_key|seller_?[Ii]d|shop_?[Ii]d)/.test(
    CODIGO_FATOS.slice(CODIGO_FATOS.indexOf("interface EntradaFatoConexao"),
                       CODIGO_FATOS.indexOf("export type ColetaConexao"))
  ));
ok("G9  controle: a sonda de projecao le a constante de verdade",
  /const COLUNAS = "id, marketplace, ativo, access_token, token_expires_at"/.test(CODIGO_FATOS));

// ─── H. Segredo ───────────────────────────────────────────────────────

secao("H. O segredo morre na fronteira");

ok("H1  LinhaConexao nao tem campo de token",
  !/access_token|refresh_token|partner_key/.test(
    CODIGO_ESTADO.slice(CODIGO_ESTADO.indexOf("interface LinhaConexao"),
                        CODIGO_ESTADO.indexOf("export function derivarEstadoConexao"))));
ok("H2  LinhaConexao usa boolean, nao o valor", /temAccessToken: boolean/.test(CODIGO_ESTADO));
ok("H3  o token vira boolean em fatos.ts",
  /temAccessToken:\s*\n?\s*typeof linhaBruta\.access_token === "string"/.test(CODIGO_FATOS));
ok("H4  refresh_token nao e projetado", !/COLUNAS = "[^"]*refresh_token/.test(CODIGO_FATOS));
ok("H5  estado.ts nao menciona token no codigo",
  !/access_token|refresh_token|partner_key/.test(CODIGO_ESTADO));
ok("H6  nao ha error.message no retorno", !/error\.message/.test(CODIGO_FATOS));
ok("H7  controle: as sondas de segredo acusam a isca",
  /access_token/.test("access_token") && /error\.message/.test("error.message"));

// ─── I. Erro de coleta ────────────────────────────────────────────────

secao("I. Falha de leitura NAO e ausencia");

ok("I1  ha tres desfechos de coleta",
  /"ok" \| "ausente" \| "falha_leitura"/.test(CODIGO_FATOS));
ok("I2  erro de banco -> falha_leitura", /coleta: "falha_leitura"/.test(CODIGO_FATOS));
ok("I3  falha_leitura NAO devolve fato", /\{ fato: null, coleta: "falha_leitura" \}/.test(CODIGO_FATOS));
ok("I4  ausencia e um desfecho distinto", /const AUSENTE[^=]*= \{ fato: null, coleta: "ausente" \}/.test(CODIGO_FATOS));
ok("I5  erro nao cai em AUSENTE", !/if \(error\)[^}]*return AUSENTE/.test(CODIGO_FATOS));
ok("I6  controle: a sonda distingue os dois literais",
  /falha_leitura/.test('coleta: "falha_leitura"') && !/falha_leitura/.test('coleta: "ausente"'));

// ─── J. Integracao com a SKILL-1C ─────────────────────────────────────

secao("J. O fato alimenta a SKILL-1C sem alterar o motor");

{
  const req = (recurso: string, plataforma = "shopee") =>
    ({ plataforma, recurso, obrigatoria: true } as const);

  // Shopee Chat: conexao valida, cobertura nao verificavel.
  const chat = diagnosticarSkill({
    skill: { id: "atendimento-shopee", requer: { conexoes: [req("chat")] } },
    funcoes: [], permissoes: [],
    conexoes: [montarFatoConexao("shopee", "chat", linha(), AGORA)],
  });
  ok("J1  Shopee Chat -> NAO_VERIFICAVEL", chat.estadoGeral === "NAO_VERIFICAVEL");
  ok("J2  nao vira PRONTO", chat.estadoGeral !== "PRONTO");
  ok("J3  nao vira FALTA_CONEXAO", chat.estadoGeral !== "FALTA_CONEXAO");
  ok("J4  nao vira CONEXAO_INVALIDA", chat.estadoGeral !== "CONEXAO_INVALIDA");

  // ML Ads: idem — token de pedidos nao prova Ads.
  const ads = diagnosticarSkill({
    skill: { id: "ads-ml", requer: { conexoes: [req("ads", "mercado_livre")] } },
    funcoes: [], permissoes: [],
    conexoes: [montarFatoConexao("mercado_livre", "ads", linha({ marketplace: "ML" }), AGORA)],
  });
  ok("J5  ML Ads -> NAO_VERIFICAVEL", ads.estadoGeral === "NAO_VERIFICAVEL");

  // Token expirado -> CONEXAO_INVALIDA, nao FALTA_CONEXAO.
  const expirado = diagnosticarSkill({
    skill: { id: "x", requer: { conexoes: [req("chat")] } },
    funcoes: [], permissoes: [],
    conexoes: [montarFatoConexao("shopee", "chat", linha({ token_expires_at: emMs(-1) }), AGORA)],
  });
  ok("J6  token expirado -> CONEXAO_INVALIDA", expirado.estadoGeral === "CONEXAO_INVALIDA");

  // Sem token -> desconectada -> CONEXAO_INVALIDA (nao FALTA_CONEXAO).
  const semToken = diagnosticarSkill({
    skill: { id: "x", requer: { conexoes: [req("chat")] } },
    funcoes: [], permissoes: [],
    conexoes: [montarFatoConexao("shopee", "chat", linha({ temAccessToken: false }), AGORA)],
  });
  ok("J7  sem token -> CONEXAO_INVALIDA, nao FALTA_CONEXAO",
    semToken.estadoGeral === "CONEXAO_INVALIDA");

  // Fato AUSENTE (nada resolvido) -> FALTA_CONEXAO.
  const ausente = diagnosticarSkill({
    skill: { id: "x", requer: { conexoes: [req("chat")] } },
    funcoes: [], permissoes: [], conexoes: [],
  });
  ok("J8  sem fato -> FALTA_CONEXAO", ausente.estadoGeral === "FALTA_CONEXAO");
  ok("J9  a 1C nao foi alterada",
    !/conexoes\/estado|conexoes\/fatos/.test(ler("lib/ia/skills/diagnostico.ts")));
}

// ─── K. Fronteira desta fase ──────────────────────────────────────────

secao("K. Fronteira — o que a 1D.c nao faz");

for (const [nome, re] of [
  ["refresh de token", /refreshMLToken|refreshShopeeToken|refresh\s*\(|renovar/i],
  ["OAuth", /oauth|auth_partner|code_challenge/i],
  ["chamada a marketplace", /mercadolibre|shopee\.com|\/api\/v2\/|\bfetch\s*\(/],
  ["escrita", /\.insert\(|\.update\(|\.delete\(|\.upsert\(/],
  ["migration/RPC", /supabase\/migrations|create table|\.rpc\(/],
  ["permissao", /agente_permissoes|NivelAutonomia|autonomia/],
  ["Funcao nova", /agentes\/funcoes|FUNCOES|resolverFuncao/],
  ["agregador", /resolverFatosDaSkill|diagnosticarAgente/],
  ["UI/React", /from "react"|components\//],
  ["LLM", /prompt|completion|systemPrompt|anthropic|@google\/genai/],
  ["n8n", /\bn8n\b/i],
] as const) {
  ok(`K  fatos.ts sem ${nome}`, !re.test(CODIGO_FATOS));
  ok(`K  estado.ts sem ${nome}`, !re.test(CODIGO_ESTADO));
}
ok("K12 controle: as sondas acusam quando o termo existe",
  /\bn8n\b/i.test("n8n") && /\.rpc\(/.test(".rpc(") && /refreshMLToken/.test("refreshMLToken()"));
ok("K13 registry de Funcoes intocado", !existe("lib/agentes/funcoes/estado.ts"));
ok("K14 nenhum modulo novo em lib/ia/skills",
  readdirSync(join(RAIZ, "lib/ia/skills")).length === 3);

// ─── L. Tamanho ───────────────────────────────────────────────────────

secao("L. Tripwire de tamanho");

const LIMITE = 400;
for (const [nome, fonte] of [["estado.ts", FONTE_ESTADO], ["fatos.ts", FONTE_FATOS]] as const) {
  const n = fonte.split("\n").length;
  ok(`L  ${nome} abaixo de ${LIMITE} linhas (hoje ${n})`, n < LIMITE, String(n));
}
ok("L3  controle: a contagem le arquivo real", FONTE_FATOS.split("\n").length > 50);
ok("L4  controle: o guarda reprova no limite", !(LIMITE < LIMITE));

// ─── Placar ───────────────────────────────────────────────────────────

console.log(`\n${"═".repeat(66)}`);
console.log(`  ${passou}/${passou + falhou} passaram` + (falhou > 0 ? `  ·  ${falhou} FALHARAM` : ""));
console.log(`${"═".repeat(66)}\n`);
process.exit(falhou > 0 ? 1 : 0);
