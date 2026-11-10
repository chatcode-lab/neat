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

    curl https://neat.link/elon.md

## Endpoints

All bodies are JSON (`Content-Type: application/json`), at most 64 KB.

| Method | Path | What it does |
| --- | --- | --- |
| GET | `/api/v1/me` | The account the token acts for. |
| GET | `/api/v1/sites` | The account's sites. |
| POST | `/api/v1/sites` | Makes a site (at most 2 per account). |
| GET | `/api/v1/sites/{handle}` | One of the account's sites. |
| PATCH | `/api/v1/sites/{handle}` | Changes content, handle or published state. |
| DELETE | `/api/v1/sites/{handle}` | Deletes a site and frees its handle. |
| PUT | `/api/v1/sites/{handle}/picture` | Sets the picture (bytes, or `{"url": …}`). |
| DELETE | `/api/v1/sites/{handle}/picture` | Removes the picture. |
| GET | `/api/v1/handles/{handle}` | Whether a handle can be taken. |

### A site

```json
{
  "handle": "elon",
  "url": "https://neat.link/elon",
  "markdown_url": "https://neat.link/elon.md",
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
  "picture": "https://media.neat.link/avatars/….jpg"
}
```

### Making and changing a site

`POST /api/v1/sites` and `PATCH /api/v1/sites/{handle}` take any of:

| Field | Rules |
| --- | --- |
| `handle` | 1–32 of `a-z 0-9 _`, starts with a letter, does not end with `_`; at least 6 characters unless it is the account's own Telegram username. Omit on create to get one suggested. |
| `title` | Required on the page, at most 100 characters. Defaults to the account's name. |
| `headline` | One line under the title, at most 120 characters. |
| `body` | CommonMark, at most 10,000 characters. Raw HTML and images are not rendered; line breaks are kept. |
| `buttons` | Up to 12 `{ "label", "url" }`. A URL may be `https://…`, a bare domain, an email or a phone number; it is normalized (`mailto:`, `tel:`, `https://`). Icons follow the domain (Telegram, Instagram, WhatsApp, YouTube, …). |
| `published` | `true` makes the page public and lists it in the sitemap; `false` hides it. New sites are drafts unless you send `true`. |

Fields you leave out keep their value. `buttons` replaces the whole list.

### Pictures

    curl -X PUT https://neat.link/api/v1/sites/elon/picture \
      -H "Authorization: Bearer $NEAT_TOKEN" -H "Content-Type: image/jpeg" \
      --data-binary @photo.jpg

or `{"url": "https://…/photo.jpg"}` with `Content-Type: application/json`.
JPEG, PNG, WebP or GIF up to 8 MB; it is cropped to a square about its centre.

## Errors

Errors are JSON: `{ "error": "<code>", "message": "<a sentence to show>" }`.

| Status | Codes |
| --- | --- |
| 400 | `invalid_json`, `invalid_field`, `invalid_handle`, `invalid_content`, `invalid_buttons`, `picture_not_image` |
| 401 | `unauthorized` |
| 403 | `site_limit` |
| 404 | `not_found` |
| 409 | `handle_taken` |
| 413 | `too_large` |
| 422 | `picture_failed` |
| 429 | `rate_limited` (wait the `Retry-After` seconds) |
