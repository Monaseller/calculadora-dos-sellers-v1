/**
 * AGENT-FACTORY-F7b.4.8.5-R1 §1 — o texto do agente, formatado e seguro.
 *
 * Suite PURA: sem rede, sem banco, sem IA, sem browser. Renderiza o
 * componente para HTML com `react-dom/server`, que ja vem com o Next, e
 * mede o HTML resultante.
 *
 * ── Por que medir o HTML, e nao a arvore ────────────────────────────
 *
 * A pergunta de seguranca e exatamente "o conteudo consegue virar
 * marcacao?". Olhar a arvore React responderia sobre a intencao do
 * componente; olhar o HTML que chega ao navegador responde sobre o
 * resultado. Se um `<img onerror>` do conteudo aparecer como TAG no HTML,
 * a suite reprova — e e isso que precisa ser impossivel.
 *
 * Roda com: npx tsx scripts/testar-texto-do-agente.ts
 */
import "./_server-only-inerte";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { TextoDoAgente, blocosDoTexto } from "../components/ui/TextoDoAgente";

let pass = 0;
let fail = 0;
function ok(nome: string, cond: boolean, detalhe = ""): void {
  if (cond) { pass += 1; console.log(`  PASS  ${nome}`); }
  else { fail += 1; console.log(`  FAIL  ${nome}${detalhe ? `  — ${detalhe}` : ""}`); }
}
function secao(t: string): void { console.log(`\n${t}`); }

/** O HTML que o navegador receberia. */
function html(texto: string): string {
  return renderToStaticMarkup(createElement(TextoDoAgente, { texto }));
}
/**
 * As TAGS que o HTML realmente contem.
 *
 * A primeira versao desta suite procurava a substring `onerror=` no HTML e
 * reprovava — mas o `<` vinha escapado (`&lt;img src=x onerror=...`), ou
 * seja o ataque ja estava neutralizado e a sonda media o texto escapado
 * como se fosse marcacao. Procurar substring nao responde "virou tag?".
 */
