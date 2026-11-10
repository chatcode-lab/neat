/**
 * A site's handle, as in neat.link/<handle>: 1 to 32 characters of a-z, 0-9
 * and underscore, starting with a letter and not ending with an underscore.
 * This is the legacy bot's rule, so every old address still resolves.
 */
export const HANDLE_PATTERN = /^[a-z](?:[a-z0-9_]{0,30}[a-z0-9])?$/;

/**
 * The shortest handle a new or renamed site may take. A shorter one is
 * allowed only when it is the owner's own Telegram username (legacy rule).
 */
export const MIN_HANDLE_LENGTH = 6;

/**
 * Handles no one may take: the site's own routes, words that would read as
 * the site speaking, and the legacy list.
 */
export const RESERVED_HANDLES: ReadonlySet<string> = new Set([
  // Routes and files.
  "about", "account", "admin", "agents", "api", "app", "apps", "assets", "auth", "bot", "build",
  "dashboard", "docs", "edit", "favicon", "help", "index", "legal", "llms", "login", "logout", "mcp",
  "media", "new", "oauth", "og", "pricing", "privacy", "robots", "security", "settings", "signin",
  "signout", "signup", "sitemap", "static", "status", "support", "terms", "tg", "theme", "welcome",
  "well_known", "www",
  // The site's own names and voices.
  "neat", "neatlink", "neat_link", "official", "team", "staff", "root", "system", "telegram", "mail",
  "email", "noreply", "no_reply", "postmaster", "hostmaster", "webmaster", "abuse", "billing",
  // The legacy bot's reserved names.
  "contact", "elon", "blog", "gdpr", "post", "receipts",
]);

/**
 * What someone typed for a handle, reduced to the handle: an address such as
 * https://neat.link/elon, neat.link/elon/, @elon, or plain elon.
 */
export function normalizeHandle(input: string): string {
  let value = input.trim().toLowerCase();
  value = value.replace(/^https?:\/\//, "").replace(/^www\./, "");
  if (value.startsWith("neat.link/")) value = value.slice("neat.link/".length);
  value = value.replace(/^@/, "").replace(/[/?#].*$/, "");
  return value;
}

export interface HandleRules {
  /** The owner's Telegram username, which they may take however short. */
  telegramUsername?: string | null;
}

/**
 * Why a handle cannot be taken for a new or renamed site, as a sentence for
 * the person or agent asking; null when it can. Whether another site holds
 * it is checked by the database.
 */
export function handleProblem(handle: string, rules: HandleRules = {}): string | null {
  if (!handle) return "Choose a handle.";
  if (handle.length > 32) return "A handle is at most 32 characters.";
  if (!HANDLE_PATTERN.test(handle)) {
    return "A handle uses a-z, 0-9 and _, starts with a letter and does not end with _.";
  }
  if (RESERVED_HANDLES.has(handle)) return "That handle is reserved.";
  const own = rules.telegramUsername?.toLowerCase();
  if (handle.length < MIN_HANDLE_LENGTH && handle !== own) {
    return `A handle is at least ${MIN_HANDLE_LENGTH} characters, unless it is your own Telegram username.`;
  }
  return null;
}

/** The public address of a site, without the scheme, as people write it. */
export function displayAddress(handle: string, host = "neat.link"): string {
  return `${host}/${handle}`;
}
