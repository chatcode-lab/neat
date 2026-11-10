import { newId } from "./ids";

/** As better-auth is configured in auth.server.ts. */
export const SESSION_SECONDS = 30 * 24 * 3600;

const COOKIE = "better-auth.session_token";

/** Better Auth's session cookie name, which takes a prefix on https. */
export function sessionCookieName(secure: boolean): string {
  return secure ? `__Secure-${COOKIE}` : COOKIE;
}

/** A cookie value signed as better-call signs it: `value.base64(HMAC-SHA256)`, URL-encoded. */
export async function signCookieValue(value: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return encodeURIComponent(`${value}.${btoa(String.fromCharCode(...new Uint8Array(signature)))}`);
}

/**
 * Starts a Better Auth session for an account that proved who it is some
 * other way than Better Auth's providers: by Telegram (Telegram Login, a
 * Mini App launch, or a sign-in link from the bot). The session is an
 * ordinary row in Better Auth's table with its usual signed cookie, so
 * everything else, signing out included, works as for Google.
 *
 * `embedded` is for the Mini App, which Telegram's web clients show in a
 * frame: its cookie must be sent there too, so it is SameSite=None and
 * partitioned by the framing site. Writes stay protected by the Origin check
 * every non-GET request passes.
 */
export async function startSession(
  db: D1Database,
  input: { userId: string; request: Request; secret: string; now: number; embedded?: boolean },
): Promise<string> {
  const token = newId(32);
  const created = new Date(input.now * 1000).toISOString();
  const expires = new Date((input.now + SESSION_SECONDS) * 1000).toISOString();
  await db
    .prepare(
      `INSERT INTO "session" ("id", "expiresAt", "token", "createdAt", "updatedAt", "ipAddress", "userAgent", "userId")
       VALUES (?1, ?2, ?3, ?4, ?4, ?5, ?6, ?7)`,
    )
    .bind(
      newId(),
      expires,
      token,
      created,
      input.request.headers.get("CF-Connecting-IP") ?? "",
      (input.request.headers.get("User-Agent") ?? "").slice(0, 300),
      input.userId,
    )
    .run();
  const secure = new URL(input.request.url).protocol === "https:";
  const parts = [
    `${sessionCookieName(secure)}=${await signCookieValue(token, input.secret)}`,
    `Max-Age=${SESSION_SECONDS}`,
    "Path=/",
    "HttpOnly",
  ];
  if (secure) parts.push("Secure");
  parts.push(input.embedded && secure ? "SameSite=None" : "SameSite=Lax");
  if (input.embedded && secure) parts.push("Partitioned");
  return parts.join("; ");
}
