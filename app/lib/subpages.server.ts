import { env } from "cloudflare:workers";

import { requireFeature } from "./billing.server";
import type { Account } from "./db/accounts.server";
import type { Site } from "./db/sites.server";
import {
  createSubpage,
  deleteSubpage,
  rotateSubpage,
  type Subpage,
  subpageById,
  subpagesOf,
  updateSubpage,
} from "./db/subpages.server";
import { subpageUrl } from "./domains";
import { MAX_HEADLINE_LENGTH, MAX_TITLE_LENGTH } from "./limits";
import { MAX_ARTICLE_LENGTH } from "./markdown";
import { allows, MAX_SUBPAGES } from "./plans";
import { Refusal } from "./refusal";
import { requireOwnedSite } from "./sites.server";
import { pathFromTitle, subpagePathProblem } from "./subpages";

/** What may be sent to make or change a subpage. Absent fields keep their value. */
export interface SubpageInput {
  title?: unknown;
  headline?: unknown;
  body?: unknown;
  /** Its public path, or null to keep it private only; true makes one from the title. */
  path?: unknown;
}

/** Whether a site's subpages are shown to visitors: the site is published and its owner has Pro. */
export const subpagesVisible = (site: Site) => site.published && allows(site.ownerPlan, "subpages");

/** A subpage as the API and MCP describe it. */
export function subpageJson(site: Site, page: Subpage, origin: string) {
  const visible = subpagesVisible(site);
  return {
    id: page.id,
    title: page.title,
    headline: page.headline,
    body: page.body,
    path: page.path,
    // Its public, indexed address; null while it is private only.
    url: page.path ? subpageUrl(site, page.path, origin) : null,
    // Works alongside the public one; never indexed; rotate it to make a new one.
    private_url: subpageUrl(site, page.privateId, origin),
    markdown_url: `${subpageUrl(site, page.path ?? page.privateId, origin)}.md`,
    // Visitors see it only while the site is published and its owner has Pro.
    visible,
    created_at: new Date(page.createdAt * 1000).toISOString(),
    updated_at: new Date(page.updatedAt * 1000).toISOString(),
  };
}

function text(value: unknown, field: string, max: number, required = false): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Refusal(400, "invalid_field", `${field} must be text.`);
  const tidy = field === "body" ? value.replace(/\r\n?/g, "\n").trimEnd() : value.replace(/\s+/g, " ").trim();
  if (required && !tidy) throw new Refusal(400, "invalid_content", `A subpage needs a ${field}.`);
  if ([...tidy].length > max) throw new Refusal(400, "invalid_content", `A ${field} is at most ${max.toLocaleString("en")} characters.`);
  return tidy;
}

/** A subpage's fields as sent, checked; `title` is the title it will have, for making a path from it. */
function fieldsOf(input: SubpageInput, title: string | undefined) {
  const fields: { title?: string; headline?: string; body?: string; path?: string | null } = {};
  const newTitle = text(input.title, "title", MAX_TITLE_LENGTH, true);
  if (newTitle !== undefined) fields.title = newTitle;
  const headline = text(input.headline, "headline", MAX_HEADLINE_LENGTH);
  if (headline !== undefined) fields.headline = headline;
  const body = text(input.body, "body", MAX_ARTICLE_LENGTH);
  if (body !== undefined) fields.body = body;
  if (input.path === null || input.path === false) fields.path = null;
  else if (input.path === true) fields.path = pathFromTitle(newTitle ?? title ?? "");
  else if (typeof input.path === "string") fields.path = input.path.trim().toLowerCase().replace(/^\/+|\/+$/g, "");
  else if (input.path !== undefined) throw new Refusal(400, "invalid_field", "path must be text, true (made from the title) or null (private only).");
  if (typeof fields.path === "string") {
    const problem = subpagePathProblem(fields.path);
    if (problem) throw new Refusal(400, "invalid_path", problem);
  }
  return fields;
}

const pathTaken = () => new Refusal(409, "path_taken", "Another subpage of this site has that path. Choose another.");

async function requireSubpage(site: Site, id: string): Promise<Subpage> {
  const page = await subpageById(env.DB, site.id, id);
  if (!page) throw new Refusal(404, "not_found", `${site.handle} has no subpage ${id}. List them with GET …/pages.`);
  return page;
}

export async function listSubpagesFor(account: Account, handle: string, origin: string) {
  const site = await requireOwnedSite(account, handle);
  return (await subpagesOf(env.DB, site.id)).map((page) => subpageJson(site, page, origin));
}

export async function getSubpageFor(account: Account, handle: string, id: string, origin: string) {
  const site = await requireOwnedSite(account, handle);
  return subpageJson(site, await requireSubpage(site, id), origin);
}

/** Makes a subpage: private unless given a path. Needs Pro. */
export async function createSubpageFor(account: Account, handle: string, input: SubpageInput, now: number, origin: string) {
  await requireFeature(account, "subpages", origin);
  const site = await requireOwnedSite(account, handle);
  if (input.title === undefined) throw new Refusal(400, "invalid_content", "A subpage needs a title.");
  const fields = fieldsOf(input, undefined);
  const made = await createSubpage(env.DB, {
    siteId: site.id,
    title: fields.title!,
    headline: fields.headline ?? "",
    body: fields.body ?? "",
    path: fields.path ?? null,
    max: MAX_SUBPAGES,
    now,
  });
  if (!made.ok) {
    if (made.reason === "path_taken") throw pathTaken();
    throw new Refusal(403, "subpage_limit", `A site has at most ${MAX_SUBPAGES} subpages. Delete one first.`);
  }
  return subpageJson(site, await requireSubpage(site, made.id), origin);
}

/** Changes a subpage. Needs Pro, except to take it off its public address. */
export async function updateSubpageFor(account: Account, handle: string, id: string, input: SubpageInput, now: number, origin: string) {
  const site = await requireOwnedSite(account, handle);
  const page = await requireSubpage(site, id);
  const fields = fieldsOf(input, page.title);
  const onlyHides = Object.keys(fields).length === 1 && fields.path === null;
  if (!onlyHides) await requireFeature(account, "subpages", origin);
  if (Object.keys(fields).length > 0) {
    const result = await updateSubpage(env.DB, { siteId: site.id, id, fields, now });
    if (result === "path_taken") throw pathTaken();
  }
  return subpageJson(site, await requireSubpage(site, id), origin);
}

/** Gives a subpage a new private address; the old one stops working at once. Allowed on any plan. */
export async function rotateSubpageFor(account: Account, handle: string, id: string, now: number, origin: string) {
  const site = await requireOwnedSite(account, handle);
  await requireSubpage(site, id);
  await rotateSubpage(env.DB, { siteId: site.id, id, now });
  return subpageJson(site, await requireSubpage(site, id), origin);
}

/** Deletes a subpage for good. Allowed on any plan. */
export async function deleteSubpageFor(account: Account, handle: string, id: string): Promise<void> {
  const site = await requireOwnedSite(account, handle);
  if (!(await deleteSubpage(env.DB, site.id, id))) {
    throw new Refusal(404, "not_found", `${site.handle} has no subpage ${id}. List them with GET …/pages.`);
  }
}
