/**
 * What neat.link sells and what each plan allows, shared by the server, the
 * editor and the API's words. Prices are in US cents, before VAT, which
 * Stripe adds at checkout where it applies.
 */

export type Product = "domains" | "pro_year" | "pro_life";
export type Plan = "free" | "domains" | "pro";
export type Feature = "domains" | "pixels" | "branding" | "subpages" | "media";

export interface ProductInfo {
  plan: Exclude<Plan, "free">;
  name: string;
  /** Before VAT, in cents. */
  amount: number;
  /** Paid once, or every year until cancelled. */
  interval: "once" | "year";
  /** The Stripe price's lookup key. */
  lookupKey: string;
  summary: string;
}

export const PRODUCTS: Record<Product, ProductInfo> = {
  domains: {
    plan: "domains",
    name: "Own domain",
    amount: 1000,
    interval: "once",
    lookupKey: "neat_domains_once",
    summary: "Your pages at your own domains. Pay once.",
  },
  pro_year: {
    plan: "pro",
    name: "Pro",
    amount: 5000,
    interval: "year",
    lookupKey: "neat_pro_year",
    summary: "Up to 10 pages, own domains, subpages, files, tracking pixels, and no neat.link sign. Yearly.",
  },
  pro_life: {
    plan: "pro",
    name: "Pro for life",
    amount: 10000,
    interval: "once",
    lookupKey: "neat_pro_life",
    summary: "Everything in Pro, paid once, for as long as neat.link runs.",
  },
};

export const PRODUCT_IDS = Object.keys(PRODUCTS) as Product[];

export function isProduct(value: unknown): value is Product {
  return typeof value === "string" && value in PRODUCTS;
}

/**
 * Pages an account may hold: published ones, and in all, drafts included.
 * Drafts are as many again as published pages, for trying things out.
 */
export const PLAN_LIMITS: Record<Plan, { published: number; sites: number }> = {
  free: { published: 2, sites: 4 },
  domains: { published: 2, sites: 4 },
  pro: { published: 10, sites: 20 },
};

const FEATURES: Record<Plan, ReadonlySet<Feature>> = {
  free: new Set(),
  domains: new Set(["domains"]),
  pro: new Set(["domains", "pixels", "branding", "subpages", "media"]),
};

export const PLAN_NAMES: Record<Plan, string> = { free: "Free", domains: "Own domain", pro: "Pro" };

/** The plan the running purchases add up to: the best of them. */
export function planOf(products: readonly string[]): Plan {
  if (products.includes("pro_life") || products.includes("pro_year")) return "pro";
  if (products.includes("domains")) return "domains";
  return "free";
}

export function allows(plan: Plan, feature: Feature): boolean {
  return FEATURES[plan].has(feature);
}

/** The cheapest product that brings a feature. */
export function productFor(feature: Feature): Product {
  return feature === "domains" ? "domains" : "pro_year";
}

/** The products that already give everything a product would. */
export const COVERED_BY: Record<Product, readonly Product[]> = {
  domains: ["domains", "pro_year", "pro_life"],
  pro_year: ["pro_year", "pro_life"],
  pro_life: ["pro_life"],
};

/** Whether buying a product would add anything to what an account has. */
export function canBuy(product: Product, running: readonly string[]): boolean {
  return !COVERED_BY[product].some((other) => running.includes(other));
}

/** "$10", "$50": a price as people read it. */
export function price(cents: number): string {
  return `$${cents % 100 === 0 ? cents / 100 : (cents / 100).toFixed(2)}`;
}

/** "$10 once", "$50 a year". */
export function priceLine(product: Product): string {
  const info = PRODUCTS[product];
  return `${price(info.amount)} ${info.interval === "year" ? "a year" : "once"}`;
}

/** Uploaded files: the largest one, and all of an account's together. */
export const MAX_FILE_BYTES = 25 * 1024 * 1024;
export const MEDIA_QUOTA_BYTES = 1024 * 1024 * 1024;
export const MAX_FILES = 1000;

/** Subpages one site may have. */
export const MAX_SUBPAGES = 100;

/** What the editor and the API say when a feature needs a plan the account lacks. */
export function planRequiredMessage(feature: Feature): string {
  const what: Record<Feature, string> = {
    domains: "Own domains come with the Own domain plan ($10 once) or Pro",
    pixels: "Tracking pixels come with Pro",
    branding: "Hiding the neat.link sign comes with Pro",
    subpages: "Subpages come with Pro",
    media: "Uploading files comes with Pro",
  };
  return `${what[feature]} ($50 a year or $100 once, plus VAT where it applies).`;
}
