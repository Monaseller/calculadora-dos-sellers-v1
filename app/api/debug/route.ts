import { NextResponse } from "next/server";

async function getAppToken(): Promise<string | null> {
  const clientId = process.env.ML_CLIENT_ID;
  const clientSecret = process.env.ML_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  try {
    const r = await fetch("https://api.mercadolibre.com/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `grant_type=client_credentials&client_id=${encodeURIComponent(clientId)}&client_secret=${encodeURIComponent(clientSecret)}`,
    });
    if (!r.ok) return null;
    const data = await r.json();
    return data.access_token ?? null;
  } catch { return null; }
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const link = url.searchParams.get("link") || "";
  const rawId = url.searchParams.get("id") || "";

  const cookieHeader = request.headers.get("cookie") || "";
  const tokenEntry = cookieHeader.split("; ").find((c) => c.startsWith("ml_access_token="));
  const token = tokenEntry ? tokenEntry.slice("ml_access_token=".length) : null;

  const steps: Record<string, unknown> = {
    link: link.slice(0, 120),
    rawId,
    temToken: !!token,
    tokenPrimeiros20: token ? token.slice(0, 20) + "..." : null,
  };

  const testId = rawId || (link.match(/MLB[U]?\d+/i)?.[0]);
  if (!testId) {
    return NextResponse.json({ erro: "Passe ?id=MLB... ou ?link=..." });
  }

  steps.idTestado = testId;

  // App token (client_credentials) — para testar search e catalog
  const appToken = await getAppToken();
  steps["appToken"] = appToken ? "obtido ✓" : "falhou ✗";

  const headers: Record<string, string> = {};
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const appHeaders: Record<string, string> = appToken ? { Authorization: `Bearer ${appToken}` } : {};

  // Test 1: /items com auth
  const r1 = await fetch(`https://api.mercadolibre.com/items/${testId}`, { headers });
  const d1 = await r1.json().catch(() => ({}));
  steps["items_com_auth"] = { status: r1.status, titulo: (d1 as Record<string, unknown>).title, erro: (d1 as Record<string, unknown>).message };

  // Test 2: /items público
  const r2 = await fetch(`https://api.mercadolibre.com/items/${testId}`);
  const d2 = await r2.json().catch(() => ({}));
  steps["items_publico"] = { status: r2.status, titulo: (d2 as Record<string, unknown>).title, erro: (d2 as Record<string, unknown>).message };

  // Test 3: /products
  const r3 = await fetch(`https://api.mercadolibre.com/products/${testId}`, { headers });
  const d3 = await r3.json().catch(() => ({}));
  steps["products"] = { status: r3.status, buy_box_winner: (d3 as Record<string, unknown>).buy_box_winner, erro: (d3 as Record<string, unknown>).message };

  // Test 4: search
  const r4 = await fetch(`https://api.mercadolibre.com/sites/MLB/search?catalog_product_id=${testId}&limit=1`, { headers });
  const d4 = await r4.json().catch(() => ({}));
  steps["search_catalog"] = { status: r4.status, primeiro_resultado: ((d4 as Record<string, unknown>).results as Record<string, unknown>[])?.[0]?.id };

  // Test 5: items com ?attributes= (às vezes bypassa restrições)
  const r5a = await fetch(`https://api.mercadolibre.com/items/${testId}?attributes=id,title,price,category_id,listing_type_id`, headers.Authorization ? { headers } : {});
  const d5a = await r5a.json().catch(() => ({}));
  steps["items_attributes_auth"] = { status: r5a.status, titulo: (d5a as Record<string, unknown>).title };

  // Test 6: /products com app token (client_credentials)
  const r6p = await fetch(`https://api.mercadolibre.com/products/${testId}`, Object.keys(appHeaders).length ? { headers: appHeaders } : {});
  const d6p = await r6p.json().catch(() => ({}));
  steps["products_apptoken"] = { status: r6p.status, buy_box_winner: (d6p as Record<string, unknown>).buy_box_winner, erro: (d6p as Record<string, unknown>).message };

  // Test 6b: busca com app token (client_credentials)
  const r6 = await fetch(`https://api.mercadolibre.com/sites/MLB/search?catalog_product_id=${testId}&limit=3`, Object.keys(appHeaders).length ? { headers: appHeaders } : {});
  const d6 = await r6.json().catch(() => ({}));
  const results6 = ((d6 as Record<string, unknown>).results as Record<string, unknown>[])?.slice(0, 3).map((r) => ({ id: r.id, title: (r.title as string)?.slice(0, 50), price: r.price }));
  steps["search_catalog_apptoken"] = { status: r6.status, erro: (d6 as Record<string, unknown>).message, results: results6 };

  // Test 7: busca por keywords do slug com app token
  if (link) {
    try {
      const urlObj = new URL(link);
      const slug = urlObj.pathname.split("/")[1] || "";
      const keywords = slug.replace(/-/g, " ").slice(0, 100);
      if (keywords) {
        const r7 = await fetch(
          `https://api.mercadolibre.com/sites/MLB/search?q=${encodeURIComponent(keywords)}&limit=5`,
          Object.keys(appHeaders).length ? { headers: appHeaders } : {}
        );
        const d7 = await r7.json().catch(() => ({}));
        const results7 = ((d7 as Record<string, unknown>).results as Record<string, unknown>[])?.slice(0, 5).map((r) => ({ id: r.id, title: (r.title as string)?.slice(0, 60), price: r.price }));
        steps["busca_slug_apptoken"] = { status: r7.status, keywords: keywords.slice(0, 80), erro: ((d7 as Record<string, unknown>).message as string)?.slice(0, 200), results: results7 };
      }
    } catch {}
  }

  // Test 8: users/me (valida token)
  if (token) {
    const r8 = await fetch("https://api.mercadolibre.com/users/me", { headers });
    const d8 = await r8.json().catch(() => ({}));
    steps["token_valido"] = { status: r8.status, user_id: (d8 as Record<string, unknown>).id };
  }

  return NextResponse.json(steps, { headers: { "Content-Type": "application/json" } });
}