function tagsDe(html: string): { nome: string; atributos: string }[] {
  const achadas: { nome: string; atributos: string }[] = [];
  for (const m of html.matchAll(/<\/?([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g)) {
    achadas.push({ nome: m[1].toLowerCase(), atributos: m[2] ?? "" });
  }
  return achadas;
}

/** Os unicos elementos que `TextoDoAgente` tem direito de emitir. */
const TAGS_PERMITIDAS = new Set([
  "div", "span", "strong", "em", "code", "ul", "ol", "li", "a",
  "table", "thead", "tbody", "tr", "th", "td",
]);

/** A fonte do componente, SEM comentario — o docblock cita o proibido. */
function fonteDoComponente(): string {
  const bruto = require("node:fs").readFileSync(
    require("node:path").join(__dirname, "..", "components", "ui", "TextoDoAgente.tsx"),
    "utf8") as string;
  return bruto.replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n").map((l) => l.replace(/\/\/.*$/, "")).join("\n");
}

/** O texto visivel, sem as tags. */
function visivel(texto: string): string {
  return html(texto).replace(/<[^>]*>/g, "")
    .replace(/&quot;/g, "\"").replace(/&#x27;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

console.log("══ F7b.4.8.5-R1 — texto do agente ══");

// ═══ A. Negrito ═══════════════════════════════════════════════════

secao("A. Negrito");
{
  const h = html("Vendas brutas: **R$ 393.838,47**");
  ok("A1  `**x**` vira <strong>", h.includes("<strong"), h.slice(0, 160));
  ok("A2  e o valor fica dentro dele",
    /<strong[^>]*>R\$ 393\.838,47<\/strong>/.test(h), h.slice(0, 200));
  ok("A3  os asteriscos NAO aparecem na tela",
    !visivel("Vendas brutas: **R$ 393.838,47**").includes("*"),
    visivel("Vendas brutas: **R$ 393.838,47**"));
  ok("A4  `__x__` tambem", html("__forte__").includes("<strong"));
  ok("A5  o texto em volta continua",
    visivel("antes **meio** depois") === "antes meio depois",
    visivel("antes **meio** depois"));
  // O caso REAL que o Rodrigo viu.
  const real = "Em **setembro de 2026** no Mercado Livre, suas **vendas brutas** foram:";
  ok("A6  a frase real nao mostra mais `**`", !visivel(real).includes("*"), visivel(real));
  ok("A7  e tem DOIS negritos", (html(real).match(/<strong/g) ?? []).length === 2);
}

// ═══ B. Italico, codigo e precedencia ═════════════════════════════

secao("B. Italico, codigo, precedencia");
{
  ok("B1  `*x*` vira <em>", html("*enfase*").includes("<em>"));
  ok("B2  `_x_` tambem", html("_enfase_").includes("<em>"));
  ok("B3  negrito ganha de italico — `**x**` nao vira <em>",
    html("**forte**").includes("<strong") && !html("**forte**").includes("<em>"),
    html("**forte**"));
  ok("B4  `` `x` `` vira <code>", html("use `total_amount`").includes("<code"));
  ok("B5  asterisco DENTRO de codigo nao vira negrito",
    !html("`a ** b`").includes("<strong"), html("`a ** b`"));
  ok("B6  asterisco solto continua texto",
    visivel("2 * 3 = 6") === "2 * 3 = 6", visivel("2 * 3 = 6"));
  ok("B7  negrito dentro de negrito nao duplica marcador",
    !visivel("**a *b* c**").includes("*"), visivel("**a *b* c**"));
}

// ═══ C. Listas ════════════════════════════════════════════════════

secao("C. Listas");
{
  const texto = "Resultado:\n- Vendas brutas: R$ 1,00\n- Vendas: 10\n- Unidades: 12";
  const h = html(texto);
  ok("C1  `- ` vira <ul>", h.includes("<ul"), h.slice(0, 120));
  ok("C2  com tres <li>", (h.match(/<li/g) ?? []).length === 3,
    String((h.match(/<li/g) ?? []).length));
  ok("C3  e o hifen nao aparece como texto",
    !visivel(texto).includes("- Vendas"), visivel(texto));
  const ordenada = html("1. primeiro\n2. segundo");
  ok("C4  `1. ` vira <ol>", ordenada.includes("<ol"), ordenada.slice(0, 120));
  ok("C5  com dois <li>", (ordenada.match(/<li/g) ?? []).length === 2);
  ok("C6  negrito DENTRO do item funciona",
    html("- **Vendas:** 10.898").includes("<strong"));
  ok("C7  `*` como marcador de lista nao vira italico",
    html("* um\n* dois").includes("<ul") && !html("* um\n* dois").includes("<em>"));
}

// ═══ D. Quebras de linha e paragrafos ═════════════════════════════

secao("D. Quebras de linha");
{
  const blocos = blocosDoTexto("primeiro paragrafo\n\nsegundo paragrafo");
  ok("D1  linha vazia separa paragrafos", blocos.length === 2, String(blocos.length));
  ok("D2  quebra simples fica no MESMO paragrafo",
    blocosDoTexto("linha um\nlinha dois").length === 1);
  ok("D3  e a quebra e preservada na tela",
    html("linha um\nlinha dois").includes("pre-wrap"),
    html("linha um\nlinha dois").slice(0, 160));
  ok("D4  as duas linhas aparecem",
    visivel("linha um\nlinha dois").includes("linha um") &&
    visivel("linha um\nlinha dois").includes("linha dois"));
  ok("D5  `\\r\\n` nao deixa carriage return visivel",
    !visivel("a\r\nb").includes("\r"));
}

// ═══ E. Texto sem Markdown ════════════════════════════════════════

secao("E. Texto sem Markdown nenhum");
{
  const simples = "Nao foi possivel falar com o Mercado Livre agora.";
  ok("E1  atravessa igual", visivel(simples) === simples, visivel(simples));
  ok("E2  sem tag de formatacao",
    !html(simples).includes("<strong") && !html(simples).includes("<em>"));
  ok("E3  acento e cedilha intactos",
    visivel("Consulta em andamento. Não precisa enviar de novo.")
      .includes("Não precisa"));
  ok("E4  texto vazio nao explode", html("") !== null && !html("").includes("undefined"));
  ok("E5  so espacos tambem nao", html("   ").length > 0);
}

// ═══ F. Tabela — o caso da comparacao ═════════════════════════════

secao("F. Tabela");
{
  const texto = [
    "| Periodo | Vendas brutas | Vendas |",
    "|---|---:|---:|",
    "| Agosto | R$ 325.697,95 | 8.861 |",
    "| Setembro | R$ 393.838,47 | 10.898 |",
  ].join("\n");
  const h = html(texto);
  ok("F1  vira <table>", h.includes("<table"), h.slice(0, 100));
  // `/<th/` casaria `<thead` tambem — dai o delimitador.
  ok("F2  com tres colunas no cabecalho", (h.match(/<th[ >]/g) ?? []).length === 3,
    String((h.match(/<th[ >]/g) ?? []).length));
  ok("F3  e duas linhas de corpo", (h.match(/<tr/g) ?? []).length === 3,
    String((h.match(/<tr/g) ?? []).length));
  ok("F4  as barras nao aparecem como texto", !visivel(texto).includes("|"),
    visivel(texto).slice(0, 80));
  ok("F5  e o separador `|---|` tambem nao", !visivel(texto).includes("---"));
  ok("F6  os numeros estao la",
    visivel(texto).includes("393.838,47") && visivel(texto).includes("10.898"));
}

// ═══ G. Titulo ════════════════════════════════════════════════════

secao("G. Titulo");
{
  ok("G1  `### x` nao mostra os sustenidos",
    !visivel("### Faturamento").includes("#"), visivel("### Faturamento"));
  ok("G2  e o texto fica em negrito",
    html("### Faturamento").includes("font-weight:600"),
    html("### Faturamento").slice(0, 160));
  ok("G3  `#hashtag` sem espaco NAO e titulo",
    visivel("#promocao").includes("#promocao"), visivel("#promocao"));
}

// ═══ H. SEGURANCA — o conteudo nao vira marcacao ══════════════════

secao("H. Seguranca: conteudo nao vira HTML (§1)");
{
  const ataques: readonly [string, string][] = [
    ["script", "<script>alert(1)</script>"],
    ["img onerror", "<img src=x onerror=alert(1)>"],
    ["svg onload", "<svg/onload=alert(1)>"],
    ["iframe", "<iframe src=\"javascript:alert(1)\"></iframe>"],
    ["negrito com tag", "**<script>alert(1)</script>**"],
    ["tag em item de lista", "- <img src=x onerror=alert(1)>"],
    ["tag em celula de tabela", "| a |\n|---|\n| <script>alert(1)</script> |"],
    ["entidade", "&lt;script&gt;alert(1)&lt;/script&gt;"],
    ["atributo solto", "\" onmouseover=\"alert(1)"],
  ];
  for (const [nome, conteudo] of ataques) {
    const h = html(conteudo);
    const tags = tagsDe(h);
    const forasteiras = tags.filter((t) => !TAGS_PERMITIDAS.has(t.nome));
    const comHandler = tags.filter((t) => /\son[a-z]+\s*=/i.test(t.atributos));
    ok(`H1  ${nome}: so emite tag da lista do componente`,
      forasteiras.length === 0, forasteiras.map((t) => t.nome).join(","));
    ok(`H1a ${nome}: e nenhuma tag ganha handler de evento`,
      comHandler.length === 0,
      comHandler.map((t) => `${t.nome}:${t.atributos}`).join(" | ").slice(0, 120));
  }
  // E o texto continua VISIVEL — escapar nao e apagar.
  ok("H2  o texto do ataque aparece como texto",
    visivel("<script>alert(1)</script>").includes("alert(1)"),
    visivel("<script>alert(1)</script>"));

  // ANCORA: a sonda sabe reconhecer uma tag perigosa quando ela existe.
  ok("H3  ANCORA: a sonda acusaria um `<script>` de verdade",
    /<script/i.test("<div><script>x</script></div>"));

  // Link: so http(s).
  ok("H4  link `https://` vira <a> com rel seguro",
    /<a [^>]*href="https:\/\/exemplo\.com"/.test(html("[ver](https://exemplo.com)")) &&
    html("[ver](https://exemplo.com)").includes("noopener"),
    html("[ver](https://exemplo.com)"));
  ok("H5  `javascript:` NAO vira link",
    !html("[clique](javascript:alert(1))").includes("<a "),
    html("[clique](javascript:alert(1))"));
  ok("H6  `data:` tambem nao",
    !html("[x](data:text/html,<script>alert(1)</script>)").includes("<a "));
  ok("H7  mas o texto do link recusado aparece",
    visivel("[clique](javascript:alert(1))").includes("clique"));
  ok("H8  nenhum `dangerouslySetInnerHTML` no CODIGO do componente",
    !fonteDoComponente().includes("dangerouslySetInnerHTML"));
  ok("H8a ANCORA: o docblock FALA dele — a sonda le codigo, nao comentario",
    require("node:fs").readFileSync(
      require("node:path").join(__dirname, "..", "components", "ui", "TextoDoAgente.tsx"),
      "utf8").includes("dangerouslySetInnerHTML"));
  // ANCORA da lista: um texto que exercita negrito, lista E tabela tem de
  // produzir varias tags. Sem isso, "nenhuma tag fora da lista" poderia
  // estar passando porque nenhuma tag foi gerada.
  const variado = ["**a**", "- b", "", "| x |", "|---|", "| y |"].join("\n");
  ok("H8b e a lista de tags permitidas foi de fato exercitada",
    tagsDe(html(variado)).length > 6, String(tagsDe(html(variado)).length));
  ok("H8c e todas elas estao na lista",
    tagsDe(html(variado)).every((t) => TAGS_PERMITIDAS.has(t.nome)),
    tagsDe(html(variado)).map((t) => t.nome).join(","));
}

// ═══ I. A resposta real do gate, inteira ══════════════════════════

secao("I. A resposta real de setembro");
{
  const real = [
    "Em **setembro de 2026** no Mercado Livre, suas **vendas brutas** foram:",
    "",
    "- **Faturamento (vendas brutas): R$ 393.838,47**",
    "- **Vendas (pedidos): 10.898**",
    "- **Unidades vendidas (itens): 11.361**",
    "- **Ticket médio:** R$ 36,14",
    "",
    "Fonte: API oficial do Mercado Livre.",
  ].join("\n");
  const lido = visivel(real);
  ok("I1  nenhum asterisco na tela", !lido.includes("*"), lido.slice(0, 120));
  ok("I2  os tres numeros aparecem",
    lido.includes("393.838,47") && lido.includes("10.898") && lido.includes("11.361"));
  ok("I3  a lista virou <ul> com quatro itens",
    (html(real).match(/<li/g) ?? []).length === 4,
    String((html(real).match(/<li/g) ?? []).length));
  ok("I4  e a fonte continua escrita", lido.includes("API oficial do Mercado Livre"));
  ok("I5  nada de tag fora da lista permitida",
    tagsDe(html(real)).every((t) => TAGS_PERMITIDAS.has(t.nome)),
    tagsDe(html(real)).map((t) => t.nome).filter((n) => !TAGS_PERMITIDAS.has(n)).join(","));
}

console.log(`\nPASS ${pass}   FAIL ${fail}`);
process.exit(fail === 0 ? 0 : 1);
