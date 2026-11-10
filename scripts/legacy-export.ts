/**
 * Turns the legacy bot's SQLite database into SQL for this app's D1, and a
 * script that copies the legacy pictures into R2.
 *
 *   npm run legacy:export -- [path/to/neat.sqlite] [out-dir]
 *   wrangler d1 execute DB --local --file <out-dir>/legacy.sql
 *   sh <out-dir>/legacy-images.sh --local      # or --remote
 *
 * Every legacy Telegram user becomes an account with that Telegram identity
 * linked and a placeholder email, so they keep access through the bot, the
 * Mini App and Telegram sign-in. Every site not deleted keeps its handle,
 * whether it was live, and its dates. Bodies are converted from Telegram's
 * MarkdownV2 to CommonMark. IDs are derived from the legacy ones and every
 * insert is OR IGNORE, so running it again changes nothing.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { normalizeButtonUrl } from "../app/lib/buttons";
import { HANDLE_PATTERN } from "../app/lib/handles";
import { telegramToCommonMark } from "../app/lib/tg-markdown";

const [dbPath = "../neat-legacy/db/neat.sqlite", outDir = ".wrangler/legacy"] = process.argv.slice(2);

interface LegacyUser {
  pk: number;
  created: string;
  full_name: string;
  username: string | null;
}

interface LegacySite {
  pk: number;
  created: string;
  published: string | null;
  name: string;
  owner_id: number;
  is_live: number;
  image_filename: string | null;
  title: string;
  body: string;
  links: string;
}

/** A legacy timestamp, stored by SQLite in UTC without a zone, as Unix seconds. */
function seconds(value: string | null): number | null {
  if (!value) return null;
  const parsed = Date.parse(`${value.replace(" ", "T").replace(/\+00:00$/, "")}Z`);
  return Number.isNaN(parsed) ? null : Math.floor(parsed / 1000);
}

const sql = (value: string | number | null) =>
  value === null ? "NULL" : typeof value === "number" ? String(value) : `'${value.replace(/'/g, "''")}'`;

const db = new DatabaseSync(dbPath, { readOnly: true });
const users = db.prepare(`SELECT pk, created, full_name, username FROM user ORDER BY pk`).all() as unknown as LegacyUser[];
const sites = db
  .prepare(
    `SELECT pk, created, published, name, owner_id, is_live, image_filename, title, body, links
     FROM neat_site WHERE deleted = 0 ORDER BY pk`,
  )
  .all() as unknown as LegacySite[];

const lines: string[] = [
  `-- Legacy import from ${path.basename(dbPath)}: ${users.length} users, ${sites.length} sites.`,
  "PRAGMA defer_foreign_keys = true;",
];
const now = Math.floor(Date.now() / 1000);

for (const user of users) {
  const created = seconds(user.created) ?? now;
  const iso = new Date(created * 1000).toISOString();
  const name = user.full_name.trim() || user.username || "Telegram user";
  lines.push(
    `INSERT OR IGNORE INTO "user" ("id", "name", "email", "emailVerified", "image", "createdAt", "updatedAt") VALUES (${sql(`tg${user.pk}`)}, ${sql(name)}, ${sql(`tg-${user.pk}@telegram.invalid`)}, 0, NULL, ${sql(iso)}, ${sql(iso)});`,
    `INSERT OR IGNORE INTO "account" ("id", "accountId", "providerId", "userId", "createdAt", "updatedAt") VALUES (${sql(`tgacc${user.pk}`)}, ${sql(String(user.pk))}, 'telegram', ${sql(`tg${user.pk}`)}, ${sql(iso)}, ${sql(iso)});`,
    `INSERT OR IGNORE INTO telegram_users (telegram_id, username, name, updated_at) VALUES (${sql(String(user.pk))}, ${sql(user.username)}, ${sql(name)}, ${now});`,
  );
}

const images: string[] = [];
const problems: string[] = [];
for (const site of sites) {
  const handle = site.name.toLowerCase();
  if (!HANDLE_PATTERN.test(handle)) {
    problems.push(`site ${site.pk}: handle "${site.name}" does not fit the pattern; skipped`);
    continue;
  }
  const created = seconds(site.created) ?? now;
  const published = site.is_live ? (seconds(site.published) ?? created) : null;
  const updated = Math.max(created, published ?? 0);
  let legacyButtons: Array<{ title?: unknown; url?: unknown }> = [];
  try {
    legacyButtons = JSON.parse(site.links) as typeof legacyButtons;
  } catch {
    problems.push(`site ${site.pk}: links are not JSON; left out`);
  }
  const buttons = [];
  for (const button of legacyButtons) {
    const label = String(button.title ?? "").replace(/\s+/g, " ").trim();
    const url = normalizeButtonUrl(String(button.url ?? "").replace(/‌/g, ""));
    if (label && url) buttons.push({ label, url });
    else problems.push(`site ${site.pk}: button ${JSON.stringify(button)} left out`);
  }
  const imageKey = site.image_filename ? `legacy/${site.image_filename}` : null;
  if (site.image_filename) images.push(site.image_filename);
  lines.push(
    `INSERT OR IGNORE INTO sites (id, owner_id, handle, published_at, created_at, updated_at, legacy_id) VALUES (${sql(`legacy${site.pk}`)}, ${sql(`tg${site.owner_id}`)}, ${sql(handle)}, ${sql(published)}, ${created}, ${updated}, ${site.pk});`,
    `INSERT OR IGNORE INTO pages (id, site_id, path, title, headline, body, buttons, image_key, created_at, updated_at) VALUES (${sql(`legacypage${site.pk}`)}, ${sql(`legacy${site.pk}`)}, '', ${sql(site.title.replace(/\s+/g, " ").trim() || handle)}, '', ${sql(telegramToCommonMark(site.body))}, ${sql(JSON.stringify(buttons))}, ${sql(imageKey)}, ${created}, ${updated});`,
  );
}

const script = [
  "#!/bin/sh",
  "# Copies the legacy pictures into R2. Pass --local or --remote.",
  "set -eu",
  'WHERE="${1:---local}"',
  'BUCKET="${BUCKET:-neat-link-media}"',
  `if [ "$WHERE" = "--local" ]; then BUCKET="\${BUCKET_LOCAL:-neat-link-local-media}"; fi`,
  'TMP="$(mktemp -d)"',
  ...images.flatMap((file) => [
    `curl -fsSL -o "$TMP/${file}" "https://neat.link/_usercontent/${file}"`,
    `npx wrangler r2 object put "$BUCKET/legacy/${file}" --file "$TMP/${file}" --content-type image/jpeg --cache-control "public, max-age=31536000, immutable" "$WHERE"`,
  ]),
  'rm -rf "$TMP"',
  "",
];

mkdirSync(outDir, { recursive: true });
writeFileSync(path.join(outDir, "legacy.sql"), `${lines.join("\n")}\n`);
writeFileSync(path.join(outDir, "legacy-images.sh"), script.join("\n"), { mode: 0o755 });
console.log(`${users.length} users, ${sites.length} sites, ${images.length} pictures → ${outDir}/legacy.sql, ${outDir}/legacy-images.sh`);
for (const problem of problems) console.warn(`note: ${problem}`);
