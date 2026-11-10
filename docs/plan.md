# neat.link: plan and decisions

The record of what neat.link is, how it is built, and why. Read it before
changing behaviour; update it when a decision changes.

## What it is

Mini business-card pages ("link in bio"): `neat.link/<handle>` shows a
picture, a name, an optional headline, a short Markdown text and a column of
buttons, centred. Pages are public, indexed and listed in the sitemap.

It is **agent-first**: everything a person can do in the editor an agent can
do through the MCP server (`/mcp`) or the HTTP API (`/api/v1`), and every
public page is also served as Markdown (`/<handle>.md`, or `Accept:
text/markdown`). `/llms.txt` points agents at all of it.

## Rewrite from the legacy bot (2026-11-10)

The first version (repo `neat-legacy`) was a Python Telegram bot that edited
pages in chat, rendered each one with Hugo, screenshotted a cover with
Firefox and uploaded the static files to S3. It needed Redis, rq, Hugo,
Firefox, geckodriver and a Telethon user account that poked @WebpageBot to
refresh Telegram link previews.

The rewrite runs entirely on Cloudflare, following `../aionly`:

| Concern | Legacy | Now |
| --- | --- | --- |
| Hosting | Hugo → S3 static files | One Worker, React Router SSR; covers, Markdown and the sitemap edge-cached |
| Data | SQLite (peewee) + Redis | D1, raw SQL |
| Media | S3 `_usercontent/` | R2 `MEDIA` bucket on `media.neat.link` |
| Covers | Firefox screenshot | resvg-wasm SVG → PNG, cached at the edge |
| Editing | Telegram chat | Web editor (also the Telegram Mini App), API, MCP |
| Bot | Long polling, state in Redis | Webhook on the same Worker, stateless |
| Queue | rq | None needed: pages render on request |

Static generation is dropped: with ~60 pages and SSR at the edge, a page is
rendered on request (one indexed D1 read); an edit is live at once, so there
is no "publish queue". Covers, Markdown views and the sitemap are kept in the
edge cache, keyed by content version where it matters. Only a site's **published** flag remains (see below).

Dropped on purpose:

- The Telethon user account and @WebpageBot refreshing. Telegram re-reads a
  page's preview on its own schedule; covers carry a content version in their
  URL so a new cover is fetched whenever Telegram re-reads the page.
- Creating a page by scraping Instagram, TikTok or Taplink (RocketAPI and
  HTML parsing). Prefilling from public profiles comes back later as a free
  feature, starting with GitHub (see "Later").
- Content editing inside the chat. The bot now opens the editor as a Mini
  App, which is the same UI as the web.

## Accounts and sign-in

- **New accounts are made with Google only** (better-auth, as in aionly).
  Provider tokens are never stored.
