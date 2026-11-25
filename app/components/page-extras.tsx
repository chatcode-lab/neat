import type { Pixels } from "~/lib/pixels";

/**
 * The owner's tracking pixels, loaded by /pixels.js from the IDs on its tag.
 * The page's Content Security Policy lets in only these vendors.
 */
export function PixelScript({ pixels }: { pixels: Pixels | null }) {
  if (!pixels || Object.keys(pixels).length === 0) return null;
  return <script src="/pixels.js" defer data-google={pixels.google} data-meta={pixels.meta} data-tiktok={pixels.tiktok} />;
}

/** The neat.link sign at the bottom of a site's pages, unless a Pro owner hid it. */
export function PageFooter({ origin, host, branding }: { origin: string; host: string; branding: boolean }) {
  if (!branding) return null;
  return (
    <footer className="pt-14 text-center text-xs text-text-faint">
      <a href={`${origin}/`} className="inline-flex items-center gap-1 hover:text-text-muted">
        <span aria-hidden>⎆</span> {host}
      </a>
    </footer>
  );
}
