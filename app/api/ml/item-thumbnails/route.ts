import { NextResponse } from "next/server";

function getToken(request: Request): string | null {
  const cookieHeader = request.headers.get("cookie") || "";
  const entry = cookieHeader.split("; ").find(c => c.startsWith("ml_access_token="));
  return entry ? entry.slice("ml_access_token=".length) : null;
}

// GET /api/ml/item-thumbnails?ids=MLB1,MLB2,...
// Retorna { MLB1: "https://...", MLB2: "https://..." }
export async function GET(request: Request) {
  const token = getToken(request);
  if (!token) return NextResponse.json({}, { status: 401 });

  const { searchParams } = new URL(request.url);
  const ids = (searchParams.get("ids") ?? "").split(",").map(s => s.trim()).filter(Boolean);
  if (!ids.length) return NextResponse.json({});

  // ML aceita até 20 IDs por chamada
  const CHUNK = 20;
  const result: Record<string, string> = {};

  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    try {
      const res = await fetch(
        `https://api.mercadolibre.com/items?ids=${chunk.join(",")}&attributes=id,thumbnail`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (!res.ok) continue;
      const data: Array<{ code: number; body: { id: string; thumbnail?: string } }> = await res.json();
      for (const item of data) {
        if (item.code === 200 && item.body?.thumbnail) {
          result[item.body.id] = item.body.thumbnail.replace("http://", "https://");
        }
      }
    } catch {
      // ignora erros parciais
    }
  }

  return NextResponse.json(result);
}
