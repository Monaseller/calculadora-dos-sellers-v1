/**
 * A Function EXTERNA, na gramatica da CDS — AGENT-FACTORY-F7b.4.
 *
 * ── O problema ──────────────────────────────────────────────────────
 *
 * O guard da CDS decide por `funcao_id`, e a tabela de permissoes tem um
 * CHECK de formato:
 *
 *   ^[a-z0-9]+(\.[a-z0-9_]+)+$
 *
 * O Composio nomeia as acoes em MAIUSCULA: `GOOGLESHEETS_ADD_SHEET`. Esse
 * nome nao passa no CHECK, e portanto nao pode ser gravado como
 * permissao. Sem um id canonico, uma ferramenta externa nao teria onde
 * guardar o nivel que o dono escolheu — e sem nivel gravado ela nao
 * poderia participar da regra de completude da ativacao.
 *
 * ── A decisao ───────────────────────────────────────────────────────
 *
 *   composio.<toolkit>.<acao>     tudo em minuscula
 *
 * Tres segmentos, e cada um carrega uma informacao que o guard e a tela
 * precisam ler sem consultar o Composio: o PROVEDOR externo, o TOOLKIT
 * (que e o que exige conexao) e a ACAO (que e o que tem risco de escrita).
 *
 * O prefixo `composio` nao e decoracao: ele e o que faz uma Function
 * externa ser reconhecivel por inspecao. `planilha.ler` e interna,
 * `composio.googlesheets.*` nao e, e nenhuma das duas precisa de um campo
 * extra para dizer isso.
 *
 * ── Por que NAO duplicar o registry ─────────────────────────────────
 *
 * `FUNCOES` mapeia id -> executor, e um executor externo nao mora la: ele
 * e uma chamada HTTP ao Composio, nao um modulo. O que o guard precisa
 * nao e o executor — e um FATO: "esta Function existe". `autorizarFuncao`
 * recebe `funcoes: FatoFuncao[]`, uma LISTA, e nao consulta `FUNCOES`.
 *
 * Por isso a Function externa entra no MESMO guard, com a MESMA tabela de
 * permissoes, sem um segundo registry e sem um segundo caminho de
 * autorizacao. O que muda depois do guard e so quem executa.
 *
 * ── Este modulo e PURO ──────────────────────────────────────────────
 *
 * Sem rede, sem env, sem banco. Traduz nomes nos dois sentidos.
 */

/** O provedor externo, e o primeiro segmento do id. */
export const PREFIXO_EXTERNO = "composio";

/**
 * Um segmento valido do CHECK depois do primeiro: `[a-z0-9_]+`.
 *
 * Note que `-` NAO e aceito, e alguns slugs do Composio o usam
 * (`hub_planner` nao, mas `google-super` poderia). A normalizacao troca
 * por `_`, e `ehIdExterno` continua reconhecendo o resultado — o que
 * garante que ida e volta sejam consistentes.
 */
