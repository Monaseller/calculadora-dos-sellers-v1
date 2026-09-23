/**
 * `sincronizar_perguntas` — o serviço de domínio da ingestão. I1.
 *
 * ── O que ele e ─────────────────────────────────────────────────────
 *
 * A peca que fica ENTRE a acao de produto e a inbox. Ela resolve o dono
 * pelo agente, manda o CDS executar a Funcao de leitura, e decide quais
 * perguntas observadas estao APTAS a virar item de trabalho.
 *
 * ── O que ele NAO e ─────────────────────────────────────────────────
 *
 * Nao e rota, nao e acao registrada e nao e alcancavel de fora. Nada
 * neste arquivo aparece em `lib/agentes/acoes/catalogo.ts`, entao o
 * webhook generico da ponte nao tem como chegar aqui: `resolverAcao`
 * devolve `null` para o que nao esta no mapa, e a rota responde
 * `acao_desconhecida`. A exposicao e um gate proprio, com rota dedicada
 * e agente vindo do servidor — nunca do chamador.
 *
 * ── Buscar e gravar usam a MESMA autoridade ────────────────────────
 *
 * A conta em que se grava e a conta de onde se leu, e isso NAO e
 * disciplina: `executarFuncao` devolve, no sucesso, o `lojaId` do mesmo
 * `snapshot` que alimentou a Funcao. Nao ha segunda resolucao de
 * binding, entao nao ha janela entre buscar e gravar em que o vinculo
 * pudesse mudar e o dado de uma conta acabar na outra.
 *
 * ── Por que passa por `executarFuncao`, e nao pelo adapter ──────────
 *
 * Chamar `buscarPerguntasRecebidasML` daqui economizaria uma camada e
 * custaria SEIS: guard de permissao, resolucao de conexao, cobertura
 * remota, credencial, auditoria de Tool Call e a idempotencia da
 * chamada. O executor e quem alcanca a leitura; este servico so pede.
 *
 * ── `lojaId` nao existe neste arquivo ───────────────────────────────
 *
 * Nem como parametro, nem como variavel. A conta vem do binding, dentro
 * do executor, e `executarPerguntasML` a le de `contexto.conexao.lojaId`
 * conferindo plataforma e recurso. Nao ha por onde escolher conta — e a
 * ausencia e a garantia, nao a disciplina. O mesmo vale para `userId`:
 * ele e LIDO do agente, nunca recebido.
 */
import { lerAgenteParaAcaoInterna } from "@/lib/agentes/capability-worker";
import {
  gravarPerguntasNaInbox,
  type LinhaParaInbox,
  type MetricasPersistencia,
} from "@/lib/agentes/dados/perguntas-inbox";
import type { PerguntaRecebida } from "@/lib/agentes/dados/perguntas";
import { LIMITE_MAXIMO_PERGUNTAS } from "@/lib/agentes/dados/perguntas";
import { executarFuncao } from "@/lib/agentes/execucao-funcoes/executar";
import { FUNCAO_ID as FUNCAO_PERGUNTAS_ML } from "@/lib/agentes/handlers/consultar-perguntas-ml-contrato";

/** O nome publico da acao. Ainda NAO registrado no catalogo — ver o topo. */
export const ACAO_SINCRONIZAR_PERGUNTAS = "sincronizar_perguntas";

/**
 * O unico status que vira item NOVO de trabalho.
 *
 * O provider publica sete rotulos (ANSWERED, UNANSWERED, BANNED,
 * CLOSED_UNANSWERED, DELETED, DISABLED, UNDER_REVIEW) e pode publicar um
 * oitavo amanha. A inbox nao tenta interpretar todos: ela ingere o que
 * pediu, conta o que veio diferente, e nao inventa trabalho a partir de
 * rotulo que ninguem auditou.
 */
export const STATUS_INGERIVEL = "UNANSWERED";

