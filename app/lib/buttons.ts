/** A button under a page's text: what it says and where it goes. */
export interface PageButton {
  label: string;
  url: string;
}

export const MAX_BUTTONS = 12;
export const MAX_LABEL_LENGTH = 40;
export const MAX_URL_LENGTH = 2000;

/** The services a button's icon and colour can show; anything else is a plain link. */
export const LINK_KINDS = [
  "amazon", "apple", "behance", "bluesky", "discord", "dribbble", "email", "facebook",
  "github", "gitlab", "instagram", "linkedin", "mastodon", "medium", "patreon", "phone",
  "pinterest", "reddit", "signal", "snapchat", "soundcloud", "spotify", "substack",
  "telegram", "threads", "tiktok", "twitch", "viber", "vk", "whatsapp", "x", "youtube",
  "link",
] as const;
export type LinkKind = (typeof LINK_KINDS)[number];

const EMAIL = /^[a-z0-9_.+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i;
const PHONE = /^\+?[0-9][0-9 ()-]{3,24}[0-9]$/;

/**
 * A button's address as typed, made into one a browser can open: an email
 * becomes mailto:, a phone number tel:, a bare domain https://. Null when it
 * is none of these. Only https, http, mailto and tel are allowed, so a
 * button can never run script.
 */
export function normalizeButtonUrl(raw: string): string | null {
  const value = raw.trim();
  if (!value || value.length > MAX_URL_LENGTH) return null;
  if (/^mailto:/i.test(value)) {
    const address = value.slice("mailto:".length);
    return EMAIL.test(address) ? `mailto:${address}` : null;
  }
  if (/^tel:/i.test(value)) {
    const number = value.slice("tel:".length);
    return PHONE.test(number) ? `tel:${compactPhone(number)}` : null;
  }
  if (EMAIL.test(value)) return `mailto:${value}`;
  if (PHONE.test(value)) return `tel:${compactPhone(value)}`;
  if (/\s/.test(value)) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(value) ? value : `https://${value.replace(/^\/\//, "")}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username || url.password) return null;
  // The parser punycodes international names, so a real host is plain ASCII
  // with a dot and a top-level part of at least two characters.
  if (!/^(?:[a-z0-9-]+\.)+(?:[a-z]{2,}|xn--[a-z0-9-]+)$/i.test(url.hostname)) return null;
  // Legacy pages had t.me/@name, which Telegram does not open.
  if (/^(t\.me|telegram\.me)$/i.test(url.hostname)) url.pathname = url.pathname.replace(/^\/@/, "/");
  return url.href;
}

function compactPhone(value: string): string {
  return value.replace(/[ ()-]/g, "");
}

const DOMAINS: Array<[LinkKind, RegExp]> = [
  ["facebook", /^(facebook\.com|fb\.com|fb\.me|fb\.watch|m\.facebook\.com)$/],
  ["instagram", /^(instagram\.com|instagr\.am)$/],
  ["tiktok", /^(tiktok\.com|vm\.tiktok\.com)$/],
  ["telegram", /^(t\.me|telegram\.me|telesco\.pe|telegram\.org)$/],
  ["x", /^(x\.com|twitter\.com|t\.co|mobile\.twitter\.com)$/],
  ["whatsapp", /^(wa\.me|whatsapp\.com|api\.whatsapp\.com|chat\.whatsapp\.com)$/],
  ["youtube", /^(youtu\.be|youtube\.com|m\.youtube\.com|music\.youtube\.com)$/],
  ["github", /^(github\.com|gist\.github\.com|[a-z0-9-]+\.github\.io)$/],
  ["gitlab", /^gitlab\.com$/],
  ["linkedin", /^(linkedin\.com|lnkd\.in)$/],
  ["discord", /^(discord\.com|discord\.gg)$/],
  ["amazon", /^amazon\.[a-z.]+$/],
  ["apple", /^(apps\.apple\.com|music\.apple\.com|podcasts\.apple\.com)$/],
  ["patreon", /^patreon\.com$/],
  ["twitch", /^twitch\.tv$/],
  ["pinterest", /^(pin\.it|pinterest\.[a-z.]+)$/],
  ["reddit", /^(reddit\.com|redd\.it)$/],
  ["spotify", /^(open\.spotify\.com|spotify\.com|spotify\.link)$/],
  ["soundcloud", /^soundcloud\.com$/],
  ["medium", /^(medium\.com|[a-z0-9-]+\.medium\.com)$/],
  ["substack", /^([a-z0-9-]+\.)?substack\.com$/],
  ["threads", /^threads\.(net|com)$/],
  ["bluesky", /^bsky\.app$/],
  ["behance", /^behance\.net$/],
  ["dribbble", /^dribbble\.com$/],
  ["snapchat", /^snapchat\.com$/],
  ["signal", /^signal\.me$/],
  ["viber", /^viber\.com$/],
  ["vk", /^(vk\.com|vk\.ru)$/],
];

/** Which service a normalized button address belongs to, for its icon. */
export function linkKind(url: string): LinkKind {
  if (url.startsWith("mailto:")) return "email";
  if (url.startsWith("tel:")) return "phone";
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "link";
  }
  for (const [kind, pattern] of DOMAINS) if (pattern.test(host)) return kind;
  if (/(^|\.)mastodon\.|^mstdn\./.test(host)) return "mastodon";
  return "link";
}

/** A short form of a button's address for text views: no scheme, no trailing slash. */
export function shortUrl(url: string): string {
  return url.replace(/^(https?:\/\/|mailto:|tel:)/, "").replace(/^www\./, "").replace(/\/$/, "");
}

export type ButtonsResult = { ok: true; buttons: PageButton[] } | { ok: false; problem: string };

/**
 * Buttons as sent by the editor, the API or an agent, checked and normalized:
 * an array of {label, url}. Each problem names the button it is about.
 */
export function parseButtons(input: unknown): ButtonsResult {
  if (!Array.isArray(input)) return { ok: false, problem: "buttons must be a list of {label, url}." };
  if (input.length > MAX_BUTTONS) return { ok: false, problem: `A page has at most ${MAX_BUTTONS} buttons.` };
  const buttons: PageButton[] = [];
  for (const [index, item] of input.entries()) {
    const which = `Button ${index + 1}`;
    if (!item || typeof item !== "object") return { ok: false, problem: `${which} must be {label, url}.` };
    const { label, url } = item as { label?: unknown; url?: unknown };
    if (typeof label !== "string" || !label.trim()) return { ok: false, problem: `${which} needs a label.` };
    const clean = label.replace(/\s+/g, " ").trim();
    if ([...clean].length > MAX_LABEL_LENGTH) {
      return { ok: false, problem: `${which}: a label is at most ${MAX_LABEL_LENGTH} characters.` };
    }
    if (typeof url !== "string" || !url.trim()) return { ok: false, problem: `${which} needs a link.` };
    const href = normalizeButtonUrl(url);
    if (!href) {
      return { ok: false, problem: `${which}: "${url.slice(0, 80)}" is not a web address, email or phone number.` };
    }
    buttons.push({ label: clean, url: href });
  }
  return { ok: true, buttons };
}

/** Buttons as stored, read leniently: anything malformed is left out. */
export function storedButtons(json: string): PageButton[] {
  try {
    const value = JSON.parse(json) as unknown;
    if (!Array.isArray(value)) return [];
    return value.filter(
      (item): item is PageButton =>
        Boolean(item) && typeof item.label === "string" && typeof item.url === "string",
    );
  } catch {
    return [];
  }
}
