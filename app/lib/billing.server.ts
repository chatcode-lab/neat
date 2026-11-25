import { env } from "cloudflare:workers";

import { StripeError, stripe, stripeConfigured } from "./billing/stripe.server";
import type { Account } from "./db/accounts.server";
import {
  type Billing,
  billingOf,
  finishCheckout,
  markRefunded,
  purchaseExists,
  recordPurchase,
  replaceCheckout,
  runningSubscriptions,
  setSubscriptionEnd,
} from "./db/billing.server";
import { mediaUsage } from "./db/media.server";
import { siteCounts } from "./db/sites.server";
import {
  allows,
  canBuy,
  type Feature,
  isProduct,
  MAX_FILE_BYTES,
  MEDIA_QUOTA_BYTES,
  type Plan,
  PLAN_LIMITS,
  PLAN_NAMES,
  planRequiredMessage,
  type Product,
  PRODUCT_IDS,
  PRODUCTS,
} from "./plans";
import { Refusal } from "./refusal";

/** Days a yearly plan keeps running past its paid year, while Stripe takes the renewal. */
const RENEWAL_GRACE_SECONDS = 3 * 24 * 3600;

export async function accountPlan(account: Pick<Account, "id">): Promise<Billing> {
  return billingOf(env.DB, account.id);
}

/** Refuses, with a 402 and where to pay, unless the account's plan has this feature. */
export async function requireFeature(account: Pick<Account, "id">, feature: Feature, origin: string): Promise<Plan> {
  const { plan } = await accountPlan(account);
  if (!allows(plan, feature)) {
    throw new Refusal(
      402,
      "plan_required",
      `${planRequiredMessage(feature)} Buy it at ${origin}/app/plan, or ask for a payment link with POST ${origin}/api/v1/checkout.`,
    );
  }
  return plan;
}

const iso = (seconds: number | null) => (seconds === null ? null : new Date(seconds * 1000).toISOString());

/** An account's plan as the API and MCP describe it: what it has, uses, and could buy. */
export async function planJson(account: Pick<Account, "id">) {
  const [billing, counts, media] = await Promise.all([
    accountPlan(account),
    siteCounts(env.DB, account.id),
    mediaUsage(env.DB, account.id),
  ]);
  const limits = PLAN_LIMITS[billing.plan];
  const owned = billing.running.map((purchase) => purchase.product);
  return {
    plan: billing.plan,
    name: PLAN_NAMES[billing.plan],
    purchases: billing.running.map((purchase) => ({
      product: purchase.product,
      name: PRODUCTS[purchase.product].name,
      bought_at: iso(purchase.createdAt),
      // A yearly plan's end moves on at each renewal; null lasts.
      runs_until: iso(purchase.endsAt),
      renews: purchase.subscriptionId !== null,
    })),
    features: {
      domains: allows(billing.plan, "domains"),
      pixels: allows(billing.plan, "pixels"),
      hide_branding: allows(billing.plan, "branding"),
      subpages: allows(billing.plan, "subpages"),
      media: allows(billing.plan, "media"),
    },
    limits: {
      published_sites: limits.published,
      sites: limits.sites,
      media_bytes: allows(billing.plan, "media") ? MEDIA_QUOTA_BYTES : 0,
      file_bytes: MAX_FILE_BYTES,
    },
    usage: { published_sites: counts.published, sites: counts.sites, media_bytes: media.bytes, files: media.files },
    products: PRODUCT_IDS.map((product) => ({
      product,
      name: PRODUCTS[product].name,
      price_usd: PRODUCTS[product].amount / 100,
      interval: PRODUCTS[product].interval,
      vat: "added at checkout where it applies",
      summary: PRODUCTS[product].summary,
      available: canBuy(product, owned),
    })),
    billing_portal: billing.customerId !== null,
  };
}

interface Price {
  id: string;
}

/** The Stripe price for a product, found by its lookup key (made by scripts/stripe-setup.ts). */
async function priceFor(product: Product): Promise<Price> {
  const { data } = await stripe<{ data: Price[] }>("GET", "prices", {
    lookup_keys: [PRODUCTS[product].lookupKey],
    active: true,
    limit: 1,
  });
  const found = data[0];
  if (!found) throw new Refusal(503, "billing_unavailable", "Payments are not set up yet. Try again later.");
  return found;
}

function unavailable(error: unknown): never {
  if (error instanceof StripeError) {
    console.error("stripe", error.status, error.code, error.message);
    throw new Refusal(503, "billing_unavailable", "Payments could not be reached. Try again in a minute.");
  }
  throw error;
}

/**
 * Starts a payment: a Stripe Checkout page for one product, for this
 * account, whose address the owner opens to pay. VAT is worked out there
 * from where they are; businesses can give a VAT number. The account gets
 * what it paid for when Stripe tells of the payment, or when the owner is
 * sent back to the plan page, whichever comes first.
 */
