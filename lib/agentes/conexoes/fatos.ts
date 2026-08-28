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
 * O marketplace que a plataforma pedida exige, ou `null`.
 *
 * Extraido para que a resolucao individual e a em lote consultem a MESMA
 * autoridade — `MARKETPLACE_POR_PLATAFORMA` — em vez de repetirem a
 * consulta ao mapa em dois lugares que poderiam divergir.
 */
function marketplaceDe(plataforma: string): string | null {
  return Object.prototype.hasOwnProperty.call(MARKETPLACE_POR_PLATAFORMA, plataforma)
    ? MARKETPLACE_POR_PLATAFORMA[plataforma]
    : null;
}

/**
 * A linha ja carregada vira fato — ou vira ausencia.
 *
 * PURO: nao abre Supabase, nao le env, nao faz rede, nao loga, nao muta e
 * nao chama relogio. Recebe `agoraMs` porque a decisao depende do tempo e
 * o determinismo e do modulo inteiro.
 *
 * ── E aqui que o segredo morre ──────────────────────────────────────
 *
 * `access_token` entra como coluna crua e sai como `temAccessToken`
 * boolean. `LinhaConexao` nao tem campo onde o valor caberia, entao a
 * reducao nao e disciplina de quem chama: e o tipo.
 *
 * Existe para que UMA linha lida possa produzir VARIOS fatos. Duas
 * capacidades da mesma loja — `(shopee, chat)` e `(shopee, pedidos)` —
 * sao dois requisitos e dois fatos, mas uma leitura so.
 */
function fatoDaLinha(
  linhaBruta: Record<string, unknown>,
  plataforma: string,
  recurso: string,
  marketplaceEsperado: string,
  agoraMs: number
): FatoConexao | null {
  // Plataforma pedida != plataforma real -> ausencia, e nao um fato
  // "invalido". Mesma decisao da resolucao individual, e pelo mesmo
  // motivo: responder outra coisa viraria oraculo de marketplace.
  if (linhaBruta.marketplace !== marketplaceEsperado) return null;

  const linha: LinhaConexao = {
    marketplace: String(linhaBruta.marketplace),
    ativo: typeof linhaBruta.ativo === "boolean" ? linhaBruta.ativo : null,
    temAccessToken:
      typeof linhaBruta.access_token === "string" && linhaBruta.access_token.length > 0,
    token_expires_at:
      typeof linhaBruta.token_expires_at === "string" ? linhaBruta.token_expires_at : null,
  };

  return montarFatoConexao(plataforma, recurso, linha, agoraMs);
}

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
  const marketplaceEsperado = marketplaceDe(plataforma);
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

  // ── A LINHA EM QUE O SEGREDO MORRE ────────────────────────────────
  //
  // `fatoDaLinha` faz a reducao e o confronto de marketplace. `null` dali
  // e ausencia — a mesma que esta funcao sempre devolveu quando a loja
  // existia mas era de outra plataforma.
  const fato = fatoDaLinha(
    data as Record<string, unknown>,
    plataforma,
    recurso,
    marketplaceEsperado,
    agoraMs
  );
  if (fato === null) return AUSENTE;

  return { fato, coleta: "ok" };
}

// ─── Resolucao EM LOTE ────────────────────────────────────────────────

/**
 * UM requisito ja selecionado.
 *
 * O trio minimo para chamar a autoridade de conexao, e nada alem. Sem
 * `userId` por pedido — o dono e da chamada inteira, e aceita-lo por item
 * permitiria uma lista mesclar tenants. Sem `obrigatoria`, sem Skill, sem
 * proveniencia: nada disso participa de "esta conexao serve?".
 *
 * `lojaId` continua OBRIGATORIO. O lote nao escolhe loja — pela mesma
 * razao que a resolucao individual nao escolhe.
 */
export interface PedidoConexao {
  plataforma: string;
  recurso: string;
  lojaId: string;
}

export interface EntradaFatosConexao {
  userId: string;
  pedidos: readonly PedidoConexao[];
  agoraMs: number;
}

/**
 * `fatos` traz UM item por pedido resolvido. Pedido sem fato simplesmente
 * NAO aparece — a ausencia e o dado, exatamente como em `FatoConexao[]`
 * de `EntradaDiagnostico`. Cada fato carrega `plataforma` e `recurso`,
 * que sao a identidade do pedido: nada se perde na omissao.
 *
 * `coleta` reusa `ColetaConexao` sem ampliar o vocabulario. Em lote ela
 * vale para a COLECAO: `ok` quando a leitura aconteceu (ainda que zero
 * fatos saiam), `falha_leitura` quando o banco nao respondeu, e `ausente`
 * apenas quando nao houve o que perguntar — sem dono, ou sem nenhum
 * pedido resolvivel. Nao ha `ausente` por item: item ausente e item
 * omitido.
 */
export interface ResultadoFatosConexao {
  fatos: readonly FatoConexao[];
  coleta: ColetaConexao;
}

