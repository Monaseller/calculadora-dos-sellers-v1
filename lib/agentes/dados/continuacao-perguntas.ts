/**
 * O cursor da varredura de perguntas — I4B2.
 *
 * ── O que ele e ─────────────────────────────────────────────────────
 *
 * A unica porta de leitura e escrita de
 * `agente_perguntas_continuacao`. Ele responde uma pergunta so: onde a
 * proxima varredura comeca, e para QUAL conta aquele numero vale.
 *
 * ── O que ele NAO e ─────────────────────────────────────────────────
 *
 * Nao e auditoria. `agente_acao_execucoes` guarda o que aconteceu e
 * nunca decide o que fazer em seguida — usar o ledger como controle
 * transformaria um buraco de auditoria num buraco de dado, e esse caso e
 * real (I3B, A12/A13).
 *
 * Nao resolve vinculo. A conta chega pronta, de
 * `resultado.autoridade.lojaId` da execucao de Funcao que buscou. Este
 * modulo COMPARA a conta do cursor com a da execucao; ele nunca vai
 * perguntar ao banco qual e a loja do agente, porque isso seria a
 * segunda resolucao que o I2 eliminou.
 *
 * ── Toda escrita e comparacao-e-troca ───────────────────────────────
 *
 * Nao existe aqui `select` seguido de `update` incondicional. Cada
 * mutacao carrega a `versao` que o chamador leu, e o `where` do UPDATE
 * decide. Quem perde nao sobrescreve: ele descobre que perdeu, rele, e
 * decide de novo. Mesmo espirito do CAS de credencial (`renovarComCas`),
 * sem reaproveitar nada daquele codigo — o problema e outro.
 */
import "server-only";

import { getSupabaseServidor } from "@/lib/estudio-anuncios/supabase-servidor";
import { CONEXAO_PERGUNTAS_ML } from "@/lib/agentes/funcoes/mercadolivre-perguntas";

const TABELA_CONTINUACAO = "agente_perguntas_continuacao";

/**
 * O requisito canonico, do MESMO lugar que o catalogo de Funcoes declara.
 *
 * Nao e redigitado: `CONEXAO_PERGUNTAS_ML` e a autoridade de qual par
 * `(plataforma, recurso)` esta Funcao exige, e uma segunda grafia aqui
 * seria a terceira forma de dizer a mesma coisa.
 */
const PLATAFORMA = CONEXAO_PERGUNTAS_ML.plataforma;
const RECURSO = CONEXAO_PERGUNTAS_ML.recurso;

const COLUNAS = "agente_id,user_id,loja_id,proximo_deslocamento,versao";

/** O cursor, como o dominio o le. */
export interface Continuacao {
  readonly agenteId: string;
  readonly userId: string;
  /** A conta para a qual `proximoDeslocamento` vale. `null` no inicio. */
  readonly lojaId: string | null;
  readonly proximoDeslocamento: number;
  /** O token de CAS. Quem for escrever precisa devolver este valor. */
  readonly versao: number;
}

export type LeituraContinuacao =
  | { readonly estado: "encontrada"; readonly continuacao: Continuacao }
  /** Nunca houve varredura. A proxima comeca do ZERO, em qualquer conta. */
  | { readonly estado: "ausente" }
  | { readonly estado: "falhou" };

/**
 * `perdida` e a resposta do BANCO: o `where` do CAS nao casou, entao
 * outra execucao mudou o cursor no meio. Nao e erro — e informacao, e
 * quem recebe deve reler em vez de insistir.
 */
export type EscritaContinuacao =
  | { readonly estado: "aplicada"; readonly continuacao: Continuacao }
  | { readonly estado: "perdida" }
  | { readonly estado: "falhou" };

function textoUtil(valor: unknown): valor is string {
  return typeof valor === "string" && valor.trim().length > 0;
}

function comoContinuacao(bruta: unknown): Continuacao | null {
  if (typeof bruta !== "object" || bruta === null) return null;
  const o = bruta as Record<string, unknown>;
  const agenteId = o.agente_id;
  const userId = o.user_id;
  const deslocamento = o.proximo_deslocamento;
  const versao = o.versao;
  if (!textoUtil(agenteId) || !textoUtil(userId)) return null;
  if (typeof deslocamento !== "number" || !Number.isInteger(deslocamento) || deslocamento < 0) {
    return null;
  }
  if (typeof versao !== "number" || !Number.isInteger(versao) || versao < 1) return null;
  const lojaId = o.loja_id;
  if (lojaId !== null && !textoUtil(lojaId)) return null;
  return {
    agenteId,
    userId,
    lojaId: lojaId === null ? null : lojaId,
    proximoDeslocamento: deslocamento,
    versao,
  };
}

