import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The burst limiters stay open here; api.test.ts covers them.
vi.mock("../../app/lib/security/rate-limit.server", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../app/lib/security/rate-limit.server")>();
  return { ...original, withinLimits: vi.fn(async () => true) };
});

// Covers are looked up here, never drawn: the renderer's WebAssembly stays out.
vi.mock("../../app/lib/og/render.server", () => ({ renderCover: vi.fn(), storedPicture: vi.fn(async () => null) }));

import { handleApi } from "../../app/lib/api/v1.server";
import { signStripePayload } from "../../app/lib/billing/stripe.server";
import { fulfilCheckout, startCheckout, subscriptionEnd } from "../../app/lib/billing.server";
import { billingOf, enforcePublishLimits } from "../../app/lib/db/billing.server";
import { accountRecord } from "../../app/lib/db/accounts.server";
import { connectedDomain, domainOf, ownershipAnswer } from "../../app/lib/db/domains.server";
import { siteByHandle } from "../../app/lib/db/sites.server";
import { sitemapSubpages } from "../../app/lib/db/subpages.server";
import { createToken } from "../../app/lib/db/tokens.server";
import { checkDomain, checkDomains } from "../../app/lib/domain-setup.server";
import { coverResponse } from "../../app/lib/og/covers.server";
import { siteExtras } from "../../app/lib/views/site-extras.server";
import { pageMarkdown, subpageMarkdown } from "../../app/lib/views/markdown.server";
import { action as stripeWebhook } from "../../app/routes/stripe-webhook";

const ORIGIN = "https://neat.link";
const NOW = Math.floor(Date.now() / 1000);
const YEAR = 365 * 24 * 3600;
const TABLES = ["api_tokens", "media", "purchases", "domains", "pages", "sites", '"account"', '"user"'];

async function user(id: string): Promise<string> {
  const stamp = new Date(NOW * 1000).toISOString();
  await env.DB.prepare(`INSERT INTO "user" VALUES (?1, ?2, ?3, 1, NULL, ?4, ?4)`).bind(id, `Name ${id}`, `${id}@example.com`, stamp).run();
  return (await createToken(env.DB, { userId: id, label: "test", now: NOW }))!;
}

async function grant(userId: string, product: "domains" | "pro_year" | "pro_life", endsAt: number | null = null) {
  await env.DB.prepare(`INSERT INTO purchases (id, user_id, product, created_at, ends_at) VALUES (?1, ?2, ?3, ?4, ?5)`)
    .bind(`grant_${userId}_${product}`, userId, product, NOW, endsAt)
    .run();
}

function api(token: string | null, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const init = new Headers(headers);
  if (token) init.set("Authorization", `Bearer ${token}`);
  let payload: BodyInit | undefined;
  if (body instanceof Uint8Array) payload = body as Uint8Array<ArrayBuffer>;
  else if (body !== undefined) {
    init.set("Content-Type", "application/json");
    payload = JSON.stringify(body);
  }
  const request = new Request(`${ORIGIN}/api/v1/${path}`, { method, headers: init, body: payload });
  return handleApi(request, path.split("?")[0]!);
}

async function answer<T = Record<string, unknown>>(response: Response | Promise<Response>): Promise<{ status: number; body: T }> {
  const resolved = await response;
  return { status: resolved.status, body: (await resolved.json()) as T };
}

/** Calls out of the Worker, answered here: Stripe, the DNS resolver and Cloudflare's API. */
type Outbound = (url: URL, init: RequestInit & { body?: string }) => Response | Promise<Response> | null;
let outbound: Outbound[] = [];
const sent: Array<{ url: string; method: string; body: string }> = [];

/** The DNS the resolver answers from: name → type → records. */
let dns: Record<string, Partial<Record<"NS" | "CNAME" | "TXT" | "A" | "AAAA", string[]>>> = {};
const TYPE_NUMBERS = { A: 1, NS: 2, CNAME: 5, TXT: 16, AAAA: 28 } as const;

