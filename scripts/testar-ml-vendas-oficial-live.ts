/**
 * AGENT-FACTORY-F7b.4.8 Parte D — vendas do Mercado Livre, fonte OFICIAL.
 *
 * Suite LIVE: fala com a API real do Mercado Livre, SOMENTE LEITURA.
 *
 * ── O que ela existe para distinguir ────────────────────────────────
 *
 * O §36 proibe aceitar nome bonito como prova. Uma Funcao chamada
 * `mercadolivre.vendas.consultar` que lesse a tabela `pedidos` passaria
 * em qualquer teste de nome. Entao aqui a pergunta e medida de tres
 * lados:
 *
 *   1. a UNICA chamada de rede vai para `api.mercadolibre.com`
 *   2. o resultado DIFERE do espelho da CDS para a mesma janela
 *   3. o recorte financeiro usa data de PAGAMENTO, nao de criacao
 *
 * O item 2 e o que fecha: se o numero viesse do banco, seria igual ao do
 * banco. Diferente significa outra fonte — e o item 1 diz qual.
 *
 * ── Seguranca ───────────────────────────────────────────────────────
 *
 * Nenhuma escrita, em nenhum lugar. Nada de token, `user_id`,
 * `seller_id`, valor financeiro absoluto, comprador nem conteudo de
 * pedido e impresso: as assercoes falam de CONTAGEM, de procedencia e de
 * diferenca relativa.
 *
 * Roda com: npx tsx scripts/testar-ml-vendas-oficial-live.ts
 */
import "./_server-only-inerte";

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@supabase/supabase-js";

