/**
 * Importacao do catalogo Mercado Livre em FATIAS retomaveis, POR LOJA (CDS V2 Fase 2D — ML import V2).
 *
 * Uma chamada de POST /api/ml/importar-anuncios processa UMA fatia da loja ML resolvida pela rota e
 * devolve um cursor; a tela chama de novo com ele ate `parcial: false`.
 *
 * Garantias:
 *   - LOJA EXPLICITA: `lojaId` e obrigatorio. Antes de qualquer chamada ao ML o motor valida a loja
 *     (dono + marketplace ML + ativa) e resolve a credencial DAQUELA loja no servidor
 *     (resolverContaML SEM permitirUnica — a escolha da loja unica e da borda, nunca do motor) e
 *     confere que o token pertence ao seller da loja (/users/me).
 *   - CURSOR PRESO A LOJA: carrega a loja; cursor de outra loja (ou de outro marketplace) e recusado
 *     ANTES do provider.
 *   - ORDEM DETERMINISTICA: os ids da loja sao ordenados (prefixo + numero); o cursor e o "ultimo
 *     item CONCLUIDO" — nunca offset (a lista do ML pode mudar entre chamadas).
 *   - ITEM ATOMICO / LOTE: um lote de itens so move o cursor depois que TODAS as suas linhas foram
 *     gravadas; erro de leitura do provider ou de escrita interrompe a fatia (fail-closed) e o
 *     cursor devolvido e o do ultimo lote gravado. Nenhum "importado" sem gravacao confirmada.
 *   - ORCAMENTO: nao inicia lote novo depois de ORCAMENTO_FATIA_MS desde o inicio da request.
 *   - IDEMPOTENTE EM RETRY SEQUENCIAL: existentes lidos por dono + ML + LOJA (todas as paginas);
 *     linha igual nao e regravada (ignorados). Concorrencia: SEM garantia forte ate a UNIQUE de
 *     identidade ML (20261108) — nao ha lease/lock duravel de import de catalogo; nada aqui finge
 *     uma garantia em memoria.
 *   - ESCOPO DE ESCRITA: INSERT sempre com loja_id explicito (o runtime nao depende da ponte
 *     transitoria do trigger); UPDATE por id + dono + ML + loja e exige exatamente 1 linha.
 *   - CAMPOS: so campos do ML (nome, preco, tipo, logistica, frete gratis, foto, link; peso/frete/
 *     SKU so se vazios). custo/insumos/imposto/margem/preco_ideal/ativo do usuario nunca. Linha nova
 *     NAO forca imposto/margem — vale o default do banco.
 *
 *   - OBSERVACAO (Fase 2H-C): cada item que VOLTOU no multiget (code 200) e uma observacao positiva:
 *     visto_em = instante da resposta do lote; status_marketplace = `item.status` RAW so se presente
 *     (sem status → so visto_em; o status anterior fica). Linha nova nasce com a observacao no INSERT;
 *     linha existente (inclusive soft-deleted, `ativo=false`) recebe um UPDATE SEPARADO so de
 *     { status_marketplace?, visto_em } por id + dono + ML + loja, DEPOIS das escritas de negocio e
 *     ANTES do cursor avancar; falha → a fatia falha (fail-closed). Nao conta como "atualizado".
 *     Ausencia (item que nao voltou) nao escreve nada.
 *
 * Paginacao do ML: o repositorio so comprova `/users/{seller}/items/search?status=active&limit&offset`
 * (sem modo scan/scroll comprovado) — ML_V2_SCAN_SUPPORTED = NO. Limitacao conhecida do provider: a
 * busca por offset pode nao alcancar catalogos muito grandes. Listagem: so `active`; ausencia NUNCA
 * vira status (reconciliacao por ausencia proibida).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { lerTodasAsPaginas } from "@/lib/anuncios/leitura-paginada";
import { gravarObservacoes, observacaoPositiva, type ObservacaoMarketplace } from "@/lib/anuncios/observacao-marketplace";
import { resolverContaML } from "@/lib/ml-conexao";
import { calcularFreteMl, calcularFreteFullMl, calcularFreteFlexMl } from "@/lib/tabela-frete-ml";
import { CATEGORIAS_ML } from "@/lib/comissoes-mercado-livre";

export const ORCAMENTO_FATIA_MS = 35_000;
/** Limites usados pelo fluxo atual: /items/search limit 100; multiget /items?ids ≤ 20. */
export const PAGINA_LISTA = 100;
export const LOTE_DETALHE = 20;
export const MAX_PAGINAS_LISTA = 1000;
export const STATUS_IMPORTADOS = ["active"] as const;

