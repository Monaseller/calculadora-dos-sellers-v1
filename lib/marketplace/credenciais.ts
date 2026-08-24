/**
 * Capability de credenciais de marketplace — PR #1.
 *
 * ── A invariante que este módulo existe para tornar estrutural ───────
 *
 *   "Nenhuma função de credencial acessível pelo código de domínio pode
 *    ler ou alterar credenciais usando apenas loja_id."
 *
 * Toda operação por loja exige o PAR `lojaId + userId`, e o `user_id`
 * entra na PRÓPRIA QUERY. A consequência é a que interessa: o `userId`
 * não precisa ser *provado* pelo chamador — ele RESTRINGE a consulta.
 * Par coerente devolve credencial; par forjado devolve `null`. Um job
 * adulterado em `sync_jobs` (tabela hoje sem RLS, gravável por quem
 * tenha a anon key) deixa de render credencial alheia e passa a falhar
 * fechado, sem depender de correção no banco.
 *
 * ── Superfície privilegiada ─────────────────────────────────────────
 * Este é o ÚNICO ponto do domínio de marketplace que toca colunas de
 * credencial. Ele NÃO exporta e NÃO recebe `SupabaseClient`: quem o usa
 * ganha seis capacidades nomeadas, nunca a capacidade genérica de
 * consultar qualquer tabela com service_role.
 *
 * ── `import "server-only"` ──────────────────────────────────────────
 * A primeira linha do módulo é a barreira. `server-only` resolve para um
 * arquivo que LANÇA quando o bundler o inclui num Client Component: o
 * erro aparece no BUILD, não em produção, e nomeia o import que causou o
 * vazamento. É proteção de tempo de compilação, mais forte do que uma
 * checagem em runtime, porque impede que o módulo chegue ao bundle do
 * cliente em vez de reagir depois que chegou.
 *
 * Ela não anda sozinha: `getSupabaseServidor()` é fail-closed e lança se
 * `SUPABASE_SERVICE_ROLE_KEY` faltar — variável que, sem o prefixo
 * `NEXT_PUBLIC_`, é `undefined` em qualquer bundle de cliente. Duas
 * barreiras independentes, em momentos diferentes.
 *
 * ── Erro: devolvido, nunca decidido aqui ────────────────────────────
 * As leituras devolvem `{ linha, erro }` em vez de lançar ou engolir. Os
 * três consumidores tratam falha de infraestrutura de formas
 * DIFERENTES e legítimas — `ml-conexao` lança `ErroConsultaConexaoML`,
 * `shopee-auth` registra e devolve `null`, `ml-auth` ignora — e este
 * módulo não pode escolher por eles sem alterar comportamento externo.
 */
import "server-only";
import { getSupabaseServidor } from "@/lib/estudio-anuncios/supabase-servidor";

/** Marketplaces tratados. Definidos aqui para não importar `ml-conexao` (ciclo). */
const MARKETPLACE_ML = "ML";
const MARKETPLACE_SHOPEE = "Shopee";

/**
 * Colunas lidas em cada marketplace. Listas EXPLÍCITAS, nunca `*`:
 * além de não trazer coluna desnecessária, é o que mantém estas
 * consultas compatíveis com um futuro `GRANT` coluna a coluna (PR #2).
 */
const COLUNAS_ML = "id, nickname, seller_id, access_token, refresh_token, token_expires_at";
const COLUNAS_SHOPEE =
  "id, shop_id, partner_id, partner_key, access_token, refresh_token, token_expires_at, nickname, ativo";

export interface LinhaCredencialML {
  id: string;
  nickname: string | null;
  seller_id: string | null;
  access_token: string | null;
  refresh_token: string | null;
  token_expires_at: string | null;
}

export interface LinhaCredencialShopee {
  id: string;
  shop_id: string | number | null;
  partner_id: string | null;
  partner_key: string | null;
  access_token: string | null;
  refresh_token: string | null;
  token_expires_at: string | null;
  nickname: string | null;
  ativo: boolean | null;
}

/** Campos graváveis. Nada além de credencial passa por aqui. */
export interface CamposCredencialML {
  access_token?: unknown;
  refresh_token?: unknown;
  token_expires_at?: unknown;
}
export interface CamposCredencialShopee {
  access_token?: unknown;
  refresh_token?: unknown;
  token_expires_at?: unknown;
}

export interface ResultadoLeitura<T> {
  linha: T | null;
  erro: string | null;
}
export interface ResultadoLista<T> {
  linhas: T[];
  erro: string | null;
}

/**
 * ── Construtores de filtro ──────────────────────────────────────────
 *
 * Exportados de propósito: são funções PURAS, sem rede e sem banco, e é
 * sobre elas que a suíte prova a invariante. Um teste que afirme
 * "toda operação por loja carrega `user_id`" precisa inspecionar o
 * filtro, e inspecionar o filtro é barato; inspecionar a query montada
 * exigiria um banco.
 *
 * `String(userId)` porque `lojas.user_id` e `sync_jobs.user_id` são
 * TEXT: comparar sem normalizar viraria recusa silenciosa por tipo — o
 * mesmo cuidado que `ml-conta.ts` já toma com `String(loja.user_id)`.
 */
export function filtrosMLPorLojaEDono(lojaId: string, userId: string): Record<string, unknown> {
  return { id: lojaId, user_id: String(userId), marketplace: MARKETPLACE_ML };
}

export function filtrosMLAtivaDoDono(userId: string): Record<string, unknown> {
  return { user_id: String(userId), marketplace: MARKETPLACE_ML, ativo: true };
}

export function filtrosShopeeDoDono(userId: string, lojaId?: string | null): Record<string, unknown> {
  const filtros: Record<string, unknown> = {
    user_id: String(userId),
    marketplace: MARKETPLACE_SHOPEE,
  };
  // Com loja indicada NÃO se filtra `ativo`: é o comportamento que
  // `getShopeeLojaById` tem hoje (o worker sincroniza a loja do job).
  // Sem loja indicada, "a mais recente ATIVA", como `getShopeeLojaAtiva`.
  if (lojaId) filtros.id = lojaId;
  else filtros.ativo = true;
  return filtros;
}

