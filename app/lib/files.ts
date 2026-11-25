/**
 * Files owners upload to embed in their pages: pictures, video, audio and
 * PDFs. A file's type is read from its first bytes, never from what the
 * sender says, and only types browsers show safely are kept: no SVG, no
 * HTML, nothing that could run as a script.
 */

export type FileKind = "image" | "video" | "audio" | "pdf";

export interface FileType {
  type: string;
  kind: FileKind;
  extension: string;
}

const ascii = (bytes: Uint8Array, offset: number, length: number) =>
  String.fromCharCode(...bytes.subarray(offset, offset + length));

/** A file's real type from its first bytes, or null when it is not one neat.link keeps. */
export function sniffFile(bytes: Uint8Array): FileType | null {
  const at = (offset: number, ...values: number[]) => values.every((value, index) => bytes[offset + index] === value);
  if (bytes.length < 12) return null;
  if (at(0, 0xff, 0xd8, 0xff)) return { type: "image/jpeg", kind: "image", extension: "jpg" };
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return { type: "image/png", kind: "image", extension: "png" };
  if (ascii(bytes, 0, 4) === "GIF8") return { type: "image/gif", kind: "image", extension: "gif" };
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") return { type: "image/webp", kind: "image", extension: "webp" };
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WAVE") return { type: "audio/wav", kind: "audio", extension: "wav" };
  if (ascii(bytes, 4, 4) === "ftyp") {
    const brand = ascii(bytes, 8, 4);
    if (brand === "avif" || brand === "avis") return { type: "image/avif", kind: "image", extension: "avif" };
    if (brand === "M4A " || brand === "M4B ") return { type: "audio/mp4", kind: "audio", extension: "m4a" };
    if (brand === "qt  ") return { type: "video/quicktime", kind: "video", extension: "mov" };
    // HEIC and other still-image brands show in few browsers.
    if (/^(?:heic|heix|hevc|mif1|msf1)$/.test(brand)) return null;
    return { type: "video/mp4", kind: "video", extension: "mp4" };
  }
  if (at(0, 0x1a, 0x45, 0xdf, 0xa3)) {
    // Matroska in general plays in few browsers; its WebM profile in all.
    return ascii(bytes, 0, Math.min(bytes.length, 64)).includes("webm") ? { type: "video/webm", kind: "video", extension: "webm" } : null;
  }
  if (ascii(bytes, 0, 4) === "OggS") return { type: "audio/ogg", kind: "audio", extension: "ogg" };
  if (ascii(bytes, 0, 4) === "fLaC") return { type: "audio/flac", kind: "audio", extension: "flac" };
  if (ascii(bytes, 0, 3) === "ID3") return { type: "audio/mpeg", kind: "audio", extension: "mp3" };
  if (bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0) {
    // An MPEG audio frame: layer bits of 00 are AAC in an ADTS stream, the rest MP3.
    return ((bytes[1] ?? 0) & 0x06) === 0
      ? { type: "audio/aac", kind: "audio", extension: "aac" }
      : { type: "audio/mpeg", kind: "audio", extension: "mp3" };
  }
  if (ascii(bytes, 0, 5) === "%PDF-") return { type: "application/pdf", kind: "pdf", extension: "pdf" };
  return null;
}

/**
 * A file's name as kept in its address: lowercase letters, digits, dots and
 * dashes, at most 60 characters before the extension, which is always the
 * one its type has.
 */
export function storedName(name: string | null | undefined, extension: string): string {
  const base = (name ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\.[a-z0-9]{1,5}$/, "")
    .replace(/[^a-z0-9.]+/g, "-")
    .replace(/\.{2,}/g, ".")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 60)
    .replace(/[-.]+$/, "");
  return `${base || "file"}.${extension}`;
}

const EMBED_KINDS: Record<string, FileKind> = {
  jpg: "image",
  png: "image",
  gif: "image",
  webp: "image",
  avif: "image",
  mp4: "video",
  mov: "video",
  webm: "video",
  mp3: "audio",
  m4a: "audio",
  aac: "audio",
  ogg: "audio",
  wav: "audio",
  flac: "audio",
  pdf: "pdf",
};

/** How a stored file shows in a page, from its address's extension. */
export function embedKind(address: string): FileKind | null {
  const extension = /\.([a-z0-9]{2,5})$/.exec(address)?.[1];
  return extension ? (EMBED_KINDS[extension] ?? null) : null;
}

/** "3.2 MB": a size as people read it. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}
