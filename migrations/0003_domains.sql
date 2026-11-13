-- A site's own domain (borkasm.com), where its page is served besides
-- neat.link/<handle> and which becomes its canonical address. One per site;
-- the twin with or without www is sent to it. For now only domains in
-- neat.link's own Cloudflare account, attached to the Worker by a route.
CREATE TABLE domains (
  hostname TEXT PRIMARY KEY CHECK (hostname = lower(hostname)),
  site_id TEXT NOT NULL UNIQUE REFERENCES sites (id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL
) STRICT;
