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
