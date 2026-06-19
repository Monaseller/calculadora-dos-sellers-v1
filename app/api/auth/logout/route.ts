import { NextResponse } from "next/server";

export async function GET(request: Request) {
  const res = NextResponse.redirect(new URL("/", request.url));
  res.cookies.set("ml_access_token", "", {
    httpOnly: true,
    secure: false,
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
  return res;
}
