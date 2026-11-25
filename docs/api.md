# neat.link API

neat.link makes mini business-card pages: `https://neat.link/<handle>` shows a
picture, a title, an optional headline, a Markdown text and a column of
buttons. This API lets an agent or script manage the sites of the account its
token belongs to. The same operations are available as MCP tools at
`https://neat.link/mcp`.

## Authentication

Send `Authorization: Bearer <token>` with every request.

- Make a token in Settings: https://neat.link/app/settings (shown once).
- Or connect an MCP client to `https://neat.link/mcp`; it signs in with OAuth.

Cookies are never read, so the API can be called from anywhere.

## Reading pages without a token

Every published page is Markdown at its address plus `.md`, or at its own
address with `Accept: text/markdown`:

    curl https://neat.link/borkasm.md

## Plans

| Plan | Price | What it has |
| --- | --- | --- |
| Free | $0 | 2 published pages and 2 drafts. |
| Own domain (`domains`) | $10 once | Own domains for the account's pages. |
| Pro (`pro_year`) | $50 a year | 10 published pages and 10 drafts, own domains, subpages, files (1 GB), tracking pixels, no neat.link sign. |
| Pro for life (`pro_life`) | $100 once | Pro, for as long as neat.link runs. |

Prices are in US dollars; VAT is added at checkout where it applies.
Only a person can pay: `POST /api/v1/checkout` gives a link for the
account's owner to open. The plan changes as soon as they have paid. When
a plan ends, nothing is deleted: pages past the free limit go back to
drafts (newest first), and domains, subpages, pixels and the hidden sign
stop applying until it is back.

## Endpoints

Bodies are JSON (`Content-Type: application/json`), at most 480 KB, except
files and pictures, which may be sent as they are.