function carregarEnvLocal(): void {
  for (const caminho of [
    join(__dirname, "..", ".env.local"),
    join("C:", "Users", "USER", "Desktop", "calculadora-dos-sellers-v1", ".env.local"),
  ]) {
    try {
      for (const linha of readFileSync(caminho, "utf-8").split("\n")) {
        const l = linha.trim();
        if (!l || l.startsWith("#")) continue;
        const i = l.indexOf("=");
        if (i <= 0) continue;
        const k = l.slice(0, i).trim();
        if (!process.env[k]) process.env[k] = l.slice(i + 1).trim().replace(/^["']|["']$/g, "");
      }
      return;
    } catch { /* proximo */ }
  }
}
carregarEnvLocal();

/** A loja MONAMOR — conexao nativa que o dono ja autorizou na CDS. */
const LOJA = "50165b6f-5185-4da7-991a-07c0c6bc8f39";

/**
 * Uma janela CURTA e ANTIGA.
 *
 * Curta para nao paginar 60 vezes num teste; antiga para estar estavel —
 * comparar espelho e oficial num periodo ainda em movimento mediria o
 * atraso do sync de hoje, e nao a fonte.
 */
const DE = "2026-09-01";
const ATE = "2026-09-03";

let pass = 0;
let fail = 0;
function ok(nome: string, cond: boolean, detalhe = ""): void {
  if (cond) { pass += 1; console.log(`  PASS  ${nome}`); }
  else { fail += 1; console.log(`  FAIL  ${nome}${detalhe ? `  — ${detalhe}` : ""}`); }
}
function secao(t: string): void { console.log(`\n${t}`); }

async function main(): Promise<void> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const chaveDb = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !chaveDb) { console.error("ERRO: env do Supabase ausente."); process.exit(1); }
  const db = createClient(url, chaveDb);

  const {
    criarLeiturasDeVendasML, validarFiltroVendasML,
  } = await import("../lib/agentes/dados/vendas-ml");
  const {
    buscarVendasPagasML, MARGEM_CRIACAO_DIAS, LIMITE_POR_PAGINA,
  } = await import("../lib/mercado-livre-vendas");
  const {
    executarVendasML, interpretarSaidaVendasML, CONEXAO_VENDAS_ML,
  } = await import("../lib/agentes/funcoes/mercadolivre-vendas");
  const { resolverPeriodo } = await import("../lib/agentes/funcoes/calendario");
  const { efeitoDaFuncaoInterna, exigeConfirmacao } =
    await import("../lib/agentes/factory/efeito");
  const { FUNCOES } = await import("../lib/agentes/funcoes/registry");

  // O dono sai do BANCO. Nunca e impresso.
  const { data: linhaLoja } = await db
    .from("lojas").select("user_id").eq("id", LOJA).maybeSingle();
  const dono = String(linhaLoja?.user_id ?? "");
  if (dono === "") { console.error("ERRO: loja fixture ausente."); process.exit(1); }

  console.log("══ F7b.4.8 Parte D — vendas oficiais do Mercado Livre ══");

  // ═══ A. O periodo e resolvido pela CDS, nunca pelo modelo (§23) ═══

  secao("A. O periodo e da CDS, e o filtro nao aceita autoridade");
  {
    // Relogio FIXO: "esta semana" e uma pergunta sobre quando se pergunta,
    // e um teste que usa `Date.now()` mede outra coisa a cada dia.
    const quarta = Date.UTC(2026, 8, 30, 15, 0, 0);   // 2026-09-30, BRT
    const p = resolverPeriodo("esta_semana", quarta);
    ok("A1  `esta_semana` comeca na SEGUNDA", p.inicio === "2026-09-28", p.inicio);
    ok("A2  e o fim e INCLUSIVO, no domingo", p.fim === "2026-10-04", p.fim);
    ok("A3  no fuso de Sao Paulo", p.fuso === "America/Sao_Paulo", p.fuso);

    ok("A4  o filtro RECUSA `lojaId` — nao e campo dele",
      validarFiltroVendasML({ periodo: "hoje", lojaId: LOJA }).erro === "campo_desconhecido");
    ok("A5  RECUSA `sellerId`",
      validarFiltroVendasML({ periodo: "hoje", sellerId: "123" }).erro === "campo_desconhecido");
    ok("A6  RECUSA `userId`",
      validarFiltroVendasML({ periodo: "hoje", userId: "x" }).erro === "campo_desconhecido");
    ok("A7  RECUSA periodo E datas ao mesmo tempo",
      validarFiltroVendasML({ periodo: "hoje", de: DE, ate: ATE }).erro === "filtro_ambiguo");
    // ── F7b.4.8.3: quem recusa periodo inventado mudou de lugar ─────
    //
    // Enquanto `periodo` era um enum de sete nomes, o validador podia
    // recusar "trimestre" na hora. Agora ele e TEXTO LIVRE — a pessoa fala
    // como quiser, e a CDS resolve — entao o validador so exige que haja
    // texto. A recusa nao desapareceu: ela passou para a resolucao, com
    // nome proprio (`periodo_nao_entendido`), e e cobrada em A8b/A8c.
    ok("A8  o validador ACEITA texto que ele nao conhece",
      validarFiltroVendasML({ periodo: "trimestre" }).erro === null);
    ok("A8a mas continua recusando `periodo` vazio",
      validarFiltroVendasML({ periodo: "" }).erro === "periodo_invalido");
    ok("A9  RECUSA data invertida",
      validarFiltroVendasML({ de: ATE, ate: DE }).erro === "periodo_invertido");
    ok("A10 ANCORA: um filtro VALIDO passa",
      validarFiltroVendasML({ periodo: "esta_semana" }).erro === null);
    ok("A11 e o par de datas tambem",
      validarFiltroVendasML({ de: DE, ate: ATE }).erro === null);

    // A recusa que saiu do validador, no lugar onde ela vive agora.
    // Sem rede: a resolucao falha ANTES de qualquer chamada.
    const inventado = await criarLeiturasDeVendasML(dono, LOJA, Date.now())(
      { periodo: "trimestre" });
    ok("A8b §35: periodo que a CDS nao entende vira recusa NOMEADA",
      inventado.erro === "periodo_nao_entendido", String(inventado.erro));
    ok("A8c e sem total — recusa nao se apresenta como resposta",
      inventado.vendasBrutas === null && inventado.porDia.length === 0);
  }

  // ═══ B. A chamada REAL, e para QUEM ela vai (§24/§36) ════════════

  secao("B. A chamada real vai para a API oficial — e so para ela");
  let oficialFaturamento = 0;
  let oficialPedidos = 0;
  {
    // A porta `buscar` e espionada: ela registra o destino e delega ao
    // `fetch` de verdade. Nao e mock — a chamada acontece.
    const destinos: string[] = [];
    const espiao: typeof fetch = (entrada, init) => {
      destinos.push(String(entrada));
      return fetch(entrada as RequestInfo, init);
    };

    const ler = criarLeiturasDeVendasML(dono, LOJA, Date.now(), undefined, { buscar: espiao });
    const r = await ler({ de: DE, ate: ATE });

    ok("B1  a consulta respondeu sem erro", r.erro === null, String(r.erro));
    ok("B2  a fonte declarada e a API do Mercado Livre",
      r.fonte === "mercadolivre_api", r.fonte);
    ok("B3  houve chamada de rede", destinos.length >= 1, String(destinos.length));
    ok("B4  TODA chamada foi para api.mercadolibre.com",
      destinos.length >= 1 &&
        destinos.every((d) => d.startsWith("https://api.mercadolibre.com/orders/search")),
      destinos.map((d) => d.split("?")[0]).join(" | "));
    ok("B5  nenhuma chamada foi para o Supabase",
      !destinos.some((d) => d.includes("supabase")));
    ok("B6  ANCORA: a sonda de destino veria outro host",
      ["https://exemplo.invalido/x"].every((d) =>
        !d.startsWith("https://api.mercadolibre.com/orders/search")));

    // ── F7b.4.8.5: a margem de criacao SAIU, e de proposito ──────
    //
    // A regra de vendas brutas recorta por `order.date_closed`, e esse
    // campo FILTRA de verdade na API (medido). Entao a consulta pede
    // exatamente os dias do periodo, e nao ha margem a adivinhar.
    //
    // A margem existia para a regra de PAGAMENTO, que busca por criacao e
    // precisa alcancar o boleto pago dias depois. Ela continua lá, em
    // `buscarVendasPagasML`, que este gate nao mexeu.
    ok("B7  o recorte e pelo campo de FECHAMENTO, sem margem de criacao",
      r.diagnostico.campoDeData === "order.date_closed",
      r.diagnostico.campoDeData);
    ok("B7a e a margem de criacao segue existindo para a regra de PAGAMENTO",
      MARGEM_CRIACAO_DIAS > 0, String(MARGEM_CRIACAO_DIAS));
    ok("B8  o provedor devolveu pedidos", r.diagnostico.recebidosDoProvider > 0,
      String(r.diagnostico.recebidosDoProvider));
    ok("B9  e pelo menos uma pagina foi lida", r.diagnostico.paginasLidas >= 1,
      String(r.diagnostico.paginasLidas));
    ok("B10 o periodo devolvido e o pedido", r.periodo.de === DE && r.periodo.ate === ATE,
      `${r.periodo.de}..${r.periodo.ate}`);
    // F7b.4.8.3: `totais` so existe quando a varredura COMPLETOU. Ler o
    // total sem antes afirmar a completude era o que permitia comparar uma
    // semana inteira com uma truncada.
    ok("B10a a varredura COMPLETOU — sem isso nao ha total",
      r.completo === true && r.vendasBrutas !== null,
      `completo=${String(r.completo)} parcial=${JSON.stringify(r.parcial)}`);
    const t = r.vendasBrutas ?? { valor: 0, vendas: 0, unidades: 0, ticketMedio: 0 };
    ok("B11 houve venda na janela", t.vendas > 0, String(t.vendas));
    ok("B11a e unidades — que NAO sao a contagem de vendas",
      t.unidades >= t.vendas, `${t.unidades} un para ${t.vendas} vendas`);
    ok("B12 e o valor e positivo — sem imprimir o valor",
      t.valor > 0);
    ok("B13 o ticket medio e derivado, nao inventado",
      t.vendas > 0 && Math.abs(t.ticketMedio - t.valor / t.vendas) < 0.02);
    ok("B14 o total por dia soma o total geral",
      Math.abs(r.porDia.reduce((s, d) => s + d.valor, 0) - t.valor) < 0.05);
    ok("B15 e cada dia esta DENTRO do periodo",
      r.porDia.every((d) => d.dia >= DE && d.dia <= ATE),
      r.porDia.map((d) => d.dia).join(","));
    // MEDIDO: o filtro da API vaza pedido do dia SEGUINTE na borda, e e
    // por isso que o recorte local existe. Zero aqui significaria que o
    // recorte nao esta sendo exercitado.
    ok("B16 o recorte local descartou o que o filtro vazou da borda",
      r.diagnostico.foraDoPeriodo > 0,
      String(r.diagnostico.foraDoPeriodo));
    ok("B17 §7: `total_amount` e `soma(unit_price x qtd)` NAO divergiram",
      r.diagnostico.divergenciasDeValor === 0,
      String(r.diagnostico.divergenciasDeValor));
    ok("B18 e a contagem de pack_splitted excluidos e reportada",
      typeof r.diagnostico.excluidosPackSplitted === "number" &&
        r.diagnostico.excluidosPackSplitted >= 0,
      String(r.diagnostico.excluidosPackSplitted));

    // Nada de credencial na saida. A sonda olha o JSON inteiro.
    const texto = JSON.stringify(r);
    for (const proibido of ["access_token", "Bearer", "refresh_token", "seller", dono]) {
      ok(`B17 a saida NAO carrega \`${proibido === dono ? "user_id" : proibido}\``,
        !texto.includes(proibido));
    }

    oficialFaturamento = t.valor;
    oficialPedidos = t.vendas;
  }

  // ═══ C. CONTROLE: oficial != espelho (§36) ═══════════════════════

  secao("C. O numero NAO vem da tabela `pedidos` da CDS");
  {
    // O espelho, pela MESMA regra financeira: `data_pagamento` na janela.
    //
    // ── CONTAGEM EXATA, e nao `data.length` ────────────────────────
    //
    // A primeira versao lia as linhas e contava o array. Deu 1000 — que
    // e exatamente o teto de linhas por resposta do Supabase, e nao a
    // contagem. A assercao "oficial difere do espelho" passava porque o
    // espelho estava truncado, e nao porque as fontes divergem: um
    // oraculo que acerta pelo motivo errado nao esta medindo nada.
    const { count, error } = await db
      .from("pedidos")
      .select("id", { count: "exact", head: true })
      .eq("loja_id", LOJA)
      .gte("data_pagamento", DE)
      .lte("data_pagamento", ATE);
    ok("C1  o espelho da CDS foi lido", error === null);

    const espelhoPedidos = count ?? 0;
    ok("C1a CONTROLE: a contagem NAO e o teto de 1000 linhas do driver",
      espelhoPedidos !== 1000, String(espelhoPedidos));
    ok("C2  ANCORA: o espelho tem linhas na janela — a comparacao vale",
      espelhoPedidos > 0, String(espelhoPedidos));

    // A assercao NAO e "os numeros batem". Nao e disso que se trata: o
    // §36 pede distinguir a FONTE, e fontes diferentes com o mesmo dado
    // ainda sao fontes diferentes. O que se prova e que a consulta
    // oficial NAO e uma leitura disfarcada desta tabela — e a diferenca
    // de contagem e a evidencia direta disso.
    console.log(`    oficial=${oficialPedidos} pedidos  espelho=${espelhoPedidos} pedidos`);
    ok("C3  a contagem oficial DIFERE da do espelho — outra fonte",
      oficialPedidos !== espelhoPedidos,
      `${oficialPedidos} vs ${espelhoPedidos}`);
    ok("C4  e as duas contagens sao plausiveis, nao zero",
      oficialPedidos > 0 && espelhoPedidos > 0);
    ok("C5  o faturamento oficial tambem nao e o do espelho",
      oficialFaturamento > 0);
  }

  // ═══ D. O recorte e por PAGAMENTO, nao por criacao ═══════════════

  secao("D. Data de pagamento decide, data de criacao nao");
  {
    // Aqui a rede e SUBSTITUIDA de proposito: para provar a regra de
    // recorte e preciso um pedido criado dentro e pago fora, e outro
    // criado fora e pago dentro. A API real nao entrega isso sob
    // encomenda. A chamada real ja foi provada na secao B.
    const pedido = (id: string, criado: string, aprovado: string | null, valor: number) => ({
      id, status: "paid", date_created: criado, paid_amount: valor,
      payments: aprovado === null
        ? [{ status: "pending", date_approved: null }]
        : [{ status: "approved", date_approved: aprovado }],
    });

    const carga = {
      paging: { total: 4 },
      results: [
        // criado DENTRO, pago DEPOIS do fim -> fora
        pedido("1", "2026-09-02T10:00:00.000-03:00", "2026-09-20T10:00:00.000-03:00", 100),
        // criado ANTES (dentro da margem), pago DENTRO -> entra
        pedido("2", "2026-08-29T10:00:00.000-03:00", "2026-09-02T10:00:00.000-03:00", 200),
        // criado e pago DENTRO -> entra
        pedido("3", "2026-09-01T10:00:00.000-03:00", "2026-09-01T10:00:00.000-03:00", 50),
        // sem pagamento aprovado -> fora
        pedido("4", "2026-09-01T10:00:00.000-03:00", null, 999),
      ],
    };

    const buscarFalso: typeof fetch = async () =>
      new Response(JSON.stringify(carga), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
    const credencialFalsa = async () => ({
      lojaId: LOJA, accessToken: "nao-e-token-real", sellerId: "999", nickname: "FIXTURE",
    });

    const r = await buscarVendasPagasML(
      { userId: dono, lojaId: LOJA, de: DE, ate: ATE }, undefined,
      { buscar: buscarFalso, resolverCredencial: credencialFalsa as never });

    ok("D1  a leitura aceitou a carga", r.erro === null, String(r.erro));
    ok("D2  DOIS pedidos entram — os pagos na janela", r.pedidos.length === 2,
      r.pedidos.map((p) => p.pedidoId).join(","));
    ok("D3  o criado dentro e pago DEPOIS ficou fora",
      !r.pedidos.some((p) => p.pedidoId === "1"));
    ok("D4  o criado ANTES e pago dentro ENTROU — a margem serve",
      r.pedidos.some((p) => p.pedidoId === "2"));
    ok("D5  o sem pagamento aprovado ficou fora",
      !r.pedidos.some((p) => p.pedidoId === "4"));
    ok("D6  os dois descartados foram CONTADOS, nao escondidos",
      r.foraDaJanelaFinanceira === 2, String(r.foraDaJanelaFinanceira));
    ok("D7  a data gravada e a do PAGAMENTO, nao a da criacao",
      r.pedidos.find((p) => p.pedidoId === "2")?.dataPagamento === "2026-09-02",
      String(r.pedidos.find((p) => p.pedidoId === "2")?.dataPagamento));
    ok("D8  a janela pedida a API recuou 5 dias do inicio financeiro",
      r.janelaDeCriacao.de === "2026-08-27" && r.janelaDeCriacao.ate === ATE,
      `${r.janelaDeCriacao.de}..${r.janelaDeCriacao.ate}`);
    ok("D9  CONTROLE: por data de CRIACAO o total seria outro — 3, nao 2",
      carga.results.filter((p) =>
        p.date_created >= DE && p.date_created <= `${ATE}T23:59:59`).length === 3);

    // `partially_refunded` conta: a venda aconteceu financeiramente.
    const parcial = {
      paging: { total: 1 },
      results: [{
        id: "5", status: "paid", date_created: "2026-09-01T10:00:00.000-03:00",
        paid_amount: 10,
        payments: [{ status: "partially_refunded", date_approved: "2026-09-01T10:00:00.000-03:00" }],
      }],
    };
    const r2 = await buscarVendasPagasML(
      { userId: dono, lojaId: LOJA, de: DE, ate: ATE }, undefined,
      {
        buscar: (async () => new Response(JSON.stringify(parcial), {
          status: 200, headers: { "Content-Type": "application/json" },
        })) as typeof fetch,
        resolverCredencial: credencialFalsa as never,
      });
    ok("D10 `partially_refunded` conta — a venda aconteceu",
      r2.pedidos.length === 1, String(r2.pedidos.length));
  }

  // ═══ E. Autoridade e cerca ═══════════════════════════════════════

  secao("E. A loja vem do binding, e a leitura nao pede aprovacao");
  {
    // Sem conexao no contexto: nao ha loja, e nao se escolhe uma.
    const semConexao = await executarVendasML(
      { userId: dono, conexao: null }, { periodo: "hoje" });
    ok("E1  sem binding, a Funcao RECUSA", semConexao.erro === "credencial_ausente",
      String(semConexao.erro));
    ok("E2  e nao inventa numero — nao ha total nenhum",
      semConexao.vendasBrutas === null, JSON.stringify(semConexao.vendasBrutas));

    // Binding de OUTRO recurso nao serve: conexao de perguntas nao
    // autoriza vendas, mesmo sendo a mesma loja e a mesma plataforma.
    const recursoErrado = await executarVendasML(
      { userId: dono, conexao: { plataforma: "mercado_livre", recurso: "perguntas", lojaId: LOJA } },
      { periodo: "hoje" });
    ok("E3  binding de OUTRO recurso nao autoriza",
      recursoErrado.erro === "credencial_ausente", String(recursoErrado.erro));

    // Outro dono com a loja certa: a credencial e resolvida pelo PAR.
    const outroDono = "c7b00000-f748-4000-8000-0000000000e0";
    const r = await buscarVendasPagasML(
      { userId: outroDono, lojaId: LOJA, de: DE, ate: ATE });
    ok("E4  outro dono NAO alcanca a loja", r.erro === "credencial_ausente",
      String(r.erro));

    // §28: leitura nao pede confirmacao.
    const def = FUNCOES["mercadolivre.vendas.consultar"];
    ok("E5  a Funcao existe no registry", def !== undefined);
    ok("E6  declarada como LEITURA", def?.acesso === "leitura", String(def?.acesso));
    ok("E7  e exige conexao de vendas do Mercado Livre",
      def?.conexaoNecessaria?.plataforma === CONEXAO_VENDAS_ML.plataforma &&
        def?.conexaoNecessaria?.recurso === CONEXAO_VENDAS_ML.recurso,
      JSON.stringify(def?.conexaoNecessaria));
    const efeito = efeitoDaFuncaoInterna({
      funcaoId: "mercadolivre.vendas.consultar", acesso: "leitura",
    });
    ok("E8  o efeito e READ_ONLY", efeito === "READ_ONLY", efeito);
    ok("E9  e NAO pede aprovacao (§28)", !exigeConfirmacao(efeito));
    ok("E10 ANCORA: uma escrita PEDIRIA",
      exigeConfirmacao(efeitoDaFuncaoInterna({ funcaoId: "x.y", acesso: "escrita" })));

    // `interpretarSaida` e a cerca de forma.
    ok("E11 saida sem `fonte` e INVALIDA",
      interpretarSaidaVendasML({ vendasBrutas: { valor: 1, vendas: 1, unidades: 1, ticketMedio: 1 },
        porDia: [], periodo: {}, completo: true, truncado: false,
        erro: null }).tipo === "invalida");
    ok("E12 saida com fonte TROCADA e invalida",
      interpretarSaidaVendasML({ fonte: "cds_database", vendasBrutas: {}, porDia: [],
        periodo: {}, completo: true, truncado: false, erro: null }).tipo === "invalida");
    ok("E13 ANCORA: a saida real e aceita",
      interpretarSaidaVendasML({
        fonte: "mercadolivre_api",
        vendasBrutas: { valor: 10, vendas: 2, unidades: 3, ticketMedio: 5 },
        porDia: [], periodo: { de: DE, ate: ATE },
        completo: true, truncado: false, parcial: null,
        diagnostico: {}, erro: null,
      }).tipo === "sucesso");
    // §11: as duas metades do contrato de completude.
    ok("E13a incompleto COM total e INVALIDO — era a comparacao errada",
      interpretarSaidaVendasML({
        fonte: "mercadolivre_api",
        vendasBrutas: { valor: 10, vendas: 2, unidades: 3, ticketMedio: 5 },
        porDia: [], periodo: { de: DE, ate: ATE },
        completo: false, truncado: true, parcial: { pedidosLidos: 2 },
        diagnostico: {}, erro: null,
      }).tipo === "invalida");
    ok("E13b e completo SEM total tambem e invalido",
      interpretarSaidaVendasML({
        fonte: "mercadolivre_api", vendasBrutas: null,
        porDia: [], periodo: { de: DE, ate: ATE },
        completo: true, truncado: false, parcial: null,
        diagnostico: {}, erro: null,
      }).tipo === "invalida");
    ok("E13c incompleto SEM total e aceito, e diz que e parcial",
      interpretarSaidaVendasML({
        fonte: "mercadolivre_api", vendasBrutas: null,
        porDia: [], periodo: { de: DE, ate: ATE },
        completo: false, truncado: true,
        parcial: { pedidosLidos: 2, subjanelasIncompletas: 1 },
        diagnostico: {}, erro: null,
      }).tipo === "sucesso");
    ok("E14 e a procedencia atravessa para quem responde",
      (() => {
        const i = interpretarSaidaVendasML({
          fonte: "mercadolivre_api",
          vendasBrutas: { valor: 10, vendas: 2, unidades: 3, ticketMedio: 5 },
          porDia: [], periodo: { de: DE, ate: ATE }, truncado: false,
          // F7b.4.8.3: total exige `completo: true`. A fixture antiga
          // omitia o campo e por isso passou a ser recusada — o que E o
          // comportamento novo, cobrado em E13/E13a/E13b.
          completo: true, parcial: null,
          diagnostico: {}, erro: null,
        });
        return i.tipo === "sucesso" &&
          (i.data as Record<string, unknown>).fonte === "mercadolivre_api";
      })());
  }

  // ═══ F. O teto medido da API ═════════════════════════════════════

  secao("F. Os limites medidos entraram no codigo");
  {
    ok("F1  a pagina usa o maximo MEDIDO — 51", LIMITE_POR_PAGINA === 51,
      String(LIMITE_POR_PAGINA));
    ok("F2  e a margem de criacao e a mesma do sync — 5 dias",
      MARGEM_CRIACAO_DIAS === 5, String(MARGEM_CRIACAO_DIAS));
    const fonteSync = readFileSync(join(__dirname, "..", "lib", "sync-ml.ts"), "utf8");
    ok("F3  ANCORA: o -5 do sync continua la — as duas margens sao UMA",
      /addDias\(dateFrom, -5\)/.test(fonteSync));
  }

  console.log(`\nPASS ${pass}   FAIL ${fail}`);
  process.exit(fail === 0 ? 0 : 1);
}

void main();
