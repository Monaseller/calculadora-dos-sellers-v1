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
import {
  PERIODOS, resolverPeriodo, FUSO_CDS, type NomeDePeriodo,
} from "@/lib/agentes/funcoes/calendario";
import type { LimiteExterno } from "@/lib/controle-tempo";

/**
 * O que o modelo pode mandar. Tres campos, e nenhum a mais.
 *
 * NAO existe, e nao pode passar a existir: `lojaId`, `sellerId`,
 * `userId`, `token`, `seller`, `status` livre nem `url`. A loja vem do
 * binding que o guard autorizou; o resto nao e assunto de quem pergunta.
 */
export interface FiltroVendasML {
  readonly periodo?: NomeDePeriodo;
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
  readonly totais: TotaisVendasML;
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
  readonly truncado: boolean;
  readonly diagnostico: {
    readonly paginasLidas: number;
    readonly recebidosDoProvider: number;
    readonly foraDaJanelaFinanceira: number;
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
    if (typeof f.periodo !== "string" ||
        !(PERIODOS as readonly string[]).includes(f.periodo)) {
      return { erro: "periodo_invalido" };
    }
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
    totais: VAZIO, porDia: [], periodo, fonte: "mercadolivre_api", truncado: false,
    diagnostico: {
      paginasLidas: 0, recebidosDoProvider: 0, foraDaJanelaFinanceira: 0,
      margemDeCriacaoDias: MARGEM_CRIACAO_DIAS,
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

    // ── §23: a CDS resolve, e o rotulo acompanha ──────────────────
    const janela = filtro.periodo !== undefined
      ? (() => {
          const p = resolverPeriodo(filtro.periodo as NomeDePeriodo, agoraMs);
          return { de: p.inicio, ate: p.fim, rotulo: p.rotulo, fuso: p.fuso };
        })()
      : {
          de: filtro.de as string, ate: filtro.ate as string,
          rotulo: `${filtro.de} a ${filtro.ate}`, fuso: FUSO_CDS,
        };

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
      truncado: bruto.truncado,
      diagnostico: {
        paginasLidas: bruto.paginasLidas,
        recebidosDoProvider: bruto.recebidosDoProvider,
        foraDaJanelaFinanceira: bruto.foraDaJanelaFinanceira,
        margemDeCriacaoDias: MARGEM_CRIACAO_DIAS,
      },
      erro: null,
    };
  };
}
