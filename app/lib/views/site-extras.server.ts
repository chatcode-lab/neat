import type { Site } from "../db/sites.server";
import { hasPixels, type Pixels, pixelVendorsOf } from "../pixels";
import { allows } from "../plans";
import { PIXELS_HEADER } from "./page-cache";

/**
 * What a site's pages carry besides their content, by its owner's plan:
 * their tracking pixels and the neat.link sign. Settings stay when a plan
 * ends; they stop applying until it is back.
 */
export function siteExtras(site: Site): { pixels: Pixels | null; branding: boolean; headers: Record<string, string> } {
  const pixels = allows(site.ownerPlan, "pixels") && hasPixels(site.pixels) ? site.pixels : null;
  return {
    pixels,
    branding: site.branding || !allows(site.ownerPlan, "branding"),
    headers: pixels ? { [PIXELS_HEADER]: pixelVendorsOf(pixels).join(" ") } : {},
  };
}
