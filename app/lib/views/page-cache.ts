import { RESERVED_HANDLES } from "../handles";
import { SESSION_COOKIE_PATTERN } from "../session-cookie";
import { readTheme } from "../theme";

/**
 * Pages that are the same for every visitor without an account (a site's
 * page, the home page, the pages about the site) are kept at the edge for a
 * minute, so most visits are answered without rendering or the database.
 * An edit shows to others within that minute; the owner, signed in, always
 * sees the page as it is. It works on the production domain; workers.dev
 * has no edge cache.
 */
export const PAGE_CACHE_SECONDS = 60;

/** Set by the server entry on pages whose routes are static; never sent to visitors. */
export const STATIC_PAGE_HEADER = "X-Static-Page";

/**
 * Set by a site's page when its owner added tracking pixels: their vendors,
 * "google meta". The Worker lets those vendors into the page's Content
 * Security Policy and never sends the header on.
 */
export const PIXELS_HEADER = "X-Page-Pixels";

/**
 * The cache key for a page request any visitor without an account would be
 * answered the same way, or null. It separates themes, which the page is
 * drawn in, and builds, whose assets the page names; query strings are left
 * out, so nobody can fill the cache by varying them.
 */
export function pageCacheKey(request: Request, url: URL, build: string): string | null {
  if (request.method !== "GET") return null;
  // The home page, a page about the site, a site's page, or one of its
  // subpages, below a handle no route of the site's own has.
  const path = /^\/([a-z0-9_]*)(\/[a-z0-9-]+)?$/.exec(url.pathname);
  if (!path || (path[2] && RESERVED_HANDLES.has(path[1]!))) return null;
  const cookie = request.headers.get("Cookie") ?? "";
  if (SESSION_COOKIE_PATTERN.test(cookie)) return null;
  return `${url.origin}/__page/${encodeURIComponent(build)}${url.pathname}?theme=${readTheme(cookie)}`;
}

/** Whether a rendered page may be kept for everyone: a complete, static page that sets no cookie. */
export function isShareablePage(response: Response): boolean {
  return (
    response.status === 200 &&
    response.headers.get(STATIC_PAGE_HEADER) === "1" &&
    !response.headers.has("Set-Cookie") &&
    (response.headers.get("Content-Type") ?? "").startsWith("text/html")
  );
}
