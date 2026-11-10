import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The burst limiters, as the handlers see them: open, or exhausted.
const limits = vi.hoisted(() => ({ allow: true }));
vi.mock("../../app/lib/security/rate-limit.server", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../app/lib/security/rate-limit.server")>();
  return { ...original, withinLimits: vi.fn(async () => limits.allow) };
});

import { handleApi } from "../../app/lib/api/v1.server";
import { accountRecord, linkTelegram, unlinkTelegram, userForTelegram } from "../../app/lib/db/accounts.server";
import { claimTelegramToken, issueTelegramToken, peekTelegramToken } from "../../app/lib/db/telegram-tokens.server";
import { createToken, revokeToken, userForToken } from "../../app/lib/db/tokens.server";
import { pageMarkdown } from "../../app/lib/views/markdown.server";

const ORIGIN = "https://neat.link";
const NOW = 1_800_000_000;
const TABLES = ["telegram_tokens", "api_tokens", "oauth_codes", "oauth_clients", "pages", "sites", "telegram_users", '"session"', '"account"', '"user"'];

async function reset() {
  await env.DB.batch(TABLES.map((table) => env.DB.prepare(`DELETE FROM ${table}`)));
}

async function user(id: string, providers: Array<["google" | "telegram", string]>, telegramUsername?: string) {
  const stamp = new Date(NOW * 1000).toISOString();
  await env.DB.prepare(`INSERT INTO "user" VALUES (?1, ?2, ?3, 1, NULL, ?4, ?4)`).bind(id, `Name ${id}`, `${id}@example.com`, stamp).run();
  for (const [provider, accountId] of providers) {
    await env.DB.prepare(`INSERT INTO "account" (id, accountId, providerId, userId, createdAt, updatedAt) VALUES (?1, ?2, ?3, ?4, ?5, ?5)`)
      .bind(`${id}-${provider}`, accountId, provider, id, stamp)
      .run();
    if (provider === "telegram") {
      await env.DB.prepare(`INSERT INTO telegram_users VALUES (?1, ?2, ?3, ?4)`).bind(accountId, telegramUsername ?? null, `Name ${id}`, NOW).run();
    }
  }
  return (await createToken(env.DB, { userId: id, label: "test", now: NOW }))!;
}

