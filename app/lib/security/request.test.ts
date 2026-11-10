import { describe, expect, it } from "vitest";

import { newUserDestination } from "./request";

describe("a new account's first page", () => {
  it("is the editor's welcome, unless signing in was on the way elsewhere", () => {
    expect(newUserDestination("/app")).toBe("/app?welcome=1");
    expect(newUserDestination("/app/sites/ada")).toBe("/app?welcome=1");
    expect(newUserDestination("/app?x=1")).toBe("/app?welcome=1");
    const consent = "/oauth/authorize?client_id=c&redirect_uri=https%3A%2F%2Fapp.example%2Fcb&state=s";
    expect(newUserDestination(consent)).toBe(consent);
    expect(newUserDestination("/apple")).toBe("/apple");
  });
});
