/**
 * Leitura OFICIAL de vendas no Mercado Livre — F7b.4.8 Parte D.
 *
 * ── Por que este arquivo existe ─────────────────────────────────────
 *
 * `vendas.consultar` le a tabela `pedidos` da CDS, que o sync preenche.
 * Isso e um espelho: serve para relatorio, e nao para responder "quanto
 * vendi esta semana" quando a pergunta e sobre a conta do Mercado Livre.
 * Espelho atrasa, perde pedido que o sync nao alcancou e depende de um
 * cron que pode nao ter rodado — e nada disso aparece no numero.
 *
 * Aqui a fonte e a API oficial, com a credencial que o dono ja autorizou.
 *
 * ── MEDIDO: nao existe filtro por data de PAGAMENTO ────────────────
 *
 * `scripts/medir-ml-orders-search.ts`, contra a API real:
 *
 *   order.date_created.from/to     FILTRA          (3037 na janela)
 *   janela impossivel              FILTRA          (0 — o filtro e real)
 *   payment.date_approved.from/to  IGNORADO        (126931 = tudo)
 *   order.date_closed.from/to      FILTRA          (3039 — existe, mas
 *                                                  nao e pagamento)
 *   parametro inexistente          IGNORADO        (3037 = igual a A)
 *
 * A ultima linha e a que importa: a API devolve **200 e ignora** o que
 * nao conhece. Entao o 200 de `payment.date_approved` nao significa
 * "aceito" — significa "nao existe", e a prova e a contagem ter voltado
 * ao total historico da loja.
 *
 * Consequencia de desenho: a JANELA e buscada por `date_created`, e o
 * RECORTE FINANCEIRO e feito aqui, sobre `payments[].date_approved`.
 * Fingir que a API filtrou por pagamento daria um numero errado com cara
 * de oficial.
 *
 * ── A margem de criacao NAO foi inventada aqui ─────────────────────
 *
 * Um boleto pago dia 10 pode pertencer a um pedido criado dia 5. Buscar
 * a janela de criacao igual a janela financeira perderia essa venda.
 *
 * `sync-ml.ts` ja decidiu esse numero — "noBuffer=false (Cron diario):
 * estende -5 dias para capturar boletos" — e `MARGEM_CRIACAO_DIAS` e o
 * MESMO valor. Duas margens diferentes para o mesmo fenomeno fariam o
 * espelho e a consulta oficial discordarem por construcao.
 *
 * ── Tambem medido: 51 por pagina ───────────────────────────────────
 *
 * `limit=51` responde 200 e devolve 51; `limit=100` devolve 400. E
 * `offset=1000` funciona — o teto de mil do sync antigo era bug de
 * cliente, nao limite da API.
 *
 * ── Este arquivo nunca recebe credencial de fora ───────────────────
 *
 * `getMLLojaById(lojaId, userId)` resolve token e `seller_id` a partir do
 * PAR, e renova quando vencido. Nada disso entra por argumento: quem
 * chama diz de quem e a loja, nunca qual o token.
 */
import "server-only";
import { getMLLojaById } from "@/lib/ml-auth";
import {
  diaEmSaoPaulo, fimDoDiaEmSaoPaulo, inicioDoDiaEmSaoPaulo,
  somarDiasNoCalendario,
} from "@/lib/fuso-sao-paulo";
import type { LimiteExterno } from "@/lib/controle-tempo";
// ML-CORPUS-A: a regra (normalizacao + pack_splitted) mora no servico
// canonico — o oraculo live e o corpus do banco usam a MESMA funcao.
import { CANCELAMENTO_DE_PACOTE_REFEITO, normalizarPedidoML } from "@/lib/vendas/canonico/ml";

/**
 * Os codigos que sobem. MESMO vocabulario de
 * `lib/mercado-livre-perguntas.ts` — as duas leituras do ML falham pelas
 * mesmas razoes, e dois vocabularios obrigariam a UI a traduzir dois.
 */
export type ErroVendasML =
  | "credencial_ausente"
  | "nao_autorizado"
  | "limite_excedido"
  | "indisponivel"
  | "resposta_invalida"
  /**
   * F7b.4.8.3: a expressao de periodo nao foi entendida.
   *
   * Separado de `resposta_invalida` porque a acao e outra e o culpado e
   * outro: aqui o provedor nem foi chamado, e quem pode corrigir e o
   * MODELO — trocando as palavras. E por isso que o codigo e corrigivel.
   */
  | "periodo_nao_entendido";

/** O endereco oficial. Uma constante, num lugar. */
const ENDPOINT = "https://api.mercadolibre.com/orders/search";

/** MEDIDO: 51 e o maximo; 100 responde 400. */
export const LIMITE_POR_PAGINA = 51;

/**
 * Dias que a busca por CRIACAO recua antes do inicio financeiro.
 *
 * O mesmo -5 de `sync-ml.ts`. Ver o bloco de cabecalho.
 */
export const MARGEM_CRIACAO_DIAS = 5;

/**
 * Os dois campos de data que `/orders/search` aceita como FILTRO.
 *
 * MEDIDO (`medir-ml-filtro-fechamento.ts`): os dois paginam igual —
 * `unicos == paging.total` em todo dia testado — e setembro inteiro por
 * `order.date_closed` chegou aos MESMOS 11.032 pedidos que a coleta por
 * criacao, em 235 chamadas. Nao e inferencia por status 200: e o mesmo
 * conjunto por dois caminhos diferentes.
 *
 * MEDIDO tambem: o filtro vaza alguns pedidos do dia SEGUINTE na borda.
 * Por isso quem recorta de verdade e o dia em Sao Paulo, localmente — o
 * filtro so reduz o que vem pela rede.
 */
export const CAMPO_DE_CRIACAO = "order.date_created";
export const CAMPO_DE_FECHAMENTO = "order.date_closed";