/**

/**
 * ISO 8601 com data, hora e fuso — o que o Mercado Livre devolve em
 * `date_created`, e o que `timestamptz` aceita sem ambiguidade.
 *
 * Deliberadamente estreita. `Date.parse` sozinho aceitaria `"2026"` e
 * varias formas locais que o Postgres leria de outro jeito, ou nao
 * leria. Uma pergunta recusada aqui apenas nao e ingerida NESTE ciclo e
 * aparece no contador; uma pergunta aceita aqui e depois recusada pelo
 * cast da RPC derrubaria o LOTE INTEIRO. Entre os dois erros, este e o
 * barato.
 */
const ISO_8601_COM_FUSO =
  /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:?\d{2})$/;

/**
 * A data serve para virar `criada_em_provider`?
 *
 * ── Por que a validacao mora AQUI, e nao em `normalizarPergunta` ────
 *
 * Aquele normalizador e compartilhado com `consultar_perguntas`, que ja
 * esta em producao. Apertar a regra la mudaria o que uma Funcao
 * implantada devolve — uma pergunta com data estranha deixaria de ser
 * listada. Aqui a pergunta e outra: "esta observacao esta APTA a virar
 * linha da inbox?". E essa pergunta e da ingestao.
 */
function dataUtilizavel(criadaEm: string): boolean {
  if (!ISO_8601_COM_FUSO.test(criadaEm)) return false;
  return Number.isFinite(Date.parse(criadaEm));
}

/**
 * `PerguntaRecebida` -> a linha que a RPC espera.
 *
 * Cinco chaves, e so elas. `user_id` e `loja_id` NAO entram na linha:
 * eles sao parametros da RPC, um por chamada. Uma linha carregando a
 * propria autoridade abriria a porta para um lote com duas.
 */
function comoLinha(p: PerguntaRecebida): LinhaParaInbox {
  return {
    id_externo: p.id,
    anuncio_id_externo: p.anuncioId,
    texto: p.texto,
    provider_status: p.status,
    criada_em_provider: p.criadaEm,
  };
}

/** O que a ingestao contou nesta varredura. Somente escalares. */

export type ResultadoSincronizacao =
  | {
      readonly tipo: "sincronizado";
      readonly requestId: string;
      /** INTERNO. Nao atravessa a ponte nem o n8n. */
      readonly perguntas: readonly PerguntaRecebida[];
      /** O que a INGESTAO observou e filtrou. */
      readonly metricas: MetricasSincronizacao;
      /** O que a RPC de fato gravou. Fonte unica, inclusive no lote vazio. */
      readonly persistencia: MetricasPersistencia;
      /** O provider indicou que ha mais alem desta pagina. */
      readonly providerTruncado: boolean;
    }
  /**
   * Varredura que bateu no teto de paginas COM o provider ainda
   * indicando backlog. O que coube foi gravado; a varredura NAO
   * terminou, e chamar isso de sucesso esconderia o que ficou de fora.
   */
  | {
      readonly tipo: "backlog_truncado";
      readonly requestId: string;
      readonly perguntas: readonly PerguntaRecebida[];
      readonly metricas: MetricasSincronizacao;
      readonly persistencia: MetricasPersistencia;
      readonly providerTruncado: boolean;
    }
  /** Duas paginas vieram de contas diferentes. ZERO gravacao. */
  | { readonly tipo: "autoridade_divergente"; readonly requestId: string; readonly codigo: string }
  /** A RPC recusou por contrato. Nada foi gravado — ela e atomica. */
  | { readonly tipo: "persistencia_recusada"; readonly requestId: string; readonly codigo: string }
  | { readonly tipo: "agente_indisponivel"; readonly motivo: "inexistente" | "inativo" | "falha_leitura" }
  | { readonly tipo: "negado"; readonly requestId: string; readonly codigo: string }
  | { readonly tipo: "aguardando_aprovacao"; readonly requestId: string; readonly aprovacaoId: string }
  | { readonly tipo: "erro"; readonly requestId: string; readonly codigo: string }
  | { readonly tipo: "ja_processado" }
  | { readonly tipo: "indisponivel"; readonly requestId: string };

