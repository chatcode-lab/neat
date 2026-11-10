/**
 * A request body as text, read up to `maxBytes` and no further: a body that
 * says or turns out to be longer is cancelled as soon as it passes the
 * limit, and the answer is null. Nothing is buffered beyond the limit,
 * whether or not the request declared its length.
 */
export async function readBodyCapped(request: Request, maxBytes: number): Promise<string | null> {
  const declared = Number(request.headers.get("Content-Length") ?? "0");
  if (declared > maxBytes) {
    await request.body?.cancel();
    return null;
  }
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

/**
 * A small JSON body, such as a sign-in check, read up to `maxBytes`;
 * undefined when it is longer or not JSON.
 */
export async function readSmallJson(
  request: Request,
  maxBytes = 2048,
): Promise<unknown> {
  const text = await readBodyCapped(request, maxBytes);
  if (text === null) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * A form body read up to `maxBytes`, or null when it is longer. Forms here
 * carry text only.
 */
export async function readSmallForm(request: Request, maxBytes: number): Promise<FormData | null> {
  const text = await readBodyCapped(request, maxBytes);
  if (text === null) return null;
  return new Response(text, { headers: { "Content-Type": request.headers.get("Content-Type") ?? "" } }).formData();
}

/** The shape of every row ID the site makes. */
export const ROW_ID = /^[A-Za-z0-9_-]{1,32}$/;

/**
 * A request body as bytes, such as an uploaded picture, read up to
 * `maxBytes`; null when it is longer.
 */
export async function readBytesCapped(request: Request, maxBytes: number): Promise<Uint8Array<ArrayBuffer> | null> {
  const declared = Number(request.headers.get("Content-Length") ?? "0");
  if (declared > maxBytes) {
    await request.body?.cancel();
    return null;
  }
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** The most any request body may be, above every endpoint's own limit, so their own answers come first. */
export const BODY_LIMIT = 512 * 1024;

/** Picture uploads: the editor's form and the API's picture endpoint, 8 MB and a margin. */
export const UPLOAD_BODY_LIMIT = 8 * 1024 * 1024 + 128 * 1024;

const UPLOAD_PATHS = [/^\/app\/sites\/[^/]+(?:\.data)?$/, /^\/api\/v1\/sites\/[^/]+\/picture$/];

/** The name of the error a reader of a body over its limit gets. */
export const BODY_OVER_LIMIT = "BodyOverLimit";

/** How much of a request body this path may read. */
export function bodyLimit(pathname: string): number {
  return UPLOAD_PATHS.some((pattern) => pattern.test(pathname)) ? UPLOAD_BODY_LIMIT : BODY_LIMIT;
}

/**
 * The request with its body cut off at `maxBytes`: reading past the limit
 * fails, so whatever parses the body (an action's formData(), better-auth)
 * never buffers more, declared length or not. Nothing is read until someone
 * reads it, so a request turned away first costs nothing. `overLimit` says
 * afterwards whether the body was cut off, so the answer can be a 413
 * whatever the reader made of the failure.
 */
export function capRequestBody(request: Request, maxBytes: number): { request: Request; overLimit: () => boolean } {
  if (!request.body) return { request, overLimit: () => false };
  let size = 0;
  let over = false;
  const body = request.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        size += chunk.byteLength;
        if (size > maxBytes) {
          over = true;
          const error = new RangeError("The request body is over its limit.");
          error.name = BODY_OVER_LIMIT;
          controller.error(error);
        } else controller.enqueue(chunk);
      },
    }),
  );
  // Node's Request needs duplex for a streamed body; Workers ignore it.
  return { request: new Request(request, { body, duplex: "half" } as RequestInit), overLimit: () => over };
}

/** The answer to a body over its limit: JSON for the API and MCP, text elsewhere. */
export function tooLarge(json: boolean): Response {
  const message = "That is more than this address accepts.";
  const headers = { "Cache-Control": "no-store" };
  return json
    ? Response.json({ error: "too_large", message }, { status: 413, headers })
    : new Response(`${message}\n`, { status: 413, headers: { ...headers, "Content-Type": "text/plain; charset=utf-8" } });
}
