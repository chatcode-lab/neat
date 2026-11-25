import { newId, newPostId } from "../ids";
import { hasProSql, servedDomainSql } from "./billing.server";
import { coverVersion, type Site } from "./sites.server";

/**
 * A site's subpage, such as an article: reachable at its private address,
 * neat.link/<handle>/<private ID>, and once made public, also at its path,
 * neat.link/<handle>/<path>.
 */
export interface Subpage {
  id: string;
  siteId: string;
  /** Its public address below the site; null while it has none. */
  path: string | null;
  /** Its private address below the site, never indexed; rotating it makes a new one. */
  privateId: string;
  title: string;
  headline: string;
  body: string;
  createdAt: number;
  updatedAt: number;
}

interface SubpageRow {
  id: string;
  site_id: string;
  path: string | null;
  private_id: string;
  title: string;
  headline: string;
  body: string;
  created_at: number;
  updated_at: number;
}

const SELECT_SUBPAGE = `SELECT id, site_id, path, private_id, title, headline, body, created_at, updated_at FROM pages`;

const toSubpage = (row: SubpageRow): Subpage => ({
  id: row.id,
  siteId: row.site_id,
  path: row.path,
  privateId: row.private_id,
  title: row.title,
  headline: row.headline,
  body: row.body,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

/** A site's subpages, newest first. */
export async function subpagesOf(db: D1Database, siteId: string): Promise<Subpage[]> {
  const { results } = await db
    .prepare(`${SELECT_SUBPAGE} WHERE site_id = ?1 AND private_id IS NOT NULL ORDER BY created_at DESC, id`)
    .bind(siteId)
    .all<SubpageRow>();
  return results.map(toSubpage);
}

export async function subpageById(db: D1Database, siteId: string, id: string): Promise<Subpage | null> {
  const row = await db
    .prepare(`${SELECT_SUBPAGE} WHERE site_id = ?1 AND id = ?2 AND private_id IS NOT NULL`)
    .bind(siteId, id)
    .first<SubpageRow>();
  return row ? toSubpage(row) : null;
}

/**
 * The subpage at an address below a site: its path, or else its private ID.
 * `via` says which, since only the public one may be indexed.
 */
export async function subpageAt(db: D1Database, siteId: string, segment: string): Promise<{ page: Subpage; via: "path" | "private" } | null> {
  const row = await db
    .prepare(
      `${SELECT_SUBPAGE} WHERE site_id = ?1 AND private_id IS NOT NULL AND (path = ?2 OR private_id = ?2)
       ORDER BY path = ?2 DESC LIMIT 1`,
    )
    .bind(siteId, segment)
    .first<SubpageRow>();
  if (!row) return null;
  return { page: toSubpage(row), via: row.path === segment ? "path" : "private" };
}

/** Whether an address below a site is free for a path: no other subpage's path or private ID. */
async function pathFree(db: D1Database, siteId: string, path: string, exceptId?: string): Promise<boolean> {
  const row = await db
    .prepare(`SELECT 1 FROM pages WHERE site_id = ?1 AND (path = ?2 OR private_id = ?2) AND id != ?3`)
    .bind(siteId, path, exceptId ?? "")
    .first();
  return !row;
}

export type SubpageWrite = "ok" | "missing" | "limit" | "path_taken";

/**
 * Makes a subpage with a fresh private ID, unless the site already has
 * `max`; the limit is part of the write. Its ID, or why not.
 */
export async function createSubpage(
  db: D1Database,
  input: { siteId: string; title: string; headline: string; body: string; path: string | null; max: number; now: number },
): Promise<{ ok: true; id: string } | { ok: false; reason: "limit" | "path_taken" }> {
  if (input.path !== null && !(await pathFree(db, input.siteId, input.path))) return { ok: false, reason: "path_taken" };
  const id = newId();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const privateId = newPostId(12);
    try {
      const result = await db
        .prepare(
          `INSERT INTO pages (id, site_id, path, private_id, title, headline, body, created_at, updated_at)
           SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8
           WHERE (SELECT count(*) FROM pages WHERE site_id = ?2 AND private_id IS NOT NULL) < ?9
             AND NOT EXISTS (SELECT 1 FROM pages WHERE site_id = ?2 AND path = ?4)`,
        )
        .bind(id, input.siteId, input.path, privateId, input.title, input.headline, input.body, input.now, input.max)
        .run();
      if (result.meta.changes > 0) return { ok: true, id };
      // Refused: the limit, or a private ID that is another page's path, which a new one fixes.
      const { n } = (await db
        .prepare(`SELECT count(*) AS n FROM pages WHERE site_id = ?1 AND private_id IS NOT NULL`)
        .bind(input.siteId)
        .first<{ n: number }>())!;
      if (n >= input.max) return { ok: false, reason: "limit" };
    } catch (error) {
      if (!String(error).includes("UNIQUE")) throw error;
      if (input.path !== null && !(await pathFree(db, input.siteId, input.path))) return { ok: false, reason: "path_taken" };
    }
  }
  throw new Error("No free private ID for a subpage.");
}

/** Saves some of a subpage's fields; `path: null` takes it off its public address. */
export async function updateSubpage(
  db: D1Database,
  input: { siteId: string; id: string; fields: Partial<Pick<Subpage, "title" | "headline" | "body" | "path">>; now: number },
): Promise<SubpageWrite> {
  const { fields } = input;
  if (fields.path !== undefined && fields.path !== null && !(await pathFree(db, input.siteId, fields.path, input.id))) return "path_taken";
  const sets: string[] = [];
  const values: unknown[] = [input.siteId, input.id, input.now];
  for (const column of ["title", "headline", "body", "path"] as const) {
    if (fields[column] === undefined) continue;
    values.push(fields[column]);
    sets.push(`${column} = ?${values.length}`);
  }
  try {
    const result = await db
      .prepare(`UPDATE pages SET ${[...sets, "updated_at = ?3"].join(", ")} WHERE site_id = ?1 AND id = ?2 AND private_id IS NOT NULL`)
      .bind(...values)
      .run();
    return result.meta.changes > 0 ? "ok" : "missing";
  } catch (error) {
    if (String(error).includes("UNIQUE")) return "path_taken";
    throw error;
  }
}

/** Gives a subpage a new private ID, so the old private address stops working. The new ID, or null when missing. */
export async function rotateSubpage(db: D1Database, input: { siteId: string; id: string; now: number }): Promise<string | null> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const privateId = newPostId(12);
    try {
      const row = await db
        .prepare(
          `UPDATE pages SET private_id = ?3, updated_at = ?4
           WHERE site_id = ?1 AND id = ?2 AND private_id IS NOT NULL
             AND NOT EXISTS (SELECT 1 FROM pages WHERE site_id = ?1 AND path = ?3)
           RETURNING private_id`,
        )
        .bind(input.siteId, input.id, privateId, input.now)
        .first<{ private_id: string }>();
      if (row) return row.private_id;
      if (!(await subpageById(db, input.siteId, input.id))) return null;
    } catch (error) {
      if (!String(error).includes("UNIQUE")) throw error;
    }
  }
  throw new Error("No free private ID for a subpage.");
}

