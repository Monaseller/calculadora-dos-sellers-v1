/**
 * Handler `analise_vendas` — AGENTES-FASE1D-c.
 *
 * O PRIMEIRO handler que le dado real. Ainda FORA do registry: esta fase
 * prova o wiring isolado, e so a 1D-d liga o tipo ao motor.
 *
 * ── O que ele NAO faz, e nao e omissao ──────────────────────────────
 * Nao ha IA, prompt, provedor, resumo textual nem "insight". Nao ha
 * `SupabaseClient`, `userId`, service_role, `fetch`, env, timer, retry
 * nem heartbeat. Nada disso e responsabilidade de handler: leitura e da
 * capability, ciclo de vida e do executor, inteligencia e de outra fase.
 *
 * ── A regra do gate 1D-0, aqui em forma de codigo ───────────────────
 * `custo` e `imposto` sao ZERO em 100% dos 398.216 pedidos pagos. Logo
 * NAO EXISTE, hoje, rentabilidade calculavel neste banco — e um numero
 * chamado "margem" seria receita liquida com nome errado.
 *
 * Este handler nao poderia produzi-lo nem se quisesse: a projecao da
 * capability tem 8 colunas e nenhuma delas e financeira de resultado.
 * A saida diz isso explicitamente em `escopo.incluiRentabilidade`, para
 * que quem consumir o `resultado` gravado nao precise adivinhar.
 *
 * ── IDEMPOTENTE ─────────────────────────────────────────────────────
 * O motor e AT-LEAST-ONCE. Este handler e somente-leitura e puro sobre a
 * resposta da capability: rodar duas vezes produz a mesma saida e nao
 * muda nada fora de si. Requisito de entrada no registry, cumprido.
 *
 * ── Como a dependencia chega ────────────────────────────────────────
 *     criarHandlerAnaliseVendas(lerVendasDoPeriodo) -> HandlerTarefa
 *
 * UMA capability nomeada, nao uma sacola de servicos. O `userId` nao
 * aparece em lugar nenhum deste arquivo: ele ja esta fechado DENTRO da
 * funcao recebida, por `criarLeiturasDeVendas(userId)`. O handler nao
 * tem assinatura pela qual pedir dado de outro dono — nem por onde
 * construir outra leitura.
 */
// `import type` — 100% apagado na compilacao (`isolatedModules: true`,
// sem `verbatimModuleSyntax`). Um import de VALOR de `dados/vendas`
// arrastaria `server-only` e a service_role para o grafo deste modulo,
// que precisa continuar puro. A suite verifica a palavra `type`.
import type {
  FiltroVendas,
  LerVendasDoPeriodo,
  LinhaVenda,
  MarketplaceVendas,
} from "@/lib/agentes/dados/vendas";
import type {
  ContextoTarefa,
  HandlerTarefa,
  RelatarProgresso,
} from "@/lib/agentes/tipos-execucao";
import { ErroEntradaTarefa } from "@/lib/agentes/erros";

export const TIPO_ANALISE_VENDAS = "analise_vendas";

/** Tamanho do ranking devolvido. Nao vai para a capability — limita a
 *  SAIDA, nao a consulta. Sem ele, um periodo com 1.671 SKUs viraria um
 *  `resultado` de 1.671 objetos gravado numa coluna `jsonb`. */
export const LIMITE_SKUS_PADRAO = 10;
export const LIMITE_SKUS_MAXIMO = 50;

/**
 * `entrada` da tarefa. Contem SOMENTE o que o handler precisa entregar a
 * capability — mais `limiteSkus`, que e recorte de saida e nao de query.
 *
 * NAO ha `userId` aqui, e nao e esquecimento: o dono vem da linha da
 * tarefa e ja esta fechado na closure. Aceita-lo na entrada devolveria
 * exatamente a porta que a 1D-a fechou.
 */
export interface EntradaAnaliseVendas {
  dataInicio: string;
  dataFim: string;
  marketplace?: MarketplaceVendas | null;
  limiteSkus?: number;
}

/**
 * Codigos que a capability devolve por CULPA DO FILTRO.
 *
 * A distincao existe para o `classificarErro` do executor: estes viram
 * `entrada_invalida` (problema de quem criou a tarefa, retentar nao
 * resolve); os outros — `user_id_ausente`, `erro_consulta_vendas` —
 * viram `handler_falhou`, que e o caso em que retentar faz sentido.
 *
 * A LISTA E DA CAPABILITY, nao deste handler: quem valida formato de
 * data, ordem do periodo, janela de 14 dias e nome de marketplace e
 * `validarFiltroVendas`. Aqui so se TRADUZ o codigo em excecao.
 */
