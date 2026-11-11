import type { FontMetrics } from "./metrics";

/**
 * A page's cover for link previews (OpenGraph, Twitter, Telegram), drawn as
 * SVG and rendered to PNG by resvg. It reads as a business card: the round
 * picture, or initials, beside the name, the headline and the first lines
 * of the text, and the page's address after the ⎆ sign. The type is as
 * large as the name allows and the card is centred both ways, so a page
 * with a name alone fills the cover as well as one with a long text.
 */

/** Bumped when the cover's design changes, so every cover's address changes and caches draw it again. */
export const COVER_DESIGN = "4";

export const WIDTH = 1200;
export const HEIGHT = 630;

/** The neat.link sign. Inter lacks it; resvg draws it from the Noto Sans Symbols subset beside the fonts. */
export const SIGN = "⎆";

const COLORS = {
  ground: "#fafafa",
  text: "#18181b",
  headline: "#3f3f46",
  body: "#52525b",
  edge: "#ffffff",
  disc: "#27272a",
  onDisc: "#fafafa",
} as const;

export const FAMILY = { regular: "Inter", semibold: "Inter Display SemiBold", symbols: "Noto Sans Symbols" } as const;

/** Fonts that measure the sign as well as their own characters, as resvg draws it. */
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
  /** The sign in place of initials: the site's own cover. */
  sign?: boolean;
}

