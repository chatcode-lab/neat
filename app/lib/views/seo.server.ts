import { TAGLINE } from "../copy";
import { publishedSites } from "../db/sites.server";

/**
 * Production welcomes every crawler, AI ones included, to every public page
 * and keeps them off private and per-account ones. Every other environment
 * is closed to all.
 */
export function robotsTxt(origin: string, indexable: boolean): string {
  if (!indexable) return "User-agent: *\nDisallow: /\n";
  return [
    "User-agent: *",
    "Allow: /",
    "Disallow: /app",
    "Disallow: /api/",
    "Disallow: /auth/",
    "Disallow: /oauth/",
    "Disallow: /signin",
    "Disallow: /tg",
    "",
    `Sitemap: ${origin}/sitemap.xml`,
    "",
  ].join("\n");
}

/** `/llms.txt` (llmstxt.org): what neat.link is, for language models, and where to read on. */
export function llmsTxt(origin: string, bot: string): string {
  return [
    "# neat.link",
    "",
    `> ${TAGLINE} Mini business-card pages at ${origin}/<handle>: a picture, a title, a headline, a short Markdown text and a column of buttons.`,
    "",
    `Every published page is Markdown at its address plus \`.md\`. Accounts manage their pages in a web editor, the Telegram bot @${bot}, an HTTP API, or an MCP server with OAuth.`,
    "",
    "## For agents",
    "",
    `- [Connecting an agent](${origin}/agents.md): MCP setup for Claude, ChatGPT, Codex and others, and how to write a good page`,
    `- [HTTP API guide](${origin}/api/v1): endpoints, fields and errors`,
    `- [MCP server](${origin}/mcp): Streamable HTTP, OAuth 2.1`,
    "",
    "## Pages",
    "",
    `- [Sitemap](${origin}/sitemap.xml): every published page; each is Markdown at its address plus .md`,
    "",
    "## Optional",
    "",
    `- [Home](${origin}/index.md)`,
    `- [Terms](${origin}/terms.md)`,
    `- [Privacy](${origin}/privacy.md)`,
    "",
  ].join("\n");
}

const xml = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const w3c = (seconds: number) => new Date(seconds * 1000).toISOString();

/** The sitemap: the home page, the pages about the site, and every published, public site. */
export async function sitemapXml(db: D1Database, origin: string): Promise<string> {
  const sites = await publishedSites(db, 49_990);
  const latest = sites.reduce((max, site) => Math.max(max, site.updatedAt), 0);
  const entries = [
    `<url><loc>${xml(`${origin}/`)}</loc>${latest ? `<lastmod>${w3c(latest)}</lastmod>` : ""}</url>`,
    ...["/agents", "/terms", "/privacy"].map((path) => `<url><loc>${xml(`${origin}${path}`)}</loc></url>`),
    ...sites.map((site) => `<url><loc>${xml(`${origin}/${site.handle}`)}</loc><lastmod>${w3c(site.updatedAt)}</lastmod></url>`),
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries.join("\n")}\n</urlset>\n`;
}
