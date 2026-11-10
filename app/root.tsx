import { env } from "cloudflare:workers";
import { useEffect } from "react";
import {
  isRouteErrorResponse,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  useMatches,
  useRouteLoaderData,
} from "react-router";

import type { Route } from "./+types/root";
import "@fontsource-variable/inter";
import interLatin from "@fontsource-variable/inter/files/inter-latin-wght-normal.woff2?url";
import "@fontsource-variable/rubik";
import "./app.css";
import { SiteFooter, SiteHeader } from "./components/chrome";
import { useTheme } from "./components/theme-switch";
import { readTheme } from "./lib/theme";
import { viewerOf } from "./lib/viewer.server";

// Inter's Latin letters are on every page; asking for them with the HTML
// saves waiting for the stylesheet to name them. Other scripts load as used.
export const links: Route.LinksFunction = () => [
  { rel: "preload", href: interLatin, as: "font", type: "font/woff2", crossOrigin: "anonymous" },
];

export async function loader({ request, context }: Route.LoaderArgs) {
  const viewer = await viewerOf(context);
  return {
    theme: readTheme(request.headers.get("Cookie")),
    viewer: viewer ? { name: viewer.name, image: viewer.image } : null,
    // The bot this deployment answers as (the test bot on staging).
    bot: env.TELEGRAM_BOT_USERNAME,
  };
}

export interface RouteHandle {
  /** The route draws its own page, without the site's header and footer. */
  bare?: boolean;
  /**
   * The route is plain HTML: it needs no scripts, so the server sends none
   * and the page is never hydrated. Its links and forms work as plain HTML.
   */
  static?: boolean;
}

export function Layout({ children }: { children: React.ReactNode }) {
  const data = useRouteLoaderData<typeof loader>("root");
  // Marks the moment the page's scripts are running, which tests wait for.
  useEffect(() => {
    document.documentElement.dataset.hydrated = "";
  }, []);
  // The server renders the remembered theme into the document, and CSS
  // resolves "system", so the first paint is already correct.
  const theme = useTheme(data?.theme);
  const handles = useMatches().map((match) => match.handle as RouteHandle | undefined);
  const bare = handles.some((handle) => handle?.bare);
  // Only the server leaves scripts out: a static page is never hydrated, and
  // in a running app (a click from the editor to /terms) they stay.
  const scripts = typeof document !== "undefined" || !handles.some((handle) => handle?.static);

  return (
    <html lang="en" data-theme={theme}>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
        <meta name="color-scheme" content={theme === "system" ? "light dark" : theme} />
        {theme === "system" ? (
          <>
            <meta name="theme-color" content="#f6f6f4" media="(prefers-color-scheme: light)" />
            <meta name="theme-color" content="#111111" media="(prefers-color-scheme: dark)" />
          </>
        ) : (
          <meta name="theme-color" content={theme === "dark" ? "#111111" : "#f6f6f4"} />
        )}
        <link rel="icon" href="/favicon.ico" sizes="any" />
        <link rel="icon" type="image/png" sizes="32x32" href="/favicon-32x32.png" />
        <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
        <link rel="manifest" href="/site.webmanifest" />
        <Meta />
        <Links />
      </head>
      <body className="flex min-h-dvh flex-col">
        {bare ? null : <SiteHeader viewer={data?.viewer ?? null} theme={theme} />}
        <div className="flex flex-1 flex-col">{children}</div>
        {bare ? null : <SiteFooter bot={data?.bot ?? "neatlink_bot"} />}
        {scripts ? (
          <>
            <ScrollRestoration />
            <Scripts />
          </>
        ) : null}
      </body>
    </html>
  );
}

export default function App() {
  return <Outlet />;
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  const missing = isRouteErrorResponse(error) && error.status === 404;
  const status = isRouteErrorResponse(error) ? error.status : 500;
  return (
    <main className="mx-auto flex w-full max-w-column flex-1 flex-col items-center justify-center gap-3 px-5 py-16 text-center">
      <h1 className="text-2xl font-semibold">{missing ? "Nothing here yet" : "Something went wrong"}</h1>
      <p className="text-text-muted">
        {missing ? "This page does not exist, or is not published." : `The server could not finish this (${status}). Try again in a moment.`}
      </p>
      <a className="btn mt-2" href="/">
        Go to neat.link
      </a>
    </main>
  );
}
