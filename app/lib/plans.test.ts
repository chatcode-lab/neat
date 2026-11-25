import { describe, expect, it } from "vitest";

import { embedKind, sniffFile, storedName } from "./files";
import { domainProblem, normalizeDomain, subpageUrl } from "./domains";
import { providerOf } from "./dns-providers";
import { renderMarkdown } from "./markdown";
import { parsePixels } from "./pixels";
import { canBuy, planOf, priceLine } from "./plans";
import { buildSitePolicy } from "./security/csp";
import { pathFromTitle, subpagePathProblem } from "./subpages";

describe("plans", () => {
  it("add up running purchases to the best plan", () => {
    expect(planOf([])).toBe("free");
    expect(planOf(["domains"])).toBe("domains");
    expect(planOf(["domains", "pro_year"])).toBe("pro");
    expect(planOf(["pro_life"])).toBe("pro");
  });

  it("sell only what would add something", () => {
    expect(canBuy("domains", [])).toBe(true);
    expect(canBuy("domains", ["domains"])).toBe(false);
    expect(canBuy("pro_year", ["domains"])).toBe(true);
    expect(canBuy("domains", ["pro_year"])).toBe(false);
    expect(canBuy("pro_life", ["pro_year"])).toBe(true);
    expect(canBuy("pro_life", ["pro_life"])).toBe(false);
    expect(priceLine("pro_year")).toBe("$50 a year");
    expect(priceLine("domains")).toBe("$10 once");
  });
});

describe("pixels", () => {
  it("take IDs as vendors show them, and refuse anything else", () => {
    expect(parsePixels({ google: " g-abc1234 ", meta: "1234567890", tiktok: "c4abcdefgh12" })).toEqual({
      ok: true,
      pixels: { google: "G-ABC1234", meta: "1234567890", tiktok: "C4ABCDEFGH12" },
    });
    expect(parsePixels({ google: "<script>" }).ok).toBe(false);
    expect(parsePixels({ meta: "12ab" }).ok).toBe(false);
    expect(parsePixels({ linkedin: "x" }).ok).toBe(false);
    expect(parsePixels({ google: "" }, { google: "G-ABC1234", meta: "1234567890" })).toEqual({ ok: true, pixels: { meta: "1234567890" } });
  });

  it("open a page's policy to their vendors only", () => {
    const closed = buildSitePolicy({ nonce: "n" });
    expect(closed).not.toContain("facebook");
    expect(closed).toContain("frame-src 'none'");
    expect(closed).toContain("https://checkout.stripe.com");
    const open = buildSitePolicy({ nonce: "n", pixels: ["meta"] });
    expect(open).toContain("script-src 'self' 'nonce-n' https://telegram.org https://connect.facebook.net");
    expect(open).toContain("img-src 'self' data: blob: https://www.facebook.com");
    expect(open).not.toContain("googletagmanager");
  });
});

