import { env } from "cloudflare:workers";
import { Form, redirect, useNavigation } from "react-router";

import { suggestHandle } from "~/lib/db/sites.server";
import { privateMeta } from "~/lib/meta";
import { RATE_LIMITED_MESSAGE, withinLimits } from "~/lib/security/rate-limit.server";
import { createSiteFor, Refusal } from "~/lib/sites.server";
import { requireAccount } from "~/lib/viewer.server";

import type { Route } from "./+types/app-new";

export function meta() {
  return privateMeta("New page");
}

export async function loader({ request, url, context }: Route.LoaderArgs) {
  const account = await requireAccount(request, context);
  return {
    host: url.host,
    handle: await suggestHandle(env.DB, [account.telegram?.username, account.email?.split("@")[0], account.name]),
    title: account.name,
  };
}

export async function action({ request, context }: Route.ActionArgs) {
  const account = await requireAccount(request, context);
  if (!(await withinLimits(request, "write", account.id))) return { error: RATE_LIMITED_MESSAGE };
  const form = await request.formData();
  try {
    const site = await createSiteFor(
      account,
      { handle: String(form.get("handle") ?? ""), title: String(form.get("title") ?? "") },
      Math.floor(Date.now() / 1000),
    );
    return redirect(`/app/sites/${site.handle}?created=1`);
  } catch (error) {
    if (error instanceof Refusal) return { error: error.message };
    throw error;
  }
}

export default function NewPage({ loaderData, actionData }: Route.ComponentProps) {
  const busy = useNavigation().state !== "idle";
  return (
    <main className="mx-auto flex w-full max-w-md flex-col gap-5">
      <h1 className="text-2xl font-semibold">New page</h1>
      <Form method="post" className="flex flex-col gap-4">
        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium">Address</span>
          <span className="flex items-center rounded border border-border-strong bg-surface focus-within:outline-2 focus-within:outline-accent">
            <span className="pl-3 text-text-muted">{loaderData.host}/</span>
            <input
              name="handle"
              defaultValue={loaderData.handle}
              required
              maxLength={32}
              pattern="[A-Za-z][A-Za-z0-9_]*"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              className="min-w-0 flex-1 bg-transparent py-2 pr-3 outline-none"
            />
          </span>
          <span className="text-sm text-text-faint">Letters, digits and _, at least 6 characters (or your Telegram username).</span>
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium">Title</span>
          <input name="title" defaultValue={loaderData.title} required maxLength={100} className="field" />
        </label>
        {actionData?.error ? (
          <p role="alert" className="rounded bg-danger-soft px-4 py-3 text-sm text-danger">
            {actionData.error}
          </p>
        ) : null}
        <button type="submit" className="btn btn-primary py-2.5" disabled={busy}>
          Create the page
        </button>
        <p className="text-sm text-text-faint">It stays a draft, seen only by you, until you publish it.</p>
      </Form>
    </main>
  );
}
