import { env } from "cloudflare:workers";

import { handleApi } from "~/lib/api/v1.server";
import { userForToken } from "~/lib/db/tokens.server";
import { handleMcp } from "~/lib/mcp/protocol";
import { instructions, TOOLS, type ToolContext } from "~/lib/mcp/tools";
import { protectedResourceMetadataUrl } from "~/lib/oauth/metadata";
import { RATE_LIMITED_MESSAGE, withinLimits } from "~/lib/security/rate-limit.server";
import { pageMarkdown } from "~/lib/views/markdown.server";

import type { Route } from "./+types/mcp";

/**
 * The tools' view of neat.link, as the account the request's token belongs
 * to. API calls run in-process with the caller's token and address, so the
 * API's checks and burst limits apply as if the client had called it.
 */
function contextFor(request: Request, userId: string): ToolContext {
  const origin = new URL(request.url).origin;
  const forwarded = new Headers({ Authorization: request.headers.get("Authorization") ?? "" });
  const address = request.headers.get("CF-Connecting-IP");
  if (address) forwarded.set("CF-Connecting-IP", address);
  return {
    origin,
    async api(method, path, body) {
      const headers = new Headers(forwarded);
      if (body) headers.set("Content-Type", "application/json");
      const inner = new Request(`${origin}/api/v1/${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
      const response = await handleApi(inner, path.split("?")[0]!);
      const text = await response.text();
      let parsed: unknown = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = { message: text };
      }
      return { status: response.status, body: parsed };
    },
    async markdown(handle) {
      if (!(await withinLimits(request, "read", userId))) return { status: 429, text: RATE_LIMITED_MESSAGE };
      const page = await pageMarkdown(env.DB, decodeURIComponent(handle), origin);
      return page ? { status: 200, text: page.text } : { status: 404, text: "No published page has that handle." };
    },
  };
}

function serve(request: Request): Promise<Response> {
  const origin = new URL(request.url).origin;
  return handleMcp(request, {
    name: "neat-link",
    title: "neat.link",
    version: "1.0.0",
    instructions: instructions(origin),
    tools: TOOLS,
    challenge: `Bearer realm="neat.link", resource_metadata="${protectedResourceMetadataUrl(origin)}"`,
    async authorize(incoming) {
      const token = /^Bearer\s+(\S+)$/i.exec(incoming.headers.get("Authorization") ?? "")?.[1];
      const found = token ? await userForToken(env.DB, token, Math.floor(Date.now() / 1000)) : null;
      return found ? contextFor(incoming, found.userId) : null;
    },
    // Every request counts against the address's read limit, whatever it asks.
    admit: (incoming) => withinLimits(incoming, "read", null),
  });
}

export function loader({ request }: Route.LoaderArgs) {
  return serve(request);
}

export function action({ request }: Route.ActionArgs) {
  return serve(request);
}