/**
 * Le o cursor do agente.
 *
 * `ausente` e um estado legitimo e comum: e o primeiro ciclo. Ele NAO e
 * confundido com `falhou`, porque as acoes sao opostas — um manda
 * comecar do zero, o outro manda parar antes de tocar o provider.
 */
export async function lerContinuacao(entrada: {
  readonly userId: string;
  readonly agenteId: string;
  /** OPCIONAL. O sinal RIGIDO da acao. */
  readonly signal?: AbortSignal;
}): Promise<LeituraContinuacao> {
  if (!textoUtil(entrada.userId) || !textoUtil(entrada.agenteId)) {
    return { estado: "falhou" };
  }

  const base = getSupabaseServidor()
    .from(TABELA_CONTINUACAO)
    .select(COLUNAS)
    .eq("agente_id", entrada.agenteId)
    .eq("user_id", entrada.userId)
    .eq("plataforma", PLATAFORMA)
    .eq("recurso", RECURSO);
  const { data, error } = await (entrada.signal === undefined
    ? base : base.abortSignal(entrada.signal)).maybeSingle();

  if (error) {
    // Sem `error.message`: mensagem de driver vaza nome de coluna, de
    // constraint e as vezes valor.
    console.error("[continuacao] falha ao ler o cursor do agente");
    return { estado: "falhou" };
  }
  if (data === null) return { estado: "ausente" };

  const continuacao = comoContinuacao(data);
  if (continuacao === null) {
    // Forma estranha nao vira "comece do zero": zero e uma decisao, e
    // toma-la sobre uma linha que nao entendemos seria reingerir tudo.
    console.error("[continuacao] o cursor veio fora de forma");
    return { estado: "falhou" };
  }
  return { estado: "encontrada", continuacao };
}

/**
 * Cria o cursor do PRIMEIRO ciclo.
 *
 * A conta chega de fora, ja autoritativa. `perdida` aqui significa que
 * outra execucao criou a linha primeiro — a chave primaria decidiu, e
 * quem perdeu rele em vez de sobrescrever.
 */
export async function iniciarContinuacao(entrada: {
  readonly userId: string;
  readonly agenteId: string;
  readonly lojaId: string;
  readonly proximoDeslocamento: number;
  /** OPCIONAL. O sinal RIGIDO da acao. */
  readonly signal?: AbortSignal;
}): Promise<EscritaContinuacao> {
  if (!textoUtil(entrada.userId) || !textoUtil(entrada.agenteId)) {
    return { estado: "falhou" };
  }
  if (!textoUtil(entrada.lojaId)) return { estado: "falhou" };
  if (!Number.isInteger(entrada.proximoDeslocamento) || entrada.proximoDeslocamento < 0) {
    return { estado: "falhou" };
  }

  const insercao = getSupabaseServidor()
    .from(TABELA_CONTINUACAO)
    .insert({
      agente_id: entrada.agenteId,
      user_id: entrada.userId,
      plataforma: PLATAFORMA,
      recurso: RECURSO,
      loja_id: entrada.lojaId,
      proximo_deslocamento: entrada.proximoDeslocamento,
      versao: 1,
    });
  const { data, error } = await (entrada.signal === undefined
    ? insercao : insercao.abortSignal(entrada.signal)).select(COLUNAS).maybeSingle();

  if (error) {
    const codigo = typeof (error as { code?: unknown }).code === "string"
      ? (error as { code: string }).code
      : "";
    // 23505: a chave primaria ja existe. Outra execucao chegou antes.
    if (codigo === "23505") return { estado: "perdida" };
    console.error(`[continuacao] falha ao iniciar o cursor (sqlstate ${codigo || "desconhecido"})`);
    return { estado: "falhou" };
  }

  const continuacao = comoContinuacao(data);
  if (continuacao === null) return { estado: "falhou" };
  return { estado: "aplicada", continuacao };
}

/**
 * A troca condicional. UM comando, e e ele que decide a corrida.
 *
 * ── Por que nao ha RPC ──────────────────────────────────────────────
 *
 * Um `update ... where versao = $1 ... returning *` ja e atomico e ja
 * devolve o vencedor. Uma RPC acrescentaria um objeto ao schema sem
 * acrescentar garantia nenhuma, e este projeto tem precedente demais de
 * infraestrutura criada antes de ser necessaria.
 *
 * O `where` confere TRES coisas. `versao` e o que da a garantia — ela e
 * monotonica e resolve o ABA. `loja_id` e `proximo_deslocamento`
 * esperados nao acrescentam seguranca; eles acrescentam DIAGNOSTICO, e
 * custam nada.
 */
