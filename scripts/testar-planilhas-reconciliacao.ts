/**
 * AGENT-FACTORY-F7b.4.8.4 — as planilhas de pericia ABREM e CONFEREM.
 *
 * Suite PURA: nenhuma rede, nenhum banco, nenhuma IA.
 *
 * ── Por que esta suite existe ───────────────────────────────────────
 *
 * O escritor de xlsx (`scripts/gerar-xlsx.mjs`) foi escrito a mao, porque
 * o repositorio le planilha e nao escreve, e uma ferramenta de diagnostico
 * nao justifica dependencia nova em producao. Codigo de zip e de XML
 * escrito a mao que "parece certo" e exatamente o tipo de coisa que abre
 * quebrada na mao de quem precisa dela.
 *
 * Entao a prova usa o LEITOR DE XLSX DO PROPRIO REPOSITORIO — o mesmo que
 * a Funcao `planilha.ler` usa. Se ele abre e encontra as abas, as colunas
 * e os valores esperados, o arquivo e valido de verdade.
 *
 * Roda com: npx tsx scripts/testar-planilhas-reconciliacao.ts
 */
import "./_server-only-inerte";

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { lerXlsx } from "../lib/agentes/planilhas/leitura";

const PASTA = process.env.PASTA ??
  join("C:", "Users", "USER", "Desktop", "reconciliacao-ml-setembro-2026");

let pass = 0;
let fail = 0;
function ok(nome: string, cond: boolean, detalhe = ""): void {
  if (cond) { pass += 1; console.log(`  PASS  ${nome}`); }
  else { fail += 1; console.log(`  FAIL  ${nome}${detalhe ? `  — ${detalhe}` : ""}`); }
}
function secao(t: string): void { console.log(`\n${t}`); }

/**
 * O conteudo de uma celula.
 *
 * O leitor do repositorio devolve `{ bruto, formula }`, e nao o valor
 * direto — `formula` e o TEXTO e `bruto` e o cache do Excel. A primeira
 * versao desta suite comparou a celula INTEIRA com texto e recebeu
 * "[object Object]" em 22 assercoes. A ancora do fim foi quem avisou.
 */
function val(c: { bruto: string | number | null } | undefined): string {
  return c === undefined || c.bruto === null ? "" : String(c.bruto);
}

/** Procura uma aba pelo nome, como o Excel a mostraria. */
function aba(pasta: ReturnType<typeof lerXlsx>, nome: string) {
  return pasta.abas.find((a) => a.nome === nome) ?? null;
}

