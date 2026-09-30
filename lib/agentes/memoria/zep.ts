import "server-only";

/**
 * O cliente do Zep — AGENT-FACTORY-F7b.4.
 *
 * ── REST puro, e por que nao o SDK ──────────────────────────────────
 *
 * As quatro operacoes de que a CDS precisa — garantir user, garantir
 * thread, adicionar mensagens, ler contexto — sao quatro chamadas HTTP.
 * Medidas contra a API real antes de escrever este arquivo:
 *
 *   POST /users                      -> 201
 *   POST /threads                    -> 201
 *   POST /threads/{id}/messages      -> 201 {message_uuids}
 *   GET  /threads/{id}/context       -> 200 {context}
 *
 * Um SDK traria um cliente de grafo, tipos gerados e um caminho de
 * atualizacao proprio para resolver isso. O repositorio ja fala REST com
 * o Google por escolha; manter o mesmo padrao aqui evita uma dependencia
 * de 13 para 14 sem ganho.
 *
 * ── Dois detalhes que so a medicao revelou ──────────────────────────
 *
 *   1. auth e `Authorization: Api-Key <chave>`. `Bearer` e `x-api-key`
 *      respondem 401.
 *   2. `User-Agent` e OBRIGATORIO. Sem ele a borda responde
 *      `403 error code 1010`, que parece credencial invalida e nao e —
 *      alguem perderia horas trocando a chave.
 *
 * ── A chave nao sai do servidor ─────────────────────────────────────
 *
 * `server-only` no topo faz o build falhar se um componente de cliente
 * importar este arquivo. A chave e lida aqui e em nenhum outro lugar, e
 * nenhuma mensagem de erro daqui a inclui.
 *
 * ── Falha do Zep nao derruba o chat ─────────────────────────────────
 *
 * Toda funcao devolve desfecho em vez de lancar. Memoria e melhoria de
 * resposta, nao pre-requisito dela: se o Zep estiver fora, o agente
 * responde sem contexto de longo prazo e o turno segue. O que NAO
 * acontece e inventar memoria — sem resposta do Zep, o contexto vai
 * vazio, nunca imaginado.
 */

const BASE = "https://api.getzep.com/api/v2";

/**
 * Identificacao do chamador.
 *
 * Obrigatoria pela borda do Zep (ver cabecalho). O valor nomeia a
 * aplicacao, nunca o usuario.
 */
const USER_AGENT = "cds-agent-factory/1.0";

/**
 * Orcamento por chamada.
 *
 * Curto de proposito: memoria entra no caminho da resposta do chat, e uma
 * espera longa aqui viraria uma espera longa para quem digitou. Preferir
 * responder sem memoria a responder tarde.
 */
const TIMEOUT_MS = 8000;

/** Desfecho de toda operacao. Nunca lanca para fora. */
export type ResultadoZep<T> =
  | { readonly estado: "ok"; readonly dados: T }
  | { readonly estado: "nao_configurado" }
  | { readonly estado: "falha"; readonly codigo: string };

