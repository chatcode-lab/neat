import { env } from "cloudflare:workers";
import { data } from "react-router";

import { PageCard } from "~/components/page-card";
import { PageFooter, PixelScript } from "~/components/page-extras";
import { coverVersion, siteByHandle } from "~/lib/db/sites.server";
import { siteMarkdownUrl, siteUrl } from "~/lib/domains";
import { HANDLE_PATTERN } from "~/lib/handles";
import { renderMarkdown, summary } from "~/lib/markdown";
import { filesPrefix, mediaUrl } from "~/lib/media.server";
import { pageMeta } from "~/lib/meta";
import { siteExtras } from "~/lib/views/site-extras.server";
import { viewerOf } from "~/lib/viewer.server";
import type { RouteHandle } from "~/root";

import type { Route } from "./+types/page";

export const handle: RouteHandle = { bare: true, static: true };

/**
 * A site's main page at /<handle>, and at its own domain when it has one
 * (the Worker sends that domain's / here), which is then its canonical
 * address. Drafts are shown to their owner only, with a note, and are kept
 * out of search engines.
 */
export async function loader({ params, url, context }: Route.LoaderArgs) {
  const handle = params.handle.toLowerCase();
  if (!HANDLE_PATTERN.test(handle)) throw data(null, { status: 404 });
  const site = await siteByHandle(env.DB, handle);
  if (!site) throw data(null, { status: 404 });
  const viewer = site.published ? null : await viewerOf(context);
  if (!site.published && viewer?.id !== site.ownerId) throw data(null, { status: 404 });
  // An address in another case is sent to the one true address.
  if (params.handle !== site.handle) throw Response.redirect(new URL(`/${site.handle}`, url).href, 301);

  const origin = url.origin;
  const extras = siteExtras(site, site.published);
  return data(
    {
      handle: site.handle,
      published: site.published,
      origin,
      host: url.host,
      url: siteUrl(site, origin),
      markdown: siteMarkdownUrl(site, origin),
      cover: `${origin}/og/${site.handle}.png?v=${coverVersion(site)}`,
      description: summary([site.page.headline, site.page.body].filter(Boolean).join("\n\n")) || `${site.page.title} on neat.link`,
      pixels: extras.pixels,
      branding: extras.branding,
      page: {
        title: site.page.title,
        headline: site.page.headline,
        bodyHtml: renderMarkdown(site.page.body, { filesPrefix: filesPrefix(origin) }),
        buttons: site.page.buttons,
        picture: site.page.imageKey ? mediaUrl(site.page.imageKey, origin) : null,
      },
    },
    { headers: extras.headers },
  );
}

/** The pixels' header reaches the Worker, which opens the page's policy to their vendors. */
export function headers({ loaderHeaders }: Route.HeadersArgs) {
  return loaderHeaders;
}

export function meta({ loaderData }: Route.MetaArgs) {
  if (!loaderData) return [{ title: "Not found · neat.link" }];
  return pageMeta({
    title: loaderData.page.title,
    description: loaderData.description,
    url: loaderData.url,
    image: loaderData.cover,
    markdown: loaderData.markdown,
    noindex: !loaderData.published,
    type: "profile",
  });
}

export default function PublicPage({ loaderData }: Route.ComponentProps) {
  return (
    <main className="flex flex-1 flex-col px-5 pt-12 pb-8 sm:pt-16">
      {!loaderData.published ? (
        <p className="mx-auto mb-8 rounded bg-accent-soft px-4 py-1.5 text-sm text-text">
          Draft: only you can see this page.{" "}
          <a className="text-link" href={`/app/sites/${loaderData.handle}`}>
            Edit and publish
          </a>
        </p>
      ) : null}
      {/* Centred in the window, as the legacy pages were. */}
      <div className="flex flex-1 flex-col justify-center">
        <PageCard page={loaderData.page} />
      </div>
      <PageFooter origin={loaderData.origin} host={loaderData.host} branding={loaderData.branding} />
      <PixelScript pixels={loaderData.pixels} />
    </main>
  );
}
