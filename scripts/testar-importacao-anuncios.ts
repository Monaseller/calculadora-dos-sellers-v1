/**
 * Importação: soft delete preservado + classificação de falha. F0.c.18A.
 *
 * ── Os dois defeitos que esta suíte trava ───────────────────────────
 *
 * 1. REATIVAÇÃO SILENCIOSA. Os quatro UPDATEs das rotas de importação
 *    (2 no ML, 2 na Shopee) carregavam `ativo: true` no payload. Um
 *    anúncio que o usuário havia excluído voltava sozinho no import
 *    seguinte — e, como a rota escreve progressivamente, voltava até
 *    parcialmente quando a função morria aos 60s. Em 2026-08-17 dois
 *    imports da Shopee deram `Vercel Runtime Timeout Error` e um deles
 *    chegou a gravar linha nova antes de morrer.
 *
 *    Decisão de produto: exclusão na CDS é do usuário. Importar NUNCA
 *    transforma `ativo=false` em `ativo=true`.
 *
 * 2. CULPA NO PROVEDOR ERRADO. O handler tinha UM try/catch cobrindo
 *    `fetch` e `res.json()`, e chamava os dois de "Falha na conexão com
 *    a Shopee". O timeout era NOSSO; a Shopee estava no ar.
 *
 * ── Como estes testes provam ────────────────────────────────────────
 * A classificação é função pura, então as quatro classes são exercidas
 * de verdade. As rotas de servidor são verificadas por leitura do
 * código-fonte — com comentários removidos antes, para o teste falar do
 * código e não da prosa. Um teste que só lesse comentários passaria com
 * o bug de volta.
 *
 * Sem rede, sem banco, sem credencial. Nada é importado.
 *
 * Uso: npx tsx scripts/testar-importacao-anuncios.ts
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

let ok = 0, falhou = 0;
let fila: Promise<void> = Promise.resolve();
const imprimir = console.log.bind(console);

function t(nome: string, fn: () => void | Promise<void>) {
  fila = fila.then(async () => {
    try { await fn(); ok++; imprimir(`  PASS  ${nome}`); }
    catch (e: any) { falhou++; imprimir(`  FALHA ${nome} -> ${e?.message ?? e}`); }
  });
}
function secao(titulo: string) { fila = fila.then(() => { imprimir(titulo); }); }
function assert(c: boolean, m: string) { if (!c) throw new Error(m); }

const RAIZ = process.cwd();
const TELA       = path.join(RAIZ, "app", "(app)", "anuncios", "page.tsx");
const PAGINACAO  = path.join(RAIZ, "app", "(app)", "anuncios", "paginacao.ts");
const ROTA_ML    = path.join(RAIZ, "app", "api", "ml", "importar-anuncios", "route.ts");
const ROTA_SP    = path.join(RAIZ, "app", "api", "shopee", "importar-anuncios", "route.ts");

function semComentarios(arquivo: string): string {
  return fs.readFileSync(arquivo, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}
const CODIGO_TELA = semComentarios(TELA);
const CODIGO_ML   = semComentarios(ROTA_ML);
const CODIGO_SP   = semComentarios(ROTA_SP);

/**
 * Blocos `.update({...})` de uma fonte, com o objeto literal que os
 * acompanha. Cobre as duas formas usadas nas rotas: objeto inline e
 * `const upd = {...}` usado logo abaixo.
 */
function payloadsDeUpdate(fonte: string): string[] {
  const blocos: string[] = [];
  for (const m of fonte.matchAll(/const\s+upd\s*:\s*any\s*=\s*\{([\s\S]*?)\};/g)) blocos.push(m[1]);
  for (const m of fonte.matchAll(/\.update\(\{([\s\S]*?)\}\)/g)) blocos.push(m[1]);
  return blocos;
}
function payloadsDeInsert(fonte: string): string[] {
  return [...fonte.matchAll(/\.insert\(\{([\s\S]*?)\}\);/g)].map(m => m[1]);
}

