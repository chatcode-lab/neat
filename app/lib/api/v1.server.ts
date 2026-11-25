import { env } from "cloudflare:workers";

import guide from "../../../docs/api.md?raw";
import { accountPlan, billingPortal, planJson, requireFeature, startCheckout } from "../billing.server";
import { type Account, accountRecord } from "../db/accounts.server";
import type { MediaFile } from "../db/media.server";
import { userForToken } from "../db/tokens.server";
import { handleFree } from "../db/sites.server";
import { checkDomainFor, domainFor, removeDomainFor, setDomainFor } from "../domain-setup.server";
import { embedKind } from "../files";
import { handleProblem, normalizeHandle } from "../handles";
import { deleteFile, listFiles, MAX_UPLOAD_BYTES, mediaUrl, storeFile, storeFileFrom } from "../media.server";
import { MAX_FILE_BYTES } from "../plans";
import { readBodyCapped, readBytesCapped } from "../security/body";
import { RATE_LIMITED_MESSAGE, withinLimits } from "../security/rate-limit.server";
import {
  createSubpageFor,
  deleteSubpageFor,
  getSubpageFor,
  listSubpagesFor,
  rotateSubpageFor,
  type SubpageInput,
  updateSubpageFor,
} from "../subpages.server";
import { makeUploadLink, readUploadLink, UPLOAD_LINK_SECONDS } from "../upload-links.server";
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

/** JSON bodies: room for a long article, under the Worker's cut-off for every body. */
const JSON_LIMIT = 480 * 1024;

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

/** A request's JSON object: a site's or subpage's fields, or another endpoint's. */
type Body = SiteInput & SubpageInput & Record<string, unknown>;

async function body(request: Request): Promise<Body> {
  const text = await readBodyCapped(request, JSON_LIMIT);
  if (text === null) throw new Refusal(413, "too_large", "The body is over 480 KB.");
  try {
    const value = JSON.parse(text || "{}") as unknown;
    if (value && typeof value === "object" && !Array.isArray(value)) return value as Body;
  } catch {
    // Answered below.
  }
  throw new Refusal(400, "invalid_json", "Send a JSON object.");
}

/** The account as the API describes it. */
async function meJson(account: Account) {
  return {
    id: account.id,
    name: account.name,
    email: account.email,
    google: account.google,
    telegram: account.telegram ? { id: account.telegram.id, username: account.telegram.username } : null,
    plan: (await accountPlan(account)).plan,
  };
}

/** An uploaded file as the API describes it, with the Markdown that embeds it in a page. */
function fileJson(file: MediaFile, origin: string) {
  const url = mediaUrl(file.key, origin);
  const kind = embedKind(file.key);
  const words = file.name.replace(/[[\]\\]/g, "").replace(/\.[a-z0-9]{2,5}$/i, "");
  return {
    id: file.id,
    name: file.name,
    type: file.type,
    size: file.size,
    url,
    markdown: kind === "pdf" ? `[${words || "PDF"}](${url})` : `![${words}](${url})`,
    uploaded_at: new Date(file.createdAt * 1000).toISOString(),
  };
}