/**
 * Escrita: `id` + `user_id`, exatamente o par exigido pela invariante.
 * `marketplace` não entra — a gravação já é alcançada por um caminho que
 * leu a credencial daquele marketplace, e manter o filtro mínimo
 * preserva a semântica do compare-and-swap.
 */
export function filtrosGravacaoPorLojaEDono(lojaId: string, userId: string): Record<string, unknown> {
  return { id: lojaId, user_id: String(userId) };
}

/** Aplica um mapa de filtros como `.eq()` encadeados. */
function aplicarFiltros(consulta: any, filtros: Record<string, unknown>): any {
  let q = consulta;
  for (const [coluna, valor] of Object.entries(filtros)) q = q.eq(coluna, valor);
  return q;
}

// ─── Mercado Livre ────────────────────────────────────────────────────

/**
 * Credencial de UMA loja ML, do dono informado.
 *
 * `somenteAtiva` existe porque os chamadores divergem de propósito:
 * `ml-conexao.relerLoja` exige loja ativa, o fallback de `getMLToken` e
 * o caminho do worker não — e uniformizar aqui mudaria comportamento
 * externo, que esta PR não pode alterar.
 */
export async function lerCredencialMLPorLojaEDono(
  lojaId: string,
  userId: string,
  opcoes: { somenteAtiva?: boolean } = {}
): Promise<ResultadoLeitura<LinhaCredencialML>> {
  if (!lojaId || !userId) return { linha: null, erro: null };

  const filtros = filtrosMLPorLojaEDono(lojaId, userId);
  if (opcoes.somenteAtiva) filtros.ativo = true;

  const { data, error } = await aplicarFiltros(
    getSupabaseServidor().from("lojas").select(COLUNAS_ML),
    filtros
  ).maybeSingle();

  if (error) return { linha: null, erro: error.message };
  return { linha: (data as LinhaCredencialML | null) ?? null, erro: null };
}

/** A loja ML ativa mais recente do dono. */
export async function lerCredencialMLAtivaDoDono(
  userId: string
): Promise<ResultadoLeitura<LinhaCredencialML>> {
  if (!userId) return { linha: null, erro: null };

  const { data, error } = await aplicarFiltros(
    getSupabaseServidor().from("lojas").select(COLUNAS_ML),
    filtrosMLAtivaDoDono(userId)
  )
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) return { linha: null, erro: error.message };
  return { linha: (data as LinhaCredencialML | null) ?? null, erro: null };
}

/**
 * Todas as lojas ML ativas do dono, opcionalmente restritas a uma.
 * `lojaId` SOMA-SE aos filtros de dono — nunca os substitui.
 */
export async function listarCredenciaisMLDoDono(
  userId: string,
  lojaId?: string | null
): Promise<ResultadoLista<LinhaCredencialML>> {
  if (!userId) return { linhas: [], erro: null };

  const filtros = filtrosMLAtivaDoDono(userId);
  if (lojaId) filtros.id = lojaId;

  const { data, error } = await aplicarFiltros(
    getSupabaseServidor().from("lojas").select(COLUNAS_ML),
    filtros
  ).order("created_at", { ascending: true });

  if (error) return { linhas: [], erro: error.message };
  return { linhas: (data ?? []) as LinhaCredencialML[], erro: null };
}

/**
 * Grava credencial ML renovada.
 *
 * `refreshAnterior` liga o COMPARE-AND-SWAP já existente: só grava se a
 * linha ainda contiver o refresh_token de onde partimos. O filtro novo
 * de `user_id` SOMA-SE a ele; a semântica do CAS não muda — "zero linhas"
 * continua significando "não gravei", e quem chama relê.
 *
 * O ramo sem `refreshAnterior` é o caminho legado, preservado: escrita
 * incondicional, sem `.select()`, devolvendo `true`. LIMITE CONHECIDO,
 * herdado e deliberadamente não corrigido nesta PR: nesse ramo o retorno
 * não distingue "gravou" de "o par não bateu". Nada é gravado no segundo
 * caso — que é o que a invariante precisa garantir —, mas o chamador não
 * fica sabendo. Os quatro chamadores legados ignoram o retorno.
 */
export async function gravarCredencialML(
  lojaId: string,
  userId: string,
  campos: CamposCredencialML,
  refreshAnterior?: string | null
): Promise<boolean> {
  if (!lojaId || !userId) return false;

  const supabase = getSupabaseServidor();
  const filtros = filtrosGravacaoPorLojaEDono(lojaId, userId);

  if (!refreshAnterior) {
    await aplicarFiltros(supabase.from("lojas").update(campos), filtros);
    return true;
  }

  filtros.refresh_token = refreshAnterior;
  const { data } = await aplicarFiltros(
    supabase.from("lojas").update(campos),
    filtros
  ).select("id");

  return Array.isArray(data) && data.length > 0;
}

// ─── Shopee ───────────────────────────────────────────────────────────

/**
 * Credencial Shopee do dono. Sem `lojaId`, a mais recente ativa; com
 * `lojaId`, exatamente aquela loja — sempre restrita ao dono.
 *
 * Devolve `partner_key`, que é o app secret da Shopee: este retorno
 * NUNCA pode ser espalhado em resposta HTTP.
 */
export async function lerCredencialShopeeDoDono(
  userId: string,
  lojaId?: string | null
): Promise<ResultadoLeitura<LinhaCredencialShopee>> {
  if (!userId) return { linha: null, erro: null };

  let consulta = aplicarFiltros(
    getSupabaseServidor().from("lojas").select(COLUNAS_SHOPEE),
    filtrosShopeeDoDono(userId, lojaId)
  );

  // "Mais recente ativa" só faz sentido quando a loja NÃO foi indicada.
  if (!lojaId) consulta = consulta.order("created_at", { ascending: false }).limit(1);

  const { data, error } = await consulta.maybeSingle();

  if (error) return { linha: null, erro: error.message };
  return { linha: (data as LinhaCredencialShopee | null) ?? null, erro: null };
}