function chave(): string | null {
  const v = process.env.ZEP_API_KEY;
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

/** `true` quando ha credencial. Nao revela nada sobre o valor. */
export function memoriaConfigurada(): boolean {
  return chave() !== null;
}

/**
 * Uma chamada ao Zep.
 *
 * `codigo` e classificado e curto: nunca o corpo da resposta, que pode
 * ecoar conteudo de conversa.
 */
async function chamar<T>(
  metodo: "GET" | "POST",
  caminho: string,
  corpo?: unknown
): Promise<ResultadoZep<T>> {
  const k = chave();
  if (k === null) return { estado: "nao_configurado" };

  const controle = new AbortController();
  const relogio = setTimeout(() => controle.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(BASE + caminho, {
      method: metodo,
      headers: {
        Authorization: `Api-Key ${k}`,
        "User-Agent": USER_AGENT,
        Accept: "application/json",
        ...(corpo !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: corpo !== undefined ? JSON.stringify(corpo) : undefined,
      signal: controle.signal,
      cache: "no-store",
    });

    if (!r.ok) {
      // ── "ja existe" chega como 400, nao como 409 ──────────────────
      //
      // Medido contra a API: recriar um user devolve
      //   400 {"message":"bad request: user already exists with user_id: ..."}
      // e recriar um thread devolve
      //   400 {"message":"bad request: session with id ... already exists"}
      //
      // A primeira versao deste cliente tratava so `409`, e por isso a
      // SEGUNDA conversa de cada agente falhava inteira: `garantirPrincipal`
      // rodava de novo, levava 400, e a ingestao abortava. O sintoma era
      // "cross-chat nao funciona"; a causa era um codigo de status.
      //
      // O reconhecimento e pelas PALAVRAS do servidor, e nao pelo status
      // sozinho: aceitar todo 400 como sucesso esconderia erro de
      // validacao de verdade — payload torto passaria por idempotencia.
      if (r.status === 400) {
        const corpoErro = await r.text().catch(() => "");
        if (/already exists/i.test(corpoErro)) {
          return { estado: "falha", codigo: "ja_existe" };
        }
        return { estado: "falha", codigo: "http_400" };
      }
      return { estado: "falha", codigo: `http_${r.status}` };
    }
    const texto = await r.text();
    if (texto.trim() === "") return { estado: "ok", dados: null as T };
    try {
      return { estado: "ok", dados: JSON.parse(texto) as T };
    } catch {
      return { estado: "falha", codigo: "resposta_ilegivel" };
    }
  } catch (err) {
    const nome = (err as { name?: string }).name;
    return { estado: "falha", codigo: nome === "AbortError" ? "timeout" : "rede" };
  } finally {
    clearTimeout(relogio);
  }
}

/**
 * "Ja existe" e o estado DESEJADO de uma garantia.
 *
 * Separado num predicado porque as duas garantias precisam da mesma
 * regra, e porque o dia em que a API passar a responder 409 de verdade
 * este e o unico lugar a mudar.
 */
function ehJaExiste(codigo: string): boolean {
  return codigo === "ja_existe" || codigo === "http_409";
}

/**
 * Garante que o principal existe.
 *
 * Idempotente por contrato: "ja existe" e exatamente o estado desejado.
 * Tratar isso como falha faria a SEGUNDA conversa de todo agente parecer
 * quebrada — foi o defeito que a prova de cross-chat pegou.
 *
 * O `metadata` NAO leva `userId` nem `agenteId` do CDS. O principal ja e
 * derivado deles, e repetir os ids em claro entregaria a um servico
 * externo exatamente a topologia que a derivacao esconde.
 */
export async function garantirPrincipal(principal: string): Promise<ResultadoZep<null>> {
  const r = await chamar<unknown>("POST", "/users", {
    user_id: principal,
    metadata: { origem: "cds-agent-factory" },
  });
  if (r.estado === "falha" && ehJaExiste(r.codigo)) return { estado: "ok", dados: null };
  return r.estado === "ok" ? { estado: "ok", dados: null } : r;
}

/** Garante o thread daquela conversa, ligado ao principal. Idempotente. */
export async function garantirThread(
  thread: string,
  principal: string
): Promise<ResultadoZep<null>> {
  const r = await chamar<unknown>("POST", "/threads", {
    thread_id: thread,
    user_id: principal,
  });
  if (r.estado === "falha" && ehJaExiste(r.codigo)) return { estado: "ok", dados: null };
  return r.estado === "ok" ? { estado: "ok", dados: null } : r;
}

export interface MensagemParaMemoria {
  readonly papel: "user" | "assistant";
  readonly conteudo: string;
}

/** Adiciona mensagens ao thread. Quem decide o QUE entra e a policy. */
export async function adicionarMensagens(
  thread: string,
  mensagens: readonly MensagemParaMemoria[]
): Promise<ResultadoZep<number>> {
  if (mensagens.length === 0) return { estado: "ok", dados: 0 };
  const r = await chamar<{ message_uuids?: unknown[] }>(
    "POST", `/threads/${encodeURIComponent(thread)}/messages`,
    { messages: mensagens.map((m) => ({ role: m.papel, content: m.conteudo })) }
  );
  if (r.estado !== "ok") return r;
  const ids = r.dados?.message_uuids;
  return { estado: "ok", dados: Array.isArray(ids) ? ids.length : 0 };
}

/**
 * O contexto relevante para o proximo turno.
 *
 * O Zep devolve uma STRING ja montada (`<USER_SUMMARY>` + `<EPISODES>`),
 * e nao uma lista de fatos. Isso e conveniente e tem uma consequencia que
 * importa: o que volta e TEXTO, e texto e contexto — nunca autoridade.
 * Quem garante isso e o composer do contexto, que o coloca num bloco
 * proprio, abaixo das regras do sistema.
 */
export async function lerContexto(thread: string): Promise<ResultadoZep<string | null>> {
  const r = await chamar<{ context?: unknown }>(
    "GET", `/threads/${encodeURIComponent(thread)}/context`);
  if (r.estado !== "ok") return r;
  const c = r.dados?.context;
  return { estado: "ok", dados: typeof c === "string" && c.trim() !== "" ? c : null };
}

/** Os threads de um principal. Usado por diagnostico e pela prova de isolamento. */
export async function listarThreadsDoPrincipal(
  principal: string
): Promise<ResultadoZep<readonly string[]>> {
  const r = await chamar<unknown>(
    "GET", `/users/${encodeURIComponent(principal)}/threads`);
  if (r.estado !== "ok") return r;
  const lista = Array.isArray(r.dados) ? r.dados : [];
  const ids: string[] = [];
  for (const t of lista) {
    const id = (t as { thread_id?: unknown }).thread_id;
    if (typeof id === "string") ids.push(id);
  }
  return { estado: "ok", dados: ids };
}
