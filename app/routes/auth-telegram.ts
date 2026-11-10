import { redirect } from "react-router";

import { withinLimits } from "~/lib/security/rate-limit.server";
import { safeReturnPath } from "~/lib/security/request";
import { startTelegramLogin } from "~/lib/telegram/login.server";

import type { Route } from "./+types/auth-telegram";

/** "Sign in with Telegram": off to Telegram Login, back at /auth/telegram/callback. */
export async function loader({ request, url }: Route.LoaderArgs) {
  const next = safeReturnPath(url.searchParams.get("next") ?? "/app", url.origin);
  if (!(await withinLimits(request, "signin", null))) throw redirect(`/signin?${new URLSearchParams({ next, error: "rate_limited" })}`);
  return startTelegramLogin(url, next);
}
