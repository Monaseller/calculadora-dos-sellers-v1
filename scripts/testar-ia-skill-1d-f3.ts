/**
 * CDS IA — SKILL-1D.f.3-A. Suite do write path de Skills.
 *
 * ── Por que esta suite EXECUTA um modulo `server-only` ──────────────
 *
 * A 1D.f.2 provou `fatos.ts` so por leitura de fonte, e a razao estava
 * escrita la: inventar um mock de Supabase provaria o mock. Aqui a
 * exigencia e outra e nao admite prova estrutural — e preciso demonstrar
 * que, quando a segunda barreira de segredo dispara, NENHUMA escrita
 * acontece. "O codigo tem um `return` antes do `.insert(`" e leitura de
 * texto; "o cliente nao recebeu chamada nenhuma" e comportamento.
 *
 * Entao o cliente Supabase e substituido por um duplo que REGISTRA cada
 * operacao — `from`, `select`, `insert`, `delete`, `eq` — e devolve
 * respostas roteirizadas. O que se afirma nao e "o fake funciona": e
 * quantas chamadas o codigo real fez, com que payload, em que tabela, e
 * com quais filtros. O duplo e o instrumento de medida, nunca o objeto
 * medido.
 *
 * Precedentes seguidos, nenhum inventado: `_server-only-inerte` (a
 * condicao `react-server` que o tsx nao ativa) e o duplo de
 * `Module.prototype.require` das suites de ML.
 *
 * Rodar:  npx tsx scripts/testar-ia-skill-1d-f3.ts
 * Sem rede, sem banco, sem IA, sem escrita real.
 */
import "./_server-only-inerte";

import Module from "node:module";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { FORMATO_SUPORTADO } from "../lib/ia/skills/contrato";
import { acharSegredos, importarSkill, LIMITE_BYTES, MOTIVOS_RECUSA } from "../lib/ia/skills/formato";
import type { MotivoRecusa } from "../lib/ia/skills/formato";

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

const FONTE = ler("lib/agentes/skills/escrita.ts");
const CODIGO = semComentarios(FONTE);

// ─── O duplo do cliente Supabase ──────────────────────────────────────

interface Chamada {
  tabela: string;
  op: string;
  colunas?: string;
  payload?: unknown;
  filtros: Record<string, unknown>;
}

interface Resposta {
  data?: unknown;
  error?: { code?: string } | null;
}

let respostas: Resposta[] = [];
let chamadas: Chamada[] = [];
let consumidas = 0;
let excedeuRoteiro = false;

/** Zera o registro e carrega as respostas que o banco fingira dar, na
 *  ordem em que o codigo real as pedir. */
function roteiro(...rs: Resposta[]): void {
  respostas = rs;
  chamadas = [];
  consumidas = 0;
  excedeuRoteiro = false;
}

function construtor(tabela: string): unknown {
  const c: Chamada = { tabela, op: "?", filtros: {} };
  const b: Record<string, unknown> = {
    select(cols: string) {
      c.colunas = cols;
      if (c.op === "?") c.op = "select";
      return b;
    },
    insert(payload: unknown) {
      c.op = "insert";
      c.payload = payload;
      return b;
    },
    delete() {
      c.op = "delete";
      return b;
    },
    eq(coluna: string, valor: unknown) {
      c.filtros[coluna] = valor;
      return b;
    },
    // O `await` do codigo real cai aqui. A chamada so e registrada neste
    // ponto: montar um builder e nao aguarda-lo nao seria uma operacao.
    then(resolver: (v: { data: unknown; error: unknown }) => void) {
      chamadas.push(c);
      const r = respostas[consumidas++];
      if (!r) {
        excedeuRoteiro = true;
        resolver({ data: null, error: { code: "ROTEIRO-VAZIO" } });
        return;
      }
      resolver({ data: r.data ?? null, error: r.error ?? null });
    },
  };
  return b;
}

const clienteFake = { from: (tabela: string) => construtor(tabela) };

