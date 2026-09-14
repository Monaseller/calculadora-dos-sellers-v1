/**
 * Handler `consultar_vendas` — FUNCTION-RUNTIME-V1-A.
 *
 * ── O que esta etapa prova ──────────────────────────────────────────
 *
 * Que uma TAREFA da fila consegue executar uma FUNCAO real, passando
 * pelo guard de permissao, pela auditoria de Tool Call e pela Approval
 * — e que o terceiro desfecho publicado pela FUNCTION-RUNTIME-P0
 * (`rodando -> aguardando_aprovacao`) finalmente tem quem o produza.
 *
 * ── A EXCECAO ARQUITETURAL, nomeada ─────────────────────────────────
 *
 * A doutrina vigente e que handler NAO alcanca `execucao-funcoes`:
 * `conversa` e proibido de faze-lo, e ha assert que o prova. Este
 * arquivo e a UNICA excecao ratificada, e ela e nominal — nao e
 * liberacao geral. O motivo e concreto: `conversa` entrega ao modelo
 * uma instrucao e uma mensagem, e um modelo sem tools nao alcanca dado
 * que ninguem lhe deu; aqui a Funcao E o proposito da tarefa, decidido
 * antes de qualquer execucao, sem modelo nenhum no caminho.
 *
 * ── A tarefa NAO escolhe a Funcao ───────────────────────────────────
 *
 * `FUNCAO_ID` e constante deste modulo. A entrada da tarefa carrega
 * APENAS o filtro. Nao ha `funcaoId` no shape aceito, nao ha tool
 * calling, nao ha modelo decidindo ferramenta: a tarefa ja nasce
 * sabendo qual e a operacao dela.
 *
 * ── Quem valida o que ───────────────────────────────────────────────
 *
 * Este handler valida ESTRUTURA e nada mais: as tres chaves conhecidas,
 * tipos, e recusa de propriedade extra. Regex de data, calendario,
 * ordem das pontas, janela de 14 dias e enum de marketplace pertencem a
 * `validarFiltroVendas`, que e a autoridade dessas regras e ja e
 * chamada por `executarFuncao` antes de abrir a Tool Call. Recopia-las
 * aqui criaria a segunda fonte de verdade que o registry de Funcoes
 * existe para impedir.
 *
 * O handler CLASSIFICA o codigo que aquele validador devolveu — isso
 * nao e validar de novo, e ler o veredicto alheio.
 *
 * ── Por que o resultado e um agregado, e nao as linhas ──────────────
 *
 * Um unico dia real desta base tem milhares de linhas, e
 * `agente_tarefas.resultado` e `jsonb` de uma fila, nao um data lake.
 * O agregado abaixo tem TETO ESTRUTURAL: nenhum campo cresce com o
 * volume, os buckets de marketplace sao fixos, e nao ha lista de SKU
 * nem de pedido. Um dia com 25 linhas e um com 3.576 produzem JSON do
 * mesmo tamanho.
 */
import { ErroEntradaTarefa, PausaPorAprovacao } from "@/lib/agentes/erros";
import {
  executarFuncao,
  type ResultadoExecucaoFuncao,
} from "@/lib/agentes/execucao-funcoes/executar";
import type { LinhaVenda } from "@/lib/agentes/dados/vendas";
import type {
  ContextoTarefa,
  HandlerTarefa,
  RelatarProgresso,
} from "@/lib/agentes/tipos-execucao";

/** O tipo de tarefa. A constante e a chave do registry — a suite prova
 *  que as duas sao a mesma string. */
export const TIPO_CONSULTAR_VENDAS = "consultar_vendas";

/**
 * A Funcao executada. CONSTANTE do modulo, nunca da entrada.
 *
 * Se viesse do `contexto.entrada`, uma tarefa enfileirada poderia
 * escolher qual capacidade invocar — e o guard passaria a proteger uma
 * decisao que o proprio pedido tomou.
 */
export const FUNCAO_ID = "vendas.consultar";

// ─── Entrada ──────────────────────────────────────────────────────────

/**
 * O filtro, PLANO. Mesma forma de `FiltroVendas`, sem envelope.
 *
 * Um wrapper `{ argumentos: {...} }` so se justificaria se a tarefa
 * precisasse carregar algo AO LADO dos argumentos — e nao precisa: a
 * Funcao e constante. Um nivel a mais seria semantica duplicada sem
 * consumidor.
 */
export interface EntradaConsultarVendas {
  dataInicio: string;
  dataFim: string;
  marketplace: string | null;
}

