import { env } from "cloudflare:workers";
import { Form, redirect, useNavigation } from "react-router";

import { googleSignIn } from "~/lib/auth.server";
import { privateMeta } from "~/lib/meta";
import { withinLimits } from "~/lib/security/rate-limit.server";
import { safeReturnPath } from "~/lib/security/request";
import { viewerOf } from "~/lib/viewer.server";

import type { Route } from "./+types/signin";

export function meta() {
  return privateMeta("Sign in");
}

const ERRORS: Record<string, string> = {
  access_denied: "Sign-in was cancelled. Try again when you are ready.",
  email_not_found: "Your Google account did not share an email address, which an account here needs.",
  email_not_verified: "Google has not verified this account's email. Verify it with Google, then try again.",
  account_not_linked: "That email already belongs to an account here, made with a different Google account.",
  rate_limited: "Too many sign-ins from this network just now. Wait a minute, then try again.",
  state_mismatch: "The sign-in started in another tab or expired. Try again from here.",
  please_restart_the_process: "The sign-in started in another tab or expired. Try again from here.",
  telegram_not_linked:
    "No neat.link account has this Telegram account linked. Continue with Google to make one, then link Telegram in Settings.",
  telegram_failed: "Telegram's answer could not be checked. Try again.",
  link_expired: "That sign-in link was used already or has expired. Send /login to the bot for a new one.",
};

export async function loader({ url, context }: Route.LoaderArgs) {
  const next = safeReturnPath(url.searchParams.get("next") ?? "/app", url.origin);
  if (await viewerOf(context)) throw redirect(next);
  const error = url.searchParams.get("error");
  return {
    next,
    error: error ? (ERRORS[error] ?? "Signing in did not work. Try again.") : null,
    telegramUrl: `/auth/telegram?${new URLSearchParams({ next })}`,
    bot: env.TELEGRAM_BOT_USERNAME,
  };
}

export async function action({ request, url }: Route.ActionArgs) {
  const form = await request.formData();
  const next = safeReturnPath(String(form.get("next") ?? "/app"), url.origin);
  if (!(await withinLimits(request, "signin", null))) {
    throw redirect(`/signin?${new URLSearchParams({ next, error: "rate_limited" })}`);
  }
  const response = await googleSignIn(request, next);
  if (!response) throw redirect(`/signin?${new URLSearchParams({ next, error: "unknown" })}`);
  return response;
}

export default function SignIn({ loaderData }: Route.ComponentProps) {
  const navigation = useNavigation();
  const busy = navigation.state !== "idle";
  return (
    <main className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center gap-6 px-5 py-12">
      <div className="text-center">
        <h1 className="text-2xl font-semibold">Sign in to neat.link</h1>
        <p className="mt-1 text-text-muted">New here? Continuing with Google makes your account.</p>
      </div>
      {loaderData.error ? (
        <p role="alert" className="rounded bg-danger-soft px-4 py-3 text-sm text-danger">
          {loaderData.error}
        </p>
      ) : null}
      <Form method="post">
        <input type="hidden" name="next" value={loaderData.next} />
        <button type="submit" className="btn btn-primary w-full py-3 text-base" disabled={busy}>
          <GoogleMark /> Continue with Google
        </button>
      </Form>
      <div className="flex items-center gap-3 text-sm text-text-faint">
        <span className="h-px flex-1 bg-border" /> or <span className="h-px flex-1 bg-border" />
      </div>
      <div className="flex flex-col gap-2">
        <a href={loaderData.telegramUrl} className="btn w-full py-3 text-base">
          <TelegramMark /> Sign in with Telegram
        </a>
        <p className="text-center text-sm text-text-muted">
          For pages made with{" "}
          <a className="text-link" href={`https://t.me/${loaderData.bot}`}>
            @{loaderData.bot}
          </a>{" "}
          or accounts with Telegram linked. You can also send <code>/login</code> to the bot for a sign-in link.
        </p>
      </div>
    </main>
  );
}

function GoogleMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden>
      <path fill="#fff" d="M21.6 12.23c0-.71-.06-1.4-.18-2.05H12v3.88h5.38a4.6 4.6 0 0 1-2 3.02v2.5h3.24c1.9-1.75 2.98-4.32 2.98-7.35Z" />
      <path fill="#fff" fillOpacity=".85" d="M12 22c2.7 0 4.96-.9 6.62-2.42l-3.24-2.5c-.9.6-2.04.95-3.38.95-2.6 0-4.8-1.75-5.59-4.1H3.07v2.58A10 10 0 0 0 12 22Z" />
      <path fill="#fff" fillOpacity=".7" d="M6.41 13.93a6 6 0 0 1 0-3.86V7.49H3.07a10 10 0 0 0 0 9.02l3.34-2.58Z" />
      <path fill="#fff" fillOpacity=".85" d="M12 5.98c1.47 0 2.79.5 3.83 1.5l2.87-2.87A9.96 9.96 0 0 0 12 2a10 10 0 0 0-8.93 5.49l3.34 2.58C7.2 7.73 9.4 5.98 12 5.98Z" />
    </svg>
  );
}

function TelegramMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M11.944 0A12 12 0 1 0 24 12 12 12 0 0 0 11.944 0Zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635Z" />
    </svg>
  );
}
