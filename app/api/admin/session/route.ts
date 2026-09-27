// GET ?t=<one-time token> → mints the 12 h owner session cookie, redirects onward.

import { NextResponse, type NextRequest } from "next/server";
import { exchangeOwnerLink, setOwnerCookie } from "@/lib/auth/owner";
import { env } from "@/lib/env";

export async function GET(req: NextRequest) {
  const t = req.nextUrl.searchParams.get("t");
  if (!t) return NextResponse.redirect(`${env.appUrl}/admin?error=missing_token`);
  const result = await exchangeOwnerLink(t);
  if (!result) return NextResponse.redirect(`${env.appUrl}/admin?error=expired_link`);
  const res = NextResponse.redirect(`${env.appUrl}${result.next}`);
  setOwnerCookie(res, result.session);
  return res;
}
