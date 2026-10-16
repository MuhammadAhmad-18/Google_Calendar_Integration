import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { reservation } from "./fixtures";

describe("actual Postgres migration and atomic RPCs", () => {
  const pg = new PGlite(); // Test-only, in-memory Postgres. Never used by the app.
  beforeAll(async () => {
    await pg.exec("create role anon; create role authenticated; create role service_role bypassrls;");
    await pg.exec(await readFile(new URL("../supabase/migrations/202610110001_phase1.sql", import.meta.url), "utf8"));
  }, 30000);
  afterAll(async () => { await pg.close(); });
  it("atomically stores one delivery and one job across duplicate submissions", async () => {
    const params = ["c8839bfe-aa2f-4ac4-9847-d30e112516d6", "reservation.created", reservation.property_id, reservation.id];
    const first = await pg.query<{ accepted: boolean }>("select public.enqueue_webhook($1,$2,$3,$4) as accepted", params);
    const repeated = await pg.query<{ accepted: boolean }>("select public.enqueue_webhook($1,$2,$3,$4) as accepted", params);
    expect(first.rows[0].accepted).toBe(true); expect(repeated.rows[0].accepted).toBe(false);
    const count = await pg.query<{ count: number }>("select count(*)::int as count from public.sync_jobs");
    expect(count.rows[0].count).toBe(1);
  });
  it("rolls back the delivery when enqueueing its job fails", async () => {
    await pg.exec("alter table public.sync_jobs add constraint reject_test_event check(event_type <> 'reject-test')");
    const id = "c8839bfe-aa2f-4ac4-9847-d30e112516d7";
    await expect(pg.query("select public.enqueue_webhook($1,$2,$3,$4)", [id, "reject-test", reservation.property_id, reservation.id])).rejects.toThrow();
    const count = await pg.query<{ count: number }>("select count(*)::int as count from public.webhook_deliveries where delivery_id=$1", [id]);
    expect(count.rows[0].count).toBe(0);
    await pg.exec("alter table public.sync_jobs drop constraint reject_test_event");
  });
  it("only one lease owner can process jobs, and another owner cannot release it", async () => {
    const owner1 = "c8839bfe-aa2f-4ac4-9847-d30e112516d8";
    const owner2 = "c8839bfe-aa2f-4ac4-9847-d30e112516d9";
    const lock = async (owner: string) => (await pg.query<{ acquired: boolean }>("select public.acquire_integration_lock($1) as acquired", [owner])).rows[0].acquired;
    expect(await lock(owner1)).toBe(true); expect(await lock(owner2)).toBe(false);
    await pg.query("select public.release_integration_lock($1)", [owner2]); expect(await lock(owner2)).toBe(false);
    await pg.query("select public.release_integration_lock($1)", [owner1]); expect(await lock(owner2)).toBe(true);
    await pg.query("select public.release_integration_lock($1)", [owner2]);
  });
  it("recovers an expired lease", async () => {
    await pg.exec("update public.integration_settings set lock_until = now() - interval '1 second'");
    const result = await pg.query<{ acquired: boolean }>("select public.acquire_integration_lock($1) as acquired", [reservation.id]);
    expect(result.rows[0].acquired).toBe(true);
    await pg.query("select public.release_integration_lock($1)", [reservation.id]);
  });
  it("consumes valid OAuth state exactly once and refuses expired state", async () => {
    await pg.exec("insert into public.oauth_states(state_hash,expires_at) values('valid-test',now()+interval '1 minute'),('expired-test',now()-interval '1 second')");
    const consume = async (value: string) => (await pg.query<{ consumed: boolean }>("select public.consume_oauth_state($1) as consumed", [value])).rows[0].consumed;
    expect(await consume("valid-test")).toBe(true); expect(await consume("valid-test")).toBe(false); expect(await consume("expired-test")).toBe(false);
  });
  it("blocks browser roles from both secret tables and privileged RPCs", async () => {
    for (const role of ["anon", "authenticated"]) {
      await pg.exec(`set role ${role}`);
      await expect(pg.query("select * from public.google_credentials")).rejects.toThrow(/permission denied/);
      await expect(pg.query("select public.acquire_integration_lock($1)", [reservation.id])).rejects.toThrow(/permission denied/);
      await pg.exec("reset role");
    }
  });
  it("gives server role access while throttling repeated login attempts", async () => {
    await pg.exec("set role service_role");
    await expect(pg.query("select * from public.google_credentials")).resolves.toBeDefined();
    for (let i = 0; i < 10; i++) {
      const result = await pg.query<{ allowed: boolean }>("select public.allow_admin_login('test-bucket') as allowed");
      expect(result.rows[0].allowed).toBe(true);
    }
    const result = await pg.query<{ allowed: boolean }>("select public.allow_admin_login('test-bucket') as allowed"); expect(result.rows[0].allowed).toBe(false);
    await pg.exec("reset role");
  });
  it("requeues failed manual work atomically and resets its cursor/counts", async () => {
    await pg.exec("insert into public.sync_jobs(integration_id,kind,status,date_from,date_to,cursor,summary) values('sandbox','manual','failed','2026-10-31','2026-11-01','{\"date\":\"2026-11-01\"}','{\"failed\":1}')");
    const reset = await pg.query<{ reset: boolean }>("select public.retry_failed_jobs() as reset"); expect(reset.rows[0].reset).toBe(true);
    const result = await pg.query<{ status: string; cursor: unknown; summary: { failed: number } }>("select status,cursor,summary from public.sync_jobs where kind='manual'");
    expect(result.rows[0].status).toBe("queued"); expect(result.rows[0].cursor).toEqual({}); expect(result.rows[0].summary.failed).toBe(0);
  });
});
