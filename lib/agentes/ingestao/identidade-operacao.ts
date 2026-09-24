/**
 * A GRAMATICA do `operationId` da rota dedicada de ingestao — I4C.
 *
 * ── Por que uma gramatica, e nao uma string livre ───────────────────
 *
 * A ponte generica aceita qualquer texto de ate 128 caracteres como
 * `operationId`: ela nao precisa entender a identidade, so compo-la. Aqui
 * e diferente. Esta rota precisa RESPONDER perguntas sobre a identidade —
 * "isto e uma tentativa nova?", "e a quarta?", "e uma continuacao?" — e
 * nenhuma delas se responde sobre texto opaco.
 *
 * Uma gramatica fechada tambem fecha, de graca, tres buracos:
 *
 *   1. NAMESPACE DUPLO. O `n8n:` e adicionado por `chaveDeIdempotencia`,
 *      no servidor, uma vez so. Um chamador que mandasse `n8n:X` geraria
 *      `n8n:n8n:X` — uma chave que parece certa e nao colide com a
 *      primeira. Aqui o `bucket` NAO admite `:`, entao a string
 *      `n8n:...` simplesmente nao e um `operationId` valido.
 *
 *   2. NAMESPACE MANUAL. O I4A congelou `manual:<quem>-<carimbo>` como
 *      namespace de prova operacional, e esta rota e a AGENDADA. Pelo
 *      mesmo motivo do item 1, `manual:...` nao passa pela gramatica — e
 *      `manual` sozinho como bucket e recusado por nome reservado.
 *
 *   3. SEPARADOR AMBIGUO. Com `:` proibido no bucket, a decomposicao em
 *      `<bucket>[:cN][:rN]` e unica. Nao ha string que possa ser lida de
 *      duas formas, e portanto nao ha duas chaves para a mesma intencao.
 *
 * ── TENTATIVA: o numero E o indice ──────────────────────────────────
 *
 * O I4A congelou `MAX_ATTEMPTS_PER_OPERATION = 3` com esta justificativa
 * literal: "cada tentativa recusada ainda paga uma chamada de grant, e 3
 * POR JANELA DE 5 MINUTOS e custo desprezivel". A janela e o bucket.
 * Logo o teto conta EXECUCOES POR BUCKET, e a execucao base e uma delas.
 *
 * Disso sai a unica leitura coerente:
 *
 *   sem sufixo  -> tentativa 1   (a execucao base, agendada)
 *   :r2         -> tentativa 2
 *   :r3         -> tentativa 3
 *   :r4 ...     -> RECUSADO, passou do teto
 *   :r1         -> RECUSADO, e um SEGUNDO NOME para a tentativa 1
 *
 * O `:r1` merece a propria linha. Ele nao e "quase certo": aceita-lo
 * criaria duas grafias da mesma tentativa, com chaves de idempotencia
 * DIFERENTES, e as duas iriam ao marketplace. Duas grafias de uma chave
 * de idempotencia e exatamente o defeito que ela existe para nao ter — a
 * mesma razao pela qual a ponte generica recusa espaco nas pontas em vez
 * de apara-lo.
 *
 * ── CONTINUACAO nao e tentativa ─────────────────────────────────────
 *
 * `:cN` identifica o PROXIMO PEDACO depois de um `backlog_truncado`. Nao
 * e repeticao de trabalho que falhou, e por isso NAO consome tentativa:
 * um backlog de dez paginas nao pode morrer no teto de retry.
 *
 * O teto de continuacoes continua `NEEDS_RUNTIME_TUNING` — ninguem mediu
 * o backlog real, e um numero inventado aqui reintroduziria a inanicao
 * que o cursor duravel acabou de fechar. O `LIMITE_INDICE` abaixo e
 * limite de FORMA (tres digitos), nao politica: 999 continuacoes de ate
 * 100 perguntas sao 99.900 perguntas num bucket, longe de qualquer
 * backlog plausivel e ainda assim finito.
 *
 * ── Composicao congelada ────────────────────────────────────────────
 *
 * Quando os dois aparecem, a ordem e `<bucket>:c<N>:r<N>` — continuacao
 * primeiro, tentativa depois. Uma ordem so, porque duas ordens seriam
 * duas chaves para a mesma intencao.
 */

/** O teto de tentativas por bucket. Congelado no I4A. */
export const MAX_TENTATIVAS_POR_OPERACAO = 3;

/**
 * Teto do `operationId` inteiro.
 *
 * Menor que os 128 da ponte generica de proposito: la o valor e opaco e
 * o limite so existe para barrar absurdo; aqui cada pedaco tem forma
 * propria, e a soma dos pedacos nao chega perto de 64. A chave final
 * fica em torno de 130 caracteres — `n8n:` + isto + `:sincronizar_perguntas:`
 * + um uuid —, e as chaves de pagina acrescentam `:pN`. Todas cabem com
 * folga no indice btree de `idempotency_key`, que e `text` sem CHECK de
 * tamanho nas duas tabelas.
 */
export const LIMITE_OPERATION_ID = 64;

/** Teto do bucket sozinho. */
const LIMITE_BUCKET = 48;

