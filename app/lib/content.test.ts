import { describe, expect, it } from "vitest";

import { linkKind, normalizeButtonUrl, parseButtons, storedButtons } from "./buttons";
import { handleProblem, normalizeHandle } from "./handles";
import { markdownToText, renderMarkdown, summary } from "./markdown";
import { telegramToCommonMark } from "./tg-markdown";

describe("handles", () => {
  it("reduces addresses and mentions to the handle", () => {
    expect(normalizeHandle(" https://www.neat.link/Elon/ ")).toBe("elon");
    expect(normalizeHandle("neat.link/elon?x=1")).toBe("elon");
    expect(normalizeHandle("@Durov")).toBe("durov");
  });

  it("keeps the legacy shape and reserved names", () => {
    expect(handleProblem("lovelace")).toBeNull();
    expect(handleProblem("tractor_fm")).toBeNull();
    expect(handleProblem("1abcdef")).toMatch(/starts with a letter/);
    expect(handleProblem("abcdef_")).toMatch(/does not end with _/);
    expect(handleProblem("signin")).toBe("That handle is reserved.");
    expect(handleProblem("settings")).toBe("That handle is reserved.");
    expect(handleProblem("a".repeat(33))).toMatch(/at most 32/);
  });

  it("allows a short handle only when it is the owner's Telegram username", () => {
    expect(handleProblem("durov")).toMatch(/at least 6/);
    expect(handleProblem("durov", { telegramUsername: "Durov" })).toBeNull();
  });
});

describe("buttons", () => {
  it("normalizes what people type", () => {
    expect(normalizeButtonUrl("t.me/neatlink")).toBe("https://t.me/neatlink");
    expect(normalizeButtonUrl("t.me/@firdavs_en10")).toBe("https://t.me/firdavs_en10");
    expect(normalizeButtonUrl("www.instagram.com/neat.link")).toBe("https://www.instagram.com/neat.link");
    expect(normalizeButtonUrl("hey@neat.link")).toBe("mailto:hey@neat.link");
    expect(normalizeButtonUrl("+1 (234) 567-8901")).toBe("tel:+12345678901");
    expect(normalizeButtonUrl("https://wa.me/+12345678901")).toBe("https://wa.me/+12345678901");
    expect(normalizeButtonUrl("http://atelierjr.net")).toBe("http://atelierjr.net/");
  });

  it("refuses addresses that are not links", () => {
    expect(normalizeButtonUrl("javascript:alert(1)")).toBeNull();
    expect(normalizeButtonUrl("data:text/html,hi")).toBeNull();
    expect(normalizeButtonUrl("localhost")).toBeNull();
    expect(normalizeButtonUrl("not a link")).toBeNull();
    expect(normalizeButtonUrl("https://user:pass@example.com")).toBeNull();
  });

  it("knows services by their domain", () => {
    expect(linkKind("https://t.me/x")).toBe("telegram");
    expect(linkKind("https://www.instagram.com/x")).toBe("instagram");
    expect(linkKind("https://x.com/x")).toBe("x");
    expect(linkKind("https://www.linkedin.com/in/x")).toBe("linkedin");
    expect(linkKind("mailto:a@b.co")).toBe("email");
    expect(linkKind("tel:+1234567")).toBe("phone");
    expect(linkKind("https://example.com")).toBe("link");
  });

  it("checks a list and names the button at fault", () => {
    expect(parseButtons([{ label: " Telegram ", url: "t.me/x" }])).toEqual({
      ok: true,
      buttons: [{ label: "Telegram", url: "https://t.me/x" }],
    });
    expect(parseButtons([{ label: "ok", url: "t.me/x" }, { label: "", url: "t.me/y" }])).toEqual({
      ok: false,
      problem: "Button 2 needs a label.",
    });
    expect(parseButtons("nope")).toMatchObject({ ok: false });
    expect(storedButtons('[{"label":"a","url":"https://a.co"},{"x":1}]')).toEqual([{ label: "a", url: "https://a.co" }]);
  });
});

describe("markdown", () => {
  it("renders CommonMark without raw HTML", () => {
    const html = renderMarkdown("**Hi** <script>alert(1)</script>\nnext line");
    expect(html).toContain("<strong>Hi</strong>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("<br>");
  });

  it("opens outside links safely and refuses script links", () => {
    expect(renderMarkdown("[a](https://a.co)")).toContain('target="_blank" rel="nofollow ugc noopener"');
    expect(renderMarkdown("[a](javascript:alert(1))")).not.toContain("href");
    expect(renderMarkdown("see https://a.co")).toContain('href="https://a.co"');
  });

  it("makes plain text for descriptions", () => {
    expect(markdownToText("# Title\n\n**Bold** and [link](https://a.co)\nline two")).toBe("Title\nBold and link\nline two");
    expect(summary("word ".repeat(100), 20)).toBe("word word word word…");
  });
});

describe("Telegram MarkdownV2 to CommonMark", () => {
  it("removes MarkdownV2 escapes", () => {
    expect(telegramToCommonMark("Hi\\! This is my fancy [neat\\.link](https://neat\\.link) page\\.")).toBe(
      "Hi! This is my fancy [neat.link](https://neat.link) page.",
    );
    expect(telegramToCommonMark("😂 \\- 🔥 \\- 💀")).toBe("😂 - 🔥 - 💀");
  });

  it("rewrites formatting", () => {
    expect(telegramToCommonMark("*The best things \\[in life\\] are not things\\.*")).toBe(
      "**The best things \\[in life\\] are not things.**",
    );
    expect(telegramToCommonMark("_it_ ~gone~ __under__ ||secret|| `x_y`")).toBe("*it* ~~gone~~ under secret `x_y`");
    expect(telegramToCommonMark("*bold *and")).toBe("**bold** and");
  });

  it("keeps plain underscores and unclosed markers readable", () => {
    expect(telegramToCommonMark("https://t\\.me/\\+8B\\_lauXc\\_1MwY2Iy \\- чатик")).toBe("https://t.me/+8B_lauXc_1MwY2Iy - чатик");
    expect(telegramToCommonMark("2 * 3")).toBe("2 \\* 3");
  });

  it("renders as the bot showed it", () => {
    const html = renderMarkdown(telegramToCommonMark("*Face with Tears of Joy*\nThe universal emoji\\."));
    expect(html).toContain("<strong>Face with Tears of Joy</strong><br>");
  });
});
