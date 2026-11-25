/**
 * Sets up Stripe for one deployment, and is safe to run again:
 *
 *   npm run stripe:setup -- staging       (test mode, STRIPE_TEST_API_KEY)
 *   npm run stripe:setup -- production    (live mode, STRIPE_LIVE_API_KEY)
 *
 * The key is read from .env. It makes what is missing: a product and a
 * price for each plan (found again by lookup key, before VAT, which Stripe
 * Tax adds), the billing portal's settings, and the webhook endpoint with
 * the API version the Worker reads. The endpoint's signing secret, which
 * Stripe shows only when it is made, and the API key itself go straight to
 * the Worker's secrets with `wrangler secret put`, never to the screen.
 *
 * Stripe Tax collects VAT only where the account is registered for it: add
 * the registrations (Estonia, and the EU's OSS once over its threshold) in
 * the Dashboard under Tax → Registrations.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { STRIPE_API_VERSION, STRIPE_EVENTS } from "../app/lib/billing/stripe";
import { PRODUCT_IDS, PRODUCTS } from "../app/lib/plans";

const target = process.argv[2];
const ORIGINS: Record<string, string> = {
  staging: "https://neat-link-staging.borkasm.workers.dev",
  production: "https://neat.link",
};
if (!target || !ORIGINS[target]) {
  console.error("Usage: npm run stripe:setup -- staging|production");
  process.exit(1);
}
const origin = ORIGINS[target]!;
const keyName = target === "production" ? "STRIPE_LIVE_API_KEY" : "STRIPE_TEST_API_KEY";
const key = readFileSync(".env", "utf8").match(new RegExp(`^${keyName}=(.+)$`, "m"))?.[1]?.trim();
if (!key) {
  console.error(`${keyName} is not in .env.`);
  process.exit(1);
}
if (!key.startsWith(target === "production" ? "sk_live_" : "sk_test_")) {
  console.error(`${keyName} is not a ${target === "production" ? "live" : "test"} secret key.`);
  process.exit(1);
}

function form(params: Record<string, unknown>, prefix = "", out = new URLSearchParams()): URLSearchParams {
  for (const [name, value] of Object.entries(params)) {
    const field = prefix ? `${prefix}[${name}]` : name;
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) value.forEach((item, index) => (typeof item === "object" ? form(item, `${field}[${index}]`, out) : out.append(`${field}[${index}]`, String(item))));
    else if (typeof value === "object") form(value as Record<string, unknown>, field, out);
    else out.append(field, String(value));
  }
  return out;
}

async function stripe<T>(method: "GET" | "POST" | "DELETE", path: string, params: Record<string, unknown> = {}): Promise<T> {
  const query = method === "GET" ? `?${form(params)}` : "";
  const response = await fetch(`https://api.stripe.com/v1/${path}${query}`, {
    method,
    headers: { Authorization: `Bearer ${key}`, "Stripe-Version": STRIPE_API_VERSION, "Content-Type": "application/x-www-form-urlencoded" },
    body: method === "POST" ? form(params).toString() : undefined,
  });
  const body = (await response.json()) as T & { error?: { message: string } };
  if (!response.ok) throw new Error(`${method} ${path}: ${body.error?.message}`);
  return body;
}

/** Sends a secret to the Worker's environment, through stdin. */
function putSecret(name: string, value: string): void {
  const result = spawnSync("npx", ["wrangler", "secret", "put", name, "-c", "wrangler.jsonc", "--env", target!], {
    input: value,
    stdio: ["pipe", "inherit", "inherit"],
  });
  if (result.status !== 0) throw new Error(`wrangler secret put ${name} failed.`);
}

// Products and prices.
for (const id of PRODUCT_IDS) {
  const info = PRODUCTS[id];
  const { data } = await stripe<{ data: Array<{ id: string }> }>("GET", "prices", { lookup_keys: [info.lookupKey], active: true });
  if (data[0]) {
    console.log(`✓ ${info.name}: ${data[0].id}`);
    continue;
  }
  const product = await stripe<{ id: string }>("POST", "products", {
    name: `neat.link ${info.name}`,
    description: info.summary,
    metadata: { product: id },
  });
  const price = await stripe<{ id: string }>("POST", "prices", {
    product: product.id,
    currency: "usd",
    unit_amount: info.amount,
    tax_behavior: "exclusive",
    lookup_key: info.lookupKey,
    ...(info.interval === "year" ? { recurring: { interval: "year" } } : {}),
    metadata: { product: id },
  });
  console.log(`+ ${info.name}: ${price.id}`);
}

// The billing portal: invoices, the card, the customer's details, and cancelling the yearly plan at its end.
const portals = await stripe<{ data: Array<{ id: string; is_default: boolean }> }>("GET", "billing_portal/configurations", { is_default: true });
if (portals.data[0]) console.log(`✓ Billing portal: ${portals.data[0].id}`);
else {
  const portal = await stripe<{ id: string }>("POST", "billing_portal/configurations", {
    business_profile: { headline: "neat.link", privacy_policy_url: `${origin}/privacy`, terms_of_service_url: `${origin}/terms` },
    default_return_url: `${origin}/app/plan`,
    features: {
      invoice_history: { enabled: true },
      payment_method_update: { enabled: true },
      customer_update: { enabled: true, allowed_updates: ["email", "address", "name", "tax_id"] },
      subscription_cancel: { enabled: true, mode: "at_period_end" },
    },
  });
  console.log(`+ Billing portal: ${portal.id}`);
}

// The webhook endpoint, with the version the Worker reads.
const url = `${origin}/stripe/webhook`;
const endpoints = await stripe<{ data: Array<{ id: string; url: string; api_version: string | null }> }>("GET", "webhook_endpoints", { limit: 100 });
const existing = endpoints.data.find((endpoint) => endpoint.url === url);
if (existing) {
  // Its events follow the Worker's; its secret stays (Stripe shows it only when made).
  await stripe("POST", `webhook_endpoints/${existing.id}`, { enabled_events: STRIPE_EVENTS });
  console.log(`✓ Webhook ${url}: ${existing.id} (API ${existing.api_version}), events brought up to date.`);
  if (existing.api_version !== STRIPE_API_VERSION) console.warn(`! Its API version is not ${STRIPE_API_VERSION}: delete it and run this again.`);
} else {
  const endpoint = await stripe<{ id: string; secret: string }>("POST", "webhook_endpoints", {
    url,
    enabled_events: STRIPE_EVENTS,
    api_version: STRIPE_API_VERSION,
    description: `neat.link ${target}`,
  });
  console.log(`+ Webhook ${url}: ${endpoint.id}`);
  try {
    putSecret("STRIPE_WEBHOOK_SECRET", endpoint.secret);
  } catch (error) {
    // Its secret cannot be read again, so an endpoint whose secret did not reach the Worker is no use.
    await stripe("DELETE", `webhook_endpoints/${endpoint.id}`);
    console.error(`- Webhook ${endpoint.id} removed again; run this once more.`);
    throw error;
  }
}
putSecret("STRIPE_SECRET_KEY", key);
console.log(`Done. Payments on ${origin} use Stripe in ${target === "production" ? "live" : "test"} mode.`);
