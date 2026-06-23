import { NextResponse } from "next/server";

export async function GET() {
  const clientId = process.env.ML_CLIENT_ID!.trim();
  const redirectUri = process.env.ML_REDIRECT_URI!.trim();

  const authUrl =
    `https://auth.mercadolivre.com.br/authorization` +
    `?response_type=code` +
    `&client_id=${clientId}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&scope=read_catalog%20offline_access`;

  return NextResponse.redirect(authUrl);
}