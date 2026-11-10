import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { LINK_KINDS } from "./buttons";

const css = readFileSync(fileURLToPath(new URL("../app.css", import.meta.url)), "utf8");

/** The custom properties declared in the block after a `/* theme:<name> *\/` marker. */
function tokens(name: string): Record<string, string> {
  const start = css.indexOf(`/* theme:${name} */`);
  if (start < 0) throw new Error(`no theme:${name} block`);
  const open = css.indexOf("{", start);
  const close = css.indexOf("}", open);
  return Object.fromEntries(
    [...css.slice(open + 1, close).matchAll(/(--[\w-]+|color-scheme):\s*([^;]+);/g)].map((match) => [match[1], match[2]!.trim()]),
  );
}

describe("themes", () => {
  it("resolve System to exactly the dark theme on a dark device", () => {
    expect(tokens("system-dark")).toEqual(tokens("dark"));
  });

  it("define every token in both themes", () => {
    expect(Object.keys(tokens("dark")).sort()).toEqual(Object.keys(tokens("light")).sort());
  });
});

/** WCAG relative luminance of a #rrggbb colour. */
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((at) => {
    const value = Number.parseInt(hex.slice(at, at + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

function contrast(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light! + 0.05) / (dark! + 0.05);
}

describe("page buttons", () => {
  const rules = [...css.matchAll(/\.page-button(-[a-z]+)? \{([^}]*)\}/g)].map((match) => ({
    kind: match[1]?.slice(1) ?? "link",
    body: match[2]!,
  }));
  const base = rules.find((rule) => rule.kind === "link")!;
  const label = (body: string) => /(?:^|[;\s])color:\s*(#[0-9a-f]{6})/.exec(body)?.[1];

  it("have a colour for every service; plain links use the base rule", () => {
    const missing = LINK_KINDS.filter((kind) => kind !== "link" && !rules.some((rule) => rule.kind === kind));
    expect(missing).toEqual([]);
  });

  it("keep every label readable: 4.5:1 against each colour of its background", () => {
    const failing = rules.flatMap(({ kind, body }) => {
      const text = label(body) ?? label(base.body)!;
      const background = /background:\s*([^;]+);/.exec(body)?.[1] ?? "";
      return [...background.matchAll(/#[0-9a-f]{6}/g)]
        .map(([stop]) => ({ kind, text, stop, ratio: Math.round(contrast(text, stop) * 100) / 100 }))
        .filter(({ ratio }) => ratio < 4.5);
    });
    expect(failing).toEqual([]);
  });
});
