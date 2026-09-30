/**
 * `mercadolivre.vendas.consultar` — executor, validador e interpretador.
 *
 * ── Por que ela existe ao lado de `vendas.consultar` ────────────────
 *
 * `vendas.consultar` le a tabela `pedidos` da CDS. Esta le a CONTA do
 * dono no Mercado Livre, pela API oficial.
 *
 * As duas ficam, e nao e indecisao: uma responde "o que a CDS registrou"
 * e a outra "o que o Mercado Livre diz". Quando as duas discordam, a
 * diferenca e informacao — e colapsa-las numa so apagaria justamente
 * isso. `vendas.consultar` NAO foi alterada: contrato congelado nao se
 * mexe para arrumar a casa.
 *
 * ── Este modulo nunca ve credencial ────────────────────────────────
 *
 * Recebe `ContextoFuncao`: `userId` e o binding sanitizado. Quem resolve
 * token e `seller_id` e `lib/mercado-livre-vendas.ts`, atras do dominio.
 * Aqui nao ha `fetch`, nao ha Supabase e nao ha `Authorization`.
 */
import "server-only";
import {
  criarLeiturasDeVendasML,
  validarFiltroVendasML,
  type FiltroVendasML,
  type ResultadoVendasML,
} from "@/lib/agentes/dados/vendas-ml";
import type {
  ContextoFuncao,
  ResultadoInterpretacaoSaida,
  ResultadoValidacaoEntrada,
} from "@/lib/agentes/funcoes/registry";

/** O requisito de conexao desta Funcao, na forma que o guard consome. */
export const CONEXAO_VENDAS_ML = Object.freeze({
  plataforma: "mercado_livre",
  recurso: "vendas",
});

/**
 * O executor.
 *
 * ── A loja vem do CONTEXTO, e de nenhum outro lugar — §22 ──────────
 *
 * `contexto.conexao.lojaId` e o binding que o agregador validou e que o
 * guard autorizou. `validarFiltroVendasML` RECUSA campo desconhecido,
 * entao nao existe um `args.lojaId` para alguem preferir — e recusar,
 * em vez de ignorar, e o que impede um `lojaId` de passar calado dando
 * a impressao de ter sido respeitado.
 *
 * ── O relogio entra AQUI ───────────────────────────────────────────
 *
 * `Date.now()` na fronteira do executor, como `executarCalendario` ja
 * faz. O dominio recebe `agoraMs` por parametro para continuar testavel
 * em qualquer data — "esta semana" e exatamente uma pergunta sobre
 * quando se pergunta.
 */
export async function executarVendasML(
  contexto: ContextoFuncao,
  argumentos: unknown
): Promise<ResultadoVendasML> {
  const conexao = contexto.conexao;

  if (
    conexao === null ||
    conexao.plataforma !== CONEXAO_VENDAS_ML.plataforma ||
    conexao.recurso !== CONEXAO_VENDAS_ML.recurso ||
    !conexao.lojaId
  ) {
    // Mesma forma de saida do caminho de sucesso, com `erro` preenchido:
    // `interpretarSaida` precisa reconhecer o objeto para poder traduzir.
    return {
      totais: { faturamento: 0, pedidos: 0, ticketMedio: 0 },
      porDia: [],
      periodo: { de: "", ate: "", rotulo: "", fuso: "America/Sao_Paulo" },
      fonte: "mercadolivre_api",
      truncado: false,
      diagnostico: {
        paginasLidas: 0, recebidosDoProvider: 0,
        foraDaJanelaFinanceira: 0, margemDeCriacaoDias: 0,
      },
      erro: "credencial_ausente",
    };
  }

  const ler = criarLeiturasDeVendasML(
    contexto.userId, conexao.lojaId, Date.now(),
    contexto.limiteDoProvider);
  // O cast satisfaz a assinatura; a VALIDACAO acontece dentro, e
  // `validarFiltroVendasML` recusa nao-objeto antes de tocar campo.
  return ler(argumentos as FiltroVendasML);
}

