import { wwwTwin } from "../domains";

export interface ConnectedDomain {
  /** The domain as connected; a request to its www twin is sent here. */
  hostname: string;
  handle: string;
  /** The later of the site's and its main page's last change. */
  updatedAt: number;
}

/**
 * The published site a domain, or its twin with or without www, is
 * connected to; null when none is. The domain itself wins over its twin.
 */
export async function connectedDomain(db: D1Database, hostname: string): Promise<ConnectedDomain | null> {
  const row = await db
    .prepare(
      `SELECT domain.hostname, site.handle, max(site.updated_at, page.updated_at) AS updated_at
       FROM domains AS domain
       JOIN sites AS site ON site.id = domain.site_id
       JOIN pages AS page ON page.site_id = site.id AND page.path = ''
       WHERE domain.hostname IN (?1, ?2) AND site.deleted_at IS NULL AND site.published_at IS NOT NULL
       ORDER BY domain.hostname = ?1 DESC
       LIMIT 1`,
    )
    .bind(hostname, wwwTwin(hostname))
    .first<{ hostname: string; handle: string; updated_at: number }>();
  return row ? { hostname: row.hostname, handle: row.handle, updatedAt: row.updated_at } : null;
}
