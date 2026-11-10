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

/** The legacy pages' picture: a soft shadow and a translucent white ring. */
const AVATAR =
  "rounded-full border-[3px] border-[rgba(255,255,255,0.4)] object-cover shadow-[0_4px_8px_rgba(0,0,0,0.2),0_6px_20px_rgba(0,0,0,0.19)]";

/**
 * A page as visitors see it: one centred column with the round picture, the
 * title, the headline, the text and the buttons. The editor's preview draws
 * the same component, so what the owner sees is what is published.
 */
export function PageCard({ page, compact = false }: { page: PageCardData; compact?: boolean }) {
  return (
    <article className={`@container mx-auto flex w-full max-w-card flex-col items-center text-center ${compact ? "gap-3" : "gap-4"}`}>
      {page.picture ? (
        <img
          src={page.picture}
          alt=""
          width={144}
          height={144}
          // The picture is what a visitor sees first.
          fetchPriority="high"
          className={`${compact ? "h-24 w-24" : "h-36 w-36"} ${AVATAR}`}
        />
      ) : (
        <div
          aria-hidden
          className={`${compact ? "h-24 w-24 text-3xl" : "h-36 w-36 text-5xl"} ${AVATAR} flex items-center justify-center bg-surface-2 font-semibold text-text-muted`}
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
      {page.bodyHtml ? <div className="prose w-full text-text-muted" dangerouslySetInnerHTML={{ __html: page.bodyHtml }} /> : null}
      {page.buttons.length > 0 ? (
        // As wide as the longest label with room around it, as on the legacy
        // pages, once the card is wide enough; the full width when it is
        // narrow, as on a phone or in the editor's preview. The card's own
        // width decides, so every preview shows what a visitor would see.
        <ul className="mt-2 flex w-full max-w-full flex-col gap-3 @lg:w-auto @lg:min-w-72">
          {page.buttons.map((button, index) => {
            const kind = linkKind(button.url);
            const web = /^https?:/i.test(button.url);
            return (
              <li key={`${index}-${button.url}`}>
                <a
                  href={button.url}
                  {...(web ? { target: "_blank", rel: "me noopener" } : {})}
                  className={`page-button page-button-${kind} flex min-h-11 w-full items-center justify-center gap-2 rounded px-4 py-2 font-button text-lg font-medium @lg:px-24`}
                >
                  <span className="flex shrink-0">
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
