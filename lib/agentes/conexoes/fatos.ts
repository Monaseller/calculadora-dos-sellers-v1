/**
 * Leitura autorizada de conexao -> `FatoConexao` — SKILL-1D.c.
 *
 * ── A fronteira que este modulo existe para ser ─────────────────────
 *
 *   credencial entra aqui  ->  vira boolean  ->  o segredo morre nesta linha
 *
 * A coluna `access_token` e projetada porque a regra precisa saber se ha
 * credencial, e nao da para distinguir "linha sem token" de "linha
 * inexistente" filtrando por `is not null`. Mas o VALOR nunca sai daqui:
 * ele e reduzido a `temAccessToken` antes de qualquer outra coisa
 * acontecer, e `LinhaConexao` — o tipo que atravessa para a regra — nao
 * tem campo onde ele caberia.
 *
 * `refresh_token`, `partner_key`, `seller_id` e `shop_id` nem chegam a
 * ser projetados. Nenhum participa da decisao de estado.
 *
 * ── Autoridade ──────────────────────────────────────────────────────
 *
 * `(id, user_id)` na PROPRIA instrucao, nunca comparacao em memoria
 * depois de ler. Loja de outro dono nao volta — e a resposta e
 * indistinguivel de loja inexistente, de proposito: distinguir viraria
 * um oraculo de existencia de ids alheios. Mesma decisao ja tomada em
 * `criarTarefa`, onde FK violada nao diferencia "agente inexistente" de
 * "agente de outro dono".
 *
 * `seller_id` e `shop_id` NAO sao autoridade. O mesmo seller externo
 * pode pertencer a donos CDS diferentes — a migration
 * `20260826_lojas_autoridade_dono.sql` fixou isso por escrito.
 *
 * ── Por que uma projecao propria, e nao um helper existente ─────────
 *
 * `lerCredencialMLPorLojaEDono` e `lerCredencialShopeeDoDono` resolvem
 * pelo par certo, mas projetam o que esta fase nao precisa e nao quer:
 * `seller_id`, `refresh_token`, `shop_id`, `partner_id`, `partner_key`.
 * `lerLojaParaValidacaoDeJob` projeta pouco demais (sem token, sem
 * validade). Alterar qualquer um deles seria mexer em producao
 * preexistente. A consulta abaixo le CINCO colunas e nenhuma a mais.
 *
 * ── O que este modulo NAO faz ───────────────────────────────────────
 *
 * Nao renova token, nao executa OAuth, nao chama marketplace, nao
 * escreve, nao persiste capability e nao inventa escopo. Refresh e acao
 * futura: ter `refresh_token` nao torna a conexao valida AGORA.
 */
import "server-only";
import { getSupabaseServidor } from "@/lib/estudio-anuncios/supabase-servidor";
import {
  MARKETPLACE_POR_PLATAFORMA,
  montarFatoConexao,
  type LinhaConexao,
} from "@/lib/agentes/conexoes/estado";
import type { FatoConexao } from "@/lib/ia/skills/diagnostico";

/**
 * Projecao MINIMA. Cinco colunas.
 *
 * `marketplace` entra para conferir a plataforma contra o dado real: o
 * chamador nao decide de que plataforma a loja e.
 */
const COLUNAS = "id, marketplace, ativo, access_token, token_expires_at";

/**
 * O que o resolvedor recebe.
 *
 * `userId` e `lojaId` sao CONTEXTO — vem da sessao e da selecao ja
 * autorizada pela camada de cima. `plataforma` e `recurso` sao o
 * REQUISITO, e vem da Skill. A separacao importa: requisito nunca vira
 * autoridade.
 *
 * `agoraMs` entra por parametro para que a resolucao seja deterministica
 * e testavel em qualquer data. Nao ha `Date.now()` neste modulo.
 *
 * Nao ha, e nao pode haver, `access_token`, `refresh_token`,
 * `partner_key`, `seller_id` nem `shop_id` na entrada: nada disso e
 * fornecido de fora.
 */