| Method | Path | What it does |
| --- | --- | --- |
| GET | `/api/v1/me` | The account the token acts for, and its plan. |
| GET | `/api/v1/plan` | The plan: what it allows, what is used, and what can be bought. |
| POST | `/api/v1/checkout` | `{"product": "domains" \| "pro_year" \| "pro_life"}`: a payment link for the owner. |
| POST | `/api/v1/billing` | A link to Stripe's billing portal: invoices, card, cancelling Pro yearly. |
| GET | `/api/v1/sites` | The account's sites. |
| POST | `/api/v1/sites` | Makes a site (within the plan's limits). |
| GET | `/api/v1/sites/{handle}` | One of the account's sites. |
| PATCH | `/api/v1/sites/{handle}` | Changes content, handle, published state, pixels or the sign. |
| DELETE | `/api/v1/sites/{handle}` | Deletes a site and frees its handle (and its domain). |
| PUT | `/api/v1/sites/{handle}/picture` | Sets the picture (bytes, or `{"url": …}`). |
| DELETE | `/api/v1/sites/{handle}/picture` | Removes the picture. |
| GET | `/api/v1/sites/{handle}/domain` | The site's own domain and its status. |
| PUT | `/api/v1/sites/{handle}/domain` | `{"hostname": "www.example.com"}`: connects a domain. |
| POST | `/api/v1/sites/{handle}/domain/check` | Checks the domain's DNS now. |
| DELETE | `/api/v1/sites/{handle}/domain` | Disconnects it. |
| GET | `/api/v1/sites/{handle}/pages` | The site's subpages. |
| POST | `/api/v1/sites/{handle}/pages` | Makes a subpage (Pro). |
| GET | `/api/v1/sites/{handle}/pages/{id}` | One subpage. |
| PATCH | `/api/v1/sites/{handle}/pages/{id}` | Changes it (Pro). |
| POST | `/api/v1/sites/{handle}/pages/{id}/rotate` | Gives it a new private address. |
| DELETE | `/api/v1/sites/{handle}/pages/{id}` | Deletes it. |
| GET | `/api/v1/media` | The account's files and how much of the quota they use. |
| POST | `/api/v1/media` | Uploads a file (Pro): its bytes, or `{"url": …}`. |
| POST | `/api/v1/media/upload-link` | A link that takes a file without a token, for 15 minutes (Pro). |
| DELETE | `/api/v1/media/{id}` | Deletes a file. |
| GET | `/api/v1/handles/{handle}` | Whether a handle can be taken. |

### A site

```json
{
  "handle": "elon",
  "url": "https://neat.link/elon",
  "markdown_url": "https://neat.link/elon.md",
  "domain": null,
  "published": true,
  "published_at": "2026-11-10T12:00:00.000Z",
  "updated_at": "2026-11-10T12:30:00.000Z",
  "title": "Elon",
  "headline": "Rockets and cars",
  "body": "Building things.\n\n**Hiring**: see the links below.",
  "buttons": [
    { "label": "Telegram", "url": "https://t.me/elon" },
    { "label": "Mail", "url": "mailto:elon@example.com" }
  ],
  "picture": "https://media.neat.link/avatars/….jpg",
  "pixels": {},
  "branding": true,
  "pro_active": false
}
```

A site with its own domain has it in `domain` (`"elon.example"`), and its
`url` and `markdown_url` are there: `https://elon.example/` and
`https://elon.example/index.md`. Its neat.link address keeps working.

### Making and changing a site

`POST /api/v1/sites` and `PATCH /api/v1/sites/{handle}` take any of:

| Field | Rules |
| --- | --- |
| `handle` | 1–32 of `a-z 0-9 _`, starts with a letter, does not end with `_`; at least 6 characters unless it is the account's own Telegram username. Omit on create to get one suggested. |
| `title` | Required on the page, at most 100 characters. Defaults to the account's name. |
| `headline` | One line under the title, at most 120 characters. |
| `body` | CommonMark, at most 10,000 characters. Raw HTML and images are not rendered; line breaks are kept. |
| `buttons` | Up to 12 `{ "label", "url" }`. A URL may be `https://…`, a bare domain, an email or a phone number; it is normalized (`mailto:`, `tel:`, `https://`). Icons follow the domain (Telegram, Instagram, WhatsApp, YouTube, …). |
| `published` | `true` makes the page public and lists it in the sitemap; `false` hides it. New sites are drafts unless you send `true`. A plan publishes a limited number at once (`publish_limit`). |
| `pixels` | Pro. `{"google": "G-…" or "AW-…", "meta": "<digits>", "tiktok": "<ID>"}`, merged into the current ones; `""` or `null` removes one. They load on the site's page and subpages. |
| `branding` | Pro. `false` hides the ⎆ neat.link sign at the bottom of the site's pages. |

Fields you leave out keep their value. `buttons` replaces the whole list.
Pixels and the sign can always be removed or shown again without Pro.

### Pictures

    curl -X PUT https://neat.link/api/v1/sites/elon/picture \
      -H "Authorization: Bearer $NEAT_TOKEN" -H "Content-Type: image/jpeg" \
      --data-binary @photo.jpg

or `{"url": "https://…/photo.jpg"}` with `Content-Type: application/json`.
JPEG, PNG, WebP or GIF up to 8 MB; it is cropped to a square about its centre.

### Own domains

With the Own domain plan or Pro, a site can be served at its own domain,
which then is its canonical address (`url`, `markdown_url`, covers).

    curl -X PUT https://neat.link/api/v1/sites/elon/domain \
      -H "Authorization: Bearer $NEAT_TOKEN" -H "Content-Type: application/json" \
      -d '{"hostname": "www.elon.example"}'

The answer says what the owner must add where the domain's DNS is
(`provider` names it):

```json
{
  "domain": {
    "hostname": "www.elon.example",
    "status": "pending",
    "url": "https://www.elon.example/",
    "records": [
      { "type": "CNAME", "name": "www", "host": "www.elon.example", "value": "k3j9x2m4qa.byo.neat.link", "required": true },
      { "type": "TXT", "name": "_neat-link.www", "host": "_neat-link.www.elon.example", "value": "neat-link=k3j9x2m4qa", "required": false }
    ],
    "provider": { "name": "GoDaddy", "dashboard": "https://dcc.godaddy.com/control/portfolio" },
    "certificate": null,
    "error": null,
    "notes": ["…"]
  }
}
```

`status` is `pending` until the CNAME (or, where a provider hides it, the
TXT record) is seen, then `issuing_certificate` while Cloudflare sets the
domain up (usually minutes), then `live`: only then is the domain the
site's address. Domains are checked every hour; `POST …/domain/check` checks at
once. A root domain (`elon.example`) can only point here with its DNS at
Cloudflare; elsewhere connect `www` and forward the root to it.

### Subpages

With Pro, a site can have pages below it, such as articles. Each has a
private address, `neat.link/<handle>/<12 letters and digits>`, that is
never indexed, and once given a `path`, a public one,
`neat.link/<handle>/<path>`, indexed and in the sitemap. Both work at once.
On a site's own domain they are at `https://<domain>/<path>`.

| Field | Rules |
| --- | --- |
| `title` | Required, at most 100 characters. |
| `headline` | One line under the title, at most 120 characters; also its description when shared. |
| `body` | CommonMark, at most 100,000 characters. |
| `path` | Lowercase words and digits joined by single dashes, at most 80 characters (`how-i-made-it`); `true` makes one from the title; `null` keeps it private only. |

A subpage as the API describes it:

```json
{
  "id": "Xb2kQ9rT1mZa",
  "title": "How I made it",
  "headline": "",
  "body": "…",
  "path": "how-i-made-it",
  "url": "https://neat.link/elon/how-i-made-it",
  "private_url": "https://neat.link/elon/k3j9x2m4qa7c",
  "markdown_url": "https://neat.link/elon/how-i-made-it.md",
  "visible": true,
  "created_at": "…",
  "updated_at": "…"
}
```

`POST …/pages/{id}/rotate` gives it a new `private_url`; the old one stops
working at once. Visitors see subpages while the site is published and its
owner has Pro.

### Files

With Pro, an account can keep up to 1 GB of files, each up to 25 MB, to
embed in its pages: pictures (JPEG, PNG, GIF, WebP, AVIF), video (MP4,
MOV, WebM), audio (MP3, M4A, AAC, OGG, WAV, FLAC) and PDFs. A file's type
is read from its bytes; anything else (SVG, HTML, text) is refused. JPEG
photos are re-encoded, which drops their metadata, such as where they were
taken.

    curl -X POST "https://neat.link/api/v1/media?name=talk.mp4" \
      -H "Authorization: Bearer $NEAT_TOKEN" --data-binary @talk.mp4

or `{"url": "https://…", "name": "talk.mp4"}` as JSON. An agent without a
token of its own (an MCP client) can ask for an upload link,
`POST /api/v1/media/upload-link`, and send the file there within 15
minutes: `curl -T talk.mp4 "<url>?name=talk.mp4"`.

Each file comes back with its `url` and the Markdown that embeds it, to
put in a page's or subpage's `body`: `![Talk](https://media.neat.link/files/…/talk.mp4)`
shows a player, a picture shows as itself, and a PDF as a link. Only
files kept here are embedded; any other address stays a link.

## Errors

Errors are JSON: `{ "error": "<code>", "message": "<a sentence to show>" }`.

| Status | Codes |
| --- | --- |
| 400 | `invalid_json`, `invalid_field`, `invalid_handle`, `invalid_content`, `invalid_buttons`, `invalid_pixels`, `invalid_path`, `invalid_domain`, `root_domain`, `invalid_product`, `picture_not_image`, `file_type` |
| 401 | `unauthorized` |
| 402 | `plan_required`: the plan lacks this; the message names the plan and price |
| 403 | `site_limit`, `publish_limit`, `subpage_limit`, `media_quota` |
| 404 | `not_found`, `no_domain`, `no_billing` |
| 409 | `handle_taken`, `domain_taken`, `path_taken`, `already_bought` |
| 413 | `too_large` |
| 422 | `picture_failed`, `file_failed` |
| 429 | `rate_limited` (wait the `Retry-After` seconds) |
| 503 | `billing_unavailable`, `try_again` |
