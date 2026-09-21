/**
 * Perguntas recebidas do Mercado Livre — o DOMINIO, M2-I1-A2.
 *
 * ── A pergunta que este modulo responde ─────────────────────────────
 *
 *   "quais perguntas esta conta recebeu, na forma que o agente pode ver?"
 *
 * Ele e o irmao de `lib/agentes/dados/vendas.ts`: mesmo papel, mesma
 * forma de fechar autoridade por CLOSURE, mesma disciplina de recusar
 * argumento invalido com codigo ESTAVEL. A diferenca e a fonte — vendas
 * le tabela propria, perguntas fala com um provider externo — e por isso
 * a chamada de rede nao mora aqui: mora no adapter, que e trocavel.
 *
 * ── O que ele NAO faz ───────────────────────────────────────────────
 *
 * Nao escolhe loja: a conta chega pronta, ja autorizada pelo guard e
 * ja validada pelo binding do agregador. Nao le credencial: o adapter
 * resolve o token por conta propria e nunca o devolve. Nao conhece
 * `agente_conexoes`, `agente_permissoes` nem Supabase.
 *
 * ── Por que a saida NAO e a resposta do provider ────────────────────
 *
 * Devolver o JSON do Mercado Livre ao agente entregaria campos que
 * ninguem auditou, que mudam sem aviso, e que carregam identidade de
 * terceiros. O dominio publica os campos de que o caso de uso precisa e
 * mais nenhum — e o que nao chegar estruturalmente confirmado nao vira
 * valor inventado: vira item descartado.
 */
import "server-only";
import {
  buscarPerguntasRecebidasML,
  type PortasPerguntasML,
  type ResultadoBrutoPerguntasML,
} from "@/lib/mercado-livre-perguntas";

// ─── Limites ──────────────────────────────────────────────────────────

/**
 * Teto de itens por chamada.
 *
 * Existe pelo mesmo motivo de `JANELA_MAXIMA_DIAS` em vendas: sem teto,
 * um argumento grande vira uma resposta grande que atravessa o executor,
 * a auditoria e eventualmente um modelo. O valor e do CDS, nao do
 * provider — se o provider aceitar mais, continuamos pedindo isto.
 */
export const LIMITE_MAXIMO_PERGUNTAS = 50;
export const LIMITE_PADRAO_PERGUNTAS = 20;

/**
 * Os status que esta fase sabe pedir.
 *
 * Lista FECHADA de proposito. `status` livre viraria passthrough de
 * parametro para a API do provider, e o contrato deste modulo e o que
 * o agente pode pedir — nunca o que a API aceita.
 */
export const STATUS_PERGUNTA_VALIDOS = ["UNANSWERED", "ANSWERED"] as const;
export type StatusPergunta = (typeof STATUS_PERGUNTA_VALIDOS)[number];

// ─── Contrato publico ─────────────────────────────────────────────────

/**
 * Uma pergunta, na forma que o agente ve.
 *
 * ── O que esta aqui, e por que ──────────────────────────────────────
 *
 *   id          para o agente poder se referir a UMA pergunta depois
 *   anuncioId   o item perguntado; sem ele a pergunta nao tem contexto
 *   texto       o conteudo — e a razao de a capacidade existir
 *   status      respondida ou nao, que e o que decide se ha trabalho
 *   criadaEm    ISO-8601; ordenar e priorizar dependem disto
 *
 * ── O que NAO esta, e nao por esquecimento ──────────────────────────
 *
 * Sem `access_token`, sem `seller_id`, sem `from.id` do comprador, sem
 * `answer`, sem o objeto bruto da loja e sem cabecalho de resposta. A
 * identidade de quem perguntou nao entra nesta fase: nenhum caso de uso
 * publicado precisa dela, e um dado pessoal sem consumidor e superficie
 * sem contrapartida.
 */
export interface PerguntaRecebida {
  readonly id: string;
  readonly anuncioId: string;
  readonly texto: string;
  readonly status: string;
  readonly criadaEm: string;
}

