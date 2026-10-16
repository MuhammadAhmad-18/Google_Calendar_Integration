import { NextResponse, type NextRequest } from "next/server";
import { appAccessMode } from "@/lib/config";
import { createHotelAuthClient } from "@/lib/auth/hotel-client";

export async function proxy(request: NextRequest) {
  if (appAccessMode() !== "public") return NextResponse.next();
  let response = NextResponse.next({ request });
  const client = createHotelAuthClient({ getAll: () => request.cookies.getAll(), setAll(values) {
    for (const { name, value } of values) request.cookies.set(name, value);
    response = NextResponse.next({ request });
    for (const { name, value, options } of values) response.cookies.set(name, value, options);
  } });
  // Provider-verified identity, never a decoded cookie/getSession assertion.
  await client.auth.getUser();
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}
export const config = { matcher: ["/dashboard", "/login", "/api/status", "/api/integrations/:path*", "/api/chatbeds/connect", "/api/chatbeds/install", "/api/chatbeds/callback", "/api/chatbeds/test", "/api/chatbeds/sync", "/api/chatbeds/disconnect", "/api/google/:path*", "/api/auth/logout"] };
