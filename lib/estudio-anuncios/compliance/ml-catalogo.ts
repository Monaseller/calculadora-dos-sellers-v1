/**
 * Cliente dos endpoints PÚBLICOS de catálogo do Mercado Livre (2026-08-24).
 *
 * POR QUE ESTE ARQUIVO EXISTE: `category_id` não pode ser texto livre nem
 * conversão da categoria que a IA sugeriu. Ele precisa ser um id REAL, e a
 * única forma honesta de saber isso é perguntar ao Mercado Livre.
 *
 * ENDPOINTS VERIFICADOS EM 2026-08-24, todos **sem OAuth** (resposta 200
 * com requisição anônima):
 *   GET /categories/{id}                        → valida o id + `settings`
 *   GET /categories/{id}/attributes             → atributos da categoria
 *   GET /sites/{site}/domain_discovery/search   → sugestão por texto
 *
 * EXIGEM CREDENCIAL (403 anônimo, confirmado na mesma verificação):
 *   /sites/{site}, /sites/{site}/listing_types,
 *   /sites/{site}/listing_prices, /categories/{id}/sale_terms
 * Por isso **os tipos de anúncio não são buscados** aqui — ver
 * `TIPOS_ANUNCIO_DOCUMENTADOS_ML` em `regras-mercado-livre.ts`.
 *
 * REGRAS QUE ESTE MÓDULO SEGUE:
 * - **Somente leitura.** Nenhum POST, nenhuma criação/alteração de anúncio.
 * - **Sem OAuth, sem token, sem segredo.** Nenhum header de autorização é
 *   montado aqui, e nada deste módulo lê variável de ambiente.
 * - **Nunca cai em fallback silencioso** (Constituição 1.2): id inexistente
 *   é `null` explícito e falha de rede lança — nunca "aceita assim mesmo".
 * - Timeout curto e explícito: a rota de configuração não pode ficar
 *   pendurada esperando um serviço externo.
 */

const BASE_ML = "https://api.mercadolibre.com";
/** Mercado Livre Brasil. O site define a moeda; nunca é digitado. */
export const SITE_ML_BRASIL = "MLB";
const TIMEOUT_MS = 10_000;

/** Formato oficial: 3 letras do site + dígitos (ex.: `MLB425079`). */
export const REGEX_CATEGORY_ID_ML = /^[A-Z]{3}\d+$/;

export class ErroCatalogoML extends Error {
  constructor(mensagem: string, public readonly tipo: "rede" | "resposta") {
    super(mensagem);
    this.name = "ErroCatalogoML";
  }
}

