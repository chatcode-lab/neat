import { wwwTwin } from "../domains";
import { hasDomainsSql } from "./billing.server";

export interface ConnectedDomain {
  /** The domain as connected; a request to its www twin is sent here. */
  hostname: string;
  siteId: string;
  handle: string;
  /** The later of the site's and its main page's last change. */
  updatedAt: number;
}

/**
 * The published site a domain, or its twin with or without www, is
 * connected to; null when none is, or its owner's plan no longer has own
 * domains. The domain itself wins over its twin.
 */
export async function connectedDomain(db: D1Database, hostname: string): Promise<ConnectedDomain | null> {
  const row = await db
    .prepare(
      `SELECT domain.hostname, site.id AS site_id, site.handle, max(site.updated_at, page.updated_at) AS updated_at
       FROM domains AS domain
       JOIN sites AS site ON site.id = domain.site_id
       JOIN pages AS page ON page.site_id = site.id AND page.path = ''
       WHERE domain.hostname IN (?1, ?2) AND domain.status = 'active'
         AND site.deleted_at IS NULL AND site.published_at IS NOT NULL
         AND ${hasDomainsSql("site.owner_id")}
       ORDER BY domain.hostname = ?1 DESC
       LIMIT 1`,
    )
    .bind(hostname, wwwTwin(hostname))
    .first<{ hostname: string; site_id: string; handle: string; updated_at: number }>();
  return row ? { hostname: row.hostname, siteId: row.site_id, handle: row.handle, updatedAt: row.updated_at } : null;
}

/** A site's domain, connected or waiting for its DNS. */
export interface DomainRecord {
  siteId: string;
  hostname: string;
  code: string;
  kind: "saas" | "route";
  status: "pending" | "active";
  zone: string | null;
  provider: string | null;
  cfId: string | null;
  sslStatus: string | null;
  registeredAt: number | null;
  cfHttpPath: string | null;
  cfHttpBody: string | null;
  stalledAt: number | null;
  error: string | null;
  createdAt: number;
  checkedAt: number | null;
  verifiedAt: number | null;
  lostAt: number | null;
}

interface DomainRow {
  site_id: string;
  hostname: string;
  code: string;
  kind: "saas" | "route";
  status: "pending" | "active";
  zone: string | null;
  provider: string | null;
  cf_id: string | null;
  ssl_status: string | null;
  registered_at: number | null;
  cf_http_path: string | null;
  cf_http_body: string | null;
  stalled_at: number | null;
  error: string | null;
  created_at: number;
  checked_at: number | null;
  verified_at: number | null;
  lost_at: number | null;
}

const toRecord = (row: DomainRow): DomainRecord => ({
  siteId: row.site_id,
  hostname: row.hostname,
  code: row.code,
  kind: row.kind,
  status: row.status,
  zone: row.zone,
  provider: row.provider,
  cfId: row.cf_id,
  sslStatus: row.ssl_status,
  registeredAt: row.registered_at,
  cfHttpPath: row.cf_http_path,
  cfHttpBody: row.cf_http_body,
  stalledAt: row.stalled_at,
  error: row.error,
  createdAt: row.created_at,
  checkedAt: row.checked_at,
  verifiedAt: row.verified_at,
  lostAt: row.lost_at,
});

export async function domainOf(db: D1Database, siteId: string): Promise<DomainRecord | null> {
  const row = await db.prepare(`SELECT * FROM domains WHERE site_id = ?1`).bind(siteId).first<DomainRow>();
  return row ? toRecord(row) : null;
}

/** Whether another site holds this name, connected. */
export async function domainHeldElsewhere(db: D1Database, hostname: string, siteId: string): Promise<boolean> {
  const row = await db
    .prepare(`SELECT 1 FROM domains WHERE hostname = ?1 AND status = 'active' AND site_id != ?2`)
    .bind(hostname, siteId)
    .first();
  return Boolean(row);
}

/**
 * Puts a site's custom hostname, as its row is now, on the list to delete
 * at Cloudflare, and returns it, also when it was on the list already.
 */
const staleFrom = (db: D1Database, siteId: string, now: number) =>
  db
    .prepare(
      `INSERT INTO stale_hostnames (cf_id, hostname, created_at)
       SELECT cf_id, hostname, ?2 FROM domains WHERE site_id = ?1 AND cf_id IS NOT NULL
       ON CONFLICT (cf_id) DO UPDATE SET hostname = excluded.hostname RETURNING cf_id`,
    )
    .bind(siteId, now);

/**
 * Starts a site's claim on a domain, replacing any claim it had. The
 * replaced claim's custom hostname, should a check have just made it, goes
 * on the list to delete in the same transaction, so it cannot be lost.
 */
