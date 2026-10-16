import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
const a="11111111-1111-4111-8111-111111111111", b="22222222-2222-4222-8222-222222222222";
const property="33333333-3333-4333-8333-333333333333", installation="44444444-4444-4444-8444-444444444444";
const scope="openid email https://www.googleapis.com/auth/calendar.events";
describe("Atomic Google-first property installation",()=>{
  const pg=new PGlite();
  beforeAll(async()=>{
    await pg.exec("create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key,email_confirmed_at timestamptz)");
    for(const name of ["202610110001_phase1","202610110002_phase2","202610120003_public_hotels","202610150004_google_onboarding"])
      await pg.exec(await readFile(new URL(`../supabase/migrations/${name}.sql`,import.meta.url),"utf8"));
    await pg.query("insert into auth.users values($1,now()),($2,now())",[a,b]);
  },30000);
  afterAll(()=>pg.close());
  async function stage(user:string,googleScope=scope,expired=false){
    const id=randomUUID();
    await pg.query("insert into public.google_onboarding(id,user_id,account_sub,account_email,calendar_id,access_token_encrypted,refresh_token_encrypted,expires_at,scope,valid_until) values($1,$2,'google-account','hotel@example.com','primary','encrypted-google-access','encrypted-google-refresh',9999999999999,$3,$4)",[id,user,googleScope,new Date(Date.now()+(expired?-60000:900000)).toISOString()]);
    return id;
  }
  async function install(user:string,setup:string,access="encrypted-chatbeds-access",prop=property,installId=installation){
    return (await pg.query<{id:string}>("select public.install_hotel_with_google($1,$2,$3,$4,$5,$6,$7,$8) as id",[user,prop,installId,access,"encrypted-chatbeds-refresh",9999999999999,"reservations:read",setup])).rows[0].id;
  }
  it("persists both connections in one transaction and consumes staged Google credentials once",async()=>{
    const setup=await stage(a); expect(await install(a,setup)).toBe(installation);
    expect((await pg.query("select account_sub,calendar_id,access_token_encrypted from public.google_credentials where integration_id=$1",[installation])).rows[0]).toEqual({account_sub:"google-account",calendar_id:"primary",access_token_encrypted:"encrypted-google-access"});
    expect((await pg.query("select google_calendar_id from public.integration_settings where id=$1",[installation])).rows[0]).toEqual({google_calendar_id:"primary"});
    expect((await pg.query("select id from public.google_onboarding where id=$1",[setup])).rows).toHaveLength(0);
    await expect(install(a,setup,"replayed-access")).rejects.toThrow(/expired or already used/);
    expect((await pg.query("select access_token_encrypted from public.chatbeds_credentials where integration_id=$1",[installation])).rows[0]).toEqual({access_token_encrypted:"encrypted-chatbeds-access"});
  });
  it("does not let a different hotel consume staged Google authorization",async()=>{
    const setup=await stage(a);
    await expect(install(b,setup)).rejects.toThrow(/expired or already used/);
    await expect(pg.query("select public.attach_hotel_google($1,$2,$3)",[b,setup,installation])).rejects.toThrow(/Property unavailable/);
    expect((await pg.query("select id from public.google_onboarding where id=$1",[setup])).rows).toHaveLength(1);
  });
  it("rejects another hotel's property without replacing either provider credential",async()=>{
    const setup=await stage(b);
    await expect(install(b,setup,"attacker-chatbeds-access")).rejects.toThrow(/Property unavailable/);
    expect((await pg.query("select access_token_encrypted from public.chatbeds_credentials where integration_id=$1",[installation])).rows[0]).toEqual({access_token_encrypted:"encrypted-chatbeds-access"});
    expect((await pg.query("select access_token_encrypted from public.google_credentials where integration_id=$1",[installation])).rows[0]).toEqual({access_token_encrypted:"encrypted-google-access"});
  });
  it("rolls back ChatBeds token replacement if Calendar permissions are absent",async()=>{
    const setup=await stage(a,"openid email");
    await expect(install(a,setup,"must-roll-back")).rejects.toThrow(/Calendar permission/);
    expect((await pg.query("select access_token_encrypted from public.chatbeds_credentials where integration_id=$1",[installation])).rows[0]).toEqual({access_token_encrypted:"encrypted-chatbeds-access"});
    expect((await pg.query("select id from public.google_onboarding where id=$1",[setup])).rows).toHaveLength(1);
  });
  it("does not create a property when the Google setup has expired",async()=>{
    const setup=await stage(a,scope,true), otherProperty=randomUUID(),otherInstallation=randomUUID();
    await expect(install(a,setup,"expired-access",otherProperty,otherInstallation)).rejects.toThrow(/expired/);
    expect((await pg.query("select id from public.integration_settings where property_id=$1",[otherProperty])).rows).toHaveLength(0);
  });
  it("allows a returning owner to reconnect Calendar using the existing property and mappings",async()=>{
    const setup=await stage(a);
    await pg.query("select public.attach_hotel_google($1,$2,$3)",[a,setup,installation]);
    expect((await pg.query("select count(*)::int as count from public.integration_settings where property_id=$1",[property])).rows[0]).toEqual({count:1});
    expect((await pg.query("select access_token_encrypted from public.chatbeds_credentials where integration_id=$1",[installation])).rows[0]).toEqual({access_token_encrypted:"encrypted-chatbeds-access"});
  });
  it("keeps staged OAuth tokens and completion functions inaccessible to browser roles",async()=>{
    for(const role of ["anon","authenticated"]){
      await pg.exec(`set role ${role}`);
      await expect(pg.query("select * from public.google_onboarding")).rejects.toThrow(/permission denied/);
      await expect(pg.query("select public.attach_hotel_google($1,$2,$3)",[a,randomUUID(),installation])).rejects.toThrow(/permission denied/);
      await expect(install(a,randomUUID())).rejects.toThrow(/permission denied/);
      await pg.exec("reset role");
    }
  });
  it("removes expired onboarding grants without deleting active property credentials",async()=>{
    await pg.query("select public.cleanup_integration_history(90)");
    expect((await pg.query("select id from public.google_onboarding where valid_until<now()")).rows).toHaveLength(0);
    expect((await pg.query("select account_sub from public.google_credentials where integration_id=$1",[installation])).rows).toHaveLength(1);
  });
});
