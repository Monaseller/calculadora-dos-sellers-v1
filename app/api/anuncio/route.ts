import { NextResponse } from "next/server";

// Cache do app token (client_credentials) — válido para chamadas de servidor
let _appTokenCache: { token: string; expiresAt: number } | null = null;

async function getAppToken(): Promise<string | null> {
  if (_appTokenCache && Date.now() < _appTokenCache.expiresAt) {
    return _appTokenCache.token;
  }
  const clientId = process.env.ML_CLIENT_ID;
  const clientSecret = process.env.ML_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  try {
    const r = await fetch("https://api.mercadolibre.com/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `grant_type=client_credentials&client_id=${encodeURIComponent(clientId)}&client_secret=${encodeURIComponent(clientSecret)}`,
    });
    if (!r.ok) {
      console.log(`[appToken] Falha ${r.status}`);
      return null;
    }
    const data = await r.json();
    _appTokenCache = {
      token: data.access_token,
      expiresAt: Date.now() + Math.max(0, (data.expires_in - 60)) * 1000,
    };
    console.log(`[appToken] Obtido, expira em ${data.expires_in}s`);
    return _appTokenCache.token;
  } catch (e) {
    console.log(`[appToken] Erro: ${e}`);
    return null;
  }
}

interface ItemIdResult {
  primaryId: string;     // Tenta primeiro (pode ser listing ou catalog)
  catalogId?: string;    // ID de catálogo para fallback via /products/
}

function extrairItemId(link: string): ItemIdResult | null {
  const texto = link.trim();

  // ID direto: MLB123456
  const mlbDireto = texto.match(/^MLB-?(\d+)$/i);
  if (mlbDireto) return { primaryId: `MLB${mlbDireto[1]}` };

  try {
    const url = new URL(texto);
    const pathname = url.pathname;

    // wid= param
    const wid = url.searchParams.get("wid");
    if (wid?.toUpperCase().startsWith("MLB")) return { primaryId: wid };

    // item_id= param direto
    const itemIdParam = url.searchParams.get("item_id");
    if (itemIdParam?.toUpperCase().startsWith("MLB")) return { primaryId: itemIdParam };

    // pdp_filters=item_id:MLB... (anúncios e catálogo)
    const pdpFilters = url.searchParams.get("pdp_filters") || "";
    const filterMatch = pdpFilters.match(/item_id:(MLB\d+)/i)
      || texto.match(/item_id%3A(MLB\d+)/i);
    const listingFromFilter = filterMatch ? filterMatch[1] : null;

    // URL de catálogo clássico: /p/MLB12345678
    const catalogoClassico = pathname.match(/\/p\/(MLB\d+)/i);
    if (catalogoClassico) {
      return {
        primaryId: listingFromFilter || catalogoClassico[1],
        catalogId: catalogoClassico[1],
      };
    }

    // URL de catálogo universal: /up/MLBU3081939424
    const catalogoUniversal = pathname.match(/\/up\/(MLBU(\d+))/i);
    if (catalogoUniversal) {
      const mlbuId = catalogoUniversal[1]; // ex: MLBU3081939424
      return {
        primaryId: listingFromFilter || mlbuId,
        catalogId: mlbuId,
      };
    }

    // URL de anúncio direto: /MLB1234567890 no path
    const pathMatch = pathname.match(/\/(MLB\d+)/i);
    if (pathMatch) return { primaryId: pathMatch[1] };

    // Se tem listing no filtro mas nenhum path específico
    if (listingFromFilter) return { primaryId: listingFromFilter };

  } catch {}

  // Último recurso: primeiro MLB no texto
  const match = texto.match(/MLB\d+/i);
  if (!match) return null;
  return { primaryId: match[0] };
}

const ATTRS = "id,title,price,category_id,listing_type_id,thumbnail,permalink,site_id";

async function fetchItem(itemId: string, token: string | null): Promise<Response> {
  const authHeaders = token ? { Authorization: `Bearer ${token}` } : {};

  // 1. Com auth + attributes (às vezes bypassa restrições de catálogo)
  if (token) {
    const r = await fetch(`https://api.mercadolibre.com/items/${itemId}?attributes=${ATTRS}`, {
      headers: authHeaders,
    });
    console.log(`[anuncio] /items/${itemId}?attributes com auth: ${r.status}`);
    if (r.ok) return r;
  }

  // 2. Sem auth + attributes
  const r2 = await fetch(`https://api.mercadolibre.com/items/${itemId}?attributes=${ATTRS}`);
  console.log(`[anuncio] /items/${itemId}?attributes público: ${r2.status}`);
  if (r2.ok) return r2;

  // 3. Sem auth, sem attributes (fallback para items que não aceitam attributes)
  const r3 = await fetch(`https://api.mercadolibre.com/items/${itemId}`);
  console.log(`[anuncio] /items/${itemId} público simples: ${r3.status}`);
  return r3;
}