/**
 * A entrada. TRES campos, e nenhum deles escolhe autoridade.
 *
 * `agenteId` diz QUEM age; o dono sai do banco. `idempotencyKey` e
 * OPCIONAL e, quando vem, ja chega derivada no servidor — este servico
 * nao a monta a partir de string de terceiro.
 */
export interface EntradaSincronizarPerguntas {
  readonly agenteId: string;
  readonly idempotencyKey?: string;
}

/**
 * As duas portas injetaveis, com o caminho REAL como padrao.
 *
 * Existem para que a suite prove comportamento sem banco e sem rede. O
 * padrao e o de producao: esquecer de injetar nao silencia nada, executa
 * de verdade.
 */
export interface PortasSincronizacao {
  readonly lerAgente: typeof lerAgenteParaAcaoInterna;
  readonly executar: typeof executarFuncao;
  readonly gravar: typeof gravarPerguntasNaInbox;
}

const PORTAS_REAIS: PortasSincronizacao = {
  lerAgente: lerAgenteParaAcaoInterna,
  executar: executarFuncao,
  gravar: gravarPerguntasNaInbox,
};

/** A forma que a Funcao de perguntas devolve em `envelope.data`. */
function lerDados(data: unknown): {
  linhas: readonly PerguntaRecebida[];
  truncado: boolean;
  providerRecebidas: number;
  descartadasNormalizacao: number;
} | null {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
  const o = data as Record<string, unknown>;
  if (!Array.isArray(o.linhas)) return null;
  if (typeof o.truncado !== "boolean") return null;
  const inteiro = (v: unknown): number | null =>
    typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null;
  const providerRecebidas = inteiro(o.providerRecebidas);
  const descartadasNormalizacao = inteiro(o.descartadasNormalizacao);
  if (providerRecebidas === null || descartadasNormalizacao === null) return null;
  return {
    linhas: o.linhas as readonly PerguntaRecebida[],
    truncado: o.truncado,
    providerRecebidas,
    descartadasNormalizacao,
  };
}

/**
 * Separa o que e apto do que apenas foi observado.
 *
 * Nenhum item observado desaparece da contabilidade: ou entra em
 * `ingeriveis`, ou e contado em `status_inesperados`, ou em
 * `descartadas`. A soma fecha com `recebidas`, e ha invariante na suite
 * provando isso.
 */
function filtrarIngeriveis(linhas: readonly PerguntaRecebida[]): {
  aptas: PerguntaRecebida[];
  statusInesperados: number;
  descartadas: number;
} {
  const aptas: PerguntaRecebida[] = [];
  let statusInesperados = 0;
  let descartadas = 0;

  for (const linha of linhas) {
    if (linha.status !== STATUS_INGERIVEL) {
      statusInesperados += 1;
      continue;
    }
    if (!dataUtilizavel(linha.criadaEm)) {
      descartadas += 1;
      continue;
    }
    aptas.push(linha);
  }

  return { aptas, statusInesperados, descartadas };
}

/**
/**
 * A janela de paginacao. Fixa, e por isso auditavel.
 *
 * `PAGE_LIMIT` no teto do dominio (`LIMITE_MAXIMO_PERGUNTAS`) porque uma
 * pagina maior significa menos idas ao provider dentro do mesmo
 * orcamento. `MAX_PAGINAS` em 2 e uma cerca ESTRUTURAL do I3A: ela nao
 * promete caber em orcamento de orquestrador nenhum, porque ainda nao
 * existe rota. Ver `WALL_CLOCK_BUDGET`, adiado.
 */
export const PAGE_LIMIT = LIMITE_MAXIMO_PERGUNTAS;
export const MAX_PAGINAS = 2;
export const MAX_JANELA_PROVIDER = PAGE_LIMIT * MAX_PAGINAS;

/**
 * O deslocamento da pagina `n`. FIXO — nunca derivado do que sobrou.
 *
 * Se o offset avancasse pelo numero de linhas NORMALIZADAS, uma pagina
 * com 3 itens malformados iria de 0 para 47 e releria 3 itens que ja
 * passaram. Descarte de forma nao pode mover a janela do provider.
 */
