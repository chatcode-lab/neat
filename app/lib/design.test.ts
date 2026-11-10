import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

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