- **Telegram is a linked identity**, not a way to sign up: an `account` row
  with `providerId = 'telegram'` and the Telegram user ID as `accountId`.
  Once linked it signs in three ways:
  1. Telegram Login on `/signin` (https://core.telegram.org/bots/telegram-login):
     OpenID Connect's code flow with PKCE at oauth.telegram.org, the bot's ID
     as client ID and its client secret from BotFather (Login Widget, where
     the site's origin and `/auth/telegram/callback` must be allowed URLs).
     The ID token is checked against Telegram's JWKS. It asks for `openid
     profile` only. It replaced the legacy Login Widget (hash keyed by the
     bot token), which is no longer used,
  2. the Mini App: `initData` signed by the bot token, verified server-side,
  3. a one-time sign-in link the bot sends (`/login`), valid 10 minutes and
     consumed by a POST so link scanners cannot use it.
  All three create an ordinary better-auth session (same table, same signed
  cookie), so the rest of the app does not care how someone signed in.
- **Legacy users keep access**: every legacy Telegram user is imported as a
  user with a Telegram account and no Google one. Their email is a
  placeholder `tg-<id>@telegram.invalid` (better-auth requires one; `.invalid`
  can never be delivered or match a real Google email). Linking Google later
  replaces it.
- A Telegram identity that is not linked to an account gets a message to sign
  up with Google in a browser (Google refuses OAuth inside the Telegram
  webview) and link Telegram in Settings.
- Sessions: 30 days, refreshed daily, cookie cache off (sign-out takes effect
  at once). Only better-auth's callback routes are reachable over HTTP;
  everything else is called server-side (aionly's lockdown).

## Sites and pages

- A **site** is a handle (`neat.link/<handle>`) owned by one user. Up to 2
  sites per account on the free plan (the legacy limit).
- Handles: 1–32 characters, `a-z 0-9 _`, starting with a letter and not
  ending with `_` (the legacy rule, so every old link still resolves). New
  handles must be at least 6 characters unless the owner's linked Telegram
  username is exactly that handle. A reserved list protects routes and words
  like `api`, `app`, `admin`, `help`.
- A site has **pages**; the main page has the empty path. Subpages
  (`/elon/cv`) are a paid feature for later; the table already allows them.
- A page is: title, optional headline, Markdown body, up to 12 buttons
  (`label` + `url`), optional picture. URLs may be `https://…`, a bare
  domain, an email (becomes `mailto:`) or a phone (`tel:`). Icons come from
  the button's domain (Telegram, Instagram, WhatsApp, …).
- **Published**: a site is a draft until its owner publishes it once; drafts
  answer 404 to everyone else and are left out of the sitemap. After that,
  saving is publishing. Unpublishing hides it again.
- Deleting a site frees its handle at once. Its row stays, renamed, for the
  record (legacy did the same).
- Markdown is CommonMark with GitHub-style strikethrough and autolinks, raw
  HTML disabled, hard line breaks on. Links get `rel="nofollow ugc noopener"`.
  Legacy bodies were Telegram MarkdownV2 and are converted once on import.

## Agents

- **MCP** at `/mcp`: stateless Streamable HTTP, hand-rolled JSON-RPC
  (ported from aionly), tools mirror the API.
- **OAuth 2.1** for MCP clients: discovery documents, dynamic client
  registration, client ID metadata documents, PKCE S256 only, codes valid 10
  minutes and single use. Tokens never expire; they are revoked in Settings.
  At most 10 app connections per account; one more revokes the least recently
  used.
- **API tokens**: `neat_` + 40 random characters, shown once, stored as
  SHA-256. Made and revoked in Settings.
- **Markdown views**: `/<handle>.md`, `/index.md`, `/agents.md`,
  `/api/v1` (the guide). `Accept: text/markdown` works on the same URLs;
  HTML pages advertise their Markdown with `<link rel="alternate">`.
- `/llms.txt` follows llmstxt.org.

## Search engines

`/sitemap.xml` lists the home page and every published, public site with
`lastmod`. `robots.txt` allows everything public and disallows `/app`,
`/api`, `/oauth`, `/mcp`, `/auth`, `/signin`. Every page has OpenGraph and
Twitter tags with a generated cover (1200×630).

## Design

Minimal and functional. One column, system font stack, semantic colour
tokens with light and dark schemes. Public pages follow the visitor's system
scheme. The editor has a System/Light/Dark switch stored in a cookie and
applied by CSS before scripts run (aionly's approach, no flash). Site themes
and backgrounds come later as a paid feature; `sites.theme` exists for them.

## Security baseline (from aionly)

CSP with a per-response nonce; frames denied except the editor, which
Telegram Web may frame as a Mini App. Every non-GET must carry a same-origin
`Origin` header, except the bearer-token API, MCP, OAuth endpoints and the
Telegram webhook (checked by its secret header). Bodies are read with caps.
Burst limits per account and per address with Workers rate-limit bindings.
Return paths after sign-in are reduced to same-origin paths.

## Migration from legacy

`npm run legacy:export -- <path to neat.sqlite>` writes SQL that imports every
legacy user (with their Telegram account) and every non-deleted site, keeping
handles, the published flag, creation dates, and converting bodies from
MarkdownV2. Pictures are copied from `https://neat.link/_usercontent/<file>`
into R2 by the same script (it prints the `wrangler r2 object put` commands).

Cut-over:

1. Deploy the Worker on `neat.link/*` (replaces the S3 site).
2. Apply migrations and import the legacy SQL to production D1; copy pictures.
3. Stop the legacy bot, then `npm run telegram:setup` to set the webhook,
   commands and the menu button (opens the editor).
4. In BotFather's mini app, the bot's Login Widget: allowed URLs
   `https://neat.link` and `https://neat.link/auth/telegram/callback`, and its
   client secret into `TELEGRAM_CLIENT_SECRET`. Then the Mini App URL →
   `https://neat.link/tg` (legacy `?startapp=<handle>` links then open that
   page).

## Later (paid, one-time payment ~$100)

Custom domain (Cloudflare for SaaS), subpages, limited file storage for
embeds, themes and backgrounds, forwarding address `<handle>@neat.link`
(Email Routing), pixel trackers (Google, Meta, TikTok; needs a CSP exception
per site), private (unlisted, `noindex`) pages.

Free later: prefill a page from a GitHub or LinkedIn profile.
