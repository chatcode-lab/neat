import { env } from "cloudflare:workers";

import { readSmallJson } from "~/lib/security/body";
import { withinLimits } from "~/lib/security/rate-limit.server";
import { telegramSession } from "~/lib/telegram/signin.server";
import { verifyInitData } from "~/lib/telegram/verify";

import type { Route } from "./+types/auth-telegram-webapp";

/**
 * Signs in from the Mini App: the page at /tg posts the initData Telegram
 * opened it with. The cookie is made to work inside Telegram's web clients'
 * frame too.
 */
export async function action({ request }: Route.ActionArgs) {
  const answer = (body: Record<string, unknown>, headers: HeadersInit = {}) =>
    Response.json(body, { headers: { "Cache-Control": "no-store", ...headers } });
  if (!(await withinLimits(request, "signin", null))) return answer({ ok: false, error: "rate_limited" });
  const input = (await readSmallJson(request, 8192)) as { initData?: unknown } | undefined;
  const launch =
    typeof input?.initData === "string"
      ? await verifyInitData(input.initData, env.TELEGRAM_BOT_TOKEN, Math.floor(Date.now() / 1000))
      : null;
  if (!launch) return answer({ ok: false, error: "invalid" });
  const cookie = await telegramSession(request, launch.user, { embedded: true });
  if (!cookie) return answer({ ok: false, error: "not_linked" });
  return answer({ ok: true, next: "/app" }, { "Set-Cookie": cookie });
}

export function loader() {
  return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST" } });
}
