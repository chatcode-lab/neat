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

const HINTS: Record<string, (origin: string) => string> = {
  site_limit: (origin) => `Tell the user: an account has at most 2 sites for now. They can delete one in ${origin}/app.`,
  handle_taken: () => "Suggest another handle, or check one first with check_handle.",
  invalid_handle: () => "Suggest a handle that follows the rule in the message, or check one first with check_handle.",
  rate_limited: () => "Wait a minute before trying again.",
  not_found: () => "Call list_sites to see the account's handles.",
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
      "Makes a site at neat.link/<handle> (at most 2 per account). Without a handle one is suggested; without a title, the account's name. It stays a draft unless published is true, so show the user before publishing.",
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
      "Changes a site's content, its handle (new_handle) or whether it is published. Fields left out keep their value; buttons replaces the whole list. Changes are live at once on a published site.",
    inputSchema: object(
      {
        handle: HANDLE,
        new_handle: { type: "string", description: "A new handle; the old address stops working." },
        ...CONTENT,
        published: { type: "boolean", description: "true to publish, false to hide it again." },
      },
      ["handle"],
    ),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: async (args, context) => {
      const body = pick(args, ["title", "headline", "body", "buttons", "published"]);
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
];

/** What the client tells the model about neat.link, once, on connecting. */
export function instructions(origin: string): string {
  return [
    "neat.link makes mini business-card pages: neat.link/<handle> shows a round picture, a title, an optional headline, a short Markdown text and a column of buttons (links, email, phone), centred. These tools manage the sites of the account that connected you.",
    "Call whoami, then list_sites. Write in the user's voice and language, keep the text short, and put contact and social links in buttons rather than in the text. New sites are drafts: show the user the result (the url, or read_page once published) and publish only when they agree.",
    `The HTTP API does the same with a token: ${origin}/api/v1. Any published page is Markdown at ${origin}/<handle>.md.`,
  ].join("\n\n");
}
