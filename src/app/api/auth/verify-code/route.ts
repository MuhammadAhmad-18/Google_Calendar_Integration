import { requireOrigin } from "@/lib/auth/session";
import { AppError, errorResponse } from "@/lib/errors";
export const runtime = "nodejs";
export async function POST(request: Request) {
  try {
    requireOrigin(request);
    throw new AppError("Email codes have been replaced. Use Continue with Google to sign in and connect Calendar.", 410);
  } catch (error) { return errorResponse(error); }
}