const ERROS_DE_FILTRO: readonly string[] = [
  "filtro_ausente",
  "data_invalida",
  "periodo_invertido",
  "janela_excedida",
  "marketplace_invalido",
];

/** Duas casas. Soma de float e deterministica para a mesma ordem de
 *  entrada, mas `0,1 + 0,2` gravado como `0.30000000000000004` num
 *  `jsonb` e ruido que ninguem quer depurar depois. */
function centavos(valor: number): number {
  return Math.round(valor * 100) / 100;
}

function numeroOuZero(valor: number | null): number {
  return typeof valor === "number" && Number.isFinite(valor) ? valor : 0;
}

/**
 * Valor de UMA linha: `item_subtotal` quando positivo, `faturamento` caso
 * contrario.
 *
 * ── De onde vem a regra ─────────────────────────────────────────────
 * A formula esta documentada em `docs/BUSINESS_RULES.md` (versao do HEAD,
 * secao da reconciliacao Shopee): "o faturamento atualmente exibido
 * (`item_subtotal`, com fallback para `faturamento`/`total_amount`)
 * permanece a regra vigente ate nova decisao explicita".
 *
 * "P-FAT" e rotulo do CODIGO, nao do documento — convencao vinda de
 * `app/api/shopee/vendas/route.ts` e reusada em `lib/resumos-diarios.ts`
 * e em `lib/agentes/dados/vendas.ts`. As tres implementacoes vigentes
 * usam exatamente este mesmo teste `> 0`; esta e a quarta, e nao inventa
 * variante.
 *
 * ── AS DUAS COLUNAS SAO POR LINHA. As duas. ─────────────────────────
 * Correcao de uma afirmacao errada que esteve aqui: `faturamento` NAO e
 * o valor inteiro do pedido, e somar por linha NAO duplica dinheiro.
 * Verificado nos escritores reais — os unicos tres que gravam estas
 * colunas:
 *
 *   Shopee, laco de itens  `lib/sync-shopee.ts`
 *     item_subtotal = valorUnit x qtd          (preco puro do item)
 *     faturamento   = totalAmount x ratioItem  (RATEADO por item),
 *                     com fallback `itemValue`, tambem por item.
 *     Somar `faturamento` nas linhas de um pedido da `totalAmount` —
 *     nao `totalAmount` vezes o numero de itens.
 *
 *   Shopee, pedido sem `item_list`
 *     Uma UNICA linha `_NOITEM` por pedido, com `item_subtotal = 0` e
 *     `faturamento` = total do pedido. O bloco faz `return rows` e nao
 *     cai no laco de itens, entao nao ha segunda linha com que somar.
 *
 *   Mercado Livre  `lib/sync-ml.ts`
 *     faturamento = valorUnit x qtd, por `order_item`. O sync do ML nao
 *     escreve `item_subtotal` — a coluna e `NUMERIC DEFAULT 0`, logo
 *     TODA linha de ML cai no fallback, que ja e por item.
 *
 * ── A premissa, dita em voz alta ────────────────────────────────────
 * `agregarVendas` soma valor POR LINHA. Isso e seguro enquanto a
 * invariante acima valer nos escritores. Se algum dia um deles gravar
 * valor de PEDIDO numa coluna de linha, a soma infla — e nada aqui
 * perceberia. Por isso a invariante nao vive so neste comentario: a
 * suite da 1D-c a verifica na fonte de `sync-shopee.ts` e `sync-ml.ts`,
 * secao I, e falha se ela for removida.
 *
 * `item_subtotal` e preferido por ser preco puro dos itens, sem o frete
 * do comprador que `total_amount` embute — nao por ser "o unico seguro".
 */
function valorDaLinha(linha: LinhaVenda): number {
  const subtotal = numeroOuZero(linha.item_subtotal);
  if (subtotal > 0) return subtotal;
  return numeroOuZero(linha.faturamento);
}

