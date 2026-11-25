import { env } from "cloudflare:workers";

/**
 * Upload links: an address an agent can send a file to without a token, for
 * MCP clients that hold no token of their own to put in a header. A link is
 * signed for one account and lasts 15 minutes; any number of files may be
 * sent to it in that time, each counted against the account's quota.
 */
export const UPLOAD_LINK_SECONDS = 15 * 60;

const encoder = new TextEncoder();

const base64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function sign(payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(`upload-link:${env.BETTER_AUTH_SECRET}`),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return base64url(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(payload))));
}

/** A signed upload address for an account, and when it stops working. */
export async function makeUploadLink(userId: string, now: number, origin: string): Promise<{ url: string; expiresAt: number }> {
  const expiresAt = now + UPLOAD_LINK_SECONDS;
  const payload = `${base64url(encoder.encode(userId))}.${expiresAt}`;
  return { url: `${origin}/api/v1/media/upload/${payload}.${await sign(payload)}`, expiresAt };
}

/** The account an upload link was signed for, while it lasts; null otherwise. */
export async function readUploadLink(token: string, now: number): Promise<string | null> {
  const match = /^([A-Za-z0-9_-]{1,200})\.(\d{1,12})\.([A-Za-z0-9_-]{43})$/.exec(token);
  if (!match) return null;
  const [, user, expires, signature] = match;
  if (Number(expires) < now) return null;
  const expected = await sign(`${user}.${expires}`);
  let difference = expected.length ^ signature!.length;
  for (let index = 0; index < expected.length; index += 1) difference |= expected.charCodeAt(index) ^ (signature!.charCodeAt(index) || 0);
  if (difference !== 0) return null;
  try {
    return new TextDecoder().decode(Uint8Array.from(atob(user!.replace(/-/g, "+").replace(/_/g, "/")), (char) => char.charCodeAt(0)));
  } catch {
    return null;
  }
}
