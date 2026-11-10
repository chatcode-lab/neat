import { env } from "cloudflare:workers";

import { rememberTelegramUser, userForTelegram } from "../db/accounts.server";
import { startSession } from "../sessions.server";
import type { TelegramUser } from "./verify";

/**
 * Signs in the account a verified Telegram identity is linked to: a Set-Cookie
 * header for its new session, or null when no account has it linked (new
 * accounts are made with Google only).
 */
export async function telegramSession(
  request: Request,
  user: TelegramUser,
  options: { embedded?: boolean } = {},
): Promise<string | null> {
  const now = Math.floor(Date.now() / 1000);
  const userId = await userForTelegram(env.DB, user.id);
  if (!userId) return null;
  await rememberTelegramUser(env.DB, user, now);
  return startSession(env.DB, { userId, request, secret: env.BETTER_AUTH_SECRET, now, embedded: options.embedded });
}

/** The bot's numeric ID, the part of its token before the colon; also its Telegram Login client ID. */
export function botId(): string {
  return env.TELEGRAM_BOT_TOKEN.split(":")[0] ?? "";
}
