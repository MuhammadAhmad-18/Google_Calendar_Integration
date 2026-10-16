export class AppError extends Error {
  constructor(message: string, public status = 500) { super(message); }
}
// Never forward provider response bodies or exception stacks to logs/UI.
export function safeError(error: unknown): string {
  return error instanceof AppError ? error.message : "Operation failed. Check configuration and retry.";
}
export function errorResponse(error: unknown) {
  return Response.json({ error: safeError(error) }, { status: error instanceof AppError ? error.status : 500 });
}