/**
 * Leitura de loja para ativacao — PR #2b-3.
 *
 * ── Projecao minima, nao `*` ────────────────────────────────────────
 * A rota pedia a linha INTEIRA e usava CINCO campos. A projecao aberta
 * trazia junto `refresh_token`, `partner_key` e `token_expires_at` — as
 * tres colunas mais sensiveis da tabela — para a memoria de uma rota
 * que nunca as usou. A projecao aqui e literal e fechada.
 *
 * `access_token` PERMANECE na projecao: a rota o emite como cookie
 * `ml_access_token`, do qual `/api/ml/item-thumbnails` e
 * `/api/ml/vendas-hoje` dependem como fonte UNICA de credencial.
 * Retirar daqui quebraria as duas. A aposentadoria desse cookie e
 * frente propria.
 *
 * ── Por que `maybeSingle()` e nao `single()` ────────────────────────
 * Detalhe que decide o contrato HTTP: `single()` trata "zero linhas"
 * como ERRO (`PGRST116`). Como esta funcao agora distingue
 * "nao encontrada" de "banco falhou", usar `single()` faria toda loja
 * inexistente virar 503. `maybeSingle()` devolve `data: null` sem erro
 * — que e exatamente a semantica de 404 que a rota precisa.
 *
 * ── O texto do Postgres nao sai daqui, nem para a rota nem para o log ─
 * A rota recebe um CODIGO estavel. E o log e uma linha ESTATICA: o
 * texto cru do Postgres nomeia tabela, coluna, esquema e as vezes
 * detalhe de conexao ou configuracao, e log de producao e superficie
 * de leitura como qualquer outra. `lojaId` e `userId` tambem ficam de
 * fora — identificam tenant sem acrescentar nada ao diagnostico.
 * O que resta e a informacao util: ESTA consulta falhou.
 */
export interface LojaParaAtivacao {
  id: string;
  nome: string | null;
  nickname: string | null;
  marketplace: string;
  access_token: string | null;
}

export interface ResultadoLojaParaAtivacao {
  loja: LojaParaAtivacao | null;
  erro: string | null;
}

export async function lerLojaParaAtivacao(
  lojaId: string,
  userId: string
): Promise<ResultadoLojaParaAtivacao> {
  if (!lojaId || !userId) return { loja: null, erro: null };

  const { data, error } = await getSupabaseServidor()
    .from("lojas")
    .select("id, nome, nickname, marketplace, access_token")
    .eq("id", lojaId)
    .eq("user_id", String(userId))
    .maybeSingle();

  if (error) {
    console.error("[credenciais] falha ao consultar loja para ativacao");
    return { loja: null, erro: "erro_consulta_loja" };
  }

  return { loja: (data as LojaParaAtivacao | null) ?? null, erro: null };
}

/**
 * Desconexao de loja — PR #2b-2.
 *
 * ── Agnostica de marketplace, de proposito ──────────────────────────
 * A operacao e identica para ML e Shopee: apaga a credencial de sessao
 * e desativa a loja. Nao ha ramo por marketplace aqui — o que difere
 * entre eles e a limpeza de COOKIES, que e assunto de HTTP e fica na
 * rota, nao no acesso ao banco.
 *
 * ── O que NAO e apagado, e por que ──────────────────────────────────
 * `partner_key` permanece. Apesar do nome, ela nao e credencial de
 * sessao: e a chave de APLICACAO da Shopee, lida do banco para assinar
 * cada requisicao (`lib/shopee-auth.ts`). Ela nao volta por
 * reautorizacao — apaga-la impediria reconectar a loja depois.
 * `seller_id`, `shop_id`, `nome`, `nickname` e `created_at` tambem
 * ficam: a loja continua existindo, apenas desconectada.
 *
 * ── Ownership na propria escrita ────────────────────────────────────
 * O filtro de dono e da instrucao de UPDATE, nao de uma checagem
 * anterior que alguem possa remover ao refatorar. `ativo = true` entra
 * junto para que desconectar duas vezes NAO produza falso sucesso: a
 * segunda passagem nao casa linha nenhuma.
 *
 * Devolve a CONTAGEM de linhas afetadas em vez de um booleano: quem
 * chama precisa distinguir "desconectei" de "nao havia o que
 * desconectar" para escolher entre 200 e 404 — e essa distincao tem de
 * vir do banco, nunca de uma suposicao.
 */
export interface ResultadoDesconexao {
  desconectadas: number;
  erro: string | null;
}

export async function desconectarLojaDoDono(
  lojaId: string,
  userId: string
): Promise<ResultadoDesconexao> {
  if (!lojaId || !userId) return { desconectadas: 0, erro: null };

  const { data, error } = await getSupabaseServidor()
    .from("lojas")
    .update({
      ativo: false,
      access_token: null,
      refresh_token: null,
      token_expires_at: null,
    })
    .eq("id", lojaId)
    .eq("user_id", String(userId))
    .eq("ativo", true)
    .select("id");

  if (error) return { desconectadas: 0, erro: error.message };
  return { desconectadas: Array.isArray(data) ? data.length : 0, erro: null };
}

// ── OAuth do Mercado Livre — PR #2b-4 ───────────────────────────────
//
// Tres operacoes estreitas cobrem o fluxo inteiro: localizar a loja de
// uma RECONEXAO, listar as lojas do dono para um seller, e persistir a
// credencial recem-autorizada. Nenhuma delas aceita filtro arbitrario e
// nenhuma faz busca global por seller — o escopo por dono e da propria
// query, sempre.
//
// NENHUMA delas participa do compare-and-swap. CAS pertence ao REFRESH
// de token (`gravarCredencialML`), onde duas renovacoes concorrentes
// poderiam sobrescrever uma a outra. Aqui o usuario acabou de autorizar:
// o token novo deve prevalecer, e exigir CAS quebraria o fluxo.

/**
 * Loja alvo de uma RECONEXAO — leitura previa a gastar o `code`.
 *
 * Projeta `seller_id` porque quem chama precisa comparar o seller que
 * voltou do Mercado Livre com o da loja pretendida: autorizar outra
 * conta NAO transforma esta loja naquela conta.
 *
 * `marketplace = "ML"` entra no filtro para que um id de loja Shopee
 * nunca seja alcancavel por este caminho.
 *
 * ── `somenteAtiva` existe porque as duas pontas divergem ────────────
 * O INICIO do fluxo so aceita reconectar loja ATIVA; o CALLBACK aceita
 * a loja em qualquer estado — afinal, entre um e outro o proprio fluxo
 * pode te-la deixado inativa. Essa diferenca ja existia entre as duas
 * consultas diretas, e unifica-la aqui mudaria comportamento em vez de
 * migrar cliente. O padrao segue `lerCredencialMLPorLojaEDono`.
 */
