import { newId } from "../ids";
import { hashToken } from "./tokens.server";

/** How long a sign-in or linking token works. */
export const TELEGRAM_TOKEN_SECONDS = 10 * 60;

export type TelegramTokenPurpose = "login" | "link";

/** A one-time token for an account; only its hash is kept. */
export async function issueTelegramToken(
  db: D1Database,
  input: { userId: string; purpose: TelegramTokenPurpose; now: number },
): Promise<string> {
  const token = newId(24);
  await db
    .prepare(`INSERT INTO telegram_tokens (token_hash, purpose, user_id, expires_at) VALUES (?1, ?2, ?3, ?4)`)
    .bind(await hashToken(token), input.purpose, input.userId, input.now + TELEGRAM_TOKEN_SECONDS)
    .run();
  return token;
}

/** The account a token was for, without using it up; null when unknown or expired. */
export async function peekTelegramToken(
  db: D1Database,
  token: string,
  purpose: TelegramTokenPurpose,
  now: number,
): Promise<string | null> {
  if (!/^[0-9A-Za-z]{24}$/.test(token)) return null;
  const row = await db
    .prepare(`SELECT user_id FROM telegram_tokens WHERE token_hash = ?1 AND purpose = ?2 AND expires_at >= ?3`)
    .bind(await hashToken(token), purpose, now)
    .first<{ user_id: string }>();
  return row?.user_id ?? null;
}

/** Uses a token up: claimed and deleted in one statement, so it works once. */
export async function claimTelegramToken(
  db: D1Database,
  token: string,
  purpose: TelegramTokenPurpose,
  now: number,
): Promise<string | null> {
  if (!/^[0-9A-Za-z]{24}$/.test(token)) return null;
  const row = await db
    .prepare(`DELETE FROM telegram_tokens WHERE token_hash = ?1 AND purpose = ?2 RETURNING user_id, expires_at`)
    .bind(await hashToken(token), purpose)
    .first<{ user_id: string; expires_at: number }>();
  return row && row.expires_at >= now ? row.user_id : null;
}

/** Forgets expired tokens. */
export async function sweepTelegramTokens(db: D1Database, now: number): Promise<void> {
  await db.prepare(`DELETE FROM telegram_tokens WHERE expires_at < ?1`).bind(now).run();
}
