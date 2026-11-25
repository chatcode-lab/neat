import { env } from "cloudflare:workers";

import { verifyStripeSignature } from "~/lib/billing/stripe.server";
import { handleStripeEvent, type StripeEvent } from "~/lib/billing.server";
import { readBodyCapped } from "~/lib/security/body";

import type { Route } from "./+types/stripe-webhook";

/**
 * Stripe's webhook: payments, renewals, cancellations and refunds. Only a
 * body signed with this endpoint's secret is read. A failure answers 500,
 * so Stripe delivers the event again later; every event can be applied
 * more than once.
 */
export async function action({ request }: Route.ActionArgs) {
  const payload = await readBodyCapped(request, 256 * 1024);
  const now = Math.floor(Date.now() / 1000);
  if (payload === null) return new Response("Too large", { status: 413 });
  if (!(await verifyStripeSignature(payload, request.headers.get("Stripe-Signature"), env.STRIPE_WEBHOOK_SECRET, now))) {
    return new Response("Bad signature", { status: 400 });
  }
  let event: StripeEvent;
  try {
    event = JSON.parse(payload) as StripeEvent;
  } catch {
    return new Response("Bad JSON", { status: 400 });
  }
  try {
    await handleStripeEvent(event, now);
  } catch (error) {
    console.error("stripe event", event.type, event.id, error);
    return new Response("Failed", { status: 500 });
  }
  return new Response("OK", { headers: { "Cache-Control": "no-store" } });
}

export function loader() {
  return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST" } });
}
