/** A `Cookie` header that carries a session, whether or not it is still valid. */
export const SESSION_COOKIE_PATTERN = /(?:^|;\s*)(?:__Secure-)?better-auth\.session_token=/;

const COOKIE = "better-auth.session_token";

/**
 * Starts the tokens of sessions begun in the Mini App, so that when Better
 * Auth renews one its cookie keeps the attributes it was first given.
 */
export const EMBEDDED_TOKEN_PREFIX = "mini_";

/** Better Auth's session cookie name, which takes a prefix on https. */
export function sessionCookieName(secure: boolean): string {
  return secure ? `__Secure-${COOKIE}` : COOKIE;
}

/**
 * A cookie Better Auth set while reading a session, as it should reach the
 * browser. Better Auth renews every session cookie as SameSite=Lax; a Mini
 * App session's lives in Telegram's frame, so on https it stays
 * SameSite=None and partitioned, as startSession made it.
 */
export function renewalCookie(setCookie: string): string {
  const [pair = "", ...attributes] = setCookie.split(";").map((part) => part.trim());
  const equals = pair.indexOf("=");
  if (pair.slice(0, equals) !== sessionCookieName(true)) return setCookie;
  let token: string;
  try {
    token = decodeURIComponent(pair.slice(equals + 1)).split(".")[0] ?? "";
  } catch {
    return setCookie;
  }
  if (!token.startsWith(EMBEDDED_TOKEN_PREFIX)) return setCookie;
  const kept = attributes.filter((attribute) => !/^(samesite|partitioned)\b/i.test(attribute));
  return [pair, ...kept, "SameSite=None", "Partitioned"].join("; ");
}
