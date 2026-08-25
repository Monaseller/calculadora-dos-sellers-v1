/**
 * Capability de LEITURA de vendas para agentes — AGENTES-FASE1D-a.
 *
 * ── A invariante que este modulo torna estrutural ───────────────────
 *
 *   "Um handler de agente nao consegue escolher de quem sao os dados
 *    que le, nem alcancar coluna financeira de rentabilidade."
 *
 * Duas garantias, cada uma pelo seu mecanismo:
 *
 *  1. `criarLeiturasDeVendas(userId)` fecha o `userId` por CLOSURE. A
 *     funcao devolvida NAO tem parametro de dono. Nao existe assinatura
 *     pela qual o handler peca dado de outro tenant — nao e disciplina,
 *     e ausencia de porta.
 *
 *  2. A projecao PUBLICA e fechada em 8 colunas. `custo`, `imposto`,
 *     `margem_contrib`, `mc_percent`, `lucro_liquido`, `roi`,
 *     `seller_income`, `escrow_amount`, `tarifa_venda` e
 *     `commission_fee` NAO sao lidas. O gate 1D-0 provou que `custo` e
 *     `imposto` sao ZERO em 100% dos 398.216 pedidos pagos — logo
 *     `margem_contrib` hoje nao e margem, e receita liquida. Nao
 *     projeta-las e o que impede um handler de, por engano ou por
 *     evolucao futura, apresentar receita como se fosse rentabilidade.
 *
 * ── `import "server-only"` ──────────────────────────────────────────
 * Primeira linha, barreira de COMPILACAO: se um Client Component
 * importar este modulo, o BUILD quebra em vez de embarcar a
 * service_role no bundle do browser.
 *
 * ── O que este modulo NAO faz ───────────────────────────────────────
 * Nao escreve. Nao chama API externa. Nao toca Storage, `lojas` nem
 * `perfil`. Nao exporta nem recebe `SupabaseClient`.
 */
import "server-only";
import { getSupabaseServidor } from "@/lib/estudio-anuncios/supabase-servidor";

/**
 * Janela maxima, em dias corridos e INCLUSIVA nas duas pontas.
 *
 * 14 nao e numero redondo — e medicao. Janela movel por dono sobre a
 * populacao elegivel (`paid` + `data_pagamento`), agosto/2026:
 *
 *   janela      pico do dono de maior volume     folga vs 50.000
 *    7 dias           12.749                          3,92x
 *   14 dias           23.773                          2,10x   <- aqui
 *   21 dias           35.203                          1,42x
 *   31 dias           50.066                          1,00x   ESTOURA
 */
export const JANELA_MAXIMA_DIAS = 14;

/**
 * PAGE_SIZE = 1000 e ESTRUTURAL, nao preferencia.
 *
 * ── Medido neste projeto (2026-08-25) ───────────────────────────────
 * O PostgREST do Supabase esta configurado com `db-max-rows = 1000`:
 *
 *     Range: 0-999   ->  1000 linhas
 *     Range: 0-1999  ->  1000 linhas   (pedimos 2000)
 *     Range: 0-4999  ->  1000 linhas   (pedimos 5000)
 *
 * Ou seja: o servidor CORTA em 1000 sem avisar. Duas consequencias:
 *
 *  1. Ler tudo numa requisicao e impossivel — paginar nao e escolha.
 *  2. AUMENTAR este valor causa PERDA SILENCIOSA DE DADOS. Com
 *     PAGE_SIZE = 2000, o servidor devolveria 1000, a condicao de
 *     parada `pagina.length < PAGE_SIZE` daria 1000 < 2000 = true, e o
 *     laco encerraria na primeira pagina achando que acabou.
 *
 * A suite trava este valor. Se o teto do projeto mudar um dia, o
 * numero muda AQUI e com medicao nova — nunca por intuicao.
 */
export const PAGE_SIZE = 1000;
export const MAX_PAGES = 50;

/**
 * PROJECAO PUBLICA — 8 colunas, o contrato que o chamador recebe.
 *
 *   order_id ....... contagem de pedidos distintos
 *   sku ............ chave do ranking
 *   anuncio ........ rotulo legivel do SKU
 *   marketplace .... agrupamento e chave composta com o SKU
 *   qtd ............ unidades
 *   item_subtotal .. numerador da regra P-FAT
 *   faturamento .... fallback da regra P-FAT
 *   data_pagamento . campo temporal oficial
 */