/** As unicas chaves aceitas. Fechada: extra REPROVA, nao e ignorada. */
const CHAVES_ACEITAS = ["dataInicio", "dataFim", "marketplace"] as const;

function textoObrigatorio(bruta: Record<string, unknown>, chave: string): string {
  const valor = bruta[chave];
  if (typeof valor !== "string" || valor.trim().length === 0) {
    throw new ErroEntradaTarefa(`${chave} ausente ou nao textual`);
  }
  // NAO normaliza: `trim`, `toUpperCase` ou completar digito inventaria
  // comportamento que ninguem pediu, e a autoridade das datas e o
  // validador da Funcao.
  return valor;
}

/**
 * Le a entrada da tarefa — ESTRUTURA apenas.
 *
 * O que NAO acontece aqui, de proposito: nenhum regex de data, nenhuma
 * checagem de calendario, nenhuma comparacao entre as pontas, nenhuma
 * janela maxima, nenhum enum de marketplace. Todas essas regras tem
 * dono, e o dono e `validarFiltroVendas`.
 */
export function lerEntradaConsultarVendas(bruta: unknown): EntradaConsultarVendas {
  if (typeof bruta !== "object" || bruta === null || Array.isArray(bruta)) {
    throw new ErroEntradaTarefa("entrada da tarefa nao e um objeto");
  }

  const entrada = bruta as Record<string, unknown>;

  // Propriedade extra REPROVA. Ignora-la silenciosamente deixaria um
  // `funcaoId` ou um `userId` viajar na entrada sem que nada acusasse.
  for (const chave of Object.keys(entrada)) {
    if (!(CHAVES_ACEITAS as readonly string[]).includes(chave)) {
      throw new ErroEntradaTarefa(`propriedade nao aceita na entrada: ${chave}`);
    }
  }

  const dataInicio = textoObrigatorio(entrada, "dataInicio");
  const dataFim = textoObrigatorio(entrada, "dataFim");

  // Ausente e `null` sao o MESMO pedido — "todos os marketplaces" — e
  // viram `null` para que o resultado tenha shape estavel. Presente e
  // nao-nulo tem de ser string; QUAL string e assunto do validador.
  const mp = entrada.marketplace;
  if (mp !== undefined && mp !== null && typeof mp !== "string") {
    throw new ErroEntradaTarefa("marketplace deve ser texto ou nulo");
  }
  const marketplace = mp === undefined || mp === null ? null : mp;

  return { dataInicio, dataFim, marketplace };
}

// ─── Aritmetica ───────────────────────────────────────────────────────
//
// As tres regras abaixo sao REIMPLEMENTADAS de `handlers/analise-vendas.ts`
// em vez de importadas, e isso e deliberado: aquele arquivo e congelado
// byte a byte por `testar-agentes-analise-vendas.ts`, e exportar de la
// custaria descongela-lo. Sao seis linhas; a regra em si NAO e nova, e a
// suite prova que as duas copias concordam.

/** Somente `number` finito conta. `null`, `undefined`, `NaN`, `Infinity`
 *  e string viram 0 — nunca `Number(...)`, nunca `+`, nunca concatenacao. */
function numeroOuZero(valor: unknown): number {
  return typeof valor === "number" && Number.isFinite(valor) ? valor : 0;
}

/** Duas casas. Soma de float acumula residuo; o corte e no fim. */
function centavos(valor: number): number {
  return Math.round(valor * 100) / 100;
}

/**
 * Valor de UMA linha: `item_subtotal` quando positivo, `faturamento`
 * caso contrario.
 *
 * A regra esta em `docs/BUSINESS_RULES.md` e nao e escolha estetica: na
 * Shopee `faturamento` e RATEADO por item, entao soma-lo nas linhas de
 * um pedido devolveria o total do pedido inteiro; e o sync do ML nao
 * escreve `item_subtotal` (coluna `NUMERIC DEFAULT 0`), entao la o
 * fallback e o unico valor existente.
 */
function valorDaLinha(linha: LinhaVenda): number {
  const subtotal = numeroOuZero(linha.item_subtotal);
  if (subtotal > 0) return subtotal;
  return numeroOuZero(linha.faturamento);
}

// ─── Agregacao ────────────────────────────────────────────────────────

/** Um bucket do breakdown. Sempre presente, mesmo zerado. */
export interface BucketMarketplace {
  linhas: number;
  pedidos: number;
  unidades: number;
  faturamento: number;
}

