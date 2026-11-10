import { env } from "cloudflare:workers";
import { Copy, KeyRound, Trash2 } from "lucide-react";
import { useState } from "react";
import { Form, useNavigation } from "react-router";

import { linkGoogle } from "~/lib/auth.server";
import { unlinkTelegram } from "~/lib/db/accounts.server";
import { issueTelegramToken } from "~/lib/db/telegram-tokens.server";
import { createToken, listTokens, MAX_TOKENS, revokeToken } from "~/lib/db/tokens.server";
import { privateMeta } from "~/lib/meta";
import { RATE_LIMITED_MESSAGE, withinLimits } from "~/lib/security/rate-limit.server";
import { requireAccount } from "~/lib/viewer.server";

import type { Route } from "./+types/app-settings";

export function meta() {
  return privateMeta("Settings");
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const account = await requireAccount(request, context);
  const tokens = await listTokens(env.DB, account.id);
  return {
    origin: new URL(request.url).origin,
    bot: env.TELEGRAM_BOT_USERNAME,
    linked: new URL(request.url).searchParams.get("linked"),
    account: {
      name: account.name,
      email: account.email,
      google: account.google,
      telegram: account.telegram ? { username: account.telegram.username, name: account.telegram.name } : null,
    },
    tokens: tokens.filter((token) => !token.app),
    apps: tokens.filter((token) => token.app),
    maxTokens: MAX_TOKENS,
  };
}

type Result = { message?: string; error?: string; token?: string; telegramLink?: string };

export async function action({ request, context }: Route.ActionArgs): Promise<Result | Response> {
  const account = await requireAccount(request, context);
  if (!(await withinLimits(request, "write", account.id))) return { error: RATE_LIMITED_MESSAGE };
  const form = await request.formData();
  const now = Math.floor(Date.now() / 1000);
  switch (form.get("intent")) {
    case "create_token": {
      const token = await createToken(env.DB, { userId: account.id, label: String(form.get("label") ?? ""), now });
      return token ? { token } : { error: `You can hold up to ${MAX_TOKENS} tokens. Revoke one first.` };
    }
    case "revoke": {
      await revokeToken(env.DB, { userId: account.id, tokenId: String(form.get("id") ?? ""), now });
      return { message: "Revoked." };
    }
    case "link_telegram": {
      // The bot confirms the link: the Telegram account that opens it is the one linked.
      const token = await issueTelegramToken(env.DB, { userId: account.id, purpose: "link", now });
      return { telegramLink: `https://t.me/${env.TELEGRAM_BOT_USERNAME}?start=link_${token}` };
    }
    case "unlink_telegram":
      return (await unlinkTelegram(env.DB, account.id))
        ? { message: "Telegram unlinked." }
        : { error: "Link Google first: without it you could not sign in any more." };
    case "link_google": {
      const response = await linkGoogle(request);
      return response ?? { error: "Google could not be reached. Try again." };
    }
    default:
      return { error: "Unknown action." };
  }
}

function date(seconds: number | null): string {
  return seconds ? new Date(seconds * 1000).toLocaleDateString("en", { year: "numeric", month: "short", day: "numeric" }) : "never";
}

