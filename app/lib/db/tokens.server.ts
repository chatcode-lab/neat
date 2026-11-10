import { newId } from "../ids";

/** A token looks like this, so a leaked one is easy to spot and search for. */
export const TOKEN_PREFIX = "neat_";

/** Tokens an owner may make by hand at once. */
export const MAX_TOKENS = 5;

/**
 * Tokens apps connected through OAuth may hold at once; connecting one more
 * revokes the one used longest ago, since apps reconnect without asking.
 */
export const MAX_APP_TOKENS = 10;

const LABEL_LIMIT = 60;

/** How often a token's last use is written, so a read costs no write. */
const LAST_USED_PRECISION = 3600;

export async function hashToken(token: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export interface TokenInfo {
  id: string;
  label: string | null;
  app: boolean;
  createdAt: number;
  lastUsedAt: number | null;
}

/** An owner's live tokens and app connections, newest first. */
export async function listTokens(db: D1Database, userId: string): Promise<TokenInfo[]> {
  const { results } = await db
    .prepare(
      `SELECT id, label, client_id, created_at, last_used_at FROM api_tokens
       WHERE user_id = ?1 AND revoked_at IS NULL ORDER BY created_at DESC`,
    )
    .bind(userId)
    .all<{ id: string; label: string | null; client_id: string | null; created_at: number; last_used_at: number | null }>();
  return results.map((row) => ({
    id: row.id,
    label: row.label,
    app: row.client_id !== null,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
  }));
}

/**
 * Makes a token by hand, shown once to its owner. Null when they already
 * hold as many as they may; the check is part of the write.
 */
export async function createToken(db: D1Database, input: { userId: string; label: string; now: number }): Promise<string | null> {
  const token = `${TOKEN_PREFIX}${newId(40)}`;
  const result = await db
    .prepare(
      `INSERT INTO api_tokens (id, user_id, token_hash, label, created_at)
       SELECT ?1, ?2, ?3, ?4, ?5
       WHERE (SELECT count(*) FROM api_tokens WHERE user_id = ?2 AND client_id IS NULL AND revoked_at IS NULL) < ${MAX_TOKENS}`,
    )
    .bind(newId(), input.userId, await hashToken(token), input.label.trim().slice(0, LABEL_LIMIT) || null, input.now)
    .run();
  return result.meta.changes > 0 ? token : null;
}

/** A token for an app that connected through OAuth, revoking the least used beyond the limit. */
export async function createAppToken(
  db: D1Database,
  input: { userId: string; clientId: string; label: string; now: number },
): Promise<string> {
  const token = `${TOKEN_PREFIX}${newId(40)}`;
  await db.batch([
    db
      .prepare(
        `UPDATE api_tokens SET revoked_at = ?2
         WHERE id IN (
           SELECT id FROM api_tokens
           WHERE user_id = ?1 AND client_id IS NOT NULL AND revoked_at IS NULL
           ORDER BY COALESCE(last_used_at, created_at) DESC, created_at DESC
           LIMIT -1 OFFSET ${MAX_APP_TOKENS - 1}
         )`,
      )
      .bind(input.userId, input.now),
    db
      .prepare(
        `INSERT INTO api_tokens (id, user_id, token_hash, label, client_id, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
      )
      .bind(newId(), input.userId, await hashToken(token), input.label.slice(0, LABEL_LIMIT), input.clientId, input.now),
  ]);
  return token;
}

/** The account a presented token acts for, or null when it is unknown or revoked. */
export async function userForToken(db: D1Database, token: string, now: number): Promise<{ userId: string; tokenId: string } | null> {
  if (!token.startsWith(TOKEN_PREFIX) || token.length > 100) return null;
  const row = await db
    .prepare(
      `SELECT token.id, token.user_id, token.last_used_at FROM api_tokens AS token
       JOIN "user" ON "user"."id" = token.user_id
       WHERE token.token_hash = ?1 AND token.revoked_at IS NULL`,
    )
    .bind(await hashToken(token))
    .first<{ id: string; user_id: string; last_used_at: number | null }>();
  if (!row) return null;
  if (row.last_used_at === null || row.last_used_at < now - LAST_USED_PRECISION) {
    await db.prepare(`UPDATE api_tokens SET last_used_at = ?2 WHERE id = ?1`).bind(row.id, now).run();
  }
  return { userId: row.user_id, tokenId: row.id };
}

/** Revokes one of an owner's tokens or app connections. */
export async function revokeToken(db: D1Database, input: { userId: string; tokenId: string; now: number }): Promise<boolean> {
  const result = await db
    .prepare(`UPDATE api_tokens SET revoked_at = ?3 WHERE id = ?1 AND user_id = ?2 AND revoked_at IS NULL`)
    .bind(input.tokenId, input.userId, input.now)
    .run();
  return result.meta.changes > 0;
}

/** Revokes a token presented by whoever holds it, as RFC 7009 has apps do. */
export async function revokePresentedToken(db: D1Database, token: string, now: number): Promise<void> {
  if (!token.startsWith(TOKEN_PREFIX) || token.length > 100) return;
  await db
    .prepare(`UPDATE api_tokens SET revoked_at = ?2 WHERE token_hash = ?1 AND revoked_at IS NULL`)
    .bind(await hashToken(token), now)
    .run();
}