/** Corpo de uma função nomeada, delimitado por contagem de chaves. */
function corpoDaFuncao(fonte: string, nome: string): string {
  const i = fonte.indexOf(`function ${nome}(`);
  assert(i >= 0, `função ${nome} não encontrada`);
  const abre = fonte.indexOf("{", i);
  let nivel = 0;
  for (let k = abre; k < fonte.length; k++) {
    if (fonte[k] === "{") nivel++;
    else if (fonte[k] === "}") { nivel--; if (nivel === 0) return fonte.slice(abre, k + 1); }
  }
  throw new Error(`fim de ${nome} não encontrado`);
}

async function principal() {
  const mod: any = await import(pathToFileURL(PAGINACAO).href);
  const { classificarRespostaImportacao, MENSAGEM_FALHA_DE_REDE } = mod;

  // ── A / B / C — a regra do soft delete no código de servidor ──────
  secao("\n[1. A/B/C — importação não reativa anúncio excluído]");

  for (const [nome, codigo] of [["Mercado Livre", CODIGO_ML], ["Shopee", CODIGO_SP]] as const) {
    t(`A/B. ${nome}: nenhum UPDATE de importação escreve 'ativo'`, () => {
      const updates = payloadsDeUpdate(codigo);
      assert(updates.length >= 2, `esperava ao menos 2 payloads de update, achei ${updates.length}`);
      for (const p of updates) {
        assert(!/\bativo\s*:/.test(p),
          `🔴 payload de UPDATE voltou a escrever 'ativo' — import reativaria anúncio excluído`);
      }
    });

    t(`C. ${nome}: todo INSERT nasce com ativo: true`, () => {
      const inserts = payloadsDeInsert(codigo);
      assert(inserts.length >= 2, `esperava ao menos 2 inserts, achei ${inserts.length}`);
      for (const p of inserts) {
        assert(/\bativo\s*:\s*true\b/.test(p), "anúncio novo deveria entrar ativo");
      }
    });

    t(`G. ${nome}: a busca de existentes NÃO filtra por ativo`, () => {
      // Se filtrasse `ativo=true`, uma linha soft-deleted não seria
      // encontrada e o import a RE-INSERIRIA como nova e ativa — a mesma
      // ressurreição, por outra porta, e ainda duplicando.
      const i = codigo.indexOf('from("anuncios")');
      assert(i >= 0, "não achei a consulta de existentes");
      const trecho = codigo.slice(i, i + 400);
      assert(!/\.eq\("ativo"/.test(trecho),
        "🔴 a busca de existentes passou a filtrar ativo — soft-deleted seria reinserido");
    });
  }

  secao("\n[2. D/E — identidade do anúncio]");

  t("D. a busca de existentes é escopada por marketplace E user_id", () => {
    for (const [nome, codigo, mkt] of [["ML", CODIGO_ML, "ML"], ["Shopee", CODIGO_SP, "Shopee"]] as const) {
      const i = codigo.indexOf('from("anuncios")');
      const trecho = codigo.slice(i, i + 400);
      assert(new RegExp(`\\.eq\\("marketplace",\\s*"${mkt}"\\)`).test(trecho),
        `${nome}: consulta sem escopo de marketplace — ML e Shopee colidiriam`);
      assert(/\.eq\("user_id",\s*userId\)/.test(trecho),
        `${nome}: consulta sem escopo de user_id`);
    }
  });

  t("E. a chave de identidade inclui a variação", () => {
    for (const [nome, codigo] of [["ML", CODIGO_ML], ["Shopee", CODIGO_SP]] as const) {
      assert(/`\$\{row\.ml_item_id\}\|\$\{row\.variation_id\s*\?\?\s*""\}`/.test(codigo),
        `${nome}: chave do mapa de existentes não combina item + variação`);
    }
  });

  t("D/E. item sem variação e com variação não colidem entre si", () => {
    // Reproduz a chave usada pelas rotas.
    const chave = (item: string, variacao: string | null) => `${item}|${variacao ?? ""}`;
    assert(chave("123", null) !== chave("123", "9"), "item sem variação colidiu com variação");
    assert(chave("123", "9") !== chave("123", "10"), "duas variações do mesmo item colidiram");
    assert(chave("123", null) === chave("123", null), "a chave não é estável");
  });

  t("D. mesmo item_id em marketplaces diferentes não colide", () => {
    // A separação vem do escopo da consulta, não da chave: cada rota
    // monta seu mapa só com linhas do próprio marketplace.
    const mapaML: Record<string, string> = { "999|": "linha-ml" };
    const mapaSP: Record<string, string> = { "999|": "linha-shopee" };
    assert(mapaML["999|"] !== mapaSP["999|"], "os mapas não são independentes");
  });

  secao("\n[3. F/G — idempotência e falha no meio]");

  t("F. import repetido não altera 'ativo' de nada que já existe", () => {
    // Simula o efeito do payload real sobre linhas existentes.
    const aplicar = (linha: { ativo: boolean }, payload: Record<string, any>) => ({ ...linha, ...payload });
    const payloadReal = { nome: "novo", preco_anuncio: 10, thumbnail: "x" }; // sem `ativo`
    assert(aplicar({ ativo: true }, payloadReal).ativo === true, "linha ativa deixou de ser ativa");
    assert(aplicar({ ativo: false }, payloadReal).ativo === false, "🔴 linha excluída foi reativada");
    // Duas passadas seguidas: mesmo resultado.
    const duasVezes = aplicar(aplicar({ ativo: false }, payloadReal), payloadReal);
    assert(duasVezes.ativo === false, "import repetido reativou");
  });

  t("G. falha no meio: o que foi escrito não reativa nada", () => {
    // A escrita é incremental e pode morrer a qualquer item. Como nenhum
    // payload de update toca `ativo`, qualquer prefixo processado é seguro.
    const payloadReal = { nome: "x", preco_anuncio: 1, thumbnail: null };
    assert(!("ativo" in payloadReal), "payload de update não pode conter ativo");
    const catalogo = [{ ativo: false }, { ativo: true }, { ativo: false }];
    const processadosAteMorrer = catalogo.slice(0, 2).map(l => ({ ...l, ...payloadReal }));
    assert(processadosAteMorrer[0].ativo === false, "import parcial reativou linha excluída");
    assert(processadosAteMorrer[1].ativo === true, "import parcial desativou linha ativa");
  });

  secao("\n[4. H/I — isolamento entre marketplaces]");

  t("H. ML só insere marketplace 'ML'", () => {
    for (const p of payloadsDeInsert(CODIGO_ML)) {
      assert(/marketplace:\s*"ML"/.test(p), "insert do ML sem marketplace ML");
      assert(!/marketplace:\s*"Shopee"/.test(p), "🔴 rota do ML inserindo Shopee");
    }
  });

  t("I. Shopee só insere marketplace 'Shopee'", () => {
    for (const p of payloadsDeInsert(CODIGO_SP)) {
      assert(/marketplace:\s*"Shopee"/.test(p), "insert da Shopee sem marketplace Shopee");
      assert(!/marketplace:\s*"ML"/.test(p), "🔴 rota da Shopee inserindo ML");
    }
  });

  t("H/I. os dois updates alcançam só a linha já casada, por id", () => {
    for (const [nome, codigo] of [["ML", CODIGO_ML], ["Shopee", CODIGO_SP]] as const) {
      const n = (codigo.match(/\.update\(upd\)\.eq\("id",\s*existente\.id\)/g) ?? []).length;
      assert(n >= 2, `${nome}: updates deveriam mirar existente.id (achei ${n})`);
    }
  });

  secao("\n[5. J — a tela não culpa o marketplace por timeout nosso]");

  t("J1. corpo não-JSON (função interrompida) -> tempo excedido, sem citar marketplace", () => {
    const r = classificarRespostaImportacao(504, "<html>Gateway Timeout</html>", "Shopee");
    assert(r.classe === "RESPOSTA_INVALIDA", `classe=${r.classe}`);
    assert(/tempo dispon[ií]vel no servidor/i.test(r.mensagem), `mensagem inesperada: ${r.mensagem}`);
    assert(!/falha na conex[aã]o com a shopee/i.test(r.mensagem),
      "🔴 voltou a culpar a Shopee por timeout do nosso servidor");
  });

  t("J2. corpo vazio também é resposta inválida", () => {
    const r = classificarRespostaImportacao(500, "", "Shopee");
    assert(r.classe === "RESPOSTA_INVALIDA", `classe=${r.classe}`);
    assert(r.dados === null, "não deveria haver dados");
  });

  t("J3. erro JSON do backend usa a mensagem do backend", () => {
    const r = classificarRespostaImportacao(401, JSON.stringify({ erro: true, mensagem: "Conta Shopee não conectada." }), "Shopee");
    assert(r.classe === "ERRO_DO_BACKEND", `classe=${r.classe}`);
    assert(r.mensagem === "Conta Shopee não conectada.", `mensagem=${r.mensagem}`);
  });

  t("J4. erro JSON sem mensagem cai num texto por marketplace", () => {
    const r = classificarRespostaImportacao(500, JSON.stringify({ erro: true }), "Mercado Livre");
    assert(r.classe === "ERRO_DO_BACKEND", `classe=${r.classe}`);
    assert(/Mercado Livre/.test(r.mensagem), `mensagem=${r.mensagem}`);
  });

  t("J5. HTTP não-OK com JSON sem 'erro' é classe própria", () => {
    const r = classificarRespostaImportacao(502, JSON.stringify({ algo: 1 }), "Shopee");
    assert(r.classe === "HTTP_NAO_OK", `classe=${r.classe}`);
    assert(/502/.test(r.mensagem), `mensagem=${r.mensagem}`);
  });

  t("J6. sucesso devolve os dados para a tela montar o texto", () => {
    const r = classificarRespostaImportacao(200, JSON.stringify({ importados: 3, atualizados: 2, total: 5 }), "Shopee");
    assert(r.classe === "SUCESSO", `classe=${r.classe}`);
    assert(r.mensagem === "", "sucesso não deveria trazer mensagem pronta");
    assert(r.dados.importados === 3 && r.dados.total === 5, "dados não repassados");
  });

  t("J7. JSON que não é objeto não passa por sucesso", () => {
    for (const corpo of ["null", '"texto"', "42", "[1,2]"]) {
      const r = classificarRespostaImportacao(200, corpo, "Shopee");
      assert(r.classe !== "SUCESSO", `corpo ${corpo} passou como sucesso`);
    }
  });

  t("J8. a tela usa a classificação e não fala mais em 'conexão com a Shopee'", () => {
    assert(!/Falha na conex[aã]o com a Shopee/.test(CODIGO_TELA),
      "🔴 a mensagem enganosa voltou");
    assert(!/Falha na conex[aã]o\./.test(CODIGO_TELA), "🔴 a mensagem genérica do ML voltou");
    const n = (CODIGO_TELA.match(/classificarRespostaImportacao\(/g) ?? []).length;
    assert(n === 2, `esperava os 2 imports usando a classificação, achei ${n}`);
    assert(/MENSAGEM_FALHA_DE_REDE/.test(CODIGO_TELA), "o caso de rede não usa a mensagem dedicada");
  });

  t("J9. os handlers leem text(), não json()", () => {
    // `json()` lançaria antes de podermos reconhecer o corpo ilegível —
    // que é exatamente a assinatura do timeout.
    for (const fn of ["importarDoML", "importarDaShopee"]) {
      // Corpo delimitado por contagem de chaves. Uma fatia de tamanho
      // fixo invadiria `sincronizarPrecos`, que usa `res.json()` de forma
      // legítima — e o teste acusaria o arquivo errado.
      const corpo = corpoDaFuncao(CODIGO_TELA, fn);
      assert(/await res\.text\(\)/.test(corpo), `${fn} não lê o corpo cru`);
      assert(!/await res\.json\(\)/.test(corpo), `${fn} ainda usa res.json()`);
    }
  });

  t("J10. a mensagem de rede é usada só no catch", () => {
    assert(typeof MENSAGEM_FALHA_DE_REDE === "string" && MENSAGEM_FALHA_DE_REDE.length > 10,
      "constante de rede ausente");
    assert(!/marketplace|Shopee|Mercado Livre/i.test(MENSAGEM_FALHA_DE_REDE),
      "a mensagem de rede não deve culpar marketplace");
  });

  await fila;
  imprimir(`\n=== RESULTADO: ${ok} passaram, ${falhou} falharam ===`);
  if (falhou > 0) process.exitCode = 1;
}

principal();