// Instalado ANTES de `escrita.ts` entrar no grafo — o import do modulo
// sob teste e dinamico, mais abaixo, exatamente por isso.
const requireOriginal = (Module as unknown as { prototype: { require: (id: string) => unknown } }).prototype.require;
let interceptouCliente = false;
(Module as unknown as { prototype: { require: unknown } }).prototype.require = function (this: unknown, id: string) {
  if (typeof id === "string" && id.includes("supabase-servidor")) {
    interceptouCliente = true;
    return { getSupabaseServidor: () => clienteFake };
  }
  // eslint-disable-next-line prefer-rest-params
  return requireOriginal.apply(this, arguments as unknown as [string]);
};

// ─── Fixtures ─────────────────────────────────────────────────────────

const MANIFESTO_BASE: Record<string, unknown> = {
  formato: FORMATO_SUPORTADO,
  id: "atendimento-shopee",
  nome: "Atendimento Shopee",
  versao: "1.0.0",
  descricao: "Uma linha.",
  quando_usar: ["cliente pergunta sobre pedido"],
  origem: "importada",
};

const CORPO_PADRAO = "Responda em ate 4 horas.";

const textoSkill = (p: Record<string, unknown> = {}, corpo = CORPO_PADRAO): string =>
  "```cds-skill\n" + JSON.stringify({ ...MANIFESTO_BASE, ...p }, null, 2) + "\n```\n\n" + corpo + "\n";

const TEXTO_VALIDO = textoSkill();
const HASH_VALIDO = createHash("sha256").update(TEXTO_VALIDO, "utf8").digest("hex");

const USER = "user-sintetico-f3";
const AGENTE = "11111111-2222-3333-4444-555555555555";
const SKILL = "99999999-8888-7777-6666-555555555555";

/**
 * O caso que justifica a SEGUNDA barreira existir.
 *
 * O parser varre o texto BRUTO. Aqui o valor esta escrito com escapes
 * unicode de JSON: no arquivo le-se `sk-AAA...`, que nenhum
 * padrao de segredo casa. Depois do `JSON.parse` o campo vale
 * `sk-AAA...` — e e ESSA forma, ja serializada de volta, que iria para o
 * banco. Sem a segunda varredura, uma chave de provedor entraria na
 * tabela tendo passado por uma deteccao que olhou para o texto errado.
 */
const SEGREDO_APOS_PARSE = "\\u0073\\u006b-" + "A".repeat(20);
const TEXTO_SEGREDO_ESCAPADO =
  "```cds-skill\n" +
  "{\n" +
  '  "formato": 1,\n' +
  '  "id": "atendimento-shopee",\n' +
  '  "nome": "Atendimento Shopee",\n' +
  `  "descricao": "${SEGREDO_APOS_PARSE}",\n` +
  '  "versao": "1.0.0",\n' +
  '  "quando_usar": ["cliente pergunta sobre pedido"],\n' +
  '  "origem": "importada"\n' +
  "}\n" +
  "```\n\n" +
  CORPO_PADRAO +
  "\n";

console.log("\n══ CDS IA — SKILL-1D.f.3-A: write path de Skills ══");

// ─── A. Fronteira da pasta ────────────────────────────────────────────

secao("A. O terceiro modulo, e a fronteira leitura/escrita");

ok("A1  escrita.ts existe", existe("lib/agentes/skills/escrita.ts"));
ok("A2  a pasta tem exatamente 3 modulos",
  JSON.stringify(readdirSync(join(RAIZ, "lib/agentes/skills")).sort()) ===
    JSON.stringify(["escrita.ts", "estado.ts", "fatos.ts"]));
ok("A3  escrita.ts E server-only", /import "server-only"/.test(CODIGO));
ok("A4  o caminho de LEITURA nao depende do de escrita",
  !/skills\/escrita/.test(ler("lib/agentes/skills/fatos.ts")) &&
  !/skills\/escrita/.test(ler("lib/agentes/skills/estado.ts")));
ok("A5  CONTROLE: a sonda de dependencia acha quando o padrao existe",
  /skills\/escrita/.test('from "@/lib/agentes/skills/escrita"'));

// ─── B. O parser e a porta unica ──────────────────────────────────────

secao("B. Parser, hash e vocabulario — sem tocar no modulo ainda");

