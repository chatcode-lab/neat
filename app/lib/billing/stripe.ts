/**
 * What the Worker and scripts/stripe-setup.ts agree on with Stripe: the API
 * version calls and webhooks use, so what Stripe sends has the shape the
 * code reads, and the events the webhook endpoint asks for.
 */
export const STRIPE_API_VERSION = "2025-03-31.basil";

export const STRIPE_EVENTS = [
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "charge.refunded",
  "charge.dispute.closed",
];
