/**
 * Vendas A3.4 (P1) — controle das consultas do Mercado Livre na tela de Vendas (puro, sem I/O; a página importa daqui).
 *
 *   chave      a consulta é identificada por loja + período (+ visão, na tabela). Filtro LOCAL (status, cadastro, SKU)
 *              não muda a chave: as linhas já carregadas são filtradas na tela, sem nova consulta ao provider.
 *   geração    cada consulta NOVA ganha uma geração; a resposta só é aplicada se a sua (chave, geração) ainda é a
 *              vigente. Resposta antiga — outra loja, outro período, outra visão, ou "Carregar mais" de uma consulta
 *              que já foi substituída — é descartada sem tocar em linhas, métricas, loading ou erro.
 *   dedupe     a mesma chave já em voo/carregada não reconsulta (ex.: data trocada dispara a leitura uma vez);
 *              `forcar` (Sincronizar, Tentar de novo) sempre abre uma consulta nova.
 *   resposta   SEM_CONTA (o dono não tem conta ML) não é erro de provider: a seção ML some. RECUSA_LOJA (409/404 de
 *              loja) segue a regra A5. FALHA = erro verdadeiro de conta conectada — continua visível.
 */

export interface BilheteConsultaML {
  chave: string;
  geracao: number;
  /** A chave mudou em relação à consulta anterior (os dados exibidos são de OUTRA consulta e devem sair). */
  novaChave: boolean;
}

export interface ControleConsultasML {
  /** Abre uma consulta nova; null = a mesma chave já está em voo ou carregada (e não foi pedido `forcar`). */
  iniciar(chave: string, forcar?: boolean): BilheteConsultaML | null;
  /** Bilhete da consulta vigente — para continuar a MESMA consulta ("Carregar mais"). */
  vigenteAgora(): BilheteConsultaML;
  /** A resposta deste bilhete ainda pode ser aplicada? */
  vigente(b: BilheteConsultaML): boolean;
  /** Nada pendente vale mais (troca/recusa de loja): a próxima consulta é sempre nova. */
  invalidar(): void;
}

export function criarControleConsultasML(): ControleConsultasML {
  let chave = "", geracao = 0;
  return {
    iniciar(nova, forcar = false) {
      if (!forcar && geracao > 0 && nova === chave) return null;
      const novaChave = nova !== chave;
      chave = nova; geracao += 1;
      return { chave, geracao, novaChave };
    },
    vigenteAgora() { return { chave, geracao, novaChave: false }; },
    vigente(b) { return b.chave === chave && b.geracao === geracao; },
    invalidar() { chave = ""; geracao += 1; },
  };
}

export const chaveMetricasML = (loja: string | null, de: string, ate: string) => `${loja ?? "-"}|${de}|${ate}`;
export const chaveTabelaML = (loja: string | null, de: string, ate: string, visao: "fechamento" | "pago") => `${chaveMetricasML(loja, de, ate)}|${visao}`;

export type RespostaML = "OK" | "SEM_CONTA" | "RECUSA_LOJA" | "FALHA";

/** Classifica a resposta de uma rota ML da tela (`valida` = o corpo tem o formato de sucesso daquela rota). */
export function classificarRespostaML(ok: boolean, corpo: any, valida: (c: any) => boolean): RespostaML {
  if (corpo?.codigo === "ML_STORE_SELECTION_REQUIRED" || corpo?.codigo === "LOJA_ML_INVALIDA") return "RECUSA_LOJA";
  if (corpo?.semConexao === true) return "SEM_CONTA";
  return ok && corpo && valida(corpo) ? "OK" : "FALHA";
}
