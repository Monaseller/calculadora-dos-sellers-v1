/**
 * Dominio das vendas OFICIAIS do Mercado Livre — F7b.4.8 Parte D.
 *
 * ── A fronteira que este arquivo e ──────────────────────────────────
 *
 *   filtro do modelo  ->  validado aqui  ->  periodo resolvido pela CDS
 *                                            |
 *                                            v
 *                                   adapter oficial (API do ML)
 *                                            |
 *                                            v
 *                                   agregacao DETERMINISTICA
 *
 * ── §23: quem resolve o periodo e a CDS ────────────────────────────
 *
 * O modelo manda um NOME de periodo — `esta_semana` —, nunca duas datas
 * que ele calculou. `resolverPeriodo` de `funcoes/calendario.ts` e a
 * unica autoridade: fuso de Sao Paulo, semana comecando na segunda, fim
 * inclusivo. Deixar o modelo mandar `de`/`ate` livres significaria
 * aceitar "esta semana" como qualquer coisa que ele achasse que era.
 *
 * Datas explicitas SAO aceitas — mas como intervalo declarado pelo dono
 * em `AAAA-MM-DD`, validado aqui, e nunca como interpretacao de uma
 * palavra. As duas formas sao exclusivas.
 *
 * ── §25: o numero nao vem do modelo ────────────────────────────────
 *
 * Faturamento, contagem e ticket medio sao somados aqui, sobre o retorno
 * oficial. `CLAUDE.md` e explicito: IA nao e autoridade matematica. O
 * modelo recebe o resultado pronto e o explica.
 */
import "server-only";
import {
  buscarVendasPagasML,
  MARGEM_CRIACAO_DIAS,
  type ErroVendasML,
  type PortasVendasML,
} from "@/lib/mercado-livre-vendas";
import { FUSO_CDS } from "@/lib/agentes/funcoes/calendario";
import { resolverExpressaoDePeriodo } from "@/lib/agentes/funcoes/periodo-em-texto";
import type { LimiteExterno } from "@/lib/controle-tempo";

/**
 * O que o modelo pode mandar. Tres campos, e nenhum a mais.
 *
 * NAO existe, e nao pode passar a existir: `lojaId`, `sellerId`,
 * `userId`, `token`, `seller`, `status` livre nem `url`. A loja vem do
 * binding que o guard autorizou; o resto nao e assunto de quem pergunta.
 */
export interface FiltroVendasML {
  /**
   * O periodo em PALAVRAS — F7b.4.8.3 §13.
   *
   * "esta semana", "ultimos 7 dias", "agosto de 2026", "de 10/09/2026 ate
   * 20/09/2026", "no dia 15/08/2026". Quem transforma isso em datas e
   * `periodo-em-texto.ts`, deterministicamente.
   *
   * Era um enum de sete valores, e o enum nao cobria data antiga nem
   * intervalo livre — o modelo nao tinha como expressar "agosto de 2026" e
   * a pergunta morria. Texto NAO afrouxa nada: o resolvedor recusa o que
   * nao entende, e a recusa e corrigivel.
   */
  readonly periodo?: string;
  /**
   * O par de datas, para quem NAO e modelo.
   *
   * Fica no contrato porque o dono pode escolher um intervalo numa tela, e
   * ali nao ha texto a interpretar. O modelo nao o recebe: a declaracao de
   * ferramenta publica so `periodo` (F7b.4.8.2 §5).
   */
  readonly de?: string;
  readonly ate?: string;
}

export interface TotaisVendasML {
  /** Soma de `paid_amount` dos pedidos pagos no periodo. */
  readonly faturamento: number;
  readonly pedidos: number;
  readonly ticketMedio: number;
}