describe("files", () => {
  const bytes = (text: string, pad = 16) => {
    const out = new Uint8Array(Math.max(pad, text.length));
    out.set([...text].map((char) => char.charCodeAt(0)));
    return out;
  };

  it("are known by their first bytes", () => {
    expect(sniffFile(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]))?.type).toBe("image/jpeg");
    expect(sniffFile(bytes("RIFF\0\0\0\0WEBPVP8 "))?.type).toBe("image/webp");
    expect(sniffFile(bytes("\0\0\0\x18ftypisom"))?.type).toBe("video/mp4");
    expect(sniffFile(bytes("\0\0\0\x18ftypM4A "))?.type).toBe("audio/mp4");
    expect(sniffFile(bytes("\0\0\0\x18ftypheic"))).toBeNull();
    expect(sniffFile(bytes("ID3\x04\0\0\0\0\0\0\0\0"))?.type).toBe("audio/mpeg");
    expect(sniffFile(bytes("%PDF-1.7\n"))?.type).toBe("application/pdf");
    expect(sniffFile(bytes("<svg xmlns='http://www.w3.org/2000/svg'>"))).toBeNull();
    expect(sniffFile(bytes("<!doctype html><script>"))).toBeNull();
  });

  it("are named safely, with their type's own extension", () => {
    expect(storedName("Résumé 2026 (final).PDF", "pdf")).toBe("resume-2026-final.pdf");
    expect(storedName("../../etc/passwd", "png")).toBe("etc-passwd.png");
    expect(storedName("photo.php.jpg", "jpg")).toBe("photo.php.jpg");
    expect(storedName("", "mp4")).toBe("file.mp4");
    expect(embedKind("files/abc/x.webm")).toBe("video");
  });

  it("embed only from neat.link's own files", () => {
    const prefix = "https://media.neat.link/files/";
    const own = `${prefix}AbCdEfGhIjKlMnOpQrStUvWx`;
    expect(renderMarkdown(`![Me](${own}/me.jpg)`, { filesPrefix: prefix })).toContain(`<img src="${own}/me.jpg" alt="Me" loading="lazy"`);
    expect(renderMarkdown(`![](${own}/talk.mp4)`, { filesPrefix: prefix })).toContain("<video");
    expect(renderMarkdown(`![Song](${own}/song.mp3)`, { filesPrefix: prefix })).toContain("<audio");
    expect(renderMarkdown(`![CV](${own}/cv.pdf)`, { filesPrefix: prefix })).toContain(`<a href="${own}/cv.pdf" target="_blank" rel="noopener">CV</a>`);
    const elsewhere = renderMarkdown("![Tracker](https://evil.example/pixel.gif)", { filesPrefix: prefix });
    expect(elsewhere).not.toContain("<img");
    expect(elsewhere).toContain('rel="nofollow ugc noopener">Tracker</a>');
    // Refused as a link, it is left as plain text.
    expect(renderMarkdown("![x](javascript:alert(1))", { filesPrefix: prefix })).toBe("<p>![x](javascript:alert(1))</p>\n");
  });
});

describe("domains", () => {
  it("are read as people type them", () => {
    expect(normalizeDomain("https://WWW.Example.com/path?x")).toBe("www.example.com");
    expect(normalizeDomain("example.com.")).toBe("example.com");
    expect(normalizeDomain("bücher.de")).toBe("xn--bcher-kva.de");
    expect(normalizeDomain("two words.com")).toBeNull();
  });

  it("refuse names that are not domains or are neat.link's own", () => {
    const own = ["neat.link", "media.neat.link", "byo.neat.link"];
    expect(domainProblem("www.example.org", own)).toBeNull();
    expect(domainProblem("com", own)).not.toBeNull();
    expect(domainProblem("x.byo.neat.link", own)).not.toBeNull();
    expect(domainProblem("my.workers.dev", own)).not.toBeNull();
    expect(domainProblem("-bad.com", own)).not.toBeNull();
  });

  it("know DNS providers by their nameservers", () => {
    expect(providerOf(["kate.ns.cloudflare.com"])?.root).toBe(true);
    expect(providerOf(["ns1.dns-parking.com"])?.name).toBe("Hostinger");
    expect(providerOf(["ns-1.awsdns-01.org"])?.name).toBe("Amazon Route 53");
    expect(providerOf(["ns1.example.net"])).toBeNull();
  });
});

describe("subpages", () => {
  it("have paths of lowercase words, made from titles", () => {
    expect(pathFromTitle("How I made my first $1M!")).toBe("how-i-made-my-first-1m");
    expect(pathFromTitle("Ünïcödé — test")).toBe("unicode-test");
    expect(subpagePathProblem("how-i-made-it")).toBeNull();
    expect(subpagePathProblem("How")).not.toBeNull();
    expect(subpagePathProblem("a--b")).not.toBeNull();
    expect(subpagePathProblem("index")).not.toBeNull();
    expect(subpageUrl({ handle: "ada", domain: "ada.dev" }, "notes", "https://neat.link")).toBe("https://ada.dev/notes");
    expect(subpageUrl({ handle: "ada", domain: null }, "notes", "https://neat.link")).toBe("https://neat.link/ada/notes");
  });
});
