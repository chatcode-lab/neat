import type { EntryContext, HandleErrorFunction, RouterContextProvider } from "react-router";
import { isRouteErrorResponse, ServerRouter } from "react-router";
import { isbot } from "isbot";
import { renderToReadableStream } from "react-dom/server";

import { nonceContext } from "./context";
import { STATIC_PAGE_HEADER } from "./lib/views/page-cache";
import type { RouteHandle } from "./root";

export const streamTimeout = 5_000;

/**
 * A loader's, an action's, or a page's own error, logged as React Router
 * logs it by default; missing pages and abandoned requests are not errors.
 */
export const handleError: HandleErrorFunction = (error, { request }) => {
  if (request.signal.aborted) return;
  if (isRouteErrorResponse(error) && error.status < 500) return;
  // React Router's own error responses carry what caused them.
  console.error((isRouteErrorResponse(error) && (error as { error?: unknown }).error) || error);
};

export default async function handleRequest(
  request: Request,
  responseStatusCode: number,
  responseHeaders: Headers,
  routerContext: EntryContext,
  loadContext: RouterContextProvider,
) {
  // https://httpwg.org/specs/rfc9110.html#HEAD
  if (request.method.toUpperCase() === "HEAD") {
    return new Response(null, {
      status: responseStatusCode,
      headers: responseHeaders,
    });
  }

  // Inline scripts only run when they carry the nonce the Worker put in this
  // response's Content Security Policy.
  const nonce = loadContext.get(nonceContext);

  let shellRendered = false;
  let userAgent = request.headers.get("user-agent");

  const body = await renderToReadableStream(
    <ServerRouter context={routerContext} url={request.url} nonce={nonce} />,
    {
      nonce,
      signal: AbortSignal.timeout(streamTimeout + 1000),
      onError(error: unknown) {
        responseStatusCode = 500;
        // Log streaming rendering errors from inside the shell. Don't log
        // errors encountered during initial shell rendering since they'll
        // reject and get logged in handleDocumentRequest.
        if (shellRendered) {
          console.error(error);
        }
      },
    },
  );
  shellRendered = true;

  // Ensure requests from bots and SPA Mode renders wait for all content to load before responding
  // https://react.dev/reference/react-dom/server/renderToPipeableStream#waiting-for-all-content-to-load-for-crawlers-and-static-generation
  if ((userAgent && isbot(userAgent)) || routerContext.isSpaMode) {
    await body.allReady;
  }
  // A static page (no scripts, the same for every visitor without an
  // account) is sent whole, and marked so the Worker may keep it at the edge.
  const isStatic = routerContext.staticHandlerContext.matches.some(
    (match) => (match.route.handle as RouteHandle | undefined)?.static,
  );
  if (isStatic) {
    await body.allReady;
    responseHeaders.set(STATIC_PAGE_HEADER, "1");
  }

  responseHeaders.set("Content-Type", "text/html");
  return new Response(body, {
    headers: responseHeaders,
    status: responseStatusCode,
  });
}
