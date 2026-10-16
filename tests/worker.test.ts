import { afterEach, describe, expect, it, vi } from "vitest";
import type { SyncJob } from "@/lib/db/types";
import { emptySummary } from "@/lib/db/types";
import { reservation } from "./fixtures";
const mocks = vi.hoisted(() => ({ jobs: [] as SyncJob[], search: vi.fn(), readReservation: vi.fn(), sync: vi.fn(), log: vi.fn(), deliveryUpdates: vi.fn() }));
vi.mock("@/lib/db/client", () => ({
  checked: (result: { data: unknown }) => result.data,
  db: () => ({ from: (table: string) => {
    if (table === "integration_settings") return { update: () => ({ eq: async () => ({ data: null, error: null }) }) };
    if (table === "sync_jobs") {
      const chain = { select: () => chain, eq: () => chain, or: () => chain, lte: () => chain, order: () => chain, limit: async () => ({ data: mocks.jobs.filter(job => ["queued", "processing"].includes(job.status)).slice(0, 1), error: null }) };
      return chain;
    }
    return { update: (value: unknown) => ({ eq: async () => { mocks.deliveryUpdates(value); return { data: null, error: null }; } }) };
  } }),
}));
vi.mock("@/lib/db/store", () => ({
  withIntegrationLock: (work: () => Promise<unknown>) => work(), getIntegration: async () => ({ property_id: reservation.property_id }),
  installationMappingStore: () => ({}), logSync: mocks.log, saveJob: async (job: SyncJob) => { const index = mocks.jobs.findIndex(value => value.id === job.id); mocks.jobs[index] = structuredClone(job); },
}));
vi.mock("@/lib/chatbeds/credentials", () => ({ credentialProvider: () => ({ getAccessCredential: async () => "mock-token" }) }));
vi.mock("@/lib/google/calendar", () => ({ googleCalendar: async () => ({ gateway: {}, credentials: { account_sub: "mock-sub", calendar_id: "primary" } }) }));
vi.mock("@/lib/chatbeds/client", () => ({ ChatBedsClient: class { search = mocks.search; reservation = mocks.readReservation; } }));
vi.mock("@/lib/sync/sync-reservation", () => ({ syncReservation: mocks.sync }));
import { processJobs } from "@/lib/sync/worker";
function job(kind: "manual" | "webhook"): SyncJob {
  return { id: "mock-job", integration_id: "sandbox", kind, delivery_id: kind === "webhook" ? reservation.id : null, reservation_id: kind === "webhook" ? reservation.id : null, event_type: kind === "webhook" ? "reservation.created" : null, date_from: "2026-10-31", date_to: "2026-11-01", cursor: {}, summary: emptySummary(), status: "queued", attempts: 0, next_attempt_at: "2026-10-01T00:00:00Z", error: null };
}
afterEach(() => { vi.resetAllMocks(); mocks.jobs = []; });
describe("persistent sync worker", () => {
  it("queries each exact arrival day, deduplicates IDs across the job and uses current reservations", async () => {
    mocks.jobs = [job("manual")]; mocks.search.mockResolvedValue([reservation]); mocks.readReservation.mockResolvedValue({ ...reservation, status: "checked_in" }); mocks.sync.mockResolvedValue({ action: "create", eventId: "mock-event", message: "created" });
    expect(await processJobs()).toEqual({ processed: 1 });
    expect(mocks.search.mock.calls.map(call => call[1])).toEqual(["2026-10-31", "2026-11-01"]);
    expect(mocks.readReservation).toHaveBeenCalledTimes(1); expect(mocks.sync.mock.calls[0][0].status).toBe("checked_in");
    expect(mocks.jobs[0].summary.created).toBe(1); expect(mocks.jobs[0].status).toBe("completed");
  });
  it("narrows saturated searches only with documented statuses and reports truncation", async () => {
    const manual = job("manual"); manual.date_to = manual.date_from; mocks.jobs = [manual];
    mocks.search.mockResolvedValue(Array.from({ length: 100 }, () => reservation)); mocks.readReservation.mockResolvedValue(reservation); mocks.sync.mockResolvedValue({ action: "skip", eventId: "mock-event", message: "same" });
    await processJobs();
    expect(mocks.search.mock.calls.map(call => call[2])).toEqual([undefined, "confirmed", "checked_in", "checked_out", "cancelled", "no_show"]);
    expect(mocks.sync).toHaveBeenCalledTimes(1); expect(mocks.jobs[0].error).toContain("API has no pagination");
  });
  it("resumes a saved cursor without requerying or repeating earlier entries", async () => {
    const manual = job("manual"); manual.date_to = manual.date_from;
    manual.cursor = { date: "2026-10-31", ids: ["already-processed", reservation.id], index: 1, seenIds: ["already-processed"], searches: [""], searchIndex: 1, searched: true, warnings: [] };
    mocks.jobs = [manual]; mocks.readReservation.mockResolvedValue(reservation); mocks.sync.mockResolvedValue({ action: "update", eventId: "mock-event", message: "updated" });
    await processJobs(); expect(mocks.search).not.toHaveBeenCalled(); expect(mocks.readReservation).toHaveBeenCalledExactlyOnceWith(reservation.id); expect(mocks.jobs[0].status).toBe("completed");
  });
  it("counts failed manual reservations and finishes with a visible retryable error", async () => {
    const manual = job("manual"); manual.date_to = manual.date_from; mocks.jobs = [manual]; mocks.search.mockResolvedValue([reservation]); mocks.readReservation.mockRejectedValue(new Error("provider-secret-must-not-escape"));
    await processJobs(); expect(mocks.jobs[0].status).toBe("failed"); expect(mocks.jobs[0].summary.failed).toBe(1);
    expect(JSON.stringify(mocks.log.mock.calls)).not.toContain("provider-secret");
  });
  it("processes webhooks from fresh API reads and marks delivery processed", async () => {
    mocks.jobs = [job("webhook")]; mocks.readReservation.mockResolvedValue({ ...reservation, status: "cancelled" }); mocks.sync.mockResolvedValue({ action: "delete", eventId: "mock-event", message: "deleted" });
    await processJobs(); expect(mocks.sync.mock.calls[0][0].status).toBe("cancelled"); expect(mocks.deliveryUpdates.mock.calls[0][0].status).toBe("processed"); expect(mocks.jobs[0].status).toBe("completed");
  });
  it("retains failed webhook work for backoff retry with sanitized errors", async () => {
    mocks.jobs = [job("webhook")]; mocks.readReservation.mockRejectedValue(new Error("provider-secret"));
    await processJobs(); expect(mocks.jobs[0].status).toBe("failed"); expect(mocks.jobs[0].attempts).toBe(1);
    expect(Date.parse(mocks.jobs[0].next_attempt_at)).toBeGreaterThan(Date.now()); expect(mocks.jobs[0].error).not.toContain("provider-secret");
  });
});
