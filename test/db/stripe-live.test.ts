import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";

import { stripe } from "../../app/lib/billing/stripe.server";
import { billingPortal, type CheckoutSession, fulfilCheckout, startCheckout } from "../../app/lib/billing.server";
import type { Account } from "../../app/lib/db/accounts.server";
import { PRODUCT_IDS, PRODUCTS } from "../../app/lib/plans";

/**
 * Against Stripe's test mode, when a test key is given for the run
 * (NEAT_STRIPE_TEST_KEY=sk_test_… npx vitest run stripe-live), after
 * `npm run stripe:setup -- staging` made the prices: Stripe accepts every
 * Checkout Session and portal session the Worker asks for, and the calls
 * that fulfil a paid one work on real payments (made with test cards, as a
 * paid Checkout would). Sessions are expired and customers deleted at the end.
 */
const live = !env.STRIPE_SECRET_KEY.includes("not_a_real_key");

describe.skipIf(!live)("Stripe test mode", () => {
  const account: Account = { id: "stripe-live-test", name: "Live Test", email: "live-test@example.com", image: null, google: true, telegram: null };

  beforeAll(async () => {
    await env.DB.prepare(`INSERT OR IGNORE INTO "user" VALUES (?1, ?2, ?3, 1, NULL, '2026-01-01', '2026-01-01')`)
      .bind(account.id, account.name, account.email)
      .run();
  });

  it("accepts a checkout for every product, with VAT, invoices and the price before VAT", async () => {
    await env.DB.prepare(`DELETE FROM purchases WHERE user_id = ?1`).bind(account.id).run();
    for (const product of PRODUCT_IDS) {
      const { url } = await startCheckout(account, product, "https://neat-link-staging.borkasm.workers.dev");
      expect(url).toMatch(/^https:\/\/checkout\.stripe\.com\//);
      const id = /\/(cs_test_[A-Za-z0-9]+)/.exec(url)?.[1];
      expect(id).toBeTruthy();
      const session = await stripe<CheckoutSession & { automatic_tax: { enabled: boolean }; amount_subtotal: number; line_items?: unknown }>(
        "GET",
        `checkout/sessions/${id}`,
      );
      expect(session).toMatchObject({ client_reference_id: account.id, metadata: { product }, automatic_tax: { enabled: true } });
      expect(session.mode).toBe(PRODUCTS[product].interval === "year" ? "subscription" : "payment");
      expect(session.amount_subtotal).toBe(PRODUCTS[product].amount);
      await stripe("POST", `checkout/sessions/${id}/expire`);
    }
  });

  it("opens the billing portal for a customer", async () => {
    const customer = await stripe<{ id: string }>("POST", "customers", { email: account.email, metadata: { test: "neat stripe-live" } });
    try {
      await env.DB.prepare(`INSERT INTO purchases (id, user_id, product, customer_id, created_at) VALUES ('grant_live', ?1, 'domains', ?2, unixepoch())`)
        .bind(account.id, customer.id)
        .run();
      const { url } = await billingPortal(account, "https://neat-link-staging.borkasm.workers.dev");
      expect(url).toMatch(/^https:\/\/billing\.stripe\.com\//);
    } finally {
      await stripe("DELETE", `customers/${customer.id}`);
    }
  });

  const now = () => Math.floor(Date.now() / 1000);
  const paidSession = (id: string, product: string, extra: Partial<CheckoutSession>): CheckoutSession => ({
    id,
    mode: "payment",
    payment_status: "paid",
    client_reference_id: account.id,
    metadata: { product },
    customer: null,
    subscription: null,
    payment_intent: null,
    amount_total: 1000,
    currency: "usd",
    ...extra,
  });
  const pay = (paymentMethod: string) =>
    stripe<{ id: string; status: string }>("POST", "payment_intents", {
      amount: 1000,
      currency: "usd",
      payment_method: paymentMethod,
      confirm: true,
      automatic_payment_methods: { enabled: true, allow_redirects: "never" },
      metadata: { test: "neat stripe-live" },
    });
  const purchase = (id: string) => env.DB.prepare(`SELECT refunded_at, pending FROM purchases WHERE id = ?1`).bind(id).first();

  it("records one-time payments, and those already refunded or lost to a chargeback as taken back", async () => {
    await env.DB.prepare(`DELETE FROM purchases WHERE user_id = ?1`).bind(account.id).run();
    const paid = await pay("pm_card_visa");
    expect(paid.status).toBe("succeeded");
    const tag = Date.now().toString(36);
    expect(await fulfilCheckout(paidSession(`cs_live_paid_${tag}`, "domains", { payment_intent: paid.id }), now())).toBe(true);

    const refunded = await pay("pm_card_visa");
    await stripe("POST", "refunds", { payment_intent: refunded.id });
    expect(await fulfilCheckout(paidSession(`cs_live_refunded_${tag}`, "pro_life", { payment_intent: refunded.id }), now())).toBe(false);
    expect(await purchase(`cs_live_refunded_${tag}`)).toMatchObject({ refunded_at: expect.any(Number), pending: null });

    // A test card that is disputed at once; losing evidence loses it.
    const disputed = await pay("pm_card_createDispute");
    let dispute: { id: string; status: string } | undefined;
    for (let tries = 0; tries < 30 && !dispute; tries++) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      dispute = (await stripe<{ data: Array<{ id: string; status: string }> }>("GET", "disputes", { payment_intent: disputed.id })).data[0];
    }
    expect(dispute).toBeTruthy();
    await stripe("POST", `disputes/${dispute!.id}`, { evidence: { uncategorized_text: "losing_evidence" }, submit: true });
    for (let tries = 0; tries < 30 && dispute!.status !== "lost"; tries++) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      dispute = await stripe<{ id: string; status: string }>("GET", `disputes/${dispute!.id}`);
    }
    expect(dispute!.status).toBe("lost");
    expect(await fulfilCheckout(paidSession(`cs_live_lost_${tag}`, "pro_life", { payment_intent: disputed.id }), now())).toBe(false);
    expect(await purchase(`cs_live_lost_${tag}`)).toMatchObject({ refunded_at: expect.any(Number) });
  }, 90_000);

  it("cancels and refunds a yearly plan paid for an account that already has Pro, once", async () => {
    await env.DB.prepare(`DELETE FROM purchases WHERE user_id = ?1`).bind(account.id).run();
    await env.DB.prepare(`INSERT INTO purchases (id, user_id, product, created_at) VALUES ('grant_live_life', ?1, 'pro_life', unixepoch())`)
      .bind(account.id)
      .run();
    const customer = await stripe<{ id: string }>("POST", "customers", {
      email: account.email,
      payment_method: "pm_card_visa",
      invoice_settings: { default_payment_method: "pm_card_visa" },
      metadata: { test: "neat stripe-live" },
    });
    try {
      // The customer's copy of the card, which the subscription charges.
      const card = (await stripe<{ data: Array<{ id: string }> }>("GET", `customers/${customer.id}/payment_methods`)).data[0]!;
      const price = (await stripe<{ data: Array<{ id: string }> }>("GET", "prices", { lookup_keys: [PRODUCTS.pro_year.lookupKey], active: true })).data[0]!;
      const subscription = await stripe<{ id: string; status: string }>("POST", "subscriptions", {
        customer: customer.id,
        items: [{ price: price.id }],
        default_payment_method: card.id,
        metadata: { test: "neat stripe-live" },
      });
      expect(subscription.status).toBe("active");
      const id = `cs_live_dup_${Date.now().toString(36)}`;
      const session = paidSession(id, "pro_year", { mode: "subscription", customer: customer.id, subscription: subscription.id });
      expect(await fulfilCheckout(session, now())).toBe(false);
      expect(await purchase(id)).toMatchObject({ refunded_at: expect.any(Number), pending: null });
      expect((await stripe<{ status: string }>("GET", `subscriptions/${subscription.id}`)).status).toBe("canceled");
      const charges = await stripe<{ data: Array<{ refunded: boolean; payment_intent: string }> }>("GET", "charges", { customer: customer.id });
      expect(charges.data.map((charge) => charge.refunded)).toEqual([true]);
      // Asked again with the work left pending (as after a failure half way): nothing is done twice.
      await env.DB.prepare(`UPDATE purchases SET pending = 'refund' WHERE id = ?1`).bind(id).run();
      await fulfilCheckout(session, now());
      expect(await purchase(id)).toMatchObject({ pending: null });
      const refunds = await stripe<{ data: unknown[] }>("GET", "refunds", { payment_intent: charges.data[0]!.payment_intent });
      expect(refunds.data).toHaveLength(1);
    } finally {
      await stripe("DELETE", `customers/${customer.id}`);
    }
  }, 60_000);
});