// ── Validacao ESTRUTURAL — e so ela ──────────────────────────────────
//
// O que e do handler:  a entrada tem os campos, com os TIPOS certos.
// O que NAO e:         formato de data, calendario, ordem do periodo,
//                      janela de 14 dias, marketplace existente, dono,
//                      `status = 'paid'`, `data_pagamento`, paginacao.
//
// Tudo na segunda lista ja e de `dados/vendas.ts` e ja tem codigo de erro
// proprio. Reimplementar aqui criaria uma SEGUNDA definicao das mesmas
// regras — duas para divergirem no dia em que uma delas mudar.

function textoObrigatorio(entrada: Record<string, unknown>, campo: string): string {
  const valor = entrada[campo];
  if (typeof valor !== "string" || valor.length === 0) {
    throw new ErroEntradaTarefa(`entrada.${campo} deve ser uma string nao vazia`);
  }
  return valor;
}

function marketplaceOpcional(entrada: Record<string, unknown>): MarketplaceVendas | null {
  const valor = entrada.marketplace;
  if (valor === undefined || valor === null) return null;
  // Apenas o TIPO. Se a string nao for um marketplace real, quem recusa e
  // `validarFiltroVendas` com `marketplace_invalido` — e a lista de nomes
  // validos continua tendo um dono so.
  if (typeof valor !== "string" || valor.length === 0) {
    throw new ErroEntradaTarefa("entrada.marketplace deve ser uma string ou estar ausente");
  }
  return valor as MarketplaceVendas;
}

function limiteOpcional(entrada: Record<string, unknown>): number {
  const valor = entrada.limiteSkus;
  if (valor === undefined || valor === null) return LIMITE_SKUS_PADRAO;
  if (
    typeof valor !== "number" ||
    !Number.isInteger(valor) ||
    valor < 1 ||
    valor > LIMITE_SKUS_MAXIMO
  ) {
    throw new ErroEntradaTarefa(
      `entrada.limiteSkus deve ser inteiro entre 1 e ${LIMITE_SKUS_MAXIMO}`
    );
  }
  return valor;
}

export function validarEntradaAnaliseVendas(bruta: unknown): EntradaAnaliseVendas {
  if (!bruta || typeof bruta !== "object" || Array.isArray(bruta)) {
    throw new ErroEntradaTarefa("entrada deve ser um objeto");
  }
  const entrada = bruta as Record<string, unknown>;
  return {
    dataInicio: textoObrigatorio(entrada, "dataInicio"),
    dataFim: textoObrigatorio(entrada, "dataFim"),
    marketplace: marketplaceOpcional(entrada),
    limiteSkus: limiteOpcional(entrada),
  };
}

// ── Agregacao ────────────────────────────────────────────────────────

interface AcumuladoSku {
  sku: string;
  marketplace: string;
  pedidos: Set<string>;
  unidades: number;
  faturamento: number;
  /** `anuncio` -> faturamento acumulado. O rotulo exibido e o anuncio de
   *  maior faturamento; empate desempata por ordem alfabetica, para que
   *  a saida nao dependa da ordem em que as linhas chegaram. */
  anuncios: Map<string, number>;
}

interface AcumuladoMarketplace {
  marketplace: string;
  pedidos: Set<string>;
  unidades: number;
  faturamento: number;
}

export interface ResumoSku {
  sku: string;
  anuncio: string | null;
  marketplace: string;
  pedidos: number;
  unidades: number;
  faturamento: number;
  anunciosDistintos: number;
}

function rotuloDeAnuncio(anuncios: Map<string, number>): string | null {
  let melhor: string | null = null;
  let maior = -Infinity;
  for (const [nome, valor] of anuncios) {
    if (valor > maior || (valor === maior && melhor !== null && nome < melhor)) {
      melhor = nome;
      maior = valor;
    }
  }
  return melhor;
}

/**
 * PURA e exportada — a suite prova as regras de agregacao sobre ESTA
 * funcao, com linhas em memoria, sem precisar de banco nem de handler.
 *
 * ── Decisoes de contagem, todas explicitas ──────────────────────────
 *  - a chave do ranking e `(sku, marketplace)`: o mesmo SKU vendido nos
 *    dois marketplaces sao duas linhas, porque as tarifas e o publico
 *    sao outros;
 *  - `pedidos` e `order_id` DISTINTO — um pedido com tres itens do mesmo
 *    SKU e um pedido, nao tres;
 *  - linha com `sku` nulo NAO entra no ranking, mas entra nos totais e e
 *    contada em `qualidadeDados.linhasSemSku`. Descartar em silencio
 *    faria a soma do ranking nao bater com o total;
 *  - linha com valor zero e contada. Zero e informacao.
 */
