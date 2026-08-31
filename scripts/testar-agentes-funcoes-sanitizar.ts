/**
 * CDS IA — TOOL-REGISTRY-B1. Suite da projecao por allowlist.
 *
 * Prova por EXECUCAO. O caso que define o modulo esta em A: um objeto
 * com oito campos, dos quais seis parecem credencial, atravessa como
 * DOIS — e a prova nao e "os seis sumiram", e "o resultado tem
 * exatamente os dois permitidos".
 *
 * Nenhum segredo real e usado. Os valores sao sinteticos e reconheciveis
 * de proposito: se um deles vazasse para a saida, o teste aponta qual.
 *
 * Rodar:  npx tsx scripts/testar-agentes-funcoes-sanitizar.ts
 * Sem rede, sem banco, sem IA, sem escrita.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  LIMITE_MENSAGEM,
  projetarPermitidos,
  truncarMensagem,
} from "../lib/agentes/funcoes/sanitizar";

let passou = 0;
let falhou = 0;

function ok(nome: string, condicao: boolean, detalhe = ""): void {
  if (condicao) {
    passou++;
  } else {
    falhou++;
    console.error(`  x ${nome}${detalhe ? `  · ${detalhe}` : ""}`);
  }
}

function secao(titulo: string): void {
  console.log(`\n── ${titulo}`);
}

const RAIZ = join(__dirname, "..");
const fonte = (rel: string) => readFileSync(join(RAIZ, rel), "utf8");
const semComentarios = (t: string) =>
  t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

// ─── A. O caso central ────────────────────────────────────────────────

secao("A. allowlist deixa passar somente o permitido");
{
  // Valores sinteticos. Nenhum e credencial real; o formato so imita.
  const ENTRADA = {
    request_id: "req-b1-0001",
    produto_id: "SKU-SINTETICO-7",
    authorization: "Bearer VALOR-SINTETICO-NAO-E-SEGREDO",
    cookie: "sessao=VALOR-SINTETICO",
    token: "VALOR-SINTETICO",
    headers: { "x-qualquer": "VALOR-SINTETICO" },
    raw_request: "POST /webhook/VALOR-SINTETICO",
    segredo: "VALOR-SINTETICO",
  };
  const PERMITIDOS = ["request_id", "produto_id"] as const;

  const saida = projetarPermitidos(ENTRADA, PERMITIDOS);
  const chaves = Object.keys(saida).sort();

  ok("A1  a saida tem exatamente duas chaves", chaves.length === 2, chaves.join(","));
  ok("A2  as chaves sao produto_id e request_id", chaves.join(",") === "produto_id,request_id", chaves.join(","));
  ok("A3  request_id atravessou com o valor certo", saida.request_id === "req-b1-0001");
  ok("A4  produto_id atravessou com o valor certo", saida.produto_id === "SKU-SINTETICO-7");

  // Assercao explicita, campo a campo — nao basta contar chaves.
  for (const proibido of ["authorization", "cookie", "token", "headers", "raw_request", "segredo"]) {
    ok(`A5.${proibido} nao aparece na saida`, !(proibido in saida));
  }

  // E o mais importante: nenhum VALOR sintetico atravessou, nem
  // aninhado, nem concatenado, nem serializado por acidente.
  const serializada = JSON.stringify(saida);
  ok("A6  nenhum valor sintetico proibido atravessou", !serializada.includes("VALOR-SINTETICO"));

  // Controle negativo: o proprio detector funcionaria se algo vazasse.
  ok("A7  controle: o detector acharia um vazamento", JSON.stringify(ENTRADA).includes("VALOR-SINTETICO"));
  // Controle negativo: permitir o campo perigoso o faria passar — ou
  // seja, a barreira e a lista, nao um filtro escondido por nome.
  const vazando = projetarPermitidos(ENTRADA, ["authorization"]);
  ok("A8  controle: a lista e a unica barreira", vazando.authorization === ENTRADA.authorization);
  ok("A9  controle: e nao ha denylist por nome", Object.keys(vazando).length === 1);
}

// ─── B. Objeto novo, nunca o original ─────────────────────────────────

secao("B. o objeto de saida e novo");
{
  const origem = { a: 1, b: 2 };
  const saida = projetarPermitidos(origem, ["a"]);
  ok("B1  a saida nao e a origem", (saida as unknown) !== (origem as unknown));
  ok("B2  a origem nao foi alterada", Object.keys(origem).sort().join(",") === "a,b");
  ok("B3  campo permitido e ausente nao vira null", Object.keys(projetarPermitidos({ a: 1 }, ["z"])).length === 0);
  ok("B4  allowlist vazia produz objeto vazio", Object.keys(projetarPermitidos(origem, [])).length === 0);
}

// ─── C. Somente escalares ─────────────────────────────────────────────

secao("C. somente escalares atravessam");
{
  const origem = {
    s: "texto",
    n: 42,
    b: false,
    nulo: null,
    obj: { dentro: "VALOR-SINTETICO" },
    arr: [1, 2, 3],
    fn: () => "VALOR-SINTETICO",
    indef: undefined,
    nan: Number.NaN,
    inf: Number.POSITIVE_INFINITY,
    grande: BigInt(9),
  };
  const saida = projetarPermitidos(origem, [
    "s", "n", "b", "nulo", "obj", "arr", "fn", "indef", "nan", "inf", "grande",
  ]);

  ok("C1  string passa", saida.s === "texto");
  ok("C2  number passa", saida.n === 42);
  ok("C3  boolean passa", saida.b === false);
  ok("C4  null passa", saida.nulo === null && "nulo" in saida);
  ok("C5  objeto aninhado NAO passa", !("obj" in saida));
  ok("C6  array NAO passa", !("arr" in saida));
  ok("C7  funcao NAO passa", !("fn" in saida));
  ok("C8  undefined NAO passa", !("indef" in saida));
  ok("C9  NaN NAO passa", !("nan" in saida));
  ok("C10 Infinity NAO passa", !("inf" in saida));
  ok("C11 BigInt NAO passa", !("grande" in saida));
  ok("C12 nenhum valor sintetico aninhado vazou", !JSON.stringify(saida).includes("VALOR-SINTETICO"));
  ok("C13 controle: os escalares realmente passaram", Object.keys(saida).sort().join(",") === "b,n,nulo,s");
}

// ─── D. Recusa de atalho perigoso ─────────────────────────────────────

secao("D. Request/Headers nao sao atalho para persistencia");
{
  const headers = new Headers({ authorization: "Bearer VALOR-SINTETICO" });
  const saidaH = projetarPermitidos(headers, ["authorization"]);
  ok("D1  Headers produz objeto vazio", Object.keys(saidaH).length === 0);

  const req = new Request("https://exemplo.invalido/x", { method: "POST" });
  const saidaR = projetarPermitidos(req, ["method", "url"]);
  ok("D2  Request produz objeto vazio", Object.keys(saidaR).length === 0);

  ok("D3  Map produz objeto vazio", Object.keys(projetarPermitidos(new Map([["a", 1]]), ["a"])).length === 0);
  ok("D4  Date produz objeto vazio", Object.keys(projetarPermitidos(new Date(), ["a"])).length === 0);
  ok("D5  array produz objeto vazio", Object.keys(projetarPermitidos([1, 2], ["0"])).length === 0);
  ok("D6  null produz objeto vazio", Object.keys(projetarPermitidos(null, ["a"])).length === 0);
  ok("D7  string produz objeto vazio", Object.keys(projetarPermitidos("texto", ["length"])).length === 0);
  ok("D8  objeto sem prototipo e aceito", projetarPermitidos(Object.assign(Object.create(null), { a: 1 }), ["a"]).a === 1);
  ok("D9  controle: objeto literal e aceito", projetarPermitidos({ a: 1 }, ["a"]).a === 1);
}

// ─── E. Herdado e __proto__ ───────────────────────────────────────────

secao("E. herdado nao atravessa; __proto__ nao polui");
{
  const base = { herdado: "VALOR-SINTETICO" };
  const filho = Object.create(base) as Record<string, unknown>;
  filho.proprio = "ok";
  // `filho` tem prototipo `base`, entao e recusado na porta — e ainda
  // assim o campo herdado nao apareceria.
  const saida = projetarPermitidos(filho, ["herdado", "proprio"]);
  ok("E1  campo herdado nao atravessa", !("herdado" in saida));

  const comProto = projetarPermitidos({ ["__proto__"]: { poluido: true } }, ["__proto__"]);
  ok("E2  __proto__ nao vira campo (nao e escalar)", !("__proto__" in comProto) || Object.keys(comProto).length === 0);
  ok("E3  Object.prototype nao foi poluido", ({} as Record<string, unknown>).poluido === undefined);
}

// ─── F. truncarMensagem ───────────────────────────────────────────────

secao("F. truncamento de mensagem");
{
  ok("F1  limite padrao e 300", LIMITE_MENSAGEM === 300);
  ok("F2  texto curto passa inteiro", truncarMensagem("erro curto") === "erro curto");
  const longo = "x".repeat(400);
  const cortado = truncarMensagem(longo);
  ok("F3  texto longo e cortado", cortado.length === LIMITE_MENSAGEM + 1);
  ok("F4  o corte deixa marca", cortado.endsWith("…"));
  ok("F5  nao-string vira vazio", truncarMensagem(undefined) === "" && truncarMensagem({ a: 1 }) === "");
  ok("F6  nao vira a string 'undefined'", truncarMensagem(undefined) !== "undefined");
  ok("F7  limite explicito e respeitado", truncarMensagem("abcdef", 3) === "abc…");
  ok("F8  limite zero devolve vazio", truncarMensagem("abcdef", 0) === "");
  ok("F9  controle: 300 chars exatos nao sao cortados", truncarMensagem("y".repeat(300)) === "y".repeat(300));
}

// ─── G. Pureza estrutural ─────────────────────────────────────────────

secao("G. pureza");
{
  const src = semComentarios(fonte("lib/agentes/funcoes/sanitizar.ts"));
  ok("G1  sem supabase", !/supabase|Supabase/.test(src));
  ok("G2  sem fetch", !/\bfetch\s*\(/.test(src));
  ok("G3  sem process.env", !/process\.env/.test(src));
  ok("G4  sem filesystem", !/node:fs|readFileSync/.test(src));
  ok("G5  sem denylist por nome", !/(authorization|cookie|token|senha|password)/i.test(src));
  ok("G6  controle: a fonte lida e a do sanitizador", src.includes("projetarPermitidos") && src.length > 500);
  ok("G7  controle: o grep de denylist acharia se houvesse", /authorization/i.test('delete o["authorization"]'));
}

// ─── Placar ───────────────────────────────────────────────────────────

console.log(`\n${"═".repeat(66)}`);
console.log(`  ${passou}/${passou + falhou} passaram` + (falhou > 0 ? `  ·  ${falhou} FALHARAM` : ""));
console.log(`${"═".repeat(66)}\n`);
process.exit(falhou > 0 ? 1 : 0);
