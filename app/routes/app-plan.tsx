import { Check, ExternalLink } from "lucide-react";
import { Form, redirect, useNavigation } from "react-router";

import { billingPortal, confirmCheckout, planJson, startCheckout } from "~/lib/billing.server";
import { formatBytes } from "~/lib/files";
import { privateMeta } from "~/lib/meta";
import { priceLine, type Product, PRODUCTS } from "~/lib/plans";
import { Refusal } from "~/lib/refusal";
import { RATE_LIMITED_MESSAGE, withinLimits } from "~/lib/security/rate-limit.server";
import { requireAccount } from "~/lib/viewer.server";

import type { Route } from "./+types/app-plan";

export function meta() {
  return privateMeta("Plan");
}

export async function loader({ request, url, context }: Route.LoaderArgs) {
  const account = await requireAccount(request, context);
  // Back from Stripe: the payment is looked up and given at once.
  const paid = url.searchParams.get("paid");
  const confirmation = paid ? await confirmCheckout(account, paid, Math.floor(Date.now() / 1000)) : null;
  return { plan: await planJson(account), confirmation };
}

type Result = { error: string };

export async function action({ request, url, context }: Route.ActionArgs): Promise<Result | Response> {
  const account = await requireAccount(request, context);
  if (!(await withinLimits(request, "write", account.id))) return { error: RATE_LIMITED_MESSAGE };
  const form = await request.formData();
  try {
    if (form.get("intent") === "portal") return redirect((await billingPortal(account, url.origin)).url);
    return redirect((await startCheckout(account, form.get("product"), url.origin)).url);
  } catch (error) {
    if (error instanceof Refusal) return { error: error.message };
    throw error;
  }
}

const FEATURES: Record<Product, string[]> = {
  domains: ["Your pages at your own domains", "2 published pages, 4 in all"],
  pro_year: [
    "Up to 10 published pages, 20 in all",
    "Own domains",
    "Subpages: articles, public or private",
    "Files: pictures, video, audio, PDFs (1 GB)",
    "Google, Meta and TikTok pixels",
    "No neat.link sign on your pages",
  ],
  pro_life: ["Everything in Pro", "Paid once, for as long as neat.link runs"],
};

const date = (iso: string) => new Date(iso).toLocaleDateString("en", { year: "numeric", month: "long", day: "numeric" });

export default function PlanPage({ loaderData, actionData }: Route.ComponentProps) {
  const { plan, confirmation } = loaderData;
  const busy = useNavigation().state !== "idle";
  const error = (actionData as Result | undefined)?.error;
  const running = plan.purchases;

  return (
    <main className="mx-auto flex w-full max-w-column flex-col gap-8">
      <h1 className="text-2xl font-semibold">Plan</h1>
      {confirmation === "paid" ? (
        <p role="status" className="rounded bg-accent-soft px-4 py-3 text-sm">
          Thank you! Your payment went through and your plan is on.
        </p>
      ) : confirmation === "pending" ? (
        <p role="status" className="rounded bg-accent-soft px-4 py-3 text-sm">
          Your payment is on its way. The plan turns on as soon as it arrives; this page shows it then.
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="rounded bg-danger-soft px-4 py-3 text-sm text-danger">
          {error}
        </p>
      ) : null}

      <section className="flex flex-col gap-3 rounded-md border border-border bg-surface px-4 py-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <p className="text-lg font-semibold">{plan.name}</p>
          {plan.billing_portal ? (
            <Form method="post">
              <input type="hidden" name="intent" value="portal" />
              <button type="submit" className="btn btn-quiet" disabled={busy}>
                <ExternalLink size={16} aria-hidden /> Invoices and billing
              </button>
            </Form>
          ) : null}
        </div>
        {running.length > 0 ? (
          <ul className="flex flex-col gap-1 text-sm text-text-muted">
            {running.map((purchase) => (
              <li key={`${purchase.product}-${purchase.bought_at}`}>
                {purchase.name}: since {date(purchase.bought_at!)}
                {purchase.runs_until ? (purchase.renews ? `, renews by ${date(purchase.runs_until)}` : `, until ${date(purchase.runs_until)}`) : ", for good"}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-text-muted">Free: 2 published pages and 2 drafts, at neat.link/yourname.</p>
        )}
        <dl className="grid grid-cols-2 gap-3 pt-1 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-text-faint">Published</dt>
            <dd>
              {plan.usage.published_sites} of {plan.limits.published_sites}
            </dd>
          </div>
          <div>
            <dt className="text-text-faint">Pages in all</dt>
            <dd>
              {plan.usage.sites} of {plan.limits.sites}
            </dd>
          </div>
          {plan.features.media ? (
            <div>
              <dt className="text-text-faint">Files</dt>
              <dd>
                {formatBytes(plan.usage.media_bytes)} of {formatBytes(plan.limits.media_bytes)}
              </dd>
            </div>
          ) : null}
        </dl>
      </section>

      <section className="grid gap-4 sm:grid-cols-3">
        {plan.products.map((product) => (
          <div key={product.product} className="flex flex-col gap-3 rounded-md border border-border px-4 py-4">
            <div>
              <h2 className="font-semibold">{product.name}</h2>
              <p className="text-2xl font-bold">{priceLine(product.product)}</p>
              <p className="text-xs text-text-faint">plus VAT where it applies</p>
            </div>
            <ul className="flex flex-1 flex-col gap-1.5 text-sm">
              {FEATURES[product.product].map((feature) => (
                <li key={feature} className="flex gap-2">
                  <Check size={16} aria-hidden className="mt-0.5 shrink-0 text-success" /> {feature}
                </li>
              ))}
            </ul>
            <Form method="post">
              <input type="hidden" name="product" value={product.product} />
              <button type="submit" className={`btn w-full ${product.product === "pro_year" ? "btn-primary" : ""}`} disabled={busy || !product.available}>
                {product.available ? `Get ${PRODUCTS[product.product].name}` : "Included"}
              </button>
            </Form>
          </div>
        ))}
      </section>

      <p className="text-sm text-text-muted">
        Payments go through Stripe, which adds VAT for where you are; businesses can give their VAT number. Pro yearly renews until you
        cancel it under Invoices and billing. When a plan ends, nothing is deleted: pages past the free limit go back to drafts, and
        domains, subpages, pixels and the hidden sign wait until it is back. Agents can do all of this through the API:{" "}
        <a className="text-link" href="/api/v1">
          POST /api/v1/checkout
        </a>{" "}
        gives a payment link to open.
      </p>
    </main>
  );
}