export const COLUNAS_VENDAS =
  "order_id, sku, anuncio, marketplace, qtd, item_subtotal, faturamento, data_pagamento";

/**
 * PROJECAO INTERNA DE PAGINACAO — a publica MAIS `id`.
 *
 * `id` entra por necessidade do cursor, NAO para o relatorio. Ele e
 * removido antes de devolver: nenhuma `LinhaVenda` carrega a PK. A
 * separacao e explicita para que ninguem confunda "coluna que a query
 * precisa" com "coluna que o agente pode usar".
 */
export const COLUNAS_LEITURA_INTERNA = `id, ${COLUNAS_VENDAS}`;

/** Marketplaces aceitos. Valores REAIS do schema — "ML", nao "MERCADO_LIVRE". */
export const MARKETPLACES_VALIDOS = ["Shopee", "ML"] as const;
export type MarketplaceVendas = (typeof MARKETPLACES_VALIDOS)[number];

/** Uma linha de venda — exatamente a projecao PUBLICA. Sem `id`. */
export interface LinhaVenda {
  order_id: string;
  sku: string | null;
  anuncio: string | null;
  marketplace: string;
  qtd: number | null;
  item_subtotal: number | null;
  faturamento: number | null;
  data_pagamento: string;
}

/** Uso EXCLUSIVO da paginacao. Nunca sai deste modulo. */
export interface LinhaVendaInterna extends LinhaVenda {
  id: string;
}

/**
 * O filtro que o chamador controla. NAO tem `user_id` — e o ponto
 * inteiro deste modulo. Ver `criarLeiturasDeVendas`.
 */
export interface FiltroVendas {
  dataInicio: string;
  dataFim: string;
  marketplace?: MarketplaceVendas | null;
}

export interface ResultadoVendas {
  linhas: LinhaVenda[];
  /** Bateu no teto de paginacao: o periodo tem MAIS dados do que os
   *  devolvidos. Quem consome PRECISA propagar isso — silenciar seria
   *  entregar um total incompleto com cara de completo. */
  truncado: boolean;
  erro: string | null;
}

export type LerVendasDoPeriodo = (filtro: FiltroVendas) => Promise<ResultadoVendas>;

const FORMATO_DATA = /^\d{4}-\d{2}-\d{2}$/;

function epochUtcDeData(texto: string): number | null {
  if (typeof texto !== "string" || !FORMATO_DATA.test(texto)) return null;
  const [a, m, d] = texto.split("-").map(Number);
  const epoch = Date.UTC(a, m - 1, d);
  const volta = new Date(epoch);
  // Rejeita data que "existe" no formato mas nao no calendario
  // (2026-02-31 viraria 03-03 sem esta checagem).
  if (volta.getUTCFullYear() !== a || volta.getUTCMonth() !== m - 1 || volta.getUTCDate() !== d) {
    return null;
  }
  return epoch;
}

export interface ValidacaoFiltro {
  erro: string | null;
  /** Dias da janela, INCLUSIVO nas duas pontas. 01→14 de julho = 14. */
  dias: number;
}

/** Valida o filtro. PURA — e sobre ela que a suite prova as regras de
 *  janela sem precisar de banco. Codigos ESTAVEIS, nunca `error.message`. */
export function validarFiltroVendas(filtro: FiltroVendas): ValidacaoFiltro {
  if (!filtro || typeof filtro !== "object") return { erro: "filtro_ausente", dias: 0 };

  const inicio = epochUtcDeData(filtro.dataInicio);
  const fim = epochUtcDeData(filtro.dataFim);
  if (inicio === null || fim === null) return { erro: "data_invalida", dias: 0 };
  if (fim < inicio) return { erro: "periodo_invertido", dias: 0 };

  const dias = Math.round((fim - inicio) / 86_400_000) + 1;
  if (dias > JANELA_MAXIMA_DIAS) return { erro: "janela_excedida", dias };

  const mp = filtro.marketplace;
  if (mp !== undefined && mp !== null && !(MARKETPLACES_VALIDOS as readonly string[]).includes(mp)) {
    return { erro: "marketplace_invalido", dias };
  }
  return { erro: null, dias };
}

