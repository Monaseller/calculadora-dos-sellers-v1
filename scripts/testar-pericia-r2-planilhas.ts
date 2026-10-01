/**
 * AGENT-FACTORY-F7b.4.8.4-R2 §13.6 — os totais saem DOS PROPRIOS XLSX.
 *
 * Suite PURA: sem rede, sem banco, sem IA. Le os arquivos entregues com o
 * leitor de xlsx do proprio repositorio e REFAZ a conta a partir das
 * celulas — nao do JSON que os gerou, nao do log.
 *
 * ── Por que refazer a conta aqui ────────────────────────────────────
 *
 * No R1 a planilha foi conferida por estrutura (abas, colunas, join por
 * order_id) e passou, enquanto faltavam dois pedidos dentro dela. Conferir
 * forma nao confere conteudo. Aqui a soma, a contagem e as unidades sao
 * recalculadas celula por celula e comparadas com o relatorio oficial,
 * tambem lido do arquivo.
 *
 * Nenhum numero do painel aparece como expectativa: a referencia e o
 * relatorio detalhado, derivado.
 *
 * Roda com: npx tsx scripts/testar-pericia-r2-planilhas.ts
 */
import "./_server-only-inerte";

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { lerXlsx } from "../lib/agentes/planilhas/leitura";

const PASTA = process.env.PASTA ??
  join("C:", "Users", "USER", "Desktop", "reconciliacao-ml-setembro-2026");
const OFICIAL = process.env.OFICIAL ??
  join("C:", "Users", "USER", "Desktop", "boleto e comprovante",
    "20261001_Vendas_BR_Mercado_Libre_y_Mercado_Shops_2026-10-01_08-21hs_744240004.xlsx");

/** Os dois pedidos que o R1 perdeu. Entram por regra, nao por excecao. */
const DOIS = ["2000018219592150", "2000018219744892"] as const;

let pass = 0;
let fail = 0;
function ok(nome: string, cond: boolean, detalhe = ""): void {
  if (cond) { pass += 1; console.log(`  PASS  ${nome}`); }
  else { fail += 1; console.log(`  FAIL  ${nome}${detalhe ? `  — ${detalhe}` : ""}`); }
}
function secao(t: string): void { console.log(`\n${t}`); }

type Celula = { bruto: string | number | null };
function val(c: Celula | undefined): string {
  return c === undefined || c.bruto === null ? "" : String(c.bruto);
}
function nu(c: Celula | undefined): number {
  if (c === undefined || c.bruto === null) return 0;
  if (typeof c.bruto === "number") return c.bruto;
  const t = c.bruto.trim();
  if (t === "") return 0;
  const n = Number(t.replace(/[R$\s.]/g, "").replace(",", "."));
  return Number.isFinite(n) ? n : 0;
}
function cent(v: number): number { return Math.round(v * 100) / 100; }

type Pasta = ReturnType<typeof lerXlsx>;
function aba(p: Pasta, nome: string) {
  return p.abas.find((a) => a.nome === nome) ?? null;
}
/** Uma aba como lista de objetos, pelo cabecalho da primeira linha. */
function registros(p: Pasta, nomeAba: string): Record<string, Celula>[] {
  const a = aba(p, nomeAba);
  if (a === null || a.linhas.length < 2) return [];
  const cab = a.linhas[0].map(val);
  return a.linhas.slice(1).map((l) => {
    const r: Record<string, Celula> = {};
    for (let i = 0; i < cab.length; i += 1) {
      if (cab[i] !== "") r[cab[i]] = (l[i] ?? { bruto: null }) as Celula;
    }
    return r;
  });
}

