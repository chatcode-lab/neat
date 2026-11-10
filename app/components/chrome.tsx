import { Link } from "react-router";

import type { Theme } from "~/lib/theme";

import { ThemeSwitch } from "./theme-switch";

/** The wordmark: the name and the "open" sign the legacy pages used. */
export function Logo() {
  return (
    <Link to="/" className="flex items-center gap-1.5 text-lg font-semibold tracking-tight">
      <span aria-hidden className="text-accent">
        ⎆
      </span>
      neat.link
    </Link>
  );
}

export function SiteHeader({ viewer, theme }: { viewer: { name: string; image: string | null } | null; theme: Theme }) {
  return (
    <header className="border-b border-border">
      <div className="mx-auto flex w-full max-w-column items-center justify-between gap-3 px-4 py-3">
        <Logo />
        <nav className="flex items-center gap-1.5 text-sm">
          <Link to="/agents" className="btn btn-quiet hidden sm:inline-flex">
            For agents
          </Link>
          {viewer ? (
            <Link to="/app" className="btn">
              My pages
            </Link>
          ) : (
            <Link to="/signin" className="btn btn-primary">
              Sign in
            </Link>
          )}
          <ThemeSwitch theme={theme} />
        </nav>
      </div>
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer className="mt-12 border-t border-border">
      <div className="mx-auto flex w-full max-w-column flex-wrap items-center justify-center gap-x-4 gap-y-1 px-4 py-6 text-sm text-text-faint">
        <Link to="/agents">For agents</Link>
        <a href="/api/v1">API</a>
        <a href="https://t.me/neatlink_bot">Telegram bot</a>
        <Link to="/terms">Terms</Link>
        <Link to="/privacy">Privacy</Link>
      </div>
    </footer>
  );
}
