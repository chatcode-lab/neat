import { describe, expect, it } from "vitest";

import { withSecurityHeaders } from "./headers";

const options = { nonce: "n", dev: false, indexable: true };
const secured = (headers: Record<string, string> = {}) =>
  withSecurityHeaders(new Request("https://neat.link/ada/x"), new Response("", { headers }), options).headers;

describe("security headers", () => {
  it("send only the origin as the referrer, unless the page asks to send none", () => {
    expect(secured().get("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
    expect(secured({ "Referrer-Policy": "unsafe-url" }).get("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
    expect(secured({ "Referrer-Policy": "no-referrer" }).get("Referrer-Policy")).toBe("no-referrer");
  });
});
