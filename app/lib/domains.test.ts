import { describe, expect, it } from "vitest";

import { isAppHost, siteMarkdownUrl, siteUrl, wwwTwin } from "./domains";

describe("own domains", () => {
  it("tells neat.link from a site's domain", () => {
    expect(isAppHost("neat.link", "https://neat.link")).toBe(true);
    expect(isAppHost("borkasm.com", "https://neat.link")).toBe(false);
    expect(isAppHost("www.neat.link", "https://neat.link")).toBe(false);
    expect(isAppHost("localhost", "https://neat.link")).toBe(true);
    // Without an app origin, as on staging, every host is the app.
    expect(isAppHost("neat-link-staging.example.workers.dev", "")).toBe(true);
  });

  it("pairs a domain with its www twin", () => {
    expect(wwwTwin("borkasm.com")).toBe("www.borkasm.com");
    expect(wwwTwin("www.borkasm.com")).toBe("borkasm.com");
  });

  it("makes the domain a site's canonical address", () => {
    expect(siteUrl({ handle: "borkasm", domain: "borkasm.com" }, "https://neat.link")).toBe("https://borkasm.com/");
    expect(siteMarkdownUrl({ handle: "borkasm", domain: "borkasm.com" }, "https://neat.link")).toBe("https://borkasm.com/index.md");
    expect(siteUrl({ handle: "durov", domain: null }, "https://neat.link")).toBe("https://neat.link/durov");
    expect(siteMarkdownUrl({ handle: "durov", domain: null }, "https://neat.link")).toBe("https://neat.link/durov.md");
  });
});