const escape = (text: string) =>
  text.replace(/[<>&'"]/g, (char) => `&${{ "<": "lt", ">": "gt", "&": "amp", "'": "apos", '"': "quot" }[char]};`);

/**
 * Letters styled with Unicode's mathematical alphabets (𝐁𝐨𝐥𝐝, 𝘪𝘵𝘢𝘭𝘪𝘤) or
 * as full-width forms, which people paste into bios and no text font
 * draws: they become the plain letters they stand for.
 */
const STYLED = /[\u{1D400}-\u{1D7FF}\u{FF01}-\u{FF5E}]/gu;

/** Whether text says anything; a line of emoji leaves only its punctuation. */
const READABLE = /[\p{L}\p{N}]/u;

/**
 * Text as the fonts can draw it: one line, styled letters made plain,
 * control characters and anything the font lacks (emoji, scripts it does
 * not cover) left out, spaces collapsed.
 */
export function drawable(text: string, font: FontMetrics): string {
  let out = "";
  for (const char of text.replace(STYLED, (styled) => styled.normalize("NFKC")).replace(/\s+/g, " ")) {
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

/** A line shortened, if need be, to end with an ellipsis within `width`. */
function ellipsize(line: string, font: FontMetrics, size: number, width: number): string {
  let last = line;
  while (last && measure(`${last}…`, font, size) > width) last = [...last].slice(0, -1).join("").trimEnd();
  return `${last.replace(/[\s,;:.–—-]+$/, "")}…`;
}

/**
 * Breaks text into at most `maxLines` lines that fit `width`: at spaces,
 * after hyphens, dashes, slashes, underscores and dots (as in handles and
 * addresses), or inside a word too long for a line (`cut`). Text left over ends the last line with an ellipsis.
 */
export function wrap(
  text: string,
  font: FontMetrics,
  size: number,
  width: number,
  maxLines: number,
): { lines: string[]; complete: boolean; cut: boolean } {
  const fits = (line: string) => measure(line, font, size) <= width;
  // Pieces of words, each with whether a space comes before it.
  const pieces = text
    .split(" ")
    .filter(Boolean)
    .flatMap((word) => word.split(/(?<=[-–—/_.])(?=.)/).map((piece, index) => ({ piece, spaced: index === 0 })));
  const lines: string[] = [];
  let line = "";
  let index = 0;
  let cut = false;
  while (index < pieces.length && lines.length < maxLines) {
    const { piece, spaced } = pieces[index]!;
    const candidate = line ? `${line}${spaced ? " " : ""}${piece}` : piece;
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
    // A piece wider than a whole line is cut where it stops fitting.
    let end = 1;
    const chars = [...piece];
    while (end < chars.length && fits(chars.slice(0, end + 1).join(""))) end += 1;
    lines.push(chars.slice(0, end).join(""));
    pieces[index] = { piece: chars.slice(end).join(""), spaced: false };
    cut = true;
  }
  if (line && lines.length < maxLines) lines.push(line);
  const complete = index >= pieces.length;
  if (!complete && lines.length > 0) lines[lines.length - 1] = ellipsize(lines[lines.length - 1]!, font, size, width);
  return { lines, complete, cut };
}

/**
 * Text wrapped as `wrap` does, then into the narrowest width that keeps as
 * many whole lines, so a name on two lines breaks evenly rather than
 * leaving one word below.
 */
export function balance(text: string, font: FontMetrics, size: number, width: number, maxLines: number): ReturnType<typeof wrap> {
  const wrapped = wrap(text, font, size, width, maxLines);
  if (!wrapped.complete || wrapped.cut || wrapped.lines.length < 2) return wrapped;
  let low = width / 2;
  let high = width;
  while (high - low > 1) {
    const middle = (low + high) / 2;
    const narrower = wrap(text, font, size, middle, maxLines);
    if (narrower.complete && !narrower.cut && narrower.lines.length === wrapped.lines.length) high = middle;
    else low = middle;
  }
  return wrap(text, font, size, high, maxLines);
}

/** Up to two letters for a page without a picture. */
export function initials(title: string): string {
  const words = title.replace(/[^\p{L}\p{N} ]/gu, " ").split(" ").filter(Boolean);
  return words
    .slice(0, 2)
    .map((word) => [...word][0]!.toUpperCase())
    .join("");
}

/**
 * Type sizes, largest first; a cover takes the first its name fits whole,
 * the last in any case. A name keeps to one line while it can be large.
 */
const STEPS = [
  { title: 96, titleLines: 1, headline: 40, text: 36, address: 36 },
  { title: 84, titleLines: 1, headline: 38, text: 34, address: 36 },
  { title: 72, titleLines: 1, headline: 36, text: 32, address: 34 },
  { title: 72, titleLines: 2, headline: 36, text: 32, address: 34 },
  { title: 62, titleLines: 2, headline: 34, text: 32, address: 32 },
  { title: 54, titleLines: 3, headline: 32, text: 30, address: 30 },
] as const;

/** The picture's diameter, the space between it and the text, and the least margin around the card. */
const SIDE = 400;
const GAP = 64;
const MARGIN_X = 64;
const MARGIN_Y = 64;
const TEXT_WIDTH = WIDTH - 2 * MARGIN_X - SIDE - GAP;

/** Inter's capital height in ems, to centre the text on its letters rather than its line boxes. */
const CAP = 0.73;

/** At most this many lines of the page text, and of headline and text together. */
const TEXT_LINES = 3;
const SECONDARY_LINES = 4;

/** The sign before the address, a little larger than its letters so it reads in a small preview. */
const SIGN_SCALE = 1.2;

/** Lines of one kind: the first baseline sits `gap` below the previous run's baseline plus this run's capital height. */
interface Run {
  lines: string[];
  /** The sign leads the line. */
  signed?: boolean;
  size: number;
  lineHeight: number;
  gap: number;
  weight: keyof Fonts;
  color: string;
}

/** How much of a blurred edge is still dark, a standard deviation apart from -3 to 3: the normal curve's tail. */
const FALLOFF = [1, 0.977, 0.841, 0.5, 0.159, 0.023, 0];

/**
 * The soft shadow of a disc, as blurring it by `sigma` would draw it, made
 * with a radial gradient: a blur filter takes several times longer to
 * render than the rest of the cover.
 */
function discShadow(id: string, cx: number, cy: number, r: number, sigma: number, opacity: number): string {
  const outer = r + 3 * sigma;
  const stops = FALLOFF.map(
    (dark, index) =>
      `<stop offset="${((r + (index - 3) * sigma) / outer).toFixed(4)}" stop-color="#000" stop-opacity="${(opacity * dark).toFixed(4)}"/>`,
  ).join("");
  return (
    `<radialGradient id="${id}" gradientUnits="userSpaceOnUse" cx="${cx}" cy="${cy}" r="${outer}">${stops}</radialGradient>` +
    `<circle cx="${cx}" cy="${cy}" r="${outer}" fill="url(#${id})"/>`
  );
}

const runHeight = (run: Run) => run.gap + run.size * CAP + (run.lines.length - 1) * run.lineHeight;

/** A family with the symbols font behind it, for the sign. */
const stack = (family: string) => `'${family}', '${FAMILY.symbols}'`;

export function coverSvg(cover: Cover, fonts: Fonts): string {
  // The name, or the page's handle when nothing of it can be drawn.
  const named = drawable(cover.title, fonts.semibold);
  const title = READABLE.test(named) ? named : drawable(cover.address.split("/").pop() ?? cover.address, fonts.semibold);

  let step: (typeof STEPS)[number] = STEPS[STEPS.length - 1]!;
  let titleLines: string[] = [];
  for (const candidate of STEPS) {
    const wrapped = balance(title, fonts.semibold, candidate.title, TEXT_WIDTH, candidate.titleLines);
    // A name cut inside a word tries a smaller size first.
    if ((wrapped.complete && !wrapped.cut) || candidate === step) {
      step = candidate;
      titleLines = wrapped.lines;
      break;
    }
  }

  const headlineText = drawable(cover.headline, fonts.regular);
  const headline = READABLE.test(headlineText) ? wrap(headlineText, fonts.regular, step.headline, TEXT_WIDTH, 2).lines : [];

  const paragraphs = cover.text
    .split("\n")
    .map((line) => drawable(line, fonts.regular))
    .filter((line) => READABLE.test(line));
  const room = Math.min(TEXT_LINES, SECONDARY_LINES - headline.length);
  const text: string[] = [];
  let shown = 0;
  for (const paragraph of paragraphs) {
    if (text.length >= room) break;
    const wrapped = wrap(paragraph, fonts.regular, step.text, TEXT_WIDTH, room - text.length);
    text.push(...wrapped.lines);
    if (wrapped.complete) shown += 1;
    else break;
  }
  const cut = () => {
    const last = text[text.length - 1];
    if (last !== undefined && !last.endsWith("…")) text[text.length - 1] = ellipsize(last, fonts.regular, step.text, TEXT_WIDTH);
  };
  if (shown < paragraphs.length) cut();

  // The address, after the sign, fills the line at most, however long the handle.
  const signWidth = (size: number) => measure(SIGN, fonts.semibold, size * SIGN_SCALE) + measure(" ", fonts.semibold, size);
  const address = drawable(cover.address, fonts.semibold);
  let addressSize: number = step.address;
  while (addressSize > 20 && signWidth(addressSize) + measure(address, fonts.semibold, addressSize) > TEXT_WIDTH) addressSize -= 1;

  const runs = (): Run[] => [
    { lines: titleLines, size: step.title, lineHeight: Math.round(step.title * 1.06), gap: 0, weight: "semibold", color: COLORS.text },
    ...(headline.length
      ? [{ lines: headline, size: step.headline, lineHeight: Math.round(step.headline * 1.3), gap: Math.round(Math.max(step.title * 0.36, step.headline * 0.9)), weight: "regular" as const, color: COLORS.headline }]
      : []),
    ...(text.length
      ? [{ lines: text, size: step.text, lineHeight: Math.round(step.text * 1.42), gap: Math.round(headline.length ? step.text * 0.75 : Math.max(step.title * 0.42, step.text)), weight: "regular" as const, color: COLORS.body }]
      : []),
    { lines: [address], signed: true, size: addressSize, lineHeight: addressSize, gap: Math.round(addressSize * 1.25), weight: "semibold", color: COLORS.text },
  ];
  let laid = runs();
  let height = laid.reduce((sum, run) => sum + runHeight(run), 0);
  while (height > HEIGHT - 2 * MARGIN_Y && text.length > 0) {
    text.pop();
    cut();
    laid = runs();
    height = laid.reduce((sum, run) => sum + runHeight(run), 0);
  }

  // The picture and the text are centred together; the widest line sets the text's width.
  const textWidth = Math.max(
    ...laid.flatMap((run) => run.lines.map((line) => (run.signed ? signWidth(run.size) : 0) + measure(line, fonts[run.weight], run.size))),
  );
  const left = Math.max(MARGIN_X, Math.round((WIDTH - (SIDE + GAP + Math.min(textWidth, TEXT_WIDTH))) / 2));
  const textX = left + SIDE + GAP;

  const parts: string[] = [];
  let baseline = Math.round((HEIGHT - height) / 2);
  for (const run of laid) {
    baseline += run.gap + run.size * CAP;
    run.lines.forEach((line, index) => {
      const y = baseline + index * run.lineHeight;
      let x = textX;
      if (run.signed) {
        // Lowered so the larger sign stays centred on the capitals.
        parts.push(
          `<text x="${x}" y="${(y + run.size * 0.06).toFixed(1)}" font-family="${stack(FAMILY.symbols)}" font-size="${(run.size * SIGN_SCALE).toFixed(1)}" fill="${run.color}">${SIGN}</text>`,
        );
        x += signWidth(run.size);
      }
      parts.push(
        `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" font-family="${stack(FAMILY[run.weight])}" font-size="${run.size}" fill="${run.color}">${escape(line)}</text>`,
      );
    });
    baseline += (run.lines.length - 1) * run.lineHeight;
  }

  // The picture with a white edge and a soft shadow, as on the page.
  const r = SIDE / 2;
  const cx = left + r;
  const cy = HEIGHT / 2;
  // Initials of the name as drawn; the sign when it has none the font can draw.
  const letters = cover.sign ? "" : drawable(initials(title), fonts.semibold);
  let face: string;
  if (cover.picture) {
    face =
      `<clipPath id="round"><circle cx="${cx}" cy="${cy}" r="${r}"/></clipPath>` +
      `<image x="${left}" y="${cy - r}" width="${SIDE}" height="${SIDE}" preserveAspectRatio="xMidYMid slice" clip-path="url(#round)" href="${cover.picture}"/>`;
  } else if (!letters) {
    // The sign's outline is centred on its advance, a third of an em above the baseline.
    const size = Math.round(SIDE * 0.46);
    face =
      `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${COLORS.disc}"/>` +
      `<text x="${cx}" y="${(cy + size * 0.356).toFixed(1)}" text-anchor="middle" font-family="${stack(FAMILY.symbols)}" font-size="${size}" fill="${COLORS.onDisc}">${SIGN}</text>`;
  } else {
    const size = Math.round(SIDE * (letters.length > 1 ? 0.36 : 0.42));
    face =
      `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${COLORS.disc}"/>` +
      `<text x="${cx}" y="${(cy + (size * CAP) / 2).toFixed(1)}" text-anchor="middle" font-family="${stack(FAMILY.semibold)}" font-size="${size}" fill="${COLORS.onDisc}">${escape(letters)}</text>`;
  }

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">`,
    `<rect width="${WIDTH}" height="${HEIGHT}" fill="${COLORS.ground}"/>`,
    // The page's two shadows (0 4px 8px and 0 6px 20px), scaled to the cover.
    discShadow("near", cx, cy + 10, r + 6, 10, 0.2),
    discShadow("far", cx, cy + 15, r + 6, 25, 0.19),
    `<circle cx="${cx}" cy="${cy}" r="${r + 6}" fill="${COLORS.edge}"/>`,
    face,
    ...parts,
    "</svg>",
  ].join("");
}
