import { type PageButton, storedButtons } from "../buttons";
import { HANDLE_PATTERN, MIN_HANDLE_LENGTH, RESERVED_HANDLES } from "../handles";
import { newId } from "../ids";
import { MAX_HEADLINE_LENGTH, MAX_TITLE_LENGTH } from "../limits";
import { MAX_BODY_LENGTH } from "../markdown";

/** Sites one account may hold on the free plan (the legacy limit). */
export const MAX_SITES = 2;

/** What a page says: everything an owner or agent edits. */
export interface PageContent {
  title: string;
  headline: string;
  body: string;
  buttons: PageButton[];
}

export interface Page extends PageContent {
  id: string;
  imageKey: string | null;
  visibility: "public" | "unlisted";
}

export interface Site {
  id: string;
  ownerId: string;
  handle: string;
  published: boolean;
  publishedAt: number | null;
  theme: string;
  createdAt: number;
  /** The later of the site's and its main page's last change. */
  updatedAt: number;
  page: Page;
}

interface SiteRow {
  id: string;
  owner_id: string;
  handle: string;
  published_at: number | null;
  theme: string;
  created_at: number;
  updated_at: number;
  page_id: string;
  title: string;
  headline: string;
  body: string;
  buttons: string;
  image_key: string | null;
  visibility: "public" | "unlisted";
  page_updated_at: number;
}

const SELECT_SITE = `
  SELECT site.id, site.owner_id, site.handle, site.published_at, site.theme, site.created_at, site.updated_at,
         page.id AS page_id, page.title, page.headline, page.body, page.buttons, page.image_key, page.visibility,
         page.updated_at AS page_updated_at
  FROM sites AS site
  JOIN pages AS page ON page.site_id = site.id AND page.path = ''`;

function toSite(row: SiteRow): Site {
  return {
    id: row.id,
    ownerId: row.owner_id,
    handle: row.handle,
    published: row.published_at !== null,
    publishedAt: row.published_at,
    theme: row.theme,
    createdAt: row.created_at,
    updatedAt: Math.max(row.updated_at, row.page_updated_at),
    page: {
      id: row.page_id,
      title: row.title,
      headline: row.headline,
      body: row.body,
      buttons: storedButtons(row.buttons),
      imageKey: row.image_key,
      visibility: row.visibility,
    },
  };
}

/** A live (not deleted) site by its handle, published or not. */
export async function siteByHandle(db: D1Database, handle: string): Promise<Site | null> {
  const row = await db
    .prepare(`${SELECT_SITE} WHERE site.handle = ?1 AND site.deleted_at IS NULL`)
    .bind(handle.toLowerCase())
    .first<SiteRow>();
  return row ? toSite(row) : null;
}

/** An owner's live sites: published first, then by handle. */
export async function sitesOf(db: D1Database, ownerId: string): Promise<Site[]> {
  const { results } = await db
    .prepare(
      `${SELECT_SITE} WHERE site.owner_id = ?1 AND site.deleted_at IS NULL
       ORDER BY site.published_at IS NULL, site.handle`,
    )
    .bind(ownerId)
    .all<SiteRow>();
  return results.map(toSite);
}

/** One of an owner's sites by handle; null when it is not theirs. */
export async function ownedSite(db: D1Database, ownerId: string, handle: string): Promise<Site | null> {
  const site = await siteByHandle(db, handle);
  return site && site.ownerId === ownerId ? site : null;
}

/** Published, public sites for the sitemap: handle and last change. */
export async function publishedSites(db: D1Database, limit = 50_000): Promise<Array<{ handle: string; updatedAt: number }>> {
  const { results } = await db
    .prepare(
      `SELECT site.handle, max(site.updated_at, page.updated_at) AS updated_at
       FROM sites AS site JOIN pages AS page ON page.site_id = site.id AND page.path = ''
       WHERE site.deleted_at IS NULL AND site.published_at IS NOT NULL AND page.visibility = 'public'
       ORDER BY site.published_at LIMIT ?1`,
    )
    .bind(limit)
    .all<{ handle: string; updated_at: number }>();
  return results.map((row) => ({ handle: row.handle, updatedAt: row.updated_at }));
}

/**
 * Why page content cannot be saved, as a sentence; null when it can. Only
 * the fields given are checked, so an update can send some of them.
 */
