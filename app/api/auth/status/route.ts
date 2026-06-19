import { NextResponse } from "next/server";

export async function GET(request: Request) {
  const cookieHeader = request.headers.get("cookie") || "";
  const tokenEntry = cookieHeader.split("; ").find((c) => c.startsWith("ml_access_token="));
  const token = tokenEntry ? tokenEntry.slice("ml_access_token=".length) : null;

  if (!token) {
    return NextResponse.json({ conectado: false });
  }

  // Valida o token com a API do ML (não apenas verifica se existe)
  try {
    const mlResponse = await fetch("https://api.mercadolibre.com/users/me", {
      headers: { Authorization: `Bearer ${token}` },
    });
    return NextResponse.json({ conectado: mlResponse.ok });
  } catch {
    return NextResponse.json({ conectado: false });
  }
}
