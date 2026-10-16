import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks=vi.hoisted(()=>({cookies:vi.fn(),rpc:vi.fn(),exchange:vi.fn(),install:vi.fn(),me:vi.fn(),log:vi.fn(),update:vi.fn(),after:vi.fn(),worker:vi.fn()}));
vi.mock("next/headers",()=>({cookies:mocks.cookies}));
vi.mock("next/server",async original=>({...await original<typeof import("next/server")>(),after:mocks.after}));
vi.mock("@/lib/auth/session",async original=>({...await original<typeof import("@/lib/auth/session")>(),requireAdmin:vi.fn()}));
vi.mock("@/lib/db/client",()=>({db:()=>({rpc:mocks.rpc}),checked:(result:{data:unknown})=>result.data}));
vi.mock("@/lib/db/store",()=>({logSync:mocks.log,updateIntegration:mocks.update,withIntegrationLock:(work:()=>Promise<unknown>)=>work()}));
vi.mock("@/lib/chatbeds/oauth",()=>({exchangeChatBedsCode:mocks.exchange}));
vi.mock("@/lib/chatbeds/token-store",()=>({installChatBeds:mocks.install}));
vi.mock("@/lib/chatbeds/credentials",()=>({OAuthCredentialProvider:class {}}));
vi.mock("@/lib/chatbeds/client",()=>({ChatBedsClient:class {me=mocks.me;}}));
vi.mock("@/lib/sync/worker",()=>({safelyProcessJobs:mocks.worker}));
import { GET } from "@/app/api/chatbeds/callback/route";
import { NextResponse } from "next/server";
import { encryptToken,decryptToken } from "@/lib/crypto/tokens";
const property="19306340-c7cf-465a-93d3-0b7873a7e85d",installation="c2205d78-c0e7-4d92-94be-9b91e1ab42aa";
function jar(session="mock-admin-session",expires=Date.now()+60000,googleSetupId?:string){const sealed=encryptToken(JSON.stringify({state:"expected-state",verifier:"mock-verifier",expires,sessionHash:createHash("sha256").update("mock-admin-session").digest("hex"),...(googleSetupId?{googleSetupId}:{})}),"chatbeds-oauth-state");mocks.cookies.mockResolvedValue({get:(name:string)=>({value:name==="chatbeds_app_state"?sealed:session})});}
function request(state="expected-state",extra="code=mock-code"){return new Request(`http://localhost:3000/api/chatbeds/callback?state=${state}&${extra}`);}
beforeEach(()=>{
  vi.resetAllMocks();vi.stubEnv("NEXT_PUBLIC_APP_URL","http://localhost:3000");vi.stubEnv("TOKEN_ENCRYPTION_KEY",Buffer.alloc(32,8).toString("base64"));jar();
  mocks.rpc.mockResolvedValue({data:true});mocks.exchange.mockResolvedValue({property_id:property,installation_id:installation,access_token:"cbat_mock",refresh_token:"cbrt_mock"});mocks.install.mockResolvedValue(installation);mocks.me.mockResolvedValue({property:{id:property,name:"Sandbox Hotel"}});
});
afterEach(()=>vi.unstubAllEnvs());
describe("ChatBeds browser callback security and installation lifecycle",()=>{
  it.each(["wrong-state","test"])("rejects unissued state (%s) before exchange",async state=>{
    expect((await GET(request(state))).headers.get("location")).toContain("chatbeds_state_invalid");expect(mocks.rpc).not.toHaveBeenCalled();expect(mocks.exchange).not.toHaveBeenCalled();
  });
  it("rejects expired state and a changed admin session",async()=>{
    jar("mock-admin-session",Date.now()-1);expect((await GET(request())).headers.get("location")).toContain("chatbeds_state_invalid");
    jar("different-admin-session");expect((await GET(request())).headers.get("location")).toContain("chatbeds_state_invalid");expect(mocks.exchange).not.toHaveBeenCalled();
  });
  it("consumes state once before exchanging a one-use code",async()=>{
    mocks.rpc.mockResolvedValue({data:false});expect((await GET(request())).headers.get("location")).toContain("chatbeds_state_invalid");expect(mocks.exchange).not.toHaveBeenCalled();
  });
  it("handles denial without exchanging or installing credentials",async()=>{
    expect((await GET(request("expected-state","error=access_denied"))).headers.get("location")).toContain("chatbeds_denied");expect(mocks.exchange).not.toHaveBeenCalled();
  });
  it("persists tokens before identity probing and selects only the authorized property",async()=>{
    mocks.me.mockImplementation(async()=>{expect(mocks.install).toHaveBeenCalledOnce();return {property:{id:property,name:"Sandbox Hotel"}};});
    const response=await GET(request());expect(response.headers.get("location")).toContain("chatbeds_connected");
    expect(mocks.exchange).toHaveBeenCalledExactlyOnceWith("mock-code","mock-verifier");
    expect(mocks.update).toHaveBeenCalledWith(expect.objectContaining({property_name:"Sandbox Hotel"}),installation);
    expect(response).toBeInstanceOf(NextResponse);
    expect(decryptToken((response as NextResponse).cookies.get("chatbeds_installation")!.value,"selected-installation")).toBe(installation);
    expect(mocks.after).toHaveBeenCalledOnce();expect(response.headers.get("location")).not.toContain("cbat_");
  });
  it("handles reconnect using the existing integration ID returned by the atomic install",async()=>{
    mocks.install.mockResolvedValue("sandbox");const response=await GET(request());
    expect(mocks.update).toHaveBeenCalledWith(expect.objectContaining({chatbeds_status:"connected"}),"sandbox");
    expect(decryptToken((response as NextResponse).cookies.get("chatbeds_installation")!.value,"selected-installation")).toBe("sandbox");
  });
  it("does not mark a mismatched /me identity as connected",async()=>{
    mocks.me.mockResolvedValue({property:{id:"other-property",name:"Wrong Hotel"}});
    expect((await GET(request())).headers.get("location")).toContain("chatbeds_oauth_failed");
    expect(mocks.log).toHaveBeenCalledWith(expect.objectContaining({success:false}),installation);expect(mocks.after).not.toHaveBeenCalled();
  });
  it("does not expose provider exceptions, codes, or secrets in notices/logs",async()=>{
    mocks.exchange.mockRejectedValue(new Error("cbs_mock-secret cb at mocked-provider-error"));
    const response=await GET(request());expect(response.headers.get("location")).toContain("chatbeds_oauth_failed");expect(JSON.stringify(mocks.log.mock.calls)).not.toContain("cbs_mock-secret");expect(mocks.install).not.toHaveBeenCalled();
  });
  it("completes public Google-first installation atomically and never requests a second Google authorization",async()=>{
    vi.stubEnv("APP_ACCESS_MODE","public");vi.stubEnv("CHATBEDS_AUTH_MODE","oauth");
    const setup="11111111-1111-4111-8111-111111111111";jar("mock-admin-session",Date.now()+60000,setup);
    const response=await GET(request());
    expect(mocks.install).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({property_id:property}),setup);
    expect(response.headers.get("location")).toBe("http://localhost:3000/dashboard?notice=chatbeds_connected");
    expect((response as NextResponse).cookies.get("chatbeds_google_setup")?.value).toBe("");
    expect(mocks.after).toHaveBeenCalledOnce();
  });
  it("requires staged Google authorization for new public installations",async()=>{
    vi.stubEnv("APP_ACCESS_MODE","public");vi.stubEnv("CHATBEDS_AUTH_MODE","oauth");
    expect((await GET(request())).headers.get("location")).toContain("chatbeds_oauth_failed");
    expect(mocks.exchange).not.toHaveBeenCalled();expect(mocks.install).not.toHaveBeenCalled();
  });
  it("does not write a public user's failed setup into another property's fallback log",async()=>{
    vi.stubEnv("APP_ACCESS_MODE","public");vi.stubEnv("CHATBEDS_AUTH_MODE","oauth");
    jar("mock-admin-session",Date.now()+60000,"11111111-1111-4111-8111-111111111111");
    mocks.exchange.mockRejectedValue(new Error("mock-provider-failure"));
    await GET(request());expect(mocks.log).not.toHaveBeenCalled();
  });
});