export function contentProblem(content: Partial<PageContent>): string | null {
  if (content.title !== undefined) {
    if (!content.title.trim()) return "A page needs a title.";
    if ([...content.title].length > MAX_TITLE_LENGTH) return `A title is at most ${MAX_TITLE_LENGTH} characters.`;
  }
  if (content.headline !== undefined && [...content.headline].length > MAX_HEADLINE_LENGTH) {
    return `A headline is at most ${MAX_HEADLINE_LENGTH} characters.`;
  }
  if (content.body !== undefined && content.body.length > MAX_BODY_LENGTH) {
    return `The text is at most ${MAX_BODY_LENGTH} characters.`;
  }
  return null;
}

/** Content as stored: single-line title and headline, body without trailing space. */
function tidy(content: Partial<PageContent>): Partial<PageContent> {
  return {
    ...content,
    ...(content.title !== undefined ? { title: content.title.replace(/\s+/g, " ").trim() } : {}),
    ...(content.headline !== undefined ? { headline: content.headline.replace(/\s+/g, " ").trim() } : {}),
    ...(content.body !== undefined ? { body: content.body.replace(/\r\n?/g, "\n").trimEnd() } : {}),
  };
}

export type CreateResult =
  | { ok: true; site: Site }
  | { ok: false; code: "site_limit" | "handle_taken"; message: string };

function isUniqueViolation(error: unknown): boolean {
  return String(error).includes("UNIQUE");
}

/**
 * Makes a site with its main page, as a draft unless `publish`. The limit
 * on sites per account is part of the write, so two at once cannot pass it.
 * The handle must already have passed `handleProblem`.
 */
export async function createSite(
  db: D1Database,
  input: { ownerId: string; handle: string; content: PageContent; publish?: boolean; now: number },
): Promise<CreateResult> {
  const siteId = newId();
  const content = tidy(input.content) as PageContent;
  try {
    const [site] = await db.batch([
      db
        .prepare(
          `INSERT INTO sites (id, owner_id, handle, published_at, created_at, updated_at)
           SELECT ?1, ?2, ?3, ?4, ?5, ?5
           WHERE (SELECT count(*) FROM sites WHERE owner_id = ?2 AND deleted_at IS NULL) < ${MAX_SITES}`,
        )
        .bind(siteId, input.ownerId, input.handle, input.publish ? input.now : null, input.now),
      db
        .prepare(
          `INSERT INTO pages (id, site_id, path, title, headline, body, buttons, created_at, updated_at)
           SELECT ?1, ?2, '', ?3, ?4, ?5, ?6, ?7, ?7 WHERE EXISTS (SELECT 1 FROM sites WHERE id = ?2)`,
        )
        .bind(newId(), siteId, content.title, content.headline, content.body, JSON.stringify(content.buttons), input.now),
    ]);
    if (site!.meta.changes === 0) {
      return { ok: false, code: "site_limit", message: `An account has at most ${MAX_SITES} sites. Delete one to make another.` };
    }
  } catch (error) {
    if (isUniqueViolation(error)) return { ok: false, code: "handle_taken", message: "That handle is taken." };
    throw error;
  }
  return { ok: true, site: (await siteByHandle(db, input.handle))! };
}

/** Saves some or all of a page's content. False when the site is not the owner's. */
export async function updatePage(
  db: D1Database,
  input: { siteId: string; ownerId: string; content: Partial<PageContent>; now: number },
): Promise<boolean> {
  const content = tidy(input.content);
  const sets: string[] = [];
  const values: unknown[] = [input.siteId, input.ownerId, input.now];
  const set = (column: string, value: unknown) => {
    values.push(value);
    sets.push(`${column} = ?${values.length}`);
  };
  if (content.title !== undefined) set("title", content.title);
  if (content.headline !== undefined) set("headline", content.headline);
  if (content.body !== undefined) set("body", content.body);
  if (content.buttons !== undefined) set("buttons", JSON.stringify(content.buttons));
  const result = await db
    .prepare(
      `UPDATE pages SET ${[...sets, "updated_at = ?3"].join(", ")}
       WHERE path = '' AND site_id IN (SELECT id FROM sites WHERE id = ?1 AND owner_id = ?2 AND deleted_at IS NULL)`,
    )
    .bind(...values)
    .run();
  return result.meta.changes > 0;
}

/** Sets the main page's picture; returns the key it replaced, or false when not the owner's. */
export async function setPageImage(
  db: D1Database,
  input: { siteId: string; ownerId: string; imageKey: string | null; now: number },
): Promise<{ replaced: string | null } | false> {
  const previous = await db
    .prepare(
      `SELECT page.image_key FROM pages AS page JOIN sites AS site ON site.id = page.site_id
       WHERE site.id = ?1 AND site.owner_id = ?2 AND site.deleted_at IS NULL AND page.path = ''`,
    )
    .bind(input.siteId, input.ownerId)
    .first<{ image_key: string | null }>();
  if (!previous) return false;
  await db
    .prepare(`UPDATE pages SET image_key = ?2, updated_at = ?3 WHERE site_id = ?1 AND path = ''`)
    .bind(input.siteId, input.imageKey, input.now)
    .run();
  return { replaced: previous.image_key };
}

