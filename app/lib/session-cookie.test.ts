import { describe, expect, it } from "vitest";

import { renewalCookie } from "./session-cookie";

const renewed = (token: string, name = "__Secure-better-auth.session_token") =>
  `${name}=${encodeURIComponent(`${token}.c2lnbmF0dXJl`)}; Max-Age=2592000; Path=/; HttpOnly; Secure; SameSite=Lax`;

describe("renewed session cookies", () => {
  it("keep a Mini App session framed: SameSite=None and partitioned", () => {
    expect(renewalCookie(renewed("mini_abc"))).toBe(
      `__Secure-better-auth.session_token=${encodeURIComponent("mini_abc.c2lnbmF0dXJl")}; Max-Age=2592000; Path=/; HttpOnly; Secure; SameSite=None; Partitioned`,
    );
  });

  it("leave every other cookie as Better Auth wrote it", () => {
    expect(renewalCookie(renewed("abc"))).toBe(renewed("abc"));
    expect(renewalCookie(renewed("mini_abc", "better-auth.session_token"))).toBe(renewed("mini_abc", "better-auth.session_token"));
    expect(renewalCookie("theme=dark; Path=/")).toBe("theme=dark; Path=/");
  });
});