export interface LojaMLParaReconexao {
  id: string;
  seller_id: string | null;
}

export async function lerLojaMLDoDonoParaReconexao(
  lojaId: string,
  userId: string,
  opcoes?: { somenteAtiva?: boolean }
): Promise<{ loja: LojaMLParaReconexao | null; erro: string | null }> {
  if (!lojaId || !userId) return { loja: null, erro: null };

  let consulta = getSupabaseServidor()
    .from("lojas")
    .select("id, seller_id")
    .eq("id", lojaId)
    .eq("user_id", String(userId))
    .eq("marketplace", MARKETPLACE_ML);

  if (opcoes?.somenteAtiva) consulta = consulta.eq("ativo", true);

  const { data, error } = await consulta.maybeSingle();

  if (error) {
    console.error("[credenciais] falha ao localizar loja ML para reconexao");
    return { loja: null, erro: "erro_consulta_loja" };
  }

  return { loja: (data as LojaMLParaReconexao | null) ?? null, erro: null };
}

/**
 * Lojas do DONO para um seller — a busca que decide connect vs update.
 *
 * ── Por que devolve lista, e nao `maybeSingle()` ────────────────────
 * Duplicidade dentro do mesmo usuario precisa continuar VISIVEL.
 * `maybeSingle()` transformaria "duas linhas" em erro generico, e
 * `single()` escolheria uma — que e exatamente o que nao pode
 * acontecer: gravar credencial numa linha arbitraria esconderia a
 * inconsistencia. Quem chama decide: 0 = criar, 1 = atualizar,
 * >1 = recusar.
 *
 * ── Escopo por dono, nao por seller ─────────────────────────────────
 * `user_id` esta no filtro, nao numa checagem posterior. O MESMO
 * `seller_id` existe legitimamente para outros donos (medido no banco:
 * 3 donos distintos para um mesmo seller) e para linhas orfas. Nenhuma
 * delas e alcancavel daqui — e e por isso que reconectar uma conta ML
 * ja usada por outro usuario nao cruza tenant.
 */
export async function listarLojasMLDoDonoPorSeller(
  userId: string,
  sellerId: string
): Promise<{ ids: string[]; erro: string | null }> {
  if (!userId || !sellerId) return { ids: [], erro: null };

  const { data, error } = await getSupabaseServidor()
    .from("lojas")
    .select("id")
    .eq("user_id", String(userId))
    .eq("marketplace", MARKETPLACE_ML)
    .eq("seller_id", sellerId);

  if (error) {
    console.error("[credenciais] falha ao listar lojas ML do dono por seller");
    return { ids: [], erro: "erro_consulta_loja" };
  }

  const linhas = Array.isArray(data) ? data : [];
  return { ids: linhas.map((l: any) => String(l.id)), erro: null };
}

/**
 * Persiste a credencial recem-autorizada — UPDATE ou INSERT.
 *
 * ── Dois caminhos, nenhum `upsert` ──────────────────────────────────
 * `lojaId` presente = a linha ja foi resolvida por quem chamou (reconexao
 * ou seller ja conhecido) e o caminho e UPDATE, com `id + user_id` na
 * propria escrita. `lojaId` ausente = nao ha linha do dono para este
 * seller, e o caminho e INSERT. Um `upsert` precisaria de uma constraint
 * que este schema nao tem, e escolheria linha sozinho.
 *
 * ── `refresh_token` ausente OMITE a coluna ──────────────────────────
 * Regra que ja existia e nao pode regredir: quando o Mercado Livre nao
 * devolve refresh token, a coluna NAO entra na escrita. Grava-la como
 * `null` destruiria uma credencial de longa duracao ainda valida por
 * causa de uma resposta que legitimamente pode vir sem ela.
 *
 * ── So colunas do ML ────────────────────────────────────────────────
 * `partner_key`, `shop_id` e `partner_id` sao da Shopee e nunca entram
 * aqui — nem no UPDATE nem no INSERT.
 *
 * `.select("id")` torna o efeito observavel: zero linhas NUNCA vira
 * sucesso, e quem chama recebe `lojaId: null`.
 */
export interface DadosCredencialMLOAuth {
  /** Presente = UPDATE de linha ja resolvida. Ausente = INSERT. */
  lojaId?: string | null;
  /** Usado somente no INSERT — o UPDATE nunca reescreve `seller_id`. */
  sellerId: string;
  nickname: string;
  accessToken: string;
  refreshToken: string | null;
  expiraEm: string;
}

export async function registrarCredencialMLOAuth(
  userId: string,
  dados: DadosCredencialMLOAuth
): Promise<{ lojaId: string | null; erro: string | null }> {
  if (!userId || !dados?.accessToken) return { lojaId: null, erro: "entrada_invalida" };

  const supabase = getSupabaseServidor();

  if (dados.lojaId) {
    const atualizacao: Record<string, unknown> = {
      access_token: dados.accessToken,
      token_expires_at: dados.expiraEm,
      nickname: dados.nickname,
      nome: dados.nickname,
      ativo: true,
    };
    if (dados.refreshToken) atualizacao.refresh_token = dados.refreshToken;

    const { data, error } = await supabase
      .from("lojas")
      .update(atualizacao)
      .eq("id", dados.lojaId)
      .eq("user_id", String(userId))
      .select("id");

    if (error) {
      console.error("[credenciais] falha ao gravar credencial ML");
      return { lojaId: null, erro: "erro_persistencia" };
    }
    const linhas = Array.isArray(data) ? data : [];
    if (linhas.length === 0) return { lojaId: null, erro: "nenhuma_linha" };
    return { lojaId: String(linhas[0].id), erro: null };
  }

  const novaLinha: Record<string, unknown> = {
    marketplace: MARKETPLACE_ML,
    seller_id: dados.sellerId,
    nickname: dados.nickname,
    nome: dados.nickname,
    access_token: dados.accessToken,
    token_expires_at: dados.expiraEm,
    ativo: true,
    // Dono SEMPRE da sessao ja validada por quem chamou — nunca do
    // `state`, do seller nem de qualquer campo vindo do navegador.
    user_id: String(userId),
  };
  if (dados.refreshToken) novaLinha.refresh_token = dados.refreshToken;

  const { data, error } = await supabase.from("lojas").insert(novaLinha).select("id");

  if (error) {
    console.error("[credenciais] falha ao criar loja ML");
    return { lojaId: null, erro: "erro_persistencia" };
  }
  const criadas = Array.isArray(data) ? data : [];
  if (criadas.length === 0) return { lojaId: null, erro: "nenhuma_linha" };
  return { lojaId: String(criadas[0].id), erro: null };
}