export async function deleteSubpage(db: D1Database, siteId: string, id: string): Promise<boolean> {
  const result = await db.prepare(`DELETE FROM pages WHERE site_id = ?1 AND id = ?2 AND private_id IS NOT NULL`).bind(siteId, id).run();
  return result.meta.changes > 0;
}

/** A site's public subpages, for its Markdown and its domain's sitemap: path, title, last change. */
export async function publicSubpages(db: D1Database, siteId: string): Promise<Array<{ path: string; title: string; updatedAt: number }>> {
  const { results } = await db
    .prepare(
      `SELECT page.path, page.title, page.updated_at FROM pages AS page JOIN sites AS site ON site.id = page.site_id
       WHERE page.site_id = ?1 AND page.private_id IS NOT NULL AND page.path IS NOT NULL AND ${hasProSql("site.owner_id")}
       ORDER BY page.created_at DESC LIMIT 1000`,
    )
    .bind(siteId)
    .all<{ path: string; title: string; updated_at: number }>();
  return results.map((row) => ({ path: row.path, title: row.title, updatedAt: row.updated_at }));
}

/**
 * Public subpages for neat.link's sitemap: of published sites whose owner
 * has Pro and which have no domain of their own (those are in its sitemap).
 */
export async function sitemapSubpages(db: D1Database, limit: number): Promise<Array<{ handle: string; path: string; updatedAt: number }>> {
  const { results } = await db
    .prepare(
      `SELECT site.handle, page.path, page.updated_at FROM pages AS page JOIN sites AS site ON site.id = page.site_id
       WHERE page.private_id IS NOT NULL AND page.path IS NOT NULL
         AND site.deleted_at IS NULL AND site.published_at IS NOT NULL
         AND ${servedDomainSql("site")} IS NULL
         AND ${hasProSql("site.owner_id")}
       ORDER BY page.created_at LIMIT ?1`,
    )
    .bind(limit)
    .all<{ handle: string; path: string; updated_at: number }>();
  return results.map((row) => ({ handle: row.handle, path: row.path, updatedAt: row.updated_at }));
}

/**
 * A subpage's cover version: what its cover shows (its title, words and
 * public address, its site's name and picture) and the design.
 */
export function subpageCoverVersion(site: Site, page: Subpage): string {
  return coverVersion({
    handle: `${site.handle}/${page.path ?? ""}`,
    domain: site.domain,
    page: { ...site.page, title: page.title, headline: site.page.title, body: page.headline || page.body.slice(0, 2000) },
  });
}