/**
 * Teto de paginas por SUBJANELA de um dia.
 *
 * ── Por que o teto antigo truncava — MEDIDO ────────────────────────
 *
 * Era `MAX_PAGINAS = 60` para a consulta INTEIRA: 60 x 51 = 3060 pedidos.
 * E a janela buscada e maior que a financeira, por causa da margem de
 * boleto — 7 dias pedidos viram 12 dias lidos.
 *
 * Medido em `scripts/medir-ml-paginacao-profunda.ts`, loja real:
 *
 *   financeiro 28/09–04/10  ->  criacao 23/09–04/10  ->  2197  cabia
 *   financeiro 21/09–27/09  ->  criacao 16/09–27/09  ->  3572  ESTOUROU
 *   financeiro 24/09–30/09  ->  criacao 19/09–30/09  ->  3444  ESTOUROU
 *   agosto/2026             ->  criacao 27/07–31/08  -> 10218  ESTOUROU
 *
 * Era exatamente essa a assimetria que o Rodrigo viu: "esta semana"
 * completa e "semana passada" truncada, com a comparacao percentual sendo
 * apresentada como se as duas valessem.
 *
 * ── E por que o teto tambem nao podia so subir ─────────────────────
 *
 * MEDIDO: `offset` acima de 10000 devolve HTTP 400 ("Limit must be a
 * lower or equal than 10000"). Agosto tem 10218 na janela de criacao —
 * mais que o teto do proprio provedor. Paginacao linear nao alcanca.
 *
 * A saida e subdividir: cada DIA e uma consulta propria, e o maior dia
 * medido tem 477 pedidos (10 paginas). O orcamento e por dia e vale para
 * TODAS as passadas: uma releitura de dia curto (ver `TENTATIVAS_POR_DIA`)
 * consome do mesmo teto, e tres passadas de um dia pesado cabem aqui.
 */
export const MAX_PAGINAS_POR_DIA = 60;

/**
 * Quantas vezes um dia pode ser RELIDO quando a contagem vem curta.
 *
 * ── MEDIDO: a paginacao por offset nao e estavel ───────────────────
 *
 * `medir-ml-empate-e-total.ts`, em ondas de 3 sobre os 16 dias de
 * 05/09..20/09:
 *
 *   2026-09-07   unicos=476   paging.total=477   duplicadas=1
 *
 * Uma linha veio duas vezes e outra nao veio nenhuma. E o comportamento
 * classico de offset sobre chave com empate: `sort=date_asc` ordena por
 * `date_created`, pedidos do mesmo instante nao tem ordem definida entre
 * si, e na fronteira de pagina a ordem relativa muda entre chamadas.
 *
 * Intermitente: apareceu em 2 de 4 varreduras, e nunca nas 32 leituras
 * SEQUENCIAIS dos mesmos dias. Foi essa perda que fez a janela
 * 10/09..20/09 dar 3304 onde o oraculo deu 3305.
 *
 * Reler resolve porque cada passada sorteia os empates de novo, e a UNIAO
 * cresce monotonicamente em direcao ao total. Nao e retry cego: a passada
 * nova so acontece quando a contagem provou estar curta, e para no
 * instante em que alcanca o total.
 */
export const TENTATIVAS_POR_DIA = 3;

/**
 * Quantas vezes uma pagina com 429 e tentada de novo, com espera.
 *
 * MEDIDO: em ondas de 6, a varredura de 16 dias levou 429 em 3 dias de
 * uma passada — e 429 dizia "sua conta e invalida" no desenho antigo,
 * abortando a consulta inteira. Nao e isso que ele diz: ele diz devagar.
 */
export const TENTATIVAS_APOS_429 = 3;

/**
 * Quantas subjanelas sao lidas ao mesmo tempo.
 *
 * ── Por que TRES, e nao seis ────────────────────────────────────────
 *
 * Seis foi escolhido a partir de uma medicao de 8 chamadas simultaneas
 * que responderam 200 em 403 ms. Essa medicao era de um INSTANTE, e nao
 * de uma varredura: em ondas de 6 sobre 128 paginas, o provedor devolveu
 * **429** em 3 dias de uma unica passada (medido). Em ondas de 3, nenhum
 * 429 em 4 varreduras completas da mesma janela.
 *
 * Custo: agosto passa de ~9 s para ~18 s — ainda dentro do corte de 60 s.
 * Um numero errado rapido nao vale mais que um numero certo.
 */
export const CONCORRENCIA_DE_SUBJANELAS = 3;

/** Orcamento proprio de UMA chamada, quando nao ha orcamento de acao. */
const TIMEOUT_MS = 20_000;

/**
 * O pedido oficial, reduzido ao que a conta financeira precisa.
 *
 * Nao ha comprador, nao ha endereco, nao ha item, nao ha `seller_id`:
 * quem consome isto responde "quanto vendi", e nada disso participa. O
 * tipo nao tem campo onde esses dados caberiam.
 */
export interface PedidoOficialML {
  readonly pedidoId: string;
  /** `YYYY-MM-DD` no fuso de Sao Paulo — a data de PAGAMENTO. */
  readonly dataPagamento: string;
  /** `paid_amount` do pedido, como a API oficial devolveu. */
  readonly valorPago: number;
  readonly status: string;
}

