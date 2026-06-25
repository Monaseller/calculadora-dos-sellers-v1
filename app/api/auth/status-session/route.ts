import { NextRequest, NextResponse } from "next/server";

export async function GET(request: NextRequest) {
  const session = request.cookies.get("cds_session")?.value;
  if (session) return NextResponse.json({ ok: true });
  return NextResponse.json({ ok: false }, { status: 401 });
}
