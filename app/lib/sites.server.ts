import { env } from "cloudflare:workers";

import { parseButtons } from "./buttons";
import type { Account } from "./db/accounts.server";
import {
  contentProblem,
  createSite,
  deleteSite,
  ownedSite,
  type PageContent,
  renameSite,
  setPageImage,
  setPublished,
  type Site,
  sitesOf,
  suggestHandle,
  updatePage,
} from "./db/sites.server";
import { handleProblem, normalizeHandle } from "./handles";
import { deleteMedia, mediaUrl, PICTURE_PROBLEMS, storePicture, storePictureFrom } from "./media.server";

/**
 * What the editor, the API and the MCP server do to sites, in one place, so
 * each checks the same rules. A refusal carries an HTTP status, a stable
 * code for programs, and a sentence for people.
 */
export class Refusal extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** What may be sent to make or change a site. Absent fields are left as they are. */
export interface SiteInput {
  handle?: unknown;
  title?: unknown;
  headline?: unknown;
  body?: unknown;
  buttons?: unknown;
  published?: unknown;
}

function text(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Refusal(400, "invalid_field", `${field} must be text.`);
  return value;
}

/** The content fields of an input, checked; only those given. */
function contentOf(input: SiteInput): Partial<PageContent> {
  const content: Partial<PageContent> = {};
  const title = text(input.title, "title");
  if (title !== undefined) content.title = title;
  const headline = text(input.headline, "headline");
  if (headline !== undefined) content.headline = headline;
  const body = text(input.body, "body");
  if (body !== undefined) content.body = body;
  if (input.buttons !== undefined) {
    const buttons = parseButtons(input.buttons);
    if (!buttons.ok) throw new Refusal(400, "invalid_buttons", buttons.problem);
    content.buttons = buttons.buttons;
  }
  const problem = contentProblem(content);
  if (problem) throw new Refusal(400, "invalid_content", problem);
  return content;
}

function checkedHandle(value: unknown, account: Account): string {
  if (typeof value !== "string") throw new Refusal(400, "invalid_handle", "handle must be text.");
  const handle = normalizeHandle(value);
  const problem = handleProblem(handle, { telegramUsername: account.telegram?.username });
  if (problem) throw new Refusal(400, "invalid_handle", problem);
  return handle;
}

export async function requireOwnedSite(account: Account, handle: string): Promise<Site> {
  const site = await ownedSite(env.DB, account.id, normalizeHandle(handle));
  if (!site) throw new Refusal(404, "not_found", `You have no site called ${normalizeHandle(handle)}.`);
  return site;
}

export function listSites(account: Account): Promise<Site[]> {
  return sitesOf(env.DB, account.id);
}

/**
 * Makes a site. Without a handle one is suggested from the account (its
 * Telegram username, email name or name); without a title, the account's
 * name. It is a draft unless `published` is true.
 */
export async function createSiteFor(account: Account, input: SiteInput, now: number): Promise<Site> {
  const handle =
    input.handle === undefined || input.handle === ""
      ? await suggestHandle(env.DB, [account.telegram?.username, account.email?.split("@")[0], account.name])
      : checkedHandle(input.handle, account);
  const content = contentOf(input);
  const result = await createSite(env.DB, {
    ownerId: account.id,
    handle,
    content: {
      title: content.title ?? account.name,
      headline: content.headline ?? "",
      body: content.body ?? "",
      buttons: content.buttons ?? [],
    },
    publish: input.published === true,
    now,
  });
  if (!result.ok) throw new Refusal(result.code === "handle_taken" ? 409 : 403, result.code, result.message);
  return result.site;
}

/** Changes a site: its content, its handle, and whether it is published. */
export async function updateSiteFor(account: Account, currentHandle: string, input: SiteInput, now: number): Promise<Site> {
  const site = await requireOwnedSite(account, currentHandle);
  const content = contentOf(input);
  if (input.published !== undefined && typeof input.published !== "boolean") {
    throw new Refusal(400, "invalid_field", "published must be true or false.");
  }
  let handle = site.handle;
  if (input.handle !== undefined && normalizeHandle(String(input.handle)) !== site.handle) {
    handle = checkedHandle(input.handle, account);
    const renamed = await renameSite(env.DB, { siteId: site.id, ownerId: account.id, handle, now });
    if (renamed === "taken") throw new Refusal(409, "handle_taken", "That handle is taken.");
  }
  if (Object.keys(content).length > 0) {
    await updatePage(env.DB, { siteId: site.id, ownerId: account.id, content, now });
  }
  if (typeof input.published === "boolean" && input.published !== site.published) {
    await setPublished(env.DB, { siteId: site.id, ownerId: account.id, published: input.published, now });
  }
  return requireOwnedSite(account, handle);
}

export async function deleteSiteFor(account: Account, handle: string, now: number): Promise<void> {
  const site = await requireOwnedSite(account, handle);
  const deleted = await deleteSite(env.DB, { siteId: site.id, ownerId: account.id, now });
  if (deleted) await deleteMedia(deleted.imageKey);
}

/** Sets a site's picture from uploaded bytes or a public address. */
export async function setPictureFor(
  account: Account,
  handle: string,
  source: { bytes: Uint8Array<ArrayBuffer> } | { url: string },
  input: { now: number; ownHost: string },
): Promise<Site> {
  const site = await requireOwnedSite(account, handle);
  const stored = "bytes" in source ? await storePicture(source.bytes) : await storePictureFrom(source.url, [input.ownHost]);
  if (!stored.ok) throw new Refusal(stored.reason === "failed" ? 422 : 400, `picture_${stored.reason}`, PICTURE_PROBLEMS[stored.reason]);
  const result = await setPageImage(env.DB, { siteId: site.id, ownerId: account.id, imageKey: stored.key, now: input.now });
  if (!result) {
    await deleteMedia(stored.key);
    throw new Refusal(404, "not_found", "That site is gone.");
  }
  await deleteMedia(result.replaced);
  return requireOwnedSite(account, site.handle);
}

export async function removePictureFor(account: Account, handle: string, now: number): Promise<Site> {
  const site = await requireOwnedSite(account, handle);
  const result = await setPageImage(env.DB, { siteId: site.id, ownerId: account.id, imageKey: null, now });
  if (result) await deleteMedia(result.replaced);
  return requireOwnedSite(account, site.handle);
}

/** A site as the API and MCP describe it. */
export function siteJson(site: Site, origin: string) {
  return {
    handle: site.handle,
    url: `${origin}/${site.handle}`,
    markdown_url: `${origin}/${site.handle}.md`,
    published: site.published,
    published_at: site.publishedAt ? new Date(site.publishedAt * 1000).toISOString() : null,
    updated_at: new Date(site.updatedAt * 1000).toISOString(),
    title: site.page.title,
    headline: site.page.headline,
    body: site.page.body,
    buttons: site.page.buttons,
    picture: site.page.imageKey ? mediaUrl(site.page.imageKey, origin) : null,
  };
}
