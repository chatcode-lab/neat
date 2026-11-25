import type { Site } from "../db/sites.server";
import { hasPixels, type Pixels, pixelVendorsOf } from "../pixels";
import { allows } from "../plans";
import { PIXELS_HEADER } from "./page-cache";

/**
 * What a site's pages carry besides their content, by its owner's plan:
 * their tracking pixels and the neat.link sign. Settings stay when a plan
 * ends; they stop applying until it is back.
 *
 * Pixels load only on pages anyone may find (`tracked`): never on a private
 * link, whose address is what lets one in and which analytics would record
 * with every view, nor on a draft only its owner can see.
 */
export function siteExtras(site: Site, tracked: boolean): { pixels: Pixels | null; branding: boolean; headers: Record<string, string> } {
  const pixels = tracked && allows(site.ownerPlan, "pixels") && hasPixels(site.pixels) ? site.pixels : null;
  return {
    pixels,
    branding: site.branding || !allows(site.ownerPlan, "branding"),
    headers: pixels ? { [PIXELS_HEADER]: pixelVendorsOf(pixels).join(" ") } : {},
  };
}
