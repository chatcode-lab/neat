import { data, redirect } from "react-router";

import { safeReturnPath } from "~/lib/security/request";
import { parseTheme, themeCookie } from "~/lib/theme";

import type { Route } from "./+types/theme";

/**
 * Remembers the theme choice. Called by the header's theme switch: by the
 * running app, which applies it at once, or as a plain form from a page sent
 * without scripts, which is sent back to where it was.
 */
export async function action({ request, url }: Route.ActionArgs) {
  const form = await request.formData();
  const theme = parseTheme(form.get("theme"));
  const headers = { "Set-Cookie": themeCookie(theme, url.protocol === "https:") };

  if (request.headers.get("Sec-Fetch-Mode") === "navigate") {
    let back = "/";
    try {
      const from = new URL(request.headers.get("Referer") ?? "");
      if (from.origin === url.origin) back = `${from.pathname}${from.search}`;
    } catch {
      // No usable Referer: the home page.
    }
    return redirect(safeReturnPath(back, url.origin), { headers });
  }
  return data({ theme }, { headers });
}