export async function claimDomain(
  db: D1Database,
  input: { siteId: string; hostname: string; code: string; zone: string | null; provider: string | null; now: number },
): Promise<string[]> {
  const [stale] = await db.batch([
    staleFrom(db, input.siteId, input.now),
    db
      .prepare(
        `INSERT INTO domains (site_id, hostname, code, kind, status, zone, provider, created_at)
         VALUES (?1, ?2, ?3, 'saas', 'pending', ?4, ?5, ?6)
         ON CONFLICT (site_id) DO UPDATE SET hostname = excluded.hostname, code = excluded.code, kind = 'saas',
           status = 'pending', zone = excluded.zone, provider = excluded.provider, cf_id = NULL, ssl_status = NULL,
           registered_at = NULL, cf_http_path = NULL, cf_http_body = NULL, stalled_at = NULL,
           error = NULL, created_at = excluded.created_at, checked_at = NULL, verified_at = NULL, lost_at = NULL`,
      )
      .bind(input.siteId, input.hostname, input.code, input.zone, input.provider, input.now),
  ]);
  return (stale!.results as Array<{ cf_id: string }>).map((row) => row.cf_id);
}

/** Puts a custom hostname nothing names any more on the list to delete at Cloudflare. */
export async function queueStaleHostname(db: D1Database, cfId: string, hostname: string, now: number): Promise<void> {
  await db
    .prepare(`INSERT INTO stale_hostnames (cf_id, hostname, created_at) VALUES (?1, ?2, ?3) ON CONFLICT DO NOTHING`)
    .bind(cfId, hostname, now)
    .run();
}

/** Custom hostnames still to delete at Cloudflare, oldest first. */
export async function staleHostnames(db: D1Database, limit: number): Promise<string[]> {
  const { results } = await db
    .prepare(`SELECT cf_id FROM stale_hostnames WHERE deleted_at IS NULL ORDER BY created_at LIMIT ?1`)
    .bind(limit)
    .all<{ cf_id: string }>();
  return results.map((row) => row.cf_id);
}

/**
 * Starts deleting a listed custom hostname, should no claim hold it, in one
 * statement: from then no claim may take it up (see saveDomainCheck), so
 * none is left naming a hostname Cloudflare deleted. True when started.
 */
