import { requireAdmin, requireOrigin } from "@/lib/auth/session";
import { beginChatBedsConnect } from "@/lib/chatbeds/connect";
import { errorResponse } from "@/lib/errors";
export const runtime = "nodejs";
export async function POST(request: Request) {
  try { await requireAdmin(); requireOrigin(request); return await beginChatBedsConnect(); }
  catch (error) { return errorResponse(error); }
}
