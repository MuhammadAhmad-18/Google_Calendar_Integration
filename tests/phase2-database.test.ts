import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { reservation } from "./fixtures";
const secondProperty = "19306340-c7cf-465a-93d3-0b7873a7e85e";
const installation1 = "c2205d78-c0e7-4d92-94be-9b91e1ab42aa", installation2 = "c2205d78-c0e7-4d92-94be-9b91e1ab42ab";
const owner1 = "c8839bfe-aa2f-4ac4-9847-d30e112516d8", owner2 = "c8839bfe-aa2f-4ac4-9847-d30e112516d9";
describe("Phase 2 additive Postgres schema and per-installation RPCs", () => {
  const pg = new PGlite();
  beforeAll(async () => {
    await pg.exec("create role anon; create role authenticated; create role service_role bypassrls;");
    await pg.exec(await readFile(new URL("../supabase/migrations/202610110001_phase1.sql", import.meta.url), "utf8"));
    await pg.query("update public.integration_settings set property_id=$1,property_name='Sandbox Hotel' where id='sandbox'", [reservation.property_id]);
    await pg.exec("insert into public.google_credentials values('sandbox','existing-google-account','qa@example.com','primary','encrypted-google-access','encrypted-google-refresh',9999999999999,now())");
    await pg.exec(await readFile(new URL("../supabase/migrations/202610110002_phase2.sql", import.meta.url), "utf8"));
  }, 30000);
  afterAll(async () => pg.close());
  async function install(property: string, installation: string, access = "encrypted-access", refresh = "encrypted-refresh") {
    return (await pg.query<{ id: string }>("select public.install_chatbeds($1,$2,$3,$4,$5,$6) as id", [property, installation, access, refresh, Date.now()+3600000, "reservations:read"])).rows[0].id;
  }
  it("converts the existing sandbox property without losing its Google credentials", async () => {
    expect(await install(reservation.property_id, installation1)).toBe("sandbox");
    const row = await pg.query<{ auth_mode: string; installation_id: string }>("select auth_mode,installation_id from public.integration_settings where id='sandbox'");
    expect(row.rows[0]).toEqual({ auth_mode: "oauth", installation_id: installation1 });
    expect((await pg.query("select account_sub from public.google_credentials where integration_id='sandbox'")).rows).toEqual([{ account_sub: "existing-google-account" }]);
  });
  it("creates separate installations and maintains independent sync leases", async () => {
    expect(await install(secondProperty, installation2)).toBe(installation2);
    const lock = async (id: string, owner: string) => (await pg.query<{ ok: boolean }>("select public.acquire_installation_lock($1,$2) as ok", [id,owner])).rows[0].ok;
    expect(await lock("sandbox",owner1)).toBe(true); expect(await lock("sandbox",owner2)).toBe(false); expect(await lock(installation2,owner2)).toBe(true);
    await pg.query("select public.release_installation_lock($1,$2)", ["sandbox",owner1]);
    await pg.query("select public.release_installation_lock($1,$2)", [installation2,owner2]);
  });
  it("routes app-wide deliveries to their property and deduplicates transactionally", async () => {
    const id = "c8839bfe-aa2f-4ac4-9847-d30e112516d6";
    const params = [installation2,id,"reservation.modified",secondProperty,reservation.id];
    expect((await pg.query<{ accepted: boolean }>("select public.enqueue_installation_webhook($1,$2,$3,$4,$5) as accepted",params)).rows[0].accepted).toBe(true);
    expect((await pg.query<{ accepted: boolean }>("select public.enqueue_installation_webhook($1,$2,$3,$4,$5) as accepted",params)).rows[0].accepted).toBe(false);
    expect((await pg.query("select integration_id from public.sync_jobs where delivery_id=$1",[id])).rows).toEqual([{ integration_id: installation2 }]);
    await expect(pg.query("select public.enqueue_installation_webhook($1,$2,$3,$4,$5)",["sandbox",owner2,"reservation.created",secondProperty,reservation.id])).rejects.toThrow(/Property does not match/);
  });
  it("retains refresh intent after expiry, and refuses finish from a different owner", async () => {
    const lock = async (owner: string) => (await pg.query<{ ok: boolean }>("select public.acquire_chatbeds_refresh($1,$2) as ok", ["sandbox",owner])).rows[0].ok;
    expect(await lock(owner1)).toBe(true); expect(await lock(owner2)).toBe(false);
    expect((await pg.query<{ ok: boolean }>("select public.begin_chatbeds_refresh($1,$2) as ok",["sandbox",owner1])).rows[0].ok).toBe(true);
    expect((await pg.query<{ ok: boolean }>("select public.finish_chatbeds_refresh($1,$2,$3,$4,$5,$6) as ok",["sandbox",owner2,"next-access","next-refresh",100,"reservations:read"])).rows[0].ok).toBe(false);
    await pg.exec("update public.chatbeds_credentials set refresh_lock_until=now()-interval '1 second' where integration_id='sandbox'");
    expect(await lock(owner2)).toBe(true);
    expect((await pg.query<{ ok: boolean }>("select public.begin_chatbeds_refresh($1,$2) as ok",["sandbox",owner2])).rows[0].ok).toBe(false);
    expect((await pg.query<{refresh_started:boolean}>("select refresh_started from public.chatbeds_credentials where integration_id='sandbox'")).rows[0].refresh_started).toBe(true);
    await pg.query("select public.release_chatbeds_refresh($1,$2)",["sandbox",owner2]);
  });
  it("reconnect atomically resets uncertain refresh and preserves integration ID", async () => {
    expect(await install(reservation.property_id,installation1,"reconnected-access","reconnected-refresh")).toBe("sandbox");
    expect((await pg.query("select refresh_started,access_token_encrypted from public.chatbeds_credentials where integration_id='sandbox'")).rows[0]).toEqual({ refresh_started: false, access_token_encrypted: "reconnected-access" });
    expect((await pg.query<{count:number}>("select count(*)::int as count from public.google_credentials")).rows[0].count).toBe(1);
  });
  it("retries only the selected installation's failed jobs", async () => {
    await pg.query("insert into public.sync_jobs(integration_id,kind,status) values('sandbox','manual','failed'),($1,'manual','failed')",[installation2]);
    await pg.query("select public.retry_installation_jobs($1)",[installation2]);
    expect((await pg.query<{status:string}>("select status from public.sync_jobs where integration_id='sandbox'")).rows[0].status).toBe("failed");
    expect((await pg.query<{status:string}>("select status from public.sync_jobs where integration_id=$1 and kind='manual'",[installation2])).rows[0].status).toBe("queued");
  });
  it("enforces a shared per-property call budget and honors Retry-After pauses", async () => {
    const claim = async (id: string) => (await pg.query<{ wait: number }>("select public.claim_chatbeds_request($1) as wait",[id])).rows[0].wait;
    for (let i=0;i<100;i++) expect(await claim("sandbox")).toBe(0);
    expect(await claim("sandbox")).toBeGreaterThan(0); expect(await claim(installation2)).toBe(0);
    await pg.query("update public.integration_settings set chatbeds_retry_at=now()+interval '10 minutes' where id=$1",[installation2]);
    expect(await claim(installation2)).toBeGreaterThan(590);
  });
  it("prevents browser roles from reading ChatBeds tokens or invoking Phase 2 RPCs", async () => {
    for (const role of ["anon","authenticated"]) {
      await pg.exec(`set role ${role}`);
      await expect(pg.query("select * from public.chatbeds_credentials")).rejects.toThrow(/permission denied/);
      await expect(pg.query("select public.acquire_chatbeds_refresh($1,$2)",["sandbox",owner1])).rejects.toThrow(/permission denied/);
      await expect(pg.query("select public.install_chatbeds($1,$2,$3,$4,$5,$6)",[secondProperty,installation2,"secret","secret",100,"reservations:read"])).rejects.toThrow(/permission denied/);
      await pg.exec("reset role");
    }
  });
  it("recovers eligible installations fairly while excluding disconnected properties",async()=>{
    await pg.exec("update public.sync_jobs set status='queued',next_attempt_at=now(); update public.integration_settings set chatbeds_status='connected'");
    await pg.query("insert into public.google_credentials(integration_id,account_sub,calendar_id,access_token_encrypted,refresh_token_encrypted,expires_at) values($1,'second-google-account','primary','encrypted-access','encrypted-refresh',9999999999999)",[installation2]);
    await pg.exec("update public.integration_settings set last_worker_at=now() where id='sandbox'");
    const ready=await pg.query<{integration_id:string}>("select * from public.ready_chatbeds_installations()");
    expect(ready.rows.map(row=>row.integration_id)).toEqual([installation2,"sandbox"]);
    await pg.query("update public.integration_settings set chatbeds_status='disconnected' where id=$1",[installation2]);
    expect((await pg.query<{integration_id:string}>("select * from public.ready_chatbeds_installations()")).rows.map(row=>row.integration_id)).toEqual(["sandbox"]);
  });
  it("serializes Google requests and account-wide revocation with an owner-bound lease",async()=>{
    const acquire=async(owner:string)=>(await pg.query<{ok:boolean}>("select public.acquire_google_grant_lock($1) as ok",[owner])).rows[0].ok;
    expect(await acquire(owner1)).toBe(true);expect(await acquire(owner2)).toBe(false);
    await pg.query("select public.release_google_grant_lock($1)",[owner2]);expect(await acquire(owner2)).toBe(false);
    await pg.query("select public.release_google_grant_lock($1)",[owner1]);expect(await acquire(owner2)).toBe(true);
    await pg.query("select public.release_google_grant_lock($1)",[owner2]);
  });
});
