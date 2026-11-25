import { env } from "cloudflare:workers";

import { shortUrl } from "../buttons";
import { agentsMarkdown, homeMarkdown, privacyMarkdown, termsMarkdown } from "../copy";
import { siteByHandle } from "../db/sites.server";
import { publicSubpages, subpageAt } from "../db/subpages.server";
import { siteUrl, subpageUrl } from "../domains";
import { HANDLE_PATTERN } from "../handles";
import { mediaUrl } from "../media.server";
import { SUBPAGE_SEGMENT } from "../subpages";
import { subpagesVisible } from "../subpages.server";

/**
 * True when a request asks for Markdown ahead of HTML, as agents and tools
 * do with `Accept: text/markdown`. Browsers never do.
 */
export function wantsMarkdown(request: Request): boolean {
  if (request.method !== "GET" && request.method !== "HEAD") return false;
  const accept = request.headers.get("Accept") ?? "";
  const weight = (type: string) => {
    let best = -1;
    for (const part of accept.split(",")) {
      const [media, ...params] = part.split(";").map((piece) => piece.trim().toLowerCase());
      if (media !== type) continue;
      const q = params.find((param) => param.startsWith("q="));
      best = Math.max(best, q ? Number(q.slice(2)) || 0 : 1);
    }
    return best;
  };
  const markdown = Math.max(weight("text/markdown"), weight("text/x-markdown"));
  return markdown > 0 && markdown >= weight("text/html");
}

/** A YAML string that needs no thought about quoting. */
const yaml = (value: string) => JSON.stringify(value);

/**
 * A published page as Markdown, and its canonical address: front matter for
 * programs, then the page as a reader sees it, its buttons as a list of
 * links. Null for a draft or a handle no site has.
 */
export async function pageMarkdown(db: D1Database, handle: string, origin: string): Promise<{ text: string; url: string } | null> {
  if (!HANDLE_PATTERN.test(handle)) return null;
  const site = await siteByHandle(db, handle);
  if (!site || !site.published) return null;
  const { page } = site;
  const url = siteUrl(site, origin);
  const front = [
    "---",
    `title: ${yaml(page.title)}`,
    ...(page.headline ? [`headline: ${yaml(page.headline)}`] : []),
    `url: ${yaml(url)}`,
    ...(page.imageKey ? [`picture: ${yaml(mediaUrl(page.imageKey, origin))}`] : []),
    `updated: ${yaml(new Date(site.updatedAt * 1000).toISOString())}`,
    "---",
  ];
  const parts = [front.join("\n"), `# ${page.title}`];
  if (page.headline) parts.push(`*${page.headline.replace(/([*_\\])/g, "\\$1")}*`);
  if (page.body) parts.push(page.body);
  if (page.buttons.length > 0) {
    parts.push(page.buttons.map((button) => `- [${linkText(button.label)}](${button.url}) — ${shortUrl(button.url)}`).join("\n"));
  }
  // Its public subpages, for agents to read on.
  const subpages = subpagesVisible(site) ? await publicSubpages(db, site.id) : [];
  if (subpages.length > 0) {
    parts.push(`## Pages\n\n${subpages.map((sub) => `- [${linkText(sub.title)}](${subpageUrl(site, sub.path, origin)})`).join("\n")}`);
  }
  return { text: `${parts.join("\n\n")}\n`, url };
}

const linkText = (text: string) => text.replace(/([[\]\\])/g, "\\$1");

/**
 * A subpage as Markdown, as visitors see it, with its address: the public
 * one, or the private one it was asked for by, which is never indexed.
 */
export async function subpageMarkdown(
  db: D1Database,
  handle: string,
  segment: string,
  origin: string,
): Promise<{ text: string; url: string; indexable: boolean } | null> {
  if (!HANDLE_PATTERN.test(handle) || !SUBPAGE_SEGMENT.test(segment)) return null;
  const site = await siteByHandle(db, handle);
  if (!site || !subpagesVisible(site)) return null;
  const found = await subpageAt(db, site.id, segment);
  if (!found) return null;
  const { page, via } = found;
  const url = subpageUrl(site, via === "path" ? page.path! : page.privateId, origin);
  const front = [
    "---",
    `title: ${yaml(page.title)}`,
    ...(page.headline ? [`headline: ${yaml(page.headline)}`] : []),
    `url: ${yaml(url)}`,
    `site: ${yaml(siteUrl(site, origin))}`,
    `author: ${yaml(site.page.title)}`,
    `updated: ${yaml(new Date(page.updatedAt * 1000).toISOString())}`,
    "---",
  ];
  const parts = [front.join("\n"), `# ${page.title}`];
  if (page.headline) parts.push(`*${page.headline.replace(/([*_\\])/g, "\\$1")}*`);
  if (page.body) parts.push(page.body);
  return { text: `${parts.join("\n\n")}\n`, url, indexable: via === "path" };
}

function markdownResponse(body: string, canonical: string, maxAge = 60, indexable = true): Response {
  return new Response(body, {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      Vary: "Accept",
      "Cache-Control": `public, max-age=${maxAge}`,
      Link: `<${canonical}>; rel="canonical"`,
      ...(indexable ? {} : { "X-Robots-Tag": "noindex" }),
    },
  });
}

/** The site's own pages that have Markdown, by path. */
const STATIC_PAGES: Record<string, (origin: string) => string> = {
  "/": (origin) => homeMarkdown(origin, env.TELEGRAM_BOT_USERNAME),
  "/agents": agentsMarkdown,
  "/terms": termsMarkdown,
  "/privacy": privacyMarkdown,
};

/**
 * Any public page as Markdown, or null when the address has none: the home
 * page, the pages about the site, and every published site.
 */
export async function markdownView(path: string, db: D1Database, origin: string): Promise<Response | null> {
  const fixed = STATIC_PAGES[path];
  if (fixed) return markdownResponse(fixed(origin), `${origin}${path}`, 3600);
  const [, handle, segment] = /^\/([^/]+)(?:\/([^/]+))?$/.exec(path)?.map((part) => part?.toLowerCase()) ?? [];
  if (!handle) return null;
  if (segment) {
    const sub = await subpageMarkdown(db, handle, segment, origin);
    return sub ? markdownResponse(sub.text, sub.url, 60, sub.indexable) : null;
  }
  const page = await pageMarkdown(db, handle, origin);
  return page ? markdownResponse(page.text, page.url) : null;
}