export default function Settings({ loaderData, actionData }: Route.ComponentProps) {
  const busy = useNavigation().state !== "idle";
  const result = actionData as Result | undefined;
  const [copied, setCopied] = useState(false);
  const { account } = loaderData;

  return (
    <main className="mx-auto flex w-full max-w-column flex-col gap-8">
      <h1 className="text-2xl font-semibold">Settings</h1>
      {result?.error ? (
        <p role="alert" className="rounded-xl bg-danger-soft px-4 py-3 text-sm text-danger">
          {result.error}
        </p>
      ) : null}
      {result?.message || loaderData.linked === "google" ? (
        <p role="status" className="rounded-xl bg-accent-soft px-4 py-3 text-sm">
          {result?.message ?? "Google linked."}
        </p>
      ) : null}

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">Account</h2>
        <div className="rounded-2xl border border-border bg-surface px-4 py-3">
          <p className="font-medium">{account.name}</p>
          <p className="text-sm text-text-muted">{account.email ?? "No email: link Google to add one."}</p>
        </div>
        <div className="flex flex-col divide-y divide-border rounded-2xl border border-border bg-surface">
          <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
            <div>
              <p className="font-medium">Google</p>
              <p className="text-sm text-text-muted">{account.google ? "Linked: sign in with it." : "Not linked."}</p>
            </div>
            {account.google ? null : (
              <Form method="post">
                <input type="hidden" name="intent" value="link_google" />
                <button type="submit" className="btn" disabled={busy}>
                  Link Google
                </button>
              </Form>
            )}
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
            <div>
              <p className="font-medium">Telegram</p>
              <p className="text-sm text-text-muted">
                {account.telegram
                  ? `Linked${account.telegram.username ? ` as @${account.telegram.username}` : ""}: sign in with it and edit from @${loaderData.bot}.`
                  : `Not linked. Link it to sign in with Telegram and edit from @${loaderData.bot}.`}
              </p>
            </div>
            {account.telegram ? (
              account.google ? (
                <Form method="post">
                  <input type="hidden" name="intent" value="unlink_telegram" />
                  <button type="submit" className="btn btn-quiet" disabled={busy}>
                    Unlink
                  </button>
                </Form>
              ) : null
            ) : result?.telegramLink ? (
              <a href={result.telegramLink} className="btn btn-primary" target="_blank" rel="noopener">
                Open Telegram to confirm
              </a>
            ) : (
              <Form method="post">
                <input type="hidden" name="intent" value="link_telegram" />
                <button type="submit" className="btn" disabled={busy}>
                  Link Telegram
                </button>
              </Form>
            )}
          </div>
        </div>
        <Form method="post" action="/signout">
          <button type="submit" className="btn">
            Sign out
          </button>
        </Form>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">Agents and API</h2>
        <p className="text-text-muted">
          Connect Claude, ChatGPT or another MCP client to <code className="rounded bg-surface-2 px-1">{loaderData.origin}/mcp</code>, or use the{" "}
          <a className="text-accent underline" href="/api/v1">
            HTTP API
          </a>{" "}
          with a token. <a className="text-accent underline" href="/agents">How to connect</a>.
        </p>

        {loaderData.apps.length > 0 ? (
          <div className="flex flex-col gap-2">
            <h3 className="font-medium">Connected apps</h3>
            <ul className="flex flex-col divide-y divide-border rounded-2xl border border-border bg-surface">
              {loaderData.apps.map((app) => (
                <TokenRow key={app.id} id={app.id} label={app.label ?? "An app"} created={date(app.createdAt)} used={date(app.lastUsedAt)} busy={busy} />
              ))}
            </ul>
          </div>
        ) : null}

        <div className="flex flex-col gap-2">
          <h3 className="font-medium">API tokens</h3>
          {result?.token ? (
            <div className="flex flex-col gap-2 rounded-2xl border border-accent bg-accent-soft px-4 py-3">
              <p className="text-sm">Copy your token now: it is shown only once.</p>
              <div className="flex gap-2">
                <code className="min-w-0 flex-1 truncate rounded-lg bg-surface px-3 py-2 text-sm">{result.token}</code>
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    void navigator.clipboard.writeText(result.token!).then(() => setCopied(true));
                  }}
                >
                  <Copy size={16} aria-hidden /> {copied ? "Copied" : "Copy"}
                </button>
              </div>
            </div>
          ) : null}
          {loaderData.tokens.length > 0 ? (
            <ul className="flex flex-col divide-y divide-border rounded-2xl border border-border bg-surface">
              {loaderData.tokens.map((token) => (
                <TokenRow key={token.id} id={token.id} label={token.label ?? "Token"} created={date(token.createdAt)} used={date(token.lastUsedAt)} busy={busy} />
              ))}
            </ul>
          ) : null}
          {loaderData.tokens.length < loaderData.maxTokens ? (
            <Form method="post" className="flex gap-2">
              <input type="hidden" name="intent" value="create_token" />
              <input name="label" placeholder="What it is for" maxLength={60} className="field min-w-0 flex-1" />
              <button type="submit" className="btn" disabled={busy}>
                <KeyRound size={16} aria-hidden /> Make a token
              </button>
            </Form>
          ) : null}
        </div>
      </section>
    </main>
  );
}

function TokenRow({ id, label, created, used, busy }: { id: string; label: string; created: string; used: string; busy: boolean }) {
  return (
    <li className="flex items-center justify-between gap-3 px-4 py-3">
      <div className="min-w-0">
        <p className="truncate font-medium">{label}</p>
        <p className="text-sm text-text-muted">
          Made {created} · last used {used}
        </p>
      </div>
      <Form method="post">
        <input type="hidden" name="intent" value="revoke" />
        <input type="hidden" name="id" value={id} />
        <button type="submit" className="btn btn-quiet btn-danger" disabled={busy} aria-label={`Revoke ${label}`}>
          <Trash2 size={16} aria-hidden /> Revoke
        </button>
      </Form>
    </li>
  );
}