export interface ResumoConsultarVendas {
  linhas: number;
  pedidos: number;
  unidades: number;
  faturamento: number;
  ticketMedio: number;
  skusDistintos: number;
}

export interface AgregadoConsultarVendas {
  resumo: ResumoConsultarVendas;
  marketplaces: {
    Shopee: BucketMarketplace;
    ML: BucketMarketplace;
    outros: BucketMarketplace;
  };
}

/** Os tres buckets. FIXOS — e o que garante tamanho constante. */
type NomeBucket = "Shopee" | "ML" | "outros";

/**
 * `LinhaVenda.marketplace` e `string`, nao a uniao do filtro: o banco
 * pode ter valor que o filtro nao aceita. Um valor desconhecido cai em
 * `outros` e o NOME DELE NAO E EXPOSTO — publicar a string abriria uma
 * chave dinamica no resultado e devolveria dado de origem nao prevista.
 *
 * Recebe `string` porque o laco ja provou o tipo antes de chamar — ver
 * a guarda de saida inesperada em `agregarConsultaDeVendas`.
 */
function bucketDe(marketplace: string): NomeBucket {
  if (marketplace === "Shopee") return "Shopee";
  if (marketplace === "ML") return "ML";
  return "outros";
}

function bucketVazio(): BucketMarketplace {
  return { linhas: 0, pedidos: 0, unidades: 0, faturamento: 0 };
}

/**
 * A IDENTIDADE LOGICA de um pedido — `(marketplace, order_id)`.
 *
 * ── Por que `order_id` sozinho nao serve ────────────────────────────
 *
 * Porque nada garante que ele seja unico entre marketplaces. A tabela
 * `pedidos` tem UMA constraint de unicidade, e ela e sobre `id` (a PK
 * interna): nao ha unique sobre `order_id`, nao ha CHECK nenhum, e os
 * dois numeros sao gerados por sistemas que nao se conhecem. Uma
 * coincidencia entre um pedido Shopee e um pedido ML contaria DOIS
 * pedidos como UM — e, como `ticketMedio` divide por essa contagem,
 * o ticket dobraria junto.
 *
 * O dado de hoje nao tem colisao, mas dado de hoje nao e invariante de
 * schema. A chave composta torna a contagem correta por construcao.
 *
 * ── Por que `JSON.stringify` e nao concatenacao ─────────────────────
 *
 * `${marketplace}:${orderId}` seria ambiguo: `("a:b","c")` e
 * `("a","b:c")` produziriam a MESMA string, e nenhuma constraint impede
 * que um marketplace ou um order_id contenha o delimitador.
 * `JSON.stringify` escapa o conteudo de cada elemento, entao no dominio
 * desta funcao — DUAS STRINGS — pares distintos dao chaves distintas.
 *
 * A afirmacao para AQUI. Ela NAO vale para valores arbitrarios: dentro
 * de um array, `undefined`, `NaN` e `Infinity` nao sao valores JSON e o
 * `JSON.stringify` os converte em `null`, colidindo entre si e com
 * `null`. E por isso que a assinatura exige `string` dos dois lados, e
 * que o laco recusa a linha antes de chegar aqui.
 *
 * Interna: a chave existe SO durante a agregacao. Nenhum `order_id`
 * sai no resultado.
 */
function chavePedido(marketplace: string, orderId: string): string {
  return JSON.stringify([marketplace, orderId]);
}

/**
 * PURA: sem banco, sem env, sem rede, sem provedor, sem Approval, sem
 * Tool Call. Exportada para que a suite a alimente com linhas
 * sinteticas — inclusive as malformadas do item de coercao.
 *
 * Nada aqui cresce com a cardinalidade dos dados: contam-se
 * cardinalidades, nunca se listam SKUs, pedidos ou anuncios.
 */
