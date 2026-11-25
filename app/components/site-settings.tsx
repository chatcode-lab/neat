import { Copy, ExternalLink, Globe, Lock, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { Form, Link, useFetcher } from "react-router";

import type { DomainJson } from "~/lib/domain-setup.server";
import { PIXEL_VENDOR_IDS, PIXEL_VENDORS, type Pixels } from "~/lib/pixels";

function Upsell({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-sm text-text-muted">
      {children}{" "}
      <Link className="text-link" to="/app/plan">
        See plans
      </Link>
    </p>
  );
}

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="btn btn-quiet h-8 shrink-0 px-2"
      aria-label={`Copy ${value}`}
      onClick={() => void navigator.clipboard.writeText(value).then(() => setCopied(true))}
    >
      <Copy size={14} aria-hidden /> {copied ? "Copied" : "Copy"}
    </button>
  );
}

const STATUS: Record<DomainJson["status"], string> = {
  pending: "Waiting for DNS",
  issuing_certificate: "Setting up: usually a few minutes",
  live: "Live",
};

/** How often the editor checks a waiting domain, and for how long. */
const CHECK_EVERY_MS = 20_000;
const CHECKS = 30;

/**
 * A site's own domain: connect one, see the DNS records to add while it
 * waits (checked every 20 seconds while the page is open, and hourly
 * after), and disconnect it.
 */