/** A file in a request: its bytes, or {"url": …} to fetch it from; its name from ?name= or the JSON. */
async function receiveFile(request: Request, userId: string, now: number, origin: string): Promise<Response> {
  const url = new URL(request.url);
  let stored;
  if ((request.headers.get("Content-Type") ?? "").startsWith("application/json")) {
    const { url: from, name } = await body(request);
    if (typeof from !== "string") throw new Refusal(400, "invalid_field", 'Send {"url": "https://…"} or the file itself.');
    stored = await storeFileFrom(userId, from, typeof name === "string" ? name : null, [new URL(origin).hostname], now);
  } else {
    const bytes = await readBytesCapped(request, MAX_FILE_BYTES);
    if (!bytes) throw new Refusal(413, "too_large", "A file is at most 25 MB.");
    stored = await storeFile(userId, bytes, url.searchParams.get("name"), now);
  }
  if (!stored.ok) {
    const status = stored.reason === "too_large" ? 413 : stored.reason === "quota" ? 403 : stored.reason === "failed" ? 422 : 400;
    throw new Refusal(status, stored.reason === "not_allowed" ? "file_type" : stored.reason === "quota" ? "media_quota" : stored.reason === "too_large" ? "too_large" : "file_failed", stored.message);
  }
  return json({ file: fileJson(stored.file, origin) }, 201);
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
    // An upload link carries its own signature instead of a token.
    if (segments[0] === "media" && segments[1] === "upload" && segments.length === 3 && (method === "PUT" || method === "POST")) {
      const userId = await readUploadLink(segments[2]!, now);
      const account = userId ? await accountRecord(env.DB, userId) : null;
      if (!account) throw new Refusal(401, "unauthorized", "That upload link is not valid or has expired. Ask for a new one.");
      await limit(request, "upload", account);
      await requireFeature(account, "media", origin);
      return await receiveFile(request, account.id, now, origin);
    }

    const account = await accountOf(request, now);
    const [resource, handle, part, id, action] = segments;

    if (resource === "me" && segments.length === 1 && method === "GET") {
      await limit(request, "read", account);
      return json(await meJson(account));
    }

    if (resource === "plan" && segments.length === 1 && method === "GET") {
      await limit(request, "read", account);
      return json(await planJson(account));
    }

    if (resource === "checkout" && segments.length === 1 && method === "POST") {
      await limit(request, "write", account);
      const { product } = await body(request);
      const checkout = await startCheckout(account, product, origin);
      return json({ ...checkout, note: "Give this link to the account's owner to pay. The plan changes as soon as they have paid." }, 201);
    }

    if (resource === "billing" && segments.length === 1 && method === "POST") {
      await limit(request, "write", account);
      return json(await billingPortal(account, origin), 201);
    }

    if (resource === "media") {
      if (segments.length === 1 && method === "GET") {
        await limit(request, "read", account);
        const plan = await planJson(account);
        return json({
          files: (await listFiles(account.id)).map((file) => fileJson(file, origin)),
          used_bytes: plan.usage.media_bytes,
          quota_bytes: plan.limits.media_bytes,
        });
      }
      if (segments.length === 1 && method === "POST") {
        await limit(request, "upload", account);
        await requireFeature(account, "media", origin);
        return await receiveFile(request, account.id, now, origin);
      }
      if (segments.length === 2 && handle === "upload-link" && method === "POST") {
        await limit(request, "write", account);
        await requireFeature(account, "media", origin);
        const link = await makeUploadLink(account.id, now, origin);
        return json(
          {
            url: link.url,
            expires_at: new Date(link.expiresAt * 1000).toISOString(),
            how: `PUT the file's bytes to url within ${UPLOAD_LINK_SECONDS / 60} minutes, with ?name=<file name> if you like: curl -T photo.jpg "<url>?name=photo.jpg"`,
          },
          201,
        );
      }
      if (segments.length === 2 && handle && method === "DELETE") {
        await limit(request, "write", account);
        if (!(await deleteFile(account.id, handle))) throw new Refusal(404, "not_found", "The account has no file with that ID.");
        return json({ deleted: handle });
      }
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

    if (resource === "sites" && handle && part === "domain") {
      if (segments.length === 3 && method === "GET") {
        await limit(request, "read", account);
        return json({ domain: await domainFor(account, handle) });
      }
      if (segments.length === 3 && (method === "PUT" || method === "POST")) {
        await limit(request, "write", account);
        const { hostname } = await body(request);
        return json({ domain: await setDomainFor(account, handle, hostname, now, origin) });
      }
      if (segments.length === 4 && id === "check" && method === "POST") {
        await limit(request, "write", account);
        return json({ domain: await checkDomainFor(account, handle, now, origin) });
      }
      if (segments.length === 3 && method === "DELETE") {
        await limit(request, "write", account);
        await removeDomainFor(account, handle);
        return json({ deleted: true });
      }
    }

    if (resource === "sites" && handle && part === "pages") {
      if (segments.length === 3 && method === "GET") {
        await limit(request, "read", account);
        return json({ pages: await listSubpagesFor(account, handle, origin) });
      }
      if (segments.length === 3 && method === "POST") {
        await limit(request, "write", account);
        return json({ page: await createSubpageFor(account, handle, await body(request), now, origin) }, 201);
      }
      if (segments.length === 4 && id) {
        if (method === "GET") {
          await limit(request, "read", account);
          return json({ page: await getSubpageFor(account, handle, id, origin) });
        }
        if (method === "PATCH") {
          await limit(request, "write", account);
          return json({ page: await updateSubpageFor(account, handle, id, await body(request), now, origin) });
        }
        if (method === "DELETE") {
          await limit(request, "write", account);
          await deleteSubpageFor(account, handle, id);
          return json({ deleted: id });
        }
      }
      if (segments.length === 5 && id && action === "rotate" && method === "POST") {
        await limit(request, "write", account);
        return json({ page: await rotateSubpageFor(account, handle, id, now, origin) });
      }
    }

    return json({ error: "not_found", message: "Nothing is here. The guide is at GET /api/v1." }, 404);
  } catch (error) {
    if (error instanceof Refusal) return refusalResponse(error);
    throw error;
  }
}
