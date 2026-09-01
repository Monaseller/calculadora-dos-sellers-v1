/**
 * O observador de aberturas stale — APPROVAL-B1D-D2-I1.
 *
 * ── A divisao de trabalho com o detector ────────────────────────────
 *
 *   `stale.ts`     devolve UMA PAGINA de aberturas stale, com cursor.
 *   este modulo    percorre paginas, agrega o que viu e devolve um
 *                  resumo — e para quando o trabalho fica grande demais
 *                  para uma execucao.
 *
 * Ele fica ACIMA do detector: nao fala com o banco, nao conhece tabela,
 * nao monta filtro. O unico import de dados e `listarAberturasStale`.
 * Se algum dia este arquivo precisar de `supabase-servidor`, e sinal de
 * que a camada errada esta fazendo o trabalho.
 *
 * ── O que ele continua NAO fazendo ──────────────────────────────────
 *
 * Nao executa Funcao, nao retoma aprovacao, nao abre nem fecha Tool
 * Call, nao escreve em lugar nenhum e nao enumera tenants. A politica do
 * B1D e AT-MOST-ONCE preservado: observar nao muda nada. Uma abertura
 * que ficou aberta continua aberta depois desta leitura.
 *
 * ── SEGMENTO, e nao "o tenant inteiro" ──────────────────────────────
 *
 * Uma chamada percorre no maximo `MAX_PAGINAS_OBSERVACAO` paginas e
 * devolve o resumo DAQUELE SEGMENTO. Se a fonte nao acabou, o resumo vem
 * com `esgotado: false` e o cursor para continuar — e a proxima execucao
 * recebe esse cursor em `cursorInicial`.
 *
 * Sem isso o teto viraria fome: cada execucao releria as mesmas
 * primeiras paginas e as posteriores nunca seriam alcancadas. O cursor
 * atravessa execucoes pela API, nao por estado persistido — nada aqui
 * grava checkpoint.
 *
 * ── Observacao temporal, e de varias fotos ──────────────────────────
 *
 * Cada pagina do detector carrega o proprio `capturadoEm`. Este modulo
 * NAO inventa um instante unico para o segmento: ele reporta `inicioEm`
 * e `fimEm`, que sao os carimbos da primeira e da ultima pagina lidas.
 * Durante o percurso aberturas podem nascer e desfechos podem chegar; o
 * resumo diz o que foi observado, nao o que e verdade agora.
 */
import "server-only";
import {
  listarAberturasStale,
  type ColetaStale,
  type CursorStale,
} from "@/lib/agentes/aprovacoes/stale";

/**
 * Quantas paginas do detector uma unica execucao percorre.
 *
 * E limite de TRABALHO POR SEGMENTO, e nada mais: nao e SLA, nao e
 * timeout, e nao promete varredura completa. Atingi-lo nao esconde nada
 * — devolve `esgotado: false` com o cursor de continuacao, e quem chama
 * decide se continua agora ou depois.
 */
export const MAX_PAGINAS_OBSERVACAO = 20;

/**
 * O vocabulario do detector, mais UM caso que so o observador enxerga.
 *
 * `contrato_invalido` significa que o detector devolveu um cursor que
 * nao avanca — a leitura funcionou, mas o contrato de paginacao
 * quebrou. Reaproveitar `falha_leitura` diria que o banco falhou, e
 * `entrada_invalida` diria que a entrada estava errada; as duas seriam
 * mentiras sobre um bug nosso. E ele fica AQUI, sem tocar
 * `ColetaStale`, porque e uma condicao do percurso, nao da pagina.
 */
export type ColetaObservacao = ColetaStale | "contrato_invalido";

