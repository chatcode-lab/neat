import { env } from "cloudflare:workers";

import { TAGLINE } from "../copy";
import { coverVersion, siteByHandle } from "../db/sites.server";
import { HANDLE_PATTERN } from "../handles";
import { markdownToText } from "../markdown";
import { COVER_DESIGN, type Cover } from "./cover";
import { renderCover, storedPicture } from "./render.server";

type Cached = (key: string, make: () => Promise<Response | null>) => Promise<Response | null>;

function png(bytes: Uint8Array): Response {
  return new Response(bytes as Uint8Array<ArrayBuffer>, {
    headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=604800, immutable" },
  });
}

/**
 * Serves /og/site.png and /og/<handle>.png. Each needs `?v=` with the
 * current version: a missing or old one, or any other parameter, is sent on
 * to the current address, so a cache key is never made from an address
 * someone varied, and an edit changes the address. A site is looked up live
 * before the cache, so a deleted or hidden page loses its cover at once.
 */
export async function coverResponse(url: URL, cached: Cached): Promise<Response | null> {
  const name = /^\/og\/([a-z0-9_]{1,32})\.png$/.exec(url.pathname)?.[1];
  if (!name) return null;
  const host = url.host;

  let version: string;
  let make: () => Promise<Cover>;
  if (name === "site") {
    version = COVER_DESIGN;
    make = async () => ({ title: "neat.link", headline: TAGLINE, text: "", address: host, picture: null, sign: true });
  } else {
    if (!HANDLE_PATTERN.test(name)) return null;
    const site = await siteByHandle(env.DB, name);
    if (!site || !site.published) return null;
    version = coverVersion(site);
    make = async () => ({
      title: site.page.title,
      headline: site.page.headline,
      text: markdownToText(site.page.body),
      address: site.domain ?? `${host}/${site.handle}`,
      picture: (await storedPicture(env.MEDIA, site.page.imageKey))?.href ?? null,
    });
  }

  const wanted = `${url.origin}${url.pathname}?v=${version}`;
  if (url.href !== wanted) return Response.redirect(wanted, 302);
  return cached(`${url.origin}/__og${url.pathname}?v=${version}`, async () => png(await renderCover(await make())));
}

/** A site's cover address, versioned by what it shows. */
export { coverVersion };
