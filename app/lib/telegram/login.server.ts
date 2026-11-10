import { env } from "cloudflare:workers";
import { createRemoteJWKSet } from "jose";

import {
  TELEGRAM_JWKS_URL,
  TELEGRAM_TOKEN_URL,
  authorizationUrl,
  loginStateCookie,
  pkceChallenge,
  randomToken,
  readLoginState,
  sameState,
  verifyIdToken,
} from "./login";
import { botId } from "./signin.server";
import type { TelegramUser } from "./verify";

/** Telegram's signing keys, fetched when first needed and kept by this isolate. */
const telegramKeys = createRemoteJWKSet(new URL(TELEGRAM_JWKS_URL), { timeoutDuration: 5000 });

/** Where Telegram sends people back; BotFather's allowed URLs must list it. */
export function telegramCallbackUrl(origin: string): string {
  return `${origin}/auth/telegram/callback`;
}

/** Sends the browser to Telegram to sign in, keeping the state and PKCE verifier in a cookie. */
export async function startTelegramLogin(url: URL, next: string): Promise<Response> {
  const state = randomToken();
  const verifier = randomToken();
  const location = authorizationUrl({
    clientId: botId(),
    redirectUri: telegramCallbackUrl(url.origin),
    state,
    challenge: await pkceChallenge(verifier),
  });
  const headers = new Headers({ Location: location, "Cache-Control": "no-store" });
  headers.append("Set-Cookie", loginStateCookie({ state, verifier, next }, url.protocol === "https:"));
  return new Response(null, { status: 302, headers });
}

export type TelegramLoginResult =
  | { ok: true; user: TelegramUser; next: string }
  | { ok: false; error: "access_denied" | "state_mismatch" | "telegram_failed"; next: string };

/**
 * Telegram's answer at the callback: checks the state against the cookie,
 * exchanges the code (with the bot's client secret and the PKCE verifier)
 * and verifies the ID token it brings.
 */
export async function finishTelegramLogin(request: Request, url: URL): Promise<TelegramLoginResult> {
  const kept = readLoginState(request.headers.get("Cookie"), url.protocol === "https:");
  const next = kept?.next ?? "/app";
  if (url.searchParams.get("error")) return { ok: false, error: "access_denied", next };
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state") ?? "";
  if (!kept || !code || !sameState(state, kept.state)) return { ok: false, error: "state_mismatch", next };

  const clientId = botId();
  let idToken: unknown;
  try {
    const response = await fetch(TELEGRAM_TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
        Authorization: `Basic ${btoa(`${clientId}:${env.TELEGRAM_CLIENT_SECRET}`)}`,
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: telegramCallbackUrl(url.origin),
        client_id: clientId,
        code_verifier: kept.verifier,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      console.warn("telegram login: token exchange failed", response.status);
      return { ok: false, error: "telegram_failed", next };
    }
    idToken = ((await response.json()) as { id_token?: unknown }).id_token;
  } catch (error) {
    console.warn("telegram login: token exchange failed", error instanceof Error ? error.name : "unknown");
    return { ok: false, error: "telegram_failed", next };
  }
  if (typeof idToken !== "string") return { ok: false, error: "telegram_failed", next };
  const user = await verifyIdToken(idToken, { clientId, keys: telegramKeys });
  if (!user) {
    console.warn("telegram login: ID token not accepted");
    return { ok: false, error: "telegram_failed", next };
  }
  return { ok: true, user, next };
}
