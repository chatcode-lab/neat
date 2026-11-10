import { linkKind, type PageButton } from "~/lib/buttons";
import { initials } from "~/lib/og/cover";

import { LinkIcon } from "./link-icon";

export interface PageCardData {
  title: string;
  headline: string;
  /** The body, already rendered by renderMarkdown. */
  bodyHtml: string;
  buttons: PageButton[];
  picture: string | null;
}

/**
 * A page as visitors see it: one centred column with the round picture, the
 * title, the headline, the text and the buttons. The editor's preview draws
 * the same component, so what the owner sees is what is published.
 */
export function PageCard({ page, compact = false }: { page: PageCardData; compact?: boolean }) {
  return (
    <article className={`mx-auto flex w-full max-w-card flex-col items-center text-center ${compact ? "gap-3" : "gap-4"}`}>
      {page.picture ? (
        <img
          src={page.picture}
          alt=""
          width={144}
          height={144}
          className={`${compact ? "h-24 w-24" : "h-36 w-36"} rounded-full border border-border object-cover`}
        />
      ) : (
        <div
          aria-hidden
          className={`${compact ? "h-24 w-24 text-3xl" : "h-36 w-36 text-5xl"} flex items-center justify-center rounded-full bg-surface-2 font-semibold text-text-muted`}
        >
          {initials(page.title) || "⎆"}
        </div>
      )}
      <header className="flex flex-col gap-1">
        <h1 className={`${compact ? "text-2xl" : "text-3xl sm:text-4xl"} font-extrabold tracking-tight [overflow-wrap:anywhere]`}>
          {page.title}
        </h1>
        {page.headline ? <p className="text-lg text-text-muted">{page.headline}</p> : null}
      </header>
      {page.bodyHtml ? <div className="prose w-full" dangerouslySetInnerHTML={{ __html: page.bodyHtml }} /> : null}
      {page.buttons.length > 0 ? (
        <ul className="mt-2 flex w-full flex-col gap-3">
          {page.buttons.map((button, index) => {
            const kind = linkKind(button.url);
            const web = /^https?:/i.test(button.url);
            return (
              <li key={`${index}-${button.url}`}>
                <a
                  href={button.url}
                  {...(web ? { target: "_blank", rel: "me noopener" } : {})}
                  className="relative flex min-h-12 w-full items-center justify-center rounded-xl border border-border bg-surface px-12 py-2.5 font-button text-base shadow-[0_1px_0_var(--border)] transition-colors hover:border-border-strong hover:bg-surface-2"
                >
                  <span className="absolute left-4 flex text-text-muted">
                    <LinkIcon kind={kind} />
                  </span>
                  <span className="[overflow-wrap:anywhere]">{button.label}</span>
                </a>
              </li>
            );
          })}
        </ul>
      ) : null}
    </article>
  );
}
