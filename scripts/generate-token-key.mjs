// 产生第 2 级接入用的 ES256 签名金钥
// 用法：node scripts/generate-token-key.mjs
// 把输出设成 Edge Function secret：npx supabase secrets set GW_TOKEN_PRIVATE_JWK='<输出>'
import { exportJWK, generateKeyPair } from "jose";

const { privateKey } = await generateKeyPair("ES256", { extractable: true });
const jwk = await exportJWK(privateKey);
jwk.kid = `gw-${new Date().toISOString().slice(0, 10)}`;
jwk.alg = "ES256";
console.log(JSON.stringify(jwk));
