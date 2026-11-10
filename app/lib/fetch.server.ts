/**
 * A response body read up to `maxBytes` and no further, or null when it is
 * longer. Nothing past the limit is downloaded.
 */
export async function readCapped(response: Response, maxBytes: number): Promise<Uint8Array<ArrayBuffer> | null> {
  const declared = Number(response.headers.get("Content-Length") ?? "0");
  if (declared > maxBytes) {
    await response.body?.cancel();
    return null;
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

/**
 * Whether the server may fetch this address for someone: https on the
 * default port, a public DNS name, never an address literal, a local name,
 * or this site itself. Workers cannot reach private networks anyway; this
 * keeps requests to where a user could point a browser.
 */
export function isFetchableUrl(raw: string, ownHosts: readonly string[] = []): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.port || url.username || url.password) return false;
  const host = url.hostname.toLowerCase();
  if (!host.includes(".") || host.endsWith(".")) return false;
  if (/^[\d.]+$/.test(host) || host.startsWith("[")) return false;
  if (/(^|\.)(localhost|local|internal|lan|home|arpa|invalid|test|example)$/.test(host)) return false;
  return !ownHosts.some((own) => host === own || host.endsWith(`.${own}`));
}

/**
 * Fetches a public address with a time limit and no redirects followed
 * blindly: up to three, each checked like the first.
 */
export async function fetchPublic(
  raw: string,
  init: { accept: string; ownHosts?: readonly string[]; timeoutMs?: number },
): Promise<Response | null> {
  let address = raw;
  for (let hop = 0; hop < 4; hop += 1) {
    if (!isFetchableUrl(address, init.ownHosts)) return null;
    let response: Response;
    try {
      response = await fetch(address, {
        headers: { Accept: init.accept, "User-Agent": "Mozilla/5.0 (compatible; neat.link/1.0; +https://neat.link/agents)" },
        redirect: "manual",
        signal: AbortSignal.timeout(init.timeoutMs ?? 8000),
      });
    } catch {
      return null;
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("Location");
      await response.body?.cancel();
      if (!location) return null;
      address = new URL(location, address).href;
      continue;
    }
    return response;
  }
  return null;
}