export interface ResumoStale {
  /** Stales observadas NESTE segmento — nunca o total do tenant. */
  total: number;
  idadeMaximaMs: number | null;
  maisAntigaEm: string | null;
  porFuncao: Readonly<Record<string, number>>;
  /** Paginas do detector efetivamente chamadas neste segmento. */
  paginas: number;
  /**
   * `true` significa SOMENTE: a fonte terminou depois deste segmento.
   *
   * NAO significa que o tenant foi varrido desde o inicio — um segmento
   * que comecou num cursor nao teria como afirmar isso.
   */
  esgotado: boolean;
  /** Onde continuar. `null` quando esgotou ou quando a coleta falhou. */
  nextCursor: CursorStale | null;
  coleta: ColetaObservacao;
  /** `capturadoEm` da primeira pagina lida. */
  inicioEm: string;
  /** `capturadoEm` da ultima pagina lida. */
  fimEm: string;
}

export interface EntradaObservacaoStale {
  /** Autoridade de tenant. Vem de camada server-side ja autenticada. */
  userId: string;
  /**
   * Posicao de leitura de uma execucao anterior — e SO isso.
   *
   * Nao escolhe tenant, nao escolhe SLA e nao amplia o que pode ser
   * visto: as tres consultas do detector continuam escopadas por
   * `userId`. Um cursor alheio, no pior caso, desloca a posicao dentro
   * do proprio tenant de quem chamou.
   */
  cursorInicial?: CursorStale | null;
}

/** Dois cursores sao o MESMO ponto. Comparacao de igualdade apenas —
 *  ver o comentario em `observarAberturasStaleDoUsuario` sobre por que
 *  nao existe deteccao de regressao aqui. */
function mesmoPonto(a: CursorStale, b: CursorStale): boolean {
  return a.criadoEm === b.criadoEm && a.requestId === b.requestId;
}

/** Log de falha, agregado. Sem `userId`, sem ids, sem cursor, sem erro
 *  cru: quem investiga precisa saber QUE falhou e em que ponto do
 *  percurso, nao de quem era a linha. */
function logarFalha(coleta: ColetaObservacao, paginas: number): void {
  console.error(`[aprovacoes/observabilidade] coleta ${coleta} apos ${paginas} pagina(s)`);
}

/**
 * Percorre um segmento de aberturas stale do usuario e resume o que viu.
 *
 * ── A condicao de parada NAO e "a pagina veio vazia" ────────────────
 *
 * Uma pagina pode nao conter nenhuma stale — todas as candidatas eram
 * automaticas, ou todas ja tinham desfecho — e mesmo assim existir mais
 * fonte adiante. Parar em `itens.length === 0` deixaria registros
 * posteriores permanentemente inalcancaveis. Quem manda parar e o
 * `nextCursor` do detector, e so ele.
 *
 * ── Falha nao vira diagnostico ──────────────────────────────────────
 *
 * Se qualquer pagina falhar, o percurso para e as METRICAS voltam
 * zeradas. O que foi agregado ate ali descreve um pedaco de um segmento
 * interrompido, e apresentar isso como numero de stale conviteria a
 * conclusao errada — "sao 3" quando podiam ser 30. `paginas` continua
 * dizendo ate onde chegamos, para diagnostico.
 *
 * ── Regressao de cursor: deliberadamente NAO detectada ──────────────
 *
 * Cursor IGUAL ao anterior e sinal seguro de bug e derruba o percurso.
 * Cursor que RETROCEDE nao e verificado: prova-lo exigiria comparar
 * `request_id` com a mesma ordem que o Postgres usa, e essa ordem
 * depende da collation do banco. Inventar aqui um `<` de JavaScript e
 * chama-lo de prova seria supor o que nao foi medido.
 */
