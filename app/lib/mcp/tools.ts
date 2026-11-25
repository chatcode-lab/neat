import { errorResult, textResult, type Tool, type ToolResult } from "./protocol";

/**
 * neat.link's MCP tools. Each is a thin call to the HTTP API or to a page's
 * Markdown, so the API's checks, limits and words apply unchanged.
 */

export interface ToolContext {
  origin: string;
  /** Calls the API as the connected account: a path below /api/v1/. */
  api: (
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    path: string,
    body?: Record<string, unknown>,
  ) => Promise<{ status: number; body: unknown }>;
  /** A published page as Markdown, as anyone sees it. */
  markdown: (handle: string) => Promise<{ status: number; text: string }>;
}

const object = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  properties,
  ...(required.length > 0 ? { required } : {}),
  additionalProperties: false,
});

const HANDLE = { type: "string", description: "The site's handle, as in neat.link/<handle>." };

const BUTTONS = {
  type: "array",
  maxItems: 12,
  description:
    "The whole list of buttons, replacing the current one. A url may be https://…, a bare domain, an email or a phone number. Icons follow the domain.",
  items: object({ label: { type: "string", maxLength: 40 }, url: { type: "string" } }, ["label", "url"]),
};

const CONTENT = {
  title: { type: "string", maxLength: 100, description: "The name at the top of the page." },
  headline: { type: "string", maxLength: 120, description: "One line under the title; empty for none." },
  body: {
    type: "string",
    maxLength: 10000,
    description: "CommonMark. Line breaks are kept; raw HTML and images are not shown. Keep it short: it is a business card.",
  },
  buttons: BUTTONS,
};

/** Only the fields given, so left-out ones keep their value. */
function pick(args: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  return Object.fromEntries(keys.filter((key) => args[key] !== undefined && args[key] !== null).map((key) => [key, args[key]]));
}

const handleOf = (value: unknown) => encodeURIComponent(typeof value === "string" ? value.trim() : "");

const PIXELS = {
  type: "object",
  description:
    'Pro: tracking pixels for the site\'s pages, merged into the current ones; an empty string removes one. {"google": "G-XXXXXXXXXX" or "AW-…", "meta": "<digits>", "tiktok": "<ID>"}',
  properties: { google: { type: "string" }, meta: { type: "string" }, tiktok: { type: "string" } },
  additionalProperties: false,
};

const SUBPAGE = {
  title: { type: "string", maxLength: 100, description: "The subpage's title." },
  headline: { type: "string", maxLength: 120, description: "One line under the title, also its description when shared." },
  body: {
    type: "string",
    maxLength: 100000,
    description:
      "CommonMark: headings, lists, links, code. Embed uploaded files with ![words](url) using a file's url from upload_file (pictures, video, audio; a PDF becomes a link).",
  },
  path: {
    type: ["string", "boolean", "null"],
    description:
      "Its public, indexed address below the site, such as how-i-made-it (lowercase words and dashes); true makes one from the title; null keeps it private only. Its private address works either way.",
  },
};

const ID = { type: "string", description: "The subpage's id, from list_subpages." };

const HINTS: Record<string, (origin: string) => string> = {
  site_limit: (origin) => `Tell the user their plan's page limit is reached. They can delete one in ${origin}/app, or move to Pro (get_plan, start_checkout).`,
  publish_limit: () => "Tell the user their plan publishes no more pages at once. They can unpublish one, or move to Pro (start_checkout with pro_year or pro_life).",
  plan_required: () =>
    "Tell the user this needs a paid plan, with its price. If they want it, call start_checkout with the product the message names (domains for own domains; pro_year or pro_life for the rest) and give them the link to pay.",
  root_domain: () => "Suggest the www form of the domain, or moving the domain's DNS to Cloudflare, as the message says.",
  domain_taken: () => "Another page holds that domain. Ask the user whether it is theirs.",
  path_taken: () => "Suggest another path.",
  media_quota: () => "Suggest deleting files the user no longer needs (list_files, delete_file).",
  file_type: () => "Only pictures, video, audio and PDFs are kept.",
  handle_taken: () => "Suggest another handle, or check one first with check_handle.",
  invalid_handle: () => "Suggest a handle that follows the rule in the message, or check one first with check_handle.",
  rate_limited: () => "Wait a minute before trying again.",
  not_found: () => "Call list_sites (or list_subpages, list_files) to see what the account has.",
  billing_unavailable: () => "Payments cannot be made right now; suggest trying later.",
};

