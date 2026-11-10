import { type RouteConfig, index, route } from "@react-router/dev/routes";

export default [
  index("routes/home.tsx"),
  route("signin", "routes/signin.tsx"),
  route("signout", "routes/signout.ts"),
  route("theme", "routes/theme.ts"),
  // The site's own prose, also served as Markdown by the Worker.
  route("agents", "routes/prose.tsx", { id: "routes/agents" }),
  route("terms", "routes/prose.tsx", { id: "routes/terms" }),
  route("privacy", "routes/prose.tsx", { id: "routes/privacy" }),

  // Signing in with Telegram: Telegram's own sign-in page or Login Widget,
  // the Mini App, and a link the bot sends.
  route("auth/telegram/widget", "routes/auth-telegram-widget.tsx"),
  route("auth/telegram/webapp", "routes/auth-telegram-webapp.ts"),
  route("auth/telegram/link", "routes/auth-telegram-link.tsx"),
  // The Mini App's entry, opened from the bot.
  route("tg", "routes/tg.tsx"),
  route("telegram/webhook", "routes/telegram-webhook.ts"),

  // The editor.
  route("app", "routes/app.tsx", [
    index("routes/app-home.tsx"),
    route("new", "routes/app-new.tsx"),
    route("sites/:handle", "routes/app-site.tsx"),
    route("settings", "routes/app-settings.tsx"),
  ]),

  route("media/*", "routes/media.ts"),
  route("api/auth/*", "routes/api-auth.ts"),
  // The agents' API: its guide at /api/v1, its endpoints below it.
  route("api/v1", "routes/api-v1.ts", { id: "routes/api-v1-guide" }),
  route("api/v1/*", "routes/api-v1.ts"),
  // The same, as an MCP server, and the OAuth that connects apps to it.
  route("mcp", "routes/mcp.ts"),
  route("oauth/authorize", "routes/oauth-authorize.tsx"),
  route("oauth/:endpoint", "routes/oauth.ts"),

  // A site's page, neat.link/<handle>. Every fixed route above wins over it.
  route(":handle", "routes/page.tsx"),
] satisfies RouteConfig;
