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
import { finishPendingPurchases, fulfilCheckout, startCheckout, subscriptionEnd } from "../../app/lib/billing.server";
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
import { loader as subpageLoader } from "../../app/routes/subpage";

const ORIGIN = "https://neat.link";
const NOW = Math.floor(Date.now() / 1000);
const YEAR = 365 * 24 * 3600;
const TABLES = ["api_tokens", "media", "purchases", "stale_hostnames", "domains", "pages", "sites", '"account"', '"user"'];

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
type Outbound = (url: URL, init: { method: string; body?: string; headers: Headers }) => Response | null | Promise<Response | null>;
let outbound: Outbound[] = [];
const sent: Array<{ url: string; method: string; body: string; key: string | null }> = [];

/** The DNS the resolver answers from: name → type → records. */
let dns: Record<string, Partial<Record<"NS" | "CNAME" | "TXT" | "A" | "AAAA", string[]>>> = {};
/** Runs as the resolver is asked about a name, to change things in the meantime. */
let onLookup: ((name: string) => Promise<void>) | null = null;
const TYPE_NUMBERS = { A: 1, NS: 2, CNAME: 5, TXT: 16, AAAA: 28 } as const;

beforeEach(async () => {
  await env.DB.batch(TABLES.map((table) => env.DB.prepare(`DELETE FROM ${table}`)));
  outbound = [];
  sent.length = 0;
  dns = {};
  onLookup = null;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const body = request.method === "GET" ? "" : new TextDecoder().decode(await request.arrayBuffer());
    sent.push({ url: url.href, method: request.method, body, key: request.headers.get("Idempotency-Key") });
    if (url.hostname === "cloudflare-dns.com") {
      const name = url.searchParams.get("name")!;
      const type = url.searchParams.get("type") as keyof typeof TYPE_NUMBERS;
      await onLookup?.(name);
      const known = dns[name];
      const records = known?.[type] ?? [];
      return Response.json({
        Status: known ? 0 : 3,
        Answer: records.map((data) => ({ name: `${name}.`, type: TYPE_NUMBERS[type], data })),
      });
    }
    for (const handler of outbound) {
      const result = await handler(url, { method: request.method, body, headers: request.headers });
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
    outbound.push((url) => (url.pathname === "/v1/subscriptions/sub_9" ? Response.json({ id: "sub_9", status: "active", cancel_at_period_end: false }) : null));
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
    stripeRefunds().paid.pi_dup = 1240;
    outbound.push((url) => (url.pathname === "/v1/payment_intents/pi_back" ? Response.json({ latest_charge: { refunded: true } }) : null));
    outbound.push((url) => (url.pathname === "/v1/payment_intents/pi_dup" ? Response.json({ latest_charge: { refunded: false } }) : null));
    // Disputed and lost: the charge only says disputed, the dispute says lost.
    outbound.push((url) =>
      url.pathname === "/v1/payment_intents/pi_lost" ? Response.json({ latest_charge: { refunded: false, disputed: true } }) : null,
    );
    outbound.push((url) =>
      url.pathname === "/v1/disputes" && url.searchParams.get("payment_intent") === "pi_lost" ? Response.json({ data: [{ status: "lost" }] }) : null,
    );
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
    expect(await fulfilCheckout(session("cs_lost", "pro_life", "pi_lost"), NOW)).toBe(false);
    expect((await billingOf(env.DB, "ada")).plan).toBe("domains");
    const rows = await env.DB.prepare(`SELECT id, pending FROM purchases WHERE refunded_at IS NOT NULL ORDER BY id`).all<{ id: string }>();
    expect(rows.results).toEqual([
      { id: "cs_back", pending: null },
      { id: "cs_dup", pending: null },
      { id: "cs_lost", pending: null },
    ]);
    // Only what Stripe can expand on a payment is asked for (and what the duplicate took, to give it all back).
    const intents = sent.filter((call) => call.url.includes("/v1/payment_intents/"));
    expect(intents.map((call) => new URL(call.url).searchParams.getAll("expand[0]"))).toEqual([["latest_charge"], [], ["latest_charge"], ["latest_charge"]]);
    expect(sent.filter((call) => call.url.endsWith("/v1/refunds"))).toHaveLength(1);
  });

  const yearly = (id: string, subscription: string) => ({
    id,
    mode: "subscription",
    payment_status: "paid",
    client_reference_id: "ada",
    metadata: { product: "pro_year" },
    customer: "cus_1",
    subscription,
    payment_intent: null,
    amount_total: 6200,
    currency: "usd",
  });

  /** Stripe's side of yearly subscriptions: each with its first invoice and payment. */
  function subscriptions(wait: (id: string) => Promise<void> = async () => {}) {
    outbound.push(async (url, init) => {
      const match = /^\/v1\/subscriptions\/(sub_\w+)$/.exec(url.pathname);
      if (!match || init.method !== "GET") return null;
      await wait(match[1]!);
      return Response.json({ id: match[1], status: "active", latest_invoice: `in_${match[1]}`, items: { data: [{ current_period_end: NOW + YEAR }] } });
    });
    outbound.push((url, init) => (url.pathname.startsWith("/v1/subscriptions/") && init.method === "DELETE" ? Response.json({ status: "canceled" }) : null));
    outbound.push((url) => {
      const match = /^\/v1\/invoices\/in_(sub_\w+)$/.exec(url.pathname);
      return match ? Response.json({ payments: { data: [{ payment: { payment_intent: `pi_${match[1]}` } }] } }) : null;
    });
  }

  it("gives a checkout told of twice at once only once, and never takes it for a duplicate", async () => {
    await user("ada");
    // The second request reads the subscription only once the first has recorded the purchase.
    let asked = 0;
    subscriptions(async () => {
      asked += 1;
      if (asked === 1) return;
      for (let tries = 0; tries < 200; tries++) {
        if (await env.DB.prepare(`SELECT 1 FROM purchases WHERE id = 'cs_race'`).first()) return;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    });
    const results = await Promise.all([fulfilCheckout(yearly("cs_race", "sub_race"), NOW), fulfilCheckout(yearly("cs_race", "sub_race"), NOW)]);
    expect(results.sort()).toEqual([false, true]);
    expect(asked).toBe(2);
    expect(sent.filter((call) => call.method === "DELETE" || call.url.endsWith("/v1/refunds"))).toEqual([]);
    const billing = await billingOf(env.DB, "ada");
    expect(billing.plan).toBe("pro");
    expect(billing.running.map((purchase) => purchase.id)).toEqual(["cs_race"]);
  });

  it("refunds the later of two payments for the same plan paid at once", async () => {
    await user("ada");
    subscriptions();
    stripeRefunds();
    const results = await Promise.all([fulfilCheckout(yearly("cs_one", "sub_one"), NOW), fulfilCheckout(yearly("cs_two", "sub_two"), NOW)]);
    expect(results.filter(Boolean)).toHaveLength(1);
    const billing = await billingOf(env.DB, "ada");
    expect(billing.running).toHaveLength(1);
    const kept = billing.running[0]!.subscriptionId!;
    const other = kept === "sub_one" ? "sub_two" : "sub_one";
    const deleted = sent.filter((call) => call.method === "DELETE").map((call) => new URL(call.url).pathname);
    expect(deleted).toEqual([`/v1/subscriptions/${other}`]);
    const refunds = sent.filter((call) => call.url.endsWith("/v1/refunds")).map((call) => new URLSearchParams(call.body).get("payment_intent"));
    expect(refunds).toEqual([`pi_${other}`]);
  });

  /**
   * Stripe's refunds as Stripe keeps them: an idempotency key gets its first
   * answer again, an error included, and a refund may take a while to
   * succeed, or fail. One made without an amount gives back what is left of
   * the payment. `paid` is what each payment took (a yearly plan's first
   * payment unless set). `failure` sets how the next attempt goes wrong:
   * "before" Stripe made anything, or "after" it made the refund.
   */
  function stripeRefunds() {
    const model = {
      refunds: [] as Array<{ id: string; payment_intent: string; amount: number; status: string; metadata: Record<string, string> }>,
      paid: {} as Record<string, number>,
      failure: null as "before" | "after" | null,
      status: "succeeded",
    };
    const paid = (paymentIntent: string) => model.paid[paymentIntent] ?? 6200;
    const answers = new Map<string, { status: number; body: unknown }>();
    outbound.push((url, init) => {
      if (url.pathname === "/v1/refunds" && init.method === "POST") {
        const key = init.headers.get("Idempotency-Key") ?? crypto.randomUUID();
        let kept = answers.get(key);
        if (!kept) {
          const form = new URLSearchParams(init.body);
          const paymentIntent = form.get("payment_intent")!;
          const left =
            paid(paymentIntent) -
            model.refunds
              .filter((refund) => refund.payment_intent === paymentIntent && refund.status !== "failed" && refund.status !== "canceled")
              .reduce((sum, refund) => sum + refund.amount, 0);
          const failure = model.failure;
          model.failure = null;
          if (left <= 0) kept = { status: 400, body: { error: { code: "charge_already_refunded", message: "Already refunded" } } };
          else if (failure !== "before") {
            const refund = {
              id: `re_${model.refunds.length + 1}`,
              payment_intent: paymentIntent,
              amount: Number(form.get("amount") ?? left),
              status: model.status,
              metadata: { checkout_session: form.get("metadata[checkout_session]")! },
            };
            model.refunds.push(refund);
            kept = failure === "after" ? { status: 500, body: { error: { message: "Something went wrong" } } } : { status: 200, body: refund };
          } else kept = { status: 500, body: { error: { message: "Something went wrong" } } };
          answers.set(key, kept);
        }
        return Response.json(kept.body, { status: kept.status });
      }
      if (url.pathname === "/v1/refunds" && init.method === "GET") {
        return Response.json({ data: model.refunds.filter((refund) => refund.payment_intent === url.searchParams.get("payment_intent")) });
      }
      // What a payment took (one asked for with its charge is answered elsewhere).
      const intent = /^\/v1\/payment_intents\/(pi_\w+)$/.exec(url.pathname);
      if (intent && !url.searchParams.has("expand[0]") && (intent[1]!.startsWith("pi_sub_") || intent[1]! in model.paid)) {
        return Response.json({ id: intent[1], amount_received: paid(intent[1]!) });
      }
      return null;
    });
    return model;
  }
  const work = () => env.DB.prepare(`SELECT pending, refunded_at FROM purchases WHERE id = 'cs_late'`).first();
  const refundPosts = () => sent.filter((call) => call.url.endsWith("/v1/refunds") && call.method === "POST");

  it("follows a duplicate's refund until Stripe has made it, and never makes a second", async () => {
    await user("ada");
    await grant("ada", "pro_life");
    subscriptions();
    const stripeSide = stripeRefunds();
    outbound.push((url) => (url.pathname === "/v1/checkout/sessions/cs_late" ? Response.json(yearly("cs_late", "sub_late")) : null));
    // Stripe makes the refund, still pending, but the answer is lost.
    stripeSide.status = "pending";
    stripeSide.failure = "after";
    await expect(fulfilCheckout(yearly("cs_late", "sub_late"), NOW)).rejects.toThrow();
    expect(await work()).toEqual({ pending: "refund", refunded_at: NOW });
    // The hourly run finds it, and waits while Stripe is still making it.
    await finishPendingPurchases(NOW + 3600);
    expect(await work()).toEqual({ pending: "refund", refunded_at: NOW });
    stripeSide.refunds[0]!.status = "succeeded";
    await finishPendingPurchases(NOW + 7200);
    expect(await work()).toEqual({ pending: null, refunded_at: NOW });
    // Done is done: neither the hourly run nor another delivery refunds again.
    await finishPendingPurchases(NOW + 10800);
    await fulfilCheckout(yearly("cs_late", "sub_late"), NOW + 10800);
    expect(stripeSide.refunds).toHaveLength(1);
    expect(refundPosts()).toHaveLength(1);
  });

  it("tries again with a new key after Stripe failed an attempt, and leaves a refund Stripe failed to be paid back by hand", async () => {
    await user("ada");
    await grant("ada", "pro_life");
    subscriptions();
    const stripeSide = stripeRefunds();
    outbound.push((url) => (url.pathname === "/v1/checkout/sessions/cs_late" ? Response.json(yearly("cs_late", "sub_late")) : null));
    stripeSide.failure = "before";
    await expect(fulfilCheckout(yearly("cs_late", "sub_late"), NOW)).rejects.toThrow();
    // The same key would only answer the same error again.
    stripeSide.status = "pending";
    await finishPendingPurchases(NOW + 3600);
    const keys = refundPosts().map((call) => call.key);
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(2);
    expect(await work()).toMatchObject({ pending: "refund" });
    expect(stripeSide.refunds).toHaveLength(1);
    // Stripe accepted the refund, then failed it (a closed card): no more tries.
    stripeSide.refunds[0]!.status = "failed";
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    await finishPendingPurchases(NOW + 7200);
    expect(await work()).toMatchObject({ pending: "refund_failed" });
    expect(errors).toHaveBeenCalledWith(expect.stringContaining("pay it back by hand"), "cs_late");
    sent.length = 0;
    await finishPendingPurchases(NOW + 10800);
    expect(sent).toEqual([]);
  });

  it("gives back the rest of a duplicate payment already partly refunded by hand", async () => {
    await user("ada");
    await grant("ada", "pro_life");
    subscriptions();
    const stripeSide = stripeRefunds();
    // $5 of the duplicate's $62 was given back by hand before it was found.
    stripeSide.refunds.push({ id: "re_hand", payment_intent: "pi_sub_part", amount: 500, status: "succeeded", metadata: {} });
    expect(await fulfilCheckout(yearly("cs_part", "sub_part"), NOW)).toBe(false);
    expect(stripeSide.refunds.map((refund) => [refund.id, refund.amount, refund.metadata.checkout_session])).toEqual([
      ["re_hand", 500, undefined],
      ["re_2", 5700, "cs_part"],
    ]);
    expect(await env.DB.prepare(`SELECT pending FROM purchases WHERE id = 'cs_part'`).first("pending")).toBeNull();
  });

  it("gives newer work its turn in the hourly run while older refunds settle or keep failing", async () => {
    await user("ada");
    await grant("ada", "pro_life");
    subscriptions();
    const stripeSide = stripeRefunds();
    stripeSide.status = "pending";
    vi.spyOn(console, "error").mockImplementation(() => {});
    // Twenty duplicates: half with refunds Stripe takes days over, half whose session Stripe will not show.
    for (let index = 0; index < 20; index++) {
      await env.DB.prepare(
        `INSERT INTO purchases (id, user_id, product, subscription_id, created_at, refunded_at, pending) VALUES (?1, 'ada', 'pro_year', ?2, ?3, ?3, 'refund')`,
      )
        .bind(`cs_old${index}`, `sub_old${index}`, NOW - 3600 + index)
        .run();
    }
    outbound.push((url) => {
      const id = /^\/v1\/checkout\/sessions\/(cs_\w+)$/.exec(url.pathname)?.[1];
      if (!id) return null;
      if (Number(id.replace("cs_old", "")) % 2 === 1) return Response.json({ error: { message: "Try again" } }, { status: 500 });
      return Response.json(yearly(id, `sub_${id.slice(3)}`));
    });
    await finishPendingPurchases(NOW);
    expect(refundPosts()).toHaveLength(10);
    // A newer duplicate, still to refund: the next run takes it on.
    await env.DB.prepare(
      `INSERT INTO purchases (id, user_id, product, subscription_id, created_at, refunded_at, pending) VALUES ('cs_new', 'ada', 'pro_year', 'sub_new', ?1, ?1, 'refund')`,
    )
      .bind(NOW + 60)
      .run();
    await finishPendingPurchases(NOW + 3600);
    expect(stripeSide.refunds.map((refund) => refund.payment_intent)).toContain("pi_sub_new");
  });

  /**
   * A yearly plan at Stripe: whether it renews, and what neat.link turned
   * that off for. `during` runs while the next update is on its way, before
   * Stripe makes it; `fail` fails the next update; `lose` loses the next
   * update's answer, and Stripe makes it only at `land()`. An update's
   * idempotency key is answered as Stripe does: its first answer again, or
   * 409 while its first request is still at work.
   */
  function yearlyPlan(id: string, start: { cancel_at_period_end?: boolean; status?: string } = {}) {
    const plan = {
      status: start.status ?? "active",
      cancel_at_period_end: start.cancel_at_period_end ?? false,
      metadata: {} as Record<string, string>,
      updates: [] as string[],
      during: null as (() => Promise<void>) | null,
      fail: false,
      lose: false,
      land: null as (() => void) | null,
    };
    const answers = new Map<string, { status: number; body: unknown }>();
    let atWork: string | null = null;
    const current = () => ({ id, status: plan.status, cancel_at_period_end: plan.cancel_at_period_end, metadata: { ...plan.metadata } });
    outbound.push(async (url, init) => {
      if (url.pathname !== `/v1/subscriptions/${id}`) return null;
      if (init.method !== "POST") return Response.json(current());
      const key = init.headers.get("Idempotency-Key");
      if (key && key === atWork) return Response.json({ error: { code: "idempotency_key_in_use", message: "In use" } }, { status: 409 });
      const known = key ? answers.get(key) : undefined;
      if (known) return Response.json(known.body, { status: known.status });
      const during = plan.during;
      plan.during = null;
      await during?.();
      const answer = (status: number, body: unknown) => {
        if (key) answers.set(key, { status, body });
        return Response.json(body, { status });
      };
      if (plan.fail) {
        plan.fail = false;
        return answer(500, { error: { message: "Try again" } });
      }
      const make = () => {
        const form = new URLSearchParams(init.body);
        plan.cancel_at_period_end = form.get("cancel_at_period_end") === "true";
        plan.updates.push(form.get("cancel_at_period_end")!);
        const stoppedFor = form.get("metadata[stopped_for]");
        if (stoppedFor) plan.metadata.stopped_for = stoppedFor;
        else if (stoppedFor === "") delete plan.metadata.stopped_for;
        return answer(200, current());
      };
      if (plan.lose) {
        plan.lose = false;
        atWork = key;
        plan.land = () => {
          atWork = null;
          plan.land = null;
          make();
        };
        throw new TypeError("Network connection lost.");
      }
      return make();
    });
    return plan;
  }
  const hasYearly = () =>
    env.DB.prepare(`INSERT INTO purchases (id, user_id, product, subscription_id, created_at, ends_at) VALUES ('cs_year', 'ada', 'pro_year', 'sub_9', ?1, ?2)`)
      .bind(NOW, NOW + YEAR)
      .run();
  /** A paid Pro for life Checkout Session, with its own payment, pi_<id>. */
  const lifetime = (id: string) => {
    outbound.push((url) => (url.pathname === `/v1/payment_intents/pi_${id}` ? Response.json({ latest_charge: { refunded: false } }) : null));
    return { ...yearly(id, "unused"), mode: "payment", subscription: null, payment_intent: `pi_${id}`, metadata: { product: "pro_life" } };
  };
  async function refunded(paymentIntent: string) {
    const body = JSON.stringify({ id: `evt_${paymentIntent}`, type: "charge.refunded", data: { object: { refunded: true, payment_intent: paymentIntent } } });
    const headers = { "Stripe-Signature": await signStripePayload(body, env.STRIPE_WEBHOOK_SECRET, NOW) };
    expect((await stripeWebhook({ request: new Request(`${ORIGIN}/stripe/webhook`, { method: "POST", headers, body }) } as never)).status).toBe(200);
  }
  const renewalWorkLeft = () => env.DB.prepare(`SELECT pending FROM purchases WHERE id = 'cs_year'`).first("pending");
  async function subscriptionUpdated(id: string) {
    const body = JSON.stringify({ id: `evt_${id}_${sent.length}`, type: "customer.subscription.updated", data: { object: { id } } });
    const headers = { "Stripe-Signature": await signStripePayload(body, env.STRIPE_WEBHOOK_SECRET, NOW) };
    expect((await stripeWebhook({ request: new Request(`${ORIGIN}/stripe/webhook`, { method: "POST", headers, body }) } as never)).status).toBe(200);
  }

  it("leaves the yearly plan renewing when Pro for life is taken back before it was stopped", async () => {
    await user("ada");
    await hasYearly();
    const plan = yearlyPlan("sub_9");
    plan.fail = true;
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await fulfilCheckout(lifetime("cs_life"), NOW)).toBe(true);
    expect(await renewalWorkLeft()).toBe("sync_renewal");
    // Refunded before the retry: the yearly plan is the account's Pro again.
    await refunded("pi_cs_life");
    expect(await renewalWorkLeft()).toBeNull();
    await finishPendingPurchases(NOW + 3600);
    expect(plan.updates).toEqual([]);
    expect(plan.cancel_at_period_end).toBe(false);
    expect((await billingOf(env.DB, "ada")).running.map((purchase) => purchase.id)).toEqual(["cs_year"]);
  });

  it("lets the yearly plan renew again when Pro for life is taken back while the plan is being stopped", async () => {
    await user("ada");
    await hasYearly();
    const plan = yearlyPlan("sub_9");
    plan.during = () => refunded("pi_cs_life");
    expect(await fulfilCheckout(lifetime("cs_life"), NOW)).toBe(true);
    expect(plan.updates).toEqual(["true", "false"]);
    expect(plan).toMatchObject({ cancel_at_period_end: false, metadata: {} });
    expect(await renewalWorkLeft()).toBeNull();
  });

  it("keeps the yearly plan stopped when Pro for life is bought again while it was being let renew", async () => {
    await user("ada");
    await hasYearly();
    const plan = yearlyPlan("sub_9");
    expect(await fulfilCheckout(lifetime("cs_life"), NOW)).toBe(true);
    // The first is refunded; while the plan is being let renew, Pro for life is bought again.
    plan.during = async () => {
      expect(await fulfilCheckout(lifetime("cs_again"), NOW)).toBe(true);
    };
    await refunded("pi_cs_life");
    expect(plan.updates).toEqual(["true", "false", "true"]);
    expect(plan).toMatchObject({ cancel_at_period_end: true, metadata: { stopped_for: "pro_life" } });
    expect(await renewalWorkLeft()).toBeNull();
  });

  it("lets the yearly plan renew once every Pro for life is taken back, whichever stopped it", async () => {
    await user("ada");
    await hasYearly();
    const plan = yearlyPlan("sub_9");
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await fulfilCheckout(lifetime("cs_life"), NOW)).toBe(true);
    // Refunded, but Stripe fails letting the plan renew; then Pro for life is bought again.
    plan.fail = true;
    await refunded("pi_cs_life");
    expect(await fulfilCheckout(lifetime("cs_again"), NOW)).toBe(true);
    await finishPendingPurchases(NOW + 3600);
    expect(plan.cancel_at_period_end).toBe(true);
    // That one taken back too: the plan renews.
    await refunded("pi_cs_again");
    expect(plan).toMatchObject({ cancel_at_period_end: false, metadata: {} });
    expect(await renewalWorkLeft()).toBeNull();
  });

  it("holds work from when the hourly run takes it, however long the run has been going", async () => {
    await user("ada");
    await hasYearly();
    const plan = yearlyPlan("sub_9");
    // Pro for life, whose stopping of the yearly plan was left for the hourly run.
    await env.DB.prepare(`INSERT INTO purchases (id, user_id, product, payment_intent_id, created_at) VALUES ('cs_life', 'ada', 'pro_life', 'pi_cs_life', ?1)`)
      .bind(NOW)
      .run();
    await env.DB.prepare(`UPDATE purchases SET pending = 'sync_renewal', pending_rev = 1 WHERE id = 'cs_year'`).run();
    // The run began ten minutes ago; Pro for life is refunded while it stops the plan.
    plan.during = () => refunded("pi_cs_life");
    await finishPendingPurchases(NOW - 600);
    expect(plan.updates).toEqual(["true", "false"]);
    expect(plan).toMatchObject({ cancel_at_period_end: false, metadata: {} });
  });

  it("leaves a yearly plan its owner stopped as it is, through Pro for life and its refund", async () => {
    await user("ada");
    await hasYearly();
    const plan = yearlyPlan("sub_9", { cancel_at_period_end: true });
    expect(await fulfilCheckout(lifetime("cs_life"), NOW)).toBe(true);
    await refunded("pi_cs_life");
    expect(plan.updates).toEqual([]);
    expect(plan.cancel_at_period_end).toBe(true);
    expect(await renewalWorkLeft()).toBeNull();
  });

  it("never lets a change to the yearly plan whose answer was lost undo a later one", async () => {
    await user("ada");
    await hasYearly();
    const plan = yearlyPlan("sub_9");
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await fulfilCheckout(lifetime("cs_life"), NOW)).toBe(true);
    // Refunded: letting the plan renew is sent, but its answer is lost, and Stripe makes it only later.
    plan.lose = true;
    await refunded("pi_cs_life");
    expect(plan.cancel_at_period_end).toBe(true);
    // Pro for life is bought again meanwhile: stopping the plan waits for Stripe to answer for that change.
    expect(await fulfilCheckout(lifetime("cs_again"), NOW)).toBe(true);
    expect(await renewalWorkLeft()).toBe("sync_renewal");
    plan.land!();
    expect(plan.cancel_at_period_end).toBe(false);
    await finishPendingPurchases(NOW + 3600);
    expect(plan.updates).toEqual(["true", "false", "true"]);
    expect(plan).toMatchObject({ cancel_at_period_end: true, metadata: { stopped_for: "pro_life" } });
    expect(await renewalWorkLeft()).toBeNull();
  });

  it("sets a yearly plan's renewal again whenever Stripe tells of one at odds with Pro for life", async () => {
    await user("ada");
    await hasYearly();
    await env.DB.prepare(`INSERT INTO purchases (id, user_id, product, payment_intent_id, created_at) VALUES ('cs_life', 'ada', 'pro_life', 'pi_cs_life', ?1)`)
      .bind(NOW)
      .run();
    const plan = yearlyPlan("sub_9");
    await subscriptionUpdated("sub_9");
    expect(plan).toMatchObject({ cancel_at_period_end: true, metadata: { stopped_for: "pro_life" } });
    // Told of it again, now stopped: nothing more is changed.
    await subscriptionUpdated("sub_9");
    expect(plan.updates).toEqual(["true"]);
    expect(await renewalWorkLeft()).toBeNull();
  });

  it("stops a lapsed yearly plan renewing once Pro for life is bought, in case it is paid after all", async () => {
    await user("ada");
    // Its renewal went unpaid past the grace: no longer the account's plan, but Stripe still tries.
    await env.DB.prepare(`INSERT INTO purchases (id, user_id, product, subscription_id, created_at, ends_at) VALUES ('cs_year', 'ada', 'pro_year', 'sub_9', ?1, ?2)`)
      .bind(NOW - YEAR, NOW - 3600)
      .run();
    const plan = yearlyPlan("sub_9", { status: "past_due" });
    expect(await fulfilCheckout(lifetime("cs_life"), NOW)).toBe(true);
    expect(plan).toMatchObject({ cancel_at_period_end: true, metadata: { stopped_for: "pro_life" } });
    // Paid after all: it runs to the end of the year paid for, and stops there.
    plan.status = "active";
    await subscriptionUpdated("sub_9");
    expect(plan.updates).toEqual(["true"]);
    expect(await renewalWorkLeft()).toBeNull();
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
    expect(siteExtras((await siteByHandle(env.DB, "adapage"))!, true)).toEqual({
      pixels: { google: "G-ABC1234", tiktok: "C4ABCDEFGHIJ" },
      branding: false,
      headers: { "X-Page-Pixels": "google tiktok" },
    });
    // Removing one merges into the rest.
    await api(token, "PATCH", "sites/adapage", { pixels: { tiktok: "" } });
    expect((await siteByHandle(env.DB, "adapage"))!.pixels).toEqual({ google: "G-ABC1234" });

    await env.DB.prepare(`UPDATE purchases SET ends_at = ?1`).bind(NOW - 1).run();
    expect(siteExtras((await siteByHandle(env.DB, "adapage"))!, true)).toEqual({ pixels: null, branding: true, headers: {} });
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

  /** Runs a test with Cloudflare for SaaS set up, its API answered by `cloudflareApi`. */
  async function withSaas(cloudflareApi: Outbound, test: () => Promise<void>) {
    const saved = { zone: env.CF_ZONE_ID, token: env.CF_API_TOKEN };
    Object.assign(env, { CF_ZONE_ID: "zone1", CF_API_TOKEN: "token1" });
    outbound.push((url, init) => (url.hostname === "api.cloudflare.com" ? cloudflareApi(url, init) : null));
    try {
      await test();
    } finally {
      Object.assign(env, { CF_ZONE_ID: saved.zone, CF_API_TOKEN: saved.token });
    }
  }
  const hostnameAnswer = (id: string) => Response.json({ success: true, result: { id, status: "pending", ssl: { status: "pending_validation" } } });
  const deletedAtCloudflare = () => sent.filter((call) => call.method === "DELETE" && call.url.includes("/custom_hostnames/")).map((call) => call.url.split("/").pop());

  it("delete a hostname made while its domain was disconnected, unless a new claim holds it", async () => {
    const token = await user("ada");
    await api(token, "POST", "sites", { handle: "adapage", published: true });
    await grant("ada", "domains");
    const siteId = (await siteByHandle(env.DB, "adapage"))!.id;
    dns["ada-lovelace.com"] = godaddy;
    dns["www.ada-lovelace.com"] = {};
    let duringCreate = async () => {};
    await withSaas(
      async (_url, init) => {
        if (init.method === "POST") await duringCreate();
        return hostnameAnswer("ch_1");
      },
      async () => {
        const point = async () => {
          const claimed = await answer<{ domain: { records: Array<{ value: string }> } }>(
            api(token, "PUT", "sites/adapage/domain", { hostname: "www.ada-lovelace.com" }),
          );
          dns["www.ada-lovelace.com"] = { CNAME: [`${claimed.body.domain.records[0]!.value}.`] };
          return (await domainOf(env.DB, siteId))!;
        };
        // The owner disconnects while Cloudflare is making the hostname.
        const first = await point();
        duringCreate = async () => {
          expect((await api(token, "DELETE", "sites/adapage/domain")).status).toBe(200);
        };
        await checkDomain(first, NOW, true, true);
        expect(await domainOf(env.DB, siteId)).toBeNull();
        expect(deletedAtCloudflare()).toEqual(["ch_1"]);

        // Disconnected and connected again: the new claim already holds the
        // same name's hostname, so the old check leaves it.
        sent.length = 0;
        dns["www.ada-lovelace.com"] = {};
        const second = await point();
        duringCreate = async () => {
          await api(token, "DELETE", "sites/adapage/domain");
          await point();
          await env.DB.prepare(`UPDATE domains SET cf_id = 'ch_1' WHERE site_id = ?1`).bind(siteId).run();
        };
        await checkDomain(second, NOW, true, true);
        expect(deletedAtCloudflare()).toEqual([]);
        expect((await domainOf(env.DB, siteId))!.cfId).toBe("ch_1");
      },
    );
  });

  it("delete the hostname of a claim replaced while a check made it, at once or in the hourly run", async () => {
    const token = await user("ada");
    await api(token, "POST", "sites", { handle: "adapage", published: true });
    await grant("ada", "domains");
    const siteId = (await siteByHandle(env.DB, "adapage"))!.id;
    dns["ada-lovelace.com"] = godaddy;
    dns["www.ada-lovelace.com"] = {};
    dns["ada-byron.com"] = godaddy;
    dns["www.ada-byron.com"] = {};
    let cloudflareDown = false;
    // Each hostname Cloudflare makes has its own ID.
    let made = "ch_old";
    await withSaas(
      (_url, init) =>
        init.method === "DELETE" && cloudflareDown ? Response.json({ success: false, errors: [{ code: 1000, message: "down" }] }, { status: 500 }) : hostnameAnswer(made),
      async () => {
        const replace = async (from: string, to: string) => {
          await api(token, "PUT", "sites/adapage/domain", { hostname: from });
          // While the new name's DNS is looked up, a check of the old claim makes and saves its hostname.
          onLookup = async (name) => {
            if (name !== to) return;
            onLookup = null;
            await env.DB.prepare(`UPDATE domains SET cf_id = ?2 WHERE site_id = ?1`).bind(siteId, made).run();
          };
          expect((await api(token, "PUT", "sites/adapage/domain", { hostname: to })).status).toBe(200);
          expect((await domainOf(env.DB, siteId))!).toMatchObject({ hostname: to, cfId: null });
        };
        await replace("www.ada-lovelace.com", "www.ada-byron.com");
        expect(deletedAtCloudflare()).toEqual(["ch_old"]);
        expect(await env.DB.prepare(`SELECT count(*) AS left FROM stale_hostnames WHERE deleted_at IS NULL`).first("left")).toBe(0);

        // Cloudflare cannot delete it now: it stays listed until the hourly run can.
        sent.length = 0;
        cloudflareDown = true;
        made = "ch_old2";
        vi.spyOn(console, "error").mockImplementation(() => {});
        await replace("www.ada-lovelace.com", "www.ada-byron.com");
        expect(await env.DB.prepare(`SELECT cf_id FROM stale_hostnames WHERE deleted_at IS NULL`).first("cf_id")).toBe("ch_old2");
        cloudflareDown = false;
        await checkDomains(NOW + 3600);
        expect(deletedAtCloudflare()).toEqual(["ch_old2", "ch_old2"]);
        expect(await env.DB.prepare(`SELECT count(*) AS left FROM stale_hostnames WHERE deleted_at IS NULL`).first("left")).toBe(0);
      },
    );
  });

  it("keep a hostname two claims share until the last lets it go", async () => {
    const ada = await user("ada");
    const bob = await user("bob");
    await grant("ada", "domains");
    await grant("bob", "domains");
    await api(ada, "POST", "sites", { handle: "adapage", published: true });
    await api(bob, "POST", "sites", { handle: "bobpage", published: true });
    dns["ada-lovelace.com"] = godaddy;
    dns["www.ada-lovelace.com"] = {};
    await withSaas(
      () => Response.json({ success: true, result: { id: "ch_1" } }),
      async () => {
        await api(ada, "PUT", "sites/adapage/domain", { hostname: "www.ada-lovelace.com" });
        await api(bob, "PUT", "sites/bobpage/domain", { hostname: "www.ada-lovelace.com" });
        // Both waiting claims found Cloudflare's one hostname for the name.
        await env.DB.prepare(`UPDATE domains SET cf_id = 'ch_1'`).run();
        expect((await api(bob, "DELETE", "sites/bobpage/domain")).status).toBe(200);
        expect(deletedAtCloudflare()).toEqual([]);
        expect((await api(ada, "DELETE", "sites/adapage/domain")).status).toBe(200);
        expect(deletedAtCloudflare()).toEqual(["ch_1"]);
      },
    );
  });

  it("keep a shared hostname listed when the last claim lets go while the one before it is cleared", async () => {
    const ada = await user("ada");
    const bob = await user("bob");
    await grant("ada", "domains");
    await grant("bob", "domains");
    await api(ada, "POST", "sites", { handle: "adapage", published: true });
    await api(bob, "POST", "sites", { handle: "bobpage", published: true });
    dns["ada-lovelace.com"] = godaddy;
    dns["www.ada-lovelace.com"] = {};
    let cloudflareDown = false;
    await withSaas(
      (_url, init) =>
        init.method === "DELETE" && cloudflareDown
          ? Response.json({ success: false, errors: [{ code: 1000, message: "down" }] }, { status: 500 })
          : Response.json({ success: true, result: { id: "ch_1" } }),
      async () => {
        await api(ada, "PUT", "sites/adapage/domain", { hostname: "www.ada-lovelace.com" });
        await api(bob, "PUT", "sites/bobpage/domain", { hostname: "www.ada-lovelace.com" });
        await env.DB.prepare(`UPDATE domains SET cf_id = 'ch_1'`).run();
        vi.spyOn(console, "error").mockImplementation(() => {});
        // Bob lets go; Ada's claim holds the hostname, but she lets go too
        // (with Cloudflare down) just before Bob's entry is cleared.
        const prepare = env.DB.prepare.bind(env.DB);
        let meanwhile: (() => Promise<void>) | null = async () => {
          cloudflareDown = true;
          expect((await api(ada, "DELETE", "sites/adapage/domain")).status).toBe(200);
        };
        vi.spyOn(env.DB, "prepare").mockImplementation((query: string) => {
          const statement = prepare(query);
          const before = meanwhile;
          if (!before || !query.startsWith("DELETE FROM stale_hostnames")) return statement;
          meanwhile = null;
          return {
            bind: (...values: unknown[]) => {
              const bound = statement.bind(...values);
              return { run: async () => (await before(), bound.run()) };
            },
          } as unknown as D1PreparedStatement;
        });
        expect((await api(bob, "DELETE", "sites/bobpage/domain")).status).toBe(200);
        expect(await env.DB.prepare(`SELECT cf_id FROM stale_hostnames`).first("cf_id")).toBe("ch_1");
        cloudflareDown = false;
        await checkDomains(NOW + 3600);
        expect(deletedAtCloudflare().at(-1)).toBe("ch_1");
        expect(await env.DB.prepare(`SELECT count(*) AS left FROM stale_hostnames WHERE deleted_at IS NULL`).first("left")).toBe(0);
      },
    );
  });

  it("never take up a hostname Cloudflare is deleting", async () => {
    const ada = await user("ada");
    const bob = await user("bob");
    await grant("ada", "domains");
    await grant("bob", "domains");
    await api(ada, "POST", "sites", { handle: "adapage", published: true });
    await api(bob, "POST", "sites", { handle: "bobpage", published: true });
    const bobSite = (await siteByHandle(env.DB, "bobpage"))!.id;
    dns["ada-lovelace.com"] = godaddy;
    dns["www.ada-lovelace.com"] = {};
    // Cloudflare's custom hostnames, one per name, served at once; a delete takes a moment.
    const hostnames = new Map<string, string>([["ch_1", "www.ada-lovelace.com"]]);
    let next = 2;
    let duringDelete: (() => Promise<void>) | null = null;
    const served = (id: string) => Response.json({ success: true, result: { id, status: "active", ssl: { status: "active" } } });
    await withSaas(
      async (url, init) => {
        const id = url.pathname.split("/custom_hostnames/")[1];
        if (init.method === "DELETE") {
          const during = duringDelete;
          duringDelete = null;
          await during?.();
          hostnames.delete(id!);
          return Response.json({ success: true, result: { id } });
        }
        if (init.method === "POST") {
          const name = (JSON.parse(init.body!) as { hostname: string }).hostname;
          if ([...hostnames.values()].includes(name)) return Response.json({ success: false, errors: [{ code: 1406, message: "Duplicate" }] }, { status: 409 });
          const made = `ch_${next++}`;
          hostnames.set(made, name);
          return served(made);
        }
        const name = url.searchParams.get("hostname");
        if (name) return Response.json({ success: true, result: [...hostnames].filter(([, other]) => other === name).map(([found]) => ({ id: found, status: "active" })) });
        return id && hostnames.has(id) ? served(id) : Response.json({ success: false, errors: [] }, { status: 404 });
      },
      async () => {
        // Ada's claim holds the name's hostname; Bob's waits for the same name.
        await api(ada, "PUT", "sites/adapage/domain", { hostname: "www.ada-lovelace.com" });
        await env.DB.prepare(`UPDATE domains SET cf_id = 'ch_1' WHERE site_id = ?1`).bind((await siteByHandle(env.DB, "adapage"))!.id).run();
        await api(bob, "PUT", "sites/bobpage/domain", { hostname: "www.ada-lovelace.com" });
        const waiting = (await domainOf(env.DB, bobSite))!;
        dns["www.ada-lovelace.com"] = { CNAME: [`${waiting.code}.${env.DOMAIN_TARGET}.`] };
        // Ada disconnects; while Cloudflare deletes her hostname, a check of Bob's claim finds it.
        duringDelete = () => checkDomain(waiting, NOW, true, true);
        expect((await api(ada, "DELETE", "sites/adapage/domain")).status).toBe(200);
        expect(hostnames.has("ch_1")).toBe(false);
        expect(await domainOf(env.DB, bobSite)).toMatchObject({ cfId: null, status: "pending" });
        // The next check makes the name's hostname anew.
        await checkDomain((await domainOf(env.DB, bobSite))!, NOW, true, true);
        expect(await domainOf(env.DB, bobSite)).toMatchObject({ cfId: "ch_2", status: "active" });
      },
    );
  });

  it("keep a hostname listed when the hourly cleanup runs as its claim lets go of it", async () => {
    const token = await user("ada");
    await api(token, "POST", "sites", { handle: "adapage", published: true });
    await grant("ada", "domains");
    const siteId = (await siteByHandle(env.DB, "adapage"))!.id;
    dns["ada-lovelace.com"] = godaddy;
    dns["www.ada-lovelace.com"] = {};
    await withSaas(
      (url) => Response.json({ success: true, result: { id: url.pathname.split("/").pop() } }),
      async () => {
        await api(token, "PUT", "sites/adapage/domain", { hostname: "www.ada-lovelace.com" });
        await env.DB.prepare(`UPDATE domains SET status = 'active', cf_id = 'ch_1', checked_at = ?2 WHERE site_id = ?1`).bind(siteId, NOW).run();
        const record = (await domainOf(env.DB, siteId))!;
        // The plan ended. The hourly cleanup runs as soon as it can once the
        // hostname is put on the list: before the claim is saved, or before
        // the transaction that does both.
        const prepare = env.DB.prepare.bind(env.DB);
        const batch = env.DB.batch.bind(env.DB);
        let listed = false;
        let meanwhile: (() => Promise<void>) | null = () => checkDomains(NOW);
        const cleanup = async () => {
          const before = meanwhile;
          meanwhile = null;
          await before?.();
        };
        vi.spyOn(env.DB, "prepare").mockImplementation((query: string) => {
          if (query.startsWith("INSERT INTO stale_hostnames")) listed = true;
          const statement = prepare(query);
          if (!meanwhile || !listed || !query.startsWith("UPDATE domains SET")) return statement;
          const bind = statement.bind.bind(statement);
          statement.bind = (...values: unknown[]) => {
            const bound = bind(...values);
            const run = bound.run.bind(bound);
            bound.run = async () => (await cleanup(), run()) as never;
            return bound;
          };
          return statement;
        });
        vi.spyOn(env.DB, "batch").mockImplementation(async (statements) => {
          if (listed) await cleanup();
          return batch(statements);
        });
        await checkDomain(record, NOW, false);
        expect(meanwhile).toBeNull();
        expect(await domainOf(env.DB, siteId)).toMatchObject({ cfId: null, status: "pending" });
        expect(deletedAtCloudflare()).toEqual(["ch_1"]);
        expect(await env.DB.prepare(`SELECT count(*) AS left FROM stale_hostnames WHERE deleted_at IS NULL`).first("left")).toBe(0);
      },
    );
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

  it("load the site's pixels at their public address only, and a private link sends no referrer", async () => {
    const token = await user("ada");
    await grant("ada", "pro_life");
    await api(token, "POST", "sites", { handle: "adapage", title: "Ada", published: true, pixels: { google: "G-ABC1234" } });
    await api(token, "PATCH", "sites/adapage", { pixels: { google: "G-ABC1234" } });
    const made = await answer<{ page: Sub }>(api(token, "POST", "sites/adapage/pages", { title: "Notes", path: "notes" }));
    const privateId = made.body.page.private_url.split("/").pop()!;
    const view = async (segment: string) => {
      const result = (await subpageLoader({
        params: { handle: "adapage", sub: segment },
        url: new URL(`${ORIGIN}/adapage/${segment}`),
        context: {},
      } as never)) as unknown as { data: { pixels: unknown }; init: { headers?: Record<string, string> } };
      const headers = result.init.headers ?? {};
      return { pixels: result.data.pixels, header: headers["X-Page-Pixels"] ?? null, referrer: headers["Referrer-Policy"] ?? null };
    };
    expect(await view("notes")).toEqual({ pixels: { google: "G-ABC1234" }, header: "google", referrer: null });
    // Nor does a private link's address travel on as the referrer.
    expect(await view(privateId)).toEqual({ pixels: null, header: null, referrer: "no-referrer" });
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