const API = "https://api.mercadolibre.com";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ITEM_ID = /^[A-Z]{3,4}\d{1,20}$/;

// ── Cursor ────────────────────────────────────────────────────────────
/** Opaco para a tela; carrega marketplace + LOJA para que um cursor nunca valha em outra. */
export function codificarCursorML(lojaId: string, ultimoItem: string): string {
  return Buffer.from(JSON.stringify({ v: 1, m: "ML", l: lojaId, i: ultimoItem }), "utf8").toString("base64url");
}
export type CursorMLLido = { ok: true; ultimoItem: string | null } | { ok: false; motivo: "CURSOR_INVALIDO" | "CURSOR_DE_OUTRA_LOJA" };
export function lerCursorML(cursor: unknown, lojaId: string): CursorMLLido {
  if (cursor === undefined || cursor === null || cursor === "") return { ok: true, ultimoItem: null };
  if (typeof cursor !== "string" || cursor.length > 400) return { ok: false, motivo: "CURSOR_INVALIDO" };
  let c: any;
  try { c = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")); } catch { return { ok: false, motivo: "CURSOR_INVALIDO" }; }
  if (!c || c.v !== 1 || c.m !== "ML" || typeof c.l !== "string" || !UUID.test(c.l) || typeof c.i !== "string" || !ITEM_ID.test(c.i)) {
    return { ok: false, motivo: "CURSOR_INVALIDO" };
  }
  if (c.l !== lojaId) return { ok: false, motivo: "CURSOR_DE_OUTRA_LOJA" };
  return { ok: true, ultimoItem: c.i };
}

/** Ordem total dos ids do ML: prefixo do site, depois o numero. */
export function cmpItemML(a: string, b: string): number {
  const x = /^([A-Z]+)(\d+)$/.exec(a)!, y = /^([A-Z]+)(\d+)$/.exec(b)!;
  if (x[1] !== y[1]) return x[1] < y[1] ? -1 : 1;
  const nx = BigInt(x[2]), ny = BigInt(y[2]);
  return nx < ny ? -1 : nx > ny ? 1 : 0;
}

export type CodigoErroImportacaoML = "CURSOR" | "LOJA" | "TOKEN" | "PROVIDER" | "BANCO";
export class ErroImportacaoML extends Error {
  /** Ultimo item CONCLUIDO e gravado antes da falha (null = nenhum alem do cursor recebido). */
  ultimoConcluido: string | null = null;
  constructor(public codigo: CodigoErroImportacaoML, mensagem: string, public motivo?: string) { super(mensagem); }
}

export interface ResultadoFatiaML {
  lojaId: string;
  parcial: boolean;
  cursor: string | null;
  importados: number;
  atualizados: number;
  ignorados: number;
  itensProcessados: number;
  total: number;
}

/** Uma linha do catalogo ML: item sem variacao (variation_id null) ou UMA variacao. */
export interface LinhaML {
  ml_item_id: string; variation_id: string | null; nome: string; preco_anuncio: number; tipo_anuncio: string;
  categoria: string | null; logistic_type: string; frete_gratis: boolean; peso_kg: number | null;
  custo_frete: number | null; sku: string | null; thumbnail: string | null; permalink: string | null;
}

// ── Mapeamentos (iguais aos do fluxo anterior) ────────────────────────
export function mapTipoAnuncio(listingTypeId: string): string {
  return (listingTypeId === "gold_premium" || listingTypeId === "gold_pro") ? "Premium" : "Clássico";
}
function mapLogisticType(t: string): string {
  const m: Record<string, string> = {
    fulfillment: "fulfillment", self_service: "self_service", me2: "me2", me1: "me1",
    drop_off: "drop_off", xd_drop_off: "xd_drop_off", cross_docking: "cross_docking",
  };
  return m[t] ?? t;
}
function parsePeso(dim: string | null | undefined, attributes: any[]): number | null {
  if (Array.isArray(attributes)) {
    const attr = attributes.find((a: any) => ["WEIGHT", "SHIPPING_WEIGHT", "ITEM_WEIGHT", "NET_WEIGHT"].includes((a.id ?? "").toUpperCase()));
    if (attr?.value_name) {
      const s = String(attr.value_name).toLowerCase().trim();
      const g = s.match(/^([\d.,]+)\s*g$/);
      if (g) { const v = parseFloat(g[1].replace(",", ".")) / 1000; if (v > 0 && v <= 150) return v; }
      const kg = s.match(/^([\d.,]+)\s*kg$/);
      if (kg) { const v = parseFloat(kg[1].replace(",", ".")); if (v > 0 && v <= 150) return v; }
    }
  }
  if (dim) {
    const m = dim.match(/^[\d.]+[xX][\d.]+[xX][\d.]+,\s*([\d.]+)/);
    if (m) {
      const w = parseFloat(m[1]);
      if (w > 0) { const kg = w >= 20 ? w / 1000 : w; if (kg >= 0.001 && kg <= 150) return kg; }
    }
  }
  return null;
}
function mapCategoria(mlCategoryName: string | null): string | null {
  if (!mlCategoryName) return null;
  const nameLower = mlCategoryName.toLowerCase();
  const exact = CATEGORIAS_ML.find((c) => c.nome.toLowerCase() === nameLower);
  if (exact) return exact.nome;
  const partial = CATEGORIAS_ML.find((c) => nameLower.includes(c.nome.toLowerCase()) || c.nome.toLowerCase().includes(nameLower.split(/[,>/]/)[0].trim()));
  return partial ? partial.nome : null;
}
function calcularFreteParaItem(pesoKg: number | null, preco: number, logisticType: string): number | null {
  if (!preco) return null;
  if (logisticType === "self_service") return calcularFreteFlexMl(preco);
  if (logisticType === "fulfillment") return pesoKg ? calcularFreteFullMl("P", preco, pesoKg) : null;
  return pesoKg ? calcularFreteMl(pesoKg, preco) : null;
}

/** Todas as linhas de UM item (sem variacao: 1 linha; com variacao: 1 por variacao — sem linha-pai). */
export function linhasDoItemML(item: any, categoria: string | null): LinhaML[] {
  const itemId: string = item.id;
  const titulo: string = item.title ?? itemId;
  const tipoAnuncio = mapTipoAnuncio(item.listing_type_id ?? "");
  const logisticType = mapLogisticType(item.shipping?.logistic_type ?? "");
  const freteGratis = item.shipping?.free_shipping === true;
  const dim: string | null = item.shipping?.dimensions ?? null;
  const attrs: any[] = item.attributes ?? [];
  const thumbnail: string | null = item.thumbnail ?? item.pictures?.[0]?.url ?? null;
  const permalink: string | null = item.permalink ?? null;
  const variations: any[] = item.variations ?? [];
  if (variations.length === 0) {
    const preco: number = item.sale_price?.amount ?? item.price ?? 0;
    const peso = parsePeso(dim, attrs);
    return [{ ml_item_id: itemId, variation_id: null, nome: titulo, preco_anuncio: preco, tipo_anuncio: tipoAnuncio, categoria,
      logistic_type: logisticType, frete_gratis: freteGratis, peso_kg: peso, custo_frete: calcularFreteParaItem(peso, preco, logisticType),
      sku: item.seller_custom_field || null, thumbnail, permalink }];
  }
  return variations.map((v: any) => {
    const varDesc = ((v.attribute_combinations ?? []) as any[]).map((a) => a.value_name).filter(Boolean).join(" / ");
    const preco: number = v.sale_price?.amount ?? v.price ?? item.sale_price?.amount ?? item.price ?? 0;
    const varPicId: string | null = v.picture_ids?.[0] ?? null;
    const varThumb = varPicId ? (item.pictures?.find((p: any) => p.id === varPicId)?.url ?? thumbnail) : thumbnail;
    const peso = parsePeso(dim, [...(v.attributes ?? []), ...attrs]);
    return { ml_item_id: itemId, variation_id: String(v.id), nome: varDesc ? `${titulo} - ${varDesc}` : titulo, preco_anuncio: preco,
      tipo_anuncio: tipoAnuncio, categoria, logistic_type: logisticType, frete_gratis: freteGratis, peso_kg: peso,
      custo_frete: calcularFreteParaItem(peso, preco, logisticType), sku: v.seller_custom_field || null, thumbnail: varThumb, permalink };
  });
}

// ── Provider ──────────────────────────────────────────────────────────
async function getML(path: string, token: string, contexto: string): Promise<any> {
  let r: Response;
  try { r = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${token}` } }); }
  catch (e: any) { throw new ErroImportacaoML("PROVIDER", `${contexto}: ${String(e?.message ?? e).slice(0, 120)}`); }
  if (!r.ok) throw new ErroImportacaoML(contexto === "users/me" ? "TOKEN" : "PROVIDER", `${contexto}: HTTP ${r.status}`);
  try { return await r.json(); } catch { throw new ErroImportacaoML("PROVIDER", `${contexto}: resposta ilegivel`); }
}
async function listarItens(sellerId: string, token: string): Promise<string[]> {
  const ids = new Set<string>();
  for (let offset = 0, pagina = 0; pagina < MAX_PAGINAS_LISTA; pagina++) {
    const data = await getML(`/users/${encodeURIComponent(sellerId)}/items/search?status=active&limit=${PAGINA_LISTA}&offset=${offset}`, token, "items/search");
    const results: string[] = data?.results ?? [];
    for (const id of results) if (typeof id === "string" && ITEM_ID.test(id)) ids.add(id);
    if (results.length < PAGINA_LISTA) break;
    offset += PAGINA_LISTA;
  }
  return [...ids].sort(cmpItemML);
}

/**
 * Processa UMA fatia do catalogo da loja `lojaId` do dono `userId`. `inicioMs` = inicio da request.
 * Lanca ErroImportacaoML em falha — o que ja foi gravado fica; `ultimoConcluido` diz onde retomar.
 */
export async function importarCatalogoML(args: {
  banco: SupabaseClient; userId: string; lojaId: string; cursor?: unknown;
  inicioMs: number; orcamentoMs?: number; agora?: () => number;
  /** Instante de cada observação (uma por resposta de lote). Seam determinístico para testes. */
  observadoEm?: () => Date;
}): Promise<ResultadoFatiaML> {
  const { banco, userId, lojaId } = args;
  const observadoEm = args.observadoEm ?? (() => new Date());
  if (!userId || typeof lojaId !== "string" || !UUID.test(lojaId)) throw new ErroImportacaoML("LOJA", "loja ML explicita obrigatoria", "LOJA_INVALIDA");
  const orcamento = args.orcamentoMs ?? ORCAMENTO_FATIA_MS;
  const agora = args.agora ?? (() => Date.now());
  const estourou = () => agora() - args.inicioMs >= orcamento;

  // 1. Cursor preso a loja — ANTES de qualquer provider.
  const cursorLido = lerCursorML(args.cursor, lojaId);
  if (!cursorLido.ok) throw new ErroImportacaoML("CURSOR", "cursor recusado", cursorLido.motivo);

  // 2. Loja do dono + marketplace ML + ativa, credencial DESTA loja (sem loja unica implicita).
  const conta = await resolverContaML(userId, lojaId);
  if (!conta.ok) throw new ErroImportacaoML("LOJA", "loja ML nao resolvida", conta.motivo);
  if (conta.lojaId !== lojaId) throw new ErroImportacaoML("LOJA", "credencial de outra loja", "LOJA_DIVERGENTE");
  const token = conta.accessToken;

  // 3. O token e da conta desta loja?
  const me = await getML("/users/me", token, "users/me");
  const sellerToken = me?.id === undefined || me?.id === null ? "" : String(me.id);
  if (!sellerToken) throw new ErroImportacaoML("TOKEN", "users/me sem id");
  if (conta.sellerId && String(conta.sellerId) !== sellerToken) throw new ErroImportacaoML("LOJA", "token de outra conta ML", "CONTA_DIVERGENTE");

  const todos = await listarItens(sellerToken, token);
  const ultimoItem = cursorLido.ultimoItem;
  const restantes = ultimoItem === null ? todos : todos.filter((id) => cmpItemML(id, ultimoItem) > 0);

  // 4. Existentes SO desta loja (chave item|variacao vale dentro dela), TODAS as paginas.
  const existentes = await lerTodasAsPaginas<any>(() => banco
    .from("anuncios")
    .select("id, ml_item_id, variation_id, nome, preco_anuncio, tipo_anuncio, logistic_type, frete_gratis, thumbnail, permalink, peso_kg, custo_frete, sku, loja_id")
    .eq("marketplace", "ML")
    .eq("user_id", userId)
    .eq("loja_id", lojaId));
  if (!existentes.ok) throw new ErroImportacaoML("BANCO", "leitura dos anuncios existentes falhou");
  const existMap = new Map<string, any>();
  for (const row of existentes.linhas) {
    if (row.loja_id !== lojaId) throw new ErroImportacaoML("BANCO", "linha de outra loja no mapa de existentes");
    existMap.set(`${row.ml_item_id}|${row.variation_id ?? ""}`, row);
  }

  const categorias = new Map<string, string | null>();
  async function categoriaDe(categoryId: string): Promise<string | null> {
    if (!categoryId) return null;
    if (categorias.has(categoryId)) return categorias.get(categoryId)!;
    let nome: string | null = null;
    try {
      const r = await fetch(`${API}/categories/${encodeURIComponent(categoryId)}`, { headers: { Authorization: `Bearer ${token}` } });
      if (r.ok) { const d = await r.json(); const path: any[] = d.path_from_root ?? []; nome = path.length >= 2 ? path[1].name : (d.name ?? null); }
    } catch { /* categoria e descritiva: ausencia nao falha o import */ }
    const mapeada = mapCategoria(nome);
    categorias.set(categoryId, mapeada);
    return mapeada;
  }

  const r: ResultadoFatiaML = { lojaId, parcial: false, cursor: null, importados: 0, atualizados: 0, ignorados: 0, itensProcessados: 0, total: todos.length };
  let cursorItem: string | null = ultimoItem;

  try {
    for (let ini = 0; ini < restantes.length; ini += LOTE_DETALHE) {
      if (ini > 0 && estourou()) break;                       // toda fatia avança ao menos UM lote (sem laço parado)
      const lote = restantes.slice(ini, ini + LOTE_DETALHE);
      const raw: any[] = await getML(`/items?ids=${lote.join(",")}&include_attributes=all`, token, "items multiget");
      const instante = observadoEm();                          // UM instante por resposta: todas as rows do item iguais
      const observacoes: { id: string; obs: ObservacaoMarketplace }[] = [];
      const porId = new Map<string, any>();
      for (const x of Array.isArray(raw) ? raw : []) if (x?.code === 200 && x.body?.id) porId.set(String(x.body.id), x.body);

      const novas: Record<string, unknown>[] = [];
      const mudancas: { id: string; upd: Record<string, unknown> }[] = [];
      for (const itemId of lote) {
        const item = porId.get(itemId);
        if (!item) continue;                                   // sumiu entre listagem e detalhe → nada a gravar (nem observacao)
        // status do ITEM/anuncio (RAW, se a resposta trouxe): o mesmo para todas as rows/variacoes dele
        const obs = observacaoPositiva(instante, item.status);
        for (const l of linhasDoItemML(item, await categoriaDe(item.category_id ?? ""))) {
          const existente = existMap.get(`${l.ml_item_id}|${l.variation_id ?? ""}`);
          if (!existente) {
            novas.push({
              marketplace: "ML", user_id: userId, loja_id: lojaId,
              nome: l.nome, ml_item_id: l.ml_item_id, variation_id: l.variation_id,
              preco_anuncio: l.preco_anuncio, tipo_anuncio: l.tipo_anuncio, categoria: l.categoria,
              logistic_type: l.logistic_type, frete_gratis: l.frete_gratis, peso_kg: l.peso_kg,
              custo_frete: l.custo_frete ?? 0, sku: l.sku, thumbnail: l.thumbnail, permalink: l.permalink,
              custo_produto: 0, insumos: 0, ativo: true,
              ...obs,
            });
            continue;
          }
          observacoes.push({ id: existente.id, obs });         // existente (ativo ou nao): observacao em escrita SEPARADA
          // So campos do ML; `ativo` e campos do usuario fora (F0.c.18A). Peso/frete/SKU so se vazios.
          const upd: Record<string, unknown> = {};
          if (existente.nome !== l.nome) upd.nome = l.nome;
          if (Number(existente.preco_anuncio) !== l.preco_anuncio) upd.preco_anuncio = l.preco_anuncio;
          if (existente.tipo_anuncio !== l.tipo_anuncio) upd.tipo_anuncio = l.tipo_anuncio;
          if (existente.logistic_type !== l.logistic_type) upd.logistic_type = l.logistic_type;
          if (existente.frete_gratis !== l.frete_gratis) upd.frete_gratis = l.frete_gratis;
          if ((existente.thumbnail ?? null) !== l.thumbnail) upd.thumbnail = l.thumbnail;
          if ((existente.permalink ?? null) !== l.permalink) upd.permalink = l.permalink;
          if (!existente.peso_kg && l.peso_kg) upd.peso_kg = l.peso_kg;
          if (!existente.custo_frete && l.custo_frete) upd.custo_frete = l.custo_frete;
          if (!existente.sku && l.sku) upd.sku = l.sku;
          if (Object.keys(upd).length === 0) r.ignorados++;
          else mudancas.push({ id: existente.id, upd });
        }
      }
      if (novas.length > 0) {
        const { error } = await banco.from("anuncios").insert(novas);
        if (error) throw new ErroImportacaoML("BANCO", "insercao em lote recusada pelo banco");
        r.importados += novas.length;
      }
      for (const m of mudancas) {
        const { data, error } = await banco.from("anuncios").update(m.upd)
          .eq("id", m.id).eq("user_id", userId).eq("marketplace", "ML").eq("loja_id", lojaId).select("id");
        if (error) throw new ErroImportacaoML("BANCO", "atualizacao recusada pelo banco");
        if ((data ?? []).length !== 1) throw new ErroImportacaoML("BANCO", "linha existente fora da loja ou removida");
        r.atualizados++;
      }
      // Observacao das linhas existentes: DEPOIS das escritas de negocio, ANTES do cursor; nao e "atualizado".
      if (observacoes.length > 0 && !(await gravarObservacoes(banco, { userId, lojaId, marketplace: "ML" }, observacoes))) {
        throw new ErroImportacaoML("BANCO", "observacao do marketplace recusada pelo banco");
      }
      cursorItem = lote[lote.length - 1];
      r.itensProcessados += lote.length;
    }
  } catch (e) {
    const erro = e instanceof ErroImportacaoML ? e : new ErroImportacaoML("PROVIDER", String((e as any)?.message ?? e));
    erro.ultimoConcluido = cursorItem;
    throw erro;
  }

  const fim = restantes.length === 0 || (cursorItem !== null && cmpItemML(cursorItem, restantes[restantes.length - 1]) >= 0);
  r.parcial = !fim;
  r.cursor = fim ? null : codificarCursorML(lojaId, cursorItem!);
  return r;
}
