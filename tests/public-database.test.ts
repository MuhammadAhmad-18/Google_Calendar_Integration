import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
const userA = "11111111-1111-4111-8111-111111111111", userB = "22222222-2222-4222-8222-222222222222";
const propertyA = "33333333-3333-4333-8333-333333333333", propertyB = "44444444-4444-4444-8444-444444444444";
const installationA = "55555555-5555-4555-8555-555555555555", installationB = "66666666-6666-4666-8666-666666666666";
describe("Public hotel ownership and durable login protection in Postgres", () => {
  const pg = new PGlite();
  beforeAll(async () => {
    await pg.exec("create role anon; create role authenticated; create role service_role bypassrls; create schema auth; create table auth.users(id uuid primary key,email_confirmed_at timestamptz);");
    for (const name of ["202610110001_phase1", "202610110002_phase2", "202610120003_public_hotels"])
      await pg.exec(await readFile(new URL(`../supabase/migrations/${name}.sql`, import.meta.url), "utf8"));
    await pg.query("insert into auth.users values($1,now()),($2,now())", [userA, userB]);
  }, 30000);
  afterAll(() => pg.close());
  async function install(user: string, property: string, installation: string, access = "encrypted-access") {
    return (await pg.query<{ id: string }>("select public.install_hotel_chatbeds($1,$2,$3,$4,$5,$6,$7) as id", [user, property, installation, access, "encrypted-refresh", Date.now() + 3600000, "reservations:read"])).rows[0].id;
  }
  it("creates different default workspaces and reuses only a user's own workspace", async () => {
    const ensure = async (id: string) => (await pg.query<{ id: string }>("select public.ensure_hotel_workspace($1) as id", [id])).rows[0].id;
    const first = await ensure(userA), second = await ensure(userB);
    expect(first).not.toBe(second); expect(first).not.toBe("sandbox"); expect(await ensure(userA)).toBe(first);
  });
  it("requires verified email before creating a workspace or installing a property", async () => {
    const unverified = "77777777-7777-4777-8777-777777777777";
    await pg.query("insert into auth.users values($1,null)", [unverified]);
    await expect(pg.query("select public.ensure_hotel_workspace($1)", [unverified])).rejects.toThrow(/Verified hotel user/);
    await expect(install(unverified, propertyA, installationA)).rejects.toThrow(/Verified hotel user/);
  });
  it("atomically assigns new properties to their authorizing user", async () => {
    expect(await install(userA, propertyA, installationA)).toBe(installationA);
    expect(await install(userB, propertyB, installationB)).toBe(installationB);
    expect((await pg.query("select user_id::text from public.integration_members where integration_id=$1", [installationA])).rows).toEqual([{ user_id: userA }]);
  });
  it("rejects another hotel reconnecting an owned property without replacing any tokens", async () => {
    await expect(install(userB, propertyA, installationA, "attacker-token")).rejects.toThrow(/Property unavailable/);
    expect((await pg.query("select access_token_encrypted from public.chatbeds_credentials where integration_id=$1", [installationA])).rows[0]).toEqual({ access_token_encrypted: "encrypted-access" });
  });
  it("allows an authorized reconnect and preserves saved Google credentials", async () => {
    await pg.query("insert into public.google_credentials(integration_id,account_sub,calendar_id,access_token_encrypted,refresh_token_encrypted,expires_at) values($1,'account','primary','google-access','google-refresh',100)", [installationA]);
    expect(await install(userA, propertyA, installationA, "reconnected-access")).toBe(installationA);
    expect((await pg.query("select account_sub from public.google_credentials where integration_id=$1", [installationA])).rows[0]).toEqual({ account_sub: "account" });
  });
  it("never lets the first signup claim a legacy sandbox connection", async () => {
    const legacyProperty = "88888888-8888-4888-8888-888888888888";
    await pg.query("update public.integration_settings set property_id=$1 where id='sandbox'", [legacyProperty]);
    await expect(install(userA, legacyProperty, "99999999-9999-4999-8999-999999999999")).rejects.toThrow(/Property unavailable/);
  });
  it("allows one owner per property and keeps browser roles out of membership mutation/RPCs", async () => {
    await expect(pg.query("insert into public.integration_members(integration_id,user_id) values($1,$2)", [installationA,userB])).rejects.toThrow(/unique/);
    for (const role of ["anon", "authenticated"]) {
      await pg.exec(`set role ${role}`);
      await expect(pg.query("select * from public.integration_members")).rejects.toThrow(/permission denied/);
      await expect(pg.query("select public.ensure_hotel_workspace($1)", [userA])).rejects.toThrow(/permission denied/);
      await expect(install(userA, propertyA, installationA)).rejects.toThrow(/permission denied/);
      await pg.exec("reset role");
    }
  });
  it("persists rate limits independently for users and resets an expired window", async () => {
    const limit = async (bucket: string) => (await pg.query<{ ok: boolean }>("select public.allow_public_auth($1,2,600) as ok", [bucket])).rows[0].ok;
    expect(await limit("hashed-email-a")).toBe(true); expect(await limit("hashed-email-a")).toBe(true); expect(await limit("hashed-email-a")).toBe(false);
    expect(await limit("hashed-email-b")).toBe(true);
    await pg.exec("update public.public_auth_attempts set window_started=now()-interval '11 minutes'");
    expect(await limit("hashed-email-a")).toBe(true);
  });
  it("cleans old completed history without deleting mappings, delivery IDs or unfinished work", async () => {
    await pg.query("insert into public.sync_logs(integration_id,source,action,success,message,created_at) values($1,'manual','skip',true,'old',now()-interval '100 days')", [installationA]);
    await pg.query("insert into public.sync_jobs(integration_id,kind,status,updated_at) values($1,'manual','completed',now()-interval '100 days'),($1,'manual','queued',now()-interval '100 days')", [installationA]);
    await pg.query("select public.cleanup_integration_history(90)");
    expect((await pg.query("select * from public.sync_logs where message='old'")).rows).toHaveLength(0);
    expect((await pg.query("select status from public.sync_jobs where integration_id=$1", [installationA])).rows).toEqual([{ status: "queued" }]);
    expect((await pg.query("select * from public.google_credentials where integration_id=$1", [installationA])).rows).toHaveLength(1);
  });
});
