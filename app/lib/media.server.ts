import { env } from "cloudflare:workers";

import { addFile, filesOf, type MediaFile, removeFile } from "./db/media.server";
import { fetchPublic, readCapped } from "./fetch.server";
import { type FileType, formatBytes, sniffFile, storedName } from "./files";
import { newId } from "./ids";
import { MAX_FILE_BYTES, MAX_FILES, MEDIA_QUOTA_BYTES } from "./plans";

/** The largest picture accepted, before it is squared and re-encoded. */
export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

/** The side of a kept page picture: sharp at three times the 144 px a page shows. */
export const PICTURE_SIDE = 480;

/**
 * Keys of stored media: avatars/ plus random characters, legacy/ plus the
 * old file name, or an uploaded file, files/<random>/<its name>.
 */
export const MEDIA_KEY =
  /^(?:avatars\/[0-9A-Za-z]{24}\.jpg|legacy\/[0-9a-f-]{36}\.jpg|files\/[0-9A-Za-z]{24}\/[a-z0-9][a-z0-9.-]{0,60}\.[a-z0-9]{2,5})$/;

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

/** Where uploaded files are served from: embeds in pages must start with it. */
export function filesPrefix(origin = ""): string {
  return mediaUrl("files/", origin);
}

export type FileResult =
  | { ok: true; file: MediaFile }
  | { ok: false; reason: "not_allowed" | "too_large" | "quota" | "failed"; message: string };

/** The longest side an uploaded JPEG keeps; it is re-encoded, which also drops where a photo was taken. */
const FILE_PICTURE_SIDE = 2560;

/**
 * Keeps an uploaded file for an account, within its quota: its type read
 * from its bytes, its name made safe, JPEG photos re-encoded without their
 * metadata. Its address never changes, and it is cached for a year.
 */
export async function storeFile(
  userId: string,
  bytes: Uint8Array<ArrayBuffer>,
  name: string | null | undefined,
  now: number,
): Promise<FileResult> {
  if (bytes.byteLength > MAX_FILE_BYTES) return { ok: false, reason: "too_large", message: `A file is at most ${formatBytes(MAX_FILE_BYTES)}.` };
  const type = sniffFile(bytes);
  if (!type) {
    return {
      ok: false,
      reason: "not_allowed",
      message: "That kind of file is not kept. Upload a JPEG, PNG, GIF, WebP or AVIF picture, MP4, MOV or WebM video, MP3, M4A, AAC, OGG, WAV or FLAC audio, or a PDF.",
    };
  }
  let body: Uint8Array<ArrayBuffer> = bytes;
  try {
    if (type.type === "image/jpeg") body = await reencodeJpeg(bytes);
  } catch (error) {
    console.error("photo not re-encoded", error);
    return { ok: false, reason: "failed", message: "That picture could not be read. Try another one." };
  }
  const id = newId();
  const fileName = storedName(name, type.extension);
  const key = `files/${newId(24)}/${fileName}`;
  // The name as given, for the owner's list; the address uses the safe one.
  const shownName = (name ?? "").trim().slice(0, 200) || fileName;
  await env.MEDIA.put(key, body, { httpMetadata: fileMetadata(type, fileName) });
  const added = await addFile(env.DB, {
    id,
    userId,
    key,
    name: shownName,
    type: type.type,
    size: body.byteLength,
    quota: MEDIA_QUOTA_BYTES,
    maxFiles: MAX_FILES,
    now,
  });
  if (!added) {
    await env.MEDIA.delete(key);
    return {
      ok: false,
      reason: "quota",
      message: `An account keeps up to ${formatBytes(MEDIA_QUOTA_BYTES)} in up to ${MAX_FILES} files. Delete some first.`,
    };
  }
  return { ok: true, file: { id, key, name: shownName, type: type.type, size: body.byteLength, createdAt: now } };
}

function fileMetadata(type: FileType, fileName: string): R2HTTPMetadata {
  return {
    contentType: type.type,
    cacheControl: "public, max-age=31536000, immutable",
    // A PDF opens in the browser under its own name.
    ...(type.kind === "pdf" ? { contentDisposition: `inline; filename="${fileName}"` } : {}),
  };
}

async function reencodeJpeg(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  const result = await env.IMAGING.input(streamOf(bytes))
    .transform({ width: FILE_PICTURE_SIDE, height: FILE_PICTURE_SIDE, fit: "scale-down" })
    .output({ format: "image/jpeg", quality: 85 });
  return new Uint8Array(await new Response(result.image()).arrayBuffer());
}

/** Fetches a file from a public address and keeps it, as `storeFile` does. */
export async function storeFileFrom(userId: string, url: string, name: string | null | undefined, ownHosts: readonly string[], now: number): Promise<FileResult> {
  const response = await fetchPublic(url, { accept: "*/*", ownHosts, timeoutMs: 20_000 });
  if (!response || !response.ok) {
    await response?.body?.cancel();
    return { ok: false, reason: "failed", message: "That address could not be fetched. It must be a public https address of the file itself." };
  }
  const bytes = await readCapped(response, MAX_FILE_BYTES);
  if (!bytes) return { ok: false, reason: "too_large", message: `A file is at most ${formatBytes(MAX_FILE_BYTES)}.` };
  const last = new URL(url).pathname.split("/").pop() ?? "";
  let fallback = last;
  try {
    fallback = decodeURIComponent(last);
  } catch {
    // A malformed escape: the name as it is.
  }
  return storeFile(userId, bytes, name ?? fallback, now);
}

export function listFiles(userId: string): Promise<MediaFile[]> {
  return filesOf(env.DB, userId);
}

/** Deletes one of an account's files; false when it has none by that ID. Pages that embed it show a broken link. */
export async function deleteFile(userId: string, id: string): Promise<boolean> {
  const key = await removeFile(env.DB, userId, id);
  if (!key) return false;
  await env.MEDIA.delete(key);
  return true;
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
