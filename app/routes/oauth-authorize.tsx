import { env } from "cloudflare:workers";
import { useEffect } from "react";
import { Form, redirect, useNavigation } from "react-router";

import { privateMeta } from "~/lib/meta";
import { issueCode, readAuthorization } from "~/lib/oauth/clients.server";
import { answerUrl } from "~/lib/oauth/metadata";
import { RATE_LIMITED_MESSAGE, withinLimits } from "~/lib/security/rate-limit.server";
import { viewerOf } from "~/lib/viewer.server";

import type { Route } from "./+types/oauth-authorize";

export function meta() {
  return privateMeta("Connect an app");
}

const now = () => Math.floor(Date.now() / 1000);

function hostOf(address: string): string {
  try {
    return new URL(address).host || address;
  } catch {
    return address;
  }
}

export async function loader({ request, url, context }: Route.LoaderArgs) {
  // Signed in first, and within the limit: reading the request may fetch the
  // app's description from its own address.
  const viewer = await viewerOf(context);
  if (!viewer) throw redirect(`/signin?${new URLSearchParams({ next: `${url.pathname}${url.search}` })}`);
  if (!(await withinLimits(request, "signin", viewer.id))) return { state: "invalid" as const, message: RATE_LIMITED_MESSAGE };
  const read = await readAuthorization(env.DB, url.searchParams, { now: now(), origin: url.origin });
  if (!read.ok && "show" in read) return { state: "invalid" as const, message: read.show };
  if (!read.ok) {
    const { uri, error, description, state } = read.redirect;
    throw redirect(answerUrl(uri, { error, error_description: description, state, iss: url.origin }));
  }
  const { client, redirectUri } = read.request;
  return {
    state: "ask" as const,
    account: viewer.email ?? viewer.name,
    client: { name: client.name, returnsTo: hostOf(redirectUri), vouchedBy: client.document ? hostOf(client.id) : null },
  };
}

export async function action({ request, url, context }: Route.ActionArgs) {
  const viewer = await viewerOf(context);
  if (!viewer) return { error: "Sign in first." };
  if (!(await withinLimits(request, "signin", viewer.id))) return { error: RATE_LIMITED_MESSAGE };
  const form = await request.formData();
  const read = await readAuthorization(env.DB, url.searchParams, { now: now(), origin: url.origin });
  if (!read.ok && "show" in read) return { error: read.show };
  if (!read.ok) {
    const { uri, error, description, state } = read.redirect;
    return { continueTo: answerUrl(uri, { error, error_description: description, state, iss: url.origin }) };
  }
  const { redirectUri, state } = read.request;
  if (form.get("intent") !== "allow") {
    return {
      continueTo: answerUrl(redirectUri, { error: "access_denied", error_description: "The connection was not allowed.", state, iss: url.origin }),
    };
  }
  const code = await issueCode(env.DB, read.request, viewer.id, now());
  return { continueTo: answerUrl(redirectUri, { code, state, iss: url.origin }) };
}

/**
 * Where an app such as Claude or ChatGPT asks to manage the person's pages.
 * Allowing it hands the app a code it trades for an API token, revocable in
 * Settings. The way back is followed by the page: a form cannot redirect to
 * another site under the form-action policy.
 */
export default function Authorize({ loaderData, actionData }: Route.ComponentProps) {
  const navigation = useNavigation();
  const busy = navigation.state !== "idle";
  const continueTo = actionData && "continueTo" in actionData ? actionData.continueTo : null;

  useEffect(() => {
    if (continueTo) window.location.assign(continueTo);
  }, [continueTo]);

  if (loaderData.state === "invalid") {
    return (
      <main className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center gap-3 px-5 py-12 text-center">
        <h1 className="text-xl font-semibold">This connection cannot go ahead</h1>
        <p className="text-text-muted">{loaderData.message}</p>
      </main>
    );
  }

  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center gap-5 px-5 py-12">
      <div className="text-center">
        <h1 className="text-2xl font-semibold">Connect {loaderData.client.name}?</h1>
        <p className="mt-2 text-text-muted">
          It will be able to read, create, change, publish and delete the pages of <strong className="text-text">{loaderData.account}</strong>,
          until you disconnect it in Settings.
        </p>
      </div>
      <dl className="rounded border border-border bg-surface px-4 py-3 text-sm">
        <div className="flex justify-between gap-3">
          <dt className="text-text-muted">Returns to</dt>
          <dd className="font-medium">{loaderData.client.returnsTo}</dd>
        </div>
        {loaderData.client.vouchedBy ? (
          <div className="mt-1 flex justify-between gap-3">
            <dt className="text-text-muted">Described by</dt>
            <dd className="font-medium">{loaderData.client.vouchedBy}</dd>
          </div>
        ) : null}
      </dl>
      {actionData && "error" in actionData ? (
        <p role="alert" className="rounded bg-danger-soft px-4 py-3 text-sm text-danger">
          {actionData.error}
        </p>
      ) : null}
      {continueTo ? (
        <p className="text-center text-text-muted">
          Returning to the app… <a className="text-link" href={continueTo}>Continue</a>
        </p>
      ) : (
        <Form method="post" className="flex gap-2">
          <button type="submit" name="intent" value="deny" className="btn flex-1 py-2.5" disabled={busy}>
            Cancel
          </button>
          <button type="submit" name="intent" value="allow" className="btn btn-primary flex-1 py-2.5" disabled={busy}>
            Connect
          </button>
        </Form>
      )}
    </main>
  );
}
