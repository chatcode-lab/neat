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

/** A subpage's address: below its site's own domain when it has one, else neat.link/<handle>/<segment>. */
export function subpageUrl(site: { handle: string; domain: string | null }, segment: string, origin: string): string {
  return site.domain ? `https://${site.domain}/${segment}` : `${origin}/${site.handle}/${segment}`;
}

/**
 * A domain as someone typed it, reduced to its name: an address such as
 * https://www.Example.com/path, or Example.COM., becomes www.example.com.
 * Names in other scripts become their ASCII (punycode) form. Null when it
 * is not a name at all.
 */
export function normalizeDomain(input: string): string | null {
  const trimmed = input.trim().replace(/\.$/, "");
  if (!trimmed || /\s/.test(trimmed)) return null;
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
    return url.hostname.replace(/\.$/, "").toLowerCase() || null;
  } catch {
    return null;
  }
}

/**
 * Why a name cannot be a site's own domain, as a sentence; null when it
 * can. `ownHosts` are neat.link's own names, which no site may claim.
 */
export function domainProblem(hostname: string, ownHosts: readonly string[]): string | null {
  if (hostname.length > 253) return "That name is too long for a domain.";
  const labels = hostname.split(".");
  if (labels.length < 2) return "Give the whole domain, such as example.com or www.example.com.";
  if (labels.some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) return "That is not a domain name.";
  if (!/^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/.test(labels.at(-1)!)) return "That is not a domain name.";
  if (/^\d+(?:\.\d+){3}$/.test(hostname)) return "Give a domain name, not an IP address.";
  const own = ownHosts.filter(Boolean);
  if (own.some((host) => hostname === host || hostname.endsWith(`.${host}`))) return "That name is neat.link's own.";
  if (/(?:^|\.)(?:workers\.dev|pages\.dev|localhost|local|internal|invalid|test|example|arpa)$/.test(hostname)) {
    return "That name cannot be connected.";
  }
  return null;
}
