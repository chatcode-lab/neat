import { COVERED_BY, type Plan, planOf, type Product } from "../plans";

/** A purchase gives its features while this holds: not refunded, and not past its end. */
export const RUNNING = `refunded_at IS NULL AND (ends_at IS NULL OR ends_at > unixepoch())`;

/**
 * SQL for the products an owner has running, as a comma-separated list, for
 * a query that has the owner's ID in `column`.
 */
export const runningProductsOf = (column: string) =>
  `(SELECT group_concat(product) FROM purchases WHERE user_id = ${column} AND ${RUNNING})`;

/** SQL that holds when the owner in `column` has Pro running. */
export const hasProSql = (column: string) =>
  `EXISTS (SELECT 1 FROM purchases WHERE user_id = ${column} AND product IN ('pro_year', 'pro_life') AND ${RUNNING})`;

/** SQL that holds when the owner in `column` may have own domains. */
export const hasDomainsSql = (column: string) => `EXISTS (SELECT 1 FROM purchases WHERE user_id = ${column} AND ${RUNNING})`;

/**
 * SQL for the domain a site is served at, or null: connected, and its
 * owner's plan still has own domains. `site` is the sites table's alias.
 */
export const servedDomainSql = (site: string) =>
  `(SELECT hostname FROM domains WHERE site_id = ${site}.id AND status = 'active' AND ${hasDomainsSql(`${site}.owner_id`)})`;

export const productsFromList = (list: string | null): Product[] => (list ? (list.split(",") as Product[]) : []);

export interface Purchase {
  id: string;
  product: Product;
  amount: number;
  currency: string;
  createdAt: number;
  endsAt: number | null;
  subscriptionId: string | null;
}

export interface Billing {
  plan: Plan;
  /** Purchases still running. */
  running: Purchase[];
  /** The Stripe customer the account last paid as, for the billing portal. */
  customerId: string | null;
}

export async function billingOf(db: D1Database, userId: string): Promise<Billing> {
  const [running, customer] = await db.batch([
    db
      .prepare(
        `SELECT id, product, amount, currency, created_at, ends_at, subscription_id FROM purchases
         WHERE user_id = ?1 AND ${RUNNING} ORDER BY created_at`,
      )
      .bind(userId),
    db
      .prepare(`SELECT customer_id FROM purchases WHERE user_id = ?1 AND customer_id IS NOT NULL ORDER BY created_at DESC LIMIT 1`)
      .bind(userId),
  ]);
  const rows = running!.results as Array<{
    id: string;
    product: Product;
    amount: number;
    currency: string;
    created_at: number;
    ends_at: number | null;
    subscription_id: string | null;
  }>;
  const purchases = rows.map((row) => ({
    id: row.id,
    product: row.product,
    amount: row.amount,
    currency: row.currency,
    createdAt: row.created_at,
    endsAt: row.ends_at,
    subscriptionId: row.subscription_id,
  }));
  return {
    plan: planOf(purchases.map((purchase) => purchase.product)),
    running: purchases,
    customerId: (customer!.results[0] as { customer_id: string } | undefined)?.customer_id ?? null,
  };
}

export interface NewPurchase {
  id: string;
  userId: string;
  product: Product;
  customerId: string | null;
  subscriptionId: string | null;
  paymentIntentId: string | null;
  amount: number;
  currency: string;
  endsAt: number | null;
  /** The payment was refunded, or lost to a chargeback, before it was recorded. */
  takenBack: boolean;
  now: number;
}

export async function purchaseExists(db: D1Database, id: string): Promise<boolean> {
  return Boolean(await db.prepare(`SELECT 1 FROM purchases WHERE id = ?1`).bind(id).first());
}

/**
 * Records a purchase once, however many requests tell of it at the same
 * time. The one statement that records it also decides whether the account
 * already had what it gives (two payment links paid): then it is recorded
 * refunded, with the refund still to make. True when this request recorded
 * it and it gives the account something.
 */
export async function claimPurchase(db: D1Database, purchase: NewPurchase): Promise<boolean> {
  const covering = COVERED_BY[purchase.product].map((product) => `'${product}'`).join(", ");
  const row = await db
    .prepare(
      `WITH earlier AS (
         SELECT EXISTS (SELECT 1 FROM purchases WHERE user_id = ?2 AND product IN (${covering}) AND ${RUNNING}) AS covered
       )
       INSERT INTO purchases (id, user_id, product, customer_id, subscription_id, payment_intent_id, amount, currency, created_at, ends_at, refunded_at, pending)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10,
         CASE WHEN ?11 OR covered THEN ?9 END,
         CASE WHEN ?11 THEN NULL WHEN covered THEN 'refund' WHEN ?3 = 'pro_life' THEN 'stop_yearly' END
       FROM earlier WHERE true
       ON CONFLICT DO NOTHING
       RETURNING refunded_at`,
    )
    .bind(
      purchase.id,
      purchase.userId,
      purchase.product,
      purchase.customerId,
      purchase.subscriptionId,
      purchase.paymentIntentId,
      purchase.amount,
      purchase.currency,
      purchase.now,
      purchase.endsAt,
      purchase.takenBack ? 1 : 0,
    )
    .first<{ refunded_at: number | null }>();
  return row !== null && row.refunded_at === null;
}