beforeEach(async () => {
  await env.DB.batch(TABLES.map((table) => env.DB.prepare(`DELETE FROM ${table}`)));
  outbound = [];
  sent.length = 0;
  dns = {};
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const body = request.method === "GET" ? "" : new TextDecoder().decode(await request.arrayBuffer());
    sent.push({ url: url.href, method: request.method, body });
    if (url.hostname === "cloudflare-dns.com") {
      const name = url.searchParams.get("name")!;
      const type = url.searchParams.get("type") as keyof typeof TYPE_NUMBERS;
      const known = dns[name];
      const records = known?.[type] ?? [];
      return Response.json({
        Status: known ? 0 : 3,
        Answer: records.map((data) => ({ name: `${name}.`, type: TYPE_NUMBERS[type], data })),
      });
    }
    for (const handler of outbound) {
      const result = await handler(url, { method: request.method, body });
      if (result) return result;
    }
    return new Response(`No mock for ${request.method} ${url.href}`, { status: 599 });
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("plans and payments", () => {
  it("starts a checkout for what the account lacks, and refuses what it has", async () => {
    const token = await user("ada");
    outbound.push((url) =>
      url.pathname === "/v1/prices" ? Response.json({ data: [{ id: `price_${url.searchParams.get("lookup_keys[0]")}` }] }) : null,
    );
    outbound.push((url) =>
      url.pathname === "/v1/checkout/sessions" ? Response.json({ id: "cs_test_1", url: "https://checkout.stripe.com/c/pay/cs_test_1" }) : null,
    );

    const made = await answer(api(token, "POST", "checkout", { product: "domains" }));
    expect(made.status).toBe(201);
    expect(made.body.url).toBe("https://checkout.stripe.com/c/pay/cs_test_1");
    const session = new URLSearchParams(sent.find((call) => call.url.endsWith("/v1/checkout/sessions"))!.body);
    expect(session.get("mode")).toBe("payment");
    expect(session.get("line_items[0][price]")).toBe("price_neat_domains_once");
    expect(session.get("client_reference_id")).toBe("ada");
    expect(session.get("metadata[product]")).toBe("domains");
    expect(session.get("automatic_tax[enabled]")).toBe("true");
    expect(session.get("invoice_creation[enabled]")).toBe("true");
    expect(session.get("customer_email")).toBe("ada@example.com");

    expect((await answer(api(token, "POST", "checkout", { product: "gold" }))).body.error).toBe("invalid_product");
    await grant("ada", "pro_life");
    const again = await answer(api(token, "POST", "checkout", { product: "pro_year" }));
    expect(again.status).toBe(409);
    expect(again.body.error).toBe("already_bought");
    const plan = await answer<{ plan: string; products: Array<{ product: string; available: boolean }> }>(api(token, "GET", "plan"));
    expect(plan.body.plan).toBe("pro");
    expect(plan.body.products.every((product) => !product.available)).toBe(true);
  });

  it("gives what a signed webhook says was paid, once, and nothing for an unsigned one", async () => {
    const token = await user("ada");
    const periodEnd = NOW + YEAR;
    outbound.push((url) =>
      url.pathname === "/v1/subscriptions/sub_1"
        ? Response.json({ id: "sub_1", status: "active", items: { data: [{ current_period_end: periodEnd }] } })
        : null,
    );
    const event = JSON.stringify({
      id: "evt_1",
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_test_2",
          mode: "subscription",
          payment_status: "paid",
          client_reference_id: "ada",
          metadata: { user_id: "ada", product: "pro_year" },
          customer: "cus_1",
          subscription: "sub_1",
          payment_intent: null,
          amount_total: 6200,
          currency: "usd",
        },
      },
    });
    const deliver = async (signature: string | null) => {
      const headers = new Headers({ "Content-Type": "application/json" });
      if (signature) headers.set("Stripe-Signature", signature);
      const response = await stripeWebhook({ request: new Request(`${ORIGIN}/stripe/webhook`, { method: "POST", headers, body: event }) } as never);
      return response.status;
    };

    expect(await deliver(null)).toBe(400);
    expect(await deliver(await signStripePayload(event, "whsec_wrong", NOW))).toBe(400);
    expect(await deliver(await signStripePayload(event, env.STRIPE_WEBHOOK_SECRET, NOW - 3600))).toBe(400);
    expect((await billingOf(env.DB, "ada")).plan).toBe("free");

    const signature = await signStripePayload(event, env.STRIPE_WEBHOOK_SECRET, NOW);
    expect(await deliver(signature)).toBe(200);
    expect(await deliver(signature)).toBe(200);
    const billing = await billingOf(env.DB, "ada");
    expect(billing.plan).toBe("pro");
    expect(billing.customerId).toBe("cus_1");
    expect(billing.running).toHaveLength(1);
    // The paid year and three days' grace for the renewal.
    expect(billing.running[0]!.endsAt).toBe(periodEnd + 3 * 24 * 3600);
    expect((await answer<{ plan: string }>(api(token, "GET", "me"))).body.plan).toBe("pro");
  });

  it("follows the yearly plan's end and takes a refunded purchase back", async () => {
    await user("ada");
    await env.DB.prepare(
      `INSERT INTO purchases (id, user_id, product, subscription_id, payment_intent_id, created_at, ends_at) VALUES
         ('cs_year', 'ada', 'pro_year', 'sub_2', NULL, ?1, ?2), ('cs_dom', 'ada', 'domains', NULL, 'pi_1', ?1, NULL)`,
    )
      .bind(NOW, NOW + YEAR)
      .run();
    outbound.push((url) =>
      url.pathname === "/v1/subscriptions/sub_2" ? Response.json({ id: "sub_2", status: "canceled", ended_at: NOW - 60 }) : null,
    );
    const deliver = async (event: unknown) => {
      const body = JSON.stringify(event);
      const headers = { "Stripe-Signature": await signStripePayload(body, env.STRIPE_WEBHOOK_SECRET, NOW) };
      return (await stripeWebhook({ request: new Request(`${ORIGIN}/stripe/webhook`, { method: "POST", headers, body }) } as never)).status;
    };
    expect(await deliver({ id: "evt_2", type: "customer.subscription.deleted", data: { object: { id: "sub_2" } } })).toBe(200);
    expect((await billingOf(env.DB, "ada")).plan).toBe("domains");
    expect(await deliver({ id: "evt_3", type: "charge.refunded", data: { object: { refunded: true, payment_intent: "pi_1" } } })).toBe(200);
    expect((await billingOf(env.DB, "ada")).plan).toBe("free");
  });

  it("stops the yearly plan renewing once Pro for life is bought", async () => {
    await user("ada");
    await env.DB.prepare(`INSERT INTO purchases (id, user_id, product, subscription_id, created_at, ends_at) VALUES ('cs_year', 'ada', 'pro_year', 'sub_9', ?1, ?2)`)
      .bind(NOW, NOW + YEAR)
      .run();
    outbound.push((url, init) => (url.pathname === "/v1/subscriptions/sub_9" && init.method === "POST" ? Response.json({ id: "sub_9" }) : null));
    outbound.push((url) => (url.pathname === "/v1/payment_intents/pi_2" ? Response.json({ id: "pi_2", latest_charge: { refunded: false } }) : null));
    const session = {
      id: "cs_life",
      mode: "payment",
      payment_status: "paid",
      client_reference_id: "ada",
      metadata: { product: "pro_life" },
      customer: "cus_1",
      subscription: null,
      payment_intent: "pi_2",
      amount_total: 12400,
      currency: "usd",
    };
    expect(await fulfilCheckout(session, NOW)).toBe(true);
    expect(await fulfilCheckout(session, NOW)).toBe(false);
    const cancel = sent.find((call) => call.url.endsWith("/v1/subscriptions/sub_9") && call.method === "POST");
    expect(new URLSearchParams(cancel!.body).get("cancel_at_period_end")).toBe("true");
  });

  it("gives an unpaid renewal three days, not the year Stripe has already moved on to", () => {
    const period = { current_period_start: NOW - 3600, current_period_end: NOW - 3600 + YEAR };
    expect(subscriptionEnd({ id: "s", status: "active", items: { data: [period] } }, NOW)).toBe(period.current_period_end + 3 * 86400);
    expect(subscriptionEnd({ id: "s", status: "past_due", items: { data: [period] } }, NOW)).toBe(period.current_period_start + 3 * 86400);
    expect(subscriptionEnd({ id: "s", status: "active", cancel_at_period_end: true, items: { data: [period] } }, NOW)).toBe(period.current_period_end);
    expect(subscriptionEnd({ id: "s", status: "canceled", ended_at: NOW - 10 }, NOW)).toBe(NOW - 10);
  });

  it("refunds a second payment for what the account already has, and keeps a refund that came first", async () => {
    await user("ada");
    await grant("ada", "domains");
    outbound.push((url, init) => (url.pathname === "/v1/refunds" && init.method === "POST" ? Response.json({ id: "re_1" }) : null));
    outbound.push((url) => (url.pathname === "/v1/payment_intents/pi_back" ? Response.json({ latest_charge: { refunded: true } }) : null));
    const session = (id: string, product: string, paymentIntent: string) => ({
      id,
      mode: "payment",
      payment_status: "paid",
      client_reference_id: "ada",
      metadata: { product },
      customer: "cus_1",
      subscription: null,
      payment_intent: paymentIntent,
      amount_total: 1240,
      currency: "usd",
    });
    expect(await fulfilCheckout(session("cs_dup", "domains", "pi_dup"), NOW)).toBe(false);
    const refund = sent.find((call) => call.url.endsWith("/v1/refunds"));
    expect(new URLSearchParams(refund!.body).get("payment_intent")).toBe("pi_dup");
    // Refunded before it was ever recorded: kept for the record, giving nothing.
    expect(await fulfilCheckout(session("cs_back", "pro_life", "pi_back"), NOW)).toBe(false);
    expect((await billingOf(env.DB, "ada")).plan).toBe("domains");
    const rows = await env.DB.prepare(`SELECT id FROM purchases WHERE refunded_at IS NOT NULL ORDER BY id`).all<{ id: string }>();
    expect(rows.results.map((row) => row.id)).toEqual(["cs_back", "cs_dup"]);
  });

  it("takes back what a lost chargeback paid for", async () => {
    await user("ada");
    await env.DB.prepare(`INSERT INTO purchases (id, user_id, product, payment_intent_id, created_at) VALUES ('cs_life', 'ada', 'pro_life', 'pi_9', ?1)`).bind(NOW).run();
    const body = JSON.stringify({ id: "evt_9", type: "charge.dispute.closed", data: { object: { status: "lost", payment_intent: "pi_9" } } });
    const headers = { "Stripe-Signature": await signStripePayload(body, env.STRIPE_WEBHOOK_SECRET, NOW) };
    expect((await stripeWebhook({ request: new Request(`${ORIGIN}/stripe/webhook`, { method: "POST", headers, body }) } as never)).status).toBe(200);
    expect((await billingOf(env.DB, "ada")).plan).toBe("free");
  });

  it("keeps one payment link open per account", async () => {
    await user("ada");
    let made = 0;
    outbound.push((url) => (url.pathname === "/v1/prices" ? Response.json({ data: [{ id: "price_1" }] }) : null));
    outbound.push((url) => {
      if (url.pathname === "/v1/checkout/sessions") {
        made += 1;
        return Response.json({ id: `cs_open_${made}`, url: `https://checkout.stripe.com/c/pay/cs_open_${made}` });
      }
      return url.pathname.endsWith("/expire") ? Response.json({ status: "expired" }) : null;
    });
    const account = (await accountRecord(env.DB, "ada"))!;
    await startCheckout(account, "domains", ORIGIN);
    expect(sent.some((call) => call.url.includes("/expire"))).toBe(false);
    await startCheckout(account, "pro_year", ORIGIN);
    expect(sent.filter((call) => call.url.includes("/expire")).map((call) => new URL(call.url).pathname)).toEqual(["/v1/checkout/sessions/cs_open_1/expire"]);
  });

  it("takes pages past an ended plan's limit back to drafts, newest first", async () => {
    const token = await user("ada");
    await grant("ada", "pro_year", NOW + YEAR);
    for (const handle of ["adapage1", "adapage2", "adapage3", "adapage4"]) {
      expect((await api(token, "POST", "sites", { handle, published: true })).status).toBe(201);
      await env.DB.prepare(`UPDATE sites SET published_at = published_at + ?2 WHERE handle = ?1`).bind(handle, Number(handle.slice(-1))).run();
    }
    expect(await enforcePublishLimits(env.DB, NOW, { free: 2, domains: 2, pro: 10 })).toBe(0);
    await env.DB.prepare(`UPDATE purchases SET ends_at = ?1`).bind(NOW - 1).run();
    expect(await enforcePublishLimits(env.DB, NOW, { free: 2, domains: 2, pro: 10 })).toBe(2);
    const published = await env.DB.prepare(`SELECT handle FROM sites WHERE published_at IS NOT NULL ORDER BY handle`).all<{ handle: string }>();
    expect(published.results.map((row) => row.handle)).toEqual(["adapage1", "adapage2"]);
    // A publish past the limit is refused before anything else is saved.
    const refused = await answer(api(token, "PATCH", "sites/adapage3", { title: "Changed", published: true }));
    expect(refused.body.error).toBe("publish_limit");
    expect((await siteByHandle(env.DB, "adapage3"))!.page.title).not.toBe("Changed");
  });
});