interface DadosPagina {
  itemId?: string;
  titulo?: string;
  preco?: number;
  thumbnail?: string;
}

// Scraping da página ML — extrai ID, preço e título do HTML/JSON-LD
async function scraparPaginaML(pageUrl: string): Promise<DadosPagina | null> {
  try {
    const r = await fetch(pageUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.8",
        "Accept-Encoding": "gzip, deflate, br",
        "Cache-Control": "no-cache",
        "Pragma": "no-cache",
      },
    });
    console.log(`[anuncio] scrape ${pageUrl.slice(0, 70)}: ${r.status}`);
    if (!r.ok) return null;
    const html = await r.text();
    console.log(`[anuncio] scrape HTML length: ${html.length}`);

    const resultado: DadosPagina = {};

    // 1. JSON-LD structured data (melhor fonte — usado para SEO/Google)
    const jsonLdMatches = [...html.matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)];
    for (const match of jsonLdMatches) {
      try {
        const jsonLd = JSON.parse(match[1]);
        const items = Array.isArray(jsonLd) ? jsonLd : [jsonLd];
        for (const item of items) {
          if (item["@type"] === "Product" || item["@type"] === "Offer") {
            if (item.name && !resultado.titulo) resultado.titulo = item.name;
            if (item.image && !resultado.thumbnail) {
              resultado.thumbnail = Array.isArray(item.image) ? item.image[0] : item.image;
            }
            const offers = item.offers ?? item;
            if (offers?.price && !resultado.preco) {
              const p = parseFloat(String(offers.price).replace(",", "."));
              if (p > 0) resultado.preco = p;
            }
          }
        }
      } catch {}
    }

    // 2. Open Graph meta tags (título e imagem)
    if (!resultado.titulo) {
      const ogTitle = html.match(/<meta[^>]+property="og:title"[^>]+content="([^"]+)"/i);
      if (ogTitle) resultado.titulo = ogTitle[1].replace(/\s*-\s*Mercado Livre.*$/, "").trim();
    }
    if (!resultado.thumbnail) {
      const ogImage = html.match(/<meta[^>]+property="og:image"[^>]+content="([^"]+)"/i);
      if (ogImage) resultado.thumbnail = ogImage[1];
    }

    // 3. Preço em meta tags (itemprop)
    if (!resultado.preco) {
      const metaPrice = html.match(/<meta[^>]+itemprop="price"[^>]+content="([^"]+)"/i);
      if (metaPrice) {
        const p = parseFloat(metaPrice[1].replace(",", "."));
        if (p > 0) resultado.preco = p;
      }
    }

    // 4. Preço em JSON embutido no HTML (__PRELOADED_STATE__ ou similar)
    if (!resultado.preco) {
      const pricePatterns = [
        /"price"\s*:\s*([\d]+(?:\.\d+)?)\b/,
        /"selling_price"\s*:\s*([\d]+(?:\.\d+)?)\b/,
        /"buy_price"\s*:\s*([\d]+(?:\.\d+)?)\b/,
      ];
      for (const p of pricePatterns) {
        const m = html.match(p);
        if (m) {
          const v = parseFloat(m[1]);
          if (v > 1 && v < 1000000) { resultado.preco = v; break; }
        }
      }
    }

    // 5. MLB item ID direto no HTML
    const idPatterns = [
      /"buy_box_winner"\s*:\s*\{[^}]*"item_id"\s*:\s*"(MLB\d+)"/,
      /"(?:selectedItemId|itemId)"\s*:\s*"(MLB\d+)"/,
      /item_id%3A(MLB\d+)/,
      /"id"\s*:\s*"(MLB\d{10,})"/,
    ];
    for (const p of idPatterns) {
      const m = html.match(p);
      if (m) { resultado.itemId = m[1]; break; }
    }
    if (!resultado.itemId) {
      const allIds = [...html.matchAll(/MLB(\d{10,})/g)].map((m) => `MLB${m[1]}`);
      if (allIds.length) resultado.itemId = allIds[0];
    }

    const temDados = resultado.titulo || resultado.preco || resultado.itemId;
    console.log(`[anuncio] scrape resultado:`, JSON.stringify(resultado));
    return temDados ? resultado : null;
  } catch (e) {
    console.log(`[anuncio] scrape erro: ${e}`);
    return null;
  }
}

