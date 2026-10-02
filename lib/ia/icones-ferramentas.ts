/**
 * Icone de cada Tool — F8.2-A.
 *
 * ── Registry local, nunca rede ──────────────────────────────────────
 *
 * Toda entrada aponta para um arquivo em `public/` servido pelo proprio
 * app. Nada de CDN nem SVG baixado em runtime: um icone que depende de
 * terceiro some quando o terceiro cai, e vaza a navegacao do dono.
 *
 *   public/icons/tools/*.svg  desenhados para a CDS (geometria simples,
 *                             sem marca de terceiros)
 *   public/logo-ml.svg        o logo do Mercado Livre que o produto JA
 *                             usa em outras telas — reaproveitado, nao
 *                             duplicado
 *
 * "Planilhas" le .xlsx e .csv, e nao e integracao com a Microsoft: o
 * icone e uma planilha generica verde, sem marca do Excel.
 *
 * Sem icone conhecido, vale o generico de ferramenta — nunca a primeira
 * letra do nome.
 */

const BASE = "/icons/tools";

/** Packs internos, pela chave de `TOOL_PACKS`. */
const POR_PACK: Readonly<Record<string, string>> = Object.freeze({
  planilhas: `${BASE}/planilha.svg`,
  calculadora: `${BASE}/calculadora.svg`,
  calendario: `${BASE}/calendario.svg`,
  vendas: `${BASE}/vendas.svg`,
  "mercadolivre-perguntas": "/logo-ml.svg",
});

/** Marketplaces, para quem mostra dado por marketplace (Vendas ao vivo). */
const POR_MARKETPLACE: Readonly<Record<string, string>> = Object.freeze({
  mercadolivre: "/logo-ml.svg",
  shopee: "/logo-shopee.svg",
});

export const ICONE_FERRAMENTA_GENERICA = `${BASE}/ferramenta.svg`;
export const ICONE_ACAO_EXTERNA = `${BASE}/acao-externa.svg`;

export function iconeDoPack(packId: string): string {
  return POR_PACK[packId] ?? ICONE_FERRAMENTA_GENERICA;
}

export function iconeDoMarketplace(marketplace: string): string {
  return POR_MARKETPLACE[marketplace] ?? ICONE_FERRAMENTA_GENERICA;
}
