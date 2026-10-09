/**
 * Importacao de anuncios Shopee em FATIAS retomaveis (Shopee product import V2).
 *
 * Uma chamada de POST /api/shopee/importar-anuncios processa uma FATIA da
 * loja escolhida e devolve um cursor; a tela chama de novo com ele ate
 * `parcial: false`. Nenhuma fatia depende de caber inteira nos 60s da funcao.
 *
 * Garantias:
 *   - ORDEM DETERMINISTICA: os item_id da loja (get_item_list, NORMAL) sao
 *     ordenados numericamente; o cursor e "ultimo item_id CONCLUIDO" — nunca
 *     offset (a lista da Shopee pode mudar entre chamadas).
 *   - ITEM ATOMICO: um item so conta como concluido quando TODAS as suas
 *     models foram lidas e TODAS as suas linhas persistidas; o cursor so
 *     avanca sobre o prefixo contiguo de itens concluidos E gravados.
 *   - ORCAMENTO: nao inicia item novo depois de ORCAMENTO_FATIA_MS desde o
 *     inicio da request; item ja iniciado termina.
 *   - IDEMPOTENTE: existentes lidos por dono + LOJA; linha igual nao e
 *     regravada (ignorados); so campos da Shopee (nome, preco, foto; SKU so
 *     se faltar) sao atualizados — custo/imposto/insumos/ativo do usuario
 *     nunca. Linhas novas vao num INSERT em lote; a UNIQUE de identidade
 *     (dono+loja+marketplace+item+model) e a ultima barreira. Falha → para,
 *     sem avancar o cursor alem do que foi gravado (fail-closed).
 *   - PRECO: price_info.current_price ja vem em REAIS (Open API v2) — direto.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { shopeeGet } from "@/lib/shopee-api";
import { lerTodasAsPaginas } from "@/lib/anuncios/leitura-paginada";

export const ORCAMENTO_FATIA_MS = 35_000;
export const CONCORRENCIA_MODELOS = 3;
/** Limites da Open API v2: get_item_list page_size ≤ 100; get_item_base_info ≤ 50 item_id. */
export const PAGINA_LISTA = 100;
export const LOTE_BASE_INFO = 50;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ITEM_ID = /^\d{1,20}$/;

