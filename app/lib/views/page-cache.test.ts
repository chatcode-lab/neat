import { describe, expect, it } from "vitest";

import { isShareablePage, pageCacheKey, STATIC_PAGE_HEADER } from "./page-cache";

const key = (path: string, init: RequestInit = {}) => {
  const request = new Request(`https://neat.link${path}`, init);
  return pageCacheKey(request, new URL(request.url), "b1");
};

describe("page cache", () => {
  it("keys pages for visitors without an account by theme and build, not query", () => {
    expect(key("/adalove?utm_source=x")).toBe("https://neat.link/__page/b1/adalove?theme=system");
    expect(key("/", { headers: { Cookie: "theme=dark" } })).toBe("https://neat.link/__page/b1/?theme=dark");
  });

  it("leaves out signed-in visitors, writes, data requests and other addresses", () => {
    expect(key("/adalove", { headers: { Cookie: "theme=dark; __Secure-better-auth.session_token=abc" } })).toBeNull();
    expect(key("/adalove", { method: "POST" })).toBeNull();
    expect(key("/adalove.data")).toBeNull();
    expect(key("/adalove.md")).toBeNull();
    expect(key("/app/settings")).toBeNull();
    expect(key("/AdaLove")).toBeNull();
  });

  it("keeps only complete static pages that set no cookie", () => {
    const page = (status: number, headers: Record<string, string>) => new Response("<html>", { status, headers });
    const html = { "Content-Type": "text/html", [STATIC_PAGE_HEADER]: "1" };
    expect(isShareablePage(page(200, html))).toBe(true);
    expect(isShareablePage(page(404, html))).toBe(false);
    expect(isShareablePage(page(200, { "Content-Type": "text/html" }))).toBe(false);
    expect(isShareablePage(page(200, { ...html, "Set-Cookie": "a=b" }))).toBe(false);
  });
});
