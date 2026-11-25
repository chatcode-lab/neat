import { env } from "cloudflare:workers";
import { data } from "react-router";

import { PageFooter, PixelScript } from "~/components/page-extras";
import { siteByHandle } from "~/lib/db/sites.server";
import { subpageAt, subpageCoverVersion } from "~/lib/db/subpages.server";
import { siteUrl, subpageUrl } from "~/lib/domains";
import { HANDLE_PATTERN } from "~/lib/handles";
import { renderMarkdown, summary } from "~/lib/markdown";
import { filesPrefix, mediaUrl } from "~/lib/media.server";
import { pageMeta } from "~/lib/meta";
import { initials } from "~/lib/og/cover";
import { SUBPAGE_SEGMENT } from "~/lib/subpages";
import { subpagesVisible } from "~/lib/subpages.server";
import { siteExtras } from "~/lib/views/site-extras.server";
import { viewerOf } from "~/lib/viewer.server";
import type { RouteHandle } from "~/root";

import type { Route } from "./+types/subpage";

export const handle: RouteHandle = { bare: true, static: true };

/**
 * A site's subpage, such as an article, at /<handle>/<path> once public, and
 * always at /<handle>/<private ID>, which is never indexed. On the site's own
 * domain it is at /<path> (the Worker sends it here). Visitors see it while
 * the site is published and its owner has Pro; the owner always does, with
 * a note when others cannot.
 */
export async function loader({ params, url, context }: Route.LoaderArgs) {
  const handle = params.handle.toLowerCase();
  const segment = params.sub.toLowerCase();
  if (!HANDLE_PATTERN.test(handle) || !SUBPAGE_SEGMENT.test(segment)) throw data(null, { status: 404 });
  const site = await siteByHandle(env.DB, handle);
  if (!site) throw data(null, { status: 404 });
  const found = await subpageAt(env.DB, site.id, segment);
  if (!found) throw data(null, { status: 404 });
  const visible = subpagesVisible(site);
  if (!visible && (await viewerOf(context))?.id !== site.ownerId) throw data(null, { status: 404 });
  if (params.handle !== site.handle || params.sub !== segment) {
    throw Response.redirect(new URL(`/${site.handle}/${segment}`, url).href, 301);
  }

  const { page, via } = found;
  const origin = url.origin;
  // Pixels only at the public address: a private one would reach analytics.
  const extras = siteExtras(site, visible && via === "path");
  const address = subpageUrl(site, segment, origin);
  return data(
    {
      visible,
      // Only the public address is indexed; the private one is shared by link.
      indexable: visible && via === "path",
      origin,
      host: url.host,
      url: page.path && via === "path" ? subpageUrl(site, page.path, origin) : address,
      markdown: `${address}.md`,
      // Named by the address it was asked by, so it goes when that address does.
      cover: `${origin}/og/${site.handle}/${segment}.png?v=${subpageCoverVersion(site, page)}`,
      description: page.headline || summary(page.body) || `${page.title} by ${site.page.title}`,
      pixels: extras.pixels,
      branding: extras.branding,
      site: {
        title: site.page.title,
        url: siteUrl(site, origin),
        picture: site.page.imageKey ? mediaUrl(site.page.imageKey, origin) : null,
      },
      page: {
        title: page.title,
        headline: page.headline,
        bodyHtml: renderMarkdown(page.body, { filesPrefix: filesPrefix(origin) }),
        updated: new Date(page.updatedAt * 1000).toISOString(),
      },
    },
    { headers: extras.headers },
  );
}

export function headers({ loaderHeaders }: Route.HeadersArgs) {
  return loaderHeaders;
}

export function meta({ loaderData }: Route.MetaArgs) {
  if (!loaderData) return [{ title: "Not found · neat.link" }];
  return pageMeta({
    title: `${loaderData.page.title} · ${loaderData.site.title}`,
    description: loaderData.description,
    url: loaderData.url,
    image: loaderData.cover,
    markdown: loaderData.markdown,
    noindex: !loaderData.indexable,
  });
}

export default function Subpage({ loaderData }: Route.ComponentProps) {
  const { site, page } = loaderData;
  return (
    <main className="flex flex-1 flex-col px-5 pt-10 pb-8 sm:pt-14">
      {!loaderData.visible ? (
        <p className="mx-auto mb-8 rounded bg-accent-soft px-4 py-1.5 text-center text-sm text-text">
          Only you can see this page: the site is a draft, or subpages need Pro.{" "}
          <a className="text-link" href="/app/plan">
            See plans
          </a>
        </p>
      ) : null}
      <article className="mx-auto w-full max-w-article flex-1">
        <a href={site.url} className="inline-flex items-center gap-2.5 text-sm font-medium text-text-muted hover:text-text">
          {site.picture ? (
            <img src={site.picture} alt="" width={32} height={32} className="h-8 w-8 rounded-full object-cover" />
          ) : (
            <span aria-hidden className="flex h-8 w-8 items-center justify-center rounded-full bg-surface-2 text-xs font-semibold">
              {initials(site.title) || "⎆"}
            </span>
          )}
          {site.title}
        </a>
        <header className="mt-8 flex flex-col gap-2">
          <h1 className="text-3xl font-extrabold tracking-tight [overflow-wrap:anywhere] sm:text-4xl">{page.title}</h1>
          {page.headline ? <p className="text-lg text-text-muted">{page.headline}</p> : null}
        </header>
        {page.bodyHtml ? <div className="prose article mt-8 text-text" dangerouslySetInnerHTML={{ __html: page.bodyHtml }} /> : null}
      </article>
      <PageFooter origin={loaderData.origin} host={loaderData.host} branding={loaderData.branding} />
      <PixelScript pixels={loaderData.pixels} />
    </main>
  );
}
