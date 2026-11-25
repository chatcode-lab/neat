/**
 * Addresses of subpages below a site: a private ID (12 lowercase letters
 * and digits) or a public path (lowercase words joined by dashes). Both fit
 * one pattern, so a request is matched before it is looked up.
 */
export const SUBPAGE_SEGMENT = /^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$/;

/** Paths that would read as something else on a site's own domain. */
const RESERVED_PATHS = new Set(["index", "robots", "sitemap", "favicon", "assets", "media", "og", "pixels"]);

export const MAX_PATH_LENGTH = 80;

/** Why a public path cannot be used, as a sentence; null when it can. */
export function subpagePathProblem(path: string): string | null {
  if (!path) return "A path needs at least one letter or digit.";
  if (path.length > MAX_PATH_LENGTH) return `A path is at most ${MAX_PATH_LENGTH} characters.`;
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(path)) return "A path is lowercase letters and digits, with single dashes between words, as in how-i-made-it.";
  if (RESERVED_PATHS.has(path)) return "That path is reserved.";
  return null;
}

/** A path made from a title: "How I made my first $1M!" becomes how-i-made-my-first-1m. */
export function pathFromTitle(title: string): string {
  return title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_PATH_LENGTH)
    .replace(/-+$/, "");
}
