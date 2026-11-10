const GOOGLE_ACCOUNTS_ORIGIN = "https://accounts.google.com";
// The Mini App's script. Telegram Login is a redirect, with nothing embedded.
const TELEGRAM_ORIGIN = "https://telegram.org";
// Telegram's web clients, which show a Mini App in a frame.
export const TELEGRAM_WEB_ORIGINS = ["https://web.telegram.org"];

/** A fresh, unguessable value for one response's inline scripts. */
export function createNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes));
}

function serialize(directives: Record<string, readonly string[]>): string {
  return Object.entries(directives)
    .map(([name, values]) => [name, ...values].join(" "))
    .join("; ");
}

export interface SitePolicyOptions {
  nonce: string;
  /** Loosens `connect-src` for the Vite dev server's HMR socket. */
  dev?: boolean;
  /** The media bucket's own domain, when it has one. */
  mediaOrigin?: string;
  /** Lets Telegram's web clients frame the page, for the Mini App. */
  frameable?: boolean;
}

/**
 * The policy for every response. Only first-party scripts and Telegram's
 * Mini App script may run, nothing is framed, and pages cannot be framed
 * except the editor and public pages, by Telegram's web clients.
 */
export function buildSitePolicy({ nonce, dev = false, mediaOrigin, frameable = false }: SitePolicyOptions): string {
  return serialize({
    "default-src": ["'self'"],
    "script-src": ["'self'", `'nonce-${nonce}'`, TELEGRAM_ORIGIN],
    // Server-rendered `style` attributes cannot run code; this is the one inline allowance.
    "style-src": ["'self'", "'unsafe-inline'"],
    // `blob:` is a picture previewed before it is uploaded.
    "img-src": ["'self'", "data:", "blob:", ...(mediaOrigin ? [mediaOrigin] : [])],
    "font-src": ["'self'"],
    "connect-src": dev ? ["'self'", "ws:"] : ["'self'"],
    "frame-src": ["'none'"],
    "frame-ancestors": frameable ? ["'self'", ...TELEGRAM_WEB_ORIGINS] : ["'none'"],
    "base-uri": ["'self'"],
    // Chrome applies `form-action` to redirects after a form post, which Google's sign-in is.
    "form-action": ["'self'", GOOGLE_ACCOUNTS_ORIGIN],
    "object-src": ["'none'"],
  });
}