/** Filtros aplicados como `.eq()` encadeados. PURA e exportada: um teste
 *  que afirme "toda leitura carrega user_id e status=paid" precisa
 *  inspecionar o objeto, e isso e barato. */
export function filtrosVendas(userId: string, marketplace?: MarketplaceVendas | null): Record<string, unknown> {
  const filtros: Record<string, unknown> = {
    user_id: String(userId),
    // Regra oficial: so `paid` entra em faturamento/pedidos.
    // BUSINESS_RULES, "Contagem de pedidos (o que conta como venda)".
    status: "paid",
  };
  if (marketplace) filtros.marketplace = marketplace;
  return filtros;
}

function aplicarFiltros(consulta: any, filtros: Record<string, unknown>): any {
  let q = consulta;
  for (const [coluna, valor] of Object.entries(filtros)) q = q.eq(coluna, valor);
  return q;
}

/** Remove a PK: o que sai daqui e a projecao PUBLICA. */
function semId(linha: LinhaVendaInterna): LinhaVenda {
  const { id: _ignorado, ...publica } = linha;
  return publica;
}

/** Uma pagina do keyset. `cursor` null = primeira pagina. */
export type BuscarPaginaKeyset = (cursor: string | null) => Promise<LinhaVendaInterna[]>;

/**
 * O LACO DE KEYSET — puro em relacao ao transporte.
 *
 * Recebe um buscador de pagina e nao sabe se ele fala com o Postgres ou
 * com um array. Isso e deliberado: a suite exercita ESTE MESMO codigo,
 * com um duplo em memoria, em vez de imitar o algoritmo com regex. As
 * provas de "nao duplica", "nao omite" e "insert nao desloca" valem
 * sobre a implementacao real.
 *
 * ── Por que keyset, e nao OFFSET ────────────────────────────────────
 * `.range(de, ate)` recalcula a posicao do zero a cada pagina. Como
 * cada pagina e uma REQUISICAO SEPARADA (o PostgREST e stateless — nao
 * ha transacao atravessando chamadas), qualquer linha que entre ou saia
 * do conjunto elegivel entre a pagina N e a N+1 desloca todos os
 * offsets seguintes, duplicando ou omitindo linhas.
 *
 * E isso NAO e hipotetico aqui: `pedidos.id` e TEXT composto
 * (`<uuid>_SHOPEE_<order_sn>_...`), e a medicao mostrou 100% de
 * divergencia entre a ordem por `id` e a ordem de insercao
 * (correlacao 0,675). Um INSERT novo cai em QUALQUER posicao da
 * ordenacao, inclusive antes do ponto ja lido.
 *
 * Com keyset, cada pagina depende apenas do ultimo `id` lido. Nada
 * desloca nada.
 */
export async function paginarKeyset(
  buscarPagina: BuscarPaginaKeyset
): Promise<{ linhas: LinhaVenda[]; truncado: boolean }> {
  const linhas: LinhaVenda[] = [];
  let cursor: string | null = null;

  for (let pagina = 0; pagina < MAX_PAGES; pagina++) {
    const lote = await buscarPagina(cursor);

    for (const linha of lote) linhas.push(semId(linha));

    // Pagina incompleta = o conjunto acabou. Unica saida limpa.
    if (lote.length < PAGE_SIZE) return { linhas, truncado: false };

    // Avanca o cursor para o ULTIMO id lido. A ordenacao ASC por `id`
    // garante que ele e o maior da pagina.
    cursor = lote[lote.length - 1].id;
  }

  // Esgotou MAX_PAGES com paginas cheias: ha (ou pode haver) mais dado
  // la fora. Conservador de proposito — dizer "truncado" a mais e
  // honesto; dizer a menos entregaria total incompleto como completo.
  return { linhas, truncado: true };
}

