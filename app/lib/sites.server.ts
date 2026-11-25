import { env } from "cloudflare:workers";

import { parseButtons } from "./buttons";
import type { Account } from "./db/accounts.server";
import { billingOf } from "./db/billing.server";
import {
  contentProblem,
  createSite,
  deleteSite,
  ownedSite,
  type PageContent,
  publishLimitMessage,
  renameSite,
  setPageImage,
  setPublished,
  setSiteSettings,
  type Site,
  siteCounts,
  sitesOf,
  suggestHandle,
  updatePage,
} from "./db/sites.server";
import { siteMarkdownUrl, siteUrl } from "./domains";
import { parsePixels, PIXEL_VENDOR_IDS, type Pixels } from "./pixels";
import { allows, type Plan, PLAN_LIMITS, planRequiredMessage } from "./plans";
import { handleProblem, normalizeHandle } from "./handles";
import { deleteMedia, mediaUrl, PICTURE_PROBLEMS, storePicture, storePictureFrom } from "./media.server";
import { removeSiteDomain } from "./domain-setup.server";
import { Refusal } from "./refusal";

export { Refusal };

/*
 * What the editor, the API and the MCP server do to sites, in one place, so
 * each checks the same rules.
 */

/** What may be sent to make or change a site. Absent fields are left as they are. */
export interface SiteInput {
  handle?: unknown;
  title?: unknown;
  headline?: unknown;
  body?: unknown;
  buttons?: unknown;
  published?: unknown;
  /** Pro: tracking pixels, {"google": "G-…", "meta": "…", "tiktok": "…"}; an empty ID removes one. */
  pixels?: unknown;
  /** Pro: false hides the neat.link sign at the bottom of the site's pages. */
  branding?: unknown;
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
  const { plan } = await billingOf(env.DB, account.id);
  const handle =
    input.handle === undefined || input.handle === ""
      ? await suggestHandle(env.DB, [account.telegram?.username, account.email?.split("@")[0], account.name])
      : checkedHandle(input.handle, account);
  const content = contentOf(input);
  // Settings are checked before the site is made, so a refusal leaves nothing behind.
  const settings = checkedSettings(input, {}, true, plan);
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
    limits: PLAN_LIMITS[plan],
    now,
  });
  if (!result.ok) throw new Refusal(result.code === "handle_taken" ? 409 : 403, result.code, result.message);
  if (settings.pixels === undefined && settings.branding === undefined) return result.site;
  await setSiteSettings(env.DB, { siteId: result.site.id, ownerId: account.id, ...settings, now });
  return requireOwnedSite(account, result.site.handle);
}

/**
 * A site's Pro settings as sent, checked: tracking pixels merged into the
 * current ones, and whether to show the neat.link sign. They may always be
 * turned off or left as they are; adding a pixel or hiding the sign needs
 * Pro.
 */
function checkedSettings(
  input: SiteInput,
  current: Pixels,
  showsBranding: boolean,
  plan: Plan,
): { pixels?: Pixels; branding?: boolean } {
  if (input.branding !== undefined && typeof input.branding !== "boolean") {
    throw new Refusal(400, "invalid_field", "branding must be true or false.");
  }
  let pixels: Pixels | undefined;
  if (input.pixels !== undefined) {
    const parsed = parsePixels(input.pixels, current);
    if (!parsed.ok) throw new Refusal(400, "invalid_pixels", parsed.problem);
    pixels = parsed.pixels;
  }
  const addsPixel = pixels !== undefined && PIXEL_VENDOR_IDS.some((vendor) => pixels[vendor] && pixels[vendor] !== current[vendor]);
  if (addsPixel && !allows(plan, "pixels")) throw planRequired("pixels");
  if (input.branding === false && showsBranding && !allows(plan, "branding")) throw planRequired("branding");
  return { pixels, branding: input.branding as boolean | undefined };
}

function planRequired(feature: Parameters<typeof planRequiredMessage>[0]): Refusal {
  return new Refusal(402, "plan_required", `${planRequiredMessage(feature)} See the plans at /app/plan, or ask for a payment link with POST /api/v1/checkout.`);
}

/** Changes a site: its content, its handle, and whether it is published. */
export async function updateSiteFor(account: Account, currentHandle: string, input: SiteInput, now: number): Promise<Site> {
  const site = await requireOwnedSite(account, currentHandle);
  const content = contentOf(input);
  if (input.published !== undefined && typeof input.published !== "boolean") {
    throw new Refusal(400, "invalid_field", "published must be true or false.");
  }
  const settings = checkedSettings(input, site.pixels, site.branding, site.ownerPlan);
  // A publish past the plan's limit is refused before anything else is saved.
  const limits = PLAN_LIMITS[site.ownerPlan];
  if (input.published === true && !site.published && (await siteCounts(env.DB, account.id)).published >= limits.published) {
    throw new Refusal(403, "publish_limit", publishLimitMessage(limits));
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
  if (settings.pixels !== undefined || settings.branding !== undefined) {
    await setSiteSettings(env.DB, { siteId: site.id, ownerId: account.id, ...settings, now });
  }
  if (typeof input.published === "boolean" && input.published !== site.published) {
    // The limit holds in the write too, for two publishes at once.
    const done = await setPublished(env.DB, { siteId: site.id, ownerId: account.id, published: input.published, maxPublished: limits.published, now });
    if (!done && input.published) throw new Refusal(403, "publish_limit", publishLimitMessage(limits));
  }
  return requireOwnedSite(account, handle);
}

export async function deleteSiteFor(account: Account, handle: string, now: number): Promise<void> {
  const site = await requireOwnedSite(account, handle);
  // Its domain goes first, so the name is free and nothing is left billed.
  await removeSiteDomain(site.id);
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
    url: siteUrl(site, origin),
    markdown_url: siteMarkdownUrl(site, origin),
    domain: site.domain,
    published: site.published,
    published_at: site.publishedAt ? new Date(site.publishedAt * 1000).toISOString() : null,
    updated_at: new Date(site.updatedAt * 1000).toISOString(),
    title: site.page.title,
    headline: site.page.headline,
    body: site.page.body,
    buttons: site.page.buttons,
    picture: site.page.imageKey ? mediaUrl(site.page.imageKey, origin) : null,
    // Pro settings: kept whatever the plan, shown on the page only with Pro.
    pixels: site.pixels,
    branding: site.branding,
    pro_active: allows(site.ownerPlan, "pixels"),
  };
}
