import { shortUrl } from "../buttons";
import { agentsMarkdown, homeMarkdown, privacyMarkdown, termsMarkdown } from "../copy";
import { siteByHandle } from "../db/sites.server";
import { HANDLE_PATTERN } from "../handles";
import { mediaUrl } from "../media.server";

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
 * A published page as Markdown: front matter for programs, then the page
 * as a reader sees it, its buttons as a list of links. Null for a draft or
 * a handle no site has.
 */
export async function pageMarkdown(db: D1Database, handle: string, origin: string): Promise<string | null> {
  if (!HANDLE_PATTERN.test(handle)) return null;
  const site = await siteByHandle(db, handle);
  if (!site || !site.published) return null;
  const { page } = site;
  const front = [
    "---",
    `title: ${yaml(page.title)}`,
    ...(page.headline ? [`headline: ${yaml(page.headline)}`] : []),
    `url: ${yaml(`${origin}/${site.handle}`)}`,
    ...(page.imageKey ? [`picture: ${yaml(mediaUrl(page.imageKey, origin))}`] : []),
    `updated: ${yaml(new Date(site.updatedAt * 1000).toISOString())}`,
    "---",
  ];
  const parts = [front.join("\n"), `# ${page.title}`];
  if (page.headline) parts.push(`*${page.headline.replace(/([*_\\])/g, "\\$1")}*`);
  if (page.body) parts.push(page.body);
  if (page.buttons.length > 0) {
    parts.push(page.buttons.map((button) => `- [${button.label.replace(/([[\]\\])/g, "\\$1")}](${button.url}) — ${shortUrl(button.url)}`).join("\n"));
  }
  return `${parts.join("\n\n")}\n`;
}

function markdownResponse(body: string, canonical: string, maxAge = 60): Response {
  return new Response(body, {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      Vary: "Accept",
      "Cache-Control": `public, max-age=${maxAge}`,
      Link: `<${canonical}>; rel="canonical"`,
    },
  });
}

/** The site's own pages that have Markdown, by path. */
const STATIC_PAGES: Record<string, (origin: string) => string> = {
  "/": homeMarkdown,
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
  const handle = /^\/([^/]+)$/.exec(path)?.[1]?.toLowerCase();
  if (!handle) return null;
  const page = await pageMarkdown(db, handle, origin);
  return page ? markdownResponse(page, `${origin}/${handle}`) : null;
}
