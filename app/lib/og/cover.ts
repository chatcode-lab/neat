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
export const COVER_DESIGN = "6";

export const WIDTH = 1200;
export const HEIGHT = 630;

/** The neat.link sign. Inter lacks it; resvg draws it from the Neat Sign font beside the fonts. */
export const SIGN = "⎆";

/**
 * The sign's ink in Neat Sign (JuliaMono SemiBold's ⎆, renamed as its
 * licence asks of a subset), in ems: it stands on the baseline, this tall,
 * and spans from `left` to `right`.
 */
const SIGN_INK = { height: 0.516, left: 0.044, right: 0.551 } as const;

const COLORS = {
  ground: "#fafafa",
  text: "#18181b",
  headline: "#3f3f46",
  body: "#52525b",
  edge: "#ffffff",
  disc: "#27272a",
  onDisc: "#fafafa",
} as const;

export const FAMILY = { regular: "Inter", semibold: "Inter Display SemiBold", symbols: "Neat Sign" } as const;

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
 * Breaks text into at most `maxLines` lines that fit `width`, at spaces. A
 * word wider than a line breaks after a hyphen, dash, slash, underscore or
 * dot, as handles and addresses can, or else between letters where it
 * stops fitting (`cut`); `broken` counts the words broken either way. Text
 * left over ends the last line with an ellipsis.
 */
export function wrap(
  text: string,
  font: FontMetrics,
  size: number,
  width: number,
  maxLines: number,
): { lines: string[]; complete: boolean; broken: number; cut: boolean } {
  const fits = (line: string) => measure(line, font, size) <= width;
  const words = text.split(" ").filter(Boolean);
  const lines: string[] = [];
  let line = "";
  let index = 0;
  let broken = 0;
  let cut = false;
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
    const pieces = word.split(/(?<=[-–—/_.])(?=.)/);
    let head = "";
    for (const piece of pieces) {
      if (!fits(head + piece)) break;
      head += piece;
    }
    if (!head) {
      const chars = [...word];
      let end = 1;
      while (end < chars.length && fits(chars.slice(0, end + 1).join(""))) end += 1;
      head = chars.slice(0, end).join("");
      cut = true;
    }
    lines.push(head);
    words[index] = word.slice(head.length);
    broken += 1;
  }
  if (line && lines.length < maxLines) lines.push(line);
  const complete = index >= words.length;
  if (!complete && lines.length > 0) lines[lines.length - 1] = ellipsize(lines[lines.length - 1]!, font, size, width);
  return { lines, complete, broken, cut };
}

/**
 * Text wrapped as `wrap` does, then into the narrowest width that keeps
 * as many lines and breaks no more words, so a name on two lines breaks
 * evenly rather than leaving one word below.
 */
export function balance(text: string, font: FontMetrics, size: number, width: number, maxLines: number): ReturnType<typeof wrap> {
  const wrapped = wrap(text, font, size, width, maxLines);
  if (!wrapped.complete || wrapped.cut || wrapped.lines.length < 2) return wrapped;
  let low = width / 2;
  let high = width;
  while (high - low > 1) {
    const middle = (low + high) / 2;
    const narrower = wrap(text, font, size, middle, maxLines);
    if (narrower.complete && !narrower.cut && narrower.broken <= wrapped.broken && narrower.lines.length === wrapped.lines.length) high = middle;
    else low = middle;
  }
  return wrap(text, font, size, high, maxLines);
}

/**
 * Text in at most `maxLines` balanced lines without cutting it short: all
 * of it, as many of its first sentences as fit, or nothing. `all` says
 * whether it is all there.
 */
export function whole(text: string, font: FontMetrics, size: number, width: number, maxLines: number): { lines: string[]; all: boolean } {
  const sentences = text.split(/(?<=[.!?…])\s+/);
  for (let count = sentences.length; count > 0; count -= 1) {
    const wrapped = balance(sentences.slice(0, count).join(" "), font, size, width, maxLines);
    if (wrapped.complete && !wrapped.cut) return { lines: wrapped.lines, all: count === sentences.length };
  }
  return { lines: [], all: false };
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
  { title: 46, titleLines: 3, headline: 32, text: 30, address: 30 },
  { title: 40, titleLines: 4, headline: 30, text: 28, address: 28 },
] as const;

/** The picture's diameter, the space between it and the text, and the least margin around the card. */
const SIDE = 400;
const GAP = 72;
const MARGIN_X = 56;
const MARGIN_Y = 64;
const TEXT_WIDTH = WIDTH - 2 * MARGIN_X - SIDE - GAP;

/** Inter's capital height in ems, to centre the text on its letters rather than its line boxes. */
const CAP = 0.73;

/** At most this many lines of the page text, and of headline and text together. */
const TEXT_LINES = 3;
const SECONDARY_LINES = 4;

/** The space between the sign and the address, in ems of the address. */
const SIGN_SPACE = 0.3;

/** The sign is drawn as tall as the capitals around it: its font is this many times their size. */
const SIGN_SIZE = CAP / SIGN_INK.height;

/** Metrics that measure the sign at the size it is drawn. */
function signSized(font: FontMetrics): FontMetrics {
  const code = SIGN.codePointAt(0)!;
  return {
    advance: (point) => (point === code ? (font.advance(point) ?? 0.6) * SIGN_SIZE : font.advance(point)),
    leftBearing: (point) => (point === code ? (font.leftBearing(point) ?? 0) * SIGN_SIZE : font.leftBearing(point)),
  };
}

/** A line as SVG text, its signs set in their own font at the capitals' height. */
const markup = (line: string, size: number) =>
  line
    .split(SIGN)
    .map(escape)
    .join(`<tspan font-family="'${FAMILY.symbols}'" font-size="${(size * SIGN_SIZE).toFixed(1)}">${SIGN}</tspan>`);

