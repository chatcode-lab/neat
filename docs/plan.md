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

- A **site** is a handle (`neat.link/<handle>`) owned by one user. An account
  publishes up to 2 sites at once and holds 4 in all, drafts included, on
  the free plan; 10 and 20 with Pro (see "Plans and payments"). Both limits
  are part of the writes that make or publish a site.
- Handles: 1–32 characters, `a-z 0-9 _`, starting with a letter and not
  ending with `_` (the legacy rule, so every old link still resolves). New
  handles must be at least 6 characters unless the owner's linked Telegram
  username is exactly that handle. A reserved list protects routes and words
  like `api`, `app`, `admin`, `help`.
- A site has **pages**; the main page has the empty path. Subpages are a
  Pro feature (see "Subpages").
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

## Own domains

A site can be served at its own domain (`borkasm.com`) as well as at
`neat.link/<handle>`. The domain then is its canonical address: the page's
canonical link, OpenGraph URL, Markdown front matter, the API's `url` and
the address on its cover all name it, and the site moves from neat.link's
sitemap to the domain's own. The domain serves the page at `/`, its
Markdown at `/index.md`, a `robots.txt` and a sitemap, and nothing else;
the twin with or without `www` and plain HTTP are sent to the domain. The
Worker answers it with the same render and edge cache as the neat.link
page. `domains` maps a domain to one site; a draft or deleted site's domain
answers 404. Any host other than `APP_ORIGIN`'s is looked up there.

Owners connect domains themselves, in the editor or through the API and
MCP, with the Own domain plan or Pro (2026-11-25; on 2026-11-13 they were
to be free, and became paid with the plans). A domain is one site's; each
claim gets its own code, and the owner adds a CNAME to
`<code>.byo.neat.link` (`DOMAIN_TARGET`), which also proves which site
claims it. Where the CNAME is hidden (Cloudflare at a root, or behind its
proxy) a TXT record `_neat-link.<domain>` = `neat-link=<code>`, with the
domain resolving at all, proves it instead. DNS is read over HTTPS from
Cloudflare's resolver; a lookup that fails is "do not know", never "no".

- **Provider** is told from the domain's nameservers (Cloudflare, GoDaddy,
  Namecheap, Route 53 and a dozen more), so the editor says where to add
  the records and links there.
- **Root domains** only with DNS at Cloudflare, which flattens a CNAME;
  elsewhere the owner connects `www` and forwards the root at their
  provider, or moves DNS to Cloudflare (free). ALIAS/ANAME, apex proxying
  (Enterprise) and our own TLS are out.
- **Cloudflare for SaaS**: once a claim's DNS points here, the domain
  becomes a custom hostname on the neat.link zone, whose certificate
  Cloudflare issues by HTTP validation within minutes. 100 are included,
  then $0.10 a month each, billed from when one is made until it is
  deleted, so none is made before the DNS points here, one that stops
  pointing here is deleted a week later, and one whose owner's plan ended
  is deleted at the next check. Without `CF_ZONE_ID` and the `CF_API_TOKEN`
  secret (local, staging) none is made and a domain is served as soon as
  its DNS points here.
- **Checks**: at once when claimed, every 20 seconds while the editor is
  open on a waiting domain, on request (`POST …/domain/check`), and hourly
  (waiting claims for a week, then daily; ones being set up at Cloudflare
  hourly; connected ones daily; at most 50 an hour).
- **States**: a site has at most one row in `domains`: `pending` or
  `active`. It turns `active`, which makes it the site's address, only once
  Cloudflare serves the hostname with its certificate; until then the API
  says `issuing_certificate`. A hostname made on a TXT record alone (which
  shows the claim, not that requests come here) that Cloudflare never
  serves within a week is let go and not made again until the owner checks
  the domain themselves. The Worker answers Cloudflare's HTTP ownership
  check for a domain being set up. Several sites may wait for one name; a
  unique index lets one hold it. `kind = 'route'` marks domains in neat.link's own account
  (borkasm.com, tractor.fm): served by a Worker route, never checked.