const LOTE_AUSENTE: ResultadoFatosConexao = Object.freeze({
  fatos: Object.freeze([]) as readonly FatoConexao[],
  coleta: "ausente",
});

const LOTE_FALHA: ResultadoFatosConexao = Object.freeze({
  fatos: Object.freeze([]) as readonly FatoConexao[],
  coleta: "falha_leitura",
});

/**
 * Resolve VARIOS requisitos ja selecionados com UMA leitura de `lojas`.
 *
 * ── Por que existe ──────────────────────────────────────────────────
 *
 * Chamar `resolverFatoConexao` em laco custa uma query por requisito, e
 * cada query projeta credencial. Dez requisitos apontando para a mesma
 * conta releriam a mesma linha — e o mesmo `access_token` — dez vezes.
 * Nao ha teto estrutural para a quantidade de requisitos: `requer.conexoes`
 * nao passa pelo limite de lista do parser, um agente pode ter quantas
 * Skills quiser, e `recurso` e slug aberto. Reduzir isso a UMA leitura e
 * decisao de superficie de credencial antes de ser de desempenho.
 *
 * ── O que ele NAO faz ───────────────────────────────────────────────
 *
 * Nao escolhe loja, nao deduplica REQUISITOS e nao ordena por loja. A
 * deduplicacao aqui e de LEITURA: `lojaId` repetido vira um id so no
 * `IN`, e cada pedido continua produzindo o proprio fato. Dois pedidos
 * identicos continuam sendo dois pedidos — decidir que sao "um requisito"
 * e da camada de cima.
 *
 * ── Equivalencia ────────────────────────────────────────────────────
 *
 * O resultado e o mesmo de chamar `resolverFatoConexao` pedido a pedido,
 * menos as leituras repetidas: entrada incompleta, plataforma
 * desconhecida, loja que nao volta e marketplace divergente continuam
 * produzindo ausencia — nunca falha.
 */
export async function resolverFatosConexao(
  entrada: EntradaFatosConexao
): Promise<ResultadoFatosConexao> {
  const { userId, pedidos, agoraMs } = entrada;

  if (!userId) return LOTE_AUSENTE;

  // Os pedidos que a resolucao individual sequer levaria ao banco sao
  // descartados ANTES da query, com o marketplace ja resolvido para nao
  // consultar o mapa duas vezes por pedido.
  const resolviveis: Array<{ pedido: PedidoConexao; marketplace: string }> = [];
  for (const p of pedidos) {
    if (!p.lojaId || !p.plataforma || !p.recurso) continue;
    const marketplace = marketplaceDe(p.plataforma);
    if (marketplace === null) continue;
    resolviveis.push({ pedido: p, marketplace });
  }

  // Nada a perguntar: ZERO query. Uma consulta com lista vazia seria um
  // round trip para responder o que ja se sabe.
  if (resolviveis.length === 0) return LOTE_AUSENTE;

  const ids = [...new Set(resolviveis.map((r) => r.pedido.lojaId))];

  const { data, error } = await getSupabaseServidor()
    .from("lojas")
    .select(COLUNAS)
    .eq("user_id", String(userId))
    .in("id", ids);

  if (error) {
    // Sem `error.message`: mensagem de driver vaza nome de coluna, de
    // constraint e as vezes de valor, e acaba em log e em resposta HTTP.
    console.error("[conexoes] falha ao ler conexoes do dono em lote");
    return LOTE_FALHA;
  }

  // Indexacao por id: sem isto, cada pedido varreria a lista inteira e o
  // N+1 de query viraria N² de memoria.
  const porId = new Map<string, Record<string, unknown>>();
  for (const bruta of (data ?? []) as Record<string, unknown>[]) {
    const id = bruta.id;
    if (typeof id !== "string" || !id) {
      console.error("[conexoes] linha de loja sem id utilizavel");
      return LOTE_FALHA;
    }
    // `lojas_pkey` torna isto impossivel no banco. Se chegar assim mesmo,
    // o estado e inconsistente — e "ultima vence" escolheria em silencio
    // qual conta responde. Mesma recusa de `confirmarLojas`.
    if (porId.has(id)) {
      console.error("[conexoes] id de loja repetido na resposta");
      return LOTE_FALHA;
    }
    porId.set(id, bruta);
  }

  // Ordem = ordem dos PEDIDOS. Nao a do banco, e nao uma ordem por loja:
  // quem chama ja entrega os requisitos ordenados, e reordenar aqui
  // esconderia essa decisao dentro desta camada.
  const fatos: FatoConexao[] = [];
  for (const { pedido, marketplace } of resolviveis) {
    const bruta = porId.get(pedido.lojaId);
    // Loja que nao voltou e ausencia, nunca falha — equivalente exato do
    // `data === null` da resolucao individual.
    if (bruta === undefined) continue;
    const fato = fatoDaLinha(bruta, pedido.plataforma, pedido.recurso, marketplace, agoraMs);
    if (fato !== null) fatos.push(fato);
  }

  return { fatos, coleta: "ok" };
}