/**
 * O filtro aceito. Tres campos, todos opcionais, todos limitados.
 *
 * Nao ha `sellerId`, nao ha `url`, nao ha `path`, nao ha `query` livre:
 * o agente descreve O QUE quer, nunca COMO buscar. Endereco e conta sao
 * decisao do adapter e do binding, nesta ordem.
 */
export interface FiltroPerguntas {
  readonly status?: StatusPergunta;
  readonly limite?: number;
  readonly deslocamento?: number;
}

/**
 * O resultado. Mesma forma de `ResultadoVendas`, e pelo mesmo motivo:
 * o executor generico do registry ja sabe interpretar
 * `{ linhas, truncado, erro }`, e uma quarta forma obrigaria traducao.
 *
 * `truncado` ATRAVESSA. Um total incompleto com cara de completo e
 * exatamente o que o contrato de vendas existe para impedir, e aqui o
 * risco e o mesmo: o agente concluiria "so ha 20 perguntas".
 */
export interface ResultadoPerguntas {
  readonly linhas: readonly PerguntaRecebida[];
  readonly truncado: boolean;
  readonly erro: string | null;
}

/** A leitura com a autoridade JA fechada. Ver `criarLeiturasDePerguntas`. */
export type LerPerguntasRecebidas = (filtro: FiltroPerguntas) => Promise<ResultadoPerguntas>;

// ─── Validacao ────────────────────────────────────────────────────────

export interface ValidacaoFiltroPerguntas {
  erro:
    | null
    | "filtro_ausente"
    | "status_invalido"
    | "limite_invalido"
    | "deslocamento_invalido";
}

/**
 * Pura, e a UNICA autoridade das regras de filtro.
 *
 * Recusa nao-objeto ANTES de tocar qualquer campo — o executor a chama
 * com `unknown`, e confiar no tipo aqui seria confiar em quem chamou.
 *
 * Campo ausente e valido: o contrato publica os tres como opcionais, e
 * "nao pedi filtro" e um pedido legitimo. Campo PRESENTE e errado nao e:
 * ele vira codigo estavel, nunca um valor corrigido em silencio.
 */
export function validarFiltroPerguntas(filtro: unknown): ValidacaoFiltroPerguntas {
  if (typeof filtro !== "object" || filtro === null || Array.isArray(filtro)) {
    return { erro: "filtro_ausente" };
  }

  const bruto = filtro as Record<string, unknown>;

  if (bruto.status !== undefined) {
    if (
      typeof bruto.status !== "string" ||
      !(STATUS_PERGUNTA_VALIDOS as readonly string[]).includes(bruto.status)
    ) {
      return { erro: "status_invalido" };
    }
  }

  if (bruto.limite !== undefined) {
    const n = bruto.limite;
    if (
      typeof n !== "number" ||
      !Number.isInteger(n) ||
      n < 1 ||
      n > LIMITE_MAXIMO_PERGUNTAS
    ) {
      return { erro: "limite_invalido" };
    }
  }

  if (bruto.deslocamento !== undefined) {
    const n = bruto.deslocamento;
    // Sem teto superior arbitrario: paginar fundo e legitimo. O que nao
    // e legitimo e valor negativo, fracionario ou nao-numero.
    if (typeof n !== "number" || !Number.isInteger(n) || n < 0) {
      return { erro: "deslocamento_invalido" };
    }
  }

  return { erro: null };
}

// ─── Normalizacao ─────────────────────────────────────────────────────

/**
 * Um item do provider vira `PerguntaRecebida` — ou vira NADA.
 *
 * ── Por que cada campo e conferido em runtime ───────────────────────
 *
 * O contrato de resposta do Mercado Livre NAO foi verificado contra a
 * documentacao oficial: a auditoria M2-A3 mediu 403 nas paginas de
 * referencia, e este slice nao tem autorizacao para chamada real. Entao
 * a forma esperada e uma HIPOTESE, e tratar hipotese como fato produz
 * exatamente o defeito que o repositorio ja proibe — dado inventado.
 *
 * A saida disso nao e adivinhar: e conferir. Item que nao trouxer os
 * cinco campos na forma esperada e DESCARTADO, e o descarte e contado
 * para quem quiser auditar. Nunca se preenche `texto: ""` nem
 * `status: "UNANSWERED"` por conveniencia.
 */
