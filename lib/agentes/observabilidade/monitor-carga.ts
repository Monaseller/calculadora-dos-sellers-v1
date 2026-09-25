/**
 * OBS-5 — a forma dos dados que o vigia carrega. Pura.
 *
 * A porta faz SQL; este modulo decide o que cada linha significa. A
 * separacao permite testar a parte que erra — leitura de linha torta,
 * chave irreconhecivel, resumo fora do vocabulario — sem banco nenhum.
 *
 * ── A PROVENIENCIA NAO PODE SER SO DO AGENDADOR ─────────────────────
 *
 * O OBS-3 R1 existe porque uma execucao `diag-*` atravessa a MESMA rota
 * e move o MESMO cursor global. Se a carga trouxesse apenas as chaves
 * `n8n:w5m-*`, o detector veria um cursor que andou sem escritor alheio
 * e afirmaria progresso onde havia contaminacao. Entao aqui entra TODA
 * execucao da acao no escopo, e a classificacao por tipo e feita depois,
 * pelo modulo de proveniencia.
 *
 * ── QUANDO A EXECUCAO ESCREVEU O CURSOR ─────────────────────────────
 *
 * O cursor duravel e gravado ANTES do desfecho da acao. Entao o melhor
 * instante conhecido para a escrita e o do DESFECHO, e e ele que vai em
 * `ocorridoEm`. Execucao sem desfecho nao tem esse instante: fica com o
 * da abertura, que e o mais cedo que ela poderia ter escrito. Isso e
 * aproximacao, e esta declarada — mas nao afrouxa a decisao, porque
 * execucao sem terminal ja conta como POSSIVEL escritora de qualquer
 * forma (`podeTerEscritoOCursor`).
 */

import { projetarResumoDaAcao } from "@/lib/agentes/acoes/auditoria-acao";

import { juntarFasesDoLedger, type LinhaDoLedger } from "./gap";
import { classificarOperacao, type EvidenciaDeMutacaoDoCursor } from "./provenancia-cursor";
import type { CargaDoLedger, LeituraDoCursorDoMonitor } from "./monitor-avaliacao";
import type { CursorAtual } from "./cursor-progresso";

