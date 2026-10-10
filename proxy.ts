import { type NextRequest, NextResponse } from "next/server";

/*
 * Optimistic check only: a page request without a session cookie goes
 * straight to /login. The real check (is the session valid, what role?)
 * happens in every Route Handler via requireUser().
 */
export function proxy(req: NextRequest) {
  if (!req.cookies.has("vt_session")) {
    const url = new URL("/login", req.url);
    url.searchParams.set("next", req.nextUrl.pathname);
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/batches/:path*", "/shipments/:path*", "/recalls/:path*", "/exposure/:path*", "/complaints/:path*"],
};
