import { env } from "cloudflare:workers";
import { ExternalLink, Pencil, Plus } from "lucide-react";
import { Link } from "react-router";

import { MAX_SITES } from "~/lib/db/sites.server";
import { mediaUrl } from "~/lib/media.server";
import { privateMeta } from "~/lib/meta";
import { listSites } from "~/lib/sites.server";
import { requireAccount } from "~/lib/viewer.server";

import type { Route } from "./+types/app-home";

export function meta() {
  return privateMeta("My pages");
}

export async function loader({ request, url, context }: Route.LoaderArgs) {
  const account = await requireAccount(request, context);
  const sites = await listSites(account);
  return {
    host: url.host,
    welcome: url.searchParams.has("welcome"),
    canCreate: sites.length < MAX_SITES,
    maxSites: MAX_SITES,
    telegramLinked: Boolean(account.telegram),
    bot: env.TELEGRAM_BOT_USERNAME,
    sites: sites.map((site) => ({
      handle: site.handle,
      title: site.page.title,
      published: site.published,
      picture: site.page.imageKey ? mediaUrl(site.page.imageKey, url.origin) : null,
    })),
  };
}

export default function MyPages({ loaderData }: Route.ComponentProps) {
  const { sites } = loaderData;
  return (
    <main className="flex flex-col gap-5">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">My pages</h1>
        {loaderData.canCreate ? (
          <Link to="/app/new" className="btn btn-primary">
            <Plus size={16} aria-hidden /> New page
          </Link>
        ) : null}
      </div>
      {loaderData.welcome && sites.length === 0 ? (
        <p className="rounded bg-accent-soft px-4 py-3">
          Welcome to neat.link! Make your first page: pick an address, add a picture, a few lines and your links.
        </p>
      ) : null}
      {sites.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-md border border-dashed border-border-strong px-5 py-12 text-center">
          <p className="text-text-muted">You have no page yet.</p>
          <Link to="/app/new" className="btn btn-primary">
            Create your page
          </Link>
        </div>
      ) : (
        <ul className="flex flex-col gap-3">
          {sites.map((site) => (
            <li key={site.handle} className="flex items-center gap-4 rounded-md border border-border bg-surface px-4 py-3">
              {site.picture ? (
                <img src={site.picture} alt="" width={48} height={48} className="h-12 w-12 rounded-full object-cover" />
              ) : (
                <span className="h-12 w-12 rounded-full bg-surface-2" aria-hidden />
              )}
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">{site.title}</p>
                <p className="truncate text-sm text-text-muted">
                  {loaderData.host}/{site.handle}
                  {" · "}
                  <span className={site.published ? "text-success" : "text-text-faint"}>{site.published ? "Published" : "Draft"}</span>
                </p>
              </div>
              <a href={`/${site.handle}`} className="btn btn-quiet hidden sm:inline-flex" target="_blank" rel="noopener">
                <ExternalLink size={16} aria-hidden /> View
              </a>
              <Link to={`/app/sites/${site.handle}`} className="btn">
                <Pencil size={16} aria-hidden /> Edit
              </Link>
            </li>
          ))}
        </ul>
      )}
      {!loaderData.canCreate ? (
        <p className="text-sm text-text-faint">An account has up to {loaderData.maxSites} pages for now.</p>
      ) : null}
      {!loaderData.telegramLinked ? (
        <p className="text-sm text-text-muted">
          Tip: <Link className="text-link" to="/app/settings">link Telegram</Link> to edit your pages from @{loaderData.bot}.
        </p>
      ) : null}
    </main>
  );
}