export function deslocamentoDaPagina(indice: number): number {
  return indice * PAGE_LIMIT;
}

/**
 * A chave de idempotencia de UMA pagina.
 *
 * Deterministica: mesma tentativa e mesma pagina dao sempre a mesma
 * chave; paginas diferentes dao chaves diferentes; tentativas
 * diferentes tambem. Nenhum uuid e sorteado aqui — sortear tornaria
 * todo retry uma execucao nova, que e exatamente o que a chave existe
 * para impedir.
 *
 * Sufixo, e nao prefixo: a chave da tentativa ja carrega provedor, acao
 * e agente, e manter esse comeco intacto preserva a separacao de
 * namespace que `chaveDeIdempotencia` construiu.
 *
 * Sem risco de estouro: `idempotency_key` e `text` no banco, e
 * `registrarAbertura` nao impoe comprimento. A chave da ponte ja tem
 * ~190 caracteres no pior caso; `:p0` acrescenta tres.
 */
export function chaveDaPagina(chaveDaTentativa: string, indice: number): string {
  return `${chaveDaTentativa}:p${indice}`;
}

/** O que a ingestao contou na varredura INTEIRA. Somente escalares. */
export interface MetricasSincronizacao {
  readonly paginas: number;
  /** Itens que o provider devolveu, ANTES da normalizacao. */
  readonly provider_recebidas: number;
  /** Itens que sobreviveram a `normalizarPerguntas`. */
  readonly normalizadas: number;
  /** Recusados pela normalizacao, por forma. */
  readonly descartadas_normalizacao: number;
  /** Recusados pelo filtro de INGESTAO — hoje, data invalida. */
  readonly descartadas_ingestao: number;
  /** Normalizados cujo status nao vira item novo de trabalho. */
  readonly status_inesperados: number;
  /** Aptos a virar linha da inbox. */
  readonly ingeriveis: number;
  /** O provider indicou que ha mais ALEM da janela varrida. */
  readonly truncado: boolean;
  /** A varredura parou por bater em `MAX_PAGINAS`. */
  readonly limite_atingido: boolean;
}

/**
 * Uma pagina lida com sucesso, ja separada pelo filtro de ingestao.
 */
interface PaginaColetada {
  readonly aptas: readonly PerguntaRecebida[];
  readonly providerRecebidas: number;
  readonly normalizadas: number;
  readonly descartadasNormalizacao: number;
  readonly descartadasIngestao: number;
  readonly statusInesperados: number;
  readonly haMais: boolean;
}

/**
 * Traduz o desfecho de UMA pagina.
 *
 * Desfecho que nao e sucesso atravessa quase intacto: recusa de
 * permissao, aprovacao pendente e erro de provider sao fatos do CDS, e
 * reembrulha-los num vocabulario proprio criaria uma segunda verdade
 * para manter. Qualquer um deles aborta a varredura ANTES de qualquer
 * gravacao.
 */
type LeituraDePagina =
  | { tipo: "ok"; pagina: PaginaColetada; lojaId: string; requestId: string }
  | { tipo: "parar"; saida: ResultadoSincronizacao };

