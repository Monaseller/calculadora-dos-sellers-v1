/**
 * Cliente AUTENTICADO do Mercado Livre para o Estúdio (2026-08-25).
 *
 * REUSA O OAUTH EXISTENTE DO CDS — não cria arquitetura nova. O token sai
 * de `getMLLojaById()` (`lib/ml-auth.ts`), que já faz refresh usando
 * `ML_CLIENT_ID`/`ML_CLIENT_SECRET` e regrava em `lojas`. Nenhuma tabela
 * nova de token, nenhum fluxo de autorização novo.
 *
 * O TOKEN NUNCA SAI DO SERVIDOR. Não é retornado por nenhuma função
 * exportada aqui, não vai para DTO, não é logado, não é persistido em
 * lugar nenhum além de `lojas` (que já era assim).
 *
 * PROPRIEDADE DA LOJA É VERIFICADA ANTES. `getMLLojaById()` **não checa
 * dono** — ela nasceu para o Worker, que resolve a loja a partir do job.
 * Por isso `carregarContaML()` confirma `user_id` + `marketplace` +
 * `ativo` numa consulta própria antes de pedir o token. Sem isso, um
 * `loja_id` forjado carregaria token alheio.
 *
 * SÓ VALIDA — NUNCA PUBLICA. O único endpoint de escrita usado é
 * `POST /items/validate`, que é o validador oficial e **não cria item**.
 * Não existe `POST /items` neste arquivo nem em nenhum outro do módulo.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { getMLLojaById } from "@/lib/ml-auth";

const BASE_ML = "https://api.mercadolibre.com";
const TIMEOUT_MS = 20_000;

/** Dados da conta que PODEM circular. `accessToken` fica fora. */
export interface ContaMLPublica {
  lojaId: string;
  nome: string;
  nickname: string;
  sellerId: string;
  siteId: string;
}

export interface ContaMLInterna extends ContaMLPublica {
  /** NUNCA sai desta camada. */
  accessToken: string;
}

export type TipoErroML =
  | "auth"          // 401/403 — token inválido ou sem permissão
  | "rate_limit"    // 429
  | "transient"     // 5xx, timeout, rede
  | "validation"    // 400 — o payload é que está errado
  | "resposta";     // respondeu algo que não sabemos ler

export class ErroML extends Error {
  constructor(
    mensagem: string,
    public readonly tipo: TipoErroML,
    public readonly httpStatus: number | null,
    /** Corpo da resposta, já sem credencial. Útil para diagnóstico. */
    public readonly corpo: unknown = null
  ) {
    super(mensagem);
    this.name = "ErroML";
  }
}

/** Classificação por inspeção estrutural, como no provedor do Gemini. */
function classificar(status: number): TipoErroML {
  if (status === 401 || status === 403) return "auth";
  if (status === 429) return "rate_limit";
  if (status >= 500) return "transient";
  if (status === 400 || status === 404) return "validation";
  return "resposta";
}

/**
 * Carrega a conta E o token, **depois** de confirmar que a loja é do
 * usuário, do marketplace certo e está ativa. Devolve `null` quando a
 * loja não serve — nunca lança por loja inexistente, porque a rota
 * traduz isso em 404.
 */
export async function carregarContaML(
  supabase: SupabaseClient,
  params: { lojaId: string; userId: string; marketplace: string }
): Promise<ContaMLInterna | null> {
  const { data, error } = await supabase
    .from("lojas")
    .select("id, nome, nickname, seller_id, marketplace, ativo, user_id")
    .eq("id", params.lojaId)
    .maybeSingle();
  if (error) throw new Error(`Falha ao ler a loja: ${error.message}`);

  const loja = data as any | null;
  // As três checagens que impedem usar token de outra pessoa.
  if (!loja) return null;
  if (!loja.user_id || String(loja.user_id) !== params.userId) return null;
  if (loja.marketplace !== params.marketplace) return null;
  if (loja.ativo !== true) return null;

  // Só aqui o token é pedido — e `getMLLojaById` cuida do refresh.
  const comToken = await getMLLojaById(params.lojaId);
  if (!comToken?.accessToken) return null;

  return {
    lojaId: loja.id,
    nome: loja.nome ?? loja.nickname ?? "Mercado Livre",
    nickname: loja.nickname ?? "",
    sellerId: comToken.sellerId || (loja.seller_id ?? ""),
    // O site sai do prefixo da conta; para o Brasil é sempre MLB.
    siteId: "MLB",
    accessToken: comToken.accessToken,
  };
}

