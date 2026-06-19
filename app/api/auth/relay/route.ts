import { NextResponse } from "next/server";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const token = url.searchParams.get("token");
  const expires = url.searchParams.get("expires");

  if (!token) {
    return NextResponse.redirect(new URL("/", request.url));
  }

  const res = NextResponse.redirect(new URL("/", request.url));

  res.cookies.set("ml_access_token", token, {
    httpOnly: true,
    secure: false,
    sameSite: "lax",
    path: "/",
    maxAge: Number(expires) || 21600,
  });

  return res;
}