export interface ResultadoBrutoVendasML {
  readonly pedidos: readonly PedidoOficialML[];
  readonly erro: ErroVendasML | null;
  /** Quantas paginas a consulta chegou a ler, somando as subjanelas. */
  readonly paginasLidas: number;
  /** Quantos pedidos a API devolveu, ANTES do recorte financeiro. */
  readonly recebidosDoProvider: number;
  /**
   * Quantos ids REPETIDOS a varredura encontrou — §8.
   *
   * Zero e o esperado: as subjanelas de criacao sao disjuntas. Ele existe
   * porque "deduplicamos" sem medir seria uma afirmacao sem prova, e um
   * numero maior que zero aqui diria que a fronteira entre dias nao e o
   * que este codigo supoe.
   */
  readonly duplicadosDescartados: number;
  /** Quantos cairam por nao ter pagamento aprovado na janela. */
  readonly foraDaJanelaFinanceira: number;
  /**
   * `true` quando TODAS as subjanelas foram lidas ate o fim — §11.
   *
   * E este campo, e nao `truncado`, que autoriza apresentar um total.
   *
   * A pagina curta PARA a subjanela; quem afirma completude e a contagem
   * conferida contra o `paging.total` DAQUELE DIA. A distincao e medida:
   * o total de uma janela larga (3572) nao bate com a soma dos totais
   * diarios (3642), mas o total de UM dia bateu com os ids contados em
   * 48/48 leituras, com e sem filtro de status. A pagina curta sozinha nao
   * percebe uma linha perdida no meio — e uma foi perdida, na prova do
   * §39. Ver o comentario em `lerSubjanela`.
   */
  readonly completo: boolean;
  /** Negacao de `completo`. Mantido para quem ja o consumia. */
  readonly truncado: boolean;
  /** Quantas subjanelas nao chegaram ao fim. Zero quando completo. */
  readonly subjanelasIncompletas: number;
  /** A janela de CRIACAO que foi de fato pedida a API. */
  readonly janelaDeCriacao: { readonly de: string; readonly ate: string };
}

export interface EntradaVendasML {
  readonly userId: string;
  readonly lojaId: string;
  /** Inicio financeiro, `YYYY-MM-DD` no fuso de Sao Paulo. */
  readonly de: string;
  /** Fim financeiro, inclusivo, `YYYY-MM-DD` no fuso de Sao Paulo. */
  readonly ate: string;
  /**
   * Corte por HORARIO, opcional — F8.2-B.
   *
   * Instante (epoch ms) apos o qual um pedido nao conta, mesmo dentro do
   * dia. Existe para o painel "Vendas ao vivo" comparar hoje ate agora com
   * ONTEM ATE O MESMO HORARIO. O criterio continua sendo o MESMO
   * `order.date_closed` do recorte por dia — so com um limite a mais.
   *
   * Ausente = comportamento provado de sempre (dia inteiro). A Tool de
   * vendas e o filtro do modelo NAO passam este campo.
   */
  readonly ateInstanteMs?: number;
}

/**
 * As portas, para a suite poder exercitar o adapter sem rede.
 *
 * Mesmo desenho de `buscarPerguntasRecebidasML`. Em producao ninguem
 * passa nada: os defaults sao `getMLLojaById` e `fetch`.
 */
export interface PortasVendasML {
  readonly resolverCredencial?: typeof getMLLojaById;
  readonly buscar?: typeof fetch;
}

function falha(
  erro: ErroVendasML,
  janela: { de: string; ate: string }
): ResultadoBrutoVendasML {
  return {
    pedidos: [], erro, paginasLidas: 0, recebidosDoProvider: 0,
    duplicadosDescartados: 0, foraDaJanelaFinanceira: 0,
    // Falha NAO e completude. Um erro com `completo: true` autorizaria
    // apresentar zero como se fosse a resposta.
    completo: false, truncado: true, subjanelasIncompletas: 0,
    janelaDeCriacao: janela,
  };
}

/**
 * Status HTTP -> codigo nosso.
 *
 * `401` e `403` colapsam em `nao_autorizado`: a acao do dono e a mesma —
 * reconectar a conta —, e distinguir "token invalido" de "escopo
 * insuficiente" nao muda nada para ele.
 */
function codigoDoStatus(status: number): ErroVendasML {
  if (status === 401 || status === 403) return "nao_autorizado";
  if (status === 429) return "limite_excedido";
  return "indisponivel";
}

/** `YYYY-MM-DD` valido? Sem `Date` — `new Date("2026-02-31")` nao recusa. */
function ehDataIso(v: unknown): v is string {
  return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
}

