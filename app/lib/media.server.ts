import { env } from "cloudflare:workers";

import { fetchPublic, readCapped } from "./fetch.server";
import { newId } from "./ids";

/** The largest picture accepted, before it is squared and re-encoded. */
export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

/** The side of a kept page picture: sharp at three times the 144 px a page shows. */
export const PICTURE_SIDE = 480;

/** Keys of stored media: avatars/ plus random characters, or legacy/ plus the old file name. */
export const MEDIA_KEY = /^(?:avatars\/[0-9A-Za-z]{24}\.jpg|legacy\/[0-9a-f-]{36}\.jpg)$/;

export type PictureType = "image/jpeg" | "image/png" | "image/webp" | "image/gif";

/** A picture's real type from its first bytes; whatever the sender claims is ignored. */
export function sniffImage(bytes: Uint8Array): PictureType | null {
  const at = (offset: number, ...values: number[]) => values.every((value, index) => bytes[offset + index] === value);
  if (at(0, 0xff, 0xd8, 0xff)) return "image/jpeg";
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return "image/webp";
  if (at(0, 0x47, 0x49, 0x46, 0x38)) return "image/gif";
  return null;
}

/** Where a stored file is served: the bucket's own domain, or through the Worker. */
export function mediaUrl(key: string, origin = ""): string {
  return env.MEDIA_ORIGIN ? `${env.MEDIA_ORIGIN}/${key}` : `${origin}/media/${key}`;
}

const streamOf = (bytes: Uint8Array<ArrayBuffer>) => new Response(bytes).body!;

export type StoreResult = { ok: true; key: string } | { ok: false; reason: "not_image" | "too_large" | "failed" };

/**
 * Keeps a page picture: cropped to a square about its centre, at most
 * PICTURE_SIDE across and never enlarged, its first frame only, as JPEG,
 * which drops metadata such as where a photo was taken. JPEG is also what
 * the cover renderer can embed.
 */
export async function storePicture(bytes: Uint8Array<ArrayBuffer>): Promise<StoreResult> {
  if (bytes.byteLength > MAX_UPLOAD_BYTES) return { ok: false, reason: "too_large" };
  if (!sniffImage(bytes)) return { ok: false, reason: "not_image" };
  try {
    const info = await env.IMAGING.info(streamOf(bytes));
    if (!("width" in info) || info.width < 1 || info.height < 1) return { ok: false, reason: "not_image" };
    const side = Math.min(PICTURE_SIDE, info.width, info.height);
    const result = await env.IMAGING.input(streamOf(bytes))
      .transform({ width: side, height: side, fit: "cover" })
      .output({ format: "image/jpeg", quality: 85, anim: false });
    const squared = new Uint8Array(await new Response(result.image()).arrayBuffer());
    const key = `avatars/${newId(24)}.jpg`;
    await env.MEDIA.put(key, squared, {
      httpMetadata: { contentType: "image/jpeg", cacheControl: "public, max-age=31536000, immutable" },
    });
    return { ok: true, key };
  } catch (error) {
    console.error("picture not stored", error);
    return { ok: false, reason: "failed" };
  }
}

/** Fetches a picture from a public address and keeps it, as `storePicture` does. */
export async function storePictureFrom(url: string, ownHosts: readonly string[]): Promise<StoreResult> {
  const response = await fetchPublic(url, { accept: "image/jpeg,image/png,image/webp,image/gif", ownHosts });
  if (!response || !response.ok) {
    await response?.body?.cancel();
    return { ok: false, reason: "failed" };
  }
  const bytes = await readCapped(response, MAX_UPLOAD_BYTES);
  if (!bytes) return { ok: false, reason: "too_large" };
  return storePicture(bytes);
}

/** Removes a stored file that nothing uses any more. */
export async function deleteMedia(key: string | null | undefined): Promise<void> {
  if (key && MEDIA_KEY.test(key)) await env.MEDIA.delete(key);
}

export const PICTURE_PROBLEMS: Record<Exclude<StoreResult, { ok: true }>["reason"], string> = {
  not_image: "That is not a JPEG, PNG, WebP or GIF picture.",
  too_large: "That picture is over 8 MB.",
  failed: "The picture could not be read. Try another one.",
};