// ── Cursor ────────────────────────────────────────────────────────────
// Opaco para a tela; carrega a LOJA para que um cursor nunca valha em outra.
export function codificarCursor(lojaId: string, ultimoItem: string): string {
  return Buffer.from(JSON.stringify({ v: 1, l: lojaId, i: ultimoItem }), "utf8").toString("base64url");
}
export type CursorLido = { ok: true; ultimoItem: string | null } | { ok: false; motivo: "CURSOR_INVALIDO" | "CURSOR_DE_OUTRA_LOJA" };
export function lerCursor(cursor: unknown, lojaId: string): CursorLido {
  if (cursor === undefined || cursor === null || cursor === "") return { ok: true, ultimoItem: null };
  if (typeof cursor !== "string" || cursor.length > 400) return { ok: false, motivo: "CURSOR_INVALIDO" };
  let c: any;
  try { c = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")); } catch { return { ok: false, motivo: "CURSOR_INVALIDO" }; }
  if (!c || c.v !== 1 || typeof c.l !== "string" || !UUID.test(c.l) || typeof c.i !== "string" || !ITEM_ID.test(c.i)) {
    return { ok: false, motivo: "CURSOR_INVALIDO" };
  }
  if (c.l !== lojaId) return { ok: false, motivo: "CURSOR_DE_OUTRA_LOJA" };
  return { ok: true, ultimoItem: c.i };
}

const cmpItem = (a: string, b: string) => { const x = BigInt(a), y = BigInt(b); return x < y ? -1 : x > y ? 1 : 0; };

export class ErroImportacaoShopee extends Error {
  /** Ultimo item CONCLUIDO e gravado antes da falha (null = nenhum nesta fatia alem do cursor recebido). */
  ultimoConcluido: string | null = null;
  constructor(public codigo: "PROVIDER" | "BANCO", mensagem: string) { super(mensagem); }
}

export interface CredencialLoja { partnerId: string; partnerKey: string; accessToken: string; shopId: number | string }
export interface ResultadoFatia {
  parcial: boolean;
  cursor: string | null;
  importados: number;
  atualizados: number;
  ignorados: number;
  itensProcessados: number;
  total: number;
}

interface LinhaShopee { ml_item_id: string; variation_id: string | null; nome: string; preco_anuncio: number; sku: string | null; thumbnail: string | null }

/** Resposta da Shopee com erro de negocio (`error` preenchido) nunca vira "vazio". */
async function chamar(cred: CredencialLoja, path: string, params: Record<string, string | number>, contexto: string): Promise<any> {
  let data: any;
  try { data = await shopeeGet(path, cred.partnerId, cred.partnerKey, cred.accessToken, cred.shopId, params); }
  catch (e: any) { throw new ErroImportacaoShopee("PROVIDER", `${contexto}: ${String(e?.message ?? e).slice(0, 160)}`); }
  if (data?.error) throw new ErroImportacaoShopee("PROVIDER", `${contexto}: ${String(data.error)} ${String(data.message ?? "").slice(0, 120)}`.trim());
  return data;
}

async function listarItens(cred: CredencialLoja): Promise<string[]> {
  const ids = new Set<string>();
  for (let offset = 0, pagina = 0; pagina < 1000; pagina++) {
    const data = await chamar(cred, "/api/v2/product/get_item_list", { offset, page_size: PAGINA_LISTA, item_status: "NORMAL" }, "get_item_list");
    for (const i of (data?.response?.item ?? []) as any[]) if (i?.item_id != null) ids.add(String(i.item_id));
    if (!data?.response?.has_next_page) break;
    offset = Number(data.response.next_offset ?? offset + PAGINA_LISTA);
  }
  return [...ids].filter((id) => ITEM_ID.test(id)).sort(cmpItem);
}

/** Todas as linhas de UM item (sem variacao: 1 linha; com variacao: 1 por model). */
async function linhasDoItem(cred: CredencialLoja, item: any): Promise<LinhaShopee[]> {
  const itemId = String(item.item_id);
  const titulo = item.item_name ?? itemId;
  const thumbnail = item.image?.image_url_list?.[0] ?? null;
  const temModelos = (item.has_model ?? false) || (item.model_list?.length ?? 0) > 0;
  if (!temModelos) {
    // Open API v2: current_price ja em REAIS (mesma unidade de model_discounted_price dos pedidos)
    return [{ ml_item_id: itemId, variation_id: null, nome: titulo, preco_anuncio: Number(item.price_info?.[0]?.current_price ?? item.price ?? 0), sku: item.sku ?? null, thumbnail }];
  }
  const data = await chamar(cred, "/api/v2/product/get_model_list", { item_id: itemId }, `get_model_list item ${itemId}`);
  return ((data?.response?.model ?? []) as any[]).map((m) => ({
    ml_item_id: itemId, variation_id: String(m.model_id),
    nome: m.model_name ? `${titulo} - ${m.model_name}` : titulo,
    preco_anuncio: Number(m.price_info?.[0]?.current_price ?? 0),
    sku: m.model_sku ?? null, thumbnail,
  }));
}

/**
 * Processa UMA fatia. `inicioMs` = inicio da request (o orcamento conta
 * tudo, inclusive a listagem). Lanca ErroImportacaoShopee em falha — o que
 * ja foi gravado fica; o cursor da proxima chamada e o da fatia anterior.
 */
export async function importarFatiaShopee(args: {
  banco: SupabaseClient; userId: string; lojaId: string; cred: CredencialLoja;
  ultimoItem: string | null; inicioMs: number; orcamentoMs?: number; agora?: () => number;
}): Promise<ResultadoFatia> {
  const { banco, userId, lojaId, cred, ultimoItem } = args;
  const orcamento = args.orcamentoMs ?? ORCAMENTO_FATIA_MS;
  const agora = args.agora ?? (() => Date.now());
  const estourou = () => agora() - args.inicioMs >= orcamento;

  const todos = await listarItens(cred);
  const restantes = ultimoItem === null ? todos : todos.filter((id) => cmpItem(id, ultimoItem) > 0);

  // Existentes SO desta loja (chave item|variacao vale dentro dela), TODAS as paginas
  // (o PostgREST corta em 1000 sem erro). Leitura falha ou incompleta → para.
  const existentes = await lerTodasAsPaginas<any>(() => banco
    .from("anuncios")
    .select("id, ml_item_id, variation_id, nome, preco_anuncio, thumbnail, sku")
    .eq("marketplace", "Shopee")
    .eq("user_id", userId)
    .eq("loja_id", lojaId));
  if (!existentes.ok) throw new ErroImportacaoShopee("BANCO", "leitura dos anuncios existentes falhou");
  const existMap = new Map<string, any>();
  for (const row of existentes.linhas) existMap.set(`${row.ml_item_id}|${row.variation_id ?? ""}`, row);

  const r: ResultadoFatia = { parcial: false, cursor: null, importados: 0, atualizados: 0, ignorados: 0, itensProcessados: 0, total: todos.length };
  let cursorItem: string | null = ultimoItem;

  try {
  for (let ini = 0; ini < restantes.length; ini += LOTE_BASE_INFO) {
    if (estourou()) break;
    const lote = restantes.slice(ini, ini + LOTE_BASE_INFO);
    const base = await chamar(cred, "/api/v2/product/get_item_base_info",
      { item_id_list: lote.join(","), need_tax_info: "false", need_complaint_policy: "false" }, "get_item_base_info");
    const porId = new Map<string, any>();
    for (const it of (base?.response?.item_list ?? []) as any[]) porId.set(String(it.item_id), it);

    // Itens do lote, em ordem, com no maximo CONCORRENCIA_MODELOS em voo.
    // Item novo so comeca dentro do orcamento; item iniciado termina.
    const linhas: (LinhaShopee[] | undefined)[] = new Array(lote.length);
    let proximo = 0, falha: unknown = null;
    const trabalhador = async () => {
      for (;;) {
        if (falha !== null || proximo >= lote.length || estourou()) return;
        const i = proximo++;
        const item = porId.get(lote[i]);
        try { linhas[i] = item ? await linhasDoItem(cred, item) : []; }   // sumiu entre listagem e detalhe → nada a gravar
        catch (e) { if (falha === null) falha = e; return; }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCORRENCIA_MODELOS, lote.length) }, trabalhador));

    // Prefixo contiguo de itens concluidos: SO ele e gravado e SO ele move o cursor.
    let k = 0;
    while (k < lote.length && linhas[k] !== undefined) k++;
    const novas: Record<string, unknown>[] = [];
    const mudancas: { id: string; upd: Record<string, unknown> }[] = [];
    for (let i = 0; i < k; i++) {
      for (const l of linhas[i]!) {
        const existente = existMap.get(`${l.ml_item_id}|${l.variation_id ?? ""}`);
        if (!existente) {
          novas.push({
            marketplace: "Shopee", nome: l.nome, ml_item_id: l.ml_item_id, variation_id: l.variation_id,
            preco_anuncio: l.preco_anuncio, sku: l.sku, thumbnail: l.thumbnail,
            custo_produto: 0, insumos: 0, custo_frete: 0, imposto: 0,
            margem_desejada: 0, frete_gratis: false, ativo: true,
            user_id: userId, loja_id: lojaId,
          });
          continue;
        }
        // So campos da Shopee; `ativo` e campos do usuario fora (F0.c.18A).
        const upd: Record<string, unknown> = {};
        if (existente.nome !== l.nome) upd.nome = l.nome;
        if (Number(existente.preco_anuncio) !== l.preco_anuncio) upd.preco_anuncio = l.preco_anuncio;
        if ((existente.thumbnail ?? null) !== l.thumbnail) upd.thumbnail = l.thumbnail;
        if (!existente.sku && l.sku) upd.sku = l.sku;
        if (Object.keys(upd).length === 0) r.ignorados++;
        else mudancas.push({ id: existente.id, upd });
      }
    }
    if (novas.length > 0) {
      const { error } = await banco.from("anuncios").insert(novas);
      if (error) throw new ErroImportacaoShopee("BANCO", "insercao em lote recusada pelo banco");
      r.importados += novas.length;
    }
    for (const m of mudancas) {
      const { error } = await banco.from("anuncios").update(m.upd).eq("id", m.id).eq("user_id", userId).eq("loja_id", lojaId);
      if (error) throw new ErroImportacaoShopee("BANCO", "atualizacao recusada pelo banco");
      r.atualizados++;
    }
    if (k > 0) cursorItem = lote[k - 1];
    r.itensProcessados += k;
    if (falha !== null) throw falha instanceof ErroImportacaoShopee ? falha : new ErroImportacaoShopee("PROVIDER", String((falha as any)?.message ?? falha));
    if (k < lote.length) break;                         // orcamento acabou no meio do lote
  }
  } catch (e) {
    // Falha: o que foi gravado fica; o erro diz ate onde ha itens COMPLETOS.
    const erro = e instanceof ErroImportacaoShopee ? e : new ErroImportacaoShopee("PROVIDER", String((e as any)?.message ?? e));
    erro.ultimoConcluido = cursorItem;
    throw erro;
  }

  const fim = restantes.length === 0 || (cursorItem !== null && cmpItem(cursorItem, restantes[restantes.length - 1]) >= 0);
  r.parcial = !fim;
  r.cursor = fim ? null : codificarCursor(lojaId, cursorItem ?? "0");
  return r;
}
