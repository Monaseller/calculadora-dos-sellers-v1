/**
 * O catalogo de APIs dos agentes — F9.2-A.
 *
 * ── API != Tool ─────────────────────────────────────────────────────
 *
 *   API_PROVIDER       a integracao (Mercado Livre, Shopee). Vive AQUI.
 *   API_CONNECTION     a conta/loja autenticada daquele provider. NAO e
 *                      tabela nova: e a linha de `lojas` que o OAuth da
 *                      CDS ja cria, filtrada por `marketplace`.
 *   API_CAPABILITY     a acao concreta. Vive AQUI, e aponta para UMA
 *                      Funcao REAL do registry (`funcaoId`).
 *   AGENT_API_ACCESS   a capability liberada para um agente, numa conta:
 *                      `agente_permissoes` (por `funcao_id`) mais
 *                      `agente_conexoes` (a loja, por recurso). Sem tabela
 *                      nova, sem segunda permissao.
 *   TOOL               ferramenta interna (Planilhas, Calculadora...). Os
 *                      Tool Packs de `catalogo-ui.ts` que NAO sao alias de
 *                      provider.
 *
 * Quatro conceitos, zero tabelas novas: o MINIMUM CHANGE aprovado.
 *
 * ── So o que funciona ───────────────────────────────────────────────
 *
 * Uma capability so entra aqui quando ha backend real que a executa para
 * agentes. Responder pergunta, ler/responder mensagem, alterar estoque ou
 * preco NAO existem ainda — e por isso NAO aparecem, nem como
 * "indisponivel". Shopee existe como provider (a conta e real), mas sem
 * capability: a tela diz "Ainda nao disponivel para agentes".
 *
 * ── Fechado ─────────────────────────────────────────────────────────
 *
 * As buscas sao por igualdade em listas congeladas. Um `funcaoId` que nao
 * esta aqui nao vira capability por prefixo ("mercadolivre.*"), e um
 * provider desconhecido devolve `null` — nunca um provider "parecido".
 *
 * ── Este modulo e PURO ──────────────────────────────────────────────
 *
 * Sem `server-only`, sem banco, sem rede: a UI le os nomes daqui, e a
 * suite do F9.2 prova a coerencia com o registry (que e server-only).
 * Provider futuro (inclusive API personalizada) e mais uma entrada com
 * outra `origemDaConexao` — nada aqui supoe que toda conexao seja `lojas`.
 */
import { TOOL_PACKS, type ToolPack } from "@/lib/agentes/factory/catalogo-ui";

export type IdProvedorDeApi = "mercado_livre" | "shopee";

export interface ProvedorDeApi {
  readonly id: IdProvedorDeApi;
  readonly nome: string;
  /** `agente_conexoes.plataforma` e `RequisitoConexaoFuncao.plataforma`. */
  readonly plataforma: string;
  /** `lojas.marketplace` das contas deste provider. */
  readonly marketplace: "ML" | "Shopee";
  /** De onde vem a conexao. Hoje so o OAuth da CDS em `lojas`. */
  readonly origemDaConexao: "lojas_oauth_cds";
  /**
   * Tool Packs PERSISTIDOS que, no dominio novo, sao este provider.
   * Compatibilidade: `agente_permissoes` e ofertas antigas guardam o id do
   * pack. Nao dirigem o modelo — so traduzem.
   */
  readonly aliasesLegados: readonly string[];
  /** Frase da tela quando nao ha capability para agentes. */
  readonly textoSemCapacidade: string | null;
}

export type EfeitoDaCapacidade = "leitura" | "escrita";
export type StatusDaCapacidade = "disponivel";

export interface CapacidadeDeApi {
  /** Identidade da capability = `funcaoId` da Funcao real. Sem traducao. */
  readonly id: string;
  readonly provedor: IdProvedorDeApi;
  readonly funcaoId: string;
  /** O recurso da conexao (`agente_conexoes.recurso`). Igual ao registry. */
  readonly recurso: string;
  /** Igual ao `acesso` da Funcao no registry. */
  readonly efeito: EfeitoDaCapacidade;
  readonly status: StatusDaCapacidade;
  readonly nome: string;
  readonly descricao: string;
}

export const TEXTO_SEM_CAPACIDADE_PARA_AGENTES = "Ainda não disponível para agentes";

