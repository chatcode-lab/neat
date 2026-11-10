import { createHash } from "node:crypto";

import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from "jose";
import { describe, expect, it } from "vitest";

import {
  TELEGRAM_ISSUER,
  authorizationUrl,
  loginStateCookie,
  pkceChallenge,
  randomToken,
  readLoginState,
  verifyIdToken,
} from "./login";

const BOT_ID = "123456";
const NOW = 1_800_000_000;

async function signer(alg: "RS256" | "ES256" = "RS256") {
  const { privateKey, publicKey } = await generateKeyPair(alg, { extractable: true });
  const jwk = { ...(await exportJWK(publicKey)), kid: "test-1", alg };
  const keys = createLocalJWKSet({ keys: [jwk] });
  const sign = (claims: Record<string, unknown>, header: { iss?: string; aud?: string; exp?: number } = {}) =>
    new SignJWT(claims)
      .setProtectedHeader({ alg, kid: "test-1" })
      .setIssuer(header.iss ?? TELEGRAM_ISSUER)
      .setAudience(header.aud ?? BOT_ID)
      .setSubject("abc")
      .setIssuedAt(NOW - 5)
      .setExpirationTime(header.exp ?? NOW + 3600)
      .sign(privateKey);
  return { keys, sign };
}

describe("Telegram Login ID tokens", () => {
  it("reads the Telegram user from a genuine token", async () => {
    const { keys, sign } = await signer();
    const token = await sign({ id: 1234567, name: "Ada L", given_name: "Ada", family_name: "L", preferred_username: "ada_l", picture: "https://t.me/i/userpic/ada.jpg" });
    expect(await verifyIdToken(token, { clientId: BOT_ID, keys, now: NOW })).toEqual({
      id: 1234567,
      firstName: "Ada",
      lastName: "L",
      username: "ada_l",
      photoUrl: "https://t.me/i/userpic/ada.jpg",
    });
  });

  it("falls back to the full name and accepts ES256", async () => {
    const { keys, sign } = await signer("ES256");
    const token = await sign({ id: 7, name: "Grace" });
    expect(await verifyIdToken(token, { clientId: BOT_ID, keys, now: NOW })).toMatchObject({ id: 7, firstName: "Grace", lastName: null, username: null });
  });

  it("refuses another bot's, another issuer's, expired, foreign or ID-less tokens", async () => {
    const { keys, sign } = await signer();
    const other = await signer();
    const claims = { id: 7, name: "A" };
    expect(await verifyIdToken(await sign(claims, { aud: "999" }), { clientId: BOT_ID, keys, now: NOW })).toBeNull();
    expect(await verifyIdToken(await sign(claims, { iss: "https://example.com" }), { clientId: BOT_ID, keys, now: NOW })).toBeNull();
    expect(await verifyIdToken(await sign(claims, { exp: NOW - 120 }), { clientId: BOT_ID, keys, now: NOW })).toBeNull();
    expect(await verifyIdToken(await other.sign(claims), { clientId: BOT_ID, keys, now: NOW })).toBeNull();
    expect(await verifyIdToken(await sign({ name: "A" }), { clientId: BOT_ID, keys, now: NOW })).toBeNull();
    expect(await verifyIdToken("not.a.token", { clientId: BOT_ID, keys, now: NOW })).toBeNull();
  });
});

describe("Telegram Login state", () => {
  it("asks for the code flow with PKCE", async () => {
    const verifier = randomToken();
    const url = new URL(authorizationUrl({ clientId: BOT_ID, redirectUri: "https://neat.link/auth/telegram/callback", state: "s", challenge: await pkceChallenge(verifier) }));
    expect(url.origin + url.pathname).toBe("https://oauth.telegram.org/auth");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      client_id: BOT_ID,
      response_type: "code",
      scope: "openid profile",
      code_challenge_method: "S256",
    });
    // S256: base64url(SHA-256(verifier)), unpadded.
    expect(url.searchParams.get("code_challenge")).toBe(createHash("sha256").update(verifier).digest("base64url"));
  });

  it("keeps the state, verifier and return path in a cookie", () => {
    const value = { state: randomToken(), verifier: randomToken(), next: "/app/sites/ada.love?x=1" };
    const cookie = loginStateCookie(value, true);
    expect(cookie).toMatch(/^__Host-neat_tg_login=.*; Max-Age=600; Path=\/; HttpOnly; SameSite=Lax; Secure$/);
    const header = `theme=dark; ${cookie.split(";")[0]}`;
    expect(readLoginState(header, true)).toEqual(value);
    expect(readLoginState(header, false)).toBeNull();
    expect(readLoginState("__Host-neat_tg_login=short.bad.x", true)).toBeNull();
    expect(loginStateCookie(null, false)).toMatch(/^neat_tg_login=; Max-Age=0;/);
  });
});