export function agregarVendas(linhas: readonly LinhaVenda[], limiteSkus: number) {
  const porSku = new Map<string, AcumuladoSku>();
  const porMarketplace = new Map<string, AcumuladoMarketplace>();
  const pedidosGerais = new Set<string>();

  let unidadesTotal = 0;
  let faturamentoTotal = 0;
  let linhasSemSku = 0;
  let linhasSemValor = 0;

  for (const linha of linhas) {
    const valor = valorDaLinha(linha);
    const unidades = numeroOuZero(linha.qtd);
    const pedido = String(linha.order_id ?? "");
    const marketplace = String(linha.marketplace ?? "");

    pedidosGerais.add(pedido);
    unidadesTotal += unidades;
    faturamentoTotal += valor;
    if (valor === 0) linhasSemValor++;

    let mp = porMarketplace.get(marketplace);
    if (!mp) {
      mp = { marketplace, pedidos: new Set(), unidades: 0, faturamento: 0 };
      porMarketplace.set(marketplace, mp);
    }
    mp.pedidos.add(pedido);
    mp.unidades += unidades;
    mp.faturamento += valor;

    const sku = typeof linha.sku === "string" && linha.sku.length > 0 ? linha.sku : null;
    if (sku === null) {
      linhasSemSku++;
      continue;
    }

    // Chave por JSON.stringify de um PAR, e nao por concatenacao com
    // separador. Concatenar exige escolher um caractere que nao possa
    // aparecer nos dados: com um espaco, ("A B","C") e ("A","B C") viram
    // a MESMA chave e dois SKUs distintos se fundem no ranking. A
    // serializacao do par e injetiva por construcao, sem depender de
    // suposicao alguma sobre o conteudo de `sku` ou `marketplace`.
    const chave = JSON.stringify([sku, marketplace]);
    let acc = porSku.get(chave);
    if (!acc) {
      acc = { sku, marketplace, pedidos: new Set(), unidades: 0, faturamento: 0, anuncios: new Map() };
      porSku.set(chave, acc);
    }
    acc.pedidos.add(pedido);
    acc.unidades += unidades;
    acc.faturamento += valor;
    if (typeof linha.anuncio === "string" && linha.anuncio.length > 0) {
      acc.anuncios.set(linha.anuncio, (acc.anuncios.get(linha.anuncio) ?? 0) + valor);
    }
  }

  // Ordem TOTAL, nunca parcial: faturamento, unidades, pedidos, sku,
  // marketplace. Os dois ultimos formam a chave unica, entao nao existe
  // empate residual — e a saida nao depende da ordem de iteracao do Map.
  const ordenados = [...porSku.values()].sort(
    (a, b) =>
      b.faturamento - a.faturamento ||
      b.unidades - a.unidades ||
      b.pedidos.size - a.pedidos.size ||
      (a.sku < b.sku ? -1 : a.sku > b.sku ? 1 : 0) ||
      (a.marketplace < b.marketplace ? -1 : a.marketplace > b.marketplace ? 1 : 0)
  );

  const skus: ResumoSku[] = ordenados.slice(0, limiteSkus).map((a) => ({
    sku: a.sku,
    anuncio: rotuloDeAnuncio(a.anuncios),
    marketplace: a.marketplace,
    pedidos: a.pedidos.size,
    unidades: a.unidades,
    faturamento: centavos(a.faturamento),
    anunciosDistintos: a.anuncios.size,
  }));

  const marketplaces = [...porMarketplace.values()]
    .sort((a, b) => (a.marketplace < b.marketplace ? -1 : a.marketplace > b.marketplace ? 1 : 0))
    .map((m) => ({
      marketplace: m.marketplace,
      pedidos: m.pedidos.size,
      unidades: m.unidades,
      faturamento: centavos(m.faturamento),
    }));

  const pedidosPagos = pedidosGerais.size;
  const faturamento = centavos(faturamentoTotal);

  return {
    totais: {
      pedidosPagos,
      unidades: unidadesTotal,
      faturamento,
      ticketMedio: pedidosPagos > 0 ? centavos(faturamentoTotal / pedidosPagos) : 0,
    },
    marketplaces,
    skus,
    qualidadeDados: {
      linhas: linhas.length,
      linhasSemSku,
      linhasSemValor,
      skusDistintos: porSku.size,
      // Corte do ranking DECLARADO. Um top-N silencioso se le como
      // "e tudo o que existe", e nao e.
      skusOmitidos: Math.max(0, porSku.size - skus.length),
    },
  };
}

