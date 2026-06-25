import { NextResponse } from "next/server";
import { buildAuthUrl } from "@/lib/shopee-api";

export async function GET() {
  const authUrl = buildAuthUrl();
  return NextResponse.redirect(authUrl);
}
