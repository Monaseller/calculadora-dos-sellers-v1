/**
 * P1 (estabilizacao) — controle das consultas do Dashboard a /api/vendas/resumo-canonico (puro, sem I/O; a pagina
 * importa daqui e injeta `executar`, `aplicar` e o relogio).
 *
 *   debounce    cada mudanca de periodo/lojas so vale depois de `debounceMs` sem nova mudanca: alternar filtros
 *               rapido gera UMA consulta, com a ultima selecao.
 *   um em voo   no maximo UMA consulta no servidor por vez. Cancelar o fetch no navegador nao para a funcao no
 *               servidor (ela continua lendo o banco), entao uma selecao nova NAO dispara outra em paralelo: ela
 *               espera a atual terminar e roda em seguida.
 *   a ultima    a selecao mais recente SEMPRE e consultada (nunca descartada por haver uma em andamento); as
 *               intermediarias que o usuario ja abandonou nao sao consultadas.
 *   descarte    a resposta so e aplicada se a sua chave ainda e a desejada; resposta antiga nunca sobrescreve a atual.
 *   dedupe      a mesma chave ja em voo ou ja exibida nao reconsulta; `tentarDeNovo` sempre abre uma consulta nova.
 */

export interface ResultadoConsultaCanonica<T> {
  ok: boolean;
  /** Corpo da resposta (so com ok). */
  dados: T | null;
}

export interface OpcoesFilaConsulta<T> {
  debounceMs: number;
  /** Faz a requisicao da chave (nunca lanca: falha volta como ok=false). */
  executar: (chave: string) => Promise<ResultadoConsultaCanonica<T>>;
  /** Resultado da chave DESEJADA (nunca de uma chave antiga). */
  aplicar: (chave: string, r: ResultadoConsultaCanonica<T>) => void;
  /** Ha (ou nao) consulta da chave desejada pendente — para o "carregando". */
  ocupado?: (carregando: boolean) => void;
  agendar: (fn: () => void, ms: number) => unknown;
  cancelar: (h: unknown) => void;
}

export interface FilaConsulta {
  /** Nova selecao (aplica debounce). */
  pedir(chave: string): void;
  /** Reconsulta a chave desejada agora, mesmo ja exibida (botao "Tentar novamente"). */
  tentarDeNovo(): void;
  /** Pagina desmontada: nada mais e aplicado. */
  encerrar(): void;
}

export function criarFilaConsulta<T>(o: OpcoesFilaConsulta<T>): FilaConsulta {
  let desejada: string | null = null;
  let exibida: string | null = null;
  let emVoo: string | null = null;
  let forcar = false;
  let timer: unknown = null;
  let encerrada = false;

  const disparar = () => {
    if (encerrada || desejada === null) return;
    if (emVoo !== null) return;                                   // espera a atual; ao terminar, a desejada roda
    if (desejada === exibida && !forcar) { o.ocupado?.(false); return; }
    const chave = desejada;
    emVoo = chave; forcar = false;
    o.ocupado?.(true);
    o.executar(chave).then(
      (r) => r,
      (): ResultadoConsultaCanonica<T> => ({ ok: false, dados: null }),
    ).then((r) => {
      emVoo = null;
      if (encerrada) return;
      if (chave === desejada) {                                   // so a resposta da selecao atual entra na tela
        exibida = chave;
        o.aplicar(chave, r);
        o.ocupado?.(false);
      }
      disparar();                                                 // a selecao mudou durante o voo: consulta a ultima
    });
  };

  return {
    pedir(chave) {
      if (encerrada) return;
      desejada = chave;
      if (timer !== null) o.cancelar(timer);
      if (chave !== exibida || emVoo !== null) o.ocupado?.(true);
      timer = o.agendar(() => { timer = null; disparar(); }, o.debounceMs);
    },
    tentarDeNovo() {
      if (encerrada || desejada === null) return;
      forcar = true;
      disparar();
    },
    encerrar() {
      encerrada = true;
      if (timer !== null) o.cancelar(timer);
      timer = null;
    },
  };
}

/** Chave da consulta: exatamente os parametros enviados a rota (mesma selecao = mesma chave). */
export const chaveConsultaCanonica = (q: URLSearchParams): string => q.toString();
