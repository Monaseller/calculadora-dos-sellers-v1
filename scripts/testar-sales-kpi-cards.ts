/**
 * CDS IA — F8.1-B4B: os 4 KPIs de vendas ML vem SO da apresentacao.
 *
 * Prova que `SalesMetricsCards` desenha exatamente o que recebe (sem
 * conta, sem texto do agente), que `apresentacoesDeVendasML` nao mistura
 * passos, e que no `ChatDoAgente` os cards entram entre o `TextoDoAgente`
 * e "Ver dados usados" sem que nada mais mude. Valores sinteticos.
 *
 * Roda com: npx tsx scripts/testar-sales-kpi-cards.ts
 */
import "./_server-only-inerte";

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import SalesMetricsCards, {
  apresentacoesDeVendasML, dataPtBR, type ApresentacaoVendasML,
} from "../components/ia/factory/SalesMetricsCards";
import type { PassoDoChatUI } from "../lib/ia/agentes-http";

let passou = 0;
let falhou = 0;
const ok = (nome: string, cond: boolean, det = ""): void => {
  if (cond) { passou += 1; console.log(`  PASS  ${nome}`); }
  else { falhou += 1; console.log(`  FAIL  ${nome}${det ? `  — ${det}` : ""}`); }
};
const secao = (t: string) =>
  console.log(`\n── ${t} ${"─".repeat(Math.max(2, 58 - t.length))}`);

const RAIZ = join(__dirname, "..");
const ler = (rel: string) => readFileSync(join(RAIZ, rel), "utf8").replace(/\r\n/g, "\n");

const BRL = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const NUM = new Intl.NumberFormat("pt-BR");

// Sinteticos. `ticketMedio` NAO e `valor / vendas` de proposito: se o
// componente dividisse, o teste veria outro numero.
const A: ApresentacaoVendasML = {
  tipo: "vendas_ml", valor: 98765.43, vendas: 4321, unidades: 5678, ticketMedio: 22.22,
  periodo: { de: "2026-08-01", ate: "2026-08-31" },
};
const B: ApresentacaoVendasML = {
  tipo: "vendas_ml", valor: 1500, vendas: 3, unidades: 4, ticketMedio: 512.5,
  periodo: { de: "2026-07-01", ate: "2026-07-31" },
};

const passo = (apresentacao: PassoDoChatUI["apresentacao"], funcaoId = "mercadolivre.vendas.consultar"):
  PassoDoChatUI => ({ funcaoId, desfecho: "sucesso", executou: true, requestId: null,
    aprovacaoId: null, apresentacao });

const html = (a: ApresentacaoVendasML) =>
  renderToStaticMarkup(createElement(SalesMetricsCards, { apresentacao: a }));
const valoresDe = (h: string) =>
  [...h.matchAll(/<dd[^>]*>([^<]*)<\/dd>/g)].map((m) => m[1].replace(/&nbsp;| /g, " "));
const norm = (s: string) => s.replace(/ /g, " ");

