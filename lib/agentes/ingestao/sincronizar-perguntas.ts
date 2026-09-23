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
 * O filtro de UMA pagina, no I1.
 *
 * `limite` no teto do dominio porque uma pagina maior significa menos
 * idas ao provider dentro do mesmo orcamento. `deslocamento` zero porque
 * o I1 nao pagina: provar a fronteira de dominio e outra coisa, e juntar
 * as duas esconderia qual das duas quebrou.
 */
export const FILTRO_PAGINA_UNICA = Object.freeze({
  status: STATUS_INGERIVEL,
  limite: LIMITE_MAXIMO_PERGUNTAS,
  deslocamento: 0,
});

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
export interface MetricasSincronizacao {
  readonly paginas: number;
  /** Itens que o provider devolveu e a Funcao normalizou com sucesso. */
  readonly recebidas: number;
  /** Observadas, porem inaptas: data invalida. */
  readonly descartadas: number;
  /** Observadas com status que nao vira item novo de trabalho. */
  readonly status_inesperados: number;
  /** Aptas a virar linha da inbox. */
  readonly ingeriveis: number;
}

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
function lerDados(
  data: unknown
): { linhas: readonly PerguntaRecebida[]; truncado: boolean } | null {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
  const o = data as Record<string, unknown>;
  if (!Array.isArray(o.linhas)) return null;
  if (typeof o.truncado !== "boolean") return null;
  return { linhas: o.linhas as readonly PerguntaRecebida[], truncado: o.truncado };
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
 * Uma varredura de UMA pagina.
 *
 * O desfecho do executor atravessa quase intacto: recusa de permissao,
 * aprovacao pendente e erro de provider sao fatos do CDS, e reembrulha-los
 * num vocabulario proprio criaria uma segunda verdade para manter.
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

  const resultado = await portas.executar({
    // Do BANCO. Nunca da entrada deste servico, que nao tem esse campo.
    userId: agente.userId,
    agenteId: agente.agenteId,
    // Do CONTRATO da Funcao. O literal nao e redigitado aqui.
    funcaoId: FUNCAO_PERGUNTAS_ML,
    argumentos: { ...FILTRO_PAGINA_UNICA },
    ...(entrada.idempotencyKey === undefined
      ? {}
      : { idempotencyKey: entrada.idempotencyKey }),
  });

  switch (resultado.tipo) {
    case "sucesso": {
      const dados = lerDados(resultado.envelope.data);
      if (dados === null) {
        // A Funcao devolveu algo fora da forma. Falha fechada: adivinhar
        // a forma aqui e o comeco de ingerir lixo.
        return { tipo: "erro", requestId: resultado.requestId, codigo: "resposta_fora_de_forma" };
      }

      // A autoridade da GRAVACAO vem da EXECUCAO que buscou. Sem ela nao
      // ha onde gravar, e inventar uma seria escolher conta por conta
      // propria — exatamente o que este servico existe para nao fazer.
      const lojaId = resultado.autoridade.lojaId;
      if (lojaId === null) {
        return { tipo: "erro", requestId: resultado.requestId, codigo: "autoridade_ausente" };
      }

      const { aptas, statusInesperados, descartadas } = filtrarIngeriveis(dados.linhas);

      const metricas: MetricasSincronizacao = {
        paginas: 1,
        recebidas: dados.linhas.length,
        descartadas,
        status_inesperados: statusInesperados,
        ingeriveis: aptas.length,
      };

      // COLLECT_THEN_WRITE: coleta e filtra TUDO, depois grava UMA vez.
      // Com uma pagina so isso ainda nao pesa; com varias, e o que impede
      // ingestao pela metade quando a pagina 2 falhar.
      const gravacao = await portas.gravar(
        { userId: agente.userId, lojaId },
        aptas.map(comoLinha)
      );

      if (gravacao.tipo === "recusado") {
        return { tipo: "persistencia_recusada", requestId: resultado.requestId, codigo: gravacao.codigo };
      }
      if (gravacao.tipo === "erro") {
        // Provider deu certo e o banco nao. Isso e ERRO, nunca sucesso
        // com zero: a RPC e atomica, entao nada foi gravado pela metade.
        return { tipo: "erro", requestId: resultado.requestId, codigo: gravacao.codigo };
      }

      return {
        tipo: "sincronizado",
        requestId: resultado.requestId,
        perguntas: aptas,
        metricas,
        persistencia: gravacao.metricas,
        providerTruncado: dados.truncado,
      };
    }

    case "negado":
      return { tipo: "negado", requestId: resultado.requestId, codigo: resultado.codigo };

    case "aguardando_aprovacao":
      return {
        tipo: "aguardando_aprovacao",
        requestId: resultado.requestId,
        aprovacaoId: resultado.aprovacaoId,
      };

    case "erro":
      return {
        tipo: "erro",
        requestId: resultado.requestId,
        // So o CODIGO. A frase do envelope nao viaja: o adapter ja
        // descartou corpo, header e status do provider.
        codigo: resultado.envelope.error.code,
      };

    case "falha_auditoria":
      if (resultado.motivo === "duplicada") return { tipo: "ja_processado" };
      return { tipo: "erro", requestId: resultado.requestId, codigo: "falha_auditoria" };

    case "aprovacao_indisponivel":
      return { tipo: "erro", requestId: resultado.requestId, codigo: resultado.codigo };

    case "indisponivel":
      return { tipo: "indisponivel", requestId: resultado.requestId };

    default: {
      // Exaustividade: uma variante nova do executor deixa de compilar aqui.
      const _exaustivo: never = resultado;
      return _exaustivo;
    }
  }
}
