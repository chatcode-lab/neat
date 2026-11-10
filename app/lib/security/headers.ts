import { HANDLE_PATTERN, RESERVED_HANDLES } from "../handles";
import { buildSitePolicy } from "./csp";

export interface SecurityHeaderOptions {
  nonce: string;
  /** True on the Vite dev server. */
  dev: boolean;
  /** False everywhere except production, where pages may be indexed. */
  indexable: boolean;
  /** The media bucket's own domain, when it has one. */
  mediaOrigin?: string;
}

/**
 * What Telegram's web clients may show in a frame, as a Mini App: its entry,
 * the editor, and the public pages it opens. Everything else, sign-in and
 * OAuth consent above all, refuses to be framed.
 */
export function isFrameablePath(pathname: string): boolean {
  if (pathname === "/tg" || pathname === "/app" || pathname.startsWith("/app/")) return true;
  const handle = /^\/([a-z0-9_]+)$/.exec(pathname)?.[1];
  return Boolean(handle && HANDLE_PATTERN.test(handle) && !RESERVED_HANDLES.has(handle));
}

/**
 * Applies the security baseline to a response. Every response gets the site
 * policy, replacing anything a route set itself.
 */
export function withSecurityHeaders(request: Request, response: Response, options: SecurityHeaderOptions): Response {
  const url = new URL(request.url);
  // Responses from `fetch` and redirects have immutable headers.
  const secured = new Response(response.body, response);
  const headers = secured.headers;
  const frameable = isFrameablePath(url.pathname);

  headers.set(
    "Content-Security-Policy",
    buildSitePolicy({ nonce: options.nonce, dev: options.dev, mediaOrigin: options.mediaOrigin, frameable }),
  );
  // X-Frame-Options has no allow-list; where Telegram may frame, the policy's
  // frame-ancestors decides alone.
  if (!frameable) headers.set("X-Frame-Options", "DENY");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  headers.set("Permissions-Policy", "camera=(), geolocation=(), microphone=(), payment=()");
  if (url.protocol === "https:") headers.set("Strict-Transport-Security", "max-age=31536000");
  // Pages can carry the signed-in account's own data, so nothing is shared
  // between visitors or kept without checking back. Routes that serve
  // something cacheable say so themselves.
  if (!headers.has("Cache-Control")) headers.set("Cache-Control", "private, no-cache");
  if (!options.indexable) headers.set("X-Robots-Tag", "noindex");
  return secured;
}