export function normalizarPergunta(bruta: unknown): PerguntaRecebida | null {
  if (typeof bruta !== "object" || bruta === null || Array.isArray(bruta)) return null;

  const o = bruta as Record<string, unknown>;

  // `id` e `item_id` chegam como numero em varios endpoints do ML. Numero
  // finito vira string; `NaN`, `Infinity` e objeto, nao.
  const texto = (v: unknown): string | null => {
    if (typeof v === "string" && v.length > 0) return v;
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
    return null;
  };

  const id = texto(o.id);
  const anuncioId = texto(o.item_id);
  const corpo = typeof o.text === "string" && o.text.length > 0 ? o.text : null;
  const status = typeof o.status === "string" && o.status.length > 0 ? o.status : null;
  const criadaEm = typeof o.date_created === "string" && o.date_created.length > 0
    ? o.date_created
    : null;

  if (id === null || anuncioId === null || corpo === null || status === null || criadaEm === null) {
    return null;
  }

  return { id, anuncioId, texto: corpo, status, criadaEm };
}

/**
 * A lista inteira, com os descartes visiveis.
 *
 * `truncado` NAO mede descarte — ele mede "havia mais do que coube no
 * limite". Sao coisas diferentes: uma fala de paginacao, a outra de
 * resposta malformada, e colapsa-las esconderia a segunda.
 */
export function normalizarPerguntas(
  bruto: ResultadoBrutoPerguntasML
): { linhas: PerguntaRecebida[]; descartadas: number } {
  const linhas: PerguntaRecebida[] = [];
  let descartadas = 0;

  for (const item of bruto.itens) {
    const pergunta = normalizarPergunta(item);
    if (pergunta === null) {
      descartadas++;
      continue;
    }
    linhas.push(pergunta);
  }

  return { linhas, descartadas };
}

// ─── A leitura ────────────────────────────────────────────────────────

/**
 * Fecha a AUTORIDADE por closure e devolve a leitura.
 *
 * ── Por que `lojaId` entra aqui, e nao no filtro ────────────────────
 *
 * Mesmo padrao de `criarLeiturasDeVendas(userId)`: a funcao devolvida
 * NAO tem parametro de conta. Nao existe assinatura pela qual o chamador
 * — nem um modelo, nem uma Skill — peca perguntas de outra loja. O
 * `lojaId` vem do binding VALIDADO que o executor montou, e o `userId`
 * vem da sessao; os dois morrem nesta closure.
 *
 * ── `portas` ────────────────────────────────────────────────────────
 *
 * Injecao de fronteira, nao de comportamento: as suites trocam rede e
 * credencial por duplos, e producao nunca passa o parametro. Nao ha
 * `skipAuth`, nao ha URL configuravel, nao ha token aceito de fora.
 */
export function criarLeiturasDePerguntas(
  userId: string,
  lojaId: string,
  portas?: PortasPerguntasML
): LerPerguntasRecebidas {
  return async function lerPerguntasRecebidas(
    filtro: FiltroPerguntas
  ): Promise<ResultadoPerguntas> {
    const validacao = validarFiltroPerguntas(filtro);
    if (validacao.erro !== null) {
      return { linhas: [], truncado: false, erro: validacao.erro };
    }

    const limite = filtro.limite ?? LIMITE_PADRAO_PERGUNTAS;

    const bruto = await buscarPerguntasRecebidasML(
      {
        userId,
        lojaId,
        status: filtro.status ?? null,
        limite,
        deslocamento: filtro.deslocamento ?? 0,
      },
      portas
    );

    if (bruto.erro !== null) {
      // O codigo do adapter atravessa INTACTO. Ele ja e vocabulario
      // fechado e ja foi despido de corpo, header e token.
      return { linhas: [], truncado: false, erro: bruto.erro };
    }

    const { linhas, descartadas } = normalizarPerguntas(bruto);

    if (descartadas > 0) {
      // Contador, nunca conteudo: o item descartado pode conter texto de
      // terceiro, e ele nao vai para log.
      console.warn(`[perguntas] ${descartadas} item(ns) fora da forma esperada, descartados`);
    }

    return { linhas, truncado: bruto.haMais, erro: null };
  };
}
