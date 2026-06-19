import { NextResponse } from "next/server";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");

  if (!code) {
    return NextResponse.json({ erro: true, mensagem: "Code não recebido" });
  }

  const response = await fetch("https://api.mercadolibre.com/oauth/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: process.env.ML_CLIENT_ID!,
      client_secret: process.env.ML_CLIENT_SECRET!,
      code,
      redirect_uri: process.env.ML_REDIRECT_URI!,
    }),
  });

  const data = await response.json();

  const relayUrl = new URL("/api/auth/relay", "http://localhost:3001");
  relayUrl.searchParams.set("token", data.access_token);
  relayUrl.searchParams.set("expires", String(data.expires_in));

  return NextResponse.redirect(relayUrl.toString());
}

export async function POST(request: Request) {
  return GET(request);
}