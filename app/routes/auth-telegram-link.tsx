import { env } from "cloudflare:workers";
import { Form, redirect } from "react-router";

import { claimTelegramToken, peekTelegramToken } from "~/lib/db/telegram-tokens.server";
import { privateMeta } from "~/lib/meta";
import { startSession } from "~/lib/sessions.server";
import { withinLimits } from "~/lib/security/rate-limit.server";

import type { Route } from "./+types/auth-telegram-link";

export function meta() {
  return privateMeta("Sign in");
}

/**
 * A sign-in link the bot sent. Opening it only shows a button: the link is
 * used up by the POST that button makes, so a scanner that fetches links in
 * chats signs no one in and spends nothing.
 */
export async function loader({ url }: Route.LoaderArgs) {
  const token = url.searchParams.get("t") ?? "";
  const valid = Boolean(await peekTelegramToken(env.DB, token, "login", Math.floor(Date.now() / 1000)));
  if (!valid) throw redirect("/signin?error=link_expired");
  return { token };
}

export async function action({ request }: Route.ActionArgs) {
  if (!(await withinLimits(request, "signin", null))) throw redirect("/signin?error=rate_limited");
  const form = await request.formData();
  const now = Math.floor(Date.now() / 1000);
  const userId = await claimTelegramToken(env.DB, String(form.get("t") ?? ""), "login", now);
  if (!userId) throw redirect("/signin?error=link_expired");
  const cookie = await startSession(env.DB, { userId, request, secret: env.BETTER_AUTH_SECRET, now });
  return redirect("/app", { headers: { "Set-Cookie": cookie } });
}

export default function TelegramLink({ loaderData }: Route.ComponentProps) {
  return (
    <main className="mx-auto flex w-full max-w-sm flex-1 flex-col items-center justify-center gap-4 px-5 py-12 text-center">
      <h1 className="text-2xl font-semibold">Sign in to neat.link</h1>
      <p className="text-text-muted">With the link from the Telegram bot.</p>
      <Form method="post" className="w-full">
        <input type="hidden" name="t" value={loaderData.token} />
        <button type="submit" className="btn btn-primary w-full py-3 text-base">
          Continue
        </button>
      </Form>
    </main>
  );
}