/**
 * Registro de loja Shopee vindo do callback OAuth — PR #2b-1.
 *
 * ── Por que existe uma função só para isto ──────────────────────────
 * As demais operações desta capability pressupõem uma loja que JÁ
 * existe: exigem `lojaId + userId`. O callback OAuth é o único ponto em
 * que a loja pode ainda não existir — o `lojaId` NASCE aqui. Por isso
 * esta é a única função sem `lojaId` de entrada: a identidade vem do
 * `userId` (autenticado pelo servidor) somado ao `shopId` (devolvido
 * pela Shopee). Ela nunca aceita `lojaId`, justamente para não virar
 * uma porta lateral de escrita em loja arbitrária.
 *
 * ── MODELO A de ownership ───────────────────────────────────────────
 * A mesma conta de marketplace PODE pertencer a mais de um usuário CDS,
 * uma linha por dono. Não é suposição: o callback do ML registra a
 * medição em producao — "3 donos distintos para o mesmo seller" — e a
 * constraint do banco e `UNIQUE (seller_id, user_id)`, ou seja, seller
 * unico POR USUARIO, nunca global.
 *
 * Consequencia: a busca e SEMPRE escopada pelo dono. Linha de outro
 * usuario nao e lida, nao e alterada e nao tem sua existencia revelada.
 * Conectar a mesma shop noutro tenant e permitido e cria linha propria.
 *
 * ── Por que NAO usa upsert ──────────────────────────────────────────
 * `upsert(..., { onConflict: "seller_id,user_id" })` seria mais curto e
 * esta PROIBIDO. A unique NAO inclui `marketplace`, e `seller_id` e a
 * coluna generica entre marketplaces — no ML guarda o seller do ML, no
 * Shopee guarda `String(shopId)`. Um upsert cego casaria pelo par
 * (seller_id, user_id) e poderia SOBRESCREVER a linha de ML do proprio
 * usuario cujo seller_id coincidisse numericamente com o shopId Shopee.
 * Improvavel, e destrutivo quando ocorre — e um upsert nao tem como
 * perceber. Por isso o caminho e SELECT escopado por marketplace,
 * depois UPDATE ou INSERT.
 *
 * A unique continua sendo a rede de seguranca: ela e o que torna o
 * tratamento de `23505` confiavel no passo de corrida.
 *
 * ── Fail-closed em todos os ramos ───────────────────────────────────
 * Nenhum erro e engolido. Nenhum caminho devolve `lojaId` sem linha
 * confirmada pelo banco. Duplicidade DENTRO do proprio usuario nao
 * escolhe linha arbitraria — devolve `duplicidade_loja`, como o ML ja
 * faz, porque gravar credencial na linha errada e pior que falhar.
 */
export interface DadosRegistroShopee {
  shopId: string;
  nickname: string;
  nome: string;
  partnerId: string;
  partnerKey: string;
  accessToken: string;
  refreshToken: string | null;
  expiraEm: string;
}

export interface ResultadoRegistroLoja {
  lojaId: string | null;
  erro: string | null;
  motivo?: "duplicidade_loja";
}

export async function registrarLojaShopeeOAuth(
  userId: string,
  dados: DadosRegistroShopee
): Promise<ResultadoRegistroLoja> {
  if (!userId || !dados?.shopId) {
    return { lojaId: null, erro: "userId e shopId sao obrigatorios." };
  }

  const supabase = getSupabaseServidor();
  const sellerId = String(dados.shopId);
  const dono = String(userId);

  // Campos gravados tanto no UPDATE quanto no INSERT. `partner_key`
  // permanece persistida TEMPORARIAMENTE: tres rotas admin ainda a leem
  // do banco. Remove-la e frente propria (ela e um segredo GLOBAL de
  // ambiente replicado por linha, nao dado por loja).
  const credenciais = {
    nickname: dados.nickname,
    nome: dados.nome,
    partner_id: dados.partnerId,
    partner_key: dados.partnerKey,
    access_token: dados.accessToken,
    refresh_token: dados.refreshToken,
    token_expires_at: dados.expiraEm,
    ativo: true,
  };

  /** Busca escopada. `marketplace` entra SEMPRE — ver "Por que NAO usa upsert". */
  async function localizar(): Promise<{ ids: string[]; erro: string | null }> {
    const { data, error } = await supabase
      .from("lojas")
      .select("id")
      .eq("user_id", dono)
      .eq("marketplace", MARKETPLACE_SHOPEE)
      .eq("seller_id", sellerId);
    if (error) return { ids: [], erro: error.message };
    return { ids: ((data ?? []) as { id: string }[]).map((l) => l.id), erro: null };
  }

  /** UPDATE tenant-aware, confirmado pela linha afetada. */
  async function atualizar(lojaId: string): Promise<ResultadoRegistroLoja> {
    const { data, error } = await supabase
      .from("lojas")
      .update(credenciais)
      .eq("id", lojaId)
      .eq("user_id", dono)
      .select("id");
    if (error) return { lojaId: null, erro: error.message };
    if (!Array.isArray(data) || data.length === 0) {
      // Zero linhas confirmadas: o par (id, user_id) nao casou. Nunca
      // tratar como sucesso — foi exatamente esse falso positivo que
      // deixou a tela dizendo "conectado" sem gravar nada.
      return { lojaId: null, erro: "nenhuma linha confirmada no update" };
    }
    return { lojaId: data[0].id, erro: null };
  }

  // PASSO 1-3 — localizar, escopado pelo dono.
  const inicial = await localizar();
  if (inicial.erro) return { lojaId: null, erro: inicial.erro };
  if (inicial.ids.length > 1) {
    return { lojaId: null, erro: "duplicidade", motivo: "duplicidade_loja" };
  }

  // PASSO 4 — exatamente uma: atualiza.
  if (inicial.ids.length === 1) return atualizar(inicial.ids[0]);

  // PASSO 5 — nenhuma: cria, sempre com o dono da sessao.
  const { data: criada, error: erroInsert } = await supabase
    .from("lojas")
    .insert({
      user_id: dono,
      marketplace: MARKETPLACE_SHOPEE,
      seller_id: sellerId,
      shop_id: sellerId,
      ...credenciais,
    })
    .select("id");

  if (!erroInsert) {
    if (!Array.isArray(criada) || criada.length === 0) {
      return { lojaId: null, erro: "insert sem linha confirmada" };
    }
    return { lojaId: criada[0].id, erro: null };
  }

  // PASSO 6 — corrida. `23505` significa que outra requisicao criou a
  // linha entre o SELECT e o INSERT. NAO e sucesso automatico: relemos e
  // atualizamos a linha que passou a existir.
  if ((erroInsert as { code?: string }).code !== "23505") {
    return { lojaId: null, erro: erroInsert.message };
  }

  const relido = await localizar();
  if (relido.erro) return { lojaId: null, erro: relido.erro };
  if (relido.ids.length > 1) {
    return { lojaId: null, erro: "duplicidade", motivo: "duplicidade_loja" };
  }
  if (relido.ids.length === 0) {
    // 23505 sem linha visivel: a violacao veio de outro indice (por
    // exemplo, uma linha de ML com o mesmo seller_id). Falha fechada.
    return { lojaId: null, erro: "conflito sem linha correspondente" };
  }
  return atualizar(relido.ids[0]);
}

