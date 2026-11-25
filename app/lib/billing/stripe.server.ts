import { env } from "cloudflare:workers";

import { STRIPE_API_VERSION } from "./stripe";

/**
 * Stripe's API over fetch, for the few calls neat.link makes: Checkout,
 * the billing portal, prices and subscriptions. The version is pinned, and
 * the webhook endpoint is made with the same one (scripts/stripe-setup.ts),
 * so what Stripe sends has the shape this code reads.
 */

export class StripeError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    message: string,
  ) {
    super(message);
  }
}

/** Stripe's form encoding: nested objects as a[b][c], lists as a[0]. Absent values are left out. */
export function stripeForm(params: Record<string, unknown>): URLSearchParams {
  const form = new URLSearchParams();
  const add = (key: string, value: unknown) => {
    if (value === undefined || value === null) return;
    if (Array.isArray(value)) value.forEach((item, index) => add(`${key}[${index}]`, item));
    else if (typeof value === "object") for (const [name, inner] of Object.entries(value)) add(`${key}[${name}]`, inner);
    else form.append(key, String(value));
  };
  for (const [name, value] of Object.entries(params)) add(name, value);
  return form;
}

export function stripeConfigured(): boolean {
  return Boolean(env.STRIPE_SECRET_KEY);
}

export async function stripe<T>(
  method: "GET" | "POST" | "DELETE",
  path: string,
  params: Record<string, unknown> = {},
  options: { idempotencyKey?: string } = {},
): Promise<T> {
  if (!env.STRIPE_SECRET_KEY) throw new StripeError(503, "not_configured", "Payments are not set up here.");
  const form = stripeForm(params);
  const query = method === "GET" && form.toString() ? `?${form}` : "";
  const headers: Record<string, string> = {
    Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
    "Stripe-Version": STRIPE_API_VERSION,
  };
  if (method === "POST") headers["Content-Type"] = "application/x-www-form-urlencoded";
  if (options.idempotencyKey) headers["Idempotency-Key"] = options.idempotencyKey;
  const response = await fetch(`https://api.stripe.com/v1/${path}${query}`, {
    method,
    headers,
    body: method === "POST" ? form.toString() : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await response.json().catch(() => ({}))) as { error?: { code?: string; message?: string } };
  if (!response.ok) throw new StripeError(response.status, body.error?.code, body.error?.message ?? "Stripe refused the request.");
  return body as T;
}

const encoder = new TextEncoder();

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Compares two strings in time that does not depend on where they differ. */
function sameText(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) difference |= a.charCodeAt(index) ^ b.charCodeAt(index);
  return difference === 0;
}

/**
 * Whether a webhook's body was signed by Stripe with this endpoint's secret
 * (the Stripe-Signature header: t=<time>,v1=<HMAC-SHA256 of "t.body">), at
 * most `toleranceSeconds` ago, so an old delivery cannot be replayed.
 */
export async function verifyStripeSignature(
  payload: string,
  header: string | null,
  secret: string | undefined,
  now: number,
  toleranceSeconds = 300,
): Promise<boolean> {
  if (!header || !secret) return false;
  let timestamp = Number.NaN;
  const signatures: string[] = [];
  for (const part of header.split(",")) {
    const [name, value = ""] = part.trim().split("=", 2);
    if (name === "t") timestamp = Number(value);
    else if (name === "v1") signatures.push(value);
  }
  if (!Number.isFinite(timestamp) || signatures.length === 0 || Math.abs(now - timestamp) > toleranceSeconds) return false;
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const expected = hex(await crypto.subtle.sign("HMAC", key, encoder.encode(`${timestamp}.${payload}`)));
  return signatures.some((signature) => sameText(signature, expected));
}

/** A signature header as Stripe would make it, for tests and local trials. */
export async function signStripePayload(payload: string, secret: string, timestamp: number): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return `t=${timestamp},v1=${hex(await crypto.subtle.sign("HMAC", key, encoder.encode(`${timestamp}.${payload}`)))}`;
}
