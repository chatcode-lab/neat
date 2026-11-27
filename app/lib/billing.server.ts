import { env } from "cloudflare:workers";

import { StripeError, stripe, stripeConfigured } from "./billing/stripe.server";
import type { Account } from "./db/accounts.server";
import {
  type Billing,
  billingOf,
  claimPurchase,
  endPending,
  finishCheckout,
  markRefunded,
  type PendingWork,
  purchaseExists,
  renewalWork,
  replaceCheckout,
  setSubscriptionEnd,
  takePending,
  unfinishedPurchases,
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
  metadata?: Record<string, string> | null;
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

/**
 * Whether a one-time payment was taken back: refunded in full, or a
 * chargeback the account lost. A charge only says it was disputed; the
 * dispute's outcome is asked for apart.
 */
async function paymentTakenBack(paymentIntent: string): Promise<boolean> {
  const intent = await stripe<{ latest_charge?: { refunded?: boolean; disputed?: boolean } | null }>(
    "GET",
    `payment_intents/${path(paymentIntent)}`,
    { expand: ["latest_charge"] },
  );
  const charge = intent.latest_charge;
  if (!charge) return false;
  if (charge.refunded) return true;
  if (!charge.disputed) return false;
  const disputes = await stripe<{ data: Array<{ status?: string }> }>("GET", "disputes", { payment_intent: paymentIntent, limit: 10 });
  return disputes.data.some((dispute) => dispute.status === "lost");
}

interface Refund {
  id: string;
  status: string;
  amount: number;
  metadata?: Record<string, string> | null;
}

type Outcome = "done" | "retry" | "failed";

/** What a refund's status means for the work: Stripe may take a while, or fail it after accepting it. */
function refundOutcome(status: string): Outcome {
  if (status === "succeeded") return "done";
  if (status === "failed" || status === "canceled") return "failed";
  return "retry";
}

/**
 * Gives back all of a payment for something the account already had, and
 * stops a duplicate subscription. Safe to repeat. Done once refunds have
 * given back the whole payment, whoever made them (one made by hand before
 * counts for what it gave); while one is still settling it is waited for.
 * This session's own refund is told by its metadata, so one whose answer
 * was lost is followed, never made again, and one Stripe failed is left
 * for paying back by hand. Each attempt to make one has its own idempotency
 * key, since Stripe answers a key with its first answer for a day, an error
 * included; it gives back what is left of the payment.
 */
async function refundDuplicate(session: CheckoutSession, subscription: Subscription | null, attempt: string): Promise<Outcome> {
  let paymentIntent = session.payment_intent;
  if (subscription) {
    if (subscription.status !== "canceled" && subscription.status !== "incomplete_expired") {
      await stripe("DELETE", `subscriptions/${path(subscription.id)}`);
    }
    if (subscription.latest_invoice) {
      const invoice = await stripe<{ payments?: { data?: Array<{ payment?: { payment_intent?: string } }> } }>(
        "GET",
        `invoices/${path(subscription.latest_invoice)}`,
        { expand: ["payments"] },
      );
      paymentIntent = invoice.payments?.data?.[0]?.payment?.payment_intent ?? null;
    }
  }
  if (!paymentIntent) {
    console.error("duplicate purchase without a payment to refund", session.id);
    return "done";
  }
  const [intent, made] = await Promise.all([
    stripe<{ amount_received?: number }>("GET", `payment_intents/${path(paymentIntent)}`),
    stripe<{ data: Refund[] }>("GET", "refunds", { payment_intent: paymentIntent, limit: 100 }),
  ]);
  if (made.data.some((refund) => refundOutcome(refund.status) === "retry")) return "retry";
  const given = made.data.filter((refund) => refund.status === "succeeded").reduce((sum, refund) => sum + refund.amount, 0);
  if (given >= (intent.amount_received ?? 0)) return "done";
  const ours = made.data.filter((refund) => refund.metadata?.checkout_session === session.id);
  if (ours.some((refund) => refundOutcome(refund.status) === "failed")) return "failed";
  try {
    const refund = await stripe<Refund>(
      "POST",
      "refunds",
      { payment_intent: paymentIntent, reason: "duplicate", metadata: { checkout_session: session.id } },
      { idempotencyKey: `refund-duplicate-${session.id}-${attempt}` },
    );
    return refundOutcome(refund.status);
  } catch (error) {
    if (error instanceof StripeError && error.code === "charge_already_refunded") return "done";
    if (error instanceof StripeError && error.code === "charge_disputed") return "failed";
    throw error;
  }
}

/** Marks a yearly plan's renewal as turned off by neat.link for Pro for life, not by its owner. */
const STOPPED_FOR = "stopped_for";

/**
 * Sets a yearly plan's renewal from what the account has now: off while it
 * has Pro for life, marked as turned off for it; on again once it has not,
 * if it was turned off for it. One its owner turned off stays off.
 */
async function syncRenewal(userId: string, subscriptionId: string): Promise<void> {
  const { running } = await billingOf(env.DB, userId);
  const lifetime = running.some((purchase) => purchase.product === "pro_life");
  const yearly = await stripe<Subscription>("GET", `subscriptions/${path(subscriptionId)}`);
  if (yearly.status === "canceled" || yearly.status === "incomplete_expired") return;
  const ours = yearly.metadata?.[STOPPED_FOR] === "pro_life";
  if (lifetime && !yearly.cancel_at_period_end) {
    await stripe("POST", `subscriptions/${path(subscriptionId)}`, { cancel_at_period_end: true, metadata: { [STOPPED_FOR]: "pro_life" } });
  } else if (!lifetime && ours) {
    await stripe("POST", `subscriptions/${path(subscriptionId)}`, { cancel_at_period_end: false, metadata: { [STOPPED_FOR]: "" } });
  }
}

const clock = () => Math.floor(Date.now() / 1000);

/**
 * Makes the Stripe calls a purchase still needs: the refund of a duplicate
 * (by `refund`, given the attempt's own key; null where the Checkout
 * Session is not at hand, which leaves it for later), or setting a yearly
 * plan's renewal. One request at a time holds the work, from when it takes
 * it; work asked for again meanwhile is done again; what is left goes to the
 * next delivery or the hourly run.
 */
async function finishWork(id: string, refund: ((attempt: string) => Promise<Outcome>) | null): Promise<void> {
  for (let turn = 0; turn < 3; turn++) {
    const work: PendingWork | null = await takePending(env.DB, id, clock());
    if (!work) return;
    let outcome: Outcome = "done";
    try {
      if (work.pending === "refund") outcome = refund ? await refund(work.lease) : "retry";
      else if (work.subscriptionId) await syncRenewal(work.userId, work.subscriptionId);
    } catch (error) {
      await endPending(env.DB, id, work, "retry", clock());
      throw error;
    }
    if (outcome === "failed") console.error("Stripe could not refund a duplicate payment: pay it back by hand", id);
    await endPending(env.DB, id, work, outcome, clock());
    if (outcome !== "done") return;
  }
}

/** Sets the renewal of an account's yearly plans still to set, now; what fails is left for the hourly run. */
async function syncRenewals(ids: readonly string[]): Promise<void> {
  for (const id of ids) {
    try {
      await finishWork(id, null);
    } catch (error) {
      console.error("yearly plan renewal", id, error);
    }
  }
}

/**
 * Gives an account what a paid Checkout Session bought, once, however many
 * times and however many requests at once tell of it (the webhook and the
 * owner's return from Checkout). A payment already taken back is recorded
 * as such; one for something the account already has (two links paid) is
 * refunded. Buying Pro for life stops the yearly plan from renewing. True
 * when this call gave something.
 */
export async function fulfilCheckout(session: CheckoutSession, now: number): Promise<boolean> {
  if (session.payment_status !== "paid" && session.payment_status !== "no_payment_required") return false;
  const userId = session.client_reference_id ?? session.metadata?.user_id;
  const product = session.metadata?.product;
  if (!userId || !isProduct(product)) return false;
  const exists = await env.DB.prepare(`SELECT 1 FROM "user" WHERE id = ?1`).bind(userId).first();
  if (!exists) return false;
  await finishCheckout(env.DB, session.id);
  let fetched: Promise<Subscription | null> | null = null;
  const subscription = () =>
    (fetched ??= session.subscription ? stripe<Subscription>("GET", `subscriptions/${path(session.subscription)}`) : Promise.resolve(null));
  let gave = false;
  if (!(await purchaseExists(env.DB, session.id))) {
    const current = await subscription();
    gave = await claimPurchase(env.DB, {
      id: session.id,
      userId,
      product,
      customerId: session.customer,
      subscriptionId: session.subscription,
      paymentIntentId: session.payment_intent,
      amount: session.amount_total ?? 0,
      currency: session.currency ?? "usd",
      endsAt: current ? subscriptionEnd(current, now) : null,
      takenBack: session.payment_intent ? await paymentTakenBack(session.payment_intent) : false,
      now,
    });
  }
  await finishWork(session.id, async (attempt) => refundDuplicate(session, await subscription(), attempt));
  // Pro for life stops the yearly plans renewing.
  if (product === "pro_life") await syncRenewals(await renewalWork(env.DB, userId));
  return gave;
}

/** The hourly run: Stripe calls a purchase still needs, left by a request that failed half way, or still settling. */
export async function finishPendingPurchases(now: number): Promise<void> {
  if (!stripeConfigured()) return;
  for (const id of await unfinishedPurchases(env.DB, now, 20)) {
    try {
      await finishWork(id, async (attempt) => {
        const session = await stripe<CheckoutSession>("GET", `checkout/sessions/${path(id)}`);
        const subscription = session.subscription ? await stripe<Subscription>("GET", `subscriptions/${path(session.subscription)}`) : null;
        return refundDuplicate(session, subscription, attempt);
      });
    } catch (error) {
      console.error("pending purchase", id, error);
    }
  }
}

/** Ends what a payment taken back bought. Yearly plans stopped for Pro for life renew again, now, or in the hourly run. */
async function takeBack(paymentIntent: string, now: number): Promise<void> {
  await syncRenewals(await markRefunded(env.DB, paymentIntent, now));
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
      if (object.refunded === true && typeof paymentIntent === "string") await takeBack(paymentIntent, now);
      return;
    }
    // A chargeback the account lost takes the money back as a refund does.
    case "charge.dispute.closed": {
      const paymentIntent = object.payment_intent;
      if (object.status === "lost" && typeof paymentIntent === "string") await takeBack(paymentIntent, now);
      return;
    }
  }
}