function main(): void {
  console.log("══ F7b.4.8.4 — as tres planilhas, lidas de volta ══");

  const esperado: readonly { arquivo: string; abas: readonly string[]; minLinhas: number }[] = [
    {
      arquivo: "ML_API_RAW_SETEMBRO_2026.xlsx",
      abas: ["Orders_Raw_Normalized", "Payments_Raw_Normalized", "Order_Items",
        "Campos_Medidos", "Status_Distribution", "Metadata"],
      minLinhas: 10000,
    },
    {
      arquivo: "AGENTE_CALCULO_SETEMBRO_2026.xlsx",
      abas: ["Resumo", "Calculo_Por_Pedido", "Calculo_Por_Dia", "Incluidos", "Excluidos",
        "Multiplos_Pagamentos", "Reembolsos_Parciais", "Reembolsos_Totais",
        "Cancelados_Pos_Pagamento", "Paid_vs_Total", "Virada_de_Mes", "Chargeback",
        "Mediacao", "Pedidos_Suspeitos", "Diferencas_Candidatos"],
      minLinhas: 10000,
    },
    {
      arquivo: "RECONCILIACAO_ML_SETEMBRO_2026.xlsx",
      abas: ["Painel_Oficial", "Totais_Candidatos", "Metricas_Cruzadas",
        "Categorias_Divergencia", "Pedidos_Maior_Impacto", "Checklist_Para_Rodrigo"],
      minLinhas: 5,
    },
  ];

  const pastas = new Map<string, ReturnType<typeof lerXlsx>>();

  for (const e of esperado) {
    secao(`${e.arquivo}`);
    const caminho = join(PASTA, e.arquivo);
    ok("existe no disco", existsSync(caminho), caminho);
    if (!existsSync(caminho)) continue;
    ok("tem conteudo", statSync(caminho).size > 5000,
      `${(statSync(caminho).size / 1024).toFixed(0)} KB`);

    let pasta: ReturnType<typeof lerXlsx>;
    try {
      pasta = lerXlsx(new Uint8Array(readFileSync(caminho)));
    } catch (erro) {
      ok("o leitor de xlsx do repositorio ABRE o arquivo", false,
        erro instanceof Error ? erro.message : String(erro));
      continue;
    }
    pastas.set(e.arquivo, pasta);
    ok("o leitor de xlsx do repositorio ABRE o arquivo", true);

    const nomes = pasta.abas.map((a) => a.nome);
    ok(`as ${e.abas.length} abas esperadas estao la`,
      e.abas.every((x) => nomes.includes(x)),
      `faltam: ${e.abas.filter((x) => !nomes.includes(x)).join(", ")} | tem: ${nomes.join(", ")}`);

    const maior = Math.max(...pasta.abas.map((a) => a.linhas.length));
    ok(`a maior aba tem pelo menos ${e.minLinhas} linhas`, maior >= e.minLinhas,
      String(maior));

    // Cabecalho em toda aba: sem ele a planilha nao se le.
    ok("toda aba tem cabecalho na primeira linha",
      pasta.abas.every((a) => a.linhas.length >= 1 && a.linhas[0].length >= 1 &&
        val(a.linhas[0][0]) !== ""),
      pasta.abas.filter((a) => a.linhas.length === 0).map((a) => a.nome).join(","));
  }

  // ═══ O conteudo, e nao so a estrutura ════════════════════════════

  secao("O conteudo confere");
  const bruto = pastas.get("ML_API_RAW_SETEMBRO_2026.xlsx");
  const calc = pastas.get("AGENTE_CALCULO_SETEMBRO_2026.xlsx");
  const recon = pastas.get("RECONCILIACAO_ML_SETEMBRO_2026.xlsx");

  if (bruto !== undefined) {
    const orders = aba(bruto, "Orders_Raw_Normalized");
    const cab = (orders?.linhas[0] ?? []).map(val);
    ok("Orders tem as tres colunas monetarias que o gate distingue",
      ["total_amount", "paid_amount", "soma_gross_price"].every((c) => cab.includes(c)),
      cab.slice(0, 20).join(","));
    ok("e tem order_id como primeira coluna — §40",
      cab[0] === "order_id", cab[0]);

    const pag = aba(bruto, "Payments_Raw_Normalized");
    const cabPag = (pag?.linhas[0] ?? []).map(val);
    ok("Payments e por PAGAMENTO, com order_id para o join",
      cabPag.includes("order_id") && cabPag.includes("payment_id"), cabPag.join(","));
    ok("§15: ha mais linhas de pagamento que de pedido",
      (pag?.linhas.length ?? 0) > (orders?.linhas.length ?? 0),
      `${pag?.linhas.length} vs ${orders?.linhas.length}`);

    // ── Nenhum dado pessoal, e isto e verificado no ARQUIVO ────────
    const proibidas = /nickname|buyer|comprador|email|telefone|endereco|cpf|token|secret|seller/i;
    const colunasSuspeitas = bruto.abas.flatMap((a) =>
      (a.linhas[0] ?? []).map(val).filter((c) => proibidas.test(c)));
    ok("§43: nenhuma coluna de dado pessoal ou credencial",
      colunasSuspeitas.length === 0, colunasSuspeitas.join(","));
  }

  if (calc !== undefined) {
    const resumo = aba(calc, "Resumo");
    const texto = (resumo?.linhas ?? []).flat().map(val).join(" | ");
    ok("§16: o Resumo declara a regra de VALOR usada hoje",
      /paid_amount/.test(texto), texto.slice(0, 120));
    ok("§16: e a regra de DATA, dizendo o fuso",
      /date_approved/.test(texto) && /-03:00/.test(texto));
    ok("§42: e registra que a regra NAO foi alterada",
      /nao desconta|nao usa total_amount/.test(texto));

    const porPedido = aba(calc, "Calculo_Por_Pedido");
    const cab = (porPedido?.linhas[0] ?? []).map(val);
    for (const exigida of ["order_id", "agente_incluiu", "agente_motivo",
      "agente_campo_valor", "agente_campo_data", "agente_data_usada", "excecoes"]) {
      ok(`§41: Calculo_Por_Pedido tem a coluna \`${exigida}\``, cab.includes(exigida));
    }
    const incluidos = aba(calc, "Incluidos");
    const excluidos = aba(calc, "Excluidos");
    ok("Incluidos + Excluidos somam o Calculo_Por_Pedido",
      (incluidos?.linhas.length ?? 0) - 1 + (excluidos?.linhas.length ?? 0) - 1 ===
        (porPedido?.linhas.length ?? 0) - 1,
      `${(incluidos?.linhas.length ?? 0) - 1} + ${(excluidos?.linhas.length ?? 0) - 1} vs ${(porPedido?.linhas.length ?? 0) - 1}`);
  }

  if (recon !== undefined) {
    const painel = aba(recon, "Painel_Oficial");
    const texto = (painel?.linhas ?? []).flat().map(val).join(" | ");
    ok("§39: o Painel_Oficial registra os seis numeros exibidos",
      /393\.839/.test(texto) && /10898|10\.898/.test(texto) &&
        /11361|11\.361/.test(texto) && /36,14/.test(texto) &&
        /34,67/.test(texto) && /414/.test(texto),
      texto.slice(0, 160));
    ok("§4: e registra que o painel nao mostra centavos",
      /centavos/i.test(texto));
    ok("§7: e que nenhuma formula foi escolhida por chegar perto",
      /nao foi escolhida|nao foram escolhidas|chegar perto/i.test(texto));

    const cruzadas = aba(recon, "Metricas_Cruzadas");
    ok("§31: as metricas cruzadas incluem os dois precos medios e as canceladas",
      (cruzadas?.linhas ?? []).some((l) => /Preco medio por venda/.test(val(l[0]))) &&
      (cruzadas?.linhas ?? []).some((l) => /Preco medio por unidade/.test(val(l[0]))) &&
      (cruzadas?.linhas ?? []).some((l) => /Canceladas/.test(val(l[0]))));

    const cats = aba(recon, "Categorias_Divergencia");
    const textoCats = (cats?.linhas ?? []).flat().map(val).join(" | ");
    ok("§33: a decomposicao nomeia o NAO EXPLICADO",
      /NAO EXPLICADO/.test(textoCats), textoCats.slice(0, 120));

    const check = aba(recon, "Checklist_Para_Rodrigo");
    ok("§48: ha checklist com pelo menos 6 itens",
      (check?.linhas.length ?? 0) >= 7, String((check?.linhas.length ?? 0) - 1));
  }

  // ═══ O join por order_id funciona de verdade — §40 ════════════════

  secao("§40: o mesmo pedido se acha nos tres arquivos");
  if (bruto !== undefined && calc !== undefined && recon !== undefined) {
    const coluna = (p: ReturnType<typeof lerXlsx>, nomeAba: string, nomeCol: string) => {
      const a = aba(p, nomeAba);
      if (a === null || a.linhas.length < 2) return [] as string[];
      const i = a.linhas[0].findIndex((c) => val(c) === nomeCol);
      if (i < 0) return [] as string[];
      return a.linhas.slice(1).map((l) => val(l[i])).filter((x) => x !== "");
    };
    const idsBruto = new Set(coluna(bruto, "Orders_Raw_Normalized", "order_id"));
    const idsCalc = new Set(coluna(calc, "Calculo_Por_Pedido", "order_id"));
    const idsPag = new Set(coluna(bruto, "Payments_Raw_Normalized", "order_id"));
    const idsImpacto = coluna(recon, "Pedidos_Maior_Impacto", "order_id");

    ok("os dois arquivos grandes tem ids", idsBruto.size > 10000 && idsCalc.size > 10000,
      `${idsBruto.size} / ${idsCalc.size}`);
    const emComum = [...idsCalc].filter((x) => idsBruto.has(x)).length;
    ok("§40: >99% dos pedidos do calculo existem no bruto",
      emComum / idsCalc.size > 0.99, `${emComum} de ${idsCalc.size}`);
    ok("§40: todo order_id de pagamento existe no bruto",
      [...idsPag].every((x) => idsBruto.has(x)),
      `${[...idsPag].filter((x) => !idsBruto.has(x)).length} orfaos`);
    ok("§40: todo pedido de maior impacto existe nos outros dois",
      idsImpacto.length > 0 && idsImpacto.every((x) => idsBruto.has(x) && idsCalc.has(x)),
      `${idsImpacto.filter((x) => !idsBruto.has(x) || !idsCalc.has(x)).length} orfaos de ${idsImpacto.length}`);

    // ANCORA: se a leitura de coluna estivesse devolvendo vazio, tudo
    // acima passaria por vacuidade.
    ok("ANCORA: as listas de id NAO estao vazias",
      idsBruto.size > 0 && idsCalc.size > 0 && idsPag.size > 0 && idsImpacto.length > 0);
  }

  console.log(`\nPASS ${pass}   FAIL ${fail}`);
  process.exit(fail === 0 ? 0 : 1);
}

main();
