# neat.link

One neat page for all your links: `neat.link/<handle>` shows a picture, a
title, a headline, a short Markdown text and a column of buttons, centred.
Agent-first: everything is also an MCP server (`/mcp`), an HTTP API
(`/api/v1`), Markdown views (`/<handle>.md`) and `/llms.txt`.

This is the Cloudflare rewrite of the legacy Telegram bot (`../neat-legacy`).
**The product and technical decisions are in [docs/plan.md](docs/plan.md).
Read it before changing behaviour.** The API guide is
[docs/api.md](docs/api.md), served at `GET /api/v1`.

## Stack

One Cloudflare Worker: React Router 8 (SSR) + D1 (raw SQL) + R2 (pictures) +
the Images binding (squaring pictures) + resvg-wasm (preview covers) +
better-auth (Google) with Telegram sign-in on top + Tailwind 4. The Telegram
bot is a webhook on the same Worker. Patterns follow `../aionly`.

## Local setup

```sh
npm install
cp .dev.vars.example .dev.vars        # fill in; use a *test* bot token
npm run db:migrate:local
npm run legacy:import:local           # optional: the legacy pages and pictures
npm run dev                           # http://localhost:5173
```

Without Google credentials, sign in locally as a legacy user through the Mini
App endpoint (`POST /auth/telegram/webapp` with initData signed by the test
bot token; see `app/lib/telegram/verify.ts`, `signForTests`).

| Script | What it does |
| --- | --- |
| `npm run dev` | Dev server with local D1, R2 and Images |
| `npm run typecheck` | Worker types, route types, `tsc -b` |
| `npm test` | Unit tests (Node) and database tests (Workers runtime, real D1) |
| `npm run preview` | Production build under `vite preview` |
| `npm run legacy:export -- <neat.sqlite> <out>` | Legacy data → `legacy.sql` + `legacy-images.sh` |
| `npm run telegram:setup -- <origin>` | Webhook, commands, menu button |
| `npm run deploy:production` | Build and deploy the production Worker |

## Going live

1. Create the resources: `wrangler d1 create neat-link` (put its id in
   `wrangler.jsonc`), `wrangler r2 bucket create neat-link-media` with
   `media.neat.link` as its public domain, and move the `neat.link` DNS zone
   to Cloudflare if it is not there.
2. Secrets: `npm run secret:production -- BETTER_AUTH_SECRET`, likewise
   `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` (redirect URI
   `https://neat.link/api/auth/callback/google`), `TELEGRAM_BOT_TOKEN`,
   `TELEGRAM_WEBHOOK_SECRET`.
3. `npm run db:migrate:production`, then import the legacy data:
   `npm run legacy:export -- <latest neat.sqlite> .wrangler/legacy`,
   `wrangler d1 execute DB --env production --remote --file .wrangler/legacy/legacy.sql`,
   `sh .wrangler/legacy/legacy-images.sh --remote`.
4. `npm run deploy:production` (the route `neat.link/*` replaces the S3 site).
5. Stop the legacy bot, then `npm run telegram:setup -- https://neat.link`
   and do the two BotFather steps it prints (`/setdomain`, Mini App URL).

## Layout

```
app/
  routes.ts            route table; /:handle (a page) comes last
  routes/              pages, the editor (/app), sign-in, OAuth, MCP, API, webhook
  lib/
    db/                D1 queries (sites, accounts, tokens, Telegram tokens)
    sites.server.ts    the rules every editor/API/MCP change goes through
    api/v1.server.ts   the HTTP API; mcp/ the MCP server (calls the API in-process)
    oauth/             OAuth 2.1 for MCP clients (DCR, client metadata documents, PKCE)
    telegram/          signature checks, Telegram sign-in, the bot
    og/                preview covers (resvg); views/ Markdown, robots, llms.txt, sitemap
    security/          CSP, headers, Origin check, rate limits, capped bodies
  components/          page card (public page and editor preview), icons, chrome
workers/app.ts         Worker entry: open paths, Markdown, covers, React Router, cron
migrations/            D1 schema
scripts/               legacy export, Telegram setup
test/db/               database tests in the Workers runtime
```

## Security baseline

CSP with per-response nonces; frames denied except the editor, the Mini App
entry and public pages, which Telegram's web client may frame. Every non-GET
needs a same-origin `Origin`, except the bearer-token API, MCP, OAuth
endpoints and the Telegram webhook (secret header). Provider tokens are never
stored; API tokens are stored as SHA-256 hashes. Fixtures and tests use
invented names; check staged changes for credentials before committing.