/** An API answer as a tool result: its JSON, or its refusal in words. */
function fromApi(answer: { status: number; body: unknown }, origin: string): ToolResult {
  const body = (answer.body ?? {}) as Record<string, unknown>;
  if (answer.status < 400) return textResult(JSON.stringify(body, null, 2), body);
  const code = typeof body.error === "string" ? body.error : "error";
  const lines = [`neat.link refused (${answer.status} ${code}): ${typeof body.message === "string" ? body.message : "That did not work."}`];
  const hint = HINTS[code]?.(origin);
  if (hint) lines.push(hint);
  return errorResult(lines.join("\n"));
}

export const TOOLS: ReadonlyArray<Tool<ToolContext>> = [
  {
    name: "whoami",
    title: "Who am I",
    description: "The neat.link account this connection acts for: name, email, and linked Telegram. Call it first.",
    inputSchema: object({}),
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: async (_args, context) => fromApi(await context.api("GET", "me"), context.origin),
  },
  {
    name: "list_sites",
    title: "List my sites",
    description:
      "The account's sites with their full content: handle, url, published, title, headline, body (Markdown), buttons and picture.",
    inputSchema: object({}),
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: async (_args, context) => fromApi(await context.api("GET", "sites"), context.origin),
  },
  {
    name: "read_page",
    title: "Read a page",
    description:
      "Any published neat.link page as Markdown, as visitors see it, by handle. Use list_sites for the account's own drafts.",
    inputSchema: object({ handle: HANDLE }, ["handle"]),
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: async (args, context) => {
      const page = await context.markdown(handleOf(args.handle));
      return page.status === 200 ? textResult(page.text) : errorResult(page.text);
    },
  },
  {
    name: "check_handle",
    title: "Check a handle",
    description: "Whether a handle can be taken by this account, and why not if it cannot.",
    inputSchema: object({ handle: HANDLE }, ["handle"]),
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: async (args, context) => fromApi(await context.api("GET", `handles/${handleOf(args.handle)}`), context.origin),
  },
  {
    name: "create_site",
    title: "Create a site",
    description:
      "Makes a site at neat.link/<handle> (Free: 2 published and 4 in all; Pro: 10 and 20). Without a handle one is suggested; without a title, the account's name. It stays a draft unless published is true, so show the user before publishing.",
    inputSchema: object({
      handle: { ...HANDLE, description: "1–32 of a-z 0-9 _, starting with a letter; at least 6 characters unless it is the user's Telegram username." },
      ...CONTENT,
      published: { type: "boolean", description: "true to make it public now." },
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    run: async (args, context) =>
      fromApi(
        await context.api("POST", "sites", pick(args, ["handle", "title", "headline", "body", "buttons", "published"])),
        context.origin,
      ),
  },
  {
    name: "update_site",
    title: "Update a site",
    description:
      "Changes a site's content, its handle (new_handle), whether it is published, and with Pro its tracking pixels and whether it shows the neat.link sign. Fields left out keep their value; buttons replaces the whole list. Changes are live at once on a published site.",
    inputSchema: object(
      {
        handle: HANDLE,
        new_handle: { type: "string", description: "A new handle; the old address stops working." },
        ...CONTENT,
        published: { type: "boolean", description: "true to publish, false to hide it again." },
        pixels: PIXELS,
        branding: { type: "boolean", description: "Pro: false hides the ⎆ neat.link sign at the bottom of the site's pages." },
      },
      ["handle"],
    ),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: async (args, context) => {
      const body = pick(args, ["title", "headline", "body", "buttons", "published", "pixels", "branding"]);
      if (typeof args.new_handle === "string") body.handle = args.new_handle;
      return fromApi(await context.api("PATCH", `sites/${handleOf(args.handle)}`, body), context.origin);
    },
  },
  {
    name: "set_picture",
    title: "Set the picture",
    description:
      "Sets a site's round picture from a public https address of a JPEG, PNG, WebP or GIF up to 8 MB. It is cropped to a square about its centre.",
    inputSchema: object({ handle: HANDLE, url: { type: "string", description: "https address of the picture." } }, ["handle", "url"]),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    run: async (args, context) =>
      fromApi(await context.api("PUT", `sites/${handleOf(args.handle)}/picture`, { url: args.url }), context.origin),
  },
  {
    name: "remove_picture",
    title: "Remove the picture",
    description: "Removes a site's picture.",
    inputSchema: object({ handle: HANDLE }, ["handle"]),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    run: async (args, context) => fromApi(await context.api("DELETE", `sites/${handleOf(args.handle)}/picture`), context.origin),
  },
  {
    name: "delete_site",
    title: "Delete a site",
    description: "Deletes a site for good and frees its handle. Ask the user to confirm first.",
    inputSchema: object({ handle: HANDLE }, ["handle"]),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    run: async (args, context) => fromApi(await context.api("DELETE", `sites/${handleOf(args.handle)}`), context.origin),
  },
  {
    name: "get_plan",
    title: "Get the plan",
    description:
      "The account's plan (free, domains or pro), what it allows, how much of it is used, and the products it could buy with their prices (in USD, plus VAT where it applies).",
    inputSchema: object({}),
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: async (_args, context) => fromApi(await context.api("GET", "plan"), context.origin),
  },
  {
    name: "start_checkout",
    title: "Get a payment link",
    description:
      "A Stripe payment link for the user to open and pay: domains ($10 once: own domains), pro_year ($50 a year) or pro_life ($100 once): up to 10 pages, own domains, subpages, files, pixels, no neat.link sign. Prices plus VAT where it applies. Only call it when the user wants to buy, then give them the url; the plan changes as soon as they have paid.",
    inputSchema: object({ product: { type: "string", enum: ["domains", "pro_year", "pro_life"] } }, ["product"]),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    run: async (args, context) => fromApi(await context.api("POST", "checkout", { product: args.product }), context.origin),
  },
  {
    name: "set_domain",
    title: "Connect a domain",
    description:
      "Connects the user's own domain to a site (Own domain plan or Pro), replacing any it had. Answers with the DNS records the user must add at their DNS provider (named, with a link) and the domain's status. A root domain (example.com) needs DNS at Cloudflare; elsewhere use www. Then call check_domain once the user has added the records.",
    inputSchema: object({ handle: HANDLE, hostname: { type: "string", description: "The domain, such as www.example.com." } }, ["handle", "hostname"]),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    run: async (args, context) =>
      fromApi(await context.api("PUT", `sites/${handleOf(args.handle)}/domain`, { hostname: args.hostname }), context.origin),
  },
  {
    name: "check_domain",
    title: "Check a domain",
    description:
      "Checks a site's domain now: pending (DNS not seen yet; records to add are in the answer), issuing_certificate (connected, HTTPS on its way within minutes), or live. Domains are also checked every hour.",
    inputSchema: object({ handle: HANDLE }, ["handle"]),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    run: async (args, context) => fromApi(await context.api("POST", `sites/${handleOf(args.handle)}/domain/check`), context.origin),
  },
  {
    name: "remove_domain",
    title: "Disconnect a domain",
    description: "Disconnects a site's own domain. The site stays at its neat.link address.",
    inputSchema: object({ handle: HANDLE }, ["handle"]),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    run: async (args, context) => fromApi(await context.api("DELETE", `sites/${handleOf(args.handle)}/domain`), context.origin),
  },
  {
    name: "list_subpages",
    title: "List subpages",
    description: "A site's subpages (articles and other pages below it), with their content, public url (if any) and private_url.",
    inputSchema: object({ handle: HANDLE }, ["handle"]),
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: async (args, context) => fromApi(await context.api("GET", `sites/${handleOf(args.handle)}/pages`), context.origin),
  },
  {
    name: "create_subpage",
    title: "Create a subpage",
    description:
      "Pro: makes a page below a site, such as an article. It is private by default: only people with its private_url (neat.link/<handle>/<random id>) see it, and it is never indexed. Give it a path to also publish it at neat.link/<handle>/<path>, indexed and in the sitemap. Show the user the private_url before making it public.",
    inputSchema: object({ handle: HANDLE, ...SUBPAGE }, ["handle", "title"]),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    run: async (args, context) =>
      fromApi(await context.api("POST", `sites/${handleOf(args.handle)}/pages`, pick(args, ["title", "headline", "body", "path"])), context.origin),
  },
  {
    name: "update_subpage",
    title: "Update a subpage",
    description: "Pro: changes a subpage. Fields left out keep their value; path null takes it off its public address (its private one stays).",
    inputSchema: object({ handle: HANDLE, id: ID, ...SUBPAGE }, ["handle", "id"]),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: async (args, context) => {
      const body = pick(args, ["title", "headline", "body"]);
      if (args.path !== undefined) body.path = args.path;
      return fromApi(await context.api("PATCH", `sites/${handleOf(args.handle)}/pages/${encodeURIComponent(String(args.id ?? ""))}`, body), context.origin);
    },
  },
  {
    name: "rotate_subpage_link",
    title: "Change a subpage's private link",
    description: "Gives a subpage a new private_url; the old one stops working at once, for everyone it was shared with.",
    inputSchema: object({ handle: HANDLE, id: ID }, ["handle", "id"]),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    run: async (args, context) =>
      fromApi(await context.api("POST", `sites/${handleOf(args.handle)}/pages/${encodeURIComponent(String(args.id ?? ""))}/rotate`), context.origin),
  },
  {
    name: "delete_subpage",
    title: "Delete a subpage",
    description: "Deletes a subpage for good. Ask the user to confirm first.",
    inputSchema: object({ handle: HANDLE, id: ID }, ["handle", "id"]),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    run: async (args, context) =>
      fromApi(await context.api("DELETE", `sites/${handleOf(args.handle)}/pages/${encodeURIComponent(String(args.id ?? ""))}`), context.origin),
  },
  {
    name: "list_files",
    title: "List files",
    description: "Files the account uploaded to embed in its pages, with their url and the Markdown that embeds each, and how much of the quota is used.",
    inputSchema: object({}),
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: async (_args, context) => fromApi(await context.api("GET", "media"), context.origin),
  },
  {
    name: "upload_file",
    title: "Upload a file",
    description:
      "Pro: keeps a file from a public https address, to embed in a page or subpage: a picture (JPEG, PNG, GIF, WebP, AVIF), video (MP4, MOV, WebM), audio (MP3, M4A, AAC, OGG, WAV, FLAC) or PDF, up to 25 MB. Answers with its url and the Markdown to put in a body. For a file on the user's computer, use create_upload_link instead.",
    inputSchema: object(
      { url: { type: "string", description: "A public https address of the file." }, name: { type: "string", description: "Its name, such as cv.pdf." } },
      ["url"],
    ),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    run: async (args, context) => fromApi(await context.api("POST", "media", pick(args, ["url", "name"])), context.origin),
  },
  {
    name: "create_upload_link",
    title: "Get an upload link",
    description:
      "Pro: an address valid 15 minutes that takes a file's bytes without a token, for files on the user's computer: curl -T photo.jpg \"<url>?name=photo.jpg\". Each upload answers with the file's url and Markdown.",
    inputSchema: object({}),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    run: async (_args, context) => fromApi(await context.api("POST", "media/upload-link"), context.origin),
  },
  {
    name: "delete_file",
    title: "Delete a file",
    description: "Deletes an uploaded file for good; pages that embed it show a broken link. Ask the user to confirm first.",
    inputSchema: object({ id: { type: "string", description: "The file's id, from list_files." } }, ["id"]),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    run: async (args, context) => fromApi(await context.api("DELETE", `media/${encodeURIComponent(String(args.id ?? ""))}`), context.origin),
  },
];

/** What the client tells the model about neat.link, once, on connecting. */
export function instructions(origin: string): string {
  return [
    "neat.link makes mini business-card pages: neat.link/<handle> shows a round picture, a title, an optional headline, a short Markdown text and a column of buttons (links, email, phone), centred. These tools manage the sites of the account that connected you.",
    "Call whoami, then list_sites. Write in the user's voice and language, keep the text short, and put contact and social links in buttons rather than in the text. New sites are drafts: show the user the result (the url, or read_page once published) and publish only when they agree.",
    "Free accounts have 2 published pages. Paid plans add own domains (set_domain), and with Pro, subpages such as articles (create_subpage), uploaded files to embed (upload_file), tracking pixels and hiding the neat.link sign (update_site). get_plan tells what the account has; when it lacks something the user asks for, tell them the price and, if they want it, give them the link from start_checkout. Only the user can pay, sign up, or add DNS records.",
    `The HTTP API does the same with a token: ${origin}/api/v1. Any published page is Markdown at ${origin}/<handle>.md.`,
  ].join("\n\n");
}
