import { env } from "cloudflare:workers";
import { useEffect, useState } from "react";

import { privateMeta } from "~/lib/meta";
import type { RouteHandle } from "~/root";

import type { Route } from "./+types/tg";

export const handle: RouteHandle = { bare: true };

export function meta() {
  return privateMeta("neat.link");
}

export function loader({ url }: Route.LoaderArgs) {
  return { origin: url.origin, bot: env.TELEGRAM_BOT_USERNAME };
}

interface TelegramWebApp {
  initData: string;
  initDataUnsafe?: { start_param?: string };
  ready(): void;
  expand(): void;
  openLink(url: string): void;
}

declare global {
  interface Window {
    Telegram?: { WebApp?: TelegramWebApp };
  }
}

/** What Telegram opened the Mini App with: from its script, or from the address's #tgWebAppData. */
function launchData(): { initData: string; startParam: string | null } {
  const app = window.Telegram?.WebApp;
  const hash = new URLSearchParams(window.location.hash.slice(1));
  const initData = app?.initData || hash.get("tgWebAppData") || "";
  const startParam =
    app?.initDataUnsafe?.start_param ?? hash.get("tgWebAppStartParam") ?? new URLSearchParams(initData).get("start_param");
  return { initData, startParam: startParam || null };
}

type State = "working" | "not_linked" | "outside" | "failed";

/**
 * The Mini App's entry. A link with ?startapp=<handle> (the legacy bot's
 * "Tg Link") opens that page; otherwise the person is signed in by what
 * Telegram signed and taken to the editor.
 */
export default function MiniApp({ loaderData }: Route.ComponentProps) {
  const [state, setState] = useState<State>("working");

  useEffect(() => {
    const app = window.Telegram?.WebApp;
    app?.ready();
    app?.expand();
    const { initData, startParam } = launchData();
    if (startParam && /^[a-z][a-z0-9_]{0,31}$/i.test(startParam)) {
      window.location.replace(`/${startParam.toLowerCase()}`);
      return;
    }
    if (!initData) {
      setState("outside");
      return;
    }
    fetch("/auth/telegram/webapp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ initData }),
      credentials: "same-origin",
    })
      .then((response) => response.json() as Promise<{ ok: boolean; next?: string; error?: string }>)
      .then((answer) => {
        if (answer.ok && answer.next) window.location.replace(answer.next);
        else setState(answer.error === "not_linked" ? "not_linked" : "failed");
      })
      .catch(() => setState("failed"));
  }, []);

  const openOutside = (path: string) => {
    const url = `${loaderData.origin}${path}`;
    const app = window.Telegram?.WebApp;
    if (app) app.openLink(url);
    else window.location.href = url;
  };

  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-4 px-6 py-12 text-center">
      <script src="https://telegram.org/js/telegram-web-app.js?59" />
      <p className="text-2xl font-semibold">
        <span className="text-accent">⎆</span> neat.link
      </p>
      {state === "working" ? <p className="text-text-muted">Opening your pages…</p> : null}
      {state === "not_linked" ? (
        <>
          <p className="max-w-sm text-text-muted">
            This Telegram account is not linked to a neat.link account yet. Sign up with Google in your browser, then link Telegram in
            Settings.
          </p>
          <button type="button" className="btn btn-primary" onClick={() => openOutside("/signin")}>
            Open neat.link in the browser
          </button>
        </>
      ) : null}
      {state === "outside" ? (
        <>
          <p className="max-w-sm text-text-muted">This page opens from @{loaderData.bot} in Telegram.</p>
          <a className="btn btn-primary" href="/app">
            Go to the editor
          </a>
        </>
      ) : null}
      {state === "failed" ? (
        <>
          <p className="max-w-sm text-text-muted">Signing in did not work. Close and open the app again.</p>
          <button type="button" className="btn" onClick={() => openOutside("/signin")}>
            Sign in in the browser
          </button>
        </>
      ) : null}
    </main>
  );
}
