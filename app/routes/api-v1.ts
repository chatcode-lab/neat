import { handleApi } from "~/lib/api/v1.server";

import type { Route } from "./+types/api-v1";

/** The HTTP API, for agents and scripts: its guide at /api/v1, its endpoints below it. */
export function loader({ request, params }: Route.LoaderArgs) {
  return handleApi(request, params["*"] ?? "");
}

export function action({ request, params }: Route.ActionArgs) {
  return handleApi(request, params["*"] ?? "");
}
