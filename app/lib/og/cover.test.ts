import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { balance, type Cover, coverSvg, drawable, HEIGHT, measure, SIGN, WIDTH, wrap } from "./cover";
import { readFontMetrics, withFallback } from "./metrics";

const font = (name: string) => {
  const bytes = readFileSync(new URL(`./fonts/${name}`, import.meta.url));
  return readFontMetrics(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
};
const sign = font("NotoSansSymbols-Sign.ttf.bin");
const fonts = {
  regular: withFallback(font("Inter-Regular.ttf.bin"), sign),
  semibold: withFallback(font("InterDisplay-SemiBold.ttf.bin"), sign),
};

/** Every text the cover draws, with where it starts and its size. */
function texts(svg: string) {
  return [...svg.matchAll(/<text x="([\d.]+)" y="([\d.]+)"(?: text-anchor="middle")? font-family="'([^']+)'[^"]*" font-size="([\d.]+)"[^>]*>([^<]*)<\/text>/g)].map(
    ([, x, y, family, size, content]) => ({ x: Number(x), y: Number(y), family: family!, size: Number(size), content: content! }),
  );
}

const page = (cover: Partial<Cover>): Cover => ({ title: "Ada Lovelace", headline: "", text: "", address: "neat.link/ada", picture: null, ...cover });

describe("cover text", () => {
  it("draws styled letters as plain ones, keeps the sign and leaves out emoji", () => {
    expect(drawable("𝐒𝐭𝐮𝐝𝐞𝐧𝐭𝐬' 𝘎𝘺𝘮𝘬𝘩𝘢𝘯𝘢 🏆", fonts.regular)).toBe("Students' Gymkhana");
    expect(drawable(`Creator of ${SIGN} neat.link 🙌🏻`, fonts.regular)).toBe(`Creator of ${SIGN} neat.link`);
  });

  it("breaks after a hyphen before cutting a word", () => {
    const width = measure("Hohenzollern-", fonts.semibold, 54) + 1;
    const wrapped = wrap("Hohenzollern-Sigmaringen", fonts.semibold, 54, width, 3);
    expect(wrapped).toEqual({ lines: ["Hohenzollern-", "Sigmaringen"], complete: true, cut: false });
  });

  it("balances a name over two lines", () => {
    const width = measure("Gymkhana IIT", fonts.semibold, 72) + 1;
    expect(wrap("Gymkhana IIT Kanpur", fonts.semibold, 72, width, 2).lines).toEqual(["Gymkhana IIT", "Kanpur"]);
    expect(balance("Gymkhana IIT Kanpur", fonts.semibold, 72, width, 2).lines).toEqual(["Gymkhana", "IIT Kanpur"]);
  });
});

describe("cover layout", () => {
  const profiles: Cover[] = [
    page({}),
    page({ title: "JR", text: "Artist until I find a real job:)\nEditions @atelierjr" }),
    page({ title: "Maximilian Alexander von Hohenzollern-Sigmaringen", headline: "Architect and urban planner, Berlin and Vienna", text: "x ".repeat(400) }),
    page({ title: "😂", address: "neat.link/pavel_alexandrovich_durov", text: "😂 - 🔥 - 💀\nSomething real" }),
    page({ title: "Ульяна коуч ICI, Психолог", text: "Приветствую вас! Я дипломированный специалист, работаю в мультимодальном подходе." }),
  ];

  it("keeps every line inside the card", () => {
    for (const cover of profiles) {
      for (const text of texts(coverSvg(cover, fonts))) {
        const metrics = text.family === "Inter" ? fonts.regular : fonts.semibold;
        const left = text.content === SIGN || /^[A-ZЀ-ӿ]{1,2}$/.test(text.content) ? text.x - text.size : text.x;
        expect(left, text.content).toBeGreaterThanOrEqual(56);
        if (text.family !== "Noto Sans Symbols") expect(text.x + measure(text.content.replace(/&\w+;/g, "x"), metrics, text.size), text.content).toBeLessThanOrEqual(WIDTH - 56);
        expect(text.y - text.size * 0.73, text.content).toBeGreaterThanOrEqual(40);
        expect(text.y, text.content).toBeLessThanOrEqual(HEIGHT - 40);
      }
    }
  });

  it("leads the address with the sign and leaves out lines with nothing to read", () => {
    const drawn = texts(coverSvg(profiles[3]!, fonts)).map((text) => text.content);
    // A name with nothing to draw gives way to the handle.
    expect(drawn.slice(1, 3).join("")).toBe("pavel_alexandrovich_durov");
    expect(drawn).toContain("Something real");
    expect(drawn.some((line) => /^[\s-]+$/.test(line))).toBe(false);
    const address = drawn.indexOf("neat.link/pavel_alexandrovich_durov");
    expect(drawn[address - 1]).toBe(SIGN);
  });

  it("draws initials of the name as shown, the handle standing in for a name it cannot draw", () => {
    const drawn = (cover: Partial<Cover>) => texts(coverSvg(page(cover), fonts)).map((text) => text.content);
    expect(drawn({ title: "𝐆𝐫𝐚𝐜𝐞 𝐇𝐨𝐩𝐩𝐞𝐫" }).slice(0, 2)).toEqual(["GH", "Grace Hopper"]);
    expect(drawn({ title: "😂", address: "neat.link/pashayou" }).slice(0, 2)).toEqual(["P", "pashayou"]);
    expect(drawn({ title: "王小明" }).slice(0, 2)).toEqual(["A", "ada"]);
  });

  it("draws the sign, not initials, on the site's cover", () => {
    const drawn = texts(coverSvg(page({ title: "neat.link", headline: "One neat page for all your links.", address: "neat.link", sign: true }), fonts));
    expect(drawn.filter((text) => text.content === SIGN)).toHaveLength(2);
    expect(drawn.map((text) => text.content)).not.toContain("NL");
  });
});
