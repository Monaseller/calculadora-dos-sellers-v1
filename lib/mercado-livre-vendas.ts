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
import type { LimiteExterno } from "@/lib/controle-tempo";

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
  | "resposta_invalida";

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
 * Teto de paginas por consulta.
 *
 * 60 paginas x 51 = 3060 pedidos. Nao e arbitrario: a janela de uma
 * semana da loja medida tem ~3000 pedidos pagos, e esse e o tamanho de
 * pergunta que este gate existe para responder.
 *
 * Estourar o teto NAO vira silencio: `truncado` sobe `true`, e a Funcao
 * diz que olhou uma parte. Um total parcial apresentado como total seria
 * o pior desfecho possivel aqui.
 */
export const MAX_PAGINAS = 60;

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
  /** Quantas paginas a consulta chegou a ler. */
  readonly paginasLidas: number;
  /** Quantos pedidos a API devolveu, ANTES do recorte financeiro. */
  readonly recebidosDoProvider: number;
  /** Quantos cairam por nao ter pagamento aprovado na janela. */
  readonly foraDaJanelaFinanceira: number;
  /** `true` quando o teto de paginas interrompeu a leitura. */
  readonly truncado: boolean;
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
    foraDaJanelaFinanceira: 0, truncado: false, janelaDeCriacao: janela,
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
 * O pagamento que conta.
 *
 * `approved` e `partially_refunded` — exatamente o critério de
 * `sync-ml.ts`. Um pedido estornado em parte foi pago; a venda aconteceu
 * financeiramente, e `BUSINESS_RULES.md` e explicito de que a data
 * permanece.
 */
function pagamentoQueConta(pedido: Record<string, unknown>): string | null {
  const pagamentos = pedido.payments;
  if (!Array.isArray(pagamentos)) return null;
  for (const p of pagamentos) {
    if (typeof p !== "object" || p === null) continue;
    const pg = p as Record<string, unknown>;
    if (pg.status !== "approved" && pg.status !== "partially_refunded") continue;
    if (typeof pg.date_approved !== "string" || pg.date_approved === "") continue;
    return pg.date_approved;
  }
  return null;
}

/** Somente `number` finito. Nunca `Number(...)`, nunca `+`. */
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

  const resolver = portas?.resolverCredencial ?? getMLLojaById;
  const buscar = portas?.buscar ?? fetch;

  let credencial: Awaited<ReturnType<typeof getMLLojaById>>;
  try {
    credencial = await resolver(lojaId, userId, limiteExterno);
  } catch {
    return falha("indisponivel", janela);
  }
  if (credencial === null || !credencial.accessToken || !credencial.sellerId) {
    return falha("credencial_ausente", janela);
  }

  const pedidos: PedidoOficialML[] = [];
  let recebidos = 0;
  let fora = 0;
  let paginas = 0;
  let truncado = false;

  for (let offset = 0; ; offset += LIMITE_POR_PAGINA) {
    if (paginas >= MAX_PAGINAS) { truncado = true; break; }

    const url = new URL(ENDPOINT);
    url.searchParams.set("seller", credencial.sellerId);
    url.searchParams.set("order.status", "paid");
    // Fim do dia no fuso de Sao Paulo: `ate` e INCLUSIVO, e cortar a
    // meia-noite perderia o dia inteiro que a pessoa pediu.
    url.searchParams.set("order.date_created.from", `${criacaoDe}T00:00:00.000-03:00`);
    url.searchParams.set("order.date_created.to", `${ate}T23:59:59.999-03:00`);
    url.searchParams.set("sort", "date_asc");
    url.searchParams.set("limit", String(LIMITE_POR_PAGINA));
    url.searchParams.set("offset", String(offset));

    const teto = limiteExterno === undefined
      ? TIMEOUT_MS
      : Math.min(TIMEOUT_MS, limiteExterno.restanteMs());
    // Orcamento esgotado no meio da paginacao NAO e falha: o que ja foi
    // lido vale, e `truncado` diz que falta. Descartar tudo desperdicaria
    // trabalho real e daria uma resposta pior.
    if (teto <= 0) { truncado = true; break; }

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
      // Primeira pagina falhou: nao ha nada, e a falha e a resposta.
      // Falhou no meio: o que ja veio continua valendo, truncado.
      if (paginas === 0) return falha("indisponivel", janela);
      truncado = true;
      break;
    } finally {
      clearTimeout(relogio);
      doOrcamento?.removeEventListener("abort", propagar);
    }

    if (!resposta.ok) {
      if (paginas === 0) return falha(codigoDoStatus(resposta.status), janela);
      truncado = true;
      break;
    }

    let corpo: unknown;
    try { corpo = await resposta.json(); } catch {
      if (paginas === 0) return falha("resposta_invalida", janela);
      truncado = true;
      break;
    }
    if (typeof corpo !== "object" || corpo === null) {
      if (paginas === 0) return falha("resposta_invalida", janela);
      truncado = true;
      break;
    }
    const resultados = (corpo as Record<string, unknown>).results;
    if (!Array.isArray(resultados)) {
      if (paginas === 0) return falha("resposta_invalida", janela);
      truncado = true;
      break;
    }

    paginas += 1;
    recebidos += resultados.length;

    for (const bruto of resultados) {
      if (typeof bruto !== "object" || bruto === null) { fora += 1; continue; }
      const o = bruto as Record<string, unknown>;
      const aprovado = pagamentoQueConta(o);
      if (aprovado === null) { fora += 1; continue; }
      const dia = diaBRT(aprovado);
      // ── O RECORTE FINANCEIRO ───────────────────────────────────────
      // A janela de criacao e mais larga de proposito. Pedido pago fora
      // do periodo pedido nao e venda do periodo, e entra aqui so para
      // ser descartado — e contado, para a Funcao poder explicar.
      if (dia === null || dia < de || dia > ate) { fora += 1; continue; }

      pedidos.push({
        pedidoId: String(o.id ?? ""),
        dataPagamento: dia,
        valorPago: numeroOuZero(o.paid_amount),
        status: typeof o.status === "string" ? o.status : "",
      });
    }

    if (resultados.length < LIMITE_POR_PAGINA) break;
  }

  return {
    pedidos, erro: null, paginasLidas: paginas, recebidosDoProvider: recebidos,
    foraDaJanelaFinanceira: fora, truncado, janelaDeCriacao: janela,
  };
}