// ─── Cursor de cobertura do sync Shopee — TIMEOUT1a ───────────────────
//
// `lojas.shopee_sincronizado_ate` responde a UMA pergunta: ate que
// instante o sync desta loja ja cobriu com sucesso. Ele nao e derivavel
// de `pedidos.synced_at` — sync com zero pedidos nao grava linha alguma,
// e sync parcial gravaria as linhas que conseguiu, fazendo
// `MAX(synced_at)` avancar sobre periodo que ficou de fora.
//
// O acesso vive aqui, e nao no motor de sync, pela mesma razao que as
// credenciais vivem: toda leitura e toda escrita em `lojas` passam por
// um par (id, user_id) explicito, e nenhuma rota monta essa query por
// conta propria.

/** Nome da coluna, num lugar so — a suite trava o valor. */
const COLUNA_CURSOR_SHOPEE = "shopee_sincronizado_ate";

export interface ResultadoCursorShopee {
  /** ISO-8601, ou `null` para "nunca completou um sync" (bootstrap). */
  cursor: string | null;
  /** Codigo estavel. `null` em sucesso — inclusive quando `cursor` e null. */
  erro: string | null;
}

export interface ResultadoAvancoCursor {
  /**
   * `true` = esta execucao moveu o cursor.
   *
   * `false` COM `erro: null` NAO e falha: significa que o cursor ja
   * estava igual ou adiante, tipicamente porque outra execucao
   * concorrente terminou depois mas cobriu mais. E o desfecho saudavel
   * do compare-and-swap, e o chamador nao deve trata-lo como problema.
   */
  avancou: boolean;
  erro: string | null;
}

/**
 * Le o cursor de cobertura de UMA loja Shopee do dono informado.
 *
 * Nao distingue "loja inexistente" de "loja sem cursor": os dois casos
 * devolvem `cursor: null`, e os dois levam ao mesmo comportamento
 * (bootstrap). O sync ja resolveu e validou a loja antes de chegar aqui
 * — mas a consulta continua tenant-aware de qualquer forma, porque a
 * invariante do modulo e essa, e nao "confie em quem chamou".
 *
 * Erro de persistencia devolve codigo estavel e `cursor: null`. O texto
 * do Postgres nao sai daqui: ele nomeia esquema, tabela e as vezes
 * detalhe de conexao. O log e linha ESTATICA, sem `lojaId` nem `userId`
 * — identificam tenant sem acrescentar nada ao diagnostico.
 */
export async function lerCursorSyncShopee(
  lojaId: string,
  userId: string
): Promise<ResultadoCursorShopee> {
  if (!lojaId || !userId) return { cursor: null, erro: null };

  const { data, error } = await aplicarFiltros(
    getSupabaseServidor().from("lojas").select(COLUNA_CURSOR_SHOPEE),
    { ...filtrosGravacaoPorLojaEDono(lojaId, userId), marketplace: MARKETPLACE_SHOPEE }
  ).maybeSingle();

  if (error) {
    console.error("[marketplace/credenciais] falha ao ler cursor de sync Shopee");
    return { cursor: null, erro: "erro_leitura_cursor_shopee" };
  }

  const linha = data as Record<string, unknown> | null;
  const valor = linha?.[COLUNA_CURSOR_SHOPEE];
  return { cursor: typeof valor === "string" ? valor : null, erro: null };
}

/**
 * Avanca o cursor — compare-and-swap, monotonico.
 *
 * ── Por que a condicao vai no UPDATE, e nao em JavaScript ───────────
 * Ler o cursor, comparar em memoria e gravar cria um TOCTOU classico:
 *
 *     A comeca (cobertura ate 15:00)   B comeca (cobertura ate 15:05)
 *     B termina, grava 15:05
 *     A termina, leu "14:00" la atras, grava 15:00   ← REGRESSAO
 *
 * O cursor teria voltado no tempo, e a execucao seguinte re-listaria um
 * periodo ja coberto. Com a condicao dentro da instrucao, o UPDATE de A
 * simplesmente nao encontra linha — o Postgres avalia o predicado sobre
 * a linha ja travada pela escrita de B.
 *
 * O `.or()` produz `WHERE (col IS NULL OR col < X)` combinado por AND
 * com os `.eq()` de tenant. `coberturaAte` vem de `toISOString()`, que
 * sempre termina em `Z`: sem virgula (que separaria os termos do `or`)
 * e sem `+` (que a query string interpretaria como espaco).
 *
 * ── Quem garante que so sync COMPLETO chega aqui ────────────────────
 * Nao esta funcao. Ela e monotonicidade e nada mais. A decisao de
 * completude e de `syncCobriuJanelaCompletamente()`, no motor de sync —
 * separada de proposito, para que cada uma seja testavel sozinha.
 */
