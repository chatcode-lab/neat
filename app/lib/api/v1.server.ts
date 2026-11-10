import { env } from "cloudflare:workers";

import guide from "../../../docs/api.md?raw";
import { type Account, accountRecord } from "../db/accounts.server";
import { userForToken } from "../db/tokens.server";
import { handleFree } from "../db/sites.server";
import { handleProblem, normalizeHandle } from "../handles";
import { MAX_UPLOAD_BYTES } from "../media.server";
import { readBodyCapped, readBytesCapped } from "../security/body";
import { RATE_LIMITED_MESSAGE, withinLimits } from "../security/rate-limit.server";
import {
  createSiteFor,
  deleteSiteFor,
  listSites,
  Refusal,
  removePictureFor,
  requireOwnedSite,
  setPictureFor,
  type SiteInput,
  siteJson,
  updateSiteFor,
} from "../sites.server";

const JSON_LIMIT = 64 * 1024;

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store", ...headers } });
}

function refusalResponse(refusal: Refusal): Response {
  return json(
    { error: refusal.code, message: refusal.message },
    refusal.status,
    refusal.status === 429 ? { "Retry-After": "60" } : refusal.status === 401 ? { "WWW-Authenticate": 'Bearer realm="neat.link"' } : {},
  );
}

/** The account a request's bearer token acts for. Cookies are never read here. */
async function accountOf(request: Request, now: number): Promise<Account> {
  const token = /^Bearer\s+(\S+)$/i.exec(request.headers.get("Authorization") ?? "")?.[1];
  const found = token ? await userForToken(env.DB, token, now) : null;
  const account = found ? await accountRecord(env.DB, found.userId) : null;
  if (!account) {
    throw new Refusal(401, "unauthorized", "Send Authorization: Bearer <token>. Make a token in Settings at /app/settings, or connect over OAuth.");
  }
  return account;
}

async function limit(request: Request, kind: "read" | "write" | "upload", account: Account): Promise<void> {
  if (!(await withinLimits(request, kind, account.id))) throw new Refusal(429, "rate_limited", RATE_LIMITED_MESSAGE);
}

async function body(request: Request): Promise<SiteInput> {
  const text = await readBodyCapped(request, JSON_LIMIT);
  if (text === null) throw new Refusal(413, "too_large", "The body is over 64 KB.");
  try {
    const value = JSON.parse(text || "{}") as unknown;
    if (value && typeof value === "object" && !Array.isArray(value)) return value as SiteInput;
  } catch {
    // Answered below.
  }
  throw new Refusal(400, "invalid_json", "Send a JSON object.");
}

/** The account as the API describes it. */
function meJson(account: Account) {
  return {
    id: account.id,
    name: account.name,
    email: account.email,
    google: account.google,
    telegram: account.telegram ? { id: account.telegram.id, username: account.telegram.username } : null,
  };
}

/**
 * The HTTP API under /api/v1: an account's sites, for agents and scripts.
 * `path` is what follows /api/v1/. See docs/api.md, served at GET /api/v1.
 */
export async function handleApi(request: Request, path: string): Promise<Response> {
  const method = request.method.toUpperCase();
  const origin = new URL(request.url).origin;
  const now = Math.floor(Date.now() / 1000);
  const segments = path.split("/").filter(Boolean);

  if (segments.length === 0 && (method === "GET" || method === "HEAD")) {
    return new Response(guide.replaceAll("https://neat.link", origin), {
      headers: { "Content-Type": "text/markdown; charset=utf-8", "Cache-Control": "public, max-age=300" },
    });
  }

  try {
    const account = await accountOf(request, now);
    const [resource, handle, part] = segments;

    if (resource === "me" && segments.length === 1 && method === "GET") {
      await limit(request, "read", account);
      return json(meJson(account));
    }

    if (resource === "handles" && handle && segments.length === 2 && method === "GET") {
      await limit(request, "read", account);
      const wanted = normalizeHandle(handle);
      const problem = handleProblem(wanted, { telegramUsername: account.telegram?.username });
      const free = !problem && (await handleFree(env.DB, wanted));
      return json({ handle: wanted, available: free, problem: problem ?? (free ? null : "That handle is taken.") });
    }

    if (resource === "sites" && segments.length === 1) {
      if (method === "GET") {
        await limit(request, "read", account);
        return json({ sites: (await listSites(account)).map((site) => siteJson(site, origin)) });
      }
      if (method === "POST") {
        await limit(request, "write", account);
        const site = await createSiteFor(account, await body(request), now);
        return json({ site: siteJson(site, origin) }, 201);
      }
    }

    if (resource === "sites" && handle && segments.length === 2) {
      if (method === "GET") {
        await limit(request, "read", account);
        return json({ site: siteJson(await requireOwnedSite(account, handle), origin) });
      }
      if (method === "PATCH") {
        await limit(request, "write", account);
        return json({ site: siteJson(await updateSiteFor(account, handle, await body(request), now), origin) });
      }
      if (method === "DELETE") {
        await limit(request, "write", account);
        await deleteSiteFor(account, handle, now);
        return json({ deleted: normalizeHandle(handle) });
      }
    }

    if (resource === "sites" && handle && part === "picture" && segments.length === 3) {
      if (method === "PUT" || method === "POST") {
        await limit(request, "upload", account);
        const type = request.headers.get("Content-Type") ?? "";
        let source: { bytes: Uint8Array<ArrayBuffer> } | { url: string };
        if (type.startsWith("application/json")) {
          const { url } = (await body(request)) as { url?: unknown };
          if (typeof url !== "string") throw new Refusal(400, "invalid_field", 'Send {"url": "https://…"} or the picture itself.');
          source = { url };
        } else {
          const bytes = await readBytesCapped(request, MAX_UPLOAD_BYTES);
          if (!bytes) throw new Refusal(413, "too_large", "That picture is over 8 MB.");
          source = { bytes };
        }
        const site = await setPictureFor(account, handle, source, { now, ownHost: new URL(origin).hostname });
        return json({ site: siteJson(site, origin) });
      }
      if (method === "DELETE") {
        await limit(request, "write", account);
        return json({ site: siteJson(await removePictureFor(account, handle, now), origin) });
      }
    }

    return json({ error: "not_found", message: "Nothing is here. The guide is at GET /api/v1." }, 404);
  } catch (error) {
    if (error instanceof Refusal) return refusalResponse(error);
    throw error;
  }
}
