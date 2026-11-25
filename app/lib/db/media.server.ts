/** A file an account uploaded to embed in its pages. */
export interface MediaFile {
  id: string;
  key: string;
  name: string;
  type: string;
  size: number;
  createdAt: number;
}

interface MediaRow {
  id: string;
  key: string;
  name: string;
  type: string;
  size: number;
  created_at: number;
}

const toFile = (row: MediaRow): MediaFile => ({
  id: row.id,
  key: row.key,
  name: row.name,
  type: row.type,
  size: row.size,
  createdAt: row.created_at,
});

/** How much an account has uploaded: bytes and files. */
export async function mediaUsage(db: D1Database, userId: string): Promise<{ bytes: number; files: number }> {
  const row = await db
    .prepare(`SELECT coalesce(sum(size), 0) AS bytes, count(*) AS files FROM media WHERE user_id = ?1`)
    .bind(userId)
    .first<{ bytes: number; files: number }>();
  return { bytes: row?.bytes ?? 0, files: row?.files ?? 0 };
}

/** An account's files, newest first. */
export async function filesOf(db: D1Database, userId: string, limit = 1000): Promise<MediaFile[]> {
  const { results } = await db
    .prepare(`SELECT id, key, name, type, size, created_at FROM media WHERE user_id = ?1 ORDER BY created_at DESC, id LIMIT ?2`)
    .bind(userId, limit)
    .all<MediaRow>();
  return results.map(toFile);
}

/**
 * Records a stored file, unless it would take the account past its quota
 * or its number of files; the check is part of the write. False when it
 * would.
 */
export async function addFile(
  db: D1Database,
  input: { id: string; userId: string; key: string; name: string; type: string; size: number; quota: number; maxFiles: number; now: number },
): Promise<boolean> {
  const result = await db
    .prepare(
      `INSERT INTO media (id, user_id, key, name, type, size, created_at)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7
       WHERE (SELECT coalesce(sum(size), 0) FROM media WHERE user_id = ?2) + ?6 <= ?8
         AND (SELECT count(*) FROM media WHERE user_id = ?2) < ?9`,
    )
    .bind(input.id, input.userId, input.key, input.name, input.type, input.size, input.now, input.quota, input.maxFiles)
    .run();
  return result.meta.changes > 0;
}

/** Forgets one of an account's files; its key, for removing it from the bucket, or null when it was not theirs. */
export async function removeFile(db: D1Database, userId: string, id: string): Promise<string | null> {
  const row = await db
    .prepare(`DELETE FROM media WHERE id = ?1 AND user_id = ?2 RETURNING key`)
    .bind(id, userId)
    .first<{ key: string }>();
  return row?.key ?? null;
}