/** Tres digitos, sem zero a esquerda. FORMA, nao politica. */
const INDICE = /^[1-9][0-9]{0,2}$/;

/** O bucket: sem `:`, e comecando por alfanumerico. */
const BUCKET = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/**
 * Nomes que um bucket NAO pode ter.
 *
 * A gramatica ja impede `manual:algo` e `n8n:algo` — o `:` nao entra no
 * bucket. Esta lista cobre o caso restante e menos obvio: o bucket ser
 * EXATAMENTE a palavra de um namespace. `n8n` viraria a chave
 * `n8n:n8n:sincronizar_perguntas:<agente>`, que e o namespace duplo com
 * outra roupa; `manual` daria a uma operacao agendada a aparencia de uma
 * prova manual.
 */
const RESERVADOS = new Set(["n8n", "manual", "sched", "cds"]);

/** O que uma identidade valida diz. Nada aqui e autoridade de dominio. */
export interface IdentidadeDaOperacao {
  /** A janela do agendador. Opaca para o CDS — so precisa ser estavel. */
  readonly bucket: string;
  /** Qual pedaco do backlog. `0` e o primeiro, sem sufixo. */
  readonly continuacao: number;
  /** Qual execucao desta janela. `1` e a base, sem sufixo. */
  readonly tentativa: number;
  /** O texto normalizado. E ELE que vira chave — nunca o bruto. */
  readonly operationId: string;
}

export type LeituraDaOperacao =
  | { readonly ok: true; readonly identidade: IdentidadeDaOperacao }
  | { readonly ok: false; readonly motivo: MotivoDeRecusa };

/**
 * Por que a identidade foi recusada.
 *
 * Existe para a SUITE e para o log interno, nao para a resposta: dizer a
 * quem chama qual regra ele violou ensina a sondar a gramatica. A rota
 * devolve 400 e o motivo fica do lado de ca.
 */
export type MotivoDeRecusa =
  | "ausente"
  | "tipo_invalido"
  | "espaco_nas_pontas"
  | "comprimento"
  | "bucket_invalido"
  | "bucket_reservado"
  | "sufixo_desconhecido"
  | "sufixo_repetido"
  | "ordem_invalida"
  | "indice_invalido"
  | "tentativa_redundante"
  | "tentativa_acima_do_teto";

function recusa(motivo: MotivoDeRecusa): LeituraDaOperacao {
  return { ok: false, motivo };
}

/**
 * Le o `operationId` bruto do corpo e devolve a identidade, ou a recusa.
 *
 * Nao consulta banco, nao conhece agente e nao decide autoridade: ela
 * diz apenas se aquela string e uma identidade de operacao bem formada, e
 * o que ela significa.
 */
export function lerIdentidadeDaOperacao(bruto: unknown): LeituraDaOperacao {
  if (bruto === undefined || bruto === null) return recusa("ausente");
  if (typeof bruto !== "string") return recusa("tipo_invalido");
  // Recusa espaco em vez de aparar, pela mesma razao da ponte generica:
  // aparar faria `" X"` e `"X"` virarem a MESMA chave em silencio.
  if (bruto !== bruto.trim()) return recusa("espaco_nas_pontas");
  if (bruto.length === 0) return recusa("ausente");
  if (bruto.length > LIMITE_OPERATION_ID) return recusa("comprimento");

  const partes = bruto.split(":");
  const bucket = partes[0];
  if (bucket === undefined || bucket.length === 0) return recusa("bucket_invalido");
  if (bucket.length > LIMITE_BUCKET) return recusa("comprimento");
  if (!BUCKET.test(bucket)) return recusa("bucket_invalido");
  if (RESERVADOS.has(bucket.toLowerCase())) return recusa("bucket_reservado");

  let continuacao = 0;
  let tentativa = 1;
  let viuContinuacao = false;
  let viuTentativa = false;

  for (const sufixo of partes.slice(1)) {
    const marca = sufixo.slice(0, 1);
    const digitos = sufixo.slice(1);

    if (marca === "c") {
      if (viuContinuacao) return recusa("sufixo_repetido");
      // Ordem congelada: continuacao vem ANTES da tentativa. Duas ordens
      // seriam duas chaves para a mesma intencao.
      if (viuTentativa) return recusa("ordem_invalida");
      if (!INDICE.test(digitos)) return recusa("indice_invalido");
      continuacao = Number(digitos);
      viuContinuacao = true;
      continue;
    }

    if (marca === "r") {
      if (viuTentativa) return recusa("sufixo_repetido");
      if (!INDICE.test(digitos)) return recusa("indice_invalido");
      const indice = Number(digitos);
      // `r1` nomearia a tentativa 1, que ja tem nome: o bucket sozinho.
      if (indice === 1) return recusa("tentativa_redundante");
      if (indice > MAX_TENTATIVAS_POR_OPERACAO) return recusa("tentativa_acima_do_teto");
      tentativa = indice;
      viuTentativa = true;
      continue;
    }

    return recusa("sufixo_desconhecido");
  }

  return {
    ok: true,
    identidade: { bucket, continuacao, tentativa, operationId: bruto },
  };
}