// Busca por keywords extraídas do slug da URL
async function buscarPorSlug(pageUrl: string, token: string | null): Promise<string | null> {
  try {
    const urlObj = new URL(pageUrl);
    const slug = urlObj.pathname.split("/")[1] || "";
    if (!slug) return null;
    const keywords = slug.replace(/-/g, " ").slice(0, 100);
    // App token para search (user token e sem token causam 403)
    const appToken = await getAppToken();
    const searchHeaders: Record<string, string> = {};
    if (appToken) searchHeaders["Authorization"] = `Bearer ${appToken}`;
    const r = await fetch(
      `https://api.mercadolibre.com/sites/MLB/search?q=${encodeURIComponent(keywords)}&limit=5`,
      Object.keys(searchHeaders).length ? { headers: searchHeaders } : {}
    );
    console.log(`[anuncio] busca slug "${keywords.slice(0, 40)}": ${r.status}`);
    if (!r.ok) return null;
    const data = await r.json();
    const results: Array<{id: string}> = data.results ?? [];
    // Pega o primeiro resultado cujo /items/ responda 200
    for (const item of results) {
      if (!item.id) continue;
      const check = await fetch(`https://api.mercadolibre.com/items/${item.id}?attributes=id`);
      if (check.ok) {
        console.log(`[anuncio] slug result acessível: ${item.id}`);
        return item.id;
      }
    }
    const found = results[0]?.id ?? null;
    console.log(`[anuncio] slug result (sem verificar): ${found}`);
    return found;
  } catch {
    return null;
  }
}

async function buscarViaPesquisa(catalogId: string, token: string | null): Promise<string | null> {
  // App token para search — user token e sem token causam 403
  const appToken = await getAppToken();
  const tentativas: Array<Record<string, string>> = [];
  if (appToken) tentativas.push({ Authorization: `Bearer ${appToken}` });
  if (token) tentativas.push({ Authorization: `Bearer ${token}` });
  tentativas.push({});

  for (const hdrs of tentativas) {
    const r = await fetch(
      `https://api.mercadolibre.com/sites/MLB/search?catalog_product_id=${catalogId}&limit=1`,
      Object.keys(hdrs).length ? { headers: hdrs } : {}
    );
    console.log(`[anuncio] search?catalog_product_id=${catalogId}: ${r.status}`);
    if (r.ok) {
      const data = await r.json();
      const found = data.results?.[0]?.id ?? null;
      console.log(`[anuncio] search result: ${found}`);
      return found;
    }
  }
  return null;
}

