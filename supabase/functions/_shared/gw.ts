// Gateway Edge Functions 共用工具
import { createClient } from "npm:@supabase/supabase-js@2";
import { importJWK, type JWK } from "npm:jose@5";

export const TOKEN_ISSUER = "mjm-gateway";
export const TOKEN_TTL_SECONDS = 60;

export const corsHeaders = {
  "Access-Control-Allow-Origin": Deno.env.get("GW_ALLOWED_ORIGIN") ?? "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-gw-api-key",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

export function serviceClient() {
  return createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false },
  });
}

export function userClient(authorization: string) {
  return createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false },
  });
}

// ES256 私钥（JWK JSON）存在 Edge Function secret：GW_TOKEN_PRIVATE_JWK
function privateJwk(): JWK & { kid: string } {
  const raw = Deno.env.get("GW_TOKEN_PRIVATE_JWK");
  if (!raw) throw new Error("GW_TOKEN_PRIVATE_JWK is not set");
  const jwk = JSON.parse(raw);
  if (!jwk.kid) throw new Error("GW_TOKEN_PRIVATE_JWK must include kid");
  return jwk;
}

export async function signingKey() {
  const jwk = privateJwk();
  return { kid: jwk.kid, key: await importJWK(jwk, "ES256") };
}

// 公钥 = 私钥 JWK 去掉 d
export function publicJwk(): JWK {
  const { kty, crv, x, y, kid } = privateJwk();
  return { kty, crv, x, y, kid, alg: "ES256", use: "sig" };
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}
