import { NavLink, Outlet } from "react-router";

import { requireAccount } from "~/lib/viewer.server";

import type { Route } from "./+types/app";

/** The editor: every page under /app needs a signed-in account. */
export async function loader({ request, context }: Route.LoaderArgs) {
  const account = await requireAccount(request, context);
  return { name: account.name };
}

const tab = ({ isActive }: { isActive: boolean }) =>
  `rounded px-3 py-1.5 text-sm font-medium ${isActive ? "bg-surface-2 text-text" : "text-text-muted hover:text-text"}`;

export default function Editor() {
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-1 flex-col px-4 py-6">
      <nav className="mb-6 flex gap-1" aria-label="Editor">
        <NavLink to="/app" end className={tab}>
          Pages
        </NavLink>
        <NavLink to="/app/settings" className={tab}>
          Settings
        </NavLink>
      </nav>
      <Outlet />
    </div>
  );
}