export interface EntradaFatoConexao {
  userId: string;
  lojaId: string;
  plataforma: string;
  recurso: string;
  agoraMs: number;
}

/**
 * Como a coleta terminou — separado do fato, de proposito.
 *
 *   ok             ha linha autorizada; `fato` preenchido
 *   ausente        nao ha linha autorizada para este par
 *   falha_leitura  o banco nao respondeu
 *
 * `falha_leitura` NAO e `ausente`, e confundi-los seria o pior desfecho
 * possivel: um banco fora do ar viraria "voce nao tem essa conexao", e a
 * SKILL-1C derivaria `FALTA_CONEXAO` de uma verdade que ninguem apurou.
 * Quem chama decide o que fazer — mas nao consegue mais confundir.
 *
 * O envelope `{ fatos, coleta }` do agregador e fase posterior; aqui a
 * forma minima que preserva a distincao ja basta.
 */
export type ColetaConexao = "ok" | "ausente" | "falha_leitura";

export interface ResultadoFatoConexao {
  fato: FatoConexao | null;
  coleta: ColetaConexao;
}

const AUSENTE: ResultadoFatoConexao = { fato: null, coleta: "ausente" };

/**
 * Resolve UMA conexao ja selecionada.
 *
 * Nao escolhe loja: com varias contas da mesma plataforma, escolher "a
 * primeira conectada" seria decidir pelo dono qual conta sofre o efeito.
 * A selecao pertence a camada de cima, e chega aqui como `lojaId`.
 */
export async function resolverFatoConexao(
  entrada: EntradaFatoConexao
): Promise<ResultadoFatoConexao> {
  const { userId, lojaId, plataforma, recurso, agoraMs } = entrada;
  if (!userId || !lojaId || !plataforma || !recurso) return AUSENTE;

  // Plataforma desconhecida nao resolve. Antes da consulta: nao ha por
  // que tocar o banco para um requisito que este codigo nao sabe mapear.
  const marketplaceEsperado = Object.prototype.hasOwnProperty.call(
    MARKETPLACE_POR_PLATAFORMA,
    plataforma
  )
    ? MARKETPLACE_POR_PLATAFORMA[plataforma]
    : null;
  if (marketplaceEsperado === null) return AUSENTE;

  const { data, error } = await getSupabaseServidor()
    .from("lojas")
    .select(COLUNAS)
    .eq("id", lojaId)
    .eq("user_id", String(userId))
    .maybeSingle();

  if (error) {
    // Sem `error.message`: mensagem de driver vaza nome de coluna, de
    // constraint e as vezes de valor, e acaba em log e em resposta HTTP.
    console.error("[conexoes] falha ao ler conexao do dono");
    return { fato: null, coleta: "falha_leitura" };
  }
  if (data === null) return AUSENTE;

  const linhaBruta = data as Record<string, unknown>;

  // Plataforma pedida != plataforma real -> ausencia, e nao um fato
  // "invalido". Responder qualquer outra coisa transformaria a funcao
  // num oraculo: bastaria variar `plataforma` para descobrir de que
  // marketplace e uma loja cujo id se conhece.
  if (linhaBruta.marketplace !== marketplaceEsperado) return AUSENTE;

  // ── A LINHA EM QUE O SEGREDO MORRE ────────────────────────────────
  const linha: LinhaConexao = {
    marketplace: String(linhaBruta.marketplace),
    ativo: typeof linhaBruta.ativo === "boolean" ? linhaBruta.ativo : null,
    temAccessToken:
      typeof linhaBruta.access_token === "string" && linhaBruta.access_token.length > 0,
    token_expires_at:
      typeof linhaBruta.token_expires_at === "string" ? linhaBruta.token_expires_at : null,
  };

  return { fato: montarFatoConexao(plataforma, recurso, linha, agoraMs), coleta: "ok" };
}
