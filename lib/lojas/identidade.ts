/**
 * IDENTIDADE DE LOJA — CDS V2, Fase 1A (núcleo PURO, sem banco, sem rede).
 *
 * Usuário → Marketplace → Loja → Credencial → Metadata.
 *
 * `lojas` é o agregado de identidade (sem tabela nova):
 *   identidade técnica  = (user_id, marketplace, seller_id); no Shopee seller_id = shop_id
 *                         (UNIQUE (seller_id, user_id) já existe no banco — mais estrita
 *                         que owner+marketplace+external);
 *   nome real           = `nome` (e `nickname`) QUANDO confirmados pelo marketplace;
 *   fallback técnico    = "<Marketplace> <id externo>" — reconhecido por igualdade EXATA
 *                         com o fallback calculado para AQUELA loja, nunca por nome de loja.
 *
 * Regras:
 *   • a UI exibe nome real → nickname real → fallback técnico (nomeExibicaoDaLoja);
 *   • o fallback técnico só é GRAVADO na criação de loja sem nome real; numa loja que
 *     já existe, ausência de nome real NÃO toca os campos de nome (camposDeNomeParaGravar);
 *   • nome real só vem do provider, pelos parsers daqui — o navegador nunca é autoridade.
 * Nenhum shop_id, seller_id ou nome de loja específico aparece neste arquivo.
 */

export type MarketplaceLoja = "Shopee" | "ML";

const ROTULO_MARKETPLACE: Record<MarketplaceLoja, string> = { Shopee: "Shopee", ML: "Mercado Livre" };

/** Teto do nome aceito do provider (defesa: nada de payload arbitrário virando rótulo). */
export const TAMANHO_MAX_NOME_LOJA = 120;

export interface LojaParaExibicao {
  nome?: string | null;
  nickname?: string | null;
  marketplace?: string | null;
  seller_id?: string | number | null;
  shop_id?: string | number | null;
}

function ehMarketplace(m: unknown): m is MarketplaceLoja {
  return m === "Shopee" || m === "ML";
}

/** Id externo da loja: Shopee → shop_id (ou seller_id, que guarda o mesmo valor); ML → seller_id. */
export function idExternoDaLoja(l: LojaParaExibicao): string | null {
  const bruto = l.marketplace === "Shopee" ? (l.shop_id ?? l.seller_id) : l.seller_id;
  const id = bruto === null || bruto === undefined ? "" : String(bruto).trim();
  return id || null;
}

/** "<Marketplace> <id externo>" — único lugar do runtime que monta o fallback técnico. */
export function fallbackTecnicoDaLoja(marketplace: string | null | undefined, idExterno: string | null | undefined): string {
  const rotulo = ehMarketplace(marketplace) ? ROTULO_MARKETPLACE[marketplace] : "Loja";
  const id = idExterno === null || idExterno === undefined ? "" : String(idExterno).trim();
  return id ? `${rotulo} ${id}` : rotulo;
}

/** Normaliza um nome candidato: string, aparada, não vazia, dentro do teto. Senão null. */
export function normalizarNomeLoja(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.replace(/\s+/g, " ").trim();
  if (!s || s.length > TAMANHO_MAX_NOME_LOJA) return null;
  return s;
}

/** Nome real = normalizável E diferente do fallback técnico DESTA loja (e do default da coluna). */
export function ehNomeReal(nome: unknown, l: LojaParaExibicao): boolean {
  const n = normalizarNomeLoja(nome);
  if (!n) return false;
  if (n === fallbackTecnicoDaLoja(l.marketplace, idExternoDaLoja(l))) return false;
  if (n === "Minha Loja") return false;   // default da coluna `nome`, nunca confirmado
  return true;
}

/** Fonte ÚNICA do nome exibido: nome real → nickname real → fallback técnico. */
export function nomeExibicaoDaLoja(l: LojaParaExibicao): string {
  if (ehNomeReal(l.nome, l)) return normalizarNomeLoja(l.nome)!;
  if (ehNomeReal(l.nickname, l)) return normalizarNomeLoja(l.nickname)!;
  return fallbackTecnicoDaLoja(l.marketplace, idExternoDaLoja(l));
}

// ── Parsers de metadata do provider (resposta já obtida; aqui não há chamada) ──

/**
 * Shopee `shop/get_shop_info`: o nome vem em `shop_name` no TOPO da resposta (API v2 —
 * nenhuma loja em produção jamais resolveu nome pelo caminho aninhado) ou, no formato
 * que o código e a fixture antigos assumiam, em `response.shop_name`. Ordem determinística:
 * topo primeiro; aninhado só se o topo não trouxer nome válido.
 */
export function extrairNomeLojaShopee(info: unknown): string | null {
  if (!info || typeof info !== "object") return null;
  const r = info as Record<string, unknown>;
  const topo = normalizarNomeLoja(r.shop_name);
  if (topo) return topo;
  const aninhado = r.response && typeof r.response === "object" ? (r.response as Record<string, unknown>).shop_name : undefined;
  return normalizarNomeLoja(aninhado);
}

export interface MetadataContaML {
  /** `id` do /users/me — seller_id da loja. */
  idExterno: string;
  /** `nickname` do /users/me; null se ausente (nunca first_name/nome pessoal). */
  nomeReal: string | null;
  /** `status.site_status` quando presente (ex.: "active"). */
  status: string | null;
}

/** Caminho canônico de metadata ML a partir de um `/users/me` já obtido. null = sem id. */
export function extrairMetadataContaML(me: unknown): MetadataContaML | null {
  if (!me || typeof me !== "object") return null;
  const r = me as Record<string, unknown>;
  const id = r.id === undefined || r.id === null ? "" : String(r.id).trim();
  if (!id) return null;
  const st = r.status && typeof r.status === "object" ? (r.status as Record<string, unknown>).site_status : undefined;
  return { idExterno: id, nomeReal: normalizarNomeLoja(r.nickname), status: typeof st === "string" ? st : null };
}

/**
 * Campos de nome a gravar numa conexão/refresh de metadata:
 *   • nome real presente  → grava (promove fallback, atualiza nome real);
 *   • sem nome real, loja EXISTENTE → {} (preserva o que houver — real ou fallback);
 *   • sem nome real, loja NOVA → fallback técnico (temporário).
 */
export function camposDeNomeParaGravar(
  nomeReal: string | null,
  ctx: { lojaNova: boolean; marketplace: MarketplaceLoja; idExterno: string },
): { nome?: string; nickname?: string } {
  const n = normalizarNomeLoja(nomeReal);
  if (n && n !== fallbackTecnicoDaLoja(ctx.marketplace, ctx.idExterno)) return { nome: n, nickname: n };
  if (!ctx.lojaNova) return {};
  const fb = fallbackTecnicoDaLoja(ctx.marketplace, ctx.idExterno);
  return { nome: fb, nickname: fb };
}