/** How long a request may take to make a purchase's Stripe calls before another may try. */
const PENDING_LOCK_SECONDS = 120;

/** Takes on what is still to be done at Stripe for a purchase, unless done or another request has it. */
export async function takePending(db: D1Database, id: string, now: number): Promise<"refund" | "stop_yearly" | null> {
  const row = await db
    .prepare(
      `UPDATE purchases SET pending_lock = ?2
       WHERE id = ?1 AND pending IS NOT NULL AND coalesce(pending_lock, 0) <= ?2 - ${PENDING_LOCK_SECONDS}
       RETURNING pending`,
    )
    .bind(id, now)
    .first<{ pending: "refund" | "stop_yearly" }>();
  return row?.pending ?? null;
}

/** What was still to be done for a purchase is done; or, when `done` is false, failed and may be tried again. */
export async function endPending(db: D1Database, id: string, done: boolean): Promise<void> {
  await db
    .prepare(done ? `UPDATE purchases SET pending = NULL, pending_lock = NULL WHERE id = ?1` : `UPDATE purchases SET pending_lock = NULL WHERE id = ?1`)
    .bind(id)
    .run();
}

/** Checkout Sessions whose Stripe calls were left undone, for the hourly run to finish. */
export async function unfinishedPurchases(db: D1Database, now: number, limit: number): Promise<string[]> {
  const { results } = await db
    .prepare(
      `SELECT id FROM purchases WHERE pending IS NOT NULL AND coalesce(pending_lock, 0) <= ?1 - ${PENDING_LOCK_SECONDS}
       AND substr(id, 1, 3) = 'cs_' ORDER BY created_at LIMIT ?2`,
    )
    .bind(now, limit)
    .all<{ id: string }>();
  return results.map((row) => row.id);
}

/** The account's Checkout Session still open, if any, replaced by a new one. */
export async function replaceCheckout(db: D1Database, userId: string, sessionId: string, now: number): Promise<string | null> {
  const previous = await db.prepare(`SELECT session_id FROM checkouts WHERE user_id = ?1`).bind(userId).first<{ session_id: string }>();
  await db
    .prepare(
      `INSERT INTO checkouts (user_id, session_id, created_at) VALUES (?1, ?2, ?3)
       ON CONFLICT (user_id) DO UPDATE SET session_id = excluded.session_id, created_at = excluded.created_at`,
    )
    .bind(userId, sessionId, now)
    .run();
  return previous && previous.session_id !== sessionId ? previous.session_id : null;
}

/** Forgets a finished Checkout Session. */
export async function finishCheckout(db: D1Database, sessionId: string): Promise<void> {
  await db.prepare(`DELETE FROM checkouts WHERE session_id = ?1`).bind(sessionId).run();
}

/** Moves a subscription's end, at a renewal or a cancellation. */
export async function setSubscriptionEnd(db: D1Database, subscriptionId: string, endsAt: number): Promise<boolean> {
  const result = await db.prepare(`UPDATE purchases SET ends_at = ?2 WHERE subscription_id = ?1`).bind(subscriptionId, endsAt).run();
  return result.meta.changes > 0;
}

/** Ends what a fully refunded payment bought. */
export async function markRefunded(db: D1Database, paymentIntentId: string, now: number): Promise<boolean> {
  const result = await db
    .prepare(`UPDATE purchases SET refunded_at = ?2 WHERE payment_intent_id = ?1 AND refunded_at IS NULL`)
    .bind(paymentIntentId, now)
    .run();
  return result.meta.changes > 0;
}

/** The account's yearly subscriptions still running, to stop when it buys Pro for life. */
export async function runningSubscriptions(db: D1Database, userId: string): Promise<string[]> {
  const { results } = await db
    .prepare(`SELECT subscription_id FROM purchases WHERE user_id = ?1 AND subscription_id IS NOT NULL AND ${RUNNING}`)
    .bind(userId)
    .all<{ subscription_id: string }>();
  return results.map((row) => row.subscription_id);
}

/**
 * Brings published pages back within each account's plan: past the limit,
 * the most recently published ones go back to drafts, nothing is deleted.
 * It runs every hour, so a plan that has ended takes its extra pages down
 * within the hour. The number taken down is returned.
 */
export async function enforcePublishLimits(db: D1Database, now: number, limits: Record<Plan, number>): Promise<number> {
  const result = await db
    .prepare(
      `UPDATE sites SET published_at = NULL, updated_at = ?1
       WHERE id IN (
         SELECT id FROM (
           SELECT id, owner_id, row_number() OVER (PARTITION BY owner_id ORDER BY published_at, id) AS rank
           FROM sites WHERE deleted_at IS NULL AND published_at IS NOT NULL
         ) AS ranked
         WHERE rank > CASE WHEN ${hasProSql("ranked.owner_id")} THEN ?2 ELSE ?3 END
       )`,
    )
    .bind(now, limits.pro, limits.free)
    .run();
  return result.meta.changes;
}