export async function startDeletingHostname(db: D1Database, cfId: string, now: number): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE stale_hostnames SET deleting_at = coalesce(deleting_at, ?2)
       WHERE cf_id = ?1 AND deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM domains WHERE cf_id = ?1)`,
    )
    .bind(cfId, now)
    .run();
  return result.meta.changes > 0;
}

/** A custom hostname deleted at Cloudflare: kept a day, so a check that found it just before cannot take it up. */
export async function hostnameDeleted(db: D1Database, cfId: string, now: number): Promise<void> {
  await db.prepare(`UPDATE stale_hostnames SET deleted_at = ?2 WHERE cf_id = ?1`).bind(cfId, now).run();
}

/** Forgets custom hostnames deleted at Cloudflare before then. */
export async function pruneDeletedHostnames(db: D1Database, before: number): Promise<void> {
  await db.prepare(`DELETE FROM stale_hostnames WHERE deleted_at <= ?1`).bind(before).run();
}

/**
 * Takes a custom hostname off the list should a claim hold it again (the
 * same name connected anew), checked in the same statement, so a last
 * claim letting go meanwhile leaves it listed.
 */
export async function forgetHeldHostname(db: D1Database, cfId: string): Promise<void> {
  await db
    .prepare(`DELETE FROM stale_hostnames WHERE cf_id = ?1 AND deleting_at IS NULL AND EXISTS (SELECT 1 FROM domains WHERE cf_id = ?1)`)
    .bind(cfId)
    .run();
}

/**
 * Records a check's result: "saved"; "taken" when turning active failed
 * because another site took the same name first (the claim stays pending,
 * with that as its error); "deleting" when the custom hostname it found is
 * being deleted at Cloudflare, so it was not taken up, and nothing saved;
 * or "gone" when the claim was disconnected or replaced while the check
 * ran, so nothing was saved.
 */
export async function saveDomainCheck(
  db: D1Database,
  siteId: string,
  code: string,
  changes: Partial<
    Pick<
      DomainRecord,
      "status" | "cfId" | "sslStatus" | "registeredAt" | "cfHttpPath" | "cfHttpBody" | "stalledAt" | "error" | "checkedAt" | "verifiedAt" | "lostAt"
    >
  >,
): Promise<"saved" | "taken" | "deleting" | "gone"> {
  const columns: Record<string, string> = {
    status: "status",
    cfId: "cf_id",
    sslStatus: "ssl_status",
    registeredAt: "registered_at",
    cfHttpPath: "cf_http_path",
    cfHttpBody: "cf_http_body",
    stalledAt: "stalled_at",
    error: "error",
    checkedAt: "checked_at",
    verifiedAt: "verified_at",
    lostAt: "lost_at",
  };
  const sets: string[] = [];
  const values: unknown[] = [siteId, code];
  for (const [field, value] of Object.entries(changes)) {
    if (value === undefined) continue;
    values.push(value);
    sets.push(`${columns[field]} = ?${values.length}`);
  }
  if (sets.length === 0) sets.push("site_id = site_id");
  // A hostname being deleted is never taken up, checked in the same statement.
  let unlisted = "";
  if (changes.cfId) {
    values.push(changes.cfId);
    unlisted = ` AND NOT EXISTS (SELECT 1 FROM stale_hostnames WHERE cf_id = ?${values.length} AND deleting_at IS NOT NULL)`;
  }
  try {
    // The code keeps a check that raced a new claim from writing over it.
    const result = await db
      .prepare(`UPDATE domains SET ${sets.join(", ")} WHERE site_id = ?1 AND code = ?2${unlisted}`)
      .bind(...values)
      .run();
    if (result.meta.changes > 0) return "saved";
    const claimed = await db.prepare(`SELECT 1 FROM domains WHERE site_id = ?1 AND code = ?2`).bind(siteId, code).first();
    return claimed && changes.cfId ? "deleting" : "gone";
  } catch (error) {
    if (!String(error).includes("UNIQUE")) throw error;
    const result = await db
      .prepare(`UPDATE domains SET error = ?3, checked_at = ?4 WHERE site_id = ?1 AND code = ?2`)
      .bind(siteId, code, "Another page is connected to this domain.", changes.checkedAt ?? null)
      .run();
    return result.meta.changes > 0 ? "taken" : "gone";
  }
}

/** Deletes a site's claim; its custom hostname, as it is at that moment, goes on the list to delete at Cloudflare. */
export async function dropDomain(db: D1Database, siteId: string, now: number): Promise<{ record: DomainRecord | null; stale: string[] }> {
  const [stale, dropped] = await db.batch([staleFrom(db, siteId, now), db.prepare(`DELETE FROM domains WHERE site_id = ?1 RETURNING *`).bind(siteId)]);
  const row = dropped!.results[0] as DomainRow | undefined;
  return { record: row ? toRecord(row) : null, stale: (stale!.results as Array<{ cf_id: string }>).map((entry) => entry.cf_id) };
}

/** The answer Cloudflare expects at a path of a domain it was asked to make, to prove the domain points here. */
export async function ownershipAnswer(db: D1Database, hostname: string, path: string): Promise<string | null> {
  const row = await db
    .prepare(`SELECT cf_http_body FROM domains WHERE hostname = ?1 AND cf_http_path = ?2 AND cf_id IS NOT NULL LIMIT 1`)
    .bind(hostname, path)
    .first<{ cf_http_body: string | null }>();
  return row?.cf_http_body ?? null;
}

/**
 * Domains the hourly check looks at, with whether their owner's plan still
 * has own domains: claims waiting for DNS (hourly for a week, then daily),
 * and connected ones (daily), oldest check first.
 */
export async function domainsToCheck(db: D1Database, now: number, limit: number): Promise<Array<DomainRecord & { entitled: boolean }>> {
  const { results } = await db
    .prepare(
      `SELECT domain.*, ${hasDomainsSql("site.owner_id")} AS entitled
       FROM domains AS domain JOIN sites AS site ON site.id = domain.site_id
       WHERE domain.kind = 'saas' AND site.deleted_at IS NULL
         AND coalesce(domain.checked_at, 0) < CASE
           WHEN domain.status = 'pending' AND (domain.created_at > ?1 - 7 * 86400 OR domain.cf_id IS NOT NULL) THEN ?1 - 3000
           ELSE ?1 - 86000 END
       ORDER BY coalesce(domain.checked_at, 0) LIMIT ?2`,
    )
    .bind(now, limit)
    .all<DomainRow & { entitled: number }>();
  return results.map((row) => ({ ...toRecord(row), entitled: row.entitled === 1 }));
}

/** Custom hostnames whose site is gone, to delete at Cloudflare; the rows go with them. */
export async function orphanedHostnames(db: D1Database): Promise<Array<{ siteId: string; cfId: string }>> {
  const { results } = await db
    .prepare(
      `SELECT domain.site_id, domain.cf_id FROM domains AS domain JOIN sites AS site ON site.id = domain.site_id
       WHERE domain.cf_id IS NOT NULL AND site.deleted_at IS NOT NULL LIMIT 100`,
    )
    .all<{ site_id: string; cf_id: string }>();
  return results.map((row) => ({ siteId: row.site_id, cfId: row.cf_id }));
}