describe("Pro settings", () => {
  it("adds pixels and hides the sign with Pro only, and stops applying them when it ends", async () => {
    const token = await user("ada");
    await api(token, "POST", "sites", { handle: "adapage", published: true });
    const refused = await answer(api(token, "PATCH", "sites/adapage", { pixels: { google: "G-ABC1234" } }));
    expect(refused.status).toBe(402);
    expect(refused.body.error).toBe("plan_required");
    expect((await answer(api(token, "PATCH", "sites/adapage", { branding: false }))).status).toBe(402);

    await grant("ada", "pro_year", NOW + YEAR);
    expect((await answer(api(token, "PATCH", "sites/adapage", { pixels: { meta: "not a number" } }))).body.error).toBe("invalid_pixels");
    const saved = await answer<{ site: Record<string, unknown> }>(
      api(token, "PATCH", "sites/adapage", { pixels: { google: " g-abc1234 ", tiktok: "c4abcdefghij" }, branding: false }),
    );
    expect(saved.status).toBe(200);
    expect(saved.body.site).toMatchObject({ pixels: { google: "G-ABC1234", tiktok: "C4ABCDEFGHIJ" }, branding: false, pro_active: true });
    expect(siteExtras((await siteByHandle(env.DB, "adapage"))!)).toEqual({
      pixels: { google: "G-ABC1234", tiktok: "C4ABCDEFGHIJ" },
      branding: false,
      headers: { "X-Page-Pixels": "google tiktok" },
    });
    // Removing one merges into the rest.
    await api(token, "PATCH", "sites/adapage", { pixels: { tiktok: "" } });
    expect((await siteByHandle(env.DB, "adapage"))!.pixels).toEqual({ google: "G-ABC1234" });

    await env.DB.prepare(`UPDATE purchases SET ends_at = ?1`).bind(NOW - 1).run();
    expect(siteExtras((await siteByHandle(env.DB, "adapage"))!)).toEqual({ pixels: null, branding: true, headers: {} });
    // Turning them off needs no plan.
    expect((await answer(api(token, "PATCH", "sites/adapage", { pixels: { google: null }, branding: true }))).status).toBe(200);
  });
});

