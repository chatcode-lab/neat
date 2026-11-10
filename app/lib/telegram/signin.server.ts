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

/** The bot's numeric ID, the part of its token before the colon. */
export function botId(): string {
  return env.TELEGRAM_BOT_TOKEN.split(":")[0] ?? "";
}

/**
 * Telegram's own sign-in page for this bot, which sends the person back to
 * `returnTo` with the signed answer in the address's #tgAuthResult. It is
 * what the Login Widget opens, used directly so the page needs no script.
 * BotFather's /setdomain must name this site's domain.
 */
export function telegramLoginUrl(origin: string, returnTo: string): string {
  const url = new URL("https://oauth.telegram.org/auth");
  url.searchParams.set("bot_id", botId());
  url.searchParams.set("origin", origin);
  url.searchParams.set("request_access", "write");
  url.searchParams.set("return_to", returnTo);
  return url.href;
}
