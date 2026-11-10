/**
 * Checks of what Telegram signs with the bot's token: the Login Widget's
 * answer (https://core.telegram.org/widgets/login#checking-authorization)
 * and a Mini App's initData
 * (https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app).
 * Both are an HMAC-SHA256 over the received fields, sorted and joined with
 * newlines, keyed by something only the bot's owner can derive.
 */

/** A Telegram user as both checks return them. */
export interface TelegramUser {
  id: number;
  firstName: string;
  lastName: string | null;
  username: string | null;
  photoUrl: string | null;
}

/** How long a signed answer is accepted after Telegram made it. */
export const MAX_AUTH_AGE_SECONDS = 24 * 3600;

const encoder = new TextEncoder();

async function hmac(key: ArrayBuffer | Uint8Array<ArrayBuffer>, data: string): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(data));
}

function hex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function sameText(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) difference |= a.charCodeAt(index) ^ b.charCodeAt(index);
  return difference === 0;
}

function dataCheckString(fields: Map<string, string>, leaveOut: readonly string[]): string {
  return [...fields.entries()]
    .filter(([key]) => !leaveOut.includes(key))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
}

function freshEnough(authDate: string | undefined, now: number): boolean {
  const at = Number(authDate);
  return Number.isInteger(at) && at <= now + 60 && now - at <= MAX_AUTH_AGE_SECONDS;
}

/**
 * The Login Widget's answer, as the query of its redirect: the user's id,
 * names, username, photo_url, auth_date and hash. The key is the SHA-256 of
 * the bot's token. Null when it is not genuine or too old.
 */
export async function verifyLoginWidget(params: URLSearchParams, botToken: string, now: number): Promise<TelegramUser | null> {
  const fields = new Map<string, string>();
  for (const key of ["id", "first_name", "last_name", "username", "photo_url", "auth_date", "hash"]) {
    const value = params.get(key);
    if (value !== null) fields.set(key, value);
  }
  const hash = fields.get("hash");
  if (!hash || !freshEnough(fields.get("auth_date"), now)) return null;
  const secret = await crypto.subtle.digest("SHA-256", encoder.encode(botToken));
  const expected = hex(await hmac(secret, dataCheckString(fields, ["hash"])));
  if (!sameText(expected, hash.toLowerCase())) return null;
  const id = Number(fields.get("id"));
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  return {
    id,
    firstName: fields.get("first_name") ?? "",
    lastName: fields.get("last_name") ?? null,
    username: fields.get("username") ?? null,
    photoUrl: fields.get("photo_url") ?? null,
  };
}

/** A Mini App launch: who opened it and what it was opened with. */
export interface MiniAppLaunch {
  user: TelegramUser;
  /** The `startapp` parameter of the link that opened it, if any. */
  startParam: string | null;
}

/**
 * A Mini App's initData string. The key is the HMAC of the bot's token under
 * "WebAppData". Every field but the hash is signed; newer clients add a
 * `signature` field for third parties, which is checked both included and
 * left out, so either reading of the documentation passes. Null when it is
 * not genuine or too old.
 */
export async function verifyInitData(initData: string, botToken: string, now: number): Promise<MiniAppLaunch | null> {
  if (!initData || initData.length > 8192) return null;
  const params = new URLSearchParams(initData);
  const fields = new Map<string, string>();
  for (const [key, value] of params) fields.set(key, value);
  const hash = fields.get("hash");
  if (!hash || !freshEnough(fields.get("auth_date"), now)) return null;
  const secret = await hmac(encoder.encode("WebAppData"), botToken);
  let genuine = false;
  for (const leaveOut of [["hash"], ["hash", "signature"]]) {
    const expected = hex(await hmac(secret, dataCheckString(fields, leaveOut)));
    if (sameText(expected, hash.toLowerCase())) genuine = true;
  }
  if (!genuine) return null;
  let raw: { id?: unknown; first_name?: unknown; last_name?: unknown; username?: unknown; photo_url?: unknown };
  try {
    raw = JSON.parse(fields.get("user") ?? "") as typeof raw;
  } catch {
    return null;
  }
  if (typeof raw.id !== "number" || !Number.isSafeInteger(raw.id) || raw.id <= 0) return null;
  const text = (value: unknown) => (typeof value === "string" && value ? value : null);
  return {
    user: {
      id: raw.id,
      firstName: text(raw.first_name) ?? "",
      lastName: text(raw.last_name),
      username: text(raw.username),
      photoUrl: text(raw.photo_url),
    },
    startParam: fields.get("start_param") ?? null,
  };
}

/** A person's name as Telegram shows it. */
export function telegramName(user: Pick<TelegramUser, "firstName" | "lastName">): string {
  return [user.firstName, user.lastName].filter(Boolean).join(" ").trim() || "Telegram user";
}

/** Signs fields the way Telegram does, for tests and local development only. */
export async function signForTests(
  fields: Record<string, string>,
  botToken: string,
  kind: "widget" | "webapp",
): Promise<string> {
  const map = new Map(Object.entries(fields));
  const secret =
    kind === "widget"
      ? await crypto.subtle.digest("SHA-256", encoder.encode(botToken))
      : await hmac(encoder.encode("WebAppData"), botToken);
  return hex(await hmac(secret, dataCheckString(map, ["hash"])));
}
