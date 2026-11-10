import { env } from "cloudflare:workers";
import { useEffect, useRef, useState } from "react";
import { redirect } from "react-router";

import { privateMeta } from "~/lib/meta";
import { withinLimits } from "~/lib/security/rate-limit.server";
import { safeReturnPath } from "~/lib/security/request";
import { telegramSession } from "~/lib/telegram/signin.server";
import { verifyLoginWidget } from "~/lib/telegram/verify";
import type { RouteHandle } from "~/root";

import type { Route } from "./+types/auth-telegram-widget";

export const handle: RouteHandle = { bare: true };

export function meta() {
  return privateMeta("Signing in");
}

const FIELDS = ["id", "first_name", "last_name", "username", "photo_url", "auth_date", "hash"] as const;

async function finish(request: Request, params: URLSearchParams, next: string): Promise<Response> {
  const user = await verifyLoginWidget(params, env.TELEGRAM_BOT_TOKEN, Math.floor(Date.now() / 1000));
  if (!user) return redirect(`/signin?${new URLSearchParams({ next, error: "telegram_failed" })}`);
  const cookie = await telegramSession(request, user);
  if (!cookie) return redirect(`/signin?${new URLSearchParams({ next, error: "telegram_not_linked" })}`);
  return redirect(next, { headers: { "Set-Cookie": cookie } });
}

/**
 * Where Telegram's sign-in sends a person back. The Login Widget's redirect
 * puts its signed answer in the query, which is checked here at once;
 * Telegram's own sign-in page puts it in #tgAuthResult, which only the page
 * can read, so the page posts it back.
 */
export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const next = safeReturnPath(url.searchParams.get("next") ?? "/app", url.origin);
  if (url.searchParams.has("hash")) {
    if (!(await withinLimits(request, "signin", null))) throw redirect(`/signin?${new URLSearchParams({ next, error: "rate_limited" })}`);
    throw await finish(request, url.searchParams, next);
  }
  return { next };
}

export async function action({ request }: Route.ActionArgs) {
  const url = new URL(request.url);
  const form = await request.formData();
  const next = safeReturnPath(String(form.get("next") ?? "/app"), url.origin);
  if (!(await withinLimits(request, "signin", null))) return redirect(`/signin?${new URLSearchParams({ next, error: "rate_limited" })}`);
  const params = new URLSearchParams();
  for (const field of FIELDS) {
    const value = form.get(field);
    if (typeof value === "string" && value) params.set(field, value);
  }
  return finish(request, params, next);
}

/** Telegram's answer from #tgAuthResult: base64 JSON of the widget's fields. */
function answerFromHash(hash: string): Record<string, string> | null {
  const raw = new URLSearchParams(hash.replace(/^#/, "")).get("tgAuthResult");
  if (!raw) return null;
  try {
    const json = JSON.parse(atob(raw.replace(/-/g, "+").replace(/_/g, "/"))) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(json).map(([key, value]) => [key, String(value)]));
  } catch {
    return null;
  }
}

export default function TelegramReturn({ loaderData }: Route.ComponentProps) {
  const form = useRef<HTMLFormElement>(null);
  const [answer, setAnswer] = useState<Record<string, string> | null>(null);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    const found = answerFromHash(window.location.hash);
    if (found) setAnswer(found);
    else setMissing(true);
  }, []);

  useEffect(() => {
    if (answer) form.current?.submit();
  }, [answer]);

  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-4 px-5 text-center">
      {missing ? (
        <>
          <p>Telegram did not send a sign-in back.</p>
          <a className="btn" href={`/signin?${new URLSearchParams({ next: loaderData.next })}`}>
            Try again
          </a>
        </>
      ) : (
        <p className="text-text-muted">Signing you in…</p>
      )}
      <form ref={form} method="post" hidden>
        <input type="hidden" name="next" value={loaderData.next} />
        {FIELDS.map((field) => (answer?.[field] ? <input key={field} type="hidden" name={field} value={answer[field]} /> : null))}
      </form>
    </main>
  );
}