async function trocar(
  esperada: Continuacao,
  novo: { readonly lojaId: string; readonly proximoDeslocamento: number },
  signal?: AbortSignal
): Promise<EscritaContinuacao> {
  if (!Number.isInteger(novo.proximoDeslocamento) || novo.proximoDeslocamento < 0) {
    return { estado: "falhou" };
  }
  if (!textoUtil(novo.lojaId)) return { estado: "falhou" };

  let consulta = getSupabaseServidor()
    .from(TABELA_CONTINUACAO)
    .update({
      loja_id: novo.lojaId,
      proximo_deslocamento: novo.proximoDeslocamento,
      // A versao e calculada aqui porque PostgREST nao faz aritmetica de
      // coluna no corpo do UPDATE. Como o `where` exige a versao lida, o
      // incremento continua sendo sobre o valor que o chamador viu.
      versao: esperada.versao + 1,
      alterado_em: new Date().toISOString(),
    })
    .eq("agente_id", esperada.agenteId)
    .eq("user_id", esperada.userId)
    .eq("plataforma", PLATAFORMA)
    .eq("recurso", RECURSO)
    .eq("versao", esperada.versao)
    .eq("proximo_deslocamento", esperada.proximoDeslocamento);

  // `is null` e `= valor` sao filtros diferentes no PostgREST, e um
  // `eq("loja_id", null)` nao casaria com NULL nenhum.
  consulta = esperada.lojaId === null
    ? consulta.is("loja_id", null)
    : consulta.eq("loja_id", esperada.lojaId);

  const { data, error } = await (signal === undefined
    ? consulta : consulta.abortSignal(signal)).select(COLUNAS).maybeSingle();

  if (error) {
    const codigo = typeof (error as { code?: unknown }).code === "string"
      ? (error as { code: string }).code
      : "";
    console.error(`[continuacao] falha ao trocar o cursor (sqlstate ${codigo || "desconhecido"})`);
    return { estado: "falhou" };
  }
  // Zero linha alterada: o `where` nao casou, e outra execucao mudou o
  // cursor entre a leitura e esta escrita.
  if (data === null) return { estado: "perdida" };

  const continuacao = comoContinuacao(data);
  if (continuacao === null) return { estado: "falhou" };
  return { estado: "aplicada", continuacao };
}

/**
 * Avanca a janela depois de um pedaco DURAVELMENTE consumido.
 *
 * Quem chama ja gravou na inbox. A ordem importa e nao e negociavel:
 * avancar antes de persistir deixaria o pedaco para tras sem que
 * ninguem o tivesse ingerido, e nenhuma releitura o traria de volta.
 */
export async function avancarContinuacao(
  esperada: Continuacao,
  lojaId: string,
  proximoDeslocamento: number,
  signal?: AbortSignal
): Promise<EscritaContinuacao> {
  return trocar(esperada, { lojaId, proximoDeslocamento }, signal);
}

/**
 * Volta a janela para o comeco da lista, na MESMA conta.
 *
 * Usado quando a travessia chegou ao fim. Nao apaga a linha: a versao
 * monotonica, o `criado_em` e o rastro de `alterado_em` sobrevivem, e
 * nao ha corrida entre um DELETE e o INSERT seguinte.
 */
export async function reiniciarContinuacao(
  esperada: Continuacao,
  lojaId: string,
  signal?: AbortSignal
): Promise<EscritaContinuacao> {
  return trocar(esperada, { lojaId, proximoDeslocamento: 0 }, signal);
}

/**
 * A conta mudou debaixo do cursor.
 *
 * O deslocamento guardado valia para a conta ANTERIOR e nao significa
 * nada na nova: aplica-lo saltaria, em silencio, as primeiras perguntas
 * dela. Entao o cursor passa a apontar para a conta nova, no ZERO.
 *
 * E a mesma troca condicional das outras duas — o nome existe porque a
 * intencao e diferente, e um `avancar(..., 0)` no meio de um caminho de
 * recuperacao seria dificil de reconhecer meses depois.
 */
export async function reapontarContinuacao(
  esperada: Continuacao,
  lojaNova: string,
  signal?: AbortSignal
): Promise<EscritaContinuacao> {
  return trocar(esperada, { lojaId: lojaNova, proximoDeslocamento: 0 }, signal);
}