function lerPagina(resultado: Awaited<ReturnType<typeof executarFuncao>>): LeituraDePagina {
  switch (resultado.tipo) {
    case "sucesso": {
      const dados = lerDados(resultado.envelope.data);
      if (dados === null) {
        // A Funcao devolveu algo fora da forma. Falha fechada: adivinhar
        // a forma aqui e o comeco de ingerir lixo.
        return {
          tipo: "parar",
          saida: { tipo: "erro", requestId: resultado.requestId, codigo: "resposta_fora_de_forma" },
        };
      }

      // A autoridade da GRAVACAO vem da EXECUCAO que buscou. Sem ela nao
      // ha onde gravar, e inventar uma seria escolher conta por conta
      // propria — exatamente o que este servico existe para nao fazer.
      const lojaId = resultado.autoridade.lojaId;
      if (lojaId === null) {
        return {
          tipo: "parar",
          saida: { tipo: "erro", requestId: resultado.requestId, codigo: "autoridade_ausente" },
        };
      }

      const { aptas, statusInesperados, descartadas } = filtrarIngeriveis(dados.linhas);
      return {
        tipo: "ok",
        lojaId,
        requestId: resultado.requestId,
        pagina: {
          aptas,
          providerRecebidas: dados.providerRecebidas,
          normalizadas: dados.linhas.length,
          descartadasNormalizacao: dados.descartadasNormalizacao,
          descartadasIngestao: descartadas,
          statusInesperados,
          // BRUTO. Uma pagina cheia de itens malformados continua sendo
          // uma pagina cheia — medir pelo que sobrou faria o descarte
          // parecer fim de lista.
          haMais: dados.truncado,
        },
      };
    }

    case "negado":
      return {
        tipo: "parar",
        saida: { tipo: "negado", requestId: resultado.requestId, codigo: resultado.codigo },
      };

    case "aguardando_aprovacao":
      return {
        tipo: "parar",
        saida: {
          tipo: "aguardando_aprovacao",
          requestId: resultado.requestId,
          aprovacaoId: resultado.aprovacaoId,
        },
      };

    case "erro":
      return {
        tipo: "parar",
        saida: {
          tipo: "erro",
          requestId: resultado.requestId,
          // So o CODIGO. A frase do envelope nao viaja: o adapter ja
          // descartou corpo, header e status do provider.
          codigo: resultado.envelope.error.code,
        },
      };

    case "falha_auditoria":
      return {
        tipo: "parar",
        saida: resultado.motivo === "duplicada"
          ? { tipo: "ja_processado" }
          : { tipo: "erro", requestId: resultado.requestId, codigo: "falha_auditoria" },
      };

    case "aprovacao_indisponivel":
      return {
        tipo: "parar",
        saida: { tipo: "erro", requestId: resultado.requestId, codigo: resultado.codigo },
      };

    case "indisponivel":
      return {
        tipo: "parar",
        saida: { tipo: "indisponivel", requestId: resultado.requestId },
      };

    default: {
      // Exaustividade: uma variante nova do executor deixa de compilar aqui.
      const _exaustivo: never = resultado;
      return _exaustivo;
    }
  }
}

/**
 * Varre ate `MAX_PAGINAS`, coleta tudo, e grava UMA vez.
 *
 * ── Por que a autoridade e CONGELADA na primeira pagina ─────────────
 *
 * Cada `executarFuncao` resolve o binding de novo. Entao a pagina 2
 * pode, em tese, vir de outra conta — se o vinculo mudou no meio. Um
 * lote com paginas de contas diferentes seria dado de uma conta gravado
 * na outra, e nenhum contador denunciaria.
 *
 * Como `COLLECT_THEN_WRITE` so grava no fim, dar com a divergencia
 * durante a varredura ainda permite abortar com ZERO escrita. Por isso
 * a primeira pagina congela a autoridade e as seguintes so podem
 * confirma-la.
 */
