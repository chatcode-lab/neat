import { env } from "cloudflare:workers";

import { readSmallJson } from "~/lib/security/body";
import { handleUpdate, type TgUpdate } from "~/lib/telegram/bot.server";

import type { Route } from "./+types/telegram-webhook";

function sameSecret(given: string, expected: string): boolean {
  if (!expected || given.length !== expected.length) return false;
  let difference = 0;
  for (let index = 0; index < given.length; index += 1) difference |= given.charCodeAt(index) ^ expected.charCodeAt(index);
  return difference === 0;
}

/**
 * Telegram's webhook for the bot. Telegram proves itself with the secret
 * set by `npm run telegram:setup`. Every genuine update is answered 200,
 * even when handling it failed, so Telegram does not send it again.
 */
export async function action({ request, context }: Route.ActionArgs) {
  if (!sameSecret(request.headers.get("X-Telegram-Bot-Api-Secret-Token") ?? "", env.TELEGRAM_WEBHOOK_SECRET)) {
    return new Response("Forbidden", { status: 403 });
  }
  const update = (await readSmallJson(request, 256 * 1024)) as TgUpdate | undefined;
  if (update && typeof update.update_id === "number") {
    await handleUpdate(update, new URL(request.url).origin);
  }
  return new Response(null, { status: 200 });
}

export function loader() {
  return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST" } });
}
