import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatBedsCredentials } from "@/lib/db/types";
const mocks = vi.hoisted(() => ({ row: null as ChatBedsCredentials | null, locked: false, saveFails:false, rpc:vi.fn(), refresh:vi.fn(), updateIntegration:vi.fn() }));
vi.mock("@/lib/db/client",()=>({checked:(r:{data:unknown,error?:unknown})=>{if(r.error)throw new Error("mock-db-error");return r.data;},db:()=>({
  from:()=>({select:()=>({eq:()=>({maybeSingle:async()=>({data:mocks.row}),single:async()=>({data:{chatbeds_retry_at:null}})})}),update:()=>({eq:async()=>({data:null})})}),rpc:mocks.rpc,
})}));
vi.mock("@/lib/db/store",()=>({updateIntegration:mocks.updateIntegration}));
vi.mock("@/lib/chatbeds/oauth",()=>({refreshChatBedsTokens:mocks.refresh}));
import { chatbedsAccessToken, chatbedsTokenContext } from "@/lib/chatbeds/token-store";
import { decryptToken, encryptToken } from "@/lib/crypto/tokens";
import { ChatBedsRetryError } from "@/lib/chatbeds/rate-limit";
const property = "19306340-c7cf-465a-93d3-0b7873a7e85d", installation = "c2205d78-c0e7-4d92-94be-9b91e1ab42aa";
beforeEach(()=>{
  vi.resetAllMocks();mocks.locked=false;mocks.saveFails=false;
  vi.stubEnv("TOKEN_ENCRYPTION_KEY",Buffer.alloc(32,4).toString("base64"));
  mocks.row={integration_id:"sandbox",installation_id:installation,property_id:property,scope:"reservations:read",expires_at:1,refresh_started:false,
    access_token_encrypted:encryptToken("cbat_old",chatbedsTokenContext(installation,"access")),refresh_token_encrypted:encryptToken("cbrt_old",chatbedsTokenContext(installation,"refresh"))};
  mocks.rpc.mockImplementation(async(name:string,args:Record<string,unknown>)=>{
    if(name==="acquire_chatbeds_refresh"){if(mocks.locked)return {data:false};mocks.locked=true;return {data:true};}
    if(name==="release_chatbeds_refresh"){mocks.locked=false;return {data:null};}
    if(name==="begin_chatbeds_refresh"){if(mocks.row!.refresh_started)return {data:false};mocks.row!.refresh_started=true;return {data:true};}
    if(name==="cancel_chatbeds_refresh"){mocks.row!.refresh_started=false;return {data:null};}
    if(name==="finish_chatbeds_refresh"){
      if(mocks.saveFails)return {data:false};
      Object.assign(mocks.row!,{access_token_encrypted:args.p_access,refresh_token_encrypted:args.p_refresh,expires_at:args.p_expiry,refresh_started:false});return {data:true};
    }
    throw new Error("Unexpected mock RPC");
  });
  mocks.refresh.mockResolvedValue({access_token:"cbat_new",refresh_token:"cbrt_new",token_type:"Bearer",expires_in:3600,scope:"reservations:read",property_id:property,installation_id:installation});
});
afterEach(()=>vi.unstubAllEnvs());
describe("single-use ChatBeds refresh safety across serverless requests",()=>{
  it("persists BOTH encrypted rotated tokens before returning new access",async()=>{
    expect(await chatbedsAccessToken("sandbox")).toBe("cbat_new");
    expect(mocks.refresh).toHaveBeenCalledExactlyOnceWith("cbrt_old");
    expect(decryptToken(mocks.row!.refresh_token_encrypted,chatbedsTokenContext(installation,"refresh"))).toBe("cbrt_new");
    expect(mocks.row!.refresh_started).toBe(false);expect(mocks.locked).toBe(false);
  });
  it("blocks a concurrent refresh so the same rotating token is used once",async()=>{
    let release!:()=>void; const held=new Promise<void>(resolve=>{release=resolve;});
    mocks.refresh.mockImplementation(async()=>{await held;return {access_token:"cbat_new",refresh_token:"cbrt_new",expires_in:3600,scope:"reservations:read",property_id:property,installation_id:installation};});
    const first=chatbedsAccessToken("sandbox");
    await vi.waitFor(()=>expect(mocks.refresh).toHaveBeenCalledOnce());
    await expect(chatbedsAccessToken("sandbox")).rejects.toMatchObject({status:409});release();await first;
    expect(mocks.refresh).toHaveBeenCalledOnce();
  });
  it("uses the newly stored access token after another caller refreshed an older rejected token",async()=>{
    await chatbedsAccessToken("sandbox");
    expect(await chatbedsAccessToken("sandbox","cbat_old")).toBe("cbat_new");expect(mocks.refresh).toHaveBeenCalledOnce();
  });
  it("never reuses a refresh token after timeout, restart, or lost save response",async()=>{
    mocks.refresh.mockRejectedValue(new Error("mock-secret-provider-body"));
    await expect(chatbedsAccessToken("sandbox")).rejects.toThrow();expect(mocks.row!.refresh_started).toBe(true);
    await expect(chatbedsAccessToken("sandbox")).rejects.toThrow("could not be confirmed");expect(mocks.refresh).toHaveBeenCalledOnce();
    expect(JSON.stringify(mocks.updateIntegration.mock.calls)).not.toContain("mock-secret");
  });
  it("requires reconnect if rotated credentials cannot be committed",async()=>{
    mocks.saveFails=true;await expect(chatbedsAccessToken("sandbox")).rejects.toThrow("saved safely");
    await expect(chatbedsAccessToken("sandbox")).rejects.toThrow("could not be confirmed");expect(mocks.refresh).toHaveBeenCalledOnce();
  });
  it("rejects tokens belonging to another property or installation",async()=>{
    mocks.refresh.mockResolvedValue({property_id:"other-property",installation_id:installation});
    await expect(chatbedsAccessToken("sandbox")).rejects.toThrow("different installation");
    expect(mocks.rpc.mock.calls.some(call=>call[0]==="finish_chatbeds_refresh")).toBe(false);
  });
  it("allows a later refresh only after a documented 429 refusal",async()=>{
    mocks.refresh.mockRejectedValueOnce(new ChatBedsRetryError(30));
    await expect(chatbedsAccessToken("sandbox")).rejects.toMatchObject({retryAfter:30});
    expect(mocks.row!.refresh_started).toBe(false);
    expect(mocks.updateIntegration).not.toHaveBeenCalled();
  });
});