export async function avancarCursorSyncShopee(
  lojaId: string,
  userId: string,
  coberturaAte: Date
): Promise<ResultadoAvancoCursor> {
  if (!lojaId || !userId) return { avancou: false, erro: null };

  const alvo = coberturaAte.toISOString();

  const { data, error } = await aplicarFiltros(
    getSupabaseServidor()
      .from("lojas")
      .update({ [COLUNA_CURSOR_SHOPEE]: alvo }),
    { ...filtrosGravacaoPorLojaEDono(lojaId, userId), marketplace: MARKETPLACE_SHOPEE }
  )
    .or(`${COLUNA_CURSOR_SHOPEE}.is.null,${COLUNA_CURSOR_SHOPEE}.lt.${alvo}`)
    .select("id");

  if (error) {
    console.error("[marketplace/credenciais] falha ao avancar cursor de sync Shopee");
    return { avancou: false, erro: "erro_avanco_cursor_shopee" };
  }

  // Zero linhas = o cursor ja estava igual ou adiante. Sucesso.
  return { avancou: Array.isArray(data) && data.length > 0, erro: null };
}

// ─── Leituras nao-credenciais de `lojas` — LOJAS-ANON-SELECT ──────────
//
// ── Por que estas operacoes existem ────────────────────────────────────
// Nove pontos de runtime liam `public.lojas` com o cliente ANON. Nenhum
// deles precisava disso: todos rodam no servidor e todos ja tem guarda de
// sessao, cron ou admin. O acesso anon era heranca do
// `ALTER DEFAULT PRIVILEGES` do projeto Supabase, nunca uma decisao.
//
// Enquanto existir UM leitor anon, o `GRANT SELECT ... TO anon` nao pode
// ser revogado — e sem revoga-lo, a chave anon (que o Next inlina no
// bundle do browser) le `access_token`, `refresh_token` e `partner_key`
// de TODOS os tenants, porque a tabela nao tem RLS nem ACL de coluna.
//
// Estas operacoes nao leem credencial. Sao deliberadamente separadas das
// de cima: projecao minima, sem token, sem `partner_key`, sem
// `refresh_token`. Quem precisa de credencial usa as funcoes de
// credencial, que tem projecao propria e fechada.

export interface ResultadoLista2<T> {
  linhas: T[];
  erro: string | null;
}

/** Loja ativa vista pelo cron: o minimo para agrupar trabalho por dono. */
export interface LinhaLojaParaCron {
  user_id: string;
  marketplace: string;
}

/**
 * TODAS as lojas ativas com dono, de TODOS os tenants.
 *
 * ── A unica leitura cross-tenant deste modulo, e e proposital ──────────
 * O cron nao tem sessao: ele existe justamente para varrer todo mundo.
 * Filtrar por `user_id` aqui tornaria a funcao inutil. O que a mantem
 * segura e o que ela NAO devolve — nem id de loja, nem token, nem
 * `seller_id`, nem `nickname`. Só o par (dono, marketplace), que e
 * exatamente o que o agrupamento do cron consome.
 *
 * `user_id IS NOT NULL` reproduz o filtro que a rota ja aplicava: lojas
 * orfas existem no banco e nao pertencem a ninguem que se possa
 * sincronizar.
 */
export async function listarLojasAtivasParaCron(): Promise<ResultadoLista2<LinhaLojaParaCron>> {
  const { data, error } = await getSupabaseServidor()
    .from("lojas")
    .select("user_id, marketplace")
    .eq("ativo", true)
    .not("user_id", "is", null);

  if (error) {
    console.error("[credenciais] falha ao listar lojas ativas para o cron");
    return { linhas: [], erro: "erro_consulta_loja" };
  }
  return { linhas: (Array.isArray(data) ? data : []) as LinhaLojaParaCron[], erro: null };
}

export interface LinhaLojaParaJob {
  id: string;
  user_id: string | null;
  marketplace: string;
  ativo: boolean | null;
}

/**
 * Loja para validar um pedido de sync vindo do cliente.
 *
 * ── O filtro de dono entrou na query, e o contrato HTTP nao mudou ──────
 * A rota lia por `id` e comparava `user_id` em memoria, devolvendo 400
 * com a MESMA mensagem para "nao existe" e "e de outro dono". Com o par
 * na query, loja de terceiro devolve `linha: null`, cai no mesmo `!loja`
 * e produz o mesmo 400 com o mesmo texto — indistinguivel de antes, do
 * lado de fora.
 *
 * A checagem em memoria permanece na rota. E redundante agora, e e para
 * ser: o isolamento passa a ter duas camadas em vez de depender só da
 * disciplina de quem chama.
 */
export async function lerLojaParaValidacaoDeJob(
  lojaId: string,
  userId: string
): Promise<ResultadoLeitura<LinhaLojaParaJob>> {
  if (!lojaId || !userId) return { linha: null, erro: null };

  const { data, error } = await aplicarFiltros(
    getSupabaseServidor().from("lojas").select("id, user_id, marketplace, ativo"),
    filtrosGravacaoPorLojaEDono(lojaId, userId)
  ).maybeSingle();

  if (error) {
    console.error("[credenciais] falha ao ler loja para validacao de job");
    return { linha: null, erro: "erro_consulta_loja" };
  }
  return { linha: (data as LinhaLojaParaJob | null) ?? null, erro: null };
}

export interface LinhaLojaDoDono {
  id: string;
  nome: string | null;
  marketplace: string;
  seller_id: string | null;
  nickname: string | null;
  ativo: boolean | null;
  created_at: string | null;
}

/** As lojas ATIVAS do dono — o que a tela de lojas lista. Sem token. */
export async function listarLojasAtivasDoDono(
  userId: string
): Promise<ResultadoLista2<LinhaLojaDoDono>> {
  if (!userId) return { linhas: [], erro: null };

  const { data, error } = await getSupabaseServidor()
    .from("lojas")
    .select("id, nome, marketplace, seller_id, nickname, ativo, created_at")
    .eq("ativo", true)
    .eq("user_id", String(userId))
    .order("created_at");

  if (error) {
    console.error("[credenciais] falha ao listar lojas ativas do dono");
    return { linhas: [], erro: "erro_consulta_loja" };
  }
  return { linhas: (Array.isArray(data) ? data : []) as LinhaLojaDoDono[], erro: null };
}