describe("own domains", () => {
  const godaddy = { NS: ["ns51.domaincontrol.com.", "ns52.domaincontrol.com."] };
  const cloudflare = { NS: ["ada.ns.cloudflare.com.", "bob.ns.cloudflare.com."] };

  it("need a plan with them, and refuse a root domain its DNS cannot point here", async () => {
    const token = await user("ada");
    await api(token, "POST", "sites", { handle: "adapage", published: true });
    expect((await answer(api(token, "PUT", "sites/adapage/domain", { hostname: "www.ada-lovelace.com" }))).status).toBe(402);
    await grant("ada", "domains");
    dns["ada-lovelace.com"] = godaddy;
    dns["www.ada-lovelace.com"] = {};
    const root = await answer(api(token, "PUT", "sites/adapage/domain", { hostname: "ada-lovelace.com" }));
    expect(root.status).toBe(400);
    expect(root.body.error).toBe("root_domain");
    expect(String(root.body.message)).toContain("www.ada-lovelace.com");
    for (const hostname of ["neat.link", "media.neat.link", "x.byo.neat.link", "localhost", "1.2.3.4", "not a domain"]) {
      expect((await answer(api(token, "PUT", "sites/adapage/domain", { hostname }))).body.error).toBe("invalid_domain");
    }
  });

  it("waits for the DNS records, then connects and serves the domain", async () => {
    const token = await user("ada");
    await api(token, "POST", "sites", { handle: "adapage", published: true });
    await grant("ada", "domains");
    dns["ada-lovelace.com"] = godaddy;
    dns["www.ada-lovelace.com"] = {};

    type DomainAnswer = { domain: { status: string; records: Array<{ type: string; name: string; value: string; required: boolean }>; provider: { name: string } } };
    const claimed = await answer<DomainAnswer>(api(token, "PUT", "sites/adapage/domain", { hostname: "https://WWW.Ada-Lovelace.com/" }));
    expect(claimed.status).toBe(200);
    expect(claimed.body.domain.status).toBe("pending");
    expect(claimed.body.domain.provider.name).toBe("GoDaddy");
    const [cname, txt] = claimed.body.domain.records;
    expect(cname).toMatchObject({ type: "CNAME", name: "www", required: true });
    expect(cname!.value).toMatch(/^[a-z0-9]{10}\.byo\.neat\.link$/);
    expect(txt).toMatchObject({ type: "TXT", name: "_neat-link.www", required: false });
    expect(await connectedDomain(env.DB, "www.ada-lovelace.com")).toBeNull();

    // A CNAME to some other site's target is not this claim.
    dns["www.ada-lovelace.com"] = { CNAME: ["other.byo.neat.link."] };
    expect((await answer<DomainAnswer>(api(token, "POST", "sites/adapage/domain/check"))).body.domain.status).toBe("pending");
    dns["www.ada-lovelace.com"] = { CNAME: [`${cname!.value}.`] };
    expect((await answer<DomainAnswer>(api(token, "POST", "sites/adapage/domain/check"))).body.domain.status).toBe("live");
    expect(await connectedDomain(env.DB, "www.ada-lovelace.com")).toMatchObject({ handle: "adapage" });
    expect(await connectedDomain(env.DB, "ada-lovelace.com")).toMatchObject({ hostname: "www.ada-lovelace.com" });
    const site = await answer<{ site: { url: string } }>(api(token, "GET", "sites/adapage"));
    expect(site.body.site.url).toBe("https://www.ada-lovelace.com/");

    // Nobody else can take it while it is connected.
    const bob = await user("bob");
    await grant("bob", "domains");
    await api(bob, "POST", "sites", { handle: "bobpage", published: true });
    expect((await answer(api(bob, "PUT", "sites/bobpage/domain", { hostname: "www.ada-lovelace.com" }))).status).toBe(409);

    // When the plan ends the domain is no longer served, nor named as the
    // page's address, and the hourly check lets it go.
    await env.DB.prepare(`DELETE FROM purchases WHERE user_id = 'ada'`).run();
    expect(await connectedDomain(env.DB, "www.ada-lovelace.com")).toBeNull();
    expect((await siteByHandle(env.DB, "adapage"))!.domain).toBeNull();
    const siteId = (await siteByHandle(env.DB, "adapage"))!.id;
    await checkDomain((await domainOf(env.DB, siteId))!, NOW, false);
    expect((await domainOf(env.DB, siteId))!.status).toBe("pending");

    await grant("ada", "domains");
    expect((await answer(api(token, "DELETE", "sites/adapage/domain"))).status).toBe(200);
    expect(await domainOf(env.DB, siteId)).toBeNull();
    // The name is free again for bob.
    expect((await answer(api(bob, "PUT", "sites/bobpage/domain", { hostname: "www.ada-lovelace.com" }))).status).toBe(200);
  });

  it("are made at Cloudflare once they point here, and served once Cloudflare serves them", async () => {
    const saved = { zone: env.CF_ZONE_ID, token: env.CF_API_TOKEN };
    Object.assign(env, { CF_ZONE_ID: "zone1", CF_API_TOKEN: "token1" });
    try {
      const token = await user("ada");
      await api(token, "POST", "sites", { handle: "adapage", published: true });
      await grant("ada", "domains");
      dns["ada-lovelace.com"] = godaddy;
      dns["www.ada-lovelace.com"] = {};
      let state = { status: "pending", ssl: "pending_validation" };
      outbound.push((url, init) => {
        if (url.hostname !== "api.cloudflare.com") return null;
        if (init.method === "POST") expect(JSON.parse(init.body!)).toMatchObject({ hostname: "www.ada-lovelace.com", ssl: { method: "http" } });
        if (init.method === "DELETE") return Response.json({ success: true, result: { id: "ch_1" } });
        return Response.json({
          success: true,
          result: {
            id: "ch_1",
            status: state.status,
            ssl: { status: state.ssl },
            ownership_verification_http: { http_url: "http://www.ada-lovelace.com/.well-known/cf-custom-hostname-challenge/abc", http_body: "proof-1" },
          },
        });
      });
      type DomainAnswer = { domain: { status: string; records: Array<{ value: string }> } };
      const claimed = await answer<DomainAnswer>(api(token, "PUT", "sites/adapage/domain", { hostname: "www.ada-lovelace.com" }));
      expect(sent.some((call) => call.url.includes("custom_hostnames"))).toBe(false);
      dns["www.ada-lovelace.com"] = { CNAME: [`${claimed.body.domain.records[0]!.value}.`] };
      expect((await answer<DomainAnswer>(api(token, "POST", "sites/adapage/domain/check"))).body.domain.status).toBe("issuing_certificate");
      // Not the site's address, nor served, until Cloudflare serves it.
      expect(await connectedDomain(env.DB, "www.ada-lovelace.com")).toBeNull();
      expect(await ownershipAnswer(env.DB, "www.ada-lovelace.com", "/.well-known/cf-custom-hostname-challenge/abc")).toBe("proof-1");
      state = { status: "active", ssl: "active" };
      expect((await answer<DomainAnswer>(api(token, "POST", "sites/adapage/domain/check"))).body.domain.status).toBe("live");
      expect(await connectedDomain(env.DB, "www.ada-lovelace.com")).not.toBeNull();
      expect((await answer(api(token, "DELETE", "sites/adapage/domain"))).status).toBe(200);
      expect(sent.some((call) => call.method === "DELETE" && call.url.endsWith("/custom_hostnames/ch_1"))).toBe(true);
    } finally {
      Object.assign(env, { CF_ZONE_ID: saved.zone, CF_API_TOKEN: saved.token });
    }
  });

  it("let a hostname made on a TXT record alone go after a week, and make it again only when asked", async () => {
    const saved = { zone: env.CF_ZONE_ID, token: env.CF_API_TOKEN };
    Object.assign(env, { CF_ZONE_ID: "zone1", CF_API_TOKEN: "token1" });
    try {
      const token = await user("ada");
      await api(token, "POST", "sites", { handle: "adapage", published: true });
      await grant("ada", "pro_life");
      dns["ada-lovelace.com"] = cloudflare;
      let registered = 0;
      outbound.push((url, init) => {
        if (url.hostname !== "api.cloudflare.com") return null;
        if (init.method === "POST") registered += 1;
        return Response.json({ success: true, result: { id: `ch_${registered}`, status: "pending", ssl: { status: "pending_validation" } } });
      });
      type DomainAnswer = { domain: { status: string; records: Array<{ value: string }> } };
      const claimed = await answer<DomainAnswer>(api(token, "PUT", "sites/adapage/domain", { hostname: "ada-lovelace.com" }));
      dns["ada-lovelace.com"] = { ...cloudflare, A: ["192.0.2.1"] };
      dns["_neat-link.ada-lovelace.com"] = { TXT: [`"${claimed.body.domain.records[1]!.value}"`] };
      expect((await answer<DomainAnswer>(api(token, "POST", "sites/adapage/domain/check"))).body.domain.status).toBe("issuing_certificate");
      expect(registered).toBe(1);
      const siteId = (await siteByHandle(env.DB, "adapage"))!.id;
      const later = NOW + 8 * 86400;
      await checkDomain((await domainOf(env.DB, siteId))!, later, true);
      const stalled = (await domainOf(env.DB, siteId))!;
      expect(stalled).toMatchObject({ status: "pending", cfId: null, stalledAt: later });
      // The hourly check leaves it; the owner's own check tries again.
      await checkDomains(later + 7200);
      expect(registered).toBe(1);
      await checkDomain((await domainOf(env.DB, siteId))!, later + 7300, true, true);
      expect(registered).toBe(2);
    } finally {
      Object.assign(env, { CF_ZONE_ID: saved.zone, CF_API_TOKEN: saved.token });
    }
  });

  it("connects a root domain at Cloudflare by its TXT record", async () => {
    const token = await user("ada");
    await api(token, "POST", "sites", { handle: "adapage", published: true });
    await grant("ada", "pro_life");
    dns["ada-lovelace.com"] = cloudflare;
    type DomainAnswer = { domain: { status: string; records: Array<{ type: string; name: string; value: string; required: boolean }>; notes: string[] } };
    const claimed = await answer<DomainAnswer>(api(token, "PUT", "sites/adapage/domain", { hostname: "ada-lovelace.com" }));
    expect(claimed.body.domain.status).toBe("pending");
    const [cname, txt] = claimed.body.domain.records;
    expect(cname).toMatchObject({ name: "@", required: true });
    expect(txt).toMatchObject({ name: "_neat-link", required: true });
    expect(claimed.body.domain.notes.join(" ")).toContain("DNS only");
    // Cloudflare flattens the CNAME into addresses; the TXT record shows whose claim it is.
    dns["ada-lovelace.com"] = { ...cloudflare, A: ["104.21.1.1"] };
    dns["_neat-link.ada-lovelace.com"] = { TXT: [`"${txt!.value}"`] };
    expect((await answer<DomainAnswer>(api(token, "POST", "sites/adapage/domain/check"))).body.domain.status).toBe("live");
  });
});