export async function observarAberturasStaleDoUsuario(
  entrada: EntradaObservacaoStale
): Promise<ResumoStale> {
  let cursorAtual: CursorStale | null = entrada.cursorInicial ?? null;

  let paginas = 0;
  let inicioEm = "";
  let fimEm = "";

  let total = 0;
  let idadeMaximaMs: number | null = null;

  // ── Por que Map, e nao `{}` ───────────────────────────────────────
  //
  // `funcaoId` e chave vinda de dado. Num objeto literal, ler
  // `alvo["__proto__"]` devolve `Object.prototype` em vez de
  // `undefined`, e escrever de volta e ignorado pelo setter — a
  // contagem daquela Funcao desapareceria. `constructor` e pior:
  // devolve a funcao `Object` e o `+ 1` produz uma STRING dentro de um
  // `Record<string, number>`.
  //
  // O CHECK `agente_funcao_chamadas_funcao_id_formato` recusa os dois
  // hoje. Mas isso e uma constraint duas camadas abaixo, que nem o
  // detector reaplica — e um agregador cuja correcao depende disso esta
  // certo por acidente. `Map` nao tem prototipo no caminho da chave.
  const porFuncao = new Map<string, number>();

  // ── Por que epoch, e nao comparacao de texto ──────────────────────
  //
  // Ordem lexical de timestamp so coincide com ordem temporal quando
  // todos tem o MESMO offset. `2026-09-01T10:00:00-03:00` e mais NOVO
  // que `2026-09-01T12:00:00Z` (13:00Z contra 12:00Z), e o texto diz o
  // contrario. `FORMA_TIMESTAMP`, no detector, aceita as duas formas —
  // logo o formato nao e canonico por validacao, e comparar string
  // seria depender do que o servidor costuma devolver.
  let maisAntigaEpochMs: number | null = null;
  let maisAntigaEm: string | null = null;

  /** Falha: metricas neutras, sem continuacao. `paginas` sobrevive. */
  const interromper = (coleta: ColetaObservacao): ResumoStale => {
    logarFalha(coleta, paginas);
    return Object.freeze({
      total: 0,
      idadeMaximaMs: null,
      maisAntigaEm: null,
      porFuncao: Object.freeze({}),
      paginas,
      esgotado: false,
      nextCursor: null,
      coleta,
      inicioEm,
      fimEm,
    });
  };

  const concluir = (esgotado: boolean, nextCursor: CursorStale | null): ResumoStale =>
    Object.freeze({
      total,
      idadeMaximaMs,
      maisAntigaEm,
      // `fromEntries` cria propriedade PROPRIA para toda chave, inclusive
      // `__proto__` — o prototipo do objeto resultante nao e alterado, e
      // o contrato publico continua sendo um `Record` serializavel.
      porFuncao: Object.freeze(Object.fromEntries(porFuncao)),
      paginas,
      esgotado,
      nextCursor,
      coleta: "ok" as const,
      inicioEm,
      fimEm,
    });

  for (let volta = 0; volta < MAX_PAGINAS_OBSERVACAO; volta++) {
    // `userId` vai SEMPRE o da entrada. O cursor nunca o substitui.
    const pagina = await listarAberturasStale({ userId: entrada.userId, cursor: cursorAtual });

    paginas++;
    if (paginas === 1) inicioEm = pagina.capturadoEm;
    fimEm = pagina.capturadoEm;

    if (pagina.coleta !== "ok") return interromper(pagina.coleta);

    for (const item of pagina.itens) {
      total++;
      porFuncao.set(item.funcaoId, (porFuncao.get(item.funcaoId) ?? 0) + 1);
      if (idadeMaximaMs === null || item.idadeMs > idadeMaximaMs) idadeMaximaMs = item.idadeMs;

      // O detector ja recusa timestamp deformado, entao `Date.parse`
      // aqui nao produz NaN. Nao reimplemento aquela validacao: uma
      // segunda copia dela envelheceria em relacao a original.
      const criadoEpochMs = Date.parse(item.criadoEm);
      if (maisAntigaEpochMs === null || criadoEpochMs < maisAntigaEpochMs) {
        maisAntigaEpochMs = criadoEpochMs;
        maisAntigaEm = item.criadoEm;
      }
    }

    // A fonte acabou. Unica forma de `esgotado: true`.
    if (pagina.nextCursor === null) return concluir(true, null);

    // O cursor precisa ANDAR. Se voltar igual, a proxima volta releria a
    // mesma pagina para sempre.
    if (cursorAtual !== null && mesmoPonto(cursorAtual, pagina.nextCursor)) {
      return interromper("contrato_invalido");
    }

    cursorAtual = pagina.nextCursor;
  }

  // Teto do segmento: nao ha pagina 21 nesta execucao. O cursor sai
  // daqui para que a proxima continue de onde esta.
  return concluir(false, cursorAtual);
}
