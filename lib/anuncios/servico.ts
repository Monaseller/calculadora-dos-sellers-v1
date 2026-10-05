/**
 * Meus Produtos — acesso server-side a `anuncios` e `vendas_dia` (SEC-3-B2).
 *
 * ── Por que existe ──────────────────────────────────────────────────
 * As telas de anúncios e o dashboard liam e escreviam estas tabelas
 * DIRETO do browser, com a chave anon. O `user_id` vinha do cliente, e a
 * edição (`update(...).eq("id", ...)`) não tinha filtro de dono nenhum:
 * conhecer um id bastava para sobrescrever o anúncio de outro usuário.
 *
 * Agora o browser só fala com as rotas `/api/anuncios/**`. Estas funções
 * são o único caminho até as tabelas, e TODAS recebem o dono já derivado
 * da sessão pela rota. Com `service_role` o banco não filtra nada (e o
 * SEC-3-C vai ligar RLS sem policy, que a service_role ignora), então o
 * isolamento é este código — cada consulta e cada escrita leva
 * `user_id = dono` DENTRO da própria consulta.
 *
 * Recebem o cliente como parâmetro: a rota passa `getSupabaseServidor()`,
 * os testes passam um duplo. Nada aqui conhece Request, cookie ou sessão.
 */
import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

// ── Projeções ────────────────────────────────────────────────────────

/** Tudo que Meus Produtos (lista + formulário de edição) lê. Sem `user_id`. */
export const COLUNAS_ANUNCIO_TELA = [
  "id", "created_at", "nome", "marketplace", "categoria", "tipo_anuncio", "tipo_conta_shopee",
  "custo_produto", "insumos", "custo_frete", "frete_gratis", "imposto", "margem_desejada",
  "preco_ideal", "preco_anuncio", "ml_item_id", "thumbnail", "permalink", "ativo", "sku",
  "lucro_liquido", "margem_contribuicao", "peso_kg", "variation_id", "logistic_type",
].join(", ");

/** Exatamente as colunas que o dashboard já pedia. */
export const COLUNAS_ANUNCIO_DASHBOARD =
  "ml_item_id, thumbnail, nome, sku, marketplace, custo_produto, preco_anuncio, margem_contribuicao";

export type Projecao = "tela" | "dashboard";

/** Uma página nunca passa do `max-rows` do PostgREST (ver paginacao.ts). */
export const TAMANHO_MAXIMO_PAGINA = 1000;
/** Mesmo teto de lote da exclusão na tela (LOTE_MAXIMO_IDS). */
export const LOTE_MAXIMO_DESATIVACAO = 200;

// ── Whitelist de escrita ─────────────────────────────────────────────

type Tipo = "texto" | "texto_ou_nulo" | "numero" | "numero_ou_nulo" | "booleano" | "marketplace";

/**
 * Os ÚNICOS campos que o browser pode gravar. `user_id`, `id`,
 * `created_at` e qualquer chave de loja ficam de fora de propósito: o dono
 * é a sessão, e um campo fora desta lista é RECUSADO (400), não ignorado —
 * quem manda `user_id` ou `loja_id` está tentando escolher o dono.
 */
export const CAMPOS_GRAVAVEIS: Record<string, Tipo> = {
  nome: "texto",
  marketplace: "marketplace",
  categoria: "texto_ou_nulo",
  tipo_anuncio: "texto_ou_nulo",
  tipo_conta_shopee: "texto_ou_nulo",
  custo_produto: "numero",
  insumos: "numero",
  custo_frete: "numero",
  frete_gratis: "booleano",
  imposto: "numero",
  margem_desejada: "numero",
  preco_ideal: "numero_ou_nulo",
  preco_anuncio: "numero_ou_nulo",
  sku: "texto_ou_nulo",
  peso_kg: "numero_ou_nulo",
  ml_item_id: "texto_ou_nulo",
  variation_id: "texto_ou_nulo",
  thumbnail: "texto_ou_nulo",
  permalink: "texto_ou_nulo",
  ativo: "booleano",
  logistic_type: "texto_ou_nulo",
};

/** Obrigatórios na criação — o que o formulário sempre manda. */
const OBRIGATORIOS_CRIACAO = ["nome", "marketplace", "custo_produto"];

const TEXTO_MAX = 2000;

function valido(tipo: Tipo, v: unknown): boolean {
  switch (tipo) {
    // Vazio é aceito: o formulário já podia gravar nome "" (título/link vazio).
    case "texto": return typeof v === "string" && v.length <= TEXTO_MAX;
    case "texto_ou_nulo": return v === null || (typeof v === "string" && v.length <= TEXTO_MAX);
    case "numero": return typeof v === "number" && Number.isFinite(v);
    case "numero_ou_nulo": return v === null || (typeof v === "number" && Number.isFinite(v));
    case "booleano": return typeof v === "boolean";
    case "marketplace": return v === "ML" || v === "Shopee";
  }
}

export type ResultadoPayload =
  | { ok: true; campos: Record<string, unknown> }
  | { ok: false; erro: string };

/**
 * Monta o objeto gravável campo a campo — nunca `insert(body)`.
 * `parcial` (edição) não exige os obrigatórios, mas exige ao menos um campo.
 */