/**
 * A FABRICA.
 *
 * Recebe UMA capability nomeada e nada mais. Nao recebe `userId` — esse
 * binding e da 1D-d, quando o registry passar de `HandlerTarefa` para
 * `ConstruirHandler` e montar `(userId) => criarHandlerAnaliseVendas(
 * criarLeiturasDeVendas(userId))`.
 *
 * O handler devolvido tem DOIS parametros, como todo `HandlerTarefa`. A
 * dependencia vive na closure, e por isso ele nao tem como trocar de
 * dono nem pedir uma capability diferente.
 */
export function criarHandlerAnaliseVendas(
  lerVendasDoPeriodo: LerVendasDoPeriodo
): HandlerTarefa {
  if (typeof lerVendasDoPeriodo !== "function") {
    // Capability ausente NAO e estado normal. Falhar na construcao, e
    // nao na execucao, foi a razao de recusar `dados?` na 1D-b.
    throw new Error("criarHandlerAnaliseVendas exige a capability de leitura de vendas");
  }

  return async function handlerAnaliseVendas(
    contexto: ContextoTarefa,
    relatarProgresso: RelatarProgresso
  ): Promise<Record<string, unknown>> {
    relatarProgresso(0);

    const entrada = validarEntradaAnaliseVendas(contexto.entrada);
    relatarProgresso(10);

    const filtro: FiltroVendas = {
      dataInicio: entrada.dataInicio,
      dataFim: entrada.dataFim,
      marketplace: entrada.marketplace ?? null,
    };

    // SEM try/catch de proposito: excecao da capability sobe inteira. Um
    // `catch` aqui viraria "engolir o erro", e o executor perderia a
    // unica informacao que tem para classificar a falha.
    const leitura = await lerVendasDoPeriodo(filtro);
    relatarProgresso(60);

    if (leitura.erro) {
      if (ERROS_DE_FILTRO.includes(leitura.erro)) {
        throw new ErroEntradaTarefa(`leitura de vendas recusou o filtro: ${leitura.erro}`);
      }
      throw new Error(`falha na leitura de vendas: ${leitura.erro}`);
    }

    if (leitura.truncado) {
      // `truncado` significa que o periodo tem MAIS dado do que veio.
      // Devolver totais assim mesmo seria entregar numero incompleto com
      // cara de completo — o proprio `ResultadoVendas` avisa disso.
      //
      // Classificado como ENTRADA e nao como falha de handler: o conserto
      // e encurtar o periodo, e retentar o mesmo filtro nunca vai
      // resolver. `handler_falhou` gastaria as tentativas a toa.
      throw new ErroEntradaTarefa(
        "leitura de vendas truncada: reduza o periodo — o intervalo pedido excede o teto de paginacao"
      );
    }

    const agregado = agregarVendas(leitura.linhas, entrada.limiteSkus ?? LIMITE_SKUS_PADRAO);

    const resultado: Record<string, unknown> = {
      // Autodescricao do que estes numeros SAO — e do que nao sao. O gate
      // 1D-0 mostrou que apresentar receita como rentabilidade e o erro
      // facil de cometer; aqui ele fica registrado junto do dado.
      escopo: {
        campoData: "data_pagamento",
        statusConsiderado: "paid",
        incluiRentabilidade: false,
      },
      periodo: {
        inicio: entrada.dataInicio,
        fim: entrada.dataFim,
        marketplace: entrada.marketplace ?? null,
      },
      totais: agregado.totais,
      marketplaces: agregado.marketplaces,
      skus: agregado.skus,
      qualidadeDados: agregado.qualidadeDados,
    };

    // Sem `geradoEm`. Um timestamp aqui tornaria duas execucoes da MESMA
    // tarefa — que a semantica at-least-once permite — produzirem
    // resultados diferentes. A hora ja existe, e melhor, em
    // `agente_tarefas.concluido_em`.

    relatarProgresso(100);
    return resultado;
  };
}
