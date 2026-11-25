/**
 * Tracking pixels a Pro owner can add to a site's pages: Google's tag
 * (Analytics or Ads), Meta's pixel and TikTok's pixel. A page with any of
 * them loads /pixels.js, which loads the vendors' scripts, and its Content
 * Security Policy lets those vendors in; pages without pixels stay as
 * closed as before.
 */

export type PixelVendor = "google" | "meta" | "tiktok";
export type Pixels = Partial<Record<PixelVendor, string>>;

interface VendorInfo {
  name: string;
  /** What an ID looks like, and an example for people. */
  pattern: RegExp;
  example: string;
  /** Where its scripts come from, and where they send and load things. */
  script: string[];
  connect: string[];
  img: string[];
  frame: string[];
}

export const PIXEL_VENDORS: Record<PixelVendor, VendorInfo> = {
  google: {
    name: "Google tag",
    pattern: /^(?:G|AW|GT|DC)-[A-Z0-9]{4,20}$/,
    example: "G-XXXXXXXXXX or AW-123456789",
    script: ["https://*.googletagmanager.com", "https://www.googleadservices.com", "https://googleads.g.doubleclick.net", "https://www.google.com"],
    connect: [
      "https://*.google-analytics.com",
      "https://*.analytics.google.com",
      "https://*.googletagmanager.com",
      "https://*.g.doubleclick.net",
      "https://www.google.com",
      "https://www.googleadservices.com",
    ],
    img: [
      "https://*.google-analytics.com",
      "https://*.googletagmanager.com",
      "https://*.g.doubleclick.net",
      "https://www.google.com",
      "https://www.googleadservices.com",
    ],
    frame: ["https://td.doubleclick.net", "https://www.googletagmanager.com"],
  },
  meta: {
    name: "Meta pixel",
    pattern: /^\d{8,20}$/,
    example: "1234567890123456",
    script: ["https://connect.facebook.net"],
    connect: ["https://www.facebook.com", "https://connect.facebook.net"],
    img: ["https://www.facebook.com"],
    frame: [],
  },
  tiktok: {
    name: "TikTok pixel",
    pattern: /^[A-Z0-9]{8,32}$/,
    example: "C4ABCDEFGHIJKLMNOPQR",
    script: ["https://analytics.tiktok.com"],
    connect: ["https://analytics.tiktok.com", "https://*.tiktok.com", "https://*.tiktokw.us"],
    img: ["https://analytics.tiktok.com"],
    frame: [],
  },
};

export const PIXEL_VENDOR_IDS = Object.keys(PIXEL_VENDORS) as PixelVendor[];

/** Pixels as stored, keeping only well-formed IDs. */
export function storedPixels(json: string | null | undefined): Pixels {
  let value: unknown;
  try {
    value = JSON.parse(json || "{}");
  } catch {
    return {};
  }
  if (!value || typeof value !== "object") return {};
  const pixels: Pixels = {};
  for (const vendor of PIXEL_VENDOR_IDS) {
    const id = (value as Record<string, unknown>)[vendor];
    if (typeof id === "string" && PIXEL_VENDORS[vendor].pattern.test(id)) pixels[vendor] = id;
  }
  return pixels;
}

export type PixelsResult = { ok: true; pixels: Pixels } | { ok: false; problem: string };

/**
 * Pixels as sent by the editor or the API: an object of vendor to ID, where
 * an empty or null ID removes that vendor's pixel. Changes merge into
 * `current`. IDs are trimmed and upper-cased, as vendors show them.
 */
export function parsePixels(input: unknown, current: Pixels = {}): PixelsResult {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, problem: 'pixels must be an object, such as {"google": "G-XXXXXXXXXX"}.' };
  }
  const pixels: Pixels = { ...current };
  for (const [vendor, raw] of Object.entries(input as Record<string, unknown>)) {
    if (!(PIXEL_VENDOR_IDS as string[]).includes(vendor)) {
      return { ok: false, problem: `Pixels can be ${PIXEL_VENDOR_IDS.join(", ")}; not ${vendor}.` };
    }
    const info = PIXEL_VENDORS[vendor as PixelVendor];
    if (raw === null || raw === undefined || (typeof raw === "string" && !raw.trim())) {
      delete pixels[vendor as PixelVendor];
      continue;
    }
    if (typeof raw !== "string") return { ok: false, problem: `The ${info.name} ID must be text.` };
    const id = raw.trim().toUpperCase();
    if (!info.pattern.test(id)) return { ok: false, problem: `That is not a ${info.name} ID: it looks like ${info.example}.` };
    pixels[vendor as PixelVendor] = id;
  }
  return { ok: true, pixels };
}

export const hasPixels = (pixels: Pixels) => PIXEL_VENDOR_IDS.some((vendor) => pixels[vendor]);

/** The vendors a page loads, as the header the page route hands the Worker: "google meta". */
export function pixelVendorsOf(pixels: Pixels): PixelVendor[] {
  return PIXEL_VENDOR_IDS.filter((vendor) => pixels[vendor]);
}

export function parseVendorList(value: string | null): PixelVendor[] {
  if (!value) return [];
  return value.split(/\s+/).filter((vendor): vendor is PixelVendor => (PIXEL_VENDOR_IDS as string[]).includes(vendor));
}
