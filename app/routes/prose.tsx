import { agentsMarkdown, privacyMarkdown, termsMarkdown } from "~/lib/copy";
import { renderMarkdown } from "~/lib/markdown";
import { pageMeta } from "~/lib/meta";

import type { Route } from "./+types/prose";

const PAGES: Record<string, { title: string; description: string; markdown: (origin: string) => string }> = {
  "/agents": {
    title: "neat.link for agents",
    description: "Connect Claude, ChatGPT, Codex or any MCP client to neat.link, or use the HTTP API.",
    markdown: agentsMarkdown,
  },
  "/terms": { title: "Terms of use · neat.link", description: "The terms of using neat.link.", markdown: termsMarkdown },
  "/privacy": { title: "Privacy · neat.link", description: "What neat.link keeps, and why.", markdown: privacyMarkdown },
};

/** The site's own prose pages, written once in Markdown (app/lib/copy.ts). */
export function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const page = PAGES[url.pathname];
  if (!page) throw new Response("Not Found", { status: 404 });
  return {
    origin: url.origin,
    path: url.pathname,
    title: page.title,
    description: page.description,
    html: renderMarkdown(page.markdown(url.origin)),
  };
}

export function meta({ loaderData }: Route.MetaArgs) {
  return pageMeta({
    title: loaderData.title,
    description: loaderData.description,
    url: `${loaderData.origin}${loaderData.path}`,
    image: `${loaderData.origin}/og/site.png?v=1`,
    markdown: `${loaderData.origin}${loaderData.path}.md`,
  });
}

export default function Prose({ loaderData }: Route.ComponentProps) {
  return (
    <main className="mx-auto w-full max-w-column px-5 py-10">
      <div className="prose" dangerouslySetInnerHTML={{ __html: loaderData.html }} />
    </main>
  );
}
