import { env } from "cloudflare:workers";

/**
 * Cloudflare for SaaS: owners' domains are custom hostnames on the
 * neat.link zone, each with a certificate Cloudflare issues once the domain
 * points here (HTTP validation). A hostname is billed from when it is made
 * until it is deleted, so one is made only after its DNS was seen to point
 * here, and deleted when it stops. Without a zone and a token (local
 * development, staging) nothing is made: the domain is served as soon as
 * its DNS points here, which only production can see anyway.
 */
export function saasConfigured(): boolean {
  return Boolean(env.CF_ZONE_ID && env.CF_API_TOKEN);
}

export interface CustomHostname {
  id: string;
  /** The hostname's own status: pending, active, moved, deleted… */
  status: string;
  /** Its certificate's: initializing, pending_validation, pending_issuance, active… */
  ssl: string | null;
  /** Where Cloudflare may ask the domain to prove it points here, and the answer. */
  httpPath: string | null;
  httpBody: string | null;
}

interface CloudflareAnswer<T> {
  success: boolean;
  errors?: Array<{ code: number; message: string }>;
  result: T;
}

interface HostnameResult {
  id: string;
  status: string;
  ssl?: { status?: string };
  ownership_verification_http?: { http_url?: string; http_body?: string };
}

async function cloudflare<T>(method: "GET" | "POST" | "DELETE", path: string, body?: unknown): Promise<CloudflareAnswer<T> & { httpStatus: number }> {
  const response = await fetch(`https://api.cloudflare.com/client/v4/zones/${env.CF_ZONE_ID}/${path}`, {
    method,
    headers: { Authorization: `Bearer ${env.CF_API_TOKEN}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  const answer = (await response.json().catch(() => ({ success: false, result: null }))) as CloudflareAnswer<T>;
  return { ...answer, httpStatus: response.status };
}

function toHostname(result: HostnameResult): CustomHostname {
  const http = result.ownership_verification_http;
  let httpPath: string | null = null;
  try {
    httpPath = http?.http_url ? new URL(http.http_url).pathname : null;
  } catch {
    httpPath = null;
  }
  return { id: result.id, status: result.status, ssl: result.ssl?.status ?? null, httpPath, httpBody: http?.http_body ?? null };
}

export class SaasError extends Error {}

/** Makes the custom hostname, or finds the one already made for this name. */
export async function registerHostname(hostname: string): Promise<CustomHostname> {
  const made = await cloudflare<HostnameResult>("POST", "custom_hostnames", {
    hostname,
    ssl: { method: "http", type: "dv", settings: { min_tls_version: "1.2" } },
  });
  if (made.success) return toHostname(made.result);
  // 1406: a custom hostname with this name exists already.
  if (made.errors?.some((error) => error.code === 1406)) {
    const found = await cloudflare<HostnameResult[]>("GET", `custom_hostnames?hostname=${encodeURIComponent(hostname)}`);
    if (found.success && found.result[0]) return toHostname(found.result[0]);
  }
  throw new SaasError(made.errors?.map((error) => error.message).join("; ") || `Cloudflare answered ${made.httpStatus}.`);
}

/** A custom hostname's status now; null when Cloudflare has no such hostname. */
export async function hostnameStatus(id: string): Promise<CustomHostname | null> {
  const answer = await cloudflare<HostnameResult>("GET", `custom_hostnames/${encodeURIComponent(id)}`);
  if (answer.success) return toHostname(answer.result);
  if (answer.httpStatus === 404) return null;
  throw new SaasError(answer.errors?.map((error) => error.message).join("; ") || `Cloudflare answered ${answer.httpStatus}.`);
}

/** Deletes a custom hostname, so it is no longer billed; one already gone is fine. */
export async function removeHostname(id: string): Promise<void> {
  const answer = await cloudflare<unknown>("DELETE", `custom_hostnames/${encodeURIComponent(id)}`);
  if (!answer.success && answer.httpStatus !== 404) {
    throw new SaasError(answer.errors?.map((error) => error.message).join("; ") || `Cloudflare answered ${answer.httpStatus}.`);
  }
}
