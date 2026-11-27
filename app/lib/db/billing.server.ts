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
 * refunded, with the refund still to make. Pro for life also asks, in the
 * same transaction, for the account's yearly plans to stop renewing. True
 * when this request recorded it and it gives the account something.
 */
export async function claimPurchase(db: D1Database, purchase: NewPurchase): Promise<boolean> {
  const covering = COVERED_BY[purchase.product].map((product) => `'${product}'`).join(", ");
  const claim = db
    .prepare(
      `WITH earlier AS (
         SELECT EXISTS (SELECT 1 FROM purchases WHERE user_id = ?2 AND product IN (${covering}) AND ${RUNNING}) AS covered
       )
       INSERT INTO purchases (id, user_id, product, customer_id, subscription_id, payment_intent_id, amount, currency, created_at, ends_at, refunded_at, pending)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10,
         CASE WHEN ?11 OR covered THEN ?9 END,
         CASE WHEN covered AND NOT ?11 THEN 'refund' END
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
    );
  const [claimed] = await db.batch(purchase.product === "pro_life" ? [claim, askRenewalSync(db, `user_id = ?1`, purchase.userId)] : [claim]);
  const row = claimed!.results[0] as { refunded_at: number | null } | undefined;
  return row !== undefined && row.refunded_at === null;
}

/**
 * Asks for the yearly plans of the accounts `owners` picks to have their
 * renewal set again from what the account has now (see renewalWork). Each
 * ask counts up pending_rev, so a request already at it does it once more.
 */
const askRenewalSync = (db: D1Database, owners: string, value: string) =>
  db
    .prepare(
      `UPDATE purchases SET pending = 'sync_renewal', pending_rev = pending_rev + 1
       WHERE ${owners} AND subscription_id IS NOT NULL AND ${RUNNING} AND (pending IS NULL OR pending = 'sync_renewal')
       RETURNING id`,
    )
    .bind(value);

/**
 * How long a request may take to make a purchase's Stripe calls before
 * another may try: well past what its calls can take, each timing out in 15
 * seconds.
 */
const PENDING_LEASE_SECONDS = 300;

/** Work at Stripe a request can take on; 'refund_failed' waits for a person. */
const OPEN_WORK = `pending IN ('refund', 'sync_renewal')`;

export interface PendingWork {
  /** 'refund' a duplicate; 'sync_renewal': set a yearly plan's renewal from what the account has now. */
  pending: "refund" | "sync_renewal";
  /** This request's hold on it, which it finishes only while still holding. */
  lease: string;
  rev: number;
  userId: string;
  subscriptionId: string | null;
}

/**
 * Takes on what is still to be done at Stripe for a purchase, unless done,
 * or another request holds it. `now` is the time it is taken, so the lease
 * runs from then.
 */
export async function takePending(db: D1Database, id: string, now: number): Promise<PendingWork | null> {
  const lease = crypto.randomUUID();
  const row = await db
    .prepare(
      `UPDATE purchases SET pending_at = ?2 + ${PENDING_LEASE_SECONDS}, pending_lease = ?3
       WHERE id = ?1 AND ${OPEN_WORK} AND coalesce(pending_at, 0) <= ?2
       RETURNING pending, pending_rev, user_id, subscription_id`,
    )
    .bind(id, now, lease)
    .first<{ pending: PendingWork["pending"]; pending_rev: number; user_id: string; subscription_id: string | null }>();
  return row ? { pending: row.pending, lease, rev: row.pending_rev, userId: row.user_id, subscriptionId: row.subscription_id } : null;
}

/**
 * Ends a request's turn at a purchase's Stripe work, if it still holds it:
 * "done", unless the work was asked for again meanwhile, which leaves it for
 * the next turn; "retry" when it failed or Stripe is still working on it,
 * for the next delivery or the hourly run, behind work not tried since;
 * "failed" when Stripe could not refund, for someone to pay the owner back
 * by hand.
 */
export async function endPending(db: D1Database, id: string, work: PendingWork, outcome: "done" | "retry" | "failed", now: number): Promise<void> {
  const statement =
    outcome === "retry"
      ? db.prepare(`UPDATE purchases SET pending_at = ?3, pending_lease = NULL WHERE id = ?1 AND pending_lease = ?2`).bind(id, work.lease, now)
      : db
          .prepare(
            `UPDATE purchases SET pending = CASE WHEN pending_rev = ?3 THEN ?4 ELSE pending END, pending_at = NULL, pending_lease = NULL
             WHERE id = ?1 AND pending_lease = ?2`,
          )
          .bind(id, work.lease, work.rev, outcome === "failed" ? "refund_failed" : null);
  await statement.run();
}

/**
 * Purchases with Stripe calls left undone or still settling, for the hourly
 * run: work never tried first, then what waited longest, so refunds Stripe
 * takes days over, or work that keeps failing, never keep newer work from
 * its turn.
 */
export async function unfinishedPurchases(db: D1Database, now: number, limit: number): Promise<string[]> {
  const { results } = await db
    .prepare(
      `SELECT id FROM purchases WHERE ${OPEN_WORK} AND coalesce(pending_at, 0) <= ?1 AND substr(id, 1, 3) = 'cs_'
       ORDER BY coalesce(pending_at, 0), created_at LIMIT ?2`,
    )
    .bind(now, limit)
    .all<{ id: string }>();
  return results.map((row) => row.id);
}

/** An account's yearly plans whose renewal is still to set. */
export async function renewalWork(db: D1Database, userId: string): Promise<string[]> {
  const { results } = await db
    .prepare(`SELECT id FROM purchases WHERE user_id = ?1 AND pending = 'sync_renewal'`)
    .bind(userId)
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

/**
 * Ends what a fully refunded payment bought. Pro for life taken back no
 * longer replaces the yearly plan, so the account's yearly plans are asked,
 * in the same transaction, to have their renewal set again; those returned.
 */
export async function markRefunded(db: D1Database, paymentIntentId: string, now: number): Promise<string[]> {
  const [, asked] = await db.batch([
    db.prepare(`UPDATE purchases SET refunded_at = ?2 WHERE payment_intent_id = ?1 AND refunded_at IS NULL`).bind(paymentIntentId, now),
    askRenewalSync(db, `user_id IN (SELECT user_id FROM purchases WHERE payment_intent_id = ?1 AND product = 'pro_life')`, paymentIntentId),
  ]);
  return (asked!.results as Array<{ id: string }>).map((row) => row.id);
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
