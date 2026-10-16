import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ cookies: vi.fn(), rpc: vi.fn(), from: vi.fn(), insert: vi.fn(), getToken: vi.fn(), verifyIdToken: vi.fn(), signInWithIdToken: vi.fn(), generateAuthUrl: vi.fn(), getUser: vi.fn() }));
vi.mock("next/headers", () => ({ cookies: mocks.cookies }));
vi.mock("@/lib/db/client", async original => ({ ...await original<typeof import("@/lib/db/client")>(), db: () => ({ from: mocks.from, rpc: mocks.rpc }) }));
vi.mock("@/lib/auth/hotel-client", () => ({ hotelAuthClient: async () => ({ auth: { signInWithIdToken: mocks.signInWithIdToken, getUser: mocks.getUser } }) }));
vi.mock("@/lib/db/store", () => ({ withIntegrationLock: (work: () => Promise<unknown>) => work() }));
vi.mock("@/lib/google/grant-lock", () => ({ withGoogleGrantLock: (work: () => Promise<unknown>) => work() }));
vi.mock("@/lib/google/oauth", () => ({ GOOGLE_SCOPES: ["openid","email","https://www.googleapis.com/auth/calendar.events"], oauthClient: () => ({ generateCodeVerifierAsync: async () => ({ codeVerifier: "mock-verifier", codeChallenge: "mock-challenge" }), generateAuthUrl: mocks.generateAuthUrl, getToken: mocks.getToken, verifyIdToken: mocks.verifyIdToken }) }));
import { beginGoogleSignIn, finishGoogleSignIn, type GoogleSignInState } from "@/lib/auth/google-signin";
import { currentGoogleSetup, sealGoogleSetup } from "@/lib/google/onboarding";
import { decryptToken, encryptToken } from "@/lib/crypto/tokens";
import { createHotelSession, validHotelSession } from "@/lib/auth/session";
import { POST as start } from "@/app/api/auth/google/route";
const userId = "11111111-1111-4111-8111-111111111111", setupId = "22222222-2222-4222-8222-222222222222";
const scope = "openid email https://www.googleapis.com/auth/calendar.events";
let state: GoogleSignInState, ids: string[], target: {id: string} | null, prior: {refresh_token_encrypted: string} | null, cookieValues: Record<string,string>, staged: {id:string;valid_until:string} | null;
beforeEach(() => {
  vi.resetAllMocks(); vi.stubEnv("APP_ACCESS_MODE","public"); vi.stubEnv("CHATBEDS_AUTH_MODE","oauth");
  vi.stubEnv("NEXT_PUBLIC_APP_URL","https://integration.example"); vi.stubEnv("GOOGLE_CLIENT_ID","mock-client");
  vi.stubEnv("TOKEN_ENCRYPTION_KEY",Buffer.alloc(32,8).toString("base64")); vi.stubEnv("SESSION_SECRET","mock-session-secret-more-than-thirty-two-characters");
  state = { intent:"signin",action:"install",state:"issued-state",verifier:"mock-verifier",nonce:"mock-nonce",expires:Date.now()+60000 };
  ids=[]; target=null; prior=null; cookieValues={}; staged=null;
  mocks.cookies.mockImplementation(async () => ({ get: (name:string) => cookieValues[name] ? {value:cookieValues[name]} : undefined }));
  mocks.rpc.mockResolvedValue({data:true,error:null}); mocks.insert.mockResolvedValue({data:null,error:null});
  mocks.generateAuthUrl.mockReturnValue("https://accounts.google.com/mock-authorize");
  mocks.getToken.mockResolvedValue({tokens:{id_token:"mock-google-id-token",access_token:"mock-google-access",refresh_token:"mock-google-refresh",expiry_date:Date.now()+3600000,scope}});
  mocks.verifyIdToken.mockResolvedValue({getPayload:() => ({sub:"google-sub",email:"hotel@example.com",email_verified:true,nonce:createHash("sha256").update(state.nonce).digest("hex")})});
  mocks.signInWithIdToken.mockResolvedValue({data:{user:{id:userId,email_confirmed_at:"2026-10-15"},session:{}},error:null});
  mocks.getUser.mockResolvedValue({data:{user:{id:userId,email_confirmed_at:"2026-10-15"}},error:null});
  mocks.from.mockImplementation((table:string) => {
    const query = { select:vi.fn(() => query), eq:vi.fn(() => query), in:vi.fn(() => query), not:vi.fn(() => query), order:vi.fn(() => query), limit:vi.fn(() => query), insert:mocks.insert,
      maybeSingle:vi.fn(async () => ({data:table==="google_credentials"?prior:table==="google_onboarding"?staged:target,error:null})),
      then:(resolve:(value:unknown)=>unknown) => Promise.resolve({data:ids.map(integration_id=>({integration_id})),error:null}).then(resolve) };
    return query;
  });
});
afterEach(() => vi.unstubAllEnvs());
function callback(value="issued-state",extra="code=mock-code") { return new Request(`https://integration.example/api/google/callback?state=${value}&${extra}`); }
describe("One Google consent for hotel sign-in and Calendar", () => {
  it("requests identity and Calendar together with offline access, PKCE, nonce and one-use state", async () => {
    const response=await beginGoogleSignIn("install"); const options=mocks.generateAuthUrl.mock.calls[0][0];
    expect(options).toMatchObject({access_type:"offline",prompt:"select_account consent",scope:["openid","email","https://www.googleapis.com/auth/calendar.events"],code_challenge:"mock-challenge",code_challenge_method:"S256"});
    const stored=JSON.parse(decryptToken(response.cookies.get("chatbeds_google_state")!.value,"oauth-state"));
    expect(stored).toMatchObject({intent:"signin",action:"install",verifier:"mock-verifier"});
    expect(options.nonce).toBe(createHash("sha256").update(stored.nonce).digest("hex"));
    expect(mocks.insert).toHaveBeenCalledWith(expect.objectContaining({state_hash:createHash("sha256").update(stored.state).digest("hex")}));
  });
  it("uses the SAME code for verified sign-in and encrypted Calendar credentials", async () => {
    const response=await finishGoogleSignIn(callback(),state);
    expect(mocks.getToken).toHaveBeenCalledExactlyOnceWith({code:"mock-code",codeVerifier:"mock-verifier"});
    expect(mocks.verifyIdToken).toHaveBeenCalledWith({idToken:"mock-google-id-token",audience:"mock-client"});
    expect(mocks.signInWithIdToken).toHaveBeenCalledExactlyOnceWith({provider:"google",token:"mock-google-id-token",nonce:"mock-nonce"});
    const row=mocks.insert.mock.calls[0][0];
    expect(row).toMatchObject({user_id:userId,account_sub:"google-sub",account_email:"hotel@example.com",calendar_id:"primary"});
    expect(decryptToken(row.access_token_encrypted,"google-sub:access")).toBe("mock-google-access");
    expect(decryptToken(row.refresh_token_encrypted,"google-sub:refresh")).toBe("mock-google-refresh");
    expect(response.headers.get("location")).toBe("https://integration.example/api/chatbeds/install");
    expect(response.headers.get("location")).not.toContain("token");
    expect(validHotelSession(response.cookies.get("chatbeds_admin")!.value,userId)).toBe(true);
    const setup=JSON.parse(decryptToken(response.cookies.get("chatbeds_google_setup")!.value,"google-onboarding"));
    expect(setup).toMatchObject({id:row.id,userId});
    expect(response.headers.get("set-cookie")).not.toContain("mock-google-access");
  });
  it("consumes browser state before token exchange", async () => {
    mocks.getToken.mockImplementation(async () => { expect(mocks.rpc).toHaveBeenCalledWith("consume_oauth_state",expect.anything()); throw new Error("mock stop"); });
    await finishGoogleSignIn(callback(),state); expect(mocks.getToken).toHaveBeenCalledOnce();
  });
  it("rejects wrong, expired and replayed state without calling Google", async () => {
    expect((await finishGoogleSignIn(callback("wrong"),state)).headers.get("location")).toContain("google_state_invalid");
    state.expires=Date.now()-1; await finishGoogleSignIn(callback(),state);
    state.expires=Date.now()+60000; mocks.rpc.mockResolvedValue({data:false,error:null}); await finishGoogleSignIn(callback(),state);
    expect(mocks.getToken).not.toHaveBeenCalled();
  });
  it("handles denial without creating an account or storing Calendar tokens", async () => {
    expect((await finishGoogleSignIn(callback("issued-state","error=access_denied"),state)).headers.get("location")).toContain("google_denied");
    expect(mocks.getToken).not.toHaveBeenCalled(); expect(mocks.signInWithIdToken).not.toHaveBeenCalled(); expect(mocks.insert).not.toHaveBeenCalled();
  });
  it.each([{email_verified:false,nonce:"correct"},{email_verified:true,nonce:"wrong"}])("rejects unverified email or wrong OIDC nonce", async override => {
    mocks.verifyIdToken.mockResolvedValue({getPayload:() => ({sub:"google-sub",email:"hotel@example.com",email_verified:override.email_verified,nonce:override.nonce==="correct"?createHash("sha256").update(state.nonce).digest("hex"):"wrong"})});
    expect((await finishGoogleSignIn(callback(),state)).headers.get("location")).toContain("google_signin_failed");
    expect(mocks.signInWithIdToken).not.toHaveBeenCalled(); expect(mocks.insert).not.toHaveBeenCalled();
  });
  it("does not sign in or pretend Calendar is connected when permission is unchecked", async () => {
    mocks.getToken.mockResolvedValue({tokens:{id_token:"mock-id",access_token:"mock-access",refresh_token:"mock-refresh",expiry_date:Date.now()+3600000,scope:"openid email"}});
    expect((await finishGoogleSignIn(callback(),state)).headers.get("location")).toContain("google_permission_missing");
    expect(mocks.signInWithIdToken).not.toHaveBeenCalled(); expect(mocks.insert).not.toHaveBeenCalled();
  });
  it("requires offline access and preserves only the same owner's matching account refresh token", async () => {
    mocks.getToken.mockResolvedValue({tokens:{id_token:"mock-id",access_token:"mock-access",expiry_date:Date.now()+3600000,scope}});
    expect((await finishGoogleSignIn(callback(),state)).headers.get("location")).toContain("google_offline_missing"); expect(mocks.insert).not.toHaveBeenCalled();
    ids=["owned-property"]; prior={refresh_token_encrypted:encryptToken("previous-refresh","google-sub:refresh")};
    expect((await finishGoogleSignIn(callback(),state)).headers.get("location")).toContain("/api/chatbeds/install");
    const query=mocks.from.mock.results.find((_,i)=>mocks.from.mock.calls[i][0]==="google_credentials")!.value;
    expect(query.in).toHaveBeenCalledWith("integration_id",["owned-property"]); expect(query.eq).toHaveBeenCalledWith("account_sub","google-sub");
    expect(mocks.insert.mock.calls[0][0].refresh_token_encrypted).toBe(prior.refresh_token_encrypted);
  });
  it("reconnects returning users' owned Calendar without another Google screen", async () => {
    state.action="signin"; ids=["owned-property"]; target={id:"owned-property"};
    const response=await finishGoogleSignIn(callback(),state);
    expect(response.headers.get("location")).toBe("https://integration.example/dashboard?notice=connected");
    expect(mocks.rpc).toHaveBeenCalledWith("attach_hotel_google",expect.objectContaining({p_user_id:userId,p_integration_id:"owned-property"}));
    expect(mocks.getToken).toHaveBeenCalledOnce(); expect(response.cookies.get("chatbeds_google_setup")?.value).toBe("");
  });
  it("continues to ChatBeds for an explicit new installation even when the owner has other properties", async () => {
    ids=["owned-property"]; target={id:"owned-property"};
    expect((await finishGoogleSignIn(callback(),state)).headers.get("location")).toContain("/api/chatbeds/install");
    expect(mocks.rpc.mock.calls.some(call=>call[0]==="attach_hotel_google")).toBe(false);
  });
  it("sanitizes provider failures and issues no local login nonce on failure", async () => {
    mocks.signInWithIdToken.mockResolvedValue({data:{user:null,session:null},error:{message:"mock-secret-provider-body"}});
    const response=await finishGoogleSignIn(callback(),state);
    expect(response.headers.get("location")).toContain("google_signin_failed"); expect(response.headers.get("location")).not.toContain("mock-secret");
    expect(response.cookies.get("chatbeds_admin")).toBeUndefined(); expect(mocks.insert).not.toHaveBeenCalled();
  });
  it("requires POST origin before starting Google authorization", async () => {
    const response=await start(new Request("https://integration.example/api/auth/google",{method:"POST",headers:{origin:"https://attacker.example"},body:new URLSearchParams({intent:"install"})}));
    expect(response.status).toBe(403); expect(mocks.generateAuthUrl).not.toHaveBeenCalled();
  });
  it("binds staged credentials to a verified user and rejects expired or forged setups", async () => {
    const expires=Date.now()+60000; cookieValues.chatbeds_admin=createHotelSession(userId);
    cookieValues.chatbeds_google_setup=sealGoogleSetup(setupId,userId,expires); staged={id:setupId,valid_until:new Date(expires).toISOString()};
    expect(await currentGoogleSetup()).toBe(setupId);
    cookieValues.chatbeds_google_setup=sealGoogleSetup(setupId,"another-user",expires); expect(await currentGoogleSetup()).toBeNull();
    cookieValues.chatbeds_google_setup=sealGoogleSetup(setupId,userId,Date.now()-1); expect(await currentGoogleSetup()).toBeNull();
    cookieValues.chatbeds_google_setup="tampered"; expect(await currentGoogleSetup()).toBeNull();
  });
});
