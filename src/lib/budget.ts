import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";
import { AppError } from "./errors";
const budgets = new AsyncLocalStorage<number>();
export function withRequestBudget<T>(milliseconds: number, work: () => Promise<T>) { return budgets.run(Date.now() + milliseconds, work); }
export function requestSignal() {
  const remaining = (budgets.getStore() ?? (Date.now() + 5000)) - Date.now();
  if (remaining <= 0) throw new AppError("Processing time budget reached; pending work will resume on the next invocation.", 503);
  return AbortSignal.timeout(Math.min(5000, remaining));
}