async function buscarJson(caminho: string): Promise<{ ok: boolean; status: number; dados: any }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE_ML}${caminho}`, {
      signal: ctrl.signal,
      headers: { accept: "application/json" },
    });
    if (res.status === 404) return { ok: false, status: 404, dados: null };
    if (!res.ok) {
      throw new ErroCatalogoML(`Mercado Livre respondeu ${res.status} em ${caminho}`, "resposta");
    }
    return { ok: true, status: res.status, dados: await res.json() };
  } catch (err: any) {
    if (err instanceof ErroCatalogoML) throw err;
    throw new ErroCatalogoML(`Falha ao consultar o Mercado Livre: ${err?.name ?? "erro"}`, "rede");
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Settings oficiais da categoria. São eles que tornam verificável o que
 * antes era `nao_verificavel`: limite de título e de descrição, número
 * máximo de imagens, moedas e condições aceitas.
 */
export interface SettingsCategoriaML {
  maxTitleLength: number | null;
  maxDescriptionLength: number | null;
  maxPicturesPerItem: number | null;
  currencies: string[];
  itemConditions: string[];
  buyingModes: string[];
  listingAllowed: boolean | null;
  status: string | null;
}

export interface CategoriaML {
  id: string;
  nome: string;
  caminho: string;
  /** `true` quando a categoria é folha — o ML só publica em folha. */
  ehFolha: boolean;
  settings: SettingsCategoriaML;
}

/** Atributo obrigatório da categoria, como o ML o declara. */
export interface AtributoObrigatorioML {
  id: string;
  nome: string;
  valueType: string | null;
  /** `conditional_required` é exigência condicional, não absoluta. */
  condicional: boolean;
}

function extrairSettings(s: any): SettingsCategoriaML {
  return {
    maxTitleLength: typeof s?.max_title_length === "number" ? s.max_title_length : null,
    maxDescriptionLength: typeof s?.max_description_length === "number" ? s.max_description_length : null,
    maxPicturesPerItem: typeof s?.max_pictures_per_item === "number" ? s.max_pictures_per_item : null,
    currencies: Array.isArray(s?.currencies) ? s.currencies.filter((c: unknown) => typeof c === "string") : [],
    itemConditions: Array.isArray(s?.item_conditions) ? s.item_conditions.filter((c: unknown) => typeof c === "string") : [],
    buyingModes: Array.isArray(s?.buying_modes) ? s.buying_modes.filter((c: unknown) => typeof c === "string") : [],
    listingAllowed: typeof s?.listing_allowed === "boolean" ? s.listing_allowed : null,
    status: typeof s?.status === "string" ? s.status : null,
  };
}

/**
 * Busca e VALIDA uma categoria. `null` quando o id não existe — é assim
 * que uma string arbitrária é rejeitada: não por regex, mas por não
 * existir no Mercado Livre.
 */
export async function buscarCategoriaML(categoryId: string): Promise<CategoriaML | null> {
  const id = categoryId.trim().toUpperCase();
  // Barreira barata antes da rede; a prova real é a resposta da API.
  if (!REGEX_CATEGORY_ID_ML.test(id)) return null;

  const { ok, dados } = await buscarJson(`/categories/${encodeURIComponent(id)}`);
  if (!ok || !dados?.id) return null;

  const caminho = Array.isArray(dados.path_from_root)
    ? dados.path_from_root.map((p: any) => p?.name).filter(Boolean).join(" › ")
    : dados.name ?? id;

  return {
    id: dados.id,
    nome: dados.name ?? id,
    caminho,
    ehFolha: Array.isArray(dados.children_categories) ? dados.children_categories.length === 0 : false,
    settings: extrairSettings(dados.settings),
  };
}

/**
 * Atributos OBRIGATÓRIOS da categoria. Só entram os marcados `required`
 * ou `conditional_required` — o resto é opcional e não vira pendência.
 */
export async function atributosObrigatoriosML(categoryId: string): Promise<AtributoObrigatorioML[]> {
  const id = categoryId.trim().toUpperCase();
  if (!REGEX_CATEGORY_ID_ML.test(id)) return [];

  const { ok, dados } = await buscarJson(`/categories/${encodeURIComponent(id)}/attributes`);
  if (!ok || !Array.isArray(dados)) return [];

  return dados
    .filter((a: any) => a?.tags?.required === true || a?.tags?.conditional_required === true)
    .map((a: any) => ({
      id: String(a.id),
      nome: a.name ?? String(a.id),
      valueType: typeof a.value_type === "string" ? a.value_type : null,
      condicional: a?.tags?.required !== true,
    }));
}

export interface SugestaoCategoriaML {
  categoryId: string;
  categoriaNome: string;
  dominioId: string | null;
  dominioNome: string | null;
}

/**
 * Sugestão de categoria a partir de texto livre — o *category predictor*
 * oficial. Isto é **sugestão para uma pessoa escolher**, nunca aplicação
 * automática: o `category_id` só é gravado quando o usuário seleciona.
 */
export async function sugerirCategoriasML(
  texto: string,
  site: string = SITE_ML_BRASIL,
  limite = 8
): Promise<SugestaoCategoriaML[]> {
  const q = texto.trim();
  if (q.length < 3) return [];

  const { ok, dados } = await buscarJson(
    `/sites/${encodeURIComponent(site)}/domain_discovery/search?limit=${limite}&q=${encodeURIComponent(q)}`
  );
  if (!ok || !Array.isArray(dados)) return [];

  return dados
    .filter((d: any) => typeof d?.category_id === "string")
    .map((d: any) => ({
      categoryId: d.category_id,
      categoriaNome: d.category_name ?? d.category_id,
      dominioId: typeof d.domain_id === "string" ? d.domain_id : null,
      dominioNome: typeof d.domain_name === "string" ? d.domain_name : null,
    }));
}

/**
 * A moeda vem dos settings da categoria, nunca do usuário. Quando a
 * categoria aceita mais de uma, não há como escolher sozinho — devolve
 * `null` e o compliance trata como pendência, em vez de chutar a primeira.
 */
export function derivarMoedaDaCategoria(settings: SettingsCategoriaML): string | null {
  return settings.currencies.length === 1 ? settings.currencies[0] : null;
}