export interface ResultadoVendasML {
  /**
   * `null` quando a varredura NAO completou — F7b.4.8.3 §11/§21.
   *
   * ── Por que ausente, e nao "parcial" ──────────────────────────────
   *
   * O Rodrigo recebeu uma comparacao percentual entre uma semana completa
   * e uma truncada, apresentada como conclusao. O erro nao foi o modelo
   * ter comparado: foi ele ter recebido dois numeros que pareciam
   * comparaveis.
   *
   * Sem total, nao ha o que comparar. O que sobra e `parcial`, que diz o
   * tamanho do que faltou — e a unica resposta possivel passa a ser "nao
   * consegui recuperar tudo".
   */
  readonly totais: TotaisVendasML | null;
  /** Um item por DIA com venda, em ordem crescente. */
  readonly porDia: readonly { readonly dia: string; readonly faturamento: number; readonly pedidos: number }[];
  /** O periodo que a CDS resolveu, para a resposta poder cita-lo. */
  readonly periodo: { readonly de: string; readonly ate: string; readonly rotulo: string; readonly fuso: string };
  /**
   * De onde os numeros vieram — §27.
   *
   * Um literal, e nao um booleano: `fonte: true` nao diria o que e
   * verdade. Quem le a saida consegue afirmar a procedencia sem
   * adivinhar, e a suite consegue reprovar uma troca de fonte.
   */
  readonly fonte: "mercadolivre_api";
  /**
   * `true` quando TODAS as subjanelas foram lidas ate o fim — §11.
   *
   * E ele, e nao `truncado`, que autoriza um total fechado.
   */
  readonly completo: boolean;
  /** Negacao de `completo`. Mantido para quem ja o consumia. */
  readonly truncado: boolean;
  /** O que se sabe sobre a falta, quando `completo` e `false`. */
  readonly parcial: {
    readonly pedidosLidos: number;
    readonly subjanelasIncompletas: number;
  } | null;
  readonly diagnostico: {
    readonly paginasLidas: number;
    readonly recebidosDoProvider: number;
    readonly foraDaJanelaFinanceira: number;
    readonly duplicadosDescartados: number;
    readonly margemDeCriacaoDias: number;
  };
  readonly erro: ErroVendasML | null;
}

export type LerVendasML = (filtro: FiltroVendasML) => Promise<ResultadoVendasML>;

export interface ValidacaoFiltroVendasML {
  readonly erro: string | null;
}

/** Duas casas. Soma de float acumula residuo; o corte e no fim. */
function centavos(valor: number): number {
  return Math.round(valor * 100) / 100;
}

function ehDataIso(v: unknown): v is string {
  return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
}

/**
 * O filtro e valido?
 *
 * Exatamente UMA das duas formas: um nome de periodo, ou o par de datas.
 * Aceitar as duas juntas obrigaria a escolher qual vence, e a escolha
 * seria invisivel para quem perguntou.
 */
export function validarFiltroVendasML(filtro: unknown): ValidacaoFiltroVendasML {
  if (typeof filtro !== "object" || filtro === null) return { erro: "filtro_ausente" };
  const f = filtro as Record<string, unknown>;

  // Chave desconhecida e RECUSA, e nao campo ignorado: um `lojaId` que
  // passasse calado daria a impressao de ter sido respeitado.
  for (const chave of Object.keys(f)) {
    if (chave !== "periodo" && chave !== "de" && chave !== "ate") {
      return { erro: "campo_desconhecido" };
    }
  }

  const temPeriodo = f.periodo !== undefined;
  const temDatas = f.de !== undefined || f.ate !== undefined;

  if (temPeriodo && temDatas) return { erro: "filtro_ambiguo" };
  if (!temPeriodo && !temDatas) return { erro: "filtro_ausente" };

  if (temPeriodo) {
    if (typeof f.periodo !== "string" || f.periodo.trim() === "") {
      return { erro: "periodo_invalido" };
    }
    // A forma e conferida aqui; o VALOR depende do relogio, e por isso a
    // resolucao acontece na leitura. Um texto que o resolvedor nao
    // entender volta como `periodo_invalido` de la — que e corrigivel, e o
    // modelo tenta com outras palavras.
    return { erro: null };
  }

  if (!ehDataIso(f.de) || !ehDataIso(f.ate)) return { erro: "data_invalida" };
  if (f.de > f.ate) return { erro: "periodo_invertido" };
  return { erro: null };
}

const VAZIO: TotaisVendasML = Object.freeze({
  faturamento: 0, pedidos: 0, ticketMedio: 0,
});

function comErro(
  erro: ErroVendasML,
  periodo: ResultadoVendasML["periodo"]
): ResultadoVendasML {
  return {
    // Erro NAO tem total. Zero apresentado como total seria a resposta
    // errada com cara de resposta.
    totais: null, porDia: [], periodo, fonte: "mercadolivre_api",
    completo: false, truncado: true, parcial: null,
    diagnostico: {
      paginasLidas: 0, recebidosDoProvider: 0, foraDaJanelaFinanceira: 0,
      duplicadosDescartados: 0, margemDeCriacaoDias: MARGEM_CRIACAO_DIAS,
    },
    erro,
  };
}