export async function sincronizarPerguntas(
  entrada: EntradaSincronizarPerguntas,
  portas: PortasSincronizacao = PORTAS_REAIS
): Promise<ResultadoSincronizacao> {
  const { agente, erro } = await portas.lerAgente(entrada.agenteId);
  if (erro !== null) return { tipo: "agente_indisponivel", motivo: "falha_leitura" };
  // Inexistente e alheio dao a MESMA resposta: distingui-las seria um
  // oraculo de existencia de recurso de terceiro.
  if (agente === null) return { tipo: "agente_indisponivel", motivo: "inexistente" };
  if (!agente.ativo) return { tipo: "agente_indisponivel", motivo: "inativo" };

  const coletadas: PaginaColetada[] = [];
  let lojaCongelada: string | null = null;
  let requestIdFinal = "";
  let haMais = false;

  for (let indice = 0; indice < MAX_PAGINAS; indice += 1) {
    const resultado = await portas.executar({
      // Do BANCO. Nunca da entrada deste servico, que nao tem esse campo.
      userId: agente.userId,
      agenteId: agente.agenteId,
      // Do CONTRATO da Funcao. O literal nao e redigitado aqui.
      funcaoId: FUNCAO_PERGUNTAS_ML,
      argumentos: {
        status: STATUS_INGERIVEL,
        limite: PAGE_LIMIT,
        deslocamento: deslocamentoDaPagina(indice),
      },
      ...(entrada.idempotencyKey === undefined
        ? {}
        : { idempotencyKey: chaveDaPagina(entrada.idempotencyKey, indice) }),
    });

    const pagina = lerPagina(resultado);
    if (pagina.tipo !== "ok") return pagina.saida;

    // ── A cerca de autoridade entre paginas ─────────────────────────
    if (lojaCongelada === null) {
      lojaCongelada = pagina.lojaId;
    } else if (pagina.lojaId !== lojaCongelada) {
      // Nada foi gravado ainda, e nada sera. Misturar paginas de contas
      // diferentes num lote so e o defeito que esta cerca existe para
      // tornar impossivel.
      return {
        tipo: "autoridade_divergente",
        requestId: pagina.requestId,
        codigo: "autoridade_divergente_entre_paginas",
      };
    }

    requestIdFinal = pagina.requestId;
    coletadas.push(pagina.pagina);
    haMais = pagina.pagina.haMais;

    // Pagina que nao encheu significa fim de lista: pedir a seguinte
    // seria uma ida ao provider que ninguem precisa.
    if (!haMais) break;
  }

  if (lojaCongelada === null) {
    // Nao houve pagina alguma — so acontece se `MAX_PAGINAS` for zero.
    return { tipo: "erro", requestId: requestIdFinal, codigo: "autoridade_ausente" };
  }

  const aptas = coletadas.flatMap((p) => [...p.aptas]);
  const soma = (f: (p: PaginaColetada) => number) =>
    coletadas.reduce((acc, p) => acc + f(p), 0);

  // Bateu no teto E o provider ainda indica mais: a varredura NAO
  // terminou, e dizer "sucesso" aqui esconderia backlog.
  const limiteAtingido = coletadas.length === MAX_PAGINAS && haMais;

  const metricas: MetricasSincronizacao = {
    paginas: coletadas.length,
    provider_recebidas: soma((p) => p.providerRecebidas),
    normalizadas: soma((p) => p.normalizadas),
    descartadas_normalizacao: soma((p) => p.descartadasNormalizacao),
    descartadas_ingestao: soma((p) => p.descartadasIngestao),
    status_inesperados: soma((p) => p.statusInesperados),
    ingeriveis: aptas.length,
    truncado: haMais,
    limite_atingido: limiteAtingido,
  };

  // COLLECT_THEN_WRITE: so agora, e uma vez so. Duplicata ENTRE paginas
  // chega junta ao mesmo lote, e quem decide o que fazer com ela e a
  // RPC — que ja prova colapso de duplicata exata e recusa de duplicata
  // divergente. Uma segunda politica de dedupe em TypeScript criaria uma
  // segunda verdade para manter.
  const gravacao = await portas.gravar(
    { userId: agente.userId, lojaId: lojaCongelada },
    aptas.map(comoLinha)
  );

  if (gravacao.tipo === "recusado") {
    return { tipo: "persistencia_recusada", requestId: requestIdFinal, codigo: gravacao.codigo };
  }
  if (gravacao.tipo === "erro") {
    // Provider deu certo e o banco nao. Isso e ERRO, nunca sucesso com
    // zero: a RPC e atomica, entao nada foi gravado pela metade.
    return { tipo: "erro", requestId: requestIdFinal, codigo: gravacao.codigo };
  }

  return {
    tipo: limiteAtingido ? "backlog_truncado" : "sincronizado",
    requestId: requestIdFinal,
    perguntas: aptas,
    metricas,
    persistencia: gravacao.metricas,
    providerTruncado: haMais,
  };
}