export const PROVEDORES_DE_API: readonly ProvedorDeApi[] = Object.freeze([
  Object.freeze({
    id: "mercado_livre",
    nome: "Mercado Livre",
    plataforma: "mercado_livre",
    marketplace: "ML",
    origemDaConexao: "lojas_oauth_cds",
    // O id historico do pack. Ver o comentario em `catalogo-ui.ts`: ele
    // esta gravado e nao muda.
    aliasesLegados: Object.freeze(["mercadolivre-perguntas"]),
    textoSemCapacidade: null,
  }),
  Object.freeze({
    id: "shopee",
    nome: "Shopee",
    plataforma: "shopee",
    marketplace: "Shopee",
    // A MESMA conexao da CDS (OAuth da Shopee -> `lojas`). Nenhuma segunda
    // integracao: o agente so passa a enxergar a conta que ja existe.
    origemDaConexao: "lojas_oauth_cds",
    aliasesLegados: Object.freeze([]),
    textoSemCapacidade: TEXTO_SEM_CAPACIDADE_PARA_AGENTES,
  }),
] as ProvedorDeApi[]);

export const CAPACIDADES_DE_API: readonly CapacidadeDeApi[] = Object.freeze([
  Object.freeze({
    id: "mercadolivre.perguntas.listar",
    provedor: "mercado_livre",
    funcaoId: "mercadolivre.perguntas.listar",
    recurso: "perguntas",
    efeito: "leitura",
    status: "disponivel",
    nome: "Listar perguntas",
    descricao: "Listar as perguntas recebidas na conta, por status.",
  }),
  Object.freeze({
    id: "mercadolivre.vendas.consultar",
    provedor: "mercado_livre",
    funcaoId: "mercadolivre.vendas.consultar",
    recurso: "vendas",
    efeito: "leitura",
    status: "disponivel",
    nome: "Consultar vendas",
    descricao: "Vendas brutas, vendas e unidades de um período, direto do Mercado Livre.",
  }),
] as CapacidadeDeApi[]);

// ─── Buscas FECHADAS ──────────────────────────────────────────────────

export function provedorPorId(id: unknown): ProvedorDeApi | null {
  if (typeof id !== "string") return null;
  return PROVEDORES_DE_API.find((p) => p.id === id) ?? null;
}

export function provedorDaPlataforma(plataforma: unknown): ProvedorDeApi | null {
  if (typeof plataforma !== "string") return null;
  return PROVEDORES_DE_API.find((p) => p.plataforma === plataforma) ?? null;
}

export function capacidadesDoProvedor(id: IdProvedorDeApi): readonly CapacidadeDeApi[] {
  return CAPACIDADES_DE_API.filter((c) => c.provedor === id);
}

/** A capability de uma Funcao — por IGUALDADE. Sem prefixo, sem palpite. */
export function capacidadeDaFuncao(funcaoId: unknown): CapacidadeDeApi | null {
  if (typeof funcaoId !== "string") return null;
  return CAPACIDADES_DE_API.find((c) => c.funcaoId === funcaoId) ?? null;
}

/** O provider tem alguma capability pronta para agentes? */
export function provedorDisponivelParaAgentes(id: IdProvedorDeApi): boolean {
  return capacidadesDoProvedor(id).some((c) => c.status === "disponivel");
}

// ─── Compatibilidade com Tool Packs persistidos ───────────────────────

/** O provider que um pack ANTIGO representa; `null` = nao e API. */
export function provedorDoPackLegado(packId: unknown): ProvedorDeApi | null {
  if (typeof packId !== "string") return null;
  return PROVEDORES_DE_API.find((p) => p.aliasesLegados.includes(packId)) ?? null;
}

export function ehAliasDeApi(packId: unknown): boolean {
  return provedorDoPackLegado(packId) !== null;
}

/** As TOOLS: Tool Packs que nao sao alias de provider de API. */
export const TOOLS_INTERNAS: readonly ToolPack[] = Object.freeze(
  TOOL_PACKS.filter((p) => !ehAliasDeApi(p.id))
);

export function ehTool(packId: unknown): boolean {
  return typeof packId === "string" && TOOLS_INTERNAS.some((t) => t.id === packId);
}
