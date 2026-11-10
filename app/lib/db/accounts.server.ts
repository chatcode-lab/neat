import { newId } from "../ids";
import { type TelegramUser, telegramName } from "../telegram/verify";

/** Placeholder emails end here: a reserved name no mail reaches (RFC 2606). */
export const PLACEHOLDER_DOMAIN = "telegram.invalid";

/** The email an account made from a Telegram identity alone carries. */
export function placeholderEmail(telegramId: number | string): string {
  return `tg-${telegramId}@${PLACEHOLDER_DOMAIN}`;
}

export function isPlaceholderEmail(email: string): boolean {
  return email.endsWith(`@${PLACEHOLDER_DOMAIN}`);
}

/** The signed-in person as the app sees them. */
export interface Account {
  id: string;
  name: string;
  /** Their Google email; null while only Telegram is linked. */
  email: string | null;
  image: string | null;
  google: boolean;
  telegram: { id: string; username: string | null; name: string } | null;
}

export async function accountRecord(db: D1Database, userId: string): Promise<Account | null> {
  const [user, accounts] = await db.batch([
    db.prepare(`SELECT id, name, email, image FROM "user" WHERE id = ?1`).bind(userId),
    db
      .prepare(
        `SELECT account."providerId" AS provider, account."accountId" AS account_id, tg.username, tg.name
         FROM "account" AS account
         LEFT JOIN telegram_users AS tg ON account."providerId" = 'telegram' AND tg.telegram_id = account."accountId"
         WHERE account."userId" = ?1`,
      )
      .bind(userId),
  ]);
  const row = user!.results[0] as { id: string; name: string; email: string; image: string | null } | undefined;
  if (!row) return null;
  const linked = accounts!.results as Array<{ provider: string; account_id: string; username: string | null; name: string | null }>;
  const telegram = linked.find((entry) => entry.provider === "telegram");
  return {
    id: row.id,
    name: row.name,
    email: isPlaceholderEmail(row.email) ? null : row.email,
    image: row.image,
    google: linked.some((entry) => entry.provider === "google"),
    telegram: telegram
      ? { id: telegram.account_id, username: telegram.username, name: telegram.name ?? row.name }
      : null,
  };
}

/** The account a Telegram identity is linked to, if any. */
export async function userForTelegram(db: D1Database, telegramId: number | string): Promise<string | null> {
  const row = await db
    .prepare(`SELECT "userId" AS user_id FROM "account" WHERE "providerId" = 'telegram' AND "accountId" = ?1`)
    .bind(String(telegramId))
    .first<{ user_id: string }>();
  return row?.user_id ?? null;
}

/** Keeps what Telegram last said about a person: username and name. */
export async function rememberTelegramUser(db: D1Database, user: TelegramUser, now: number): Promise<void> {
  await db
    .prepare(
      `INSERT INTO telegram_users (telegram_id, username, name, updated_at) VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT (telegram_id) DO UPDATE SET username = excluded.username, name = excluded.name, updated_at = excluded.updated_at`,
    )
    .bind(String(user.id), user.username, telegramName(user), now)
    .run();
}

export type LinkResult = "linked" | "already_linked" | "taken" | "has_other";

/**
 * Links a Telegram identity to an account, as its owner asked in Settings
 * and confirmed in the bot. One Telegram identity per account, and each
 * linked to one account.
 */
export async function linkTelegram(db: D1Database, userId: string, user: TelegramUser, now: number): Promise<LinkResult> {
  const owner = await userForTelegram(db, user.id);
  if (owner === userId) return "already_linked";
  if (owner) return "taken";
  const stamp = new Date(now * 1000).toISOString();
  // The check that the account has no Telegram yet is part of the insert,
  // and a unique index backs it, so two confirmations at once link one.
  let linked: boolean;
  try {
    const result = await db
      .prepare(
        `INSERT INTO "account" ("id", "accountId", "providerId", "userId", "createdAt", "updatedAt")
         SELECT ?1, ?2, 'telegram', ?3, ?4, ?4
         WHERE NOT EXISTS (SELECT 1 FROM "account" WHERE "userId" = ?3 AND "providerId" = 'telegram')`,
      )
      .bind(newId(), String(user.id), userId, stamp)
      .run();
    linked = result.meta.changes > 0;
  } catch {
    // A unique index: this Telegram linked elsewhere, or another one here, at the same moment.
    const holder = await userForTelegram(db, user.id);
    if (holder === userId) return "already_linked";
    if (holder) return "taken";
    return "has_other";
  }
  if (!linked) return "has_other";
  await rememberTelegramUser(db, user, now);
  return "linked";
}

/**
 * Unlinks Telegram from an account that can still sign in with Google; an
 * account with Telegram alone would be locked out, so it keeps it.
 */
export async function unlinkTelegram(db: D1Database, userId: string): Promise<boolean> {
  const result = await db
    .prepare(
      `DELETE FROM "account" WHERE "userId" = ?1 AND "providerId" = 'telegram'
         AND EXISTS (SELECT 1 FROM "account" WHERE "userId" = ?1 AND "providerId" = 'google')`,
    )
    .bind(userId)
    .run();
  return result.meta.changes > 0;
}

/**
 * Gives an account that had only a placeholder its Google email, once
 * Google is linked, unless another account already has that email.
 */
export async function adoptGoogleEmail(db: D1Database, userId: string, email: string, now: number): Promise<void> {
  await db
    .prepare(
      `UPDATE "user" SET "email" = ?2, "emailVerified" = 1, "updatedAt" = ?3
       WHERE "id" = ?1 AND "email" LIKE '%@' || ?4
         AND NOT EXISTS (SELECT 1 FROM "user" WHERE "email" = ?2)`,
    )
    .bind(userId, email, new Date(now * 1000).toISOString(), PLACEHOLDER_DOMAIN)
    .run();
}