export async function startCheckout(account: Account, product: unknown, origin: string): Promise<{ url: string; product: Product }> {
  if (!isProduct(product)) {
    throw new Refusal(400, "invalid_product", `product must be one of ${PRODUCT_IDS.join(", ")}.`);
  }
  if (!stripeConfigured()) throw new Refusal(503, "billing_unavailable", "Payments are not set up here.");
  const billing = await accountPlan(account);
  if (!canBuy(product, billing.running.map((purchase) => purchase.product))) {
    throw new Refusal(409, "already_bought", "The account already has everything this would add.");
  }
  const info = PRODUCTS[product];
  const yearly = info.interval === "year";
  const metadata = { user_id: account.id, product };
  try {
    const price = await priceFor(product);
    const session = await stripe<{ id: string; url: string }>("POST", "checkout/sessions", {
      mode: yearly ? "subscription" : "payment",
      line_items: [{ price: price.id, quantity: 1 }],
      client_reference_id: account.id,
      metadata,
      success_url: `${origin}/app/plan?paid={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/app/plan`,
      automatic_tax: { enabled: true },
      tax_id_collection: { enabled: true },
      allow_promotion_codes: true,
      custom_text: {
        submit: {
          message: `${info.name} for the neat.link account of ${[...account.name].slice(0, 60).join("")}. VAT is added where it applies. By paying you accept the terms at ${origin}/terms.`,
        },
      },
      ...(billing.customerId
        ? { customer: billing.customerId, customer_update: { address: "auto", name: "auto" } }
        : { customer_email: account.email ?? undefined }),
      ...(yearly
        ? { subscription_data: { metadata } }
        : {
            ...(billing.customerId ? {} : { customer_creation: "always" }),
            invoice_creation: { enabled: true, invoice_data: { metadata } },
            payment_intent_data: { metadata },
          }),
    });
    // One open payment link per account: the one before stops working, so
    // two links opened by mistake cannot both be paid.
    const previous = await replaceCheckout(env.DB, account.id, session.id, Math.floor(Date.now() / 1000));
    if (previous) await stripe("POST", `checkout/sessions/${encodeURIComponent(previous)}/expire`).catch(() => undefined);
    return { url: session.url, product };
  } catch (error) {
    return unavailable(error);
  }
}

/** Stripe's billing portal for the account: its invoices, card, and the yearly plan's cancellation. */
export async function billingPortal(account: Account, origin: string): Promise<{ url: string }> {
  const { customerId } = await accountPlan(account);
  if (!customerId) throw new Refusal(404, "no_billing", "There is nothing to manage: the account has not paid for anything.");
  try {
    return await stripe<{ url: string }>("POST", "billing_portal/sessions", { customer: customerId, return_url: `${origin}/app/plan` });
  } catch (error) {
    return unavailable(error);
  }
}

interface Subscription {
  id: string;
  status: string;
  cancel_at_period_end?: boolean;
  ended_at?: number | null;
  current_period_start?: number;
  current_period_end?: number;
  latest_invoice?: string | null;
  items?: { data?: Array<{ current_period_start?: number; current_period_end?: number }> };
}

/**
 * When a subscription stops giving its features: the end of its paid
 * period and a grace; for one whose renewal is not paid yet, the grace from
 * when the unpaid period began (Stripe moves the period on before it
 * charges); for one that ended, when it ended.
 */
export function subscriptionEnd(subscription: Subscription, now: number): number {
  const item = subscription.items?.data?.[0];
  const periodEnd = item?.current_period_end ?? subscription.current_period_end ?? now;
  const periodStart = item?.current_period_start ?? subscription.current_period_start ?? now;
  if (subscription.status === "past_due") return periodStart + RENEWAL_GRACE_SECONDS;
  if (subscription.status === "active" || subscription.status === "trialing") {
    return subscription.cancel_at_period_end ? periodEnd : periodEnd + RENEWAL_GRACE_SECONDS;
  }
  return Math.min(subscription.ended_at ?? now, now);
}

export interface CheckoutSession {
  id: string;
  mode: string;
  status?: string;
  payment_status: string;
  client_reference_id: string | null;
  metadata?: Record<string, string> | null;
  customer: string | null;
  subscription: string | null;
  payment_intent: string | null;
  amount_total: number | null;
  currency: string | null;
}

const path = encodeURIComponent;

/** Whether a one-time payment was taken back: refunded in full, or a chargeback the account lost. */
async function paymentTakenBack(paymentIntent: string): Promise<boolean> {
  const intent = await stripe<{ latest_charge?: { refunded?: boolean; disputed?: boolean; dispute?: { status?: string } | null } | null }>(
    "GET",
    `payment_intents/${path(paymentIntent)}`,
    { expand: ["latest_charge.dispute"] },
  );
  const charge = intent.latest_charge;
  return Boolean(charge && (charge.refunded || charge.dispute?.status === "lost"));
}