/** Delegacao pura: `validarFiltroVendasML` e a unica autoridade. */
export function validarEntradaVendasML(argumentos: unknown): ResultadoValidacaoEntrada {
  const validacao = validarFiltroVendasML(argumentos);
  return validacao.erro === null ? { valida: true } : { valida: false, codigo: validacao.erro };
}

/**
 * As mensagens que o DONO le.
 *
 * Nenhuma deriva de texto do provider: `resposta.text()` nunca sobe,
 * `error.message` nunca sobe, status HTTP nao aparece.
 */
const MENSAGENS_ERRO: Readonly<Record<string, string>> = Object.freeze({
  credencial_ausente:
    "Não há conta do Mercado Livre ligada a este agente para consultar vendas.",
  nao_autorizado: "A conta do Mercado Livre precisa ser reconectada.",
  limite_excedido: "O Mercado Livre limitou as consultas agora. Tente mais tarde.",
  indisponivel: "Não foi possível falar com o Mercado Livre agora.",
  resposta_invalida: "O Mercado Livre respondeu num formato que não reconhecemos.",
});

const MENSAGEM_GENERICA = "Não foi possível consultar as vendas do Mercado Livre.";

/**
 * Codigos em que REPETIR pode dar outro resultado.
 *
 * Reconectar conta e acesso recusado nao mudam sozinhos; rede, limite e
 * 5xx, sim. Isto NAO pede retry — nao existe retry neste sistema.
 */
const REPETIVEIS: ReadonlySet<string> = new Set(["limite_excedido", "indisponivel"]);

/**
 * `interpretarSaida` — checagem de runtime de verdade.
 *
 * Um cast seria apagado na compilacao: `null`, `{}` e `[]` passariam e
 * virariam "sucesso". A forma minima e conferida campo a campo.
 *
 * `fonte` e conferida contra o literal: e ela que sustenta a afirmacao
 * de procedencia do §27. Uma saida que diga outra coisa — ou que nao
 * diga nada — e `invalida`, e nao um sucesso de origem desconhecida.
 */
export function interpretarSaidaVendasML(saida: unknown): ResultadoInterpretacaoSaida {
  if (typeof saida !== "object" || saida === null) return { tipo: "invalida" };
  const proto = Object.getPrototypeOf(saida);
  if (proto !== Object.prototype && proto !== null) return { tipo: "invalida" };

  const bruto = saida as Record<string, unknown>;
  if (bruto.fonte !== "mercadolivre_api") return { tipo: "invalida" };
  if (typeof bruto.truncado !== "boolean") return { tipo: "invalida" };
  if (!Array.isArray(bruto.porDia)) return { tipo: "invalida" };

  const totais = bruto.totais;
  if (typeof totais !== "object" || totais === null) return { tipo: "invalida" };
  const t = totais as Record<string, unknown>;
  const numero = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) ? v : null;
  if (numero(t.faturamento) === null || numero(t.ticketMedio) === null) {
    return { tipo: "invalida" };
  }
  if (typeof t.pedidos !== "number" || !Number.isInteger(t.pedidos) || t.pedidos < 0) {
    return { tipo: "invalida" };
  }

  const periodo = bruto.periodo;
  if (typeof periodo !== "object" || periodo === null) return { tipo: "invalida" };

  const erro = bruto.erro;
  if (erro === null) {
    return {
      tipo: "sucesso",
      data: {
        totais: bruto.totais,
        porDia: bruto.porDia,
        periodo: bruto.periodo,
        // §27: a procedencia atravessa. Sem ela o agente teria os numeros
        // e nao saberia dizer de onde vieram.
        fonte: bruto.fonte,
        // `truncado` atravessa: silencia-lo entregaria um total parcial
        // com cara de total.
        truncado: bruto.truncado,
        diagnostico: bruto.diagnostico,
      },
    };
  }

  if (typeof erro !== "string" || erro.trim().length === 0) return { tipo: "invalida" };

  return {
    tipo: "erro",
    codigo: erro,
    mensagem: MENSAGENS_ERRO[erro] ?? MENSAGEM_GENERICA,
    retryable: REPETIVEIS.has(erro),
  };
}
