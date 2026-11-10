import { env } from "cloudflare:workers";
import { redirect, type RouterContextProvider } from "react-router";

import { viewerContext } from "../context";
import { authFor } from "./auth.server";
import { type Account, accountRecord } from "./db/accounts.server";

// Better Auth's session cookie, with or without the `__Secure-` prefix.
const SESSION_COOKIE = /(?:^|;\s*)(?:__Secure-)?better-auth\.session_token=/;

/**
 * The signed-in account from the session cookie, read from D1 every time.
 * Requests without the cookie skip the database.
 */
export async function loadViewer(request: Request): Promise<Account | null> {
  if (!SESSION_COOKIE.test(request.headers.get("Cookie") ?? "")) return null;
  const session = await authFor(request).api.getSession({ headers: request.headers, query: { disableCookieCache: true } });
  if (!session) return null;
  return accountRecord(env.DB, session.user.id);
}

export function viewerOf(context: Readonly<RouterContextProvider>): Promise<Account | null> {
  return context.get(viewerContext)();
}

/**
 * The page a request is for. A navigation inside the app asks for the page's
 * data at `<path>.data`; this is the address the visitor sees.
 */
export function pagePath(request: Request): string {
  const url = new URL(request.url);
  let path = url.pathname;
  if (path.endsWith(".data")) path = path.slice(0, -".data".length);
  if (path === "/_root") path = "/";
  url.searchParams.delete("_routes");
  return `${path}${url.search}`;
}

export function signInPath(request: Request): string {
  return `/signin?${new URLSearchParams({ next: pagePath(request) })}`;
}

/**
 * The signed-in account. Pages send a signed-out visitor to sign in;
 * writes answer 401.
 */
export async function requireAccount(request: Request, context: Readonly<RouterContextProvider>): Promise<Account> {
  const viewer = await viewerOf(context);
  if (viewer) return viewer;
  if (request.method !== "GET" && request.method !== "HEAD") {
    throw Response.json({ error: "sign_in", message: "Sign in to continue." }, { status: 401 });
  }
  throw redirect(signInPath(request));
}