/** Versão que pode ir para a UI — sem token, por construção. */
export function paraContaPublica(conta: ContaMLInterna): ContaMLPublica {
  const { accessToken, ...publica } = conta;
  return publica;
}

async function chamar(
  caminho: string,
  token: string,
  init?: { method?: string; body?: unknown }
): Promise<{ status: number; corpo: any }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE_ML}${caminho}`, {
      method: init?.method ?? "GET",
      headers: {
        // O único lugar onde o token aparece: o header da requisição.
        Authorization: `Bearer ${token}`,
        accept: "application/json",
        ...(init?.body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: init?.body === undefined ? undefined : JSON.stringify(init.body),
      signal: ctrl.signal,
    });
    const texto = await res.text();
    let corpo: any = null;
    if (texto) {
      try { corpo = JSON.parse(texto); } catch { corpo = { raw: texto.slice(0, 2000) }; }
    }
    return { status: res.status, corpo };
  } catch (err: any) {
    const nome = err?.name ?? "";
    // Timeout e falha de rede são transitórios — nunca viram "validado".
    throw new ErroML(
      /abort|timeout/i.test(nome) ? "Tempo esgotado ao falar com o Mercado Livre." : "Falha de comunicação com o Mercado Livre.",
      "transient",
      null
    );
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Modelo de publicação da CONTA (2026-08-26).
 *
 * `user_products` é o modelo novo do Mercado Livre: o título **não é
 * enviado pelo integrador** (o ML o monta) e `family_name` passa a ser
 * obrigatório. `legacy` é o modelo anterior, com `title` e `variations`.
 */
export type ModeloPublicacaoML = "user_products" | "legacy";

/** Tag oficial que identifica o modelo — fonte: doc "User Products". */
export const TAG_USER_PRODUCTS = "user_product_seller";

export interface ContaMLModelo {
  modelo: ModeloPublicacaoML;
  tags: string[];
  sellerId: string;
  siteId: string;
}

/**
 * Resolve o modelo a partir das tags. Função pura e explícita: a decisão
 * NUNCA é inferida do erro de `/items/validate` — aquele erro só diria
 * que algo faltou, não qual modelo a conta usa.
 */
export function resolverModeloPorTags(tags: unknown): ModeloPublicacaoML {
  const lista = Array.isArray(tags) ? tags.filter(t => typeof t === "string") : [];
  return lista.includes(TAG_USER_PRODUCTS) ? "user_products" : "legacy";
}

/**
 * `GET /users/{seller_id}` — exige OAuth. Devolve o modelo resolvido e as
 * tags cruas, para a decisão continuar auditável depois.
 *
 * Resposta sem `tags` reconhecível é ERRO, não "legacy por omissão":
 * assumir o modelo antigo em silêncio publicaria pelo formato errado.
 */
export async function buscarModeloDaContaML(conta: ContaMLInterna): Promise<ContaMLModelo> {
  if (!conta.sellerId) {
    throw new ErroML("A conta não tem seller_id para consultar o modelo.", "validation", null);
  }
  const { status, corpo } = await chamar(`/users/${encodeURIComponent(conta.sellerId)}`, conta.accessToken);
  if (status !== 200) {
    throw new ErroML(`Não foi possível ler os dados da conta (${status}).`, classificar(status), status, corpo);
  }
  if (!Array.isArray(corpo?.tags)) {
    throw new ErroML("A conta respondeu sem a lista de tags — modelo de publicação indeterminado.", "resposta", status, corpo);
  }
  const tags = corpo.tags.filter((t: unknown) => typeof t === "string") as string[];
  return {
    modelo: resolverModeloPorTags(tags),
    tags,
    sellerId: String(corpo.id ?? conta.sellerId),
    siteId: typeof corpo.site_id === "string" ? corpo.site_id : conta.siteId,
  };
}

export interface TipoAnuncioML {
  id: string;
  nome: string;
}

/**
 * Tipos de anúncio que a CONTA permite. Endpoint 403 sem OAuth — é
 * exatamente o dado que não dava para verificar antes desta etapa.
 */
export async function listarTiposAnuncioML(conta: ContaMLInterna): Promise<TipoAnuncioML[]> {
  const { status, corpo } = await chamar(`/sites/${conta.siteId}/listing_types`, conta.accessToken);
  if (status !== 200) {
    throw new ErroML(`Não foi possível listar os tipos de anúncio (${status}).`, classificar(status), status, corpo);
  }
  if (!Array.isArray(corpo)) {
    throw new ErroML("Resposta inesperada ao listar tipos de anúncio.", "resposta", status, corpo);
  }
  return corpo
    .filter((t: any) => typeof t?.id === "string")
    .map((t: any) => ({ id: t.id, nome: typeof t.name === "string" ? t.name : t.id }));
}

/** Um problema apontado pelo Mercado Livre, preservando o código oficial. */
export interface ProblemaML {
  /** Código oficial do ML — nunca traduzido nem reescrito. */
  codigo: string;
  /** Mensagem oficial, como veio. */
  mensagem: string;
  /** Campo do payload, quando o ML informa. */
  campo: string | null;
  /** Tipo declarado pelo ML (`error`, `warning`, …). */
  tipo: string | null;
}

export interface RespostaValidacaoML {
  httpStatus: number;
  /** 204 = payload aceito pelo validador oficial. */
  aceito: boolean;
  erros: ProblemaML[];
  alertas: ProblemaML[];
  /** Corpo bruto, já filtrado de credencial. Para auditoria. */
  respostaBruta: unknown;
  /**
   * `true` quando a resposta é o envelope de validação CONHECIDO
   * (`error: "validation_error"` com `cause` interpretável). É o que
   * autoriza `derivarStatusOficial` a ler um 400 como parecer semântico
   * em vez de falha — ver o comentário lá.
   */
  envelopeValidacaoConhecido: boolean;
}

/**
 * Extrai os problemas preservando os CÓDIGOS OFICIAIS. A tarefa é
 * explícita: não reduzir tudo a uma string e não traduzir de um jeito que
 * mude o significado. O que a UI mostrar por cima é enfeite; o código
 * original continua disponível.
 *
 * A API devolve `cause` como lista (às vezes objeto), e nem todo item
 * traz `type` — quando não traz, é tratado como ERRO, nunca como alerta:
 * na dúvida, bloqueia.
 */
function extrairProblemas(corpo: any): { erros: ProblemaML[]; alertas: ProblemaML[] } {
  const erros: ProblemaML[] = [];
  const alertas: ProblemaML[] = [];
  if (!corpo) return { erros, alertas };

  const causas = Array.isArray(corpo.cause) ? corpo.cause : corpo.cause ? [corpo.cause] : [];
  for (const c of causas) {
    if (c == null) continue;
    const item: ProblemaML =
      typeof c === "string"
        ? { codigo: "sem_codigo", mensagem: c, campo: null, tipo: null }
        : {
            codigo: String(c.code ?? c.error ?? "sem_codigo"),
            mensagem: String(c.message ?? c.cause ?? JSON.stringify(c).slice(0, 300)),
            campo: typeof c.references?.[0] === "string" ? c.references[0] : (typeof c.field === "string" ? c.field : null),
            tipo: typeof c.type === "string" ? c.type : null,
          };
    if (item.tipo && /warn/i.test(item.tipo)) alertas.push(item);
    else erros.push(item);
  }

  // Erro sem `cause` detalhada ainda é erro: o envelope vira um item.
  if (erros.length === 0 && alertas.length === 0 && (corpo.message || corpo.error)) {
    erros.push({
      codigo: String(corpo.error ?? "sem_codigo"),
      mensagem: String(corpo.message ?? "Erro sem detalhamento."),
      campo: null,
      tipo: null,
    });
  }
  return { erros, alertas };
}

/**
 * VALIDAÇÃO OFICIAL — `POST /items/validate`.
 *
 * Este endpoint **não cria anúncio**: é o validador que a própria
 * documentação recomenda para conferir o item antes de publicar. Segundo
 * a fonte oficial, resposta **204 No Content** significa payload correto.
 *
 * Erros de comunicação (401/403/429/5xx/timeout) sobem como `ErroML` e
 * **não viram parecer "validado"** — a distinção entre "o ML reprovou" e
 * "não conseguimos falar com o ML" é preservada.
 */
export async function validarItemML(
  conta: ContaMLInterna,
  payload: Record<string, unknown>
): Promise<RespostaValidacaoML> {
  const { status, corpo } = await chamar("/items/validate", conta.accessToken, {
    method: "POST",
    body: payload,
  });

  if (status === 204 || status === 200) {
    return { httpStatus: status, aceito: true, erros: [], alertas: [], respostaBruta: corpo, envelopeValidacaoConhecido: true };
  }
  if (status === 400 || status === 422) {
    const { erros, alertas } = extrairProblemas(corpo);
    // Envelope CONHECIDO: `validation_error` com `cause` em array. Só
    // esta forma exata pode virar parecer semântico — um 400 de formato
    // desconhecido continua sendo tratado como problema.
    const envelopeValidacaoConhecido =
      !!corpo && corpo.error === "validation_error" && Array.isArray(corpo.cause);
    return { httpStatus: status, aceito: false, erros, alertas, respostaBruta: corpo, envelopeValidacaoConhecido };
  }
  // 401/403/429/5xx não são veredito sobre o payload.
  throw new ErroML(
    `Mercado Livre respondeu ${status} na validação.`,
    classificar(status),
    status,
    corpo
  );
}

// ────────────────────────────────────────────────────────────────────
// UPLOAD DE IMAGEM — `POST /pictures/items/upload` (2026-08-30)
//
// Endpoint OFICIAL, fonte [B] (Working with pictures), literal:
//   "curl -X POST -H 'Authorization: Bearer $ACCESS_TOKEN'
//    -H 'content-type: multipart/form-data' -F 'file=@FILE'
//    https://api.mercadolibre.com/pictures/items/upload"
//   "Note: The endpoint only supports multipart uploads (direct data)"
//   "We recommend using the obtained ID to make a new publication"
//
// NÃO CRIA ANÚNCIO. Cria um recurso de IMAGEM na conta, que é o que a
// própria documentação manda fazer antes de publicar.
// ────────────────────────────────────────────────────────────────────

export interface PictureML {
  id: string;
  maxSize: string | null;
  dominantColor: string | null;
  /** Corpo bruto para auditoria — sem credencial. */
  respostaBruta: unknown;
}

/**
 * Sobe UMA imagem e devolve o `picture id` do Mercado Livre.
 *
 * `content-type` NÃO é definido à mão de propósito: o `fetch` monta o
 * boundary do multipart sozinho a partir do `FormData`, e escrevê-lo
 * manualmente produz um boundary errado e um 400 difícil de diagnosticar.
 *
 * Erros de comunicação sobem como `ErroML`, exatamente como no resto do
 * arquivo: "não conseguimos subir" nunca pode ser lido como "subiu".
 */
export async function subirImagemML(
  conta: ContaMLInterna,
  bytes: Uint8Array,
  nomeArquivo: string,
  mimeType: string
): Promise<PictureML> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let status: number;
  let corpo: any = null;
  try {
    const form = new FormData();
    form.append("file", new Blob([bytes as unknown as BlobPart], { type: mimeType }), nomeArquivo);
    const res = await fetch(`${BASE_ML}/pictures/items/upload`, {
      method: "POST",
      // O único lugar onde o token aparece: o header da requisição.
      headers: { Authorization: `Bearer ${conta.accessToken}`, accept: "application/json" },
      body: form,
      signal: ctrl.signal,
    });
    status = res.status;
    const texto = await res.text();
    if (texto) {
      try { corpo = JSON.parse(texto); } catch { corpo = { raw: texto.slice(0, 2000) }; }
    }
  } catch (err: any) {
    const nome = err?.name ?? "";
    throw new ErroML(
      /abort|timeout/i.test(nome) ? "Tempo esgotado ao enviar a imagem ao Mercado Livre." : "Falha de comunicação ao enviar a imagem.",
      "transient",
      null
    );
  } finally {
    clearTimeout(timer);
  }

  if (status === 200 || status === 201) {
    const id = typeof corpo?.id === "string" ? corpo.id.trim() : "";
    if (!id) {
      // Respondeu OK sem id: não dá para inventar um, e seguir sem ele
      // produziria um payload que referencia imagem inexistente.
      throw new ErroML("O Mercado Livre aceitou a imagem mas não devolveu um picture id.", "resposta", status, corpo);
    }
    return {
      id,
      maxSize: typeof corpo?.max_size === "string" ? corpo.max_size : null,
      dominantColor: typeof corpo?.dominant_color === "string" ? corpo.dominant_color : null,
      respostaBruta: corpo,
    };
  }

  // 400 aqui é recusa da IMAGEM (formato, tamanho), não do anúncio —
  // mas continua sendo falha de upload, nunca sucesso.
  throw new ErroML(
    `Mercado Livre respondeu ${status} ao receber a imagem.`,
    classificar(status),
    status,
    corpo
  );
}

// ────────────────────────────────────────────────────────────────────
// PUBLICAÇÃO REAL — `POST /items` (2026-08-31)
//
// A única operação deste módulo que CRIA um anúncio público. Tudo o que
// vem antes existe para que ela seja segura.
//
// NÃO HÁ IDEMPOTÊNCIA OFICIAL. A documentação do Mercado Livre não
// descreve `Idempotency-Key`, `X-Request-Id` nem equivalente para
// `POST /items` (verificado nas fontes [A] e [C] em 2026-08-31), e
// inventar um cabeçalho que o servidor ignora daria uma falsa sensação
// de proteção. Por isso a proteção é NOSSA: reserva no banco antes de
// chamar, e reconciliação por busca quando a resposta é ambígua.
// ────────────────────────────────────────────────────────────────────

/** Desfecho de um `POST /items`, incluindo o caso "não sei". */
export type ResultadoPublicacaoML =
  | { desfecho: "criado"; httpStatus: number; item: Record<string, any> }
  | { desfecho: "recusado"; httpStatus: number; erros: ProblemaML[]; alertas: ProblemaML[]; respostaBruta: unknown }
  /**
   * A requisição saiu e não sabemos o que aconteceu do outro lado. É
   * DIFERENTE de "recusado": o item pode existir. Reenviar aqui é o que
   * cria o segundo anúncio.
   */
  | { desfecho: "incerto"; httpStatus: number | null; motivo: string; respostaBruta: unknown };

/**
 * Cria o anúncio. **Uma chamada, sem retry.**
 *
 * O `catch` não relança `ErroML` como o resto do arquivo faz de
 * propósito: aqui, "falhou a comunicação" não é uma conclusão utilizável
 * — o pedido pode ter chegado. Um 5xx ou um timeout viram `incerto`, e
 * quem chama precisa reconciliar antes de qualquer nova tentativa.
 *
 * 401/403/429 são a exceção: nesses o servidor rejeitou ANTES de
 * processar, então nada foi criado e classificá-los como incertos só
 * travaria o canal sem motivo.
 */
export async function publicarItemML(
  conta: ContaMLInterna,
  payload: Record<string, unknown>
): Promise<ResultadoPublicacaoML> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let status: number;
  let corpo: any = null;
  try {
    const res = await fetch(`${BASE_ML}/items`, {
      method: "POST",
      headers: {
        // O único lugar onde o token aparece: o header da requisição.
        Authorization: `Bearer ${conta.accessToken}`,
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    status = res.status;
    const texto = await res.text();
    if (texto) {
      try { corpo = JSON.parse(texto); } catch { corpo = { raw: texto.slice(0, 4000) }; }
    }
  } catch (err: any) {
    const nome = err?.name ?? "";
    const timeout = /abort|timeout/i.test(nome);
    return {
      desfecho: "incerto",
      httpStatus: null,
      motivo: timeout
        ? "tempo esgotado esperando o Mercado Livre — a requisição pode ter sido processada"
        : "falha de rede depois do envio — a requisição pode ter sido processada",
      respostaBruta: null,
    };
  } finally {
    clearTimeout(timer);
  }

  if (status === 200 || status === 201) {
    const id = typeof corpo?.id === "string" ? corpo.id.trim() : "";
    if (!id) {
      // Respondeu sucesso sem id: o item provavelmente existe e não
      // sabemos qual é. É o caso mais perigoso para "tentar de novo".
      return { desfecho: "incerto", httpStatus: status, motivo: "o Mercado Livre respondeu sucesso sem devolver o id do item", respostaBruta: corpo };
    }
    return { desfecho: "criado", httpStatus: status, item: corpo };
  }

  if (status === 400 || status === 422) {
    // Recusa estruturada: o item NÃO foi criado.
    const { erros, alertas } = extrairProblemas(corpo);
    return { desfecho: "recusado", httpStatus: status, erros, alertas, respostaBruta: corpo };
  }

  if (status === 401 || status === 403 || status === 429) {
    // Rejeitado antes de processar — nada foi criado.
    return {
      desfecho: "recusado",
      httpStatus: status,
      erros: [{ codigo: `http_${status}`, mensagem: `Mercado Livre respondeu ${status} sem processar o anúncio.`, campo: null, tipo: "error" }],
      alertas: [],
      respostaBruta: corpo,
    };
  }

  // 5xx e qualquer coisa fora do contrato: pode ter criado.
  return {
    desfecho: "incerto",
    httpStatus: status,
    motivo: `o Mercado Livre respondeu ${status} — o anúncio pode ter sido criado`,
    respostaBruta: corpo,
  };
}

/** Item real, para conferir o que foi criado contra o que foi enviado. */
export async function buscarItemML(conta: ContaMLInterna, itemId: string): Promise<Record<string, any> | null> {
  const { status, corpo } = await chamar(`/items/${encodeURIComponent(itemId)}`, conta.accessToken);
  if (status === 200) return corpo;
  if (status === 404) return null;
  throw new ErroML(`Mercado Livre respondeu ${status} ao consultar o item.`, classificar(status), status, corpo);
}

/**
 * Ids dos anúncios da conta — a base da RECONCILIAÇÃO.
 *
 * Comparando a lista de antes com a de depois de um envio ambíguo, dá
 * para descobrir se o item nasceu, **sem** arriscar criar outro.
 */
export async function listarItensDaContaML(conta: ContaMLInterna, limite = 50): Promise<string[]> {
  const { status, corpo } = await chamar(
    `/users/${encodeURIComponent(conta.sellerId)}/items/search?orders=start_time_desc&limit=${limite}`,
    conta.accessToken
  );
  if (status !== 200) {
    throw new ErroML(`Mercado Livre respondeu ${status} ao listar os anúncios da conta.`, classificar(status), status, corpo);
  }
  return Array.isArray(corpo?.results) ? corpo.results.filter((x: unknown) => typeof x === "string") : [];
}
