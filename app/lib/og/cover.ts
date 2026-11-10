import type { FontMetrics } from "./metrics";

/**
 * A page's cover for link previews (OpenGraph, Twitter, Telegram), drawn as
 * SVG and rendered to PNG by resvg: the round picture on the left, the
 * title, headline and the first lines of the text on the right, and the
 * page's address under them, as the legacy covers had it.
 */

/** Bumped when the cover's design changes, so every cover's address changes and caches draw it again. */
export const COVER_DESIGN = "2";

export const WIDTH = 1200;
export const HEIGHT = 630;

const COLORS = {
  ground: "#f6f6f4",
  text: "#1c1c1b",
  muted: "#5c5b58",
  faint: "#8a8984",
  ring: "#e2e1dc",
  initialsGround: "#e7e6e1",
} as const;

export const FAMILY = { regular: "Inter", semibold: "Inter Display SemiBold" } as const;

export interface Fonts {
  regular: FontMetrics;
  semibold: FontMetrics;
}

export interface Cover {
  title: string;
  headline: string;
  /** The page text as plain lines. */
  text: string;
  /** neat.link/<handle>, as shown. */
  address: string;
  /** The picture as a data: address, or null for initials. */
  picture: string | null;
}

const escape = (text: string) =>
  text.replace(/[<>&'"]/g, (char) => `&${{ "<": "lt", ">": "gt", "&": "amp", "'": "apos", '"': "quot" }[char]};`);

/**
 * Text as the fonts can draw it: one line, control characters and anything
 * the font lacks (emoji, scripts it does not cover) left out, spaces
 * collapsed.
 */
export function drawable(text: string, font: FontMetrics): string {
  let out = "";
  for (const char of text.replace(/\s+/g, " ")) {
    const code = char.codePointAt(0)!;
    if (char === " " || (code >= 0x20 && font.advance(code) !== null)) out += char;
  }
  return out.replace(/ {2,}/g, " ").trim();
}

/** A line's width in pixels at a size. */
export function measure(text: string, font: FontMetrics, size: number): number {
  let width = 0;
  for (const char of text) width += font.advance(char.codePointAt(0)!) ?? 0.6;
  return width * size;
}

/**
 * Breaks text into at most `maxLines` lines that fit `width`, at spaces, or
 * inside a word too long for a line. Text left over ends the last line with
 * an ellipsis.
 */
export function wrap(text: string, font: FontMetrics, size: number, width: number, maxLines: number): { lines: string[]; complete: boolean } {
  const fits = (line: string) => measure(line, font, size) <= width;
  const words = text.split(" ").filter(Boolean);
  const lines: string[] = [];
  let line = "";
  let index = 0;
  while (index < words.length && lines.length < maxLines) {
    const word = words[index]!;
    const candidate = line ? `${line} ${word}` : word;
    if (fits(candidate)) {
      line = candidate;
      index += 1;
      continue;
    }
    if (line) {
      lines.push(line);
      line = "";
      continue;
    }
    // A word wider than a whole line is cut where it stops fitting.
    let cut = 1;
    const chars = [...word];
    while (cut < chars.length && fits(chars.slice(0, cut + 1).join(""))) cut += 1;
    lines.push(chars.slice(0, cut).join(""));
    words[index] = chars.slice(cut).join("");
  }
  if (line && lines.length < maxLines) lines.push(line);
  const complete = index >= words.length;
  if (!complete && lines.length > 0) {
    let last = lines[lines.length - 1]!;
    while (last && !fits(`${last}…`)) last = [...last].slice(0, -1).join("").trimEnd();
    lines[lines.length - 1] = `${last.replace(/[\s,;:.–—-]+$/, "")}…`;
  }
  return { lines, complete };
}

/** Up to two letters for a page without a picture. */
export function initials(title: string): string {
  const words = title.replace(/[^\p{L}\p{N} ]/gu, " ").split(" ").filter(Boolean);
  return words
    .slice(0, 2)
    .map((word) => [...word][0]!.toUpperCase())
    .join("");
}

function textLines(lines: string[], x: number, y: number, size: number, lineHeight: number, family: string, color: string): string {
  return lines
    .map(
      (line, index) =>
        `<text x="${x}" y="${y + index * lineHeight}" font-family="${family}" font-size="${size}" fill="${color}">${escape(line)}</text>`,
    )
    .join("");
}

export function coverSvg(cover: Cover, fonts: Fonts): string {
  const side = 300;
  const left = 100;
  const circleY = (HEIGHT - side) / 2;
  const textX = left + side + 70;
  const textWidth = WIDTH - textX - 90;

  // The title takes the largest size, of these, at which it fits two lines.
  const title = drawable(cover.title, fonts.semibold) || drawable(cover.address, fonts.semibold);
  let titleSize = 46;
  let titleLines = wrap(title, fonts.semibold, titleSize, textWidth, 2).lines;
  for (const size of [84, 72, 62, 54]) {
    const wrapped = wrap(title, fonts.semibold, size, textWidth, size >= 72 ? 1 : 2);
    if (wrapped.complete) {
      titleSize = size;
      titleLines = wrapped.lines;
      break;
    }
  }
  const titleLineHeight = Math.round(titleSize * 1.12);

  const headline = wrap(drawable(cover.headline, fonts.regular), fonts.regular, 34, textWidth, 2).lines;
  const textSize = 28;
  const textLineHeight = 40;
  const roomForText = Math.max(0, 4 - titleLines.length - headline.length);
  const paragraphs = cover.text.split("\n").map((line) => drawable(line, fonts.regular)).filter(Boolean);
  const text: string[] = [];
  for (const paragraph of paragraphs) {
    if (text.length >= roomForText) break;
    const wrapped = wrap(paragraph, fonts.regular, textSize, textWidth, roomForText - text.length);
    text.push(...wrapped.lines);
  }
  if (paragraphs.length > 0 && text.length === roomForText && text.length > 0 && !text[text.length - 1]!.endsWith("…")) {
    // More text than room: say so.
    const shown = text.join(" ").length;
    if (shown < paragraphs.join(" ").length - 1) text[text.length - 1] = `${text[text.length - 1]!.replace(/[\s,;:.–—-]+$/, "")}…`;
  }

  const blockHeight =
    titleLines.length * titleLineHeight +
    (headline.length ? 16 + headline.length * 44 : 0) +
    (text.length ? 24 + text.length * textLineHeight : 0) +
    70;
  let y = Math.max(70, (HEIGHT - blockHeight) / 2) + titleSize * 0.82;
  const parts: string[] = [];
  parts.push(textLines(titleLines, textX, y, titleSize, titleLineHeight, FAMILY.semibold, COLORS.text));
  y += (titleLines.length - 1) * titleLineHeight;
  if (headline.length) {
    y += 16 + 44;
    parts.push(textLines(headline, textX, y, 34, 44, FAMILY.regular, COLORS.muted));
    y += (headline.length - 1) * 44;
  }
  if (text.length) {
    y += 24 + textLineHeight;
    parts.push(textLines(text, textX, y, textSize, textLineHeight, FAMILY.regular, COLORS.faint));
    y += (text.length - 1) * textLineHeight;
  }
  y += 70;
  parts.push(
    `<text x="${textX}" y="${y}" font-family="${FAMILY.semibold}" font-size="32" fill="${COLORS.text}">${escape(drawable(cover.address, fonts.semibold))}</text>`,
  );

  const cx = left + side / 2;
  const cy = circleY + side / 2;
  const picture = cover.picture
    ? `<clipPath id="round"><circle cx="${cx}" cy="${cy}" r="${side / 2}"/></clipPath>` +
      `<image x="${left}" y="${circleY}" width="${side}" height="${side}" preserveAspectRatio="xMidYMid slice" clip-path="url(#round)" href="${cover.picture}"/>`
    : `<circle cx="${cx}" cy="${cy}" r="${side / 2}" fill="${COLORS.initialsGround}"/>` +
      `<text x="${cx}" y="${cy + 40}" text-anchor="middle" font-family="${FAMILY.semibold}" font-size="112" fill="${COLORS.muted}">${escape(drawable(initials(cover.title), fonts.semibold) || "⎆")}</text>`;

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">`,
    `<rect width="${WIDTH}" height="${HEIGHT}" fill="${COLORS.ground}"/>`,
    picture,
    `<circle cx="${cx}" cy="${cy}" r="${side / 2 + 3}" fill="none" stroke="${COLORS.ring}" stroke-width="6"/>`,
    ...parts,
    "</svg>",
  ].join("");
}