/**
 * Só o `id` da loja ML ativa mais recente do dono.
 *
 * Existe separada de `lerCredencialMLAtivaDoDono` de proposito: aquela
 * projeta `access_token`/`refresh_token` porque quem a chama precisa
 * deles. Este chamador quer um id para devolver ao frontend, e trazer
 * token para a memoria de uma rota que nunca o usa e superficie a toa.
 */
export async function lerIdLojaMLAtivaMaisRecenteDoDono(
  userId: string
): Promise<{ lojaId: string | null; erro: string | null }> {
  if (!userId) return { lojaId: null, erro: null };

  const { data, error } = await aplicarFiltros(
    getSupabaseServidor().from("lojas").select("id"),
    filtrosMLAtivaDoDono(userId)
  )
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error("[credenciais] falha ao ler loja ML ativa mais recente do dono");
    return { lojaId: null, erro: "erro_consulta_loja" };
  }
  const linha = data as { id?: unknown } | null;
  return { lojaId: linha?.id ? String(linha.id) : null, erro: null };
}

export interface LinhaLojaParaResumo {
  id: string;
  marketplace: string;
  nickname: string | null;
}

/**
 * Cruzamento das lojas do dono com uma lista de ids ja conhecidos.
 *
 * Os dois filtros opcionais reproduzem os `.eq()` condicionais que a rota
 * de backfill aplicava. Sao campos de FILTRO, nunca colunas de escrita, e
 * a lista de ids nao dispensa o `user_id`: id vindo de outro tenant
 * simplesmente nao volta.
 */
export async function listarLojasDoDonoPorIds(
  userId: string,
  lojaIds: string[],
  opcoes: { marketplace?: string | null; nickname?: string | null } = {}
): Promise<ResultadoLista2<LinhaLojaParaResumo>> {
  if (!userId || !Array.isArray(lojaIds) || lojaIds.length === 0) {
    return { linhas: [], erro: null };
  }

  let consulta = getSupabaseServidor()
    .from("lojas")
    .select("id, marketplace, nickname")
    .eq("user_id", String(userId))
    .in("id", lojaIds);

  if (opcoes.marketplace) consulta = consulta.eq("marketplace", opcoes.marketplace);
  if (opcoes.nickname) consulta = consulta.eq("nickname", opcoes.nickname);

  const { data, error } = await consulta;

  if (error) {
    console.error("[credenciais] falha ao cruzar lojas do dono por ids");
    return { linhas: [], erro: "erro_consulta_loja" };
  }
  return { linhas: (Array.isArray(data) ? data : []) as LinhaLojaParaResumo[], erro: null };
}

export interface LinhaLojaConectada {
  id: string;
  nome: string | null;
  nickname: string | null;
  seller_id: string | null;
  created_at: string | null;
}

/**
 * Lojas do dono, de um marketplace, ativas e COM token.
 *
 * `access_token` entra no `.not(...)` mas NAO na projecao: a pergunta e
 * "esta conectada?", e a resposta e um booleano que o filtro ja resolve.
 * O valor do token nunca precisa sair do banco para isso — e o comentario
 * original da rota ja dizia exatamente isso ("nem para checar").
 */
export async function listarLojasConectadasDoDono(
  userId: string,
  marketplace: string
): Promise<ResultadoLista2<LinhaLojaConectada>> {
  if (!userId || !marketplace) return { linhas: [], erro: null };

  const { data, error } = await getSupabaseServidor()
    .from("lojas")
    .select("id, nome, nickname, seller_id, created_at")
    .eq("user_id", String(userId))
    .eq("marketplace", marketplace)
    .eq("ativo", true)
    .not("access_token", "is", null)
    .order("created_at", { ascending: false });

  if (error) {
    console.error("[credenciais] falha ao listar lojas conectadas do dono");
    return { linhas: [], erro: "erro_consulta_loja" };
  }
  return { linhas: (Array.isArray(data) ? data : []) as LinhaLojaConectada[], erro: null };
}

export interface LinhaLojaPublicacaoML {
  id: string;
  nome: string | null;
  nickname: string | null;
  seller_id: string | null;
  marketplace: string;
  ativo: boolean | null;
  user_id: string | null;
}

/**
 * Loja para o fluxo de publicacao no Mercado Livre.
 *
 * `user_id` continua na PROJECAO mesmo com o par ja na query: quem chama
 * mantem as tres checagens em memoria (`user_id`, `marketplace`,
 * `ativo`), e retira-las seria trocar defesa em profundidade por
 * economia de linha. O filtro na query e camada nova, nao substituta.
 */
export async function lerLojaParaPublicacaoML(
  lojaId: string,
  userId: string
): Promise<ResultadoLeitura<LinhaLojaPublicacaoML>> {
  if (!lojaId || !userId) return { linha: null, erro: null };

  const { data, error } = await aplicarFiltros(
    getSupabaseServidor()
      .from("lojas")
      .select("id, nome, nickname, seller_id, marketplace, ativo, user_id"),
    filtrosGravacaoPorLojaEDono(lojaId, userId)
  ).maybeSingle();

  if (error) {
    console.error("[credenciais] falha ao ler loja para publicacao ML");
    return { linha: null, erro: "erro_consulta_loja" };
  }
  return { linha: (data as LinhaLojaPublicacaoML | null) ?? null, erro: null };
}

/**
 * Grava credencial Shopee renovada.
 *
 * NÃO há compare-and-swap aqui, e isso é intencional nesta PR: a
 * ausência de CAS na Shopee é um limite PRÉ-EXISTENTE, documentado e
 * testado, cuja correção é frente própria. Acrescentá-lo aqui alteraria
 * semântica que esta PR se comprometeu a preservar.
 */
export async function gravarCredencialShopee(
  lojaId: string,
  userId: string,
  campos: CamposCredencialShopee
): Promise<void> {
  if (!lojaId || !userId) return;

  await aplicarFiltros(
    getSupabaseServidor().from("lojas").update(campos),
    filtrosGravacaoPorLojaEDono(lojaId, userId)
  );
}
