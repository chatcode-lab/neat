-- Paid plans (2026-11-25). What an account bought, and what that unlocks:
-- its own domains (connected by the owner, through Cloudflare for SaaS), and
-- with Pro, tracking pixels, a page without the neat.link sign, subpages and
-- uploaded files.

-- Purchases from Stripe Checkout, or given by hand. An account's plan is
-- worked out from the rows still running; it is never stored.
CREATE TABLE purchases (
  -- The Checkout Session (cs_…), or grant_<…> for one given by hand.
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
  product TEXT NOT NULL CHECK (product IN ('domains', 'pro_year', 'pro_life')),
  customer_id TEXT,
  subscription_id TEXT UNIQUE,
  payment_intent_id TEXT,
  -- What was paid, tax included, in the currency's smallest unit.
  amount INTEGER NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'usd',
  created_at INTEGER NOT NULL,
  -- Null for a purchase that lasts; for the yearly plan, the end of the
  -- paid year and a few days' grace, moved on at each renewal.
  ends_at INTEGER,
  refunded_at INTEGER
) STRICT;
CREATE INDEX purchases_user ON purchases (user_id);
CREATE INDEX purchases_payment ON purchases (payment_intent_id) WHERE payment_intent_id IS NOT NULL;

-- An account's Checkout Session not yet finished: starting another expires
-- it, so an account cannot pay twice by opening two payment links.
CREATE TABLE checkouts (
  user_id TEXT PRIMARY KEY REFERENCES "user" ("id") ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;

-- The owner of a domain connected so far is neat.link's own account; it
-- keeps its domains, and gets everything else, for good.
INSERT INTO purchases (id, user_id, product, created_at)
  SELECT DISTINCT 'grant_' || site.owner_id, site.owner_id, 'pro_life', unixepoch()
  FROM domains JOIN sites AS site ON site.id = domains.site_id;

-- Pro settings of a site: its owner's tracking pixels ({"google": "G-…",
-- "meta": "…", "tiktok": "…"}) and whether its pages show the neat.link sign.
-- Both apply only while the owner has Pro.
ALTER TABLE sites ADD COLUMN pixels TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(pixels) AND json_type(pixels) = 'object');
ALTER TABLE sites ADD COLUMN branding INTEGER NOT NULL DEFAULT 1 CHECK (branding IN (0, 1));

-- Pages again, now with subpages: the main page has the empty path and no
-- private ID; a subpage always has a private ID (neat.link/<handle>/<id>,
-- never indexed, changed by rotating it) and, once made public, a path
-- (neat.link/<handle>/<path>, indexed). Both addresses work at once.
CREATE TABLE pages_next (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites (id) ON DELETE CASCADE,
  path TEXT CHECK (path IS NULL OR path = '' OR (path = lower(path) AND length(path) BETWEEN 1 AND 80)),
  private_id TEXT,
  title TEXT NOT NULL,
  headline TEXT NOT NULL DEFAULT '',
  -- CommonMark, raw HTML disabled when rendered.
  body TEXT NOT NULL DEFAULT '',
  -- JSON array of {"label": ..., "url": ...}; the main page's buttons.
  buttons TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(buttons) AND json_type(buttons) = 'array'),
  -- The main page's picture: its key in the MEDIA bucket.
  image_key TEXT,
  -- 'unlisted' (url only, noindex) for a main page comes later.
  visibility TEXT NOT NULL DEFAULT 'public' CHECK (visibility IN ('public', 'unlisted')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (site_id, path),
  UNIQUE (site_id, private_id),
  CHECK (CASE WHEN path = '' THEN private_id IS NULL ELSE private_id IS NOT NULL END)
) STRICT;
INSERT INTO pages_next (id, site_id, path, private_id, title, headline, body, buttons, image_key, visibility, created_at, updated_at)
  SELECT id, site_id, path, NULL, title, headline, body, buttons, image_key, visibility, created_at, updated_at FROM pages;
DROP TABLE pages;
ALTER TABLE pages_next RENAME TO pages;

-- Domains again, now connected by owners: a site's one domain, waiting for
-- its DNS and certificate ('pending') or served ('active'), which also
-- makes it the site's address. Several sites may wait for the same name;
-- one can hold it.
CREATE TABLE domains_next (
  site_id TEXT PRIMARY KEY REFERENCES sites (id) ON DELETE CASCADE,
  hostname TEXT NOT NULL CHECK (hostname = lower(hostname) AND length(hostname) BETWEEN 3 AND 253),
  -- This claim's own DNS target, <code>.<DOMAIN_TARGET>, and the TXT value
  -- that proves it where a provider hides the CNAME.
  code TEXT NOT NULL UNIQUE,
  -- 'saas': a Cloudflare for SaaS custom hostname; 'route': a zone in
  -- neat.link's own Cloudflare account, with a Worker route.
  kind TEXT NOT NULL DEFAULT 'saas' CHECK (kind IN ('route', 'saas')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active')),
  -- The DNS zone the name is in, and its provider, as found by its nameservers.
  zone TEXT,
  provider TEXT,
  -- The custom hostname at Cloudflare, its certificate's status, when it
  -- was made, and the answer Cloudflare may ask the domain for to prove it
  -- (served at the path by the Worker).
  cf_id TEXT,
  ssl_status TEXT,
  registered_at INTEGER,
  cf_http_path TEXT,
  cf_http_body TEXT,
  -- Set when a hostname made on a TXT record alone never worked for a
  -- week: it is not made again until the owner checks it themselves.
  stalled_at INTEGER,
  -- Why the last check could not connect it, for the owner.
  error TEXT,
  created_at INTEGER NOT NULL,
  checked_at INTEGER,
  verified_at INTEGER,
  -- When it stopped working (its DNS or its hostname); a week later it is let go.
  lost_at INTEGER
) STRICT;
CREATE UNIQUE INDEX domains_hostname ON domains_next (hostname) WHERE status = 'active';
CREATE INDEX domains_status ON domains_next (status, checked_at);
INSERT INTO domains_next (site_id, hostname, code, kind, status, ssl_status, created_at, checked_at, verified_at)
  SELECT site_id, hostname, lower(hex(randomblob(6))), 'route', 'active', 'active', created_at, created_at, created_at FROM domains;
DROP TABLE domains;
ALTER TABLE domains_next RENAME TO domains;

-- Files an account uploaded to embed in its pages, kept in the MEDIA bucket.
CREATE TABLE media (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
  key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  size INTEGER NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX media_user ON media (user_id, created_at);