function main(): void {
  console.log("\n══ CDS IA — F8.1-B4B: KPI cards de vendas ML ══");

  // =====================================================================
  secao("A. Apresentacao valida -> 4 cards com os valores recebidos");
  const h = html(A);
  const cards = (h.match(/data-kpi=/g) ?? []).length;
  ok("A1  quatro cards", cards === 4, String(cards));
  const v = valoresDe(h);
  ok("A2  Vendas brutas = valor recebido, formatado BRL", v[0] === norm(BRL.format(A.valor)), v[0]);
  ok("A3  Vendas (pedidos) = vendas recebido, pt-BR", v[1] === norm(NUM.format(A.vendas)), v[1]);
  ok("A4  Unidades (itens) = unidades recebido, pt-BR", v[2] === norm(NUM.format(A.unidades)), v[2]);
  ok("A5  Ticket medio = ticketMedio RECEBIDO (nao valor/vendas)",
    v[3] === norm(BRL.format(A.ticketMedio)) &&
      v[3] !== norm(BRL.format(A.valor / A.vendas)), v[3]);
  ok("A6  rotulos na ordem aprovada",
    /Vendas brutas[\s\S]*Vendas \(pedidos\)[\s\S]*Unidades \(itens\)[\s\S]*Ticket médio/.test(h));
  ok("A7  periodo vem de apresentacao.periodo, em pt-BR sem Date",
    h.includes("Período: 01/08/2026 a 31/08/2026"));
  ok("A8  oculto por padrao; so o Office liga (--cds-chat-kpis-display)",
    h.includes("display:var(--cds-chat-kpis-display, none)"));
  ok("A9  dataPtBR: formato inesperado aparece como veio", dataPtBR("agosto") === "agosto" &&
    dataPtBR("2026-8-1") === "2026-8-1");

  // =====================================================================
  secao("B. Quem ganha cards");
  ok("B1  passos sem apresentacao (mensagem antiga) -> nenhuma",
    apresentacoesDeVendasML([passo(null), passo(null, "vendas.consultar")]).length === 0);
  ok("B2  nenhum passo -> nenhuma", apresentacoesDeVendasML([]).length === 0);
  ok("B3  outro tipo -> nenhuma",
    apresentacoesDeVendasML([passo({ ...A, tipo: "vendas_shopee" } as never)]).length === 0);
  const varias = apresentacoesDeVendasML([passo(A), passo(null), passo(B)]);
  ok("B4  multiplas: uma por passo, na ordem, sem misturar",
    varias.length === 2 && varias[0] === A && varias[1] === B);
  const hA = valoresDe(html(varias[0])), hB = valoresDe(html(varias[1]));
  ok("B5  cada conjunto mostra so os proprios valores (nada somado)",
    hA[0] === norm(BRL.format(A.valor)) && hB[0] === norm(BRL.format(B.valor)) &&
      !hA.includes(norm(BRL.format(A.valor + B.valor))));
  ok("B6  duplicata EXATA aparece uma vez",
    apresentacoesDeVendasML([passo(A), passo({ ...A, periodo: { ...A.periodo } })]).length === 1);

  // =====================================================================
  secao("C. ChatDoAgente: ponto unico de renderizacao");
  const CHAT = ler("components/ia/factory/ChatDoAgente.tsx");
  const iTexto = CHAT.indexOf("<TextoDoAgente texto={m.conteudo} />");
  const iCards = CHAT.indexOf("apresentacoesDeVendasML(m.passos).map(");
  const iVer = CHAT.indexOf("Ver dados usados");
  ok("C1  TextoDoAgente continua renderizado", iTexto > 0);
  ok("C2  'Ver dados usados' continua existindo", iVer > 0);
  ok("C3  ordem: TextoDoAgente -> cards -> Ver dados usados",
    iTexto > 0 && iTexto < iCards && iCards < iVer, `${iTexto} < ${iCards} < ${iVer}`);
  ok("C4  so mensagem do agente ganha cards",
    /m\.papel === "assistente" && apresentacoesDeVendasML\(m\.passos\)/.test(CHAT));
  ok("C5  os cards so recebem a apresentacao (nenhum outro dado)",
    /<SalesMetricsCards key=\{`[^`]+`\} apresentacao=\{a\} \/>/.test(CHAT));

  // =====================================================================
  secao("D. Zero parser textual, zero calculo, zero hardcode");
  const CARDS = ler("components/ia/factory/SalesMetricsCards.tsx");
  const semComentario = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  const codigoCards = semComentario(CARDS);
  ok("D1  o componente nao le texto: sem conteudo/texto/markdown/regex",
    !/conteudo|TextoDoAgente|markdown|RegExp|\.match\(|\.exec\(|\.test\(|matchAll/.test(codigoCards));
  // Strings fora: `"--cds-chat-kpi-valor"` e nome de variavel CSS, nao conta.
  const semStrings = codigoCards.replace(/"[^"\n]*"|`[^`]*`/g, '""');
  ok("D2  o componente nao faz conta sobre os agregados",
    semStrings.includes("apresentacao.ticketMedio") &&
      !/(valor|vendas|unidades|ticketMedio)\s*[-+*/]|[-+*/]\s*(apresentacao\.)?(valor|vendas|unidades|ticketMedio)\b/
        .test(semStrings));
  ok("D3  sem fetch/API/banco no componente",
    !/fetch\s*\(|\/api\/|supabase|mercadolivre-vendas|vendas-ml/i.test(codigoCards));
  // A busca pelos numeros reais proibidos fica FORA deste arquivo (grep
  // no relatorio): lista-los aqui seria hardcoda-los em codigo novo.
  ok("D4  nenhum literal numerico com cara de dinheiro no componente",
    !/\d{1,3}(\.\d{3})+,\d{2}|\d+,\d{2}\b/.test(codigoCards));
  ok("D5  o trecho novo do chat nao tem regex nem numero",
    !/RegExp|\.match\(|\d{2,}/.test(CHAT.slice(iCards - 300, iCards + 200).replace(/F8\.1-B4B/g, "")));

  console.log(`\n── placar ${"─".repeat(50)}\n  PASS ${passou}   FAIL ${falhou}\n`);
  if (falhou > 0) process.exit(1);
}

main();