export function agregarConsultaDeVendas(
  linhas: readonly LinhaVenda[]
): AgregadoConsultarVendas {
  const pedidosGerais = new Set<string>();
  const skusGerais = new Set<string>();
  const pedidosPorBucket: Record<NomeBucket, Set<string>> = {
    Shopee: new Set(),
    ML: new Set(),
    outros: new Set(),
  };
  const buckets: Record<NomeBucket, BucketMarketplace> = {
    Shopee: bucketVazio(),
    ML: bucketVazio(),
    outros: bucketVazio(),
  };

  let unidades = 0;
  let faturamento = 0;

  for (const linha of linhas) {
    // ── FAIL CLOSED: marketplace nao-string e SAIDA INESPERADA ──────
    //
    // Primeira instrucao do laco, antes de qualquer acumulador, e isso
    // e o ponto: uma linha recusada nao pode ter somado unidade,
    // faturamento ou linha antes de ser recusada — o resumo seria
    // parcial e pareceria completo.
    //
    // Por que recusar em vez de PULAR a linha: pular contabilizaria
    // valor e unidade dela e NAO contabilizaria o pedido, e
    // `ticketMedio` divide um pelo outro — o numero sairia errado com
    // cara de certo. E por que recusar em vez de coagir: `String(x)`
    // transformaria `null` e `undefined` em marketplaces chamados
    // "null" e "undefined", inventando origem que nao existe.
    //
    // `LinhaVenda.marketplace` e `string` no TIPO, mas o tipo nao foi
    // verificado: `interpretarSaida` da Funcao declara que nao valida
    // linha a linha, e `lerDadosDaFuncao` so confere o envelope. A
    // garantia de hoje e do banco (`pedidos.marketplace text NOT NULL`),
    // que e externa a este modulo — e uma saida que ja foi declarada
    // SUCESSO tendo campo fora do contrato e exatamente o caso que o
    // vocabulario `saida_inesperada` existe para nomear.
    if (typeof linha.marketplace !== "string") {
      throw new Error("funcao_erro:saida_inesperada");
    }

    const valor = valorDaLinha(linha);
    const qtd = numeroOuZero(linha.qtd);

    unidades += qtd;
    faturamento += valor;

    // String DESCONHECIDA continua valida: `"TikTokShop"` cai em
    // `outros` e segue contando. A guarda acima e sobre TIPO em runtime,
    // nunca sobre o enum de dominio — esse continua sendo assunto de
    // `validarFiltroVendas`, dentro da Funcao.
    const nome = bucketDe(linha.marketplace);

    // `order_id` e NOT NULL no schema, mas a linha chega como dado — a
    // checagem custa nada e evita contar `undefined` como pedido. O
    // CRITERIO de participacao e o mesmo de sempre; o que mudou foi a
    // CHAVE do distinct, que passou a carregar o marketplace.
    if (typeof linha.order_id === "string" && linha.order_id.length > 0) {
      const chave = chavePedido(linha.marketplace, linha.order_id);
      pedidosGerais.add(chave);
      // A MESMA chave nos dois conjuntos. Em `Shopee`/`ML` o marketplace
      // ja esta fixado e a composicao nao muda o numero — mas `outros`
      // agrega VARIOS marketplaces desconhecidos, e ali ela e necessaria.
      // Usar uma chave so evita duas semanticas de "pedido" convivendo.
      pedidosPorBucket[nome].add(chave);
    }
    // SKU nulo NAO conta como um SKU distinto: `sku` e `string | null`,
    // e agrupar os nulos daria um "SKU" que nao existe.
    if (typeof linha.sku === "string" && linha.sku.length > 0) {
      skusGerais.add(linha.sku);
    }

    const bucket = buckets[nome];
    bucket.linhas += 1;
    bucket.unidades += qtd;
    bucket.faturamento += valor;
  }

  for (const nome of ["Shopee", "ML", "outros"] as const) {
    // Cardinalidade DENTRO do bucket, pela mesma identidade logica do
    // total. Com a chave composta a soma dos buckets passa a bater com
    // o total geral em contagem de pedidos — antes nao batia quando o
    // mesmo `order_id` aparecia em marketplaces diferentes.
    buckets[nome].pedidos = pedidosPorBucket[nome].size;
    buckets[nome].faturamento = centavos(buckets[nome].faturamento);
  }

  const pedidos = pedidosGerais.size;
  const faturamentoFinal = centavos(faturamento);

  return {
    resumo: {
      linhas: linhas.length,
      pedidos,
      unidades,
      faturamento: faturamentoFinal,
      // Guarda de divisao por zero: periodo sem pedido devolve 0, nunca
      // `NaN` nem `Infinity`.
      ticketMedio: pedidos > 0 ? centavos(faturamentoFinal / pedidos) : 0,
      skusDistintos: skusGerais.size,
    },
    marketplaces: buckets,
  };
}

// ─── Leitura do resultado da Funcao ───────────────────────────────────

/**
 * `envelope.data` e `unknown` no tipo. `interpretarSaida` da Funcao ja
 * garantiu a forma, mas chamar o interpretador de novo daqui seria o
 * handler reexecutando contrato alheio. Este narrowing e LOCAL, pequeno
 * e consistente com aquele contrato — e nao usa cast cego.
 */