function texto(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function booleanoOuNulo(v: unknown): boolean | null {
  return typeof v === "boolean" ? v : null;
}

function numeroOuNulo(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * Uma linha do ledger, como o detector a le.
 *
 * `null` quando a linha nao tem o minimo para participar da juncao —
 * dono, request, fase, status e instante. Descartar e mais honesto que
 * completar com vazio: uma linha sem `request_id` juntaria com qualquer
 * outra que tambem nao tivesse.
 */
export function lerLinhaDoLedger(bruta: unknown): LinhaDoLedger | null {
  if (typeof bruta !== "object" || bruta === null) return null;
  const o = bruta as Record<string, unknown>;
  const userId = texto(o.user_id);
  const requestId = texto(o.request_id);
  const fase = texto(o.fase);
  const status = texto(o.status);
  const criadoEm = texto(o.criado_em);
  if (userId === null || requestId === null) return null;
  if (fase === null || status === null || criadoEm === null) return null;

  // A MESMA allowlist da escrita, aplicada na leitura: chave que nao
  // pertence ao vocabulario nao entra, venha ela de uma versao antiga ou
  // de uma futura.
  const resumo = projetarResumoDaAcao(o.entrada_resumo);

  return {
    userId,
    requestId,
    fase,
    status,
    idempotencyKey: texto(o.idempotency_key),
    criadoEm,
    codigoDesfecho: texto(o.codigo_desfecho),
    continuacaoPendente: booleanoOuNulo(resumo.continuacao_pendente),
    deslocamentoInicial: numeroOuNulo(resumo.deslocamento_inicial),
    truncado: booleanoOuNulo(resumo.truncado),
    limiteAtingido: booleanoOuNulo(resumo.limite_atingido),
    orcamentoEsgotado: booleanoOuNulo(resumo.orcamento_esgotado),
  };
}

export interface EscopoDaCarga {
  readonly userId: string;
  readonly agenteId: string;
  readonly plataforma: string;
  readonly recurso: string;
}

/**
 * A proveniencia: uma evidencia por travessia, de QUALQUER tipo de
 * operacao.
 *
 * O resumo do desfecho e quem diz se o cursor andou. Sem desfecho, os
 * dois campos ficam `null` — "nao se sabe" —, e e assim que o OBS-3
 * fecha para o lado seguro.
 */
export function montarProveniencia(
  linhas: readonly LinhaDoLedger[],
  escopo: EscopoDaCarga,
  resumoPorRequest: ReadonlyMap<string, Record<string, number | boolean>>
): readonly EvidenciaDeMutacaoDoCursor[] {
  const { execucoes } = juntarFasesDoLedger(linhas);
  const evidencias: EvidenciaDeMutacaoDoCursor[] = [];

  for (const e of execucoes) {
    const classificacao = classificarOperacao(e.abertura.idempotencyKey);
    const fonte = e.terminal;
    const instante = Date.parse(fonte ? fonte.criadoEm : e.abertura.criadoEm);
    if (!Number.isFinite(instante)) continue;

    const resumo = fonte
      ? resumoPorRequest.get(JSON.stringify([fonte.userId, fonte.requestId])) ?? {}
      : {};

    evidencias.push({
      userId: e.userId,
      agenteId: escopo.agenteId,
      plataforma: escopo.plataforma,
      recurso: escopo.recurso,
      requestId: e.requestId,
      tipoDeOperacao: classificacao.tipo,
      canonicalBucketId: classificacao.canonicalBucketId,
      ocorridoEm: instante,
      cursorAtualizado: fonte ? booleanoOuNulo(resumo.cursor_atualizado) : null,
      cursorReiniciado: fonte ? booleanoOuNulo(resumo.cursor_reiniciado) : null,
      temTerminal: fonte !== null,
    });
  }

  return evidencias;
}

/** A linha e do dono e do agente que estamos observando? */
function doEscopo(bruta: unknown, escopo: EscopoDaCarga): boolean {
  if (typeof bruta !== "object" || bruta === null) return false;
  const o = bruta as Record<string, unknown>;
  return o.user_id === escopo.userId && o.agente_id === escopo.agenteId;
}

/**
 * Monta a carga inteira a partir das linhas cruas.
 *
 * `truncada` vem de quem consultou: e a unica forma de saber que a
 * janela nao coube. Transformar teto atingido em "foi isso que
 * aconteceu" seria a mentira mais cara deste modulo.
 */
export function montarCarga(
  brutas: readonly unknown[],
  escopo: EscopoDaCarga,
  truncada: boolean
): CargaDoLedger {
  const linhas: LinhaDoLedger[] = [];
  const resumoPorRequest = new Map<string, Record<string, number | boolean>>();

  for (const b of brutas) {
    // Cerca de escopo AQUI tambem, e nao so no `where` da consulta. Uma
    // porta mal ligada e um erro de fio; misturar dono ou agente na
    // analise seria um erro de VERDADE — o cursor de um agente
    // explicando o bucket de outro.
    if (!doEscopo(b, escopo)) continue;
    const linha = lerLinhaDoLedger(b);
    if (linha === null) continue;
    linhas.push(linha);
    if (linha.fase === "desfecho" && typeof b === "object" && b !== null) {
      resumoPorRequest.set(
        JSON.stringify([linha.userId, linha.requestId]),
        projetarResumoDaAcao((b as Record<string, unknown>).entrada_resumo)
      );
    }
  }

  return {
    linhas,
    mutacoes: montarProveniencia(linhas, escopo, resumoPorRequest),
    truncada,
  };
}

/**
 * O cursor duravel, como o OBS-3 o consome.
 *
 * Linha torta NAO vira `ausente`: ausente significa "nunca houve
 * varredura" e manda o detector tratar o comeco como legitimo. Forma
 * invalida e outra coisa, e vira `falhou`.
 */
export function lerCursorDoMonitor(
  bruta: unknown,
  escopo: EscopoDaCarga
): LeituraDoCursorDoMonitor {
  if (bruta === null || bruta === undefined) return { estado: "ausente" };
  if (typeof bruta !== "object") return { estado: "falhou" };
  const o = bruta as Record<string, unknown>;

  const deslocamento = o.proximo_deslocamento;
  const versao = o.versao;
  const alteradoEm = texto(o.alterado_em);
  if (typeof deslocamento !== "number" || !Number.isInteger(deslocamento) || deslocamento < 0) {
    return { estado: "falhou" };
  }
  if (typeof versao !== "number" || !Number.isInteger(versao) || versao < 1) {
    return { estado: "falhou" };
  }
  if (alteradoEm === null || !Number.isFinite(Date.parse(alteradoEm))) return { estado: "falhou" };

  const cursor: CursorAtual = {
    agenteId: escopo.agenteId,
    plataforma: escopo.plataforma,
    recurso: escopo.recurso,
    proximoDeslocamento: deslocamento,
    versao,
    alteradoEm,
  };
  return { estado: "encontrado", cursor };
}
