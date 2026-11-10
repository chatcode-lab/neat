import { env } from "cloudflare:workers";
import { Link } from "react-router";

import { PageCard } from "~/components/page-card";
import { TAGLINE } from "~/lib/copy";
import { renderMarkdown } from "~/lib/markdown";
import { pageMeta } from "~/lib/meta";
import { COVER_DESIGN } from "~/lib/og/cover";
import type { RouteHandle } from "~/root";
import { viewerOf } from "~/lib/viewer.server";

import type { Route } from "./+types/home";

/** Plain HTML: nothing here needs scripts. */
export const handle: RouteHandle = { static: true };

export async function loader({ url, context }: Route.LoaderArgs) {
  const origin = url.origin;
  return {
    origin,
    host: url.host,
    signedIn: Boolean(await viewerOf(context)),
    bot: env.TELEGRAM_BOT_USERNAME,
    example: { ...EXAMPLE, bodyHtml: renderMarkdown(EXAMPLE.body) },
  };
}

export function meta({ loaderData }: Route.MetaArgs) {
  return pageMeta({
    title: "neat.link — one neat page for all your links",
    description: `${TAGLINE} A picture, your name, a few lines and a button for every place people can find you. Agents can write it for you.`,
    url: `${loaderData.origin}/`,
    image: `${loaderData.origin}/og/site.png?v=${COVER_DESIGN}`,
    markdown: `${loaderData.origin}/index.md`,
  });
}

const EXAMPLE = {
  title: "Ada Lovelace",
  headline: "Mathematician · first programmer",
  body: "Writing notes on the **Analytical Engine**.\nAvailable for talks and consulting.",
  buttons: [
    { label: "Telegram", url: "https://t.me/example" },
    { label: "LinkedIn", url: "https://www.linkedin.com/in/example" },
    { label: "Email", url: "mailto:ada@example.com" },
  ],
  picture: null,
};

const points = (bot: string) => [
  ["Nothing to design", "A page is a title, a short text and buttons. It looks right on every phone, in light and dark."],
  ["Agent-friendly", "Let Claude, ChatGPT or any MCP client write and update it. Every page is also Markdown at /yourname.md."],
  ["Findable", "Pages load instantly, show a proper preview when shared, and are listed for search engines."],
  ["Telegram too", `Open the editor right inside Telegram from @${bot}.`],
];

export default function Home({ loaderData }: Route.ComponentProps) {
  return (
    <main className="mx-auto flex w-full max-w-column flex-col gap-14 px-5 py-12 sm:py-16">
      <section className="flex flex-col items-center gap-5 text-center">
        <h1 className="text-4xl font-extrabold tracking-tight sm:text-5xl">One neat page for all your links</h1>
        <p className="max-w-card text-lg text-text-muted">
          A picture, your name, a few lines about you and a button for every place people can find you, at{" "}
          <span className="font-medium text-text">{loaderData.host}/yourname</span>.
        </p>
        <div className="flex flex-wrap justify-center gap-2">
          <Link to={loaderData.signedIn ? "/app" : "/signin"} className="btn btn-primary px-5 py-2.5 text-base">
            {loaderData.signedIn ? "Go to my pages" : "Create your page"}
          </Link>
          <Link to="/agents" className="btn px-5 py-2.5 text-base">
            Connect an agent
          </Link>
        </div>
      </section>
      <section aria-label="An example page" className="rounded-md border border-border bg-bg px-5 py-10 shadow-sm">
        <PageCard page={loaderData.example} compact />
      </section>
      <section className="grid gap-6 sm:grid-cols-2">
        {points(loaderData.bot).map(([title, text]) => (
          <div key={title}>
            <h2 className="font-semibold">{title}</h2>
            <p className="mt-1 text-text-muted">{text}</p>
          </div>
        ))}
      </section>
    </main>
  );
}