/**
 * A leitura pronta para a Funcao.
 *
 * `agoraMs` ENTRA por parametro: "esta semana" depende do relogio, e uma
 * funcao que le o relogio por dentro nao pode ser testada em duas datas.
 * Mesma decisao de `conexoes/estado.ts`.
 */
export function criarLeiturasDeVendasML(
  userId: string,
  lojaId: string,
  agoraMs: number,
  limiteExterno?: LimiteExterno,
  portas?: PortasVendasML
): LerVendasML {
  return async (filtro: FiltroVendasML): Promise<ResultadoVendasML> => {
    const validacao = validarFiltroVendasML(filtro);

    // Periodo provisorio para poder RESPONDER com erro sem mentir sobre
    // qual janela foi usada: nenhuma foi.
    const semJanela = { de: "", ate: "", rotulo: "", fuso: FUSO_CDS };
    if (validacao.erro !== null) return comErro("resposta_invalida", semJanela);

    // ── A CDS resolve, e o rotulo acompanha — §13 ─────────────────
    //
    // O texto vem do modelo; as DATAS vem daqui. Se o resolvedor nao
    // entender a expressao, a resposta e `periodo_invalido` — corrigivel,
    // entao o modelo tenta com outras palavras em vez de o turno morrer.
    let janela: ResultadoVendasML["periodo"];
    if (filtro.periodo !== undefined) {
      const p = resolverExpressaoDePeriodo(filtro.periodo, agoraMs);
      if (p === null) return comErro("periodo_nao_entendido", semJanela);
      janela = { de: p.de, ate: p.ate, rotulo: p.rotulo, fuso: p.fuso };
    } else {
      janela = {
        de: filtro.de as string, ate: filtro.ate as string,
        rotulo: `${filtro.de} a ${filtro.ate}`, fuso: FUSO_CDS,
      };
    }

    const bruto = await buscarVendasPagasML(
      { userId, lojaId, de: janela.de, ate: janela.ate }, limiteExterno, portas);

    if (bruto.erro !== null) return comErro(bruto.erro, janela);

    // ── A conta, em cima do retorno OFICIAL ───────────────────────
    let faturamento = 0;
    const porDia = new Map<string, { faturamento: number; pedidos: number }>();
    for (const p of bruto.pedidos) {
      faturamento += p.valorPago;
      const atual = porDia.get(p.dataPagamento) ?? { faturamento: 0, pedidos: 0 };
      atual.faturamento += p.valorPago;
      atual.pedidos += 1;
      porDia.set(p.dataPagamento, atual);
    }

    const pedidos = bruto.pedidos.length;
    const faturamentoFinal = centavos(faturamento);

    const diagnostico = {
      paginasLidas: bruto.paginasLidas,
      recebidosDoProvider: bruto.recebidosDoProvider,
      foraDaJanelaFinanceira: bruto.foraDaJanelaFinanceira,
      duplicadosDescartados: bruto.duplicadosDescartados,
      margemDeCriacaoDias: MARGEM_CRIACAO_DIAS,
    };

    // ── §11/§21: varredura incompleta NAO produz total ────────────
    //
    // O Rodrigo recebeu -55,00% entre uma semana completa e uma truncada.
    // O modelo nao errou a conta: ele recebeu dois numeros que pareciam
    // comparaveis. Sem total, nao ha o que comparar — e a unica resposta
    // possivel passa a ser "nao consegui recuperar tudo".
    //
    // `porDia` sai junto: um recorte diario de um conjunto incompleto
    // tambem e parcial, e seria lido como se fosse o dia inteiro.
    if (!bruto.completo) {
      return {
        totais: null,
        porDia: [],
        periodo: janela,
        fonte: "mercadolivre_api",
        completo: false,
        truncado: true,
        parcial: {
          pedidosLidos: pedidos,
          subjanelasIncompletas: bruto.subjanelasIncompletas,
        },
        diagnostico,
        erro: null,
      };
    }

    return {
      totais: {
        faturamento: faturamentoFinal,
        pedidos,
        // Divisao por zero nao vira `NaN` nem `Infinity`: sem pedido nao
        // existe ticket, e zero e a unica resposta que nao inventa um.
        ticketMedio: pedidos > 0 ? centavos(faturamento / pedidos) : 0,
      },
      porDia: [...porDia.entries()]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([dia, v]) => ({
          dia, faturamento: centavos(v.faturamento), pedidos: v.pedidos,
        })),
      periodo: janela,
      fonte: "mercadolivre_api",
      completo: true,
      truncado: false,
      parcial: null,
      diagnostico,
      erro: null,
    };
  };
}