async function resolverCatalogo(catalogId: string, token: string | null): Promise<string | null> {
  const headers: Record<string, string> = {};
  if (token) headers["Authorization"] = `Bearer ${token}`;

  // Tenta com o ID como veio (MLB... ou MLBU...)
  console.log(`[anuncio] /products/${catalogId}`);
  let r = await fetch(`https://api.mercadolibre.com/products/${catalogId}`, { headers });
  console.log(`[anuncio] /products/${catalogId}: ${r.status}`);

  if (!r.ok && catalogId.toUpperCase().startsWith("MLBU")) {
    // Tenta sem o 'U': MLBU3081939424 → MLB3081939424
    const semU = "MLB" + catalogId.slice(4);
    console.log(`[anuncio] /products/${semU} (sem U)`);
    r = await fetch(`https://api.mercadolibre.com/products/${semU}`, { headers });
    console.log(`[anuncio] /products/${semU}: ${r.status}`);
  }

  if (!r.ok) return null;

  const data = await r.json();
  const listingId = data.buy_box_winner?.item_id ?? null;
  console.log(`[anuncio] buy_box_winner: ${listingId}`);
  return listingId;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const link = url.searchParams.get("link");

  if (!link) return NextResponse.json({ erro: true, mensagem: "Link não informado" });

  const parsed = extrairItemId(link);
  if (!parsed) {
    return NextResponse.json({ erro: true, mensagem: "Não encontrei um ID de produto ML no link." });
  }

  console.log(`[anuncio] Link: ${link.slice(0, 80)}`);
  console.log(`[anuncio] primaryId: ${parsed.primaryId} | catalogId: ${parsed.catalogId}`);

  const cookieHeader = request.headers.get("cookie") || "";
  const tokenEntry = cookieHeader.split("; ").find((c) => c.startsWith("ml_access_token="));
  const token = tokenEntry ? tokenEntry.slice("ml_access_token=".length) : null;

  let itemId = parsed.primaryId;
  let response = await fetchItem(parsed.primaryId, token);

  // Se o primaryId é MLBU..., tenta também sem o 'U' como item direto
  if (!response.ok && parsed.primaryId.toUpperCase().startsWith("MLBU")) {
    const semU = "MLB" + parsed.primaryId.slice(4);
    console.log(`[anuncio] Tentando MLBU→MLB: ${semU}`);
    const r2 = await fetchItem(semU, token);
    if (r2.ok) { itemId = semU; response = r2; }
  }

  // Se falhou E temos um catalogId, resolve via /products/
  if (!response.ok && parsed.catalogId) {
    console.log(`[anuncio] Tentando catálogo: ${parsed.catalogId}`);
    const listingId = await resolverCatalogo(parsed.catalogId, token);
    if (listingId) {
      itemId = listingId;
      response = await fetchItem(listingId, token);
    }
  }

  // Se ainda falhou, tenta o primaryId como catálogo também
  if (!response.ok) {
    const listingId = await resolverCatalogo(parsed.primaryId, token);
    if (listingId) {
      itemId = listingId;
      response = await fetchItem(listingId, token);
    }
  }

  // Último recurso: busca via search API por catalog_product_id
  if (!response.ok && parsed.catalogId) {
    const listingId = await buscarViaPesquisa(parsed.catalogId, token);
    if (listingId) {
      itemId = listingId;
      response = await fetchItem(listingId, token);
    }
  }
  if (!response.ok) {
    const listingId = await buscarViaPesquisa(parsed.primaryId, token);
    if (listingId) {
      itemId = listingId;
      response = await fetchItem(listingId, token);
    }
  }

  // Fallback: scraping da página ML — extrai preço, título e ID do HTML/JSON-LD
  let dadosScrape: DadosPagina | null = null;
  if (!response.ok && link.startsWith("http")) {
    dadosScrape = await scraparPaginaML(link);
    if (dadosScrape?.itemId) {
      const r = await fetchItem(dadosScrape.itemId, token);
      if (r.ok) { itemId = dadosScrape.itemId; response = r; }
    }
  }

  // Último fallback API: busca por keywords do slug
  if (!response.ok && link.startsWith("http")) {
    try {
      const slugId = await buscarPorSlug(link, token);
      if (slugId) {
        const r = await fetchItem(slugId, token);
        if (r.ok) { itemId = slugId; response = r; }
      }
    } catch {}
  }

  if (!response.ok) {
    const errData = await response.json().catch(() => ({}));
    console.log(`[anuncio] Falha final ${response.status}:`, errData);

    // Fallback parcial: extrai título do slug da URL para catálogos (MLBU/p/)
    // Retorna dados parciais — usuário preenche preço manualmente
    if (response.status !== 401 && link.startsWith("http")) {
      // Se scraping retornou dados (título e/ou preço), usa eles
      const tituloScrape = dadosScrape?.titulo;
      const precoScrape = dadosScrape?.preco;
      const thumbnailScrape = dadosScrape?.thumbnail;

      // Fallback de título pelo slug se scraping não trouxe
      let tituloFinal = tituloScrape;
      if (!tituloFinal) {
        try {
          const urlObj = new URL(link);
          const slug = urlObj.pathname.split("/")[1] || "";
          if (slug) {
            tituloFinal = slug
              .replace(/-/g, " ")
              .replace(/\b\w/g, (c) => c.toUpperCase())
              .trim();
          }
        } catch {}
      }

      if (tituloFinal && tituloFinal.length > 5) {
        console.log(`[anuncio] Fallback parcial: título="${tituloFinal}" preço=${precoScrape}`);
        return NextResponse.json({
          id: parsed.catalogId || parsed.primaryId,
          titulo: tituloFinal,
          preco: precoScrape ?? null,
          categoria: null,
          categoriaId: null,
          tipoAnuncio: null,
          thumbnail: thumbnailScrape ?? null,
          permalink: link,
          parcial: true,
        });
      }
    }

    return NextResponse.json({
      erro: true,
      tokenExpirado: response.status === 401,
      mensagem:
        response.status === 401
          ? "Sessão expirada. Clique em 'Desconectar' e reconecte ao Mercado Livre."
          : `Não foi possível buscar o anúncio (${response.status}). Tente copiar o link diretamente do navegador após abrir o produto.`,
    });
  }

  const data = await response.json();
  console.log(`[anuncio] ✓ ${data.id} — ${data.title}`);

  let nomeCategoria = data.category_id;
  try {
    const catR = await fetch(`https://api.mercadolibre.com/categories/${data.category_id}`);
    if (catR.ok) {
      const catData = await catR.json();
      nomeCategoria = catData.name;
    }
  } catch {}

  let tipoAnuncio = data.listing_type_id;
  if (tipoAnuncio === "gold_special") tipoAnuncio = "Clássico";
  if (tipoAnuncio === "gold_pro") tipoAnuncio = "Premium";

  return NextResponse.json({
    id: data.id,
    titulo: data.title,
    preco: data.price,
    categoria: nomeCategoria,
    categoriaId: data.category_id,
    tipoAnuncio,
    thumbnail: data.thumbnail,
    permalink: data.permalink,
  });
}