function normalizarSegmento(bruto: string): string {
  return bruto
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export interface PecasDaFuncaoExterna {
  readonly toolkit: string;
  readonly acao: string;
}

export type ComposicaoDeId =
  | { readonly ok: true; readonly funcaoId: string }
  | { readonly ok: false; readonly motivo: string };

/**
 * `googlesheets` + `GOOGLESHEETS_ADD_SHEET` ->
 * `composio.googlesheets.googlesheets_add_sheet`
 *
 * Recusa em vez de produzir um id degradado: um id que nao passa no CHECK
 * do banco falharia na hora de gravar a permissao, e falhar ali e muito
 * mais longe da causa.
 */
export function idDaFuncaoExterna(pecas: PecasDaFuncaoExterna): ComposicaoDeId {
  const toolkit = normalizarSegmento(pecas.toolkit ?? "");
  const acao = normalizarSegmento(pecas.acao ?? "");
  if (toolkit === "") return { ok: false, motivo: "toolkit_invalido" };
  if (acao === "") return { ok: false, motivo: "acao_invalida" };

  const id = `${PREFIXO_EXTERNO}.${toolkit}.${acao}`;
  // Confere contra o MESMO formato do banco. Sem isto, uma mudanca na
  // normalizacao poderia gerar id aceito aqui e recusado no INSERT.
  if (!FORMATO_DO_BANCO.test(id)) return { ok: false, motivo: "formato_invalido" };
  return { ok: true, funcaoId: id };
}

/**
 * O CHECK do banco, repetido aqui de proposito.
 *
 * Duplicar uma regra e normalmente ruim; nao duplicar esta seria pior. O
 * CHECK vive em SQL e nao e importavel; sem uma copia validada, o codigo
 * descobriria a incompatibilidade no INSERT, com a permissao do dono
 * perdida no caminho. A suite cobra que as duas sejam a mesma expressao.
 */
export const FORMATO_DO_BANCO = /^[a-z0-9]+(\.[a-z0-9_]+)+$/;

/** `true` para Function de catalogo externo. Reconhecivel por inspecao. */
export function ehFuncaoExterna(funcaoId: unknown): boolean {
  return typeof funcaoId === "string" &&
    funcaoId.startsWith(`${PREFIXO_EXTERNO}.`) &&
    FORMATO_DO_BANCO.test(funcaoId) &&
    funcaoId.split(".").length === 3;
}

/**
 * Volta do id canonico para as pecas.
 *
 * `null` para id interno ou malformado — quem chama nao pode tratar
 * `planilha.ler` como se tivesse toolkit.
 */
export function pecasDoId(funcaoId: unknown): PecasDaFuncaoExterna | null {
  if (!ehFuncaoExterna(funcaoId)) return null;
  const [, toolkit, acao] = (funcaoId as string).split(".");
  return { toolkit, acao };
}

// ─── Risco: leitura, escrita, desconhecido ────────────────────────────

export const RISCOS = Object.freeze(["leitura", "escrita", "desconhecido"] as const);
export type RiscoDaAcao = (typeof RISCOS)[number];

/**
 * Verbos que denunciam ESCRITA no slug da acao.
 *
 * O catalogo do Composio nao publica um campo "read/write" confiavel, e
 * inventar um seria pior que admitir a duvida. O que ele publica e um
 * slug em que o verbo vem primeiro — `GOOGLESHEETS_ADD_SHEET`,
 * `GMAIL_SEND_EMAIL` — e isso da um sinal honesto.
 */
const VERBOS_DE_ESCRITA: readonly string[] = Object.freeze([
  "add", "append", "create", "insert", "update", "patch", "write", "set",
  "delete", "remove", "clear", "send", "post", "upload", "move", "copy",
  "rename", "archive", "trash", "batch_update", "replace", "duplicate",
  "enable", "disable", "revoke", "grant", "invite", "assign", "merge",
]);

/** Verbos que denunciam LEITURA. So valem quando nenhum de escrita casa. */
const VERBOS_DE_LEITURA: readonly string[] = Object.freeze([
  "get", "list", "read", "find", "search", "fetch", "describe", "lookup",
  "count", "check", "info", "export", "download", "query",
]);

/**
 * Classifica a acao pelo slug.
 *
 * `desconhecido` e um desfecho de primeira classe, e nao uma falha: §11
 * manda exigir aprovacao quando nao da para classificar com seguranca. O
 * que NAO pode acontecer e uma acao de escrita ser rotulada como leitura
 * e ganhar autonomia por engano — por isso ESCRITA vence em caso de
 * empate.
 */
export function riscoDaAcao(acaoSlug: string): RiscoDaAcao {
  const partes = normalizarSegmento(acaoSlug).split("_").filter((p) => p !== "");
  if (partes.length === 0) return "desconhecido";

  // Escrita primeiro: `GET_AND_UPDATE` e escrita, nao leitura.
  for (const p of partes) {
    if (VERBOS_DE_ESCRITA.includes(p)) return "escrita";
  }
  for (const p of partes) {
    if (VERBOS_DE_LEITURA.includes(p)) return "leitura";
  }
  return "desconhecido";
}

/**
 * O nivel RECOMENDADO para uma acao externa.
 *
 * Nunca `automatico` para escrita nem para desconhecido — §11 e §18. A
 * recomendacao e o que a tela pre-seleciona; quem decide continua sendo o
 * dono, e a decisao dele e o que o guard le.
 */
export function nivelRecomendado(risco: RiscoDaAcao): "automatico" | "aprovacao" {
  return risco === "leitura" ? "automatico" : "aprovacao";
}
