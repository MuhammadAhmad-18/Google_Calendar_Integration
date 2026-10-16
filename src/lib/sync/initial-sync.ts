import { z } from "zod";
import { dateSchema } from "../chatbeds/types";
import { AppError } from "../errors";
import type { ManualCursor } from "../db/types";

export function nextDate(value: string) { return new Date(Date.parse(`${value}T00:00:00Z`) + 86400000).toISOString().slice(0, 10); }
export function dateRange(value: unknown) {
  const parsed = z.object({ from: dateSchema, to: dateSchema }).safeParse(value);
  if (!parsed.success) throw new AppError("Choose valid from/to arrival dates (YYYY-MM-DD).", 400);
  const { from, to } = parsed.data;
  const days = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000 + 1;
  if (days < 1 || days > 90) throw new AppError("Choose a range of 1 to 90 arrival dates.", 400);
  return { from, to };
}
export function initialCursor(date: string, warnings: string[] = [], seenIds: string[] = []): ManualCursor {
  return { date, ids: [], seenIds, index: 0, searches: [""], searchIndex: 0, searched: false, warnings };
}
export const searchStatuses = ["confirmed", "checked_in", "checked_out", "cancelled", "no_show"];