interface DadosVendasConsultar {
  linhas: LinhaVenda[];
  truncado: boolean;
}

function lerDadosDaFuncao(data: unknown): DadosVendasConsultar {
  if (typeof data !== "object" || data === null) {
    throw new Error("funcao_erro:saida_inesperada");
  }
  const bruto = data as Record<string, unknown>;
  if (!Array.isArray(bruto.linhas) || typeof bruto.truncado !== "boolean") {
    throw new Error("funcao_erro:saida_inesperada");
  }
  return { linhas: bruto.linhas as LinhaVenda[], truncado: bruto.truncado };
}

/**
 * Os codigos que o VALIDADOR autoritativo devolve.
 *
 * Nao sao regras recopiadas — sao os veredictos dele. Classifica-los
 * como `entrada_invalida` e o que impede uma janela de 30 dias de
 * terminar como `handler_falhou`, que diria que o motor quebrou quando
 * quem errou foi o pedido.
 */
const CODIGOS_DE_ENTRADA = [
  "filtro_ausente",
  "data_invalida",
  "periodo_invertido",
  "janela_excedida",
  "marketplace_invalido",
] as const;

function ehCodigoDeEntrada(codigo: string): boolean {
  return (CODIGOS_DE_ENTRADA as readonly string[]).includes(codigo);
}

// ─── O mapeamento dos desfechos ───────────────────────────────────────

/**
 * Traduz o desfecho de `executarFuncao` no desfecho da TAREFA.
 *
 * ── Por que e uma funcao propria, e exportada ───────────────────────
 *
 * Porque so assim as sete variantes podem ser PROVADAS. Deixar o
 * `switch` dentro do handler obrigaria a suite a substituir
 * `executarFuncao` por um duplo — injecao de dependencia generica que
 * nenhum outro handler tem e que o gate nao autoriza. Esta funcao e
 * PURA: recebe o desfecho ja pronto, nao toca banco, env, rede,
 * provedor, Approval nem Tool Call, e a suite a alimenta com objetos
 * sinteticos das sete variantes.
 *
 * Devolver e concluir; LANCAR e o unico outro caminho — inclusive para
 * a pausa, que sobe como `PausaPorAprovacao` e NAO como erro.
 */
export function mapearResultadoConsultarVendas(
  resultado: ResultadoExecucaoFuncao,
  entrada: EntradaConsultarVendas
): Record<string, unknown> {
  // ── As SETE variantes, exaustivamente ─────────────────────────────
  //
  // `switch` com `never` no default, e nao `if/else`: o compilador passa
  // a recusar uma variante nova nao tratada. Um fallback generico que
  // mandasse tudo para `handler_falhou` engoliria `aguardando_aprovacao`
  // — e uma Approval real ficaria pendente com a tarefa mentindo que
  // falhou, que e exatamente o defeito que a FUNCTION-RUNTIME-P0
  // existiu para eliminar.
  switch (resultado.tipo) {
    case "sucesso": {
      const dados = lerDadosDaFuncao(resultado.envelope.data);
      const agregado = agregarConsultaDeVendas(dados.linhas);
      return {
        periodo: {
          dataInicio: entrada.dataInicio,
          dataFim: entrada.dataFim,
          marketplace: entrada.marketplace,
        },
        resumo: agregado.resumo,
        marketplaces: agregado.marketplaces,
        // Truncamento NAO vira erro: o resumo continua verdadeiro sobre
        // o que foi lido, e o contrato de `ResultadoVendas` diz que quem
        // consome PRECISA propagar isto. Silencia-lo entregaria um total
        // incompleto com cara de completo.
        truncado: dados.truncado,
      };
    }

    case "aguardando_aprovacao":
      // EXATAMENTE isto, e nada mais. A Approval ja foi criada ou
      // reutilizada por `executarFuncao`; a pausa da tarefa e do
      // executor, via `aguardar_aprovacao_tarefa`. O handler nao chama
      // RPC, nao decide e nao consome aprovacao.
      throw new PausaPorAprovacao(resultado.aprovacaoId);

    case "negado":
      // Termina, nao pausa. `permissao_bloqueada` e uma decisao ja
      // tomada pelo dono; esperar por ela seria esperar para sempre.
      throw new Error(`funcao_negada:${resultado.codigo}`);

    case "erro": {
      const codigo = resultado.envelope.error.code;
      // O veredicto do validador autoritativo, CLASSIFICADO — nao
      // revalidado. Sem isto, uma janela de 30 dias terminaria como
      // `handler_falhou`, dizendo que o motor quebrou quando quem errou
      // foi o pedido.
      if (ehCodigoDeEntrada(codigo)) throw new ErroEntradaTarefa(`entrada_invalida:${codigo}`);
      // So o CODIGO, que e vocabulario fechado e ja sanitizado.
      // `envelope.error.message` nao viaja: o modulo de dados ja descarta
      // `message`/`details`/`hint` do driver, e repetir a frase aqui nao
      // acrescenta fato nenhum.
      throw new Error(`funcao_erro:${codigo}`);
    }

    case "aprovacao_indisponivel":
      // Aprovacao vencida, rejeitada, cancelada ou ja consumida. NUNCA
      // pausar: pausar sem aprovacao alcancavel recriaria a tarefa
      // inalcancavel que a P0 eliminou.
      throw new Error(`aprovacao_indisponivel:${resultado.codigo}`);

    case "falha_auditoria":
      // A etapa importa e nao e escondida: `abertura` significa que a
      // Funcao NAO rodou; `desfecho`, que rodou e o registro se perdeu.
      // Sem retry proprio — `reexecutavel: false` e literal, e repeticao
      // e decisao do banco via `tentativas`.
      throw new Error(`falha_auditoria:${resultado.etapa}`);

    case "indisponivel":
      // Agente/tarefa inexistente ou de outro dono. As causas chegam
      // INDISTINGUIVEIS de proposito — separa-las seria um oraculo de
      // existencia de recurso alheio —, e o handler nao tenta adivinhar
      // qual foi.
      throw new Error("funcao_indisponivel");

    default: {
      // Checagem de exaustividade: se uma oitava variante nascer, isto
      // deixa de compilar. E o unico "default" aceitavel — ele nao trata
      // nada, so prova que nao ha o que tratar.
      const _exaustivo: never = resultado;
      return _exaustivo;
    }
  }
}

