import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";

import { stripe } from "../../app/lib/billing/stripe.server";
import { billingPortal, type CheckoutSession, startCheckout } from "../../app/lib/billing.server";
import type { Account } from "../../app/lib/db/accounts.server";
import { PRODUCT_IDS, PRODUCTS } from "../../app/lib/plans";

/**
 * Against Stripe's test mode, when a test key is given for the run
 * (NEAT_STRIPE_TEST_KEY=sk_test_… npx vitest run stripe-live), after
 * `npm run stripe:setup -- staging` made the prices: Stripe accepts every
 * Checkout Session and portal session the Worker asks for. The sessions are
 * expired again at the end.
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
});
