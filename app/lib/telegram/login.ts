import { type JWTPayload, type JWTVerifyGetKey, jwtVerify } from "jose";

import type { TelegramUser } from "./verify";

/**
 * Telegram Login (https://core.telegram.org/bots/telegram-login): OpenID
 * Connect's authorization code flow with PKCE at oauth.telegram.org. The
 * client is the bot: its ID is the client ID and BotFather shows its client
 * secret (the bot's mini app → Login Widget), along with the allowed URLs,
 * which must include this site's origin and its callback address.
 *
 * Telegram signs an ID token with the person's Telegram ID, name, username
 * and picture; there is no UserInfo endpoint.
 */
export const TELEGRAM_ISSUER = "https://oauth.telegram.org";
export const TELEGRAM_AUTHORIZE_URL = `${TELEGRAM_ISSUER}/auth`;
export const TELEGRAM_TOKEN_URL = `${TELEGRAM_ISSUER}/token`;
export const TELEGRAM_JWKS_URL = `${TELEGRAM_ISSUER}/.well-known/jwks.json`;

/** `profile` brings the Telegram ID, name, username and picture; nothing else is asked for. */
export const TELEGRAM_SCOPE = "openid profile";

/** The algorithms that carry `profile` claims (BotFather's default is RS256). */
const ALGORITHMS = ["RS256", "ES256"];

/** How long a started sign-in may take before its state is forgotten. */
export const LOGIN_STATE_SECONDS = 10 * 60;

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** 32 random bytes, base64url: a state value or a PKCE verifier. */
export function randomToken(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

/** The PKCE S256 challenge of a verifier. */
export async function pkceChallenge(verifier: string): Promise<string> {
  return base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
}

export function authorizationUrl(input: { clientId: string; redirectUri: string; state: string; challenge: string }): string {
  const url = new URL(TELEGRAM_AUTHORIZE_URL);
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", TELEGRAM_SCOPE);
  url.searchParams.set("state", input.state);
  url.searchParams.set("code_challenge", input.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  // Spaces as %20, as Telegram's own example writes the scope.
  return url.href.replace(/\+/g, "%20");
}

/** What the browser keeps between leaving for Telegram and coming back. */
export interface LoginState {
  state: string;
  verifier: string;
  next: string;
}

const STATE_COOKIE = "neat_tg_login";

/** `__Host-` on https, so no other site or subdomain can set it. */
export function loginStateCookieName(secure: boolean): string {
  return secure ? `__Host-${STATE_COOKIE}` : STATE_COOKIE;
}

/**
 * The state cookie. SameSite=Lax is sent on the top-level redirect back from
 * Telegram; it needs no signature, because it only has to match what comes
 * back, and only this site can set it.
 */
export function loginStateCookie(value: LoginState | null, secure: boolean): string {
  const content = value ? `${value.state}.${value.verifier}.${encodeURIComponent(value.next)}` : "";
  const parts = [
    `${loginStateCookieName(secure)}=${content}`,
    `Max-Age=${value ? LOGIN_STATE_SECONDS : 0}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

const TOKEN = /^[A-Za-z0-9_-]{43}$/;

export function readLoginState(cookieHeader: string | null, secure: boolean): LoginState | null {
  const name = loginStateCookieName(secure);
  for (const pair of (cookieHeader ?? "").split(";")) {
    const [key, ...rest] = pair.trim().split("=");
    if (key !== name) continue;
    const [state, verifier, ...next] = rest.join("=").split(".");
    if (!state || !verifier || !TOKEN.test(state) || !TOKEN.test(verifier)) return null;
    try {
      return { state, verifier, next: decodeURIComponent(next.join(".")) || "/app" };
    } catch {
      return null;
    }
  }
  return null;
}

/** Compares a returned state with the kept one in constant time. */
export function sameState(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) difference |= a.charCodeAt(index) ^ b.charCodeAt(index);
  return difference === 0;
}

const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : null);

/** The Telegram user an ID token's claims name, or null without a usable Telegram ID. */
export function telegramUserFromClaims(claims: JWTPayload): TelegramUser | null {
  const id = typeof claims.id === "number" ? claims.id : Number(text(claims.id));
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  const given = text(claims.given_name);
  const name = text(claims.name);
  return {
    id,
    firstName: given ?? name ?? "",
    lastName: given ? text(claims.family_name) : null,
    username: text(claims.preferred_username),
    photoUrl: text(claims.picture),
  };
}

/**
 * Checks an ID token as Telegram says to: its signature by a key from the
 * JWKS, `iss`, `aud` (the bot's ID) and `exp`. Null when any check fails.
 */
export async function verifyIdToken(
  idToken: string,
  input: { clientId: string; keys: JWTVerifyGetKey; now?: number },
): Promise<TelegramUser | null> {
  try {
    const { payload } = await jwtVerify(idToken, input.keys, {
      issuer: TELEGRAM_ISSUER,
      audience: input.clientId,
      algorithms: ALGORITHMS,
      requiredClaims: ["exp", "iat"],
      clockTolerance: 60,
      currentDate: input.now === undefined ? undefined : new Date(input.now * 1000),
    });
    return telegramUserFromClaims(payload);
  } catch {
    return null;
  }
}
