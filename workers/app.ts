import { env } from "cloudflare:workers";
import { createRequestHandler, RouterContextProvider } from "react-router";

import { nonceContext, viewerContext, waitUntilContext } from "../app/context";
import { sweepTelegramTokens } from "../app/lib/db/telegram-tokens.server";
import { sweepOAuth } from "../app/lib/oauth/clients.server";
import { authorizationServerMetadata, protectedResourceMetadata } from "../app/lib/oauth/metadata";
import { createNonce } from "../app/lib/security/csp";
import { withSecurityHeaders } from "../app/lib/security/headers";
import { isSameOriginRequest } from "../app/lib/security/request";
import { loadViewer } from "../app/lib/viewer.server";
import { markdownView, wantsMarkdown } from "../app/lib/views/markdown.server";
import { llmsTxt, robotsTxt, sitemapXml } from "../app/lib/views/seo.server";

const requestHandler = createRequestHandler(() => import("virtual:react-router/server-build"), import.meta.env.MODE);

/**
 * Serves a response that is the same for everyone from the edge cache, or
 * makes it and keeps it there. The cache answers without the database; it
 * works on the production domain and is skipped on workers.dev. `key`
 * separates views that share an address, such as Markdown and HTML.
 */
async function cached(ctx: ExecutionContext, key: string, make: () => Promise<Response | null>): Promise<Response | null> {
  const cache = await caches.open("public-views");
  const request = new Request(key);
  const hit = await cache.match(request);
  if (hit) return hit;
  const response = await make();
  if (response && response.status === 200) ctx.waitUntil(cache.put(request, response.clone()));
  return response;
}

/**
 * Where apps connect agents from anywhere, browser-based ones included: the
 * MCP server, the OAuth endpoints apps call, and their discovery documents.
 * None reads a cookie, so any origin may call them.
 */
const OPEN_PATHS = new Set([
  "/mcp",
  "/oauth/token",
  "/oauth/register",
  "/oauth/revoke",
  "/.well-known/oauth-protected-resource",
  "/.well-known/oauth-protected-resource/mcp",
  "/.well-known/oauth-authorization-server",
]);

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, *",
  "Access-Control-Expose-Headers": "WWW-Authenticate, Mcp-Session-Id",
  "Access-Control-Max-Age": "86400",
};

/** Paths any origin may call, with CORS: the open ones and the bearer-token API. */
function isOpenPath(pathname: string): boolean {
  return OPEN_PATHS.has(pathname) || pathname === "/api/v1" || pathname.startsWith("/api/v1/");
}

function withCors(response: Response): Response {
  const open = new Response(response.body, response);
  for (const [name, value] of Object.entries(CORS)) open.headers.set(name, value);
  return open;
}

/** The OAuth discovery documents (RFC 9728, RFC 8414), the same for everyone. */
function discovery(pathname: string, origin: string): Response | null {
  const body =
    pathname === "/.well-known/oauth-authorization-server"
      ? authorizationServerMetadata(origin)
      : pathname.startsWith("/.well-known/oauth-protected-resource")
        ? protectedResourceMetadata(origin)
        : null;
  return body ? Response.json(body, { headers: { "Cache-Control": "public, max-age=3600" } }) : null;
}

const text = (body: string, type: string, maxAge = 3600) =>
  new Response(body, { headers: { "Content-Type": `${type}; charset=utf-8`, "Cache-Control": `public, max-age=${maxAge}` } });

/** A request the browser makes ahead of need, as for `<link rel="prefetch">`. */
function isPrefetch(request: Request): boolean {
  return ["Sec-Purpose", "Purpose", "X-Moz"].some((name) => request.headers.get(name)?.includes("prefetch") === true);
}