ok("B1  usa importarSkill", /\bimportarSkill\(/.test(CODIGO));
ok("B2  usa acharSegredos", /\bacharSegredos\(/.test(CODIGO));
ok("B3  usa createHash de node:crypto",
  /from "node:crypto"/.test(CODIGO) && /createHash\("sha256"\)/.test(CODIGO));
ok("B4  nao ha parser alternativo (nenhuma cerca reimplementada)",
  !/```/.test(CODIGO) && !/cds-skill/.test(CODIGO));
ok("B5  nao aceita manifesto/corpo prontos de fora",
  !/manifesto\s*[:?]\s*ManifestoSkill/.test(CODIGO.replace(/JSON\.parse\(manifestoJson\) as ManifestoSkill/g, "")));
ok("B6  nao introduz validador de UUID",
  !/\[0-9a-f\]\{8\}|uuidv?4|isUUID|validarUuid/i.test(CODIGO));
ok("B7  nunca le error.message", !/error\.message|erro\.message/.test(CODIGO));
ok("B8  o hash e do texto BRUTO, antes do parser",
  CODIGO.indexOf("createHash") < CODIGO.indexOf("importarSkill("));

const iBarreira = CODIGO.indexOf("acharSegredos(");
const iInsert = CODIGO.indexOf(".insert(");
ok("B9  a segunda barreira vem ANTES de qualquer insert", iBarreira > 0 && iInsert > 0 && iBarreira < iInsert);

// ─── C. A partir daqui o modulo real e executado ──────────────────────

async function principal(): Promise<void> {
  const escrita = await import("../lib/agentes/skills/escrita");
  const { importarEPersistirSkill, associarSkillAoAgente, desassociarSkillDoAgente } = escrita;

  secao("C. O instrumento de medida esta mesmo instalado");

  ok("C1  ANCORA: o duplo interceptou o cliente Supabase", interceptouCliente);
  const carregados = Object.keys(require.cache).map((p) => p.replace(/\\/g, "/"));
  ok("C2  ANCORA: escrita.ts esta no grafo", carregados.some((p) => p.includes("/lib/agentes/skills/escrita.ts")));
  ok("C3  nenhum cliente Supabase real carregado",
    !carregados.some((p) => /@supabase|supabase-servidor/.test(p)));

  // Controle positivo do proprio instrumento: um caminho que DEVE
  // escrever produz chamada registrada. Sem isto, todo "0 chamadas"
  // abaixo poderia estar medindo um duplo que nunca registra nada.
  roteiro({ data: [] }, { data: [{ id: SKILL }] });
  const controle = await importarEPersistirSkill({ userId: USER, texto: TEXTO_VALIDO });
  ok("C4  CONTROLE POSITIVO: caminho feliz registra 2 operacoes",
    controle.estado === "criada" && chamadas.length === 2);
  ok("C5  CONTROLE POSITIVO: a segunda operacao e um INSERT em skills",
    chamadas[1]?.op === "insert" && chamadas[1]?.tabela === "skills");

  // ─── D. Guards ──────────────────────────────────────────────────────

  secao("D. Guards — sem autoridade nao ha pergunta ao banco");

  for (const [rot, entrada] of [
    ["userId vazio", { userId: "", texto: TEXTO_VALIDO }],
    ["texto vazio", { userId: USER, texto: "" }],
    ["ambos vazios", { userId: "", texto: "" }],
  ] as const) {
    roteiro();
    const r = await importarEPersistirSkill(entrada);
    ok(`D1 importar com ${rot} -> entrada_invalida`, r.estado === "entrada_invalida");
    ok(`D2 importar com ${rot} -> ZERO operacao`, chamadas.length === 0);
  }

  for (const [rot, entrada] of [
    ["userId vazio", { userId: "", agenteId: AGENTE, skillId: SKILL }],
    ["agenteId vazio", { userId: USER, agenteId: "", skillId: SKILL }],
    ["skillId vazio", { userId: USER, agenteId: AGENTE, skillId: "" }],
  ] as const) {
    roteiro();
    const a = await associarSkillAoAgente(entrada);
    ok(`D3 associar com ${rot} -> entrada_invalida`, a.estado === "entrada_invalida");
    ok(`D4 associar com ${rot} -> ZERO operacao`, chamadas.length === 0);

    roteiro();
    const d = await desassociarSkillDoAgente(entrada);
    ok(`D5 desassociar com ${rot} -> entrada_invalida`, d.estado === "entrada_invalida");
    ok(`D6 desassociar com ${rot} -> ZERO operacao`, chamadas.length === 0);
  }

  // ─── E. Recusa do parser ────────────────────────────────────────────

  secao("E. Os 8 motivos do parser — recusa sem escrever");

  const casos: readonly (readonly [MotivoRecusa, string])[] = [
    ["tamanho_excedido", textoSkill({}, "x".repeat(LIMITE_BYTES + 10))],
    ["manifesto_ausente", "so prosa, sem cerca nenhuma"],
    ["manifesto_duplicado", TEXTO_VALIDO + "\n" + TEXTO_VALIDO],
    ["json_invalido", "```cds-skill\n{ isto nao e json\n```\n\ncorpo"],
    ["formato_desconhecido", textoSkill({ formato: 2 })],
    ["campo_invalido", textoSkill({ versao: "nao-e-semver" })],
    ["campo_proibido", textoSkill({ nivel: 3 })],
    ["segredo_detectado", textoSkill({}, "use sk-" + "B".repeat(20))],
  ];

  const vistos = new Set<string>();
  for (const [motivo, texto] of casos) {
    roteiro();
    const r = await importarEPersistirSkill({ userId: USER, texto });
    const recusada = r.estado === "recusada";
    ok(`E1 ${motivo} -> recusada`, recusada);
    ok(`E2 ${motivo} -> motivo correto no envelope`,
      recusada && (r as { motivos: readonly MotivoRecusa[] }).motivos.includes(motivo));
    ok(`E3 ${motivo} -> ZERO operacao no banco`, chamadas.length === 0);
    if (recusada) for (const m of (r as { motivos: readonly MotivoRecusa[] }).motivos) vistos.add(m);
  }

  ok("E4 os 8 motivos do vocabulario foram exercitados",
    MOTIVOS_RECUSA.every((m) => vistos.has(m)), `faltaram: ${MOTIVOS_RECUSA.filter((m) => !vistos.has(m)).join(", ")}`);
  ok("E5 so sai vocabulario fechado — nenhuma string livre",
    [...vistos].every((m) => (MOTIVOS_RECUSA as readonly string[]).includes(m)));

  // ─── F. A segunda barreira ──────────────────────────────────────────

  secao("F. Segunda barreira de segredo — a que o parser nao pega");

  const importado = importarSkill(TEXTO_SEGREDO_ESCAPADO);
  ok("F1  ANCORA: o parser ACEITA este texto",
    importado.aceito !== null, importado.recusas.map((r) => r.motivo).join(","));
  ok("F2  ANCORA: o texto BRUTO nao acusa segredo algum",
    acharSegredos(TEXTO_SEGREDO_ESCAPADO).length === 0);
  ok("F3  ANCORA: o conteudo A PERSISTIR acusa chave de provedor",
    importado.aceito !== null &&
      acharSegredos(`${JSON.stringify(importado.aceito.manifesto)}\n${importado.aceito.corpo}`).length > 0);

  // Nenhuma resposta roteirizada: se o codigo tentar falar com o banco,
  // a chamada fica registrada e o assert abaixo reprova.
  roteiro();
  const errosCapturados: string[] = [];
  const errOriginal = console.error;
  console.error = (...args: unknown[]) => { errosCapturados.push(args.map(String).join(" ")); };
  const rSegredo = await importarEPersistirSkill({ userId: USER, texto: TEXTO_SEGREDO_ESCAPADO });
  console.error = errOriginal;

  ok("F4  segredo apos o parse -> recusada", rSegredo.estado === "recusada");
  ok("F5  motivo e segredo_detectado",
    rSegredo.estado === "recusada" && rSegredo.motivos.includes("segredo_detectado"));
  ok("F6  PROVA COMPORTAMENTAL: ZERO operacao no banco", chamadas.length === 0);
  ok("F7  em particular, ZERO insert", !chamadas.some((c) => c.op === "insert"));
  ok("F8  o log registrou o TIPO do achado", errosCapturados.some((l) => /chave de provedor/.test(l)));
  ok("F9  o log NAO contem o valor do segredo",
    !errosCapturados.some((l) => /sk-A{16,}/.test(l) || l.includes("A".repeat(20))));
  ok("F10 o log nao despeja manifesto nem corpo",
    !errosCapturados.some((l) => l.includes(CORPO_PADRAO) || l.includes("atendimento-shopee")));

  // ─── G. Payload persistido ──────────────────────────────────────────

  secao("G. O que exatamente vai para a tabela");

  roteiro({ data: [] }, { data: [{ id: SKILL }] });
  const rCriada = await importarEPersistirSkill({ userId: USER, texto: TEXTO_VALIDO });
  const insercao = chamadas.find((c) => c.op === "insert");
  const payload = (insercao?.payload ?? {}) as Record<string, unknown>;

  ok("G1  estado criada com o id devolvido pelo banco",
    rCriada.estado === "criada" && (rCriada as { skillId: string }).skillId === SKILL);
  ok("G2  as 8 colunas exatas, nem uma a mais",
    JSON.stringify(Object.keys(payload).sort()) ===
      JSON.stringify(["conteudo_hash", "corpo", "manifesto", "nome", "origem", "slug", "user_id", "versao"]));
  ok("G3  vigente NAO e enviado — o DEFAULT do banco decide", !("vigente" in payload));
  ok("G4  user_id e o da entrada", payload.user_id === USER);
  ok("G5  slug vem de manifesto.id", payload.slug === MANIFESTO_BASE.id);
  ok("G6  versao vem do manifesto", payload.versao === MANIFESTO_BASE.versao);
  ok("G7  nome vem do manifesto", payload.nome === MANIFESTO_BASE.nome);
  ok("G8  origem preservada como declarada", payload.origem === MANIFESTO_BASE.origem);
  ok("G9  corpo e o corpo do arquivo", payload.corpo === CORPO_PADRAO);
  ok("G10 conteudo_hash e SHA-256 do texto bruto", payload.conteudo_hash === HASH_VALIDO);
  ok("G11 hash tem 64 chars hex minusculos", /^[0-9a-f]{64}$/.test(String(payload.conteudo_hash)));
  ok("G12 o texto BRUTO nao e persistido em coluna alguma",
    !Object.values(payload).some((v) => typeof v === "string" && v.includes("```")));
  ok("G13 nenhuma coluna de agente entra em skills",
    !("agente_id" in payload) && !("agenteId" in payload));

  // ─── H. TOCTOU ──────────────────────────────────────────────────────

  secao("H. Validado e escrito sao o MESMO conteudo");

  const referencia = importarSkill(TEXTO_VALIDO);
  ok("H1  o manifesto escrito e identico ao que o parser validou",
    referencia.aceito !== null &&
      JSON.stringify(payload.manifesto) === JSON.stringify(referencia.aceito.manifesto));
  ok("H2  o corpo escrito e identico ao validado",
    referencia.aceito !== null && payload.corpo === referencia.aceito.corpo);
  ok("H3  o payload que chegou ao banco PASSA na barreira de segredo",
    acharSegredos(`${JSON.stringify(payload.manifesto)}\n${String(payload.corpo)}`).length === 0);
  ok("H4  o modulo serializa antes de escrever (janela fechada)",
    /JSON\.stringify\(importado\.aceito\.manifesto\)/.test(CODIGO) &&
    /JSON\.parse\(manifestoJson\)/.test(CODIGO));
  ok("H5  CONTROLE: a sonda de barreira acusa um payload sujo",
    acharSegredos(`{"descricao":"sk-${"C".repeat(20)}"}`).length > 0);

  // ─── I. Identidade, idempotencia e conflito ─────────────────────────

  secao("I. Identidade (user_id, slug, versao)");

  ok("I1  a leitura de identidade filtra pelas 3 colunas",
    JSON.stringify(chamadas[0]?.filtros) ===
      JSON.stringify({ user_id: USER, slug: MANIFESTO_BASE.id, versao: MANIFESTO_BASE.versao }));
  ok("I2  a leitura nao traz manifesto nem corpo de volta",
    chamadas[0]?.colunas === "id, conteudo_hash");

  roteiro({ data: [{ id: SKILL, conteudo_hash: HASH_VALIDO }] });
  const rIgual = await importarEPersistirSkill({ userId: USER, texto: TEXTO_VALIDO });
  ok("I3  mesma versao + MESMO hash -> ja_existia", rIgual.estado === "ja_existia");
  ok("I4  ja_existia devolve o id da linha existente",
    (rIgual as { skillId?: string }).skillId === SKILL);
  ok("I5  ja_existia NAO insere e NAO atualiza",
    chamadas.length === 1 && !chamadas.some((c) => c.op === "insert"));

  roteiro({ data: [{ id: SKILL, conteudo_hash: "f".repeat(64) }] });
  const rConflito = await importarEPersistirSkill({ userId: USER, texto: TEXTO_VALIDO });
  ok("I6  mesma versao + hash DIFERENTE -> conflito_versao", rConflito.estado === "conflito_versao");
  ok("I7  conflito nao vaza skillId", !("skillId" in rConflito));
  ok("I8  conflito nao escreve nada", chamadas.length === 1);

  roteiro({ data: [] }, { data: [{ id: "outro-id" }] });
  const rOutraVersao = await importarEPersistirSkill({ userId: USER, texto: textoSkill({ versao: "2.0.0" }) });
  ok("I9  outra versao do mesmo slug e uma linha NOVA",
    rOutraVersao.estado === "criada" &&
      (chamadas.find((c) => c.op === "insert")?.payload as Record<string, unknown>)?.versao === "2.0.0");

  roteiro({ data: [{ id: SKILL, conteudo_hash: HASH_VALIDO }, { id: "outro", conteudo_hash: HASH_VALIDO }] });
  const rAmbiguo = await importarEPersistirSkill({ userId: USER, texto: TEXTO_VALIDO });
  ok("I10 duas linhas para a mesma identidade -> falha_escrita, nunca 'a primeira'",
    rAmbiguo.estado === "falha_escrita");

  // ─── J. A corrida ───────────────────────────────────────────────────

  secao("J. Corrida na importacao — 23505 e UMA releitura");

  roteiro({ data: [] }, { error: { code: "23505" } }, { data: [{ id: SKILL, conteudo_hash: HASH_VALIDO }] });
  const rCorridaIgual = await importarEPersistirSkill({ userId: USER, texto: TEXTO_VALIDO });
  ok("J1  23505 + mesmo hash -> ja_existia", rCorridaIgual.estado === "ja_existia");
  ok("J2  o id vem da releitura", (rCorridaIgual as { skillId?: string }).skillId === SKILL);
  ok("J3  exatamente 3 operacoes: le, tenta, rele", chamadas.length === 3);
  ok("J4  ZERO retry de INSERT", chamadas.filter((c) => c.op === "insert").length === 1);
  ok("J5  a releitura usa a mesma identidade",
    JSON.stringify(chamadas[2]?.filtros) === JSON.stringify(chamadas[0]?.filtros));

  roteiro({ data: [] }, { error: { code: "23505" } }, { data: [{ id: SKILL, conteudo_hash: "a".repeat(64) }] });
  const rCorridaDif = await importarEPersistirSkill({ userId: USER, texto: TEXTO_VALIDO });
  ok("J6  23505 + hash diferente -> conflito_versao", rCorridaDif.estado === "conflito_versao");
  ok("J7  ainda assim, um unico INSERT", chamadas.filter((c) => c.op === "insert").length === 1);

  roteiro({ data: [] }, { error: { code: "23505" } }, { data: [] });
  const rCorridaVazia = await importarEPersistirSkill({ userId: USER, texto: TEXTO_VALIDO });
  ok("J8  23505 com releitura vazia -> falha_escrita, sem inventar estado",
    rCorridaVazia.estado === "falha_escrita");

  // ─── K. Demais erros ────────────────────────────────────────────────

  secao("K. SQLSTATE sem significado de dominio");

  for (const codigo of ["23514", "42501", "08006", undefined]) {
    roteiro({ data: [] }, { error: { code: codigo } });
    const r = await importarEPersistirSkill({ userId: USER, texto: TEXTO_VALIDO });
    ok(`K1 insert com ${codigo ?? "erro sem codigo"} -> falha_escrita`, r.estado === "falha_escrita");
  }

  roteiro({ error: { code: "42501" } });
  const rLeitura = await importarEPersistirSkill({ userId: USER, texto: TEXTO_VALIDO });
  ok("K2  falha na LEITURA nao tenta inserir",
    rLeitura.estado === "falha_escrita" && !chamadas.some((c) => c.op === "insert"));

  roteiro({ data: [] }, { data: [] });
  const rSemId = await importarEPersistirSkill({ userId: USER, texto: TEXTO_VALIDO });
  ok("K3  insert sem id de retorno -> falha_escrita, nunca 'criada' sem skillId",
    rSemId.estado === "falha_escrita");

  // ─── L. Associacao ──────────────────────────────────────────────────

  secao("L. Associacao — pin exato, owner-closed, idempotente");

  roteiro({ data: null });
  const aOk = await associarSkillAoAgente({ userId: USER, agenteId: AGENTE, skillId: SKILL });
  ok("L1  associacao valida -> associada", aOk.estado === "associada");
  ok("L2  escreve em agente_skills", chamadas[0]?.tabela === "agente_skills");
  ok("L3  o payload leva as 3 colunas de autoridade",
    JSON.stringify(Object.keys((chamadas[0]?.payload ?? {}) as object).sort()) ===
      JSON.stringify(["agente_id", "skill_id", "user_id"]));
  ok("L4  o skill_id vai EXATO, sem resolucao",
    ((chamadas[0]?.payload ?? {}) as Record<string, unknown>).skill_id === SKILL);
  ok("L5  uma unica operacao — nenhum lookup previo", chamadas.length === 1);
  ok("L6  nao consulta skills para 'descobrir' a versao",
    !chamadas.some((c) => c.tabela === "skills"));

  for (const [codigo, esperado] of [
    ["23505", "ja_associada"],
    ["23503", "nao_disponivel"],
    ["23514", "falha_escrita"],
    ["42501", "falha_escrita"],
  ] as const) {
    roteiro({ error: { code: codigo } });
    const r = await associarSkillAoAgente({ userId: USER, agenteId: AGENTE, skillId: SKILL });
    ok(`L7 associar com ${codigo} -> ${esperado}`, r.estado === esperado);
  }

  ok("L8  as 4 causas de 23503 caem num estado so — sem oraculo",
    /SQLSTATE_FK\) return \{ estado: "nao_disponivel" \}/.test(CODIGO));

  // ─── M. Desassociacao ───────────────────────────────────────────────

  secao("M. Desassociacao — exata, idempotente, e a Skill sobrevive");

  roteiro({ data: [{ skill_id: SKILL }] });
  const dOk = await desassociarSkillDoAgente({ userId: USER, agenteId: AGENTE, skillId: SKILL });
  ok("M1  associacao existente -> desassociada", dOk.estado === "desassociada");
  ok("M2  opera em agente_skills, nunca em skills",
    chamadas[0]?.tabela === "agente_skills" && !chamadas.some((c) => c.tabela === "skills"));
  ok("M3  e um DELETE", chamadas[0]?.op === "delete");
  ok("M4  filtro TRIPLO exato",
    JSON.stringify(chamadas[0]?.filtros) ===
      JSON.stringify({ user_id: USER, agente_id: AGENTE, skill_id: SKILL }));
  ok("M5  uma unica operacao — nenhuma consulta previa de existencia", chamadas.length === 1);

  roteiro({ data: [] });
  const dAusente = await desassociarSkillDoAgente({ userId: USER, agenteId: AGENTE, skillId: SKILL });
  ok("M6  associacao ausente -> nao_associada (idempotente)", dAusente.estado === "nao_associada");
  ok("M7  ausencia tambem nao consulta antes", chamadas.length === 1);

  roteiro({ error: { code: "42501" } });
  const dErro = await desassociarSkillDoAgente({ userId: USER, agenteId: AGENTE, skillId: SKILL });
  ok("M8  erro de banco -> falha_escrita", dErro.estado === "falha_escrita");

  // ─── N. O que o modulo nao faz ──────────────────────────────────────

  secao("N. Zero promocao, zero RPC, zero delete de Skill");

  // `.update(` cru casaria com `createHash("sha256").update(texto)` — a
  // sonda ingenua reprovaria o hash. Entao ela conta: existe UM, e ele e
  // o do digest. Um segundo `.update(` — o do Supabase — reprova.
  ok("N1  o unico .update( e o do hash, nenhum no cliente Supabase",
    (CODIGO.match(/\.update\(/g) ?? []).length === 1 &&
      /createHash\("sha256"\)\.update\(/.test(CODIGO));
  // ── N2..N4 — invertidos pela SKILL-1D.f.4-C ──────────────────────
  //
  // Estes tres afirmavam o estado PRE-f.4: "vigente nao aparece",
  // "nenhuma funcao de promocao", "nenhum .rpc(". A f.4 criou a RPC
  // atomica `promover_skill_vigente` e a chamou daqui, entao as tres
  // afirmacoes viraram falsas POR DESENHO — mesma inversao ja feita em
  // P1/P2 e em A3.
  //
  // Nao foram removidos: o que era uma NEGATIVA ("promocao nao existe")
  // vira uma restricao mais forte ("a promocao existe e so pode
  // acontecer por UM caminho"). A negativa protegia enquanto a feature
  // nao existia; a restricao protege agora que ela existe.
  ok("N2  a promocao de vigente e explicita e nomeada",
    /promoverSkillVigente/.test(CODIGO) && /promover_skill_vigente/.test(CODIGO));
  ok("N3  promoverSkillVigente e exportada",
    /export async function promoverSkillVigente/.test(CODIGO));
  // O modulo chama a RPC pela constante `RPC_PROMOVER`, nao por literal
  // inline — mesmo estilo de `TABELA_SKILLS`. A sonda segue as duas
  // pontas: a chamada usa a constante, e a constante vale o nome certo.
  ok("N4  a promocao passa EXCLUSIVAMENTE pela RPC — uma, e so uma",
    (CODIGO.match(/\.rpc\(/g) ?? []).length === 1 &&
      /\.rpc\(RPC_PROMOVER,/.test(CODIGO) &&
      /const RPC_PROMOVER = "promover_skill_vigente"/.test(CODIGO));
  ok("N4a nenhuma promocao por .update( direto",
    (CODIGO.match(/\.update\(/g) ?? []).length === 1 &&
      /createHash\("sha256"\)\.update\(/.test(CODIGO));
  ok("N4b CONTROLE: as sondas acusariam uma segunda RPC ou um update de vigente",
    ('.rpc(a) .rpc(b)'.match(/\.rpc\(/g) ?? []).length === 2 &&
      /\.update\(\{\s*vigente/.test('.update({ vigente: true })'));
  ok("N5  um unico .delete(, e ele e da associacao",
    (CODIGO.match(/\.delete\(/g) ?? []).length === 1 &&
      /TABELA_ASSOCIACOES\)\s*\.delete\(/.test(CODIGO));
  ok("N6  skills nunca aparece num caminho de delete",
    !/TABELA_SKILLS\)\s*\.delete\(/.test(CODIGO));
  ok("N7  CONTROLE: as sondas acusam quando os padroes existem",
    /\.update\(/.test('.update({vigente:true})') && /\.rpc\(/.test('.rpc("x")') && /vigente/.test("vigente"));
  ok("N8  nenhuma migration foi criada nesta fase",
    !existe("supabase/migrations/20260924_skills_vigente.sql"));

  secao("O. Sem consumidor de producao");

  const alvos: string[] = [];
  const varrer = (dir: string): void => {
    for (const e of readdirSync(join(RAIZ, dir), { withFileTypes: true })) {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) {
        if (!/node_modules|\.next/.test(e.name)) varrer(rel);
      } else if (/\.tsx?$/.test(e.name) && rel !== "lib/agentes/skills/escrita.ts") {
        if (/skills\/escrita/.test(ler(rel))) alvos.push(rel);
      }
    }
  };
  varrer("lib");
  varrer("app");
  ok("O1  zero import de skills/escrita em lib/ e app/", alvos.length === 0, alvos.join(", "));
  ok("O2  ANCORA: a varredura leu arquivos de verdade", existe("lib/agentes/skills/fatos.ts"));
  ok("O3  o roteiro nunca foi excedido em nenhum cenario", !excedeuRoteiro);

  console.log(`\n══ ${passou} PASS / ${falhou} FAIL ══\n`);
  process.exit(falhou === 0 ? 0 : 1);
}

principal().catch((e) => {
  console.log(`  FAIL  excecao nao tratada — ${String(e).slice(0, 300)}`);
  process.exit(1);
});