/** Gives back a payment for something the account already had, and stops a duplicate subscription. */
async function refundDuplicate(session: CheckoutSession, subscription: Subscription | null): Promise<void> {
  let paymentIntent = session.payment_intent;
  if (subscription) {
    await stripe("DELETE", `subscriptions/${path(subscription.id)}`);
    if (subscription.latest_invoice) {
      const invoice = await stripe<{ payments?: { data?: Array<{ payment?: { payment_intent?: string } }> } }>(
        "GET",
        `invoices/${path(subscription.latest_invoice)}`,
        { expand: ["payments"] },
      );
      paymentIntent = invoice.payments?.data?.[0]?.payment?.payment_intent ?? null;
    }
  }
  if (paymentIntent) {
    await stripe("POST", "refunds", { payment_intent: paymentIntent, reason: "duplicate", metadata: { checkout_session: session.id } }, {
      idempotencyKey: `refund-duplicate-${session.id}`,
    });
  } else console.error("duplicate purchase without a payment to refund", session.id);
}

/**
 * Gives an account what a paid Checkout Session bought, once, however many
 * times it is told. A payment already taken back is recorded as such; one
 * for something the account already has (two links paid) is refunded at
 * once. Buying Pro for life stops the yearly plan from renewing. True when
 * this gave something.
 */
export async function fulfilCheckout(session: CheckoutSession, now: number): Promise<boolean> {
  if (session.payment_status !== "paid" && session.payment_status !== "no_payment_required") return false;
  const userId = session.client_reference_id ?? session.metadata?.user_id;
  const product = session.metadata?.product;
  if (!userId || !isProduct(product)) return false;
  const exists = await env.DB.prepare(`SELECT 1 FROM "user" WHERE id = ?1`).bind(userId).first();
  if (!exists) return false;
  await finishCheckout(env.DB, session.id);
  const stopping = product === "pro_life" ? await runningSubscriptions(env.DB, userId) : [];
  const stopYearly = async () => {
    // Asked again on every delivery, in case an earlier one failed half way; it changes nothing twice.
    for (const subscription of stopping) {
      await stripe("POST", `subscriptions/${path(subscription)}`, { cancel_at_period_end: true });
    }
  };
  if (await purchaseExists(env.DB, session.id)) {
    await stopYearly();
    return false;
  }
  const subscription = session.subscription ? await stripe<Subscription>("GET", `subscriptions/${path(session.subscription)}`) : null;
  const endsAt = subscription ? subscriptionEnd(subscription, now) : null;
  const running = (await billingOf(env.DB, userId)).running.map((purchase) => purchase.product);
  const duplicate = !canBuy(product, running);
  if (duplicate) await refundDuplicate(session, subscription);
  const takenBack = !duplicate && session.payment_intent ? await paymentTakenBack(session.payment_intent) : false;
  const added = await recordPurchase(env.DB, {
    id: session.id,
    userId,
    product,
    customerId: session.customer,
    subscriptionId: session.subscription,
    paymentIntentId: session.payment_intent,
    amount: session.amount_total ?? 0,
    currency: session.currency ?? "usd",
    endsAt,
    refundedAt: duplicate || takenBack ? now : null,
    now,
  });
  if (duplicate || takenBack) return false;
  await stopYearly();
  return added;
}

/**
 * The owner is back from Checkout: their payment is looked up at Stripe and
 * given at once, without waiting for the webhook. Only their own session
 * counts.
 */
export async function confirmCheckout(account: Account, sessionId: string, now: number): Promise<"paid" | "pending" | "unknown"> {
  if (!/^cs_[A-Za-z0-9_]{10,200}$/.test(sessionId) || !stripeConfigured()) return "unknown";
  try {
    const session = await stripe<CheckoutSession>("GET", `checkout/sessions/${sessionId}`);
    if ((session.client_reference_id ?? session.metadata?.user_id) !== account.id) return "unknown";
    if (session.payment_status === "unpaid") return "pending";
    await fulfilCheckout(session, now);
    return "paid";
  } catch (error) {
    console.error("checkout confirmation", error);
    return "unknown";
  }
}

export interface StripeEvent {
  id: string;
  type: string;
  data: { object: Record<string, unknown> };
}

/**
 * What a webhook from Stripe changes. A subscription's state is read again
 * from Stripe, so events arriving out of order still leave the latest.
 */
export async function handleStripeEvent(event: StripeEvent, now: number): Promise<void> {
  const object = event.data.object;
  switch (event.type) {
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded":
      await fulfilCheckout(object as unknown as CheckoutSession, now);
      return;
    case "customer.subscription.updated":
    case "customer.subscription.deleted": {
      const id = String(object.id ?? "");
      const subscription = await stripe<Subscription>("GET", `subscriptions/${encodeURIComponent(id)}`);
      await setSubscriptionEnd(env.DB, subscription.id, subscriptionEnd(subscription, now));
      return;
    }
    case "charge.refunded": {
      const paymentIntent = object.payment_intent;
      if (object.refunded === true && typeof paymentIntent === "string") await markRefunded(env.DB, paymentIntent, now);
      return;
    }
    // A chargeback the account lost takes the money back as a refund does.
    case "charge.dispute.closed": {
      const paymentIntent = object.payment_intent;
      if (object.status === "lost" && typeof paymentIntent === "string") await markRefunded(env.DB, paymentIntent, now);
      return;
    }
  }
}