async function serve(request: Request, ctx: ExecutionContext): Promise<Response> {
  const nonce = createNonce();
  const options = {
    nonce,
    dev: import.meta.env.DEV,
    indexable: !import.meta.env.DEV && env.ENVIRONMENT === "production",
    mediaOrigin: env.MEDIA_ORIGIN || undefined,
  };
  const secure = (response: Response) => withSecurityHeaders(request, response, options);
  const url = new URL(request.url);

  // The API, the MCP server and the OAuth endpoints apps call read only a
  // bearer token, never cookies, so a request from anywhere carries no one's
  // session and needs no Origin check. Telegram's webhook proves itself by
  // its secret header.
  const crossOrigin = isOpenPath(url.pathname) || url.pathname === "/telegram/webhook";
  if (!crossOrigin && !isSameOriginRequest(request)) return secure(new Response("Forbidden", { status: 403 }));
  if (request.method === "OPTIONS" && isOpenPath(url.pathname)) return secure(new Response(null, { status: 204 }));

  if (request.method === "GET" || request.method === "HEAD") {
    const document = discovery(url.pathname, url.origin);
    if (document) return secure(document);
    if (url.pathname === "/robots.txt") return secure(text(robotsTxt(url.origin, options.indexable), "text/plain"));
    if (url.pathname === "/llms.txt") return secure(text(llmsTxt(url.origin, env.TELEGRAM_BOT_USERNAME), "text/plain"));
    if (url.pathname === "/sitemap.xml") {
      const response = await cached(ctx, `${url.origin}/sitemap.xml`, async () =>
        text(await sitemapXml(env.DB, url.origin), "application/xml"),
      );
      return secure(response!);
    }
    // Covers for shared links, drawn on first request and then cached. The
    // renderer loads only here, so no other request pays for it.
    if (url.pathname.startsWith("/og/")) {
      const { coverResponse } = await import("../app/lib/og/covers.server");
      const response = await coverResponse(url, (key, make) => cached(ctx, key, make));
      return secure(response ?? new Response("Not Found", { status: 404 }));
    }
    // Every public page is Markdown at its address plus .md (the home page
    // at /index.md), whatever the request asks for, for agents whose tools
    // cannot choose a format; and at its own address to a request that asks.
    const markdownPath = url.pathname.endsWith(".md") ? (url.pathname === "/index.md" ? "/" : url.pathname.slice(0, -3)) : null;
    if (markdownPath !== null || wantsMarkdown(request)) {
      const path = markdownPath ?? url.pathname;
      const response = await cached(ctx, `${url.origin}/__markdown${path}`, () => markdownView(path, env.DB, url.origin));
      if (response) return secure(request.method === "HEAD" ? new Response(null, response) : response);
      if (markdownPath !== null) {
        return secure(
          new Response("Nothing is at this address in Markdown.\n", {
            status: 404,
            headers: { "Content-Type": "text/markdown; charset=utf-8" },
          }),
        );
      }
    }
  }

  // A page's data fetched ahead as a link is pointed at: pages are never
  // kept without checking back, so the click fetches it again anyway.
  if (request.method === "GET" && url.pathname.endsWith(".data") && isPrefetch(request)) {
    return secure(new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } }));
  }

  const context = new RouterContextProvider();
  context.set(nonceContext, nonce);
  let viewer: ReturnType<typeof loadViewer> | undefined;
  context.set(viewerContext, () => (viewer ??= loadViewer(request)));
  context.set(waitUntilContext, (work) => ctx.waitUntil(work));
  const response = secure(await requestHandler(request, context));
  // Pages answer in Markdown too, to requests that ask for it.
  if (response.headers.get("Content-Type")?.startsWith("text/html")) response.headers.append("Vary", "Accept");
  return response;
}

export default {
  async fetch(request, _workerEnv, ctx) {
    const response = await serve(request, ctx);
    return isOpenPath(new URL(request.url).pathname) ? withCors(response) : response;
  },

  // Hourly: forgets expired OAuth codes and unused apps, expired sign-in and
  // linking tokens, and expired sessions.
  async scheduled(_controller, workerEnv, ctx) {
    const now = Math.floor(Date.now() / 1000);
    const run = (job: string, work: Promise<unknown>) =>
      ctx.waitUntil(work.catch((error: unknown) => console.error(job, error)));
    run("sweepOAuth", sweepOAuth(workerEnv.DB, now));
    run("sweepTelegramTokens", sweepTelegramTokens(workerEnv.DB, now));
    run(
      "sweepSessions",
      workerEnv.DB.prepare(`DELETE FROM "session" WHERE "expiresAt" < ?1`).bind(new Date(now * 1000).toISOString()).run(),
    );
  },
} satisfies ExportedHandler<Env>;
