import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { authorizationUrl, exchangeChatBedsCode, refreshChatBedsTokens, revokeChatBedsToken } from "@/lib/chatbeds/oauth";
import { ChatBedsClient } from "@/lib/chatbeds/client";
import { chatbedsOAuthReadiness, configurationReadiness, missingVariables } from "@/lib/config";
import { reservation } from "./fixtures";
const tokens = { access_token: "cbat_mock-access", refresh_token: "cbrt_mock-refresh", token_type: "Bearer", expires_in: 3600, scope: "reservations:read", property_id: reservation.property_id, installation_id: "c2205d78-c0e7-4d92-94be-9b91e1ab42aa" };
beforeEach(() => {
  vi.stubEnv("CHATBEDS_AUTH_MODE", "oauth"); vi.stubEnv("CHATBEDS_CLIENT_ID", "cba_mock-client"); vi.stubEnv("CHATBEDS_CLIENT_SECRET", "cbs_mock-secret");
  vi.stubEnv("CHATBEDS_REDIRECT_URI", "https://integration.example/api/chatbeds/callback");
  vi.stubEnv("CHATBEDS_OAUTH_AUTHORIZE_URL", "https://mock-chatbeds.invalid/oauth/authorize");
  vi.stubEnv("CHATBEDS_OAUTH_TOKEN_URL", "https://mock-chatbeds.invalid/oauth/token"); vi.stubEnv("CHATBEDS_OAUTH_REVOKE_URL", "https://mock-chatbeds.invalid/oauth/revoke");
  vi.stubEnv("CHATBEDS_API_BASE_URL", "https://mock-chatbeds.invalid/partner/v1");
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
describe("official ChatBeds App OAuth wire protocol", () => {
  it("requests only reservations:read and uses state and PKCE S256", () => {
    const verifier = "mock-verifier-43-characters-minimum-long-for-test";
    const url = authorizationUrl("mock-state",verifier);
    expect(url.origin).toBe("https://mock-chatbeds.invalid");
    expect(Object.fromEntries(url.searchParams)).toEqual({ response_type: "code",client_id:"cba_mock-client",redirect_uri:"https://integration.example/api/chatbeds/callback",scope:"reservations:read",state:"mock-state",code_challenge:createHash("sha256").update(verifier).digest("base64url"),code_challenge_method:"S256" });
    expect(url.toString()).not.toContain("cbs_mock-secret");
  });
  it("exchanges an authorization code using client_secret_post and the exact callback", async () => {
    const http = vi.fn().mockResolvedValue(Response.json(tokens)); vi.stubGlobal("fetch",http);
    expect(await exchangeChatBedsCode("mock-code","mock-verifier")).toEqual(tokens);
    const [url, request] = http.mock.calls[0];
    expect(url.toString()).toBe("https://mock-chatbeds.invalid/oauth/token");
    expect(request.method).toBe("POST");
    expect(Object.fromEntries(request.body)).toEqual({ grant_type:"authorization_code",code:"mock-code",code_verifier:"mock-verifier",redirect_uri:"https://integration.example/api/chatbeds/callback",client_id:"cba_mock-client",client_secret:"cbs_mock-secret" });
  });
  it("refreshes once with the documented rotating refresh grant", async () => {
    const http = vi.fn().mockResolvedValue(Response.json(tokens)); vi.stubGlobal("fetch",http);
    await refreshChatBedsTokens("cbrt_mock-old");
    expect(http).toHaveBeenCalledTimes(1);
    expect(Object.fromEntries(http.mock.calls[0][1].body)).toEqual({grant_type:"refresh_token",refresh_token:"cbrt_mock-old",client_id:"cba_mock-client",client_secret:"cbs_mock-secret"});
  });
  it("rejects missing reservations permission rather than assuming it", async () => {
    vi.stubGlobal("fetch",vi.fn().mockResolvedValue(Response.json({...tokens,scope:"rooms:read"})));
    await expect(exchangeChatBedsCode("mock-code","mock-verifier")).rejects.toThrow("reservations:read");
  });
  it("sanitizes OAuth errors and never retries an uncertain refresh result", async () => {
    const http = vi.fn().mockRejectedValue(new Error("mock-provider-secret-body")); vi.stubGlobal("fetch",http);
    await expect(refreshChatBedsTokens("cbrt_mock-old")).rejects.toThrow("could not be completed"); expect(http).toHaveBeenCalledTimes(1);
    http.mockResolvedValue(Response.json({error:"invalid_grant",error_description:"mock-provider-secret-body"},{status:400}));
    await expect(refreshChatBedsTokens("cbrt_mock-old")).rejects.toThrow("Reconnect this property");
  });
  it("honors OAuth Retry-After instead of retrying immediately", async () => {
    const http = vi.fn().mockResolvedValue(Response.json({error:"slow_down"},{status:429,headers:{"Retry-After":"23"}}));vi.stubGlobal("fetch",http);
    await expect(refreshChatBedsTokens("cbrt_mock-old")).rejects.toMatchObject({retryAfter:23});expect(http).toHaveBeenCalledTimes(1);
  });
  it("revokes using a server-side form body with no token in the URL", async () => {
    const http = vi.fn().mockResolvedValue(new Response(null,{status:200}));vi.stubGlobal("fetch",http);
    await revokeChatBedsToken("cbat_mock-access");
    expect(http.mock.calls[0][0].toString()).toBe("https://mock-chatbeds.invalid/oauth/revoke");
    expect(Object.fromEntries(http.mock.calls[0][1].body)).toEqual({token:"cbat_mock-access",client_id:"cba_mock-client",client_secret:"cbs_mock-secret"});
  });
  it("retries a safe API read once after 401 with the refreshed token", async () => {
    const http = vi.fn().mockResolvedValueOnce(new Response(null,{status:401})).mockResolvedValueOnce(Response.json({property:{id:reservation.property_id,name:"Sandbox Hotel"}}));vi.stubGlobal("fetch",http);
    const refresh = vi.fn().mockResolvedValue("cbat_mock-new");
    await new ChatBedsClient({getAccessCredential:async()=>"cbat_mock-old",onUnauthorized:refresh}).me();
    expect(refresh).toHaveBeenCalledExactlyOnceWith("cbat_mock-old"); expect(http.mock.calls[1][1].headers.Authorization).toBe("Bearer cbat_mock-new");
  });
  it("marks connection disconnected when refreshed API access is still rejected", async () => {
    vi.stubGlobal("fetch",vi.fn().mockResolvedValue(new Response(null,{status:401})));
    const rejected = vi.fn();
    await expect(new ChatBedsClient({getAccessCredential:async()=>"cbat_mock-old",onUnauthorized:async()=>"cbat_mock-new",onRejected:rejected}).me()).rejects.toThrow("revoked"); expect(rejected).toHaveBeenCalledOnce();
  });
  it("makes API key optional in OAuth mode and keeps webhook configuration independent", () => {
    vi.stubEnv("CHATBEDS_API_KEY","");
    expect(missingVariables()).not.toContain("CHATBEDS_API_KEY");
    expect(configurationReadiness(["CHATBEDS_WEBHOOK_SECRET","CRON_SECRET"])).toEqual({googleReady:true,syncReady:true});
    expect(configurationReadiness(["CHATBEDS_CLIENT_SECRET"])).toEqual({googleReady:true,syncReady:false});
  });
  it("allows ChatBeds consent before Google and webhook setup are finished",()=>{
    expect(chatbedsOAuthReadiness(["GOOGLE_CLIENT_ID","GOOGLE_CLIENT_SECRET","CHATBEDS_WEBHOOK_SECRET","CRON_SECRET"])).toBe(true);
    expect(chatbedsOAuthReadiness(["CHATBEDS_CLIENT_SECRET"])).toBe(false);
  });
});