// ─── O handler ────────────────────────────────────────────────────────

/**
 * A fabrica. `userId` fica preso AQUI, na closure, fora do alcance do
 * handler — mesmo padrao de `analise_vendas` e `conversa`.
 *
 * O handler recebe o ALVO pelo contexto (`agenteId`, `tarefaId`) e o
 * PODER daqui. Nao ha assinatura pela qual ele peca dado de outro dono,
 * e `contexto.userId` deliberadamente NAO e usado: o valor seria o
 * mesmo, mas o handler passaria a ter uma variavel de dono ao alcance.
 */
export function criarHandlerConsultarVendas(userId: string): HandlerTarefa {
  return async function handlerConsultarVendas(
    contexto: ContextoTarefa,
    relatarProgresso: RelatarProgresso
  ): Promise<Record<string, unknown>> {
    relatarProgresso(0);

    const entrada = lerEntradaConsultarVendas(contexto.entrada);

    // Vem da LINHA da tarefa, nunca da entrada. Vazio aqui e defeito
    // nosso, nao pedido malformado — por isso nao e `ErroEntradaTarefa`.
    if (!contexto.agenteId) throw new Error("contexto sem agenteId");
    // `tarefaId` e OBRIGATORIO neste caminho, e nao por simetria: ele
    // entra no fingerprint da Approval (duas tarefas pedindo a mesma
    // acao nao podem colidir), e `executarFuncao` o usa para provar
    // posse da tarefa. `null` aqui descartaria as duas coisas.
    if (!contexto.tarefaId) throw new Error("contexto sem tarefaId");

    relatarProgresso(25);

    const resultado = await executarFuncao({
      userId,
      agenteId: contexto.agenteId,
      tarefaId: contexto.tarefaId,
      funcaoId: FUNCAO_ID,
      argumentos: {
        dataInicio: entrada.dataInicio,
        dataFim: entrada.dataFim,
        marketplace: entrada.marketplace,
      },
    });

    relatarProgresso(75);

    // O `switch` exaustivo vive em `mapearResultadoConsultarVendas`, que
    // e pura e por isso PODE ser provada variante a variante. Aqui so
    // resta devolver o que ela devolveu — ou deixar subir o que ela
    // lancou, inclusive `PausaPorAprovacao`.
    const saida = mapearResultadoConsultarVendas(resultado, entrada);
    relatarProgresso(100);
    return saida;
  };
}
