import { Monitor, Moon, Sun } from "lucide-react";
import { useFetcher } from "react-router";

import { parseTheme, type Theme } from "~/lib/theme";

/** Shared so the document can apply the choice before the server confirms. */
export const THEME_FETCHER_KEY = "theme";

const OPTIONS: Record<Theme, { label: string; Icon: typeof Sun; next: Theme }> = {
  system: { label: "System", Icon: Monitor, next: "light" },
  light: { label: "Light", Icon: Sun, next: "dark" },
  dark: { label: "Dark", Icon: Moon, next: "system" },
};

/** The theme currently in effect, counting a change still being saved. */
export function useTheme(saved: Theme | undefined): Theme {
  const fetcher = useFetcher({ key: THEME_FETCHER_KEY });
  return parseTheme(fetcher.formData?.get("theme") ?? saved);
}

/** One button that steps through System, Light and Dark. */
export function ThemeSwitch({ theme }: { theme: Theme }) {
  const fetcher = useFetcher({ key: THEME_FETCHER_KEY });
  const { label, Icon, next } = OPTIONS[theme];
  return (
    <fetcher.Form method="post" action="/theme">
      <input type="hidden" name="theme" value={next} />
      <button
        type="submit"
        className="btn btn-quiet h-9 w-9 p-0"
        aria-label={`Theme: ${label}. Switch to ${OPTIONS[next].label}.`}
        title={`Theme: ${label}`}
      >
        <Icon size={18} aria-hidden />
      </button>
    </fetcher.Form>
  );
}