/**
 * Cria a leitura de vendas JA AMARRADA a um dono.
 *
 * ── Por que fabrica, e nao `lerVendas(userId, filtro)` ──────────────
 * Uma funcao com `userId` no parametro deixaria o dono escolhivel por
 * quem chama. Aqui ele entra UMA vez, na construcao — feita pelo
 * executor, que o tira da propria linha da tarefa — e some da
 * assinatura. O handler recebe `(filtro) => ...` e nao tem por onde
 * pedir dado alheio.
 *
 * ── Regras temporais, fixas e nao configuraveis ─────────────────────
 * O campo temporal e SEMPRE `data_pagamento`, regra financeira oficial
 * do CDS. Torna-lo parametro abriria relatorio financeiro por data de
 * criacao, que o BUSINESS_RULES proibe como referencia financeira.
 * Pedido pago com `data_pagamento` NULL nao entra — o `.gte`/`.lte` ja
 * o exclui, que e exatamente a regra da arquitetura de tres datas.
 *
 * ── As DUAS queries, e o que cada uma garante ───────────────────────
 * 1) LIMITE INICIAL: um unico `id`, o maior do conjunto elegivel no
 *    instante em que a leitura comeca. Calculado com EXATAMENTE os
 *    mesmos filtros (dono, status, marketplace, intervalo de datas) —
 *    nunca um `MAX(id)` global.
 * 2) PAGINAS: `id > cursor AND id <= limiteInicial`, ASC, LIMIT 1000.
 *
 * O limite superior exclui da leitura toda linha inserida depois do
 * inicio cujo `id` caia acima dele. NAO e snapshot transacional, e nao
 * deve ser descrito como tal: como `id` NAO e monotonico por insercao,
 * uma linha criada durante a leitura pode receber um `id` dentro do
 * intervalo `(cursor, limiteInicial]` e ainda assim entrar. O que se
 * ganha e reducao da janela, nao eliminacao dela.
 *
 * Fora da garantia, em qualquer hipotese sem transacao: UPDATE de
 * `status`, `data_pagamento`, `marketplace` ou `user_id` durante a
 * leitura, e DELETE. Uma linha ja lida que deixe de ser elegivel
 * permanece no resultado; uma que se torne elegivel abaixo do cursor
 * nao aparece.
 */
export function criarLeiturasDeVendas(userId: string): LerVendasDoPeriodo {
  return async function lerVendasDoPeriodo(filtro: FiltroVendas): Promise<ResultadoVendas> {
    if (!userId) return { linhas: [], truncado: false, erro: "user_id_ausente" };

    const validacao = validarFiltroVendas(filtro);
    if (validacao.erro) return { linhas: [], truncado: false, erro: validacao.erro };

    const filtros = filtrosVendas(userId, filtro.marketplace ?? null);

    /** Aplica dono + status + marketplace + intervalo de datas. Usada
     *  pelas DUAS queries, para que o limite superior pertenca
     *  exatamente ao mesmo conjunto que as paginas percorrem. */
    const consultaBase = () =>
      aplicarFiltros(getSupabaseServidor().from("pedidos").select(COLUNAS_LEITURA_INTERNA), filtros)
        .gte("data_pagamento", filtro.dataInicio)
        .lte("data_pagamento", filtro.dataFim);

    // ── 1) LIMITE INICIAL ────────────────────────────────────────────
    const { data: topo, error: erroTopo } = await consultaBase()
      .order("id", { ascending: false })
      .limit(1);

    if (erroTopo) {
      console.error("[agentes/dados] falha ao capturar o limite inicial de vendas");
      return { linhas: [], truncado: false, erro: "erro_consulta_vendas" };
    }

    const primeiraLinha = Array.isArray(topo) ? (topo[0] as LinhaVendaInterna | undefined) : undefined;
    // Conjunto vazio: nao ha o que paginar, e nao e erro.
    if (!primeiraLinha) return { linhas: [], truncado: false, erro: null };
    const limiteInicial = primeiraLinha.id;

    // ── 2) PAGINAS ───────────────────────────────────────────────────
    let erroPagina: string | null = null;

    const { linhas, truncado } = await paginarKeyset(async (cursor) => {
      if (erroPagina) return [];

      let q = consultaBase().lte("id", limiteInicial);
      if (cursor !== null) q = q.gt("id", cursor);

      const { data, error } = await q.order("id", { ascending: true }).limit(PAGE_SIZE);

      if (error) {
        // Codigo estavel, nunca `error.message`.
        console.error("[agentes/dados] falha ao ler pagina de vendas");
        erroPagina = "erro_consulta_vendas";
        return [];
      }
      return Array.isArray(data) ? (data as LinhaVendaInterna[]) : [];
    });

    // Falha de pagina invalida a leitura INTEIRA: devolver resultado
    // parcial seria entregar um total errado com cara de completo.
    if (erroPagina) return { linhas: [], truncado: false, erro: erroPagina };

    return { linhas, truncado, erro: null };
  };
}