/** A data `YYYY-MM-DD` deslocada em `n` dias. Meio-dia evita fuso. */
function somarDias(dia: string, n: number): string {
  const d = new Date(`${dia}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * O instante de pagamento, no DIA de Sao Paulo.
 *
 * `-3h` e a mesma conversao de `sync-ml.ts`. Ela e aritmetica de fuso
 * fixo, e nao de horario de verao: o Brasil nao tem horario de verao
 * desde 2019, e o sync ja depende disso desde antes deste arquivo.
 */
function diaBRT(iso: string): string | null {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return null;
  return new Date(t - 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/**
 * O pagamento que conta, e a data dele.
 *
 * `approved` e `partially_refunded` — exatamente o critério de
 * `sync-ml.ts`. Um pedido estornado em parte foi pago; a venda aconteceu
 * financeiramente, e `BUSINESS_RULES.md` e explicito de que a data
 * permanece.
 *
 * ── Mais de um pagamento aprovado: o MAIS ANTIGO ────────────────────
 *
 * MEDIDO em 01/08..07/08 (`medir-ml-semantica-pagamento.ts`): 36 dos 2042
 * pedidos da semana tem mais de um pagamento, 10 deles tem mais de um
 * pagamento APROVADO, e em 3 desses a ordem do array NAO comeca pelo mais
 * antigo.
 *
 * `sync-ml.ts` usa `.find()` — a primeira posicao do array — e por isso o
 * espelho da CDS pode atribuir a venda a outro dia. Este gate declara o
 * espelho `KNOWN_UNRELIABLE / DEFERRED` e nao o corrige; aqui a regra e
 * dita, e nao herdada:
 *
 *   a venda foi paga no PRIMEIRO instante em que houve pagamento
 *   aprovado; um segundo pagamento aprovado depois nao empurra a venda
 *   para a frente no tempo.
 *
 * Sem isso, a ordem de um array do provedor decidiria em que dia — e, na
 * fronteira do mes, em que MES — a venda entra.
 */
function pagamentoQueConta(pedido: Record<string, unknown>): string | null {
  const pagamentos = pedido.payments;
  if (!Array.isArray(pagamentos)) return null;
  let maisAntigo: string | null = null;
  for (const p of pagamentos) {
    if (typeof p !== "object" || p === null) continue;
    const pg = p as Record<string, unknown>;
    if (pg.status !== "approved" && pg.status !== "partially_refunded") continue;
    if (typeof pg.date_approved !== "string" || pg.date_approved === "") continue;
    // Comparacao por INSTANTE, e nao por texto: dois ISO da mesma hora
    // podem vir com offsets diferentes, e ai ordenar string mente.
    const t = new Date(pg.date_approved).getTime();
    if (!Number.isFinite(t)) continue;
    if (maisAntigo === null || t < new Date(maisAntigo).getTime()) {
      maisAntigo = pg.date_approved;
    }
  }
  return maisAntigo;
}

/** Somente `number` finito. Nunca `Number(...)`, nunca `+`. */
/** O resultado de UMA subjanela. `completa` e o que autoriza o total. */
interface Subjanela {
  readonly brutos: readonly Record<string, unknown>[];
  readonly paginas: number;
  readonly completa: boolean;
  readonly erroFatal: ErroVendasML | null;
}

function numeroOuZero(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/**
 * As vendas PAGAS no periodo, direto da conta do dono.
 *
 * ── A ordem das coisas, e por que ela e esta ────────────────────────
 *
 *  1. valida a entrada — sem tocar rede
 *  2. resolve a credencial pelo PAR `(lojaId, userId)`
 *  3. busca a janela de CRIACAO, paginando
 *  4. recorta por data de PAGAMENTO, aqui
 *
 * O passo 4 nao pode virar passo 3: a API nao o oferece (medido), e
 * pedi-lo a ela devolveria a loja inteira com status 200.
 */
/** O que a varredura compartilhada devolve. */
interface Varredura {
  readonly subjanelas: readonly Subjanela[];
  readonly erro: ErroVendasML | null;
}

/**
 * A varredura, dia por dia — UMA implementacao para as duas regras.
 *
 * ── Por que compartilhada ───────────────────────────────────────────
 *
 * Aqui moram as correcoes da F7b.4.8.3, que custaram um gate inteiro:
 * pagina curta nao e fim, offset anda pelo que veio, cobertura conferida
 * contra `paging.total` do dia, 429 espera em vez de abortar, releitura
 * do dia que vem curto, concorrencia de tres. Uma segunda copia disso
 * para a regra nova seria a garantia de que uma das duas regrediria.
 *
 * O que muda entre as regras e o CAMPO de data do filtro e a lista de
 * dias. O resto e identico.
 */
async function varrerDias(args: {
  readonly userId: string;
  readonly lojaId: string;
  readonly campoDeData: string;
  readonly dias: readonly string[];
  readonly limiteExterno?: LimiteExterno;
  readonly portas?: PortasVendasML;
}): Promise<Varredura> {
  const { userId, lojaId, campoDeData, dias, limiteExterno, portas } = args;

  const resolver = portas?.resolverCredencial ?? getMLLojaById;
  const buscar = portas?.buscar ?? fetch;

  let credencial: Awaited<ReturnType<typeof getMLLojaById>>;
  try {
    credencial = await resolver(lojaId, userId, limiteExterno);
  } catch {
    return { subjanelas: [], erro: "indisponivel" };
  }
  if (credencial === null || !credencial.accessToken || !credencial.sellerId) {
    return { subjanelas: [], erro: "credencial_ausente" };
  }

  const lerSubjanela = async (dia: string): Promise<Subjanela> => {
    const brutos: Record<string, unknown>[] = [];
    let paginas = 0;
    /** Os ids DESTE dia — a contagem que se confere contra o provedor. */
    const idsDoDia = new Set<string>();
    /** Todo `paging.total` visto neste dia. Mais de um = o conjunto mexeu. */
    const totaisRelatados = new Set<number>();

    /**
     * UMA passada pelo dia, do offset zero ao fim.
     *
     * Acumula em `brutos`, `idsDoDia` e `totaisRelatados`, que sao da
     * subjanela e nao da passada — e isso e o ponto: uma segunda passada
     * soma a UNIAO, e nao recomeca a contagem.
     */
    const passada = async (): Promise<Subjanela> => {
      // ── O offset anda pelo que VEIO, e nao pelo que se pediu ──────
      //
      // Uma pagina pode voltar com menos de 51 linhas SEM ser a ultima.
      // Somar 51 nesse caso pularia as linhas que ficaram faltando — e
      // era esse o jeito antigo. Andar pelo tamanho real do lote cobre a
      // lacuna: pedi 51, vieram 40, o proximo pedido comeca em 40.
      let offset = 0;
      /** Quantas vezes esta pagina levou 429. Zera a cada pagina nova. */
      let esperas = 0;
      for (;;) {
      if (paginas >= MAX_PAGINAS_POR_DIA) {
        return { brutos, paginas, completa: false, erroFatal: null };
      }

      const url = new URL(ENDPOINT);
      url.searchParams.set("seller", credencial.sellerId);
      // ── SEM `order.status` — a autoridade e o PAGAMENTO ───────────
      //
      // `order.status=paid` estava aqui, e escondia dinheiro real.
      //
      // MEDIDO em 10/09..20/09 (`medir-ml-janela-divergente.ts`): com o
      // filtro, 3305 pedidos e 125845.26; sem ele, 3314 e 126138.55. Os 9
      // pedidos de diferenca tem `order.status = partially_refunded` com
      // pagamento `approved` — ou seja, exatamente o caso que a regra
      // deste arquivo diz contar, e que o filtro removia antes de a regra
      // ser aplicada. Duas autoridades sobre o mesmo numero, discordando.
      //
      // Custo medido da remocao: 128 paginas contra 123 na mesma janela de
      // 16 dias (+4%). Nada do que entra passa a contar sozinho — pedido
      // cancelado tem pagamento `refunded`, e `pagamentoQueConta` continua
      // recusando (e, medido, o `paid_amount` desses e 0.00).
      //
      // Um dia civil INTEIRO no fuso de Sao Paulo. Cortar a meia-noite
      // perderia o dia que a pessoa pediu.
      //
      // As fronteiras saem de `fuso-sao-paulo.ts`, que descobre o offset
      // VIGENTE naquele dia em vez de supor -03:00. Se o horario de verao
      // voltar, o filtro acompanha sem ninguem mexer aqui.
      url.searchParams.set(
        `${campoDeData}.from`, inicioDoDiaEmSaoPaulo(dia) ?? `${dia}T00:00:00.000-03:00`);
      url.searchParams.set(
        `${campoDeData}.to`, fimDoDiaEmSaoPaulo(dia) ?? `${dia}T23:59:59.999-03:00`);
      url.searchParams.set("sort", "date_asc");
      url.searchParams.set("limit", String(LIMITE_POR_PAGINA));
      url.searchParams.set("offset", String(offset));

      const teto = limiteExterno === undefined
        ? TIMEOUT_MS
        : Math.min(TIMEOUT_MS, limiteExterno.restanteMs());
      // Orcamento esgotado NAO e falha: o que ja foi lido vale, e a
      // subjanela volta INCOMPLETA. Descartar desperdicaria trabalho real;
      // mentir que esta completa daria um total errado.
      if (teto <= 0) return { brutos, paginas, completa: false, erroFatal: null };

      const controlador = new AbortController();
      const relogio = setTimeout(() => controlador.abort(), teto);
      const propagar = () => controlador.abort();
      const doOrcamento = limiteExterno?.signal;
      if (doOrcamento?.aborted) controlador.abort();
      else doOrcamento?.addEventListener("abort", propagar, { once: true });

      let resposta: Response;
      try {
        resposta = await buscar(url.toString(), {
          headers: { Authorization: `Bearer ${credencial.accessToken}` },
          signal: controlador.signal,
        });
      } catch {
        // Falha de rede na PRIMEIRA pagina do PRIMEIRO dia e falha da
        // consulta. Aqui ela e so uma subjanela incompleta — quem decide
        // se ha resposta e o agregador, olhando o conjunto.
        return { brutos, paginas, completa: false, erroFatal: null };
      } finally {
        clearTimeout(relogio);
        doOrcamento?.removeEventListener("abort", propagar);
      }

      // ── 429 nao condena a conta; ele pede espera ──────────────────
      //
      // No desenho antigo 429 era fatal, ao lado de 401 e 403. MEDIDO que
      // isso estava errado em dois sentidos: em ondas de 6 o provedor
      // devolveu 429 em 3 dias de uma passada — e um 429 abortava a
      // consulta inteira, transformando uma pedida de calma em "nao foi
      // possivel". A mesma pagina, pedida de novo depois de uma espera,
      // responde.
      if (resposta.status === 429 && esperas < TENTATIVAS_APOS_429) {
        esperas += 1;
        const espera = 400 * Math.pow(3, esperas - 1);
        const teto429 = limiteExterno === undefined
          ? espera
          : Math.min(espera, limiteExterno.restanteMs());
        // Sem orcamento para esperar, nao ha o que esperar.
        if (teto429 <= 0) {
          return { brutos, paginas, completa: false, erroFatal: null };
        }
        await new Promise((r) => setTimeout(r, teto429));
        continue;
      }

      if (!resposta.ok) {
        return {
          brutos, paginas, completa: false,
          // 401/403 falam da CONTA, e nao deste dia: eles condenam a
          // consulta inteira, e nao ha por que varrer os outros 35 dias
          // para receber o mesmo 401. 429 ja foi tratado acima, e se
          // chegou aqui e porque as esperas acabaram — dia incompleto,
          // nao consulta perdida.
          erroFatal: resposta.status === 401 || resposta.status === 403
            ? codigoDoStatus(resposta.status) : null,
        };
      }
      esperas = 0;

      let corpo: unknown;
      try { corpo = await resposta.json(); } catch {
        return { brutos, paginas, completa: false, erroFatal: null };
      }
      if (typeof corpo !== "object" || corpo === null) {
        return { brutos, paginas, completa: false, erroFatal: null };
      }
      const resultados = (corpo as Record<string, unknown>).results;
      if (!Array.isArray(resultados)) {
        return { brutos, paginas, completa: false, erroFatal: null };
      }

      paginas += 1;
      const totalDaPagina = (corpo as { paging?: { total?: unknown } }).paging?.total;
      if (typeof totalDaPagina === "number" && Number.isFinite(totalDaPagina)) {
        totaisRelatados.add(totalDaPagina);
      }
      for (const item of resultados) {
        if (typeof item === "object" && item === null) continue;
        if (typeof item !== "object") continue;
        const linha = item as Record<string, unknown>;
        const id = linha.id;
        if (typeof id !== "string" && typeof id !== "number") {
          // Sem id nao ha como saber se repete. Entra, e o agregador
          // decide — perder uma venda por falta de id seria pior.
          brutos.push(linha);
          continue;
        }
        // So o que e NOVO no dia. A segunda passada existe para achar a
        // linha que faltou, e nao para reentregar as 476 que ja vieram:
        // sem isto, `duplicadosDescartados` deixaria de medir sobreposicao
        // do provedor e passaria a medir a nossa propria releitura.
        if (idsDoDia.has(String(id))) continue;
        idsDoDia.add(String(id));
        brutos.push(linha);
      }

      // ── O fim do dia e a CONTAGEM, e nao a pagina curta ──────────
      //
      // MEDIDO na prova do §39: a janela 10/09..20/09 deu 3305 pedidos no
      // oraculo, 3304 na leitura do agente quatro minutos depois, e 3305
      // outra vez em duas releituras — com soma identica, logo o mesmo
      // conjunto. Um pedido, 42.90, sumiu de uma varredura que se
      // declarou COMPLETA.
      //
      // Tres hipoteses foram testadas e REFUTADAS:
      //
      //   deriva de paginacao      estavel em varredura rapida, em lenta
      //                            com 2s entre paginas, com e sem filtro
      //   erro transitorio engolido  todo caminho de falha aqui devolve
      //                            `completa: false` — nao sai total
      //   empate em `date_created`   0 duplicadas em 48 leituras, e
      //                            unicos == paging.total em 48/48
      //
      // E 32/32 leituras SEQUENCIAIS dos 16 dias da janela bateram exato.
      // O que a producao faz de diferente e ler 6 subjanelas ao mesmo
      // tempo — e foi sob concorrencia que a perda apareceu.
      //
      // Dai a regra nova: uma pagina curta NAO e prova de fim. Ela pode
      // ser uma resposta parcial no meio. O fim e um destes:
      //
      //   lote vazio            nao ha mais o que ler
      //   contagem alcancada    ja se leu o total que o provedor relatou
      //   teto de paginas       e ai a subjanela volta INCOMPLETA
      //
      // `paging.total` por DIA serve para isso, e por janela larga nao:
      // medido em 48 leituras de 8 dias, com e sem filtro de status, a
      // contagem unica bateu com o total do dia em 48/48 — enquanto o
      // total de uma janela larga (3572) discorda da soma dos dias (3642).
      //
      // ── Por que ">=" e nao "==" ──────────────────────────────────
      //
      // O dia de HOJE ainda recebe pedido. Exigir contagem congelada
      // marcaria "esta semana" como incompleta sempre que uma venda
      // entrasse no meio da varredura — trocaria um numero certo por um
      // "nao consegui" falso, que e o defeito que este gate veio corrigir.
      //
      // Crescer e inofensivo, e isso depende de ter removido
      // `order.status`: `date_created` e imutavel e pedido nao e apagado,
      // entao o conjunto de um dia so RECEBE linha. Com `sort=date_asc` a
      // linha nova entra no fim, depois da posicao ja lida — nunca
      // empurra o que ja passou. Era o filtro de status que tornava o
      // conjunto mutavel nos dois sentidos, porque um pedido podia SAIR
      // dele.
      //
      // Total ausente = nao ha o que conferir, e sem conferencia nao se
      // afirma completude.
      const menorTotal = totaisRelatados.size === 0
        ? null
        : Math.min(...totaisRelatados);
      if (resultados.length === 0 ||
        (menorTotal !== null && idsDoDia.size >= menorTotal)) {
        return {
          brutos, paginas,
          completa: menorTotal !== null && idsDoDia.size >= menorTotal,
          erroFatal: null,
        };
      }
      offset += resultados.length;
      }
    };

    // ── A releitura do dia curto ────────────────────────────────────
    //
    // Contagem menor que o total do dia significa que a paginacao perdeu
    // linha — medido em 09/07: 476 lidas contra 477 relatadas, com uma
    // duplicada no meio. Outra passada sorteia os empates de novo, e a
    // uniao cresce. Para no instante em que alcanca; nunca insiste em dia
    // que ja fechou, e nunca insiste alem do orcamento de paginas.
    let ultima: Subjanela = { brutos, paginas: 0, completa: false, erroFatal: null };
    for (let tentativa = 1; tentativa <= TENTATIVAS_POR_DIA; tentativa += 1) {
      ultima = await passada();
      if (ultima.erroFatal !== null || ultima.completa) return ultima;
      if (paginas >= MAX_PAGINAS_POR_DIA) return ultima;
    }
    return ultima;
  };

  // ── Concorrencia limitada, em ondas ──────────────────────────────
  //
  // `Promise.all` sobre 36 dias abriria 36 conexoes de uma vez. Ondas de
  // tres: MEDIDO que seis produz 429 numa varredura de 128 paginas, e que
  // tres nao produziu nenhum em 4 varreduras da mesma janela.
  const subjanelas: Subjanela[] = [];
  for (let i = 0; i < dias.length; i += CONCORRENCIA_DE_SUBJANELAS) {
    const onda = dias.slice(i, i + CONCORRENCIA_DE_SUBJANELAS);
    const lidas = await Promise.all(onda.map(lerSubjanela));
    subjanelas.push(...lidas);
    const fatal = lidas.find((x) => x.erroFatal !== null);
    // Erro de CONTA interrompe: os dias restantes receberiam o mesmo.
    if (fatal !== undefined) {
      return { subjanelas: [], erro: fatal.erroFatal as ErroVendasML };
    }
  }

  // Nenhum dia leu nada e nenhum completou: nao ha resposta a dar.
  if (subjanelas.every((x) => x.paginas === 0)) {
    return { subjanelas: [], erro: "indisponivel" };
  }

  return { subjanelas, erro: null };
}

/**
 * As vendas PAGAS no periodo — recorte por data de PAGAMENTO.
 *
 * ── O que esta funcao e, e o que ela NAO e ──────────────────────────
 *
 * Ela responde sobre FLUXO FINANCEIRO: quanto foi pago, quando o
 * pagamento foi aprovado. A semantica disso segue PARCIAL
 * (`docs/SEMANTICA_FATURAMENTO_ML.md`), e ela NAO e a resposta para
 * "quanto vendi" — essa e `buscarVendasBrutasML`, provada contra o
 * relatorio oficial do Mercado Livre no F7b.4.8.4.
 *
 * Preservada de proposito: pagamento nao e lixo, e outra dimensao.
 */
export async function buscarVendasPagasML(
  entrada: EntradaVendasML,
  limiteExterno?: LimiteExterno,
  portas?: PortasVendasML
): Promise<ResultadoBrutoVendasML> {
  const { userId, lojaId, de, ate } = entrada;
  const janelaVazia = { de: "", ate: "" };

  if (!userId || !lojaId) return falha("credencial_ausente", janelaVazia);
  if (!ehDataIso(de) || !ehDataIso(ate) || de > ate) {
    return falha("resposta_invalida", janelaVazia);
  }

  const criacaoDe = somarDias(de, -MARGEM_CRIACAO_DIAS);
  const janela = { de: criacaoDe, ate };

  const dias: string[] = [];
  for (let d = criacaoDe; d <= ate; d = somarDias(d, 1)) dias.push(d);

  const varredura = await varrerDias({
    userId, lojaId, campoDeData: CAMPO_DE_CRIACAO, dias, limiteExterno, portas,
  });
  if (varredura.erro !== null) return falha(varredura.erro, janela);
  const subjanelas = varredura.subjanelas;

  // ── Dedupe por id do pedido — §8 ────────────────────────────────
  //
  // As subjanelas de criacao sao disjuntas, entao o esperado e zero
  // repetido. A contagem existe porque afirmar "deduplicamos" sem medir
  // nao e prova: um numero acima de zero diria que a fronteira entre dias
  // nao e o que este codigo supoe.
  const pedidos: PedidoOficialML[] = [];
  const vistos = new Set<string>();
  let recebidos = 0;
  let fora = 0;
  let duplicados = 0;
  let paginas = 0;
  let incompletas = 0;

  for (const sub of subjanelas) {
    paginas += sub.paginas;
    if (!sub.completa) incompletas += 1;
    recebidos += sub.brutos.length;

    for (const o of sub.brutos) {
      const id = String(o.id ?? "");
      if (id !== "" && vistos.has(id)) { duplicados += 1; continue; }
      if (id !== "") vistos.add(id);

      const aprovado = pagamentoQueConta(o);
      if (aprovado === null) { fora += 1; continue; }
      const dia = diaBRT(aprovado);
      // ── O RECORTE FINANCEIRO ─────────────────────────────────────
      // A janela de criacao e mais larga de proposito. Pedido pago fora do
      // periodo pedido nao e venda do periodo, e entra aqui so para ser
      // descartado — e contado, para a Funcao poder explicar.
      if (dia === null || dia < de || dia > ate) { fora += 1; continue; }

      pedidos.push({
        pedidoId: id,
        dataPagamento: dia,
        valorPago: numeroOuZero(o.paid_amount),
        status: typeof o.status === "string" ? o.status : "",
      });
    }
  }

  const completo = incompletas === 0;

  return {
    pedidos, erro: null, paginasLidas: paginas, recebidosDoProvider: recebidos,
    duplicadosDescartados: duplicados, foraDaJanelaFinanceira: fora,
    completo, truncado: !completo, subjanelasIncompletas: incompletas,
    janelaDeCriacao: janela,
  };
}

// ═══════════════════════════════════════════════════════════════════
// VENDAS BRUTAS — F7b.4.8.5
// ═══════════════════════════════════════════════════════════════════

/**
 * O codigo de cancelamento que o Mercado Livre usa quando ELE desfaz o
 * pedido e cria outro no lugar.
 *
 * MEDIDO na F7b.4.8.4: 134 pedidos de setembro trazem este codigo, nenhum
 * tem irmao vivo no mesmo `pack_id`, e NENHUM aparece no relatorio oficial
 * da loja. Contar os dois lados contaria a mesma venda duas vezes.
 *
 * A exclusao e so desta: cancelamento comercial — o comprador desistiu, o
 * envio falhou, houve mediacao — CONTINUA sendo venda bruta, porque e
 * assim que o relatorio oficial conta.
 */
export { CANCELAMENTO_DE_PACOTE_REFEITO };

export interface PedidoVendaBrutaML {
  readonly pedidoId: string;
  /** `AAAA-MM-DD` em America/Sao_Paulo — o dia do FECHAMENTO. */
  readonly diaFechamento: string;
  /** `order.total_amount`, como a API oficial devolveu. */
  readonly valor: number;
  /** Soma de `order_items[].quantity`. */
  readonly unidades: number;
  readonly status: string;
  readonly cancelCode: string | null;
  /**
   * Soma de `unit_price x quantity` — invariante de observabilidade.
   *
   * MEDIDO: igual a `total_amount` em 10.898 de 10.898 vendas de setembro.
   * Guardado para que uma divergencia futura APARECA em vez de trocar o
   * valor silenciosamente (§7).
   */
  readonly valorPorItens: number;
}

export interface ResultadoVendasBrutasML {
  readonly pedidos: readonly PedidoVendaBrutaML[];
  readonly erro: ErroVendasML | null;
  readonly paginasLidas: number;
  readonly recebidosDoProvider: number;
  readonly duplicadosDescartados: number;
  /** Veio pelo filtro mas o fechamento cai fora do periodo (borda). */
  readonly foraDoPeriodo: number;
  readonly excluidosPackSplitted: number;
  /** Pedidos em que `total_amount` discorda de `soma(unit_price x qtd)`. */
  readonly divergenciasDeValor: number;
  readonly completo: boolean;
  readonly truncado: boolean;
  readonly subjanelasIncompletas: number;
  readonly periodo: { readonly de: string; readonly ate: string; readonly fuso: string };
}

function falhaBruta(
  erro: ErroVendasML, de: string, ate: string
): ResultadoVendasBrutasML {
  return {
    pedidos: [], erro, paginasLidas: 0, recebidosDoProvider: 0,
    duplicadosDescartados: 0, foraDoPeriodo: 0, excluidosPackSplitted: 0,
    divergenciasDeValor: 0, completo: false, truncado: true,
    subjanelasIncompletas: 0,
    periodo: { de, ate, fuso: "America/Sao_Paulo" },
  };
}


/**
 * As VENDAS BRUTAS do periodo — a semantica provada no F7b.4.8.4.
 *
 * ── A regra, e de onde ela veio ─────────────────────────────────────
 *
 * Provada contra o relatorio detalhado que o dono baixou do proprio
 * Mercado Livre, pedido por pedido, para setembro de 2026:
 *
 *   data        `order.date_closed` em America/Sao_Paulo   10.898/10.898
 *   valor       `order.total_amount`                       10.898/10.898
 *   unidades    soma de `order_items[].quantity`           10.898/10.898
 *   populacao   igualdade de conjunto                      0 a mais, 0 a menos
 *
 * E o que ela NAO exige, porque o relatorio oficial tambem nao:
 *
 *   `order.status = paid`      nao exigido
 *   pagamento aprovado         nao exigido
 *   nao ter sido cancelado     nao exigido
 *   nao ter sido estornado     nao exigido
 *
 * Venda cancelada depois continua sendo venda do mes em que fechou — e
 * `paid_amount` dela e 0,00, que era exatamente como a regra antiga
 * perdia R$ 10 mil em setembro.
 *
 * ── Por que o filtro e por fechamento ──────────────────────────────
 *
 * MEDIDO: o atraso entre criacao e fechamento tem p50 de 17 segundos, mas
 * chega a 14 DIAS, e 6 pedidos de setembro passam de 5 dias, somando
 * R$ 212,02. Buscar por criacao com a margem do boleto perderia esses
 * seis. `order.date_closed` filtra de verdade e pagina igual (medido), e
 * assim nao ha margem nenhuma a adivinhar.
 *
 * O filtro ainda vaza pedido do dia seguinte na borda, entao quem recorta
 * e o dia em Sao Paulo, aqui dentro.
 */
export async function buscarVendasBrutasML(
  entrada: EntradaVendasML,
  limiteExterno?: LimiteExterno,
  portas?: PortasVendasML
): Promise<ResultadoVendasBrutasML> {
  const { userId, lojaId, de, ate } = entrada;

  if (!userId || !lojaId) return falhaBruta("credencial_ausente", "", "");
  if (!ehDataIso(de) || !ehDataIso(ate) || de > ate) {
    return falhaBruta("resposta_invalida", "", "");
  }

  // Um dia civil de Sao Paulo por subjanela. Sem margem: o filtro ja e
  // pelo campo que decide.
  const dias: string[] = [];
  for (let d = de; d <= ate; d = somarDiasNoCalendario(d, 1)) dias.push(d);

  const varredura = await varrerDias({
    userId, lojaId, campoDeData: CAMPO_DE_FECHAMENTO, dias, limiteExterno, portas,
  });
  if (varredura.erro !== null) return falhaBruta(varredura.erro, de, ate);

  const pedidos: PedidoVendaBrutaML[] = [];
  const vistos = new Set<string>();
  let recebidos = 0;
  let duplicados = 0;
  let fora = 0;
  let excluidos = 0;
  let divergencias = 0;
  let paginas = 0;
  let incompletas = 0;

  for (const sub of varredura.subjanelas) {
    paginas += sub.paginas;
    if (!sub.completa) incompletas += 1;
    recebidos += sub.brutos.length;

    for (const o of sub.brutos) {
      const id = String(o.id ?? "");
      if (id !== "" && vistos.has(id)) { duplicados += 1; continue; }
      if (id !== "") vistos.add(id);

      // ── O RECORTE: dia de FECHAMENTO em Sao Paulo ───────────────
      //
      // Convertido ANTES de comparar. Cortar o texto da data e comparar
      // depois foi o bug que levou dois gates para achar: um pedido de
      // 31/08 23h33 no offset -04:00 do provedor e venda de 01/09 aqui.
      const dia = diaEmSaoPaulo(o.date_closed);
      if (dia === null || dia < de || dia > ate) { fora += 1; continue; }

      // F8.2-B: o corte por horario, quando pedido, e o MESMO campo —
      // fechamento depois do instante fica de fora, contado como borda.
      if (entrada.ateInstanteMs !== undefined) {
        const fechadoEm = typeof o.date_closed === "string" ? Date.parse(o.date_closed) : NaN;
        if (!Number.isFinite(fechadoEm) || fechadoEm > entrada.ateInstanteMs) { fora += 1; continue; }
      }

      // Regra canonica UNICA (lib/vendas/canonico/ml.ts): o dia acima e o
      // `n.diaFechamento` saem da MESMA diaEmSaoPaulo(o.date_closed).
      const n = normalizarPedidoML(o);
      const cancelCode = n.cancelCode;
      if (cancelCode === CANCELAMENTO_DE_PACOTE_REFEITO) { excluidos += 1; continue; }

      // §7: divergencia NAO troca o valor — ela e contada, para aparecer.
      if (Math.abs(n.valor - n.valorPorItens) > 0.005) divergencias += 1;

      pedidos.push({
        pedidoId: id,
        diaFechamento: dia,
        valor: n.valor,
        unidades: n.unidades,
        status: n.status,
        cancelCode,
        valorPorItens: n.valorPorItens,
      });
    }
  }

  const completo = incompletas === 0;
  return {
    pedidos, erro: null, paginasLidas: paginas, recebidosDoProvider: recebidos,
    duplicadosDescartados: duplicados, foraDoPeriodo: fora,
    excluidosPackSplitted: excluidos, divergenciasDeValor: divergencias,
    completo, truncado: !completo, subjanelasIncompletas: incompletas,
    periodo: { de, ate, fuso: "America/Sao_Paulo" },
  };
}
