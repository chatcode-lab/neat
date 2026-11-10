-- The first schema of the Cloudflare rewrite (2026-11-10).
--
-- Better Auth's tables come first, as its SQLite generator writes them: they
-- hold identities and sessions and are never read by public queries. Better
-- Auth stores times as ISO strings and flags as 0 or 1. App tables are STRICT,
-- keep times as Unix seconds, and mark removal with a timestamp.

CREATE TABLE "user" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "name" TEXT NOT NULL,
  -- Google's verified email; for an account that only has Telegram, a
  -- placeholder `tg-<id>@telegram.invalid` that can match no real address.
  "email" TEXT NOT NULL UNIQUE,
  "emailVerified" INTEGER NOT NULL,
  "image" TEXT,
  "createdAt" DATE NOT NULL,
  "updatedAt" DATE NOT NULL
);

CREATE TABLE "session" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "expiresAt" DATE NOT NULL,
  "token" TEXT NOT NULL UNIQUE,
  "createdAt" DATE NOT NULL,
  "updatedAt" DATE NOT NULL,
  "ipAddress" TEXT,
  "userAgent" TEXT,
  "userId" TEXT NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE
);
CREATE INDEX "session_userId_idx" ON "session" ("userId");

-- Google and Telegram identities. Provider tokens are never kept. A Telegram
-- account's accountId is the Telegram user ID, as text.
CREATE TABLE "account" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "accountId" TEXT NOT NULL,
  "providerId" TEXT NOT NULL,
  "userId" TEXT NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
  "accessToken" TEXT,
  "refreshToken" TEXT,
  "idToken" TEXT,
  "accessTokenExpiresAt" DATE,
  "refreshTokenExpiresAt" DATE,
  "scope" TEXT,
  "password" TEXT,
  "createdAt" DATE NOT NULL,
  "updatedAt" DATE NOT NULL
);
CREATE INDEX "account_userId_idx" ON "account" ("userId");
-- One account here per provider identity.
CREATE UNIQUE INDEX "account_provider_identity" ON "account" ("providerId", "accountId");

CREATE TABLE "verification" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "identifier" TEXT NOT NULL,
  "value" TEXT NOT NULL,
  "expiresAt" DATE NOT NULL,
  "createdAt" DATE NOT NULL,
  "updatedAt" DATE NOT NULL
);
CREATE INDEX "verification_identifier_idx" ON "verification" ("identifier");

-- A site is a handle, neat.link/<handle>, owned by one account.
CREATE TABLE sites (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
  handle TEXT NOT NULL CHECK (handle = lower(handle) AND length(handle) BETWEEN 1 AND 40),
  -- Null while a draft: only the owner sees it, and it is not in the sitemap.
  published_at INTEGER,
  -- For themes later; every site has the default one now.
  theme TEXT NOT NULL DEFAULT 'default',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  -- The legacy bot's row, for imported sites.
  legacy_id INTEGER UNIQUE
) STRICT;
-- A handle belongs to one live site; a deleted site gives it up at once.
CREATE UNIQUE INDEX sites_handle ON sites (handle) WHERE deleted_at IS NULL;
CREATE INDEX sites_owner ON sites (owner_id, created_at);

-- A site's pages. The main page has the empty path; subpages such as
-- neat.link/elon/cv come later as a paid feature.
CREATE TABLE pages (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites (id) ON DELETE CASCADE,
  path TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL,
  headline TEXT NOT NULL DEFAULT '',
  -- CommonMark, raw HTML disabled when rendered.
  body TEXT NOT NULL DEFAULT '',
  -- JSON array of {"label": ..., "url": ...}.
  buttons TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(buttons) AND json_type(buttons) = 'array'),
  -- The picture's key in the MEDIA bucket.
  image_key TEXT,
  -- 'unlisted' (url only, noindex) comes later as a paid feature.
  visibility TEXT NOT NULL DEFAULT 'public' CHECK (visibility IN ('public', 'unlisted')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (site_id, path)
) STRICT;

-- Bearer tokens for the API and MCP: made by the owner in Settings, or issued
-- to an app through OAuth (client_id set). Only a hash is kept. Revoked tokens
-- stay, for the record.
CREATE TABLE api_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  label TEXT,
  client_id TEXT,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at INTEGER
) STRICT;
CREATE INDEX api_tokens_user ON api_tokens (user_id, created_at);

-- Apps that connect through OAuth, such as Claude, Codex or ChatGPT: either
-- registered (RFC 7591) or named by the address of their metadata document,
-- kept here once fetched.
CREATE TABLE oauth_clients (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  -- JSON array of the redirect addresses it may use.
  redirect_uris TEXT NOT NULL,
  fetched_at INTEGER,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
) STRICT;

-- Authorization codes, each for one exchange within ten minutes.
CREATE TABLE oauth_codes (
  code_hash TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  resource TEXT,
  expires_at INTEGER NOT NULL
) STRICT;

-- What Telegram last told about a linked Telegram user: their username (a
-- handle may be as short as one's own username) and name, for the bot's
-- greetings and the Settings page.
CREATE TABLE telegram_users (
  telegram_id TEXT PRIMARY KEY,
  username TEXT,
  name TEXT NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

-- One-time tokens between the bot and the web, valid ten minutes:
--   login: a sign-in link the bot sends a linked Telegram user;
--   link: a Settings page's request to link the Telegram account that
--         opens the bot with it.
-- Only a hash of each token is kept.
CREATE TABLE telegram_tokens (
  token_hash TEXT PRIMARY KEY,
  purpose TEXT NOT NULL CHECK (purpose IN ('login', 'link')),
  user_id TEXT NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
) STRICT;
