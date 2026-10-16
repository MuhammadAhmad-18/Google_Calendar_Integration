import { createHash } from "node:crypto";
import { afterEach,beforeEach,describe,expect,it,vi } from "vitest";
const mocks=vi.hoisted(()=>({admin:vi.fn(),cookies:vi.fn(),insert:vi.fn(),delete:vi.fn(),getIntegration:vi.fn(),update:vi.fn(),log:vi.fn(),credentials:vi.fn(),revoke:vi.fn()}));
vi.mock("next/headers",()=>({cookies:mocks.cookies}));
vi.mock("@/lib/auth/session",async original=>({...await original<typeof import("@/lib/auth/session")>(),requireAdmin:mocks.admin}));
vi.mock("@/lib/db/client",()=>({checked:(result:{data:unknown})=>result.data,db:()=>({from:()=>({insert:mocks.insert,delete:()=>({eq:mocks.delete})})})}));
vi.mock("@/lib/db/store",()=>({getIntegration:mocks.getIntegration,updateIntegration:mocks.update,logSync:mocks.log,withIntegrationLock:(work:()=>Promise<unknown>)=>work()}));
vi.mock("@/lib/chatbeds/token-store",()=>({getChatBedsCredentials:mocks.credentials,withChatBedsRefreshLock:(_id:string,work:()=>Promise<unknown>)=>work(),chatbedsTokenContext:(id:string,kind:string)=>`chatbeds:${id}:${kind}`}));
vi.mock("@/lib/chatbeds/oauth",async original=>({...await original<typeof import("@/lib/chatbeds/oauth")>(),revokeChatBedsToken:mocks.revoke}));
import { POST as connect } from "@/app/api/chatbeds/connect/route";
import { POST as disconnect } from "@/app/api/chatbeds/disconnect/route";
import { POST as select } from "@/app/api/integrations/select/route";
import { decryptToken,encryptToken } from "@/lib/crypto/tokens";
import { NextResponse } from "next/server";
import { AppError } from "@/lib/errors";
const integration="c2205d78-c0e7-4d92-94be-9b91e1ab42ab",installation="c2205d78-c0e7-4d92-94be-9b91e1ab42aa";
function request(path:string,body?:unknown,origin="http://localhost:3000"){return new Request(`http://localhost:3000/api/${path}`,{method:"POST",headers:{origin,"Content-Type":"application/json"},body:body?JSON.stringify(body):undefined});}
beforeEach(()=>{
  vi.resetAllMocks();vi.stubEnv("NEXT_PUBLIC_APP_URL","http://localhost:3000");vi.stubEnv("TOKEN_ENCRYPTION_KEY",Buffer.alloc(32,9).toString("base64"));vi.stubEnv("CHATBEDS_AUTH_MODE","oauth");
  vi.stubEnv("CHATBEDS_CLIENT_ID","cba_mock");vi.stubEnv("CHATBEDS_CLIENT_SECRET","cbs_mock-secret");vi.stubEnv("CHATBEDS_REDIRECT_URI","http://localhost:3000/api/chatbeds/callback");vi.stubEnv("CHATBEDS_OAUTH_AUTHORIZE_URL","https://mock-chatbeds.invalid/oauth/authorize");
  mocks.cookies.mockResolvedValue({get:(name:string)=>name==="chatbeds_installation"?{value:encryptToken(integration,"selected-installation")}:{value:"mock-admin-session"}});
  mocks.insert.mockResolvedValue({data:null});mocks.delete.mockResolvedValue({data:null});mocks.getIntegration.mockResolvedValue({id:integration,auth_mode:"oauth"});
  mocks.credentials.mockResolvedValue({installation_id:installation,refresh_started:false,access_token_encrypted:encryptToken("cbat_mock-access",`chatbeds:${installation}:access`)});
});
afterEach(()=>vi.unstubAllEnvs());
describe("Phase 2 admin connection controls",()=>{
  it("creates encrypted, session-bound PKCE state with one-use database hash",async()=>{
    const response=await connect(request("chatbeds/connect"));expect(response.status).toBe(303);
    const url=new URL(response.headers.get("location")!),state=url.searchParams.get("state")!;
    expect(url.searchParams.get("scope")).toBe("reservations:read");expect(url.toString()).not.toContain("cbs_mock-secret");
    const cookie=(response as NextResponse).cookies.get("chatbeds_app_state")!;
    const stored=JSON.parse(decryptToken(cookie.value,"chatbeds-oauth-state"));expect(stored.state).toBe(state);expect(stored.verifier.length).toBeGreaterThanOrEqual(43);
    expect(stored.sessionHash).toBe(createHash("sha256").update("mock-admin-session").digest("hex"));expect(cookie.httpOnly).toBe(true);expect(cookie.sameSite).toBe("lax");
    expect(mocks.insert).toHaveBeenCalledWith(expect.objectContaining({state_hash:createHash("sha256").update(state).digest("hex")}));
  });
  it.each([connect,disconnect,select])("rejects another origin before token or database changes",async handler=>{
    expect((await handler(request("test",{integrationId:integration},"https://attacker.example"))).status).toBe(403);
    expect(mocks.insert).not.toHaveBeenCalled();expect(mocks.delete).not.toHaveBeenCalled();expect(mocks.revoke).not.toHaveBeenCalled();
  });
  it("requires admin authentication for ChatBeds connection",async()=>{
    mocks.admin.mockRejectedValue(new AppError("Sign in first.",401));expect((await connect(request("chatbeds/connect"))).status).toBe(401);expect(mocks.insert).not.toHaveBeenCalled();
  });
  it("keeps private-key mode separate from ChatBeds app OAuth",async()=>{
    vi.stubEnv("CHATBEDS_AUTH_MODE","api_key");expect((await connect(request("chatbeds/connect"))).status).toBe(409);expect(mocks.insert).not.toHaveBeenCalled();
  });
  it("disconnects only the selected ChatBeds installation and retains maps/Google credentials",async()=>{
    const response=await disconnect(request("chatbeds/disconnect"));expect(await response.json()).toEqual({ok:true,revoked:true});
    expect(mocks.revoke).toHaveBeenCalledExactlyOnceWith("cbat_mock-access");expect(mocks.delete).toHaveBeenCalledExactlyOnceWith("integration_id",integration);
    expect(mocks.update).toHaveBeenCalledWith(expect.objectContaining({chatbeds_status:"disconnected"}),integration);
  });
  it("removes local ChatBeds credentials even when remote revocation fails",async()=>{
    mocks.revoke.mockRejectedValue(new Error("mock-secret-provider-body"));const response=await disconnect(request("chatbeds/disconnect"));
    expect(await response.json()).toEqual({ok:true,revoked:false});expect(mocks.delete).toHaveBeenCalledOnce();expect(JSON.stringify(mocks.log.mock.calls)).not.toContain("mock-secret");
  });
  it("does not claim confirmed remote revocation after an uncertain refresh",async()=>{
    mocks.credentials.mockResolvedValue({installation_id:installation,refresh_started:true,access_token_encrypted:encryptToken("cbat_mock-access",`chatbeds:${installation}:access`)});
    expect(await (await disconnect(request("chatbeds/disconnect"))).json()).toEqual({ok:true,revoked:false});
  });
  it("validates a selected installation before issuing an encrypted cookie",async()=>{
    const response=await select(request("integrations/select",{integrationId:integration}));expect(response.status).toBe(200);
    expect(mocks.getIntegration).toHaveBeenCalledExactlyOnceWith(integration);
    expect(decryptToken((response as NextResponse).cookies.get("chatbeds_installation")!.value,"selected-installation")).toBe(integration);
  });
  it("issues no cookie for an unknown installation",async()=>{
    mocks.getIntegration.mockRejectedValue(new AppError("Unknown installation.",404));const response=await select(request("integrations/select",{integrationId:integration}));expect(response.status).toBe(404);expect(response.headers.get("set-cookie")).toBeNull();
  });
});