export function montarCamposGravaveis(corpo: unknown, parcial: boolean): ResultadoPayload {
  if (!corpo || typeof corpo !== "object" || Array.isArray(corpo)) {
    return { ok: false, erro: "Corpo inválido." };
  }
  const campos: Record<string, unknown> = {};
  for (const [chave, valor] of Object.entries(corpo as Record<string, unknown>)) {
    const tipo = CAMPOS_GRAVAVEIS[chave];
    if (!tipo) return { ok: false, erro: `Campo não permitido: ${chave}.` };
    if (!valido(tipo, valor)) return { ok: false, erro: `Valor inválido para ${chave}.` };
    campos[chave] = valor;
  }
  if (parcial) {
    if (Object.keys(campos).length === 0) return { ok: false, erro: "Nada para atualizar." };
  } else {
    for (const c of OBRIGATORIOS_CRIACAO) {
      if (!(c in campos)) return { ok: false, erro: `Campo obrigatório: ${c}.` };
    }
  }
  return { ok: true, campos };
}

// ── Operações ────────────────────────────────────────────────────────

/** Uma página dos anúncios ATIVOS do dono, na ordem da tela. `null` = falha. */
export async function listarAnunciosDoDono(
  cliente: SupabaseClient, dono: string, de: number, ate: number, projecao: Projecao
): Promise<Record<string, unknown>[] | null> {
  const { data, error } = await cliente
    .from("anuncios")
    .select(projecao === "dashboard" ? COLUNAS_ANUNCIO_DASHBOARD : COLUNAS_ANUNCIO_TELA)
    .eq("ativo", true)
    .eq("user_id", dono)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .range(de, ate);
  if (error) return null;
  return (data ?? []) as unknown as Record<string, unknown>[];
}

/** Cria UM anúncio com `user_id` = dono. Devolve o id ou `null`. */
export async function criarAnuncio(
  cliente: SupabaseClient, dono: string, campos: Record<string, unknown>
): Promise<string | null> {
  const { data, error } = await cliente
    .from("anuncios")
    .insert({ ...campos, user_id: dono })
    .select("id")
    .single();
  if (error || !data) return null;
  return (data as { id: string }).id;
}

/**
 * Edita UM anúncio do dono. `id` E `user_id` na MESMA escrita — nunca
 * `WHERE id = :id` sozinho. Anúncio alheio ou inexistente devolve `false`
 * do mesmo jeito: a rota responde 404 sem revelar se ele existe.
 */
export async function atualizarAnuncioDoDono(
  cliente: SupabaseClient, dono: string, id: string, campos: Record<string, unknown>
): Promise<boolean | null> {
  const { data, error } = await cliente
    .from("anuncios")
    .update(campos)
    .eq("id", id)
    .eq("user_id", dono)
    .select("id");
  if (error) return null;
  return (data ?? []).length > 0;
}

/**
 * Soft delete (`ativo:false`) de um lote do dono. Devolve os ids que o
 * banco CONFIRMOU — ids alheios simplesmente não voltam, e a tela os trata
 * como não confirmados (mesma semântica de antes).
 */
export type RespostaDesativacao = { ids: string[] | null; erro: string | null };

export async function desativarAnunciosDoDono(
  cliente: SupabaseClient, dono: string, ids: string[]
): Promise<RespostaDesativacao> {
  const { data, error } = await cliente
    .from("anuncios")
    .update({ ativo: false })
    .in("id", ids)
    .eq("user_id", dono)
    .select("id");
  if (error) return { ids: null, erro: "Falha ao excluir anúncios." };
  return { ids: (data ?? []).map((r: { id: string }) => r.id), erro: null };
}

/** O anúncio é do dono? Prova de posse ANTES de escrever em `vendas_dia`. */
export async function anuncioPertenceAoDono(
  cliente: SupabaseClient, dono: string, id: string
): Promise<boolean | null> {
  const { data, error } = await cliente
    .from("anuncios")
    .select("id")
    .eq("id", id)
    .eq("user_id", dono)
    .maybeSingle();
  if (error) return null;
  return !!data;
}

export interface VendaDiaEntrada { unidades_vendidas: number; faturamento: number; lucro: number }

export function validarVendaDia(corpo: unknown): VendaDiaEntrada | null {
  if (!corpo || typeof corpo !== "object" || Array.isArray(corpo)) return null;
  const c = corpo as Record<string, unknown>;
  const chaves = Object.keys(c);
  if (chaves.some((k) => !["unidades_vendidas", "faturamento", "lucro"].includes(k))) return null;
  const { unidades_vendidas, faturamento, lucro } = c;
  if (typeof unidades_vendidas !== "number" || !Number.isFinite(unidades_vendidas) || unidades_vendidas <= 0) return null;
  if (typeof faturamento !== "number" || !Number.isFinite(faturamento)) return null;
  if (typeof lucro !== "number" || !Number.isFinite(lucro)) return null;
  return { unidades_vendidas, faturamento, lucro };
}

/**
 * Registra a venda do dia de um anúncio JÁ provado do dono. A data é a do
 * servidor, no mesmo formato de antes (`toISOString` → dia UTC); a chave
 * de conflito continua `anuncio_id,data`.
 */
export async function registrarVendaDia(
  cliente: SupabaseClient, anuncioId: string, venda: VendaDiaEntrada, agora: Date = new Date()
): Promise<boolean> {
  const { error } = await cliente.from("vendas_dia").upsert({
    anuncio_id: anuncioId,
    data: agora.toISOString().split("T")[0],
    unidades_vendidas: venda.unidades_vendidas,
    faturamento: venda.faturamento,
    lucro: venda.lucro,
  }, { onConflict: "anuncio_id,data" });
  return !error;
}