describe("subpages", () => {
  type Sub = { id: string; url: string | null; private_url: string; markdown_url: string; path: string | null; visible: boolean };

  it("are private by link, public at a path once given one, and need Pro", async () => {
    const token = await user("ada");
    await api(token, "POST", "sites", { handle: "adapage", title: "Ada", published: true });
    expect((await answer(api(token, "POST", "sites/adapage/pages", { title: "Notes" }))).status).toBe(402);
    await grant("ada", "pro_year", NOW + YEAR);

    const made = await answer<{ page: Sub }>(api(token, "POST", "sites/adapage/pages", { title: "How I made it", body: "First **steps**." }));
    expect(made.status).toBe(201);
    const page = made.body.page;
    expect(page.url).toBeNull();
    expect(page.private_url).toMatch(/^https:\/\/neat\.link\/adapage\/[a-z0-9]{12}$/);
    const privateId = page.private_url.split("/").pop()!;
    const hidden = await subpageMarkdown(env.DB, "adapage", privateId, ORIGIN);
    expect(hidden).toMatchObject({ url: page.private_url, indexable: false });
    expect(hidden!.text).toContain("First **steps**.");
    expect(await sitemapSubpages(env.DB, 100)).toEqual([]);

    const published = await answer<{ page: Sub }>(api(token, "PATCH", `sites/adapage/pages/${page.id}`, { path: true }));
    expect(published.body.page.url).toBe("https://neat.link/adapage/how-i-made-it");
    expect(await subpageMarkdown(env.DB, "adapage", "how-i-made-it", ORIGIN)).toMatchObject({ indexable: true });
    // Both addresses work at once.
    expect(await subpageMarkdown(env.DB, "adapage", privateId, ORIGIN)).not.toBeNull();
    expect(await sitemapSubpages(env.DB, 100)).toEqual([{ handle: "adapage", path: "how-i-made-it", updatedAt: expect.any(Number) }]);
    expect((await pageMarkdown(env.DB, "adapage", ORIGIN))!.text).toContain("## Pages\n\n- [How I made it](https://neat.link/adapage/how-i-made-it)");

    // Paths are checked and unique within the site.
    expect((await answer(api(token, "POST", "sites/adapage/pages", { title: "x", path: "Bad Path" }))).body.error).toBe("invalid_path");
    expect((await answer(api(token, "POST", "sites/adapage/pages", { title: "x", path: "how-i-made-it" }))).status).toBe(409);
    expect((await answer(api(token, "POST", "sites/adapage/pages", { title: "x", path: privateId }))).status).toBe(409);

    // Rotating ends the old private address, and its cover.
    const cover = (segment: string) =>
      coverResponse(new URL(`${ORIGIN}/og/adapage/${segment}.png`), async () => {
        throw new Error("not drawn here");
      });
    expect((await cover(privateId))?.status).toBe(302);
    const rotated = await answer<{ page: Sub }>(api(token, "POST", `sites/adapage/pages/${page.id}/rotate`));
    expect(rotated.body.page.private_url).not.toBe(page.private_url);
    expect(await subpageMarkdown(env.DB, "adapage", privateId, ORIGIN)).toBeNull();
    expect(await cover(privateId)).toBeNull();
    expect(await cover(page.id)).toBeNull();

    // A draft site, or an ended plan, hides them from visitors.
    await api(token, "PATCH", "sites/adapage", { published: false });
    expect(await subpageMarkdown(env.DB, "adapage", "how-i-made-it", ORIGIN)).toBeNull();
    await api(token, "PATCH", "sites/adapage", { published: true });
    await env.DB.prepare(`UPDATE purchases SET ends_at = ?1`).bind(NOW - 1).run();
    expect(await subpageMarkdown(env.DB, "adapage", "how-i-made-it", ORIGIN)).toBeNull();
    expect(await sitemapSubpages(env.DB, 100)).toEqual([]);
    // Deleting still works without Pro.
    expect((await answer(api(token, "DELETE", `sites/adapage/pages/${page.id}`))).status).toBe(200);
    expect((await answer<{ pages: Sub[] }>(api(token, "GET", "sites/adapage/pages"))).body.pages).toEqual([]);
  });
});

