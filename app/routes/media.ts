import { env } from "cloudflare:workers";

import { MEDIA_KEY, mediaUrl } from "~/lib/media.server";

import type { Route } from "./+types/media";

/**
 * Serves a stored file where the bucket has no public domain of its own, as
 * in local development and tests, the way the domain would: by key, to
 * anyone, with the cache lifetime stored on the object. Where it has one,
 * an old address redirects there.
 */
export async function loader({ params }: Route.LoaderArgs) {
  const key = params["*"] ?? "";
  if (!MEDIA_KEY.test(key)) return new Response("Not Found", { status: 404 });
  if (env.MEDIA_ORIGIN) return Response.redirect(mediaUrl(key), 301);
  const object = await env.MEDIA.get(key);
  if (!object) return new Response("Not Found", { status: 404 });
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  if (!headers.has("Cache-Control")) headers.set("Cache-Control", "public, max-age=300");
  headers.set("Content-Length", String(object.size));
  return new Response(object.body, { headers });
}