- A domain is served only while its owner's plan has own domains; the
  migration gave the owner of the first two (neat.link's own account) Pro
  for life. Deleting a site lets its domain go first.
- **Production setup**, once: enable Cloudflare for SaaS on the neat.link
  zone (needs a payment method); add proxied `AAAA byo 100::` and
  `AAAA *.byo 100::`; set the fallback origin to `byo.neat.link`; add the
  Worker route `*/*` on the zone with a no-Worker route for
  `media.neat.link/*` (the Worker passes that host to the bucket anyway);
  and a zone token with SSL and Certificates: Edit as `CF_API_TOKEN`.
- Domain Connect (one-click setup at GoDaddy, IONOS, Cloudflare and others)
  comes next; then maybe Cloudflare's OAuth.

## Plans and payments

Decided 2026-11-25:

| Plan | Price | Pages (published / in all) | Adds |
| --- | --- | --- | --- |
| Free | $0 | 2 / 4 | |
| Own domain (`domains`) | $10 once | 2 / 4 | own domains |
| Pro (`pro_year`) | $50 a year | 10 / 20 | own domains, pixels, no sign, subpages, files, and what comes later |
| Pro for life (`pro_life`) | $100 once | 10 / 20 | as Pro, for as long as neat.link runs |

- Prices are in USD before VAT. **Stripe Checkout** takes payment, with
  Stripe Tax (`automatic_tax`; active in both modes, but it collects only
  where the account has registrations, added in the Dashboard), VAT numbers
  for businesses, promotion codes, and an invoice for one-time payments.
  Stripe is called over `fetch` (no SDK) with a pinned API version
  (`2025-03-31.basil`), as is the webhook endpoint.
- `npm run stripe:setup -- staging|production` makes the prices (found by
  lookup key), the billing portal's settings and the webhook endpoint, and
  puts the key and the endpoint's secret into the Worker's secrets.
- **Purchases** are rows in `purchases`; an account's plan is worked out
  from the running ones on every read (a subquery in the site query), never
  stored. A purchase is given when the webhook says it is paid, or when the
  owner comes back from Checkout and the session is looked up, whichever is
  first; both are idempotent on the session ID. The yearly plan runs to its
  paid period's end plus three days' grace for the renewal; an unpaid
  renewal gets the three days from when the unpaid period began (Stripe
  moves the period on before it charges). Stripe's subscription events move
  that end. A full refund or a lost chargeback of a one-time payment takes
  it back, also when Stripe told of it before the purchase was recorded.
  Buying Pro for life stops the yearly plan renewing.
- **Both at once**: the webhook and the owner's return often arrive
  together. The one statement that records a purchase also decides whether
  the account already had what it gives, so two requests for one session
  record it once and never take it for a duplicate. What is still to be
  done at Stripe (a duplicate's refund, stopping the yearly plan) is kept on
  the row and done by one request at a time; one that fails half way is
  finished by the next delivery or the hourly job.
- **No paying twice**: an account has one open Checkout Session; starting
  another expires the one before. A payment that still arrives for
  something the account already has is refunded at once (a duplicate
  subscription is cancelled and its first payment refunded) and recorded
  as refunded.
- **When a plan ends nothing is deleted.** The hourly job takes published
  pages past the plan's limit back to drafts, newest first; domains,
  pixels, the hidden sign and subpages stop applying until it is back.
  Files stay served.
- **Agents** can do everything but pay: `GET /api/v1/plan` says what the
  account has and could buy, and `POST /api/v1/checkout` (MCP
  `start_checkout`) gives a Checkout link for the owner to open. An
  unentitled request answers 402 `plan_required`, naming the plan and price.
- Billing portal (invoices, card, cancelling at the year's end) from the
  Plan page only, for the owner signed in. An app's token never opens it:
  it shows invoices and can cancel the plan, which connecting an app
  never agreed to.
- No credit from one plan to another, for now: Own domain then Pro pays
  both.

## Pro features

- **Tracking pixels**: a site's Google tag (`G-`, `AW-`, `GT-`, `DC-`),
  Meta pixel and TikTok pixel, on its main page and subpages. A page with
  any loads `/pixels.js` (a static file with each vendor's own loader,
  reading the IDs from its tag's `data-` attributes), and its Content
  Security Policy lets in those vendors' addresses only: the page route
  hands the Worker an internal header, kept with the edge-cached copy.
  Pages without pixels stay as closed as before. Consent where the law asks
  for it is the owner's (said in the terms and the editor).
- **No sign**: `sites.branding = 0` hides the ⎆ neat.link footer.
- **Subpages**: rows in `pages` with a `private_id` (12 lowercase letters
  and digits, `/<handle>/<private_id>`, never indexed, rotatable) and, once
  public, a `path` (`/<handle>/<path>`, indexed, in the sitemap). Both work
  at once; a path may not equal another subpage's private ID. Title,
  headline and Markdown body up to 100,000 characters; 100 per site. Made
  through the API and MCP only for now; the editor lists them. Their own
  covers, at the address they are shared by (so a rotated or withdrawn
  address takes its cover with it), Markdown views (`.md`), and on a
  site's own domain `/<path>`. A rotated address can stay in the edge cache
  for up to a minute. The
  main page's Markdown lists its public subpages.
- **Files**: up to 25 MB each and 1 GB per account, in R2 under
  `files/<random>/<safe name>`, served from the bucket's domain with a
  year's cache. Types are read from the bytes: pictures, video, audio and
  PDFs; no SVG, HTML or text. JPEG photos are re-encoded (Cloudflare
  Images), dropping their metadata. Uploaded by the API (bytes or a public
  URL), or for MCP clients without a token of their own, an upload link
  signed for the account and valid 15 minutes. Markdown `![words](url)`
  embeds a stored file (picture, player, or PDF link) in any page body;
  any other address stays a link, so pages still load nothing from other
  sites.

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

`/sitemap.xml` lists the home page, every published, public site and its
public subpages, with `lastmod`; a site with its own domain is listed in
that domain's sitemap instead. `robots.txt` allows everything public and disallows `/app`,
`/api`, `/oauth`, `/mcp`, `/auth`, `/signin`. Every page has OpenGraph and
Twitter tags with a generated cover (1200×630).

## Speed and cost

Most traffic is visitors reading pages, so that path is kept cheap:

- **Static pages send no scripts.** A site's page, the home page and
  `/agents`, `/terms`, `/privacy` are plain HTML (route `handle.static`):
  about 3 KB, one stylesheet and one preloaded font, never hydrated. The
  header's theme switch falls back to a form post that reloads the page.
- **Edge cache for visitors without an account.** Static pages are kept in
  the Cache API for 60 seconds per data centre, keyed by path, theme and
  build, so a hit needs no rendering and no D1 read. A request with a
  session cookie always renders, so an owner sees their edit at once; others
  see it within a minute. The Cache API is per data centre and cannot be
  purged globally without an API token, which a minute's delay does not
  justify. It does not work on workers.dev, so staging always renders.
- **Built assets are immutable** (`public/_headers`: a year for
  `/assets/*`, a day for icons) and served by Cloudflare without running
  the Worker. Pictures are stored resized with a year's cache and, in
  production, served from the bucket's own domain, also without the Worker.
- Covers, Markdown views and the sitemap were already edge-cached.
- Logs keep every request; production traces sample one in ten.

## Design

Minimal and functional. One column, Inter (Rubik on page buttons, as on the
legacy pages), served from the site itself, semantic colour
tokens with light and dark schemes. The look follows the legacy pages
(neat.link/elon was the reference): white or near-black behind, neutral
greys, muted body text with grey medium-weight links that underline on
hover, an extra-bold title, the round picture with a soft shadow, and the
page centred in the window. A page's buttons wear their services' colours
(the legacy values, the brand's for services the legacy did not know, the
legacy blue-to-teal for other links), with small corners, Rubik, and the
legacy width: as wide as the longest label plus room on wider screens, the
full width on phones. The rest of the site is monochrome: the accent is the
text colour, and only errors and confirmations have a hue. Dark mode is
near-black rather than the legacy zinc-800, which read with less contrast;
page buttons get a faint light edge there so black ones (X, Threads) still
show. Public pages follow the visitor's system
scheme. The editor has a System/Light/Dark switch stored in a cookie and
applied by CSS before scripts run (aionly's approach, no flash). Site themes
and backgrounds come later as a paid feature; `sites.theme` exists for them.

Covers read as business cards: the round picture with the page's white
edge and shadow (initials, or the sign for the site, on a dark disc when
there is none) beside the name, the headline, up to three lines of the
text and the address after the ⎆ sign. The name is set as large as it
fits, on one line while it can be large, and the card is centred both
ways, so a page with a name alone fills the cover as well as a long one.
Letters styled with Unicode's mathematical alphabets are drawn plain, and
lines left with nothing to read once emoji are dropped are left out. The
sign comes from JuliaMono SemiBold, subset to that one character and
renamed Neat Sign as its licence asks; it is as tall as the capitals and
hangs in the margin, so the address lines up with the text. Text is never
cut short on a cover: a paragraph that does not fit keeps its first whole
sentences, or is left out with what follows it.

## Security baseline (from aionly)

CSP with a per-response nonce; frames denied except the editor, which
Telegram Web may frame as a Mini App. A page with its owner's tracking
pixels lets in those vendors only; forms may post on to Google's sign-in
and Stripe's checkout and portal. Every non-GET must carry a same-origin
`Origin` header, except the bearer-token API, MCP, OAuth endpoints, the
Telegram webhook (checked by its secret header) and Stripe's (checked by
its signature, at most five minutes old). Bodies are read with caps:
each endpoint has its own, and the Worker cuts every request body off at
512 KiB (8 MB and a margin where pictures are uploaded, 25 MB where files
are), so no action or
library ever buffers more, whatever the request declares.
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

## Later

In Pro: themes and backgrounds, a forwarding address `<handle>@neat.link`
(Email Routing), an unlisted main page, writing subpages and uploading
files in the editor, Domain Connect.

Free later: prefill a page from a GitHub or LinkedIn profile.