export type RenameResult = "renamed" | "same" | "taken" | "missing";

export async function renameSite(
  db: D1Database,
  input: { siteId: string; ownerId: string; handle: string; now: number },
): Promise<RenameResult> {
  try {
    const result = await db
      .prepare(
        `UPDATE sites SET handle = ?3, updated_at = ?4
         WHERE id = ?1 AND owner_id = ?2 AND deleted_at IS NULL AND handle != ?3`,
      )
      .bind(input.siteId, input.ownerId, input.handle, input.now)
      .run();
    if (result.meta.changes > 0) return "renamed";
  } catch (error) {
    if (isUniqueViolation(error)) return "taken";
    throw error;
  }
  const same = await db
    .prepare(`SELECT 1 FROM sites WHERE id = ?1 AND owner_id = ?2 AND deleted_at IS NULL AND handle = ?3`)
    .bind(input.siteId, input.ownerId, input.handle)
    .first();
  return same ? "same" : "missing";
}

/** Publishes or unpublishes a site; publishing again keeps the first date. */
export async function setPublished(
  db: D1Database,
  input: { siteId: string; ownerId: string; published: boolean; now: number },
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE sites SET published_at = ${input.published ? "COALESCE(published_at, ?3)" : "NULL"}, updated_at = ?3
       WHERE id = ?1 AND owner_id = ?2 AND deleted_at IS NULL`,
    )
    .bind(input.siteId, input.ownerId, input.now)
    .run();
  return result.meta.changes > 0;
}

/**
 * Deletes a site: its handle is free at once, the row stays for the record,
 * and the picture key is returned so the file can go too.
 */
export async function deleteSite(
  db: D1Database,
  input: { siteId: string; ownerId: string; now: number },
): Promise<{ imageKey: string | null } | false> {
  const row = await db
    .prepare(
      `UPDATE sites SET deleted_at = ?3, published_at = NULL, updated_at = ?3
       WHERE id = ?1 AND owner_id = ?2 AND deleted_at IS NULL
       RETURNING (SELECT image_key FROM pages WHERE site_id = ?1 AND path = '') AS image_key`,
    )
    .bind(input.siteId, input.ownerId, input.now)
    .first<{ image_key: string | null }>();
  if (!row) return false;
  await db.prepare(`UPDATE pages SET image_key = NULL WHERE site_id = ?1`).bind(input.siteId).run();
  return { imageKey: row.image_key };
}

/** Whether a handle is free for a new or renamed site. */
export async function handleFree(db: D1Database, handle: string): Promise<boolean> {
  const row = await db.prepare(`SELECT 1 FROM sites WHERE handle = ?1 AND deleted_at IS NULL`).bind(handle).first();
  return !row;
}

/**
 * A free handle for a new site, from what is known about its owner (their
 * Telegram username, email name, or name), as the legacy bot did: the first
 * that fits, else one with a short random ending.
 */
export async function suggestHandle(db: D1Database, candidates: Array<string | null | undefined>): Promise<string> {
  const bases: string[] = [];
  for (const candidate of candidates) {
    const base = (candidate ?? "")
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9_]+/g, "_")
      .replace(/^[^a-z]+/, "")
      .replace(/_+/g, "_")
      .replace(/_+$/, "")
      .slice(0, 24);
    if (base && HANDLE_PATTERN.test(base)) bases.push(base);
  }
  for (const base of bases) {
    if (base.length >= MIN_HANDLE_LENGTH && !RESERVED_HANDLES.has(base) && (await handleFree(db, base))) return base;
  }
  const base = bases[0] ?? "page";
  for (;;) {
    const suffix = [...crypto.getRandomValues(new Uint8Array(2))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    const handle = `${base}_${suffix}`;
    if (await handleFree(db, handle)) return handle;
  }
}

/**
 * A short fingerprint of what a page's cover shows, so the cover's address
 * changes whenever it does and caches never serve an old one.
 */
export function coverVersion(site: Pick<Site, "handle" | "page">): string {
  const text = [site.handle, site.page.title, site.page.headline, site.page.body, site.page.imageKey ?? "", "1"].join("\u0000");
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
}
