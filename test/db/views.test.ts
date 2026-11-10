import { describe, expect, it } from "vitest";

import { llmsTxt } from "../../app/lib/views/seo.server";

describe("llms.txt", () => {
  it("names the bot this deployment answers as", () => {
    const text = llmsTxt("https://neat.link", "TestNeatBot");
    expect(text).toContain("the Telegram bot @TestNeatBot,");
    expect(text).not.toContain("${");
  });
});
