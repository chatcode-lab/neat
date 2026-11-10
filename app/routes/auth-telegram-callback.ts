import { redirect } from "react-router";

import { withinLimits } from "~/lib/security/rate-limit.server";
import { safeReturnPath } from "~/lib/security/request";
import { loginStateCookie } from "~/lib/telegram/login";
import { finishTelegramLogin } from "~/lib/telegram/login.server";
import { telegramSession } from "~/lib/telegram/signin.server";

import type { Route } from "./+types/auth-telegram-callback";

/**
 * Where Telegram Login sends a person back. Signs in the account their
 * Telegram is linked to; Telegram alone never makes an account.
 */
export async function loader({ request, url }: Route.LoaderArgs) {
  const headers = new Headers({ "Cache-Control": "no-store" });
  headers.append("Set-Cookie", loginStateCookie(null, url.protocol === "https:"));
  const back = (next: string, error: string) =>
    redirect(`/signin?${new URLSearchParams({ next: safeReturnPath(next, url.origin), error })}`, { headers });

  if (!(await withinLimits(request, "signin", null))) return back("/app", "rate_limited");
  const result = await finishTelegramLogin(request, url);
  if (!result.ok) return back(result.next, result.error);
  const cookie = await telegramSession(request, result.user);
  if (!cookie) return back(result.next, "telegram_not_linked");
  headers.append("Set-Cookie", cookie);
  return redirect(safeReturnPath(result.next, url.origin), { headers });
}
