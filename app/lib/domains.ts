/**
 * Whether a request's host is neat.link itself rather than a site's own
 * domain. Without an app origin (staging on workers.dev) every host is the
 * app; localhost always is, for development.
 */
export function isAppHost(hostname: string, appOrigin: string): boolean {
  if (!appOrigin || hostname === "localhost" || hostname === "127.0.0.1") return true;
  return hostname === new URL(appOrigin).hostname;
}

/** The same domain with www added or taken off. */
export function wwwTwin(hostname: string): string {
  return hostname.startsWith("www.") ? hostname.slice("www.".length) : `www.${hostname}`;
}

/** A site's canonical address: its own domain when it has one, else neat.link/<handle>. */
export function siteUrl(site: { handle: string; domain: string | null }, origin: string): string {
  return site.domain ? `https://${site.domain}/` : `${origin}/${site.handle}`;
}

/** Where a site's page is as Markdown, beside its canonical address. */
export function siteMarkdownUrl(site: { handle: string; domain: string | null }, origin: string): string {
  return site.domain ? `https://${site.domain}/index.md` : `${origin}/${site.handle}.md`;
}