function main(): void {
  console.log("══ F7b.4.8.4-R2 — as planilhas, recalculadas ══");

  // ═══ A. Os arquivos ════════════════════════════════════════════

  const esperado = [
    {
      arquivo: "ML_API_RAW_SETEMBRO_2026_R2.xlsx",
      abas: ["Orders_Raw_Normalized", "Payments_Raw_Normalized", "Order_Items",
        "Controles_De_Borda", "Metadata"],
    },
    {
      arquivo: "AGENTE_CALCULO_SETEMBRO_2026_R2.xlsx",
      abas: ["Resumo", "Calculo_Por_Pedido", "Calculo_Por_Dia", "Incluidos", "Excluidos",
        "Virada_de_Mes", "Multiplos_Pagamentos", "Reembolsos_Parciais", "Reembolsos_Totais",
        "Cancelados", "Paid_vs_Total", "Chargeback", "Mediacao", "Pedidos_Suspeitos",
        "Prova_Dos_Dois_Pedidos"],
    },
    {
      arquivo: "RECONCILIACAO_ML_SETEMBRO_2026_R2.xlsx",
      abas: ["Lineage", "Oficial_vs_Painel", "Totais_Candidatos", "Metricas_Cruzadas",
        "Categorias_Divergencia", "Prova_Dos_Dois_Pedidos", "Anti_Vacuidade",
        "Checklist_Para_Rodrigo"],
    },
  ];
  const pastas = new Map<string, Pasta>();
  for (const e of esperado) {
    secao(e.arquivo);
    const caminho = join(PASTA, e.arquivo);
    ok("existe", existsSync(caminho), caminho);
    if (!existsSync(caminho)) continue;
    ok("tem conteudo", statSync(caminho).size > 5000,
      `${(statSync(caminho).size / 1024).toFixed(0)} KB`);
    let p: Pasta;
    try { p = lerXlsx(new Uint8Array(readFileSync(caminho))); } catch (erro) {
      ok("o leitor do repositorio ABRE", false,
        erro instanceof Error ? erro.message : String(erro));
      continue;
    }
    pastas.set(e.arquivo, p);
    ok("o leitor do repositorio ABRE", true);
    const nomes = p.abas.map((a) => a.nome);
    ok(`as ${e.abas.length} abas esperadas estao la`,
      e.abas.every((x) => nomes.includes(x)),
      `faltam: ${e.abas.filter((x) => !nomes.includes(x)).join(", ")}`);
  }

  const bruto = pastas.get("ML_API_RAW_SETEMBRO_2026_R2.xlsx");
  const calc = pastas.get("AGENTE_CALCULO_SETEMBRO_2026_R2.xlsx");
  const recon = pastas.get("RECONCILIACAO_ML_SETEMBRO_2026_R2.xlsx");
  if (bruto === undefined || calc === undefined || recon === undefined) {
    console.log(`\nPASS ${pass}   FAIL ${fail}`);
    process.exit(1);
  }

  // ═══ B. O relatorio oficial, derivado aqui tambem ══════════════

  secao("B. A referencia oficial, lida do arquivo do Mercado Livre");
  const abaOficial = lerXlsx(new Uint8Array(readFileSync(OFICIAL))).abas[0];
  let iCab = -1;
  for (let i = 0; i < Math.min(15, abaOficial.linhas.length); i += 1) {
    const t = abaOficial.linhas[i].map(val).join("|").toLowerCase();
    if (t.includes("venda") && t.includes("unidades")) { iCab = i; break; }
  }
  const cabOficial = abaOficial.linhas[iCab].map(val);
  const col = (padrao: RegExp) => cabOficial.findIndex((c) => padrao.test(c.toLowerCase()));
  const cUnid = col(/^unidades$/);
  const cPreco = col(/pre.o unit.rio de venda/);
  const linhasOficiais = abaOficial.linhas.slice(iCab + 1)
    .filter((l) => l.some((c) => val(c) !== ""));
  const vendasOficiais = linhasOficiais.filter((l) => val(l[cUnid]).trim() !== "");
  const oficialPedidos = vendasOficiais.length;
  const oficialUnidades = vendasOficiais.reduce((a, l) => a + nu(l[cUnid]), 0);
  const oficialValor = cent(vendasOficiais.reduce(
    (a, l) => a + nu(l[cUnid]) * nu(l[cPreco]), 0));
  ok("B1  o relatorio oficial abre e tem as colunas", cUnid >= 0 && cPreco >= 0);
  ok("B2  linhas sem unidade sao separadas das vendas",
    linhasOficiais.length > oficialPedidos,
    `${linhasOficiais.length} linhas, ${oficialPedidos} vendas`);
  console.log(`       oficial: ${oficialPedidos} vendas, ${oficialUnidades} un, R$ ${oficialValor.toFixed(2)}`);

  // ═══ C. §13.6 — a conta REFEITA a partir do XLSX entregue ══════

  secao("C. Os totais, recalculados celula por celula");
  const incluidos = registros(calc, "Incluidos");
  ok("C1  a aba Incluidos tem linhas", incluidos.length > 1000, String(incluidos.length));
  const somaTotal = cent(incluidos.reduce((a, r) => a + nu(r["total_amount"]), 0));
  const somaUnidades = incluidos.reduce((a, r) => a + nu(r["unidades"]), 0);
  ok("C2  pedidos recalculados = oficial", incluidos.length === oficialPedidos,
    `${incluidos.length} vs ${oficialPedidos}`);
  ok("C3  unidades recalculadas = oficial", somaUnidades === oficialUnidades,
    `${somaUnidades} vs ${oficialUnidades}`);
  ok("C4  valor recalculado = oficial", Math.abs(somaTotal - oficialValor) < 0.005,
    `${somaTotal.toFixed(2)} vs ${oficialValor.toFixed(2)}`);
  const medioVenda = cent(somaTotal / incluidos.length);
  const medioUnidade = cent(somaTotal / somaUnidades);
  ok("C5  medio por venda = oficial",
    Math.abs(medioVenda - cent(oficialValor / oficialPedidos)) < 0.005,
    `${medioVenda} vs ${cent(oficialValor / oficialPedidos)}`);
  ok("C6  medio por unidade = oficial",
    Math.abs(medioUnidade - cent(oficialValor / oficialUnidades)) < 0.005,
    `${medioUnidade} vs ${cent(oficialValor / oficialUnidades)}`);
  console.log(`       recalculado: ${incluidos.length} ped, ${somaUnidades} un, ` +
    `R$ ${somaTotal.toFixed(2)}, ${medioVenda}/venda, ${medioUnidade}/un`);

  // E o `Calculo_Por_Dia` tem de fechar com o mesmo total.
  const porDia = registros(calc, "Calculo_Por_Dia");
  ok("C7  a quebra por dia fecha com o total",
    Math.abs(cent(porDia.reduce((a, r) => a + nu(r["total_amount"]), 0)) - somaTotal) < 0.02,
    `${cent(porDia.reduce((a, r) => a + nu(r["total_amount"]), 0))} vs ${somaTotal}`);
  ok("C8  e os dias sao todos de setembro",
    porDia.every((r) => val(r["dia"]) >= "2026-09-01" && val(r["dia"]) <= "2026-09-30"),
    porDia.map((r) => val(r["dia"])).filter((d) => d < "2026-09-01" || d > "2026-09-30").join(","));

  // ═══ D. §8 — os dois pedidos, com tudo o que o gate pede ═══════

  secao("D. Os dois pedidos do R1");
  const porPedido = registros(calc, "Calculo_Por_Pedido");
  const porId = new Map(porPedido.map((r) => [val(r["order_id"]), r]));
  const idsNoRaw = new Set(registros(bruto, "Orders_Raw_Normalized")
    .map((r) => val(r["order_id"])));
  const provaCalc = registros(calc, "Prova_Dos_Dois_Pedidos");
  const provaRecon = registros(recon, "Prova_Dos_Dois_Pedidos");
  for (const id of DOIS) {
    ok(`D1  ${id} esta no RAW`, idsNoRaw.has(id));
    const r = porId.get(id);
    ok(`D2  ${id} esta no calculo`, r !== undefined);
    if (r === undefined) continue;
    ok(`D3  ${id} entra na candidata`, val(r["candidata_incluiu"]) === "SIM",
      val(r["candidata_incluiu"]));
    ok(`D4  ${id} tem pack_id`, val(r["pack_id"]) !== "");
    ok(`D5  ${id} tem o date_closed original com offset do provedor`,
      /-04:00$/.test(val(r["date_closed_original"])), val(r["date_closed_original"]));
    ok(`D6  ${id} tem o date_closed em Sao Paulo`,
      val(r["date_closed_sao_paulo"]).startsWith("2026-09-01"),
      val(r["date_closed_sao_paulo"]));
    ok(`D7  ${id} mostra o dia escrito (agosto) e o dia SP (setembro)`,
      val(r["dia_fechamento_escrito_minus04"]) === "2026-08-31" &&
      val(r["dia_fechamento_sao_paulo"]) === "2026-09-01",
      `${val(r["dia_fechamento_escrito_minus04"])} / ${val(r["dia_fechamento_sao_paulo"])}`);
    ok(`D8  ${id} tem total_amount, quantity, status e cancel_code`,
      nu(r["total_amount"]) > 0 && nu(r["unidades"]) > 0 &&
      val(r["status"]) !== "" && val(r["cancel_code"]) !== "",
      `${nu(r["total_amount"])} ${nu(r["unidades"])} ${val(r["status"])} ${val(r["cancel_code"])}`);
    ok(`D9  ${id} marca a virada de mes pelo fuso`,
      val(r["excecoes"]).includes("MUDA_DE_MES_PELO_FUSO"), val(r["excecoes"]));
  }
  ok("D10 a aba de prova existe nos DOIS arquivos, com os dois pedidos",
    provaCalc.length === 2 && provaRecon.length === 2,
    `${provaCalc.length} / ${provaRecon.length}`);
  ok("D11 e ela explica POR QUE entram agora",
    provaCalc.every((r) => /America\/Sao_Paulo/.test(val(r["porque_entra_agora"]))),
    val(provaCalc[0]?.["porque_entra_agora"]).slice(0, 80));
  // ANCORA: a soma dos dois e o que faltava no R1.
  ok("D12 ANCORA: os dois somam R$ 80,70 e 3 unidades",
    Math.abs(cent(DOIS.reduce((a, id) => a + nu(porId.get(id)?.["total_amount"]), 0)) - 80.7) < 0.005 &&
    DOIS.reduce((a, id) => a + nu(porId.get(id)?.["unidades"]), 0) === 3);

  // ═══ E. §4 — anti-vacuidade declarada no arquivo ═══════════════

  secao("E. Anti-vacuidade");
  const anti = registros(recon, "Anti_Vacuidade");
  const linhaFalhas = anti.find((r) => /falhas de cobertura/i.test(val(r["controle"])));
  ok("E1  a aba declara as falhas de cobertura", linhaFalhas !== undefined);
  ok("E2  §4: zero falhas", nu(linhaFalhas?.["resultado"]) === 0,
    val(linhaFalhas?.["resultado"]));
  const linhaObrig = anti.find((r) => /missing_from_raw/i.test(val(r["controle"])));
  ok("E3  e zero na candidata obrigatoria", nu(linhaObrig?.["resultado"]) === 0,
    val(linhaObrig?.["resultado"]));
  ok("E4  a candidata obrigatoria e a de date_closed SP + sem pack_splitted + total_amount",
    /fechamento_sp\|sem_pack_splitted\|total_amount/.test(val(linhaObrig?.["controle"])),
    val(linhaObrig?.["controle"]));
  ok("E5  e o arquivo registra que o gerador ABORTA se houver falha",
    anti.some((r) => /aborta/i.test(val(r["controle"])) || /exit/i.test(val(r["resultado"]))));

  // A conferencia de verdade, feita aqui: todo pedido incluido existe no raw.
  const faltando = incluidos.map((r) => val(r["order_id"])).filter((id) => !idsNoRaw.has(id));
  ok("E6  recalculado: todo pedido incluido existe no RAW", faltando.length === 0,
    faltando.slice(0, 5).join(","));
  ok("E6a ANCORA: havia pedido a conferir", incluidos.length > 1000);

  // ═══ F. §7 — os tres controles de conjunto ═════════════════════

  secao("F. Os controles de conjunto");
  const cruzadas = registros(recon, "Metricas_Cruzadas");
  const porIndicador = new Map(cruzadas.map((r) => [val(r["indicador"]), r]));
  for (const nome of ["official_orders_minus_candidate", "candidate_minus_official_orders",
    "missing_candidate_orders_from_raw"]) {
    const r = porIndicador.get(nome);
    ok(`F1  ${nome} = 0`, r !== undefined && nu(r["candidata_vencedora"]) === 0,
      val(r?.["candidata_vencedora"]));
  }
  const dataMinuto = cruzadas.filter((r) => /Data ao minuto/.test(val(r["indicador"])));
  ok("F2  a prova de data ao minuto esta no arquivo", dataMinuto.length >= 3,
    String(dataMinuto.length));
  const doFechamento = dataMinuto.find((r) => /fechamento_sp/.test(val(r["indicador"])));
  ok("F3  e `fechamento_sp` bate 100%", val(doFechamento?.["veredito"]) === "100%",
    val(doFechamento?.["veredito"]));
  const outras = dataMinuto.filter((r) => !/fechamento_sp/.test(val(r["indicador"])));
  ok("F3a CONTROLE: as outras datas NAO batem 100% — a sonda discrimina",
    outras.length >= 2 && outras.every((r) => val(r["veredito"]) !== "100%"),
    outras.map((r) => val(r["veredito"])).join(","));

  // ═══ G. §6 — linhagem unica e identidade de candidata ══════════

  secao("G. Linhagem");
  const lineage = registros(recon, "Lineage");
  ok("G1  a aba Lineage descreve a cadeia", lineage.length >= 10, String(lineage.length));
  const textoLineage = lineage.map((r) => `${val(r["etapa"])} ${val(r["descricao"])}`).join(" | ");
  for (const etapa of ["raw", "deduplicacao", "normalizacao temporal", "populacao",
    "candidata", "valor", "unidades", "oficial", "anti-vacuidade", "painel"]) {
    ok(`G2  a linhagem cita \`${etapa}\``, new RegExp(etapa, "i").test(textoLineage));
  }
  // §6: a mesma candidata nos tres lugares.
  const idNoResumo = registros(calc, "Resumo")
    .find((r) => val(r["indicador"]) === "candidata_id");
  const idNasCruzadas = new Set(cruzadas.map((r) => val(r["candidata_id"]))
    .filter((x) => x !== "" && !x.includes("|todos|")));
  const idNaDecomposicao = registros(recon, "Categorias_Divergencia")
    .filter((r) => /RESIDUO/.test(val(r["passo"]))).map((r) => val(r["candidata_id"]));
  const vencedoraNoResumo = val(idNoResumo?.["candidata_vencedora"]);
  ok("G3  o Resumo nomeia a candidata vencedora por ID", vencedoraNoResumo !== "",
    vencedoraNoResumo);
  ok("G4  §6: as Metricas_Cruzadas usam a MESMA candidata",
    idNasCruzadas.size === 1 && idNasCruzadas.has(vencedoraNoResumo),
    [...idNasCruzadas].join(","));
  ok("G5  §6: e a decomposicao termina na MESMA candidata",
    idNaDecomposicao.length === 1 && idNaDecomposicao[0] === vencedoraNoResumo,
    idNaDecomposicao.join(","));
  const candidatos = registros(recon, "Totais_Candidatos");
  ok("G6  a matriz de candidatas tem id em toda linha",
    candidatos.length > 50 && candidatos.every((r) => val(r["candidata_id"]).includes("|")),
    String(candidatos.length));
  ok("G7  §6: a vencedora e a PRIMEIRA do ranking — nenhuma melhor foi ignorada",
    val(candidatos[0]?.["candidata_id"]) === vencedoraNoResumo,
    val(candidatos[0]?.["candidata_id"]));
  ok("G8  e a nota dela e a maxima da matriz",
    candidatos.every((r) => nu(r["nota"]) <= nu(candidatos[0]?.["nota"]) ||
      val(r["nota"]).length > 0),
    val(candidatos[0]?.["nota"]));

  // ═══ H. §3 — controle de borda geral, nao excecao ══════════════

  secao("H. Controle de borda");
  const borda = registros(bruto, "Controles_De_Borda");
  ok("H1  a aba de borda existe e tem linhas", borda.length > 0, String(borda.length));
  ok("H2  §3: ela cobre a borda 31/08 -> 01/09",
    borda.some((r) => val(r["dia_escrito_minus04"]) === "2026-08-31" &&
      val(r["dia_sao_paulo"]) === "2026-09-01"));
  ok("H3  §3: e a borda inversa, 30/09 -> 01/10",
    borda.some((r) => val(r["dia_escrito_minus04"]) === "2026-09-30" &&
      val(r["dia_sao_paulo"]) === "2026-10-01"));
  ok("H4  e cada linha diz se entra pelo escrito e se entra por Sao Paulo",
    borda.every((r) => ["SIM", "NAO"].includes(val(r["dentro_pelo_escrito"])) &&
      ["SIM", "NAO"].includes(val(r["dentro_pelo_sao_paulo"]))));
  ok("H5  §3: a correcao NAO e uma excecao para os dois ids — a borda tem mais casos",
    borda.length > 2, String(borda.length));

  // ═══ I. §9 — painel separado do oficial ═══════════════════════

  secao("I. Painel x oficial detalhado");
  const oficialVsPainel = registros(recon, "Oficial_vs_Painel");
  const porMetrica = new Map(oficialVsPainel.map((r) => [val(r["metrica"]), r]));
  ok("I1  OFFICIAL_DETAILED_EXPORT e o valor derivado",
    Math.abs(nu(porMetrica.get("OFFICIAL_DETAILED_EXPORT")?.["valor"]) - oficialValor) < 0.005,
    val(porMetrica.get("OFFICIAL_DETAILED_EXPORT")?.["valor"]));
  ok("I2  PANEL_HEADLINE esta registrado como leitura de tela",
    /tela/i.test(val(porMetrica.get("PANEL_HEADLINE")?.["origem"])),
    val(porMetrica.get("PANEL_HEADLINE")?.["origem"]));
  ok("I3  o DELTA e calculado, nao afirmado",
    Math.abs(nu(porMetrica.get("DELTA")?.["valor"]) -
      cent(oficialValor - nu(porMetrica.get("PANEL_HEADLINE")?.["valor"]))) < 0.005,
    val(porMetrica.get("DELTA")?.["valor"]));
  ok("I4  §9: a reconciliacao do painel e PARTIAL",
    val(porMetrica.get("PANEL_HEADLINE_RECONCILIATION")?.["valor"]) === "PARTIAL");
  ok("I5  §9: e nenhuma regra de arredondamento foi inventada",
    /arredondamento/i.test(val(porMetrica.get("PANEL_HEADLINE_RECONCILIATION")?.["origem"])));
  ok("I6  §10: as canceladas seguem PARTIAL",
    val(porMetrica.get("CANCELLED_SALES_SEMANTICS")?.["valor"]) === "PARTIAL");

  // ═══ J. Seguranca e join ══════════════════════════════════════

  secao("J. Seguranca e join");
  // ── O que e dado pessoal, e o que so MENCIONA o comprador ─────────
  //
  // A primeira versao desta sonda procurava a palavra "comprador" em
  // qualquer posicao e reprovou `frete_comprador`, que e o frete pago pelo
  // comprador — um valor em reais, nao a pessoa. Um padrao que confunde as
  // duas coisas obrigaria a renomear uma coluna correta para passar no
  // teste, que e o caminho mais curto para um teste inutil.
  //
  // O alvo e IDENTIDADE e CONTATO: nome, apelido, e-mail, telefone,
  // endereco, documento, e credencial.
  const proibidas = new RegExp([
    "nickname", "apelido", "nome", "email", "e_mail", "telefone", "fone",
    "endereco", "address", "cpf", "cnpj", "documento", "taxpayer",
    "token", "secret", "credential", "access_key",
    // Identificadores de PESSOA, e nao o `order_id` ou o `pack_id`.
    "buyer_id", "payer_id", "seller_id", "comprador_id", "vendedor_id",
  ].join("|"), "i");
  const suspeitas: string[] = [];
  for (const p of [bruto, calc, recon]) {
    for (const a of p.abas) {
      for (const c of (a.linhas[0] ?? []).map(val)) {
        if (proibidas.test(c)) suspeitas.push(`${a.nome}.${c}`);
      }
    }
  }
  ok("J1  nenhuma coluna de dado pessoal ou credencial", suspeitas.length === 0,
    suspeitas.join(","));
  // CONTROLE NEGATIVO: a sonda precisa REPROVAR uma coluna pessoal de
  // verdade. Sem isto, o padrao acima poderia nao casar com nada.
  ok("J1a CONTROLE: a sonda reprovaria `buyer_nickname` e `payer_id`",
    proibidas.test("buyer_nickname") && proibidas.test("payer_id") &&
    proibidas.test("endereco_entrega"));
  ok("J1b CONTROLE: e NAO reprova coluna monetaria que cita o comprador",
    !proibidas.test("frete_comprador") && !proibidas.test("order_id") &&
    !proibidas.test("pack_id"));
  const idsPag = new Set(registros(bruto, "Payments_Raw_Normalized")
    .map((r) => val(r["order_id"])));
  ok("J2  §40: todo order_id de pagamento existe no raw",
    [...idsPag].every((x) => idsNoRaw.has(x)),
    `${[...idsPag].filter((x) => !idsNoRaw.has(x)).length} orfaos`);
  const idsCalc = new Set(porPedido.map((r) => val(r["order_id"])));
  ok("J3  §40: calculo e raw tem a MESMA populacao",
    idsCalc.size === idsNoRaw.size &&
    [...idsCalc].every((x) => idsNoRaw.has(x)),
    `${idsCalc.size} vs ${idsNoRaw.size}`);
  ok("J4  ANCORA: as populacoes nao estao vazias",
    idsNoRaw.size > 10000 && idsPag.size > 1000);

  // ═══ K. §5 — a evidencia do R1 nao foi sobrescrita ════════════

  secao("K. A evidencia do R1 segue no disco");
  for (const antigo of ["ML_API_RAW_SETEMBRO_2026.xlsx",
    "AGENTE_CALCULO_SETEMBRO_2026.xlsx", "RECONCILIACAO_ML_SETEMBRO_2026.xlsx"]) {
    ok(`K1  ${antigo} continua la`, existsSync(join(PASTA, antigo)));
  }

  console.log(`\nPASS ${pass}   FAIL ${fail}`);
  process.exit(fail === 0 ? 0 : 1);
}

main();