function api(token: string | null, method: string, path: string, body?: unknown) {
  const headers = new Headers();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (body !== undefined) headers.set("Content-Type", "application/json");
  const request = new Request(`${ORIGIN}/api/v1/${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return handleApi(request, path);
}

beforeEach(async () => {
  limits.allow = true;
  await reset();
});

describe("the API", () => {
  it("serves its guide without a token and refuses everything else", async () => {
    const guide = await api(null, "GET", "");
    expect(guide.headers.get("Content-Type")).toContain("text/markdown");
    expect(await guide.text()).toContain("# neat.link API");
    const refused = await api(null, "GET", "sites");
    expect(refused.status).toBe(401);
    expect(refused.headers.get("WWW-Authenticate")).toContain("Bearer");
  });

  it("makes a draft site, publishes it, and serves it as Markdown", async () => {
    const token = await user("ada", [["google", "g1"]]);
    const made = await api(token, "POST", "sites", {
      handle: "Ada_Lovelace",
      title: "Ada",
      body: "Hello *world*",
      buttons: [{ label: "Mail", url: "ada@example.com" }, { label: "Site", url: "example.com" }],
    });
    expect(made.status).toBe(201);
    const { site } = (await made.json()) as { site: Record<string, unknown> };
    expect(site).toMatchObject({
      handle: "ada_lovelace",
      published: false,
      buttons: [
        { label: "Mail", url: "mailto:ada@example.com" },
        { label: "Site", url: "https://example.com/" },
      ],
    });
    expect(await pageMarkdown(env.DB, "ada_lovelace", ORIGIN)).toBeNull();

    const published = await api(token, "PATCH", "sites/ada_lovelace", { published: true, headline: "First programmer" });
    expect(published.status).toBe(200);
    const markdown = await pageMarkdown(env.DB, "ada_lovelace", ORIGIN);
    expect(markdown).toContain('title: "Ada"');
    expect(markdown).toContain("Hello *world*");
    expect(markdown).toContain("- [Mail](mailto:ada@example.com)");
  });

  it("keeps the handle rules and the site limit", async () => {
    const token = await user("ada", [["google", "g1"], ["telegram", "42"]], "ada42");
    expect(((await (await api(token, "POST", "sites", { handle: "ada" })).json()) as { error: string }).error).toBe("invalid_handle");
    expect(((await (await api(token, "POST", "sites", { handle: "settings" })).json()) as { error: string }).error).toBe("invalid_handle");
    // A handle may be as short as the owner's own Telegram username.
    expect((await api(token, "POST", "sites", { handle: "ada42" })).status).toBe(201);
    expect((await api(token, "POST", "sites", {})).status).toBe(201);
    const third = await api(token, "POST", "sites", { handle: "adathird" });
    expect(third.status).toBe(403);
    expect(((await third.json()) as { error: string }).error).toBe("site_limit");
  });

  it("refuses another owner's site and a taken handle", async () => {
    const ada = await user("ada", [["google", "g1"]]);
    const bob = await user("bob", [["google", "g2"]]);
    await api(ada, "POST", "sites", { handle: "adapage" });
    expect((await api(bob, "PATCH", "sites/adapage", { title: "Mine" })).status).toBe(404);
    expect((await api(bob, "DELETE", "sites/adapage")).status).toBe(404);
    expect((await api(bob, "POST", "sites", { handle: "adapage" })).status).toBe(409);
    // Deleting frees the handle at once.
    expect((await api(ada, "DELETE", "sites/adapage")).status).toBe(200);
    expect((await api(bob, "POST", "sites", { handle: "adapage" })).status).toBe(201);
  });

  it("names the button at fault and refuses script links", async () => {
    const token = await user("ada", [["google", "g1"]]);
    await api(token, "POST", "sites", { handle: "adapage" });
    const answer = await api(token, "PATCH", "sites/adapage", { buttons: [{ label: "x", url: "javascript:alert(1)" }] });
    expect(answer.status).toBe(400);
    expect(((await answer.json()) as { message: string }).message).toMatch(/^Button 1/);
  });

  it("answers 429 past the burst limit", async () => {
    const token = await user("ada", [["google", "g1"]]);
    limits.allow = false;
    const answer = await api(token, "GET", "sites");
    expect(answer.status).toBe(429);
    expect(answer.headers.get("Retry-After")).toBe("60");
  });
});

describe("tokens", () => {
  it("stop working once revoked", async () => {
    const token = await user("ada", [["google", "g1"]]);
    const found = await userForToken(env.DB, token, NOW);
    expect(found?.userId).toBe("ada");
    await revokeToken(env.DB, { userId: "ada", tokenId: found!.tokenId, now: NOW });
    expect(await userForToken(env.DB, token, NOW)).toBeNull();
  });
});

describe("Telegram", () => {
  const telegram = { id: 777, firstName: "Ada", lastName: null, username: "ada_tg", photoUrl: null };

  it("links one identity to one account", async () => {
    await user("ada", [["google", "g1"]]);
    await user("bob", [["google", "g2"]]);
    expect(await linkTelegram(env.DB, "ada", telegram, NOW)).toBe("linked");
    expect(await linkTelegram(env.DB, "ada", telegram, NOW)).toBe("already_linked");
    expect(await linkTelegram(env.DB, "bob", telegram, NOW)).toBe("taken");
    expect(await userForTelegram(env.DB, 777)).toBe("ada");
    expect((await accountRecord(env.DB, "ada"))?.telegram).toEqual({ id: "777", username: "ada_tg", name: "Ada" });
  });

  it("keeps Telegram on an account that has nothing else to sign in with", async () => {
    await user("legacy", [["telegram", "555"]]);
    expect(await unlinkTelegram(env.DB, "legacy")).toBe(false);
    await user("ada", [["google", "g1"], ["telegram", "556"]]);
    expect(await unlinkTelegram(env.DB, "ada")).toBe(true);
  });

  it("uses a sign-in or linking token once, within its time", async () => {
    await user("ada", [["google", "g1"]]);
    const token = await issueTelegramToken(env.DB, { userId: "ada", purpose: "login", now: NOW });
    expect(await peekTelegramToken(env.DB, token, "link", NOW)).toBeNull();
    expect(await peekTelegramToken(env.DB, token, "login", NOW)).toBe("ada");
    expect(await claimTelegramToken(env.DB, token, "login", NOW)).toBe("ada");
    expect(await claimTelegramToken(env.DB, token, "login", NOW)).toBeNull();
    const late = await issueTelegramToken(env.DB, { userId: "ada", purpose: "login", now: NOW });
    expect(await claimTelegramToken(env.DB, late, "login", NOW + 3600)).toBeNull();
  });
});