describe("files", () => {
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82]);
  const PDF = new TextEncoder().encode("%PDF-1.4\n%neat test file\n");

  it("are kept for Pro accounts, by their real type, and can be deleted", async () => {
    const token = await user("ada");
    expect((await answer(api(token, "POST", "media?name=logo.png", PNG, { "Content-Type": "image/png" }))).status).toBe(402);
    await grant("ada", "pro_life");

    type File = { id: string; url: string; markdown: string; type: string; size: number };
    const png = await answer<{ file: File }>(api(token, "POST", "media?name=My Logo!.png", PNG, { "Content-Type": "application/octet-stream" }));
    expect(png.status).toBe(201);
    expect(png.body.file.type).toBe("image/png");
    expect(png.body.file.url).toMatch(/^https:\/\/neat\.link\/media\/files\/[A-Za-z0-9]{24}\/my-logo\.png$/);
    expect(png.body.file.markdown).toBe(`![My Logo!](${png.body.file.url})`);
    const stored = await env.MEDIA.get(png.body.file.url.split("/media/")[1]!);
    expect(stored?.httpMetadata?.contentType).toBe("image/png");

    // Whatever it says it is, a text file is not kept.
    const text = await answer(api(token, "POST", "media?name=page.svg", new TextEncoder().encode("<svg onload=alert(1)></svg>"), { "Content-Type": "image/svg+xml" }));
    expect(text.status).toBe(400);
    expect(text.body.error).toBe("file_type");

    const list = await answer<{ files: File[]; used_bytes: number }>(api(token, "GET", "media"));
    expect(list.body.files).toHaveLength(1);
    expect(list.body.used_bytes).toBe(PNG.byteLength);
    expect((await answer(api(token, "DELETE", `media/${png.body.file.id}`))).status).toBe(200);
    expect(await env.MEDIA.get(png.body.file.url.split("/media/")[1]!)).toBeNull();
  });

  it("can be sent to an upload link without a token, while it lasts", async () => {
    const token = await user("ada");
    await grant("ada", "pro_life");
    const link = await answer<{ url: string }>(api(token, "POST", "media/upload-link"));
    expect(link.status).toBe(201);
    const path = new URL(link.body.url).pathname.replace("/api/v1/", "");
    const upload = await answer<{ file: { type: string; url: string } }>(api(null, "PUT", `${path}?name=cv.pdf`, PDF));
    expect(upload.status).toBe(201);
    expect(upload.body.file.type).toBe("application/pdf");
    expect(upload.body.file.url).toMatch(/\/cv\.pdf$/);
    // A link changed by one character is no link.
    const forged = path.slice(0, -1) + (path.endsWith("A") ? "B" : "A");
    expect((await answer(api(null, "PUT", forged, PDF))).status).toBe(401);
  });
});