export function DomainPanel({ domain, allowed, busy }: { domain: DomainJson | null; allowed: boolean; busy: boolean }) {
  const check = useFetcher();
  const waiting = domain !== null && domain.status !== "live";
  useEffect(() => {
    if (!waiting) return;
    let left = CHECKS;
    const timer = setInterval(() => {
      if (left-- <= 0) return clearInterval(timer);
      if (document.visibilityState === "visible" && check.state === "idle") void check.submit({ intent: "check_domain" }, { method: "post" });
    }, CHECK_EVERY_MS);
    return () => clearInterval(timer);
    // The fetcher's state is read when the timer fires.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [waiting, domain?.hostname]);

  return (
    <section className="flex flex-col gap-3 rounded-md border border-border px-4 py-3">
      <h2 className="flex items-center gap-2 font-medium">
        <Globe size={16} aria-hidden /> Own domain
      </h2>
      {domain ? (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="min-w-0">
              <a className="text-link font-medium [overflow-wrap:anywhere]" href={domain.url} target="_blank" rel="noopener">
                {domain.hostname}
              </a>
              <p className={`text-sm ${domain.status === "live" ? "text-success" : "text-text-muted"}`}>{STATUS[domain.status]}</p>
            </div>
            <div className="flex gap-2">
              {waiting && allowed ? (
                <check.Form method="post">
                  <input type="hidden" name="intent" value="check_domain" />
                  <button type="submit" className="btn" disabled={check.state !== "idle"}>
                    <RefreshCw size={16} aria-hidden className={check.state !== "idle" ? "animate-spin" : ""} /> Check now
                  </button>
                </check.Form>
              ) : null}
              <Form method="post">
                <input type="hidden" name="intent" value="remove_domain" />
                <button type="submit" className="btn btn-quiet" disabled={busy}>
                  Disconnect
                </button>
              </Form>
            </div>
          </div>
          {domain.error ? <p className="text-sm text-danger">{domain.error}</p> : null}
          {domain.status === "pending" && domain.records.length > 0 ? (
            <div className="flex flex-col gap-2">
              <ul className="flex flex-col gap-2">
                {domain.records.map((record) => (
                  <li key={record.type} className="rounded border border-border bg-surface px-3 py-2 text-sm">
                    <p className="font-medium">
                      {record.type} {record.required ? null : <span className="font-normal text-text-faint">(if needed)</span>}
                    </p>
                    <div className="mt-1 grid gap-1 sm:grid-cols-[4rem_minmax(0,1fr)_auto] sm:items-center">
                      <span className="text-text-faint">Name</span>
                      <code className="truncate">{record.name}</code>
                      <CopyButton value={record.name} />
                      <span className="text-text-faint">Value</span>
                      <code className="truncate">{record.value}</code>
                      <CopyButton value={record.value} />
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {domain.notes.map((note) => (
            <p key={note} className="text-sm text-text-muted [overflow-wrap:anywhere]">
              {note}
            </p>
          ))}
        </div>
      ) : allowed ? (
        <Form method="post" className="flex flex-col gap-2">
          <input type="hidden" name="intent" value="set_domain" />
          <label className="flex flex-col gap-1.5">
            <span className="text-sm text-text-muted">
              Show this page at your own domain, such as www.yourname.com. A root domain (yourname.com) needs its DNS at Cloudflare.
            </span>
            <span className="flex gap-2">
              <input name="hostname" placeholder="www.yourname.com" required autoCapitalize="none" spellCheck={false} inputMode="url" className="field min-w-0 flex-1" />
              <button type="submit" className="btn" disabled={busy}>
                Connect
              </button>
            </span>
          </label>
        </Form>
      ) : (
        <Upsell>Show this page at your own domain: $10 once, or with Pro.</Upsell>
      )}
    </section>
  );
}

/** A site's Pro settings: tracking pixels, and whether its pages show the neat.link sign. */
export function ProPanel({ pixels, branding, allowed, busy }: { pixels: Pixels; branding: boolean; allowed: boolean; busy: boolean }) {
  return (
    <section className="flex flex-col gap-3 rounded-md border border-border px-4 py-3">
      <h2 className="flex items-center gap-2 font-medium">Pixels and sign</h2>
      {!allowed ? (
        <Upsell>Add Google, Meta or TikTok pixels and hide the neat.link sign with Pro.</Upsell>
      ) : (
        <Form method="post" className="flex flex-col gap-3">
          <input type="hidden" name="intent" value="save_pro" />
          {PIXEL_VENDOR_IDS.map((vendor) => (
            <label key={vendor} className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">{PIXEL_VENDORS[vendor].name}</span>
              <input
                name={`pixel_${vendor}`}
                defaultValue={pixels[vendor] ?? ""}
                placeholder={PIXEL_VENDORS[vendor].example}
                autoCapitalize="characters"
                spellCheck={false}
                className="field font-mono text-sm"
              />
            </label>
          ))}
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="branding" defaultChecked={branding} />
            Show the ⎆ neat.link sign at the bottom of the page
          </label>
          <p className="text-xs text-text-faint">
            Pixels load on this page and its subpages. Where visitors must agree to tracking first, as in the EU, asking them is up to you.
          </p>
          <button type="submit" className="btn self-start" disabled={busy}>
            Save
          </button>
        </Form>
      )}
    </section>
  );
}

export interface SubpageRow {
  id: string;
  title: string;
  url: string | null;
  privateUrl: string;
}

/** A site's subpages, made through an agent or the API for now. */
export function SubpagesPanel({ subpages, allowed }: { subpages: SubpageRow[]; allowed: boolean }) {
  return (
    <section className="flex flex-col gap-3 rounded-md border border-border px-4 py-3">
      <h2 className="font-medium">Subpages</h2>
      {subpages.length > 0 ? (
        <ul className="flex flex-col divide-y divide-border">
          {subpages.map((page) => (
            <li key={page.id} className="flex flex-col gap-0.5 py-2 text-sm">
              <span className="font-medium">{page.title}</span>
              {page.url ? (
                <a className="text-link flex items-start gap-1 [overflow-wrap:anywhere]" href={page.url} target="_blank" rel="noopener">
                  <ExternalLink size={12} aria-hidden className="mt-1 shrink-0" /> {page.url.replace(/^https?:\/\//, "")}
                </a>
              ) : null}
              <a className="flex items-start gap-1 text-text-muted [overflow-wrap:anywhere] hover:text-text" href={page.privateUrl} target="_blank" rel="noopener">
                <Lock size={12} aria-hidden className="mt-1 shrink-0" /> {page.privateUrl.replace(/^https?:\/\//, "")}
              </a>
            </li>
          ))}
        </ul>
      ) : null}
      {allowed ? (
        <p className="text-sm text-text-muted">
          Articles and other pages below this one, private by link or public and indexed. Write them with an agent (
          <Link className="text-link" to="/agents">
            connect one
          </Link>
          ) or the{" "}
          <a className="text-link" href="/api/v1">
            API
          </a>
          .
        </p>
      ) : (
        <Upsell>Add articles and other pages below this one with Pro.</Upsell>
      )}
    </section>
  );
}