/** Lines of one kind: the first baseline sits `gap` below the previous run's baseline plus this run's capital height. */
interface Run {
  lines: string[];
  /** The sign hangs before the line, in the margin, so the line starts where the others do. */
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

export function coverSvg(cover: Cover, given: Fonts): string {
  const fonts: Fonts = { regular: signSized(given.regular), semibold: signSized(given.semibold) };
  // The name, or the page's handle when nothing of it can be drawn.
  const named = drawable(cover.title, fonts.semibold);
  const title = READABLE.test(named) ? named : drawable(cover.address.split("/").pop() ?? cover.address, fonts.semibold);

  // The largest size the name fits whole at, its words unbroken; failing
  // that, broken only after a hyphen, underscore and the like; failing
  // that, the smallest.
  const fitted = STEPS.map((step) => ({ step, wrapped: balance(title, fonts.semibold, step.title, TEXT_WIDTH, step.titleLines) }));
  const { step, wrapped: titled } =
    fitted.find(({ wrapped }) => wrapped.complete && wrapped.broken === 0) ??
    fitted.find(({ wrapped }) => wrapped.complete && !wrapped.cut) ??
    fitted[fitted.length - 1]!;
  const titleLines = titled.lines;

  // The headline and the text show whole lines only: a paragraph too long
  // for the room keeps its first sentences, or is left out with all that
  // follows it, so nothing ends cut short.
  const headlineText = drawable(cover.headline, fonts.regular);
  const headline = READABLE.test(headlineText) ? whole(headlineText, fonts.regular, step.headline, TEXT_WIDTH, 2).lines : [];

  const paragraphs = cover.text
    .split("\n")
    .map((line) => drawable(line, fonts.regular))
    .filter((line) => READABLE.test(line));
  const room = Math.min(TEXT_LINES, SECONDARY_LINES - headline.length);
  const shown: string[][] = [];
  for (const paragraph of paragraphs) {
    const left = room - shown.flat().length;
    if (left <= 0) break;
    const kept = whole(paragraph, fonts.regular, step.text, TEXT_WIDTH, left);
    if (kept.lines.length) shown.push(kept.lines);
    if (!kept.all) break;
  }

  // The address fills the line at most, however long the handle.
  const address = drawable(cover.address, fonts.semibold);
  let addressSize: number = step.address;
  while (addressSize > 20 && measure(address, fonts.semibold, addressSize) > TEXT_WIDTH) addressSize -= 1;

  const runs = (): Run[] => [
    { lines: titleLines, size: step.title, lineHeight: Math.round(step.title * 1.06), gap: 0, weight: "semibold", color: COLORS.text },
    ...(headline.length
      ? [{ lines: headline, size: step.headline, lineHeight: Math.round(step.headline * 1.3), gap: Math.round(Math.max(step.title * 0.36, step.headline * 0.9)), weight: "regular" as const, color: COLORS.headline }]
      : []),
    ...(shown.length
      ? [{ lines: shown.flat(), size: step.text, lineHeight: Math.round(step.text * 1.42), gap: Math.round(headline.length ? step.text * 0.75 : Math.max(step.title * 0.42, step.text)), weight: "regular" as const, color: COLORS.body }]
      : []),
    { lines: [address], signed: true, size: addressSize, lineHeight: addressSize, gap: Math.round(addressSize * 1.25), weight: "semibold", color: COLORS.text },
  ];
  let laid = runs();
  let height = laid.reduce((sum, run) => sum + runHeight(run), 0);
  while (height > HEIGHT - 2 * MARGIN_Y && shown.length > 0) {
    shown.pop();
    laid = runs();
    height = laid.reduce((sum, run) => sum + runHeight(run), 0);
  }

  // The picture and the text are centred together; the widest line sets the text's width.
  const textWidth = Math.max(
    ...laid.flatMap((run) => run.lines.map((line) => measure(line, fonts[run.weight], run.size))),
  );
  const left = Math.max(MARGIN_X, Math.round((WIDTH - (SIDE + GAP + Math.min(textWidth, TEXT_WIDTH))) / 2));
  const textX = left + SIDE + GAP;

  const parts: string[] = [];
  let baseline = Math.round((HEIGHT - height) / 2);
  for (const run of laid) {
    baseline += run.gap + run.size * CAP;
    run.lines.forEach((line, index) => {
      const y = baseline + index * run.lineHeight;
      if (run.signed) {
        // As tall as the capitals, on the same baseline, ending a space before the line.
        const size = run.size * SIGN_SIZE;
        const x = textX - run.size * SIGN_SPACE - SIGN_INK.right * size;
        parts.push(
          `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" font-family="${stack(FAMILY.symbols)}" font-size="${size.toFixed(1)}" fill="${run.color}">${SIGN}</text>`,
        );
      }
      // Every line's ink starts at textX, however large its first letter's side bearing.
      const x = textX - (fonts[run.weight].leftBearing(line.codePointAt(0) ?? 32) ?? 0) * run.size;
      parts.push(
        `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" font-family="${stack(FAMILY[run.weight])}" font-size="${run.size}" fill="${run.color}">${markup(line, run.size)}</text>`,
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
    // The sign's ink, a third of the disc tall, centred in it.
    const size = (SIDE * 0.34) / SIGN_INK.height;
    const x = cx - ((SIGN_INK.left + SIGN_INK.right) / 2) * size;
    face =
      `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${COLORS.disc}"/>` +
      `<text x="${x.toFixed(1)}" y="${(cy + (SIGN_INK.height / 2) * size).toFixed(1)}" font-family="${stack(FAMILY.symbols)}" font-size="${size.toFixed(1)}" fill="${COLORS.onDisc}">${SIGN}</text>`;
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
