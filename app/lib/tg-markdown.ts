/**
 * Converts Telegram's MarkdownV2, which the legacy bot stored page bodies in,
 * to the CommonMark pages use now. Run once, on import.
 *
 * MarkdownV2 marks *bold*, _italic_, __underline__, ~strikethrough~,
 * ||spoiler||, `code`, ```pre``` and [text](url), and escapes every other
 * use of those characters, and of . ! - + = # > | { } ( ), with a backslash.
 * CommonMark is written back with **bold**, _italic_, ~~strikethrough~~,
 * code and links; underline and spoilers become plain text, since pages have
 * neither. Only characters CommonMark would misread are escaped, so the
 * result reads as ordinary text. A marker left unclosed is kept as text.
 */

type Mark = "bold" | "italic" | "underline" | "strike" | "spoiler";

type Piece =
  | { kind: "text"; value: string }
  | { kind: "mark"; mark: Mark; raw: string }
  | { kind: "code"; value: string }
  | { kind: "pre"; value: string; language: string }
  | { kind: "link"; text: string; url: string };

// Italic is written with * so it also works inside a word, where CommonMark ignores _.
const OPEN: Record<Mark, string> = { bold: "**", italic: "*", underline: "", strike: "~~", spoiler: "" };

function unescape(value: string): string {
  return value.replace(/\\(.)/gs, "$1");
}

/** Reads text up to an unescaped `close`, from `start`; null when it never closes. */
function readUntil(source: string, start: number, close: string): { value: string; end: number } | null {
  let index = start;
  while (index < source.length) {
    if (source[index] === "\\") {
      index += 2;
      continue;
    }
    if (source.startsWith(close, index)) return { value: source.slice(start, index), end: index + close.length };
    index += 1;
  }
  return null;
}

function tokenize(source: string): Piece[] {
  const pieces: Piece[] = [];
  let text = "";
  const flush = () => {
    if (text) pieces.push({ kind: "text", value: text });
    text = "";
  };
  let index = 0;
  while (index < source.length) {
    const char = source[index]!;
    if (char === "\\" && index + 1 < source.length) {
      text += source[index + 1];
      index += 2;
      continue;
    }
    if (source.startsWith("```", index)) {
      const closed = readUntil(source, index + 3, "```");
      if (closed) {
        flush();
        const [first = "", ...rest] = closed.value.split("\n");
        const hasLanguage = rest.length > 0 && /^[\w+-]*$/.test(first);
        const value = unescape(hasLanguage ? rest.join("\n") : closed.value).replace(/^\n|\n$/g, "");
        pieces.push({ kind: "pre", value, language: hasLanguage ? first : "" });
        index = closed.end;
        continue;
      }
    }
    if (char === "`") {
      const closed = readUntil(source, index + 1, "`");
      if (closed) {
        flush();
        pieces.push({ kind: "code", value: unescape(closed.value) });
        index = closed.end;
        continue;
      }
    }
    if (char === "[" || (char === "!" && source[index + 1] === "[")) {
      const at = char === "!" ? index + 1 : index;
      const label = readUntil(source, at + 1, "]");
      if (label && source[label.end] === "(") {
        const target = readUntil(source, label.end + 1, ")");
        if (target) {
          flush();
          const url = unescape(target.value).trim();
          const words = tokenizeInline(label.value);
          // A custom emoji (![👍](tg://emoji?id=…)) keeps only its fallback emoji.
          if (url.startsWith("tg://emoji")) pieces.push(...words);
          else pieces.push({ kind: "link", text: render(words), url });
          index = target.end;
          continue;
        }
      }
    }
    if (source.startsWith("||", index)) {
      flush();
      pieces.push({ kind: "mark", mark: "spoiler", raw: "||" });
      index += 2;
      continue;
    }
    if (source.startsWith("__", index)) {
      flush();
      pieces.push({ kind: "mark", mark: "underline", raw: "__" });
      index += 2;
      continue;
    }
    const single: Record<string, Mark> = { "*": "bold", _: "italic", "~": "strike" };
    if (single[char]) {
      flush();
      pieces.push({ kind: "mark", mark: single[char]!, raw: char });
      index += 1;
      continue;
    }
    text += char;
    index += 1;
  }
  flush();
  return pairMarks(pieces);
}

function tokenizeInline(source: string): Piece[] {
  return tokenize(source);
}

/** Markers that open and close in pairs stay; any without a partner become text. */
function pairMarks(pieces: Piece[]): Piece[] {
  const open: number[] = [];
  const paired = new Set<number>();
  pieces.forEach((piece, index) => {
    if (piece.kind !== "mark") return;
    let last = -1;
    for (let at = open.length - 1; at >= 0; at -= 1) {
      if ((pieces[open[at]!] as { mark: Mark }).mark === piece.mark) {
        last = at;
        break;
      }
    }
    if (last >= 0) {
      paired.add(open[last]!);
      paired.add(index);
      open.splice(last);
    } else {
      open.push(index);
    }
  });
  return pieces.map((piece, index) =>
    piece.kind === "mark" && !paired.has(index) ? { kind: "text", value: piece.raw } : piece,
  );
}

/**
 * Escapes what CommonMark would read as formatting in plain text. An
 * underscore inside a word (snake_case, a URL) needs none.
 */
function escapeText(value: string): string {
  return value
    .replace(/[\\`*[\]]/g, "\\$&")
    .replace(/~~/g, "\\~\\~")
    .replace(/_/g, (match, offset: number, whole: string) => {
      const before = whole[offset - 1] ?? " ";
      const after = whole[offset + 1] ?? " ";
      return /[\p{L}\p{N}]/u.test(before) && /[\p{L}\p{N}_]/u.test(after) ? match : "\\_";
    })
    .replace(/^(\s*)([#>])/gm, "$1\\$2");
}

function escapeUrl(url: string): string {
  return url.replace(/[()\s]/g, (char) => encodeURIComponent(char));
}

function render(pieces: Piece[]): string {
  let out = "";
  const active: Mark[] = [];
  // The marker just opened, so spaces after it can move in front of it:
  // CommonMark does not start emphasis just before a space.
  let justOpened = "";
  for (const piece of pieces) {
    switch (piece.kind) {
      case "text": {
        let value = piece.value;
        const lead = justOpened ? (/^\s+/.exec(value)?.[0] ?? "") : "";
        if (lead) {
          out = `${out.slice(0, out.length - justOpened.length)}${lead}${justOpened}`;
          value = value.slice(lead.length);
        }
        out += escapeText(value);
        break;
      }
      case "code": {
        const fence = piece.value.includes("`") ? "``" : "`";
        out += `${fence}${piece.value}${fence}`;
        break;
      }
      case "pre":
        out += `${out && !out.endsWith("\n") ? "\n" : ""}\`\`\`${piece.language}\n${piece.value}\n\`\`\`\n`;
        break;
      case "link":
        out += `[${piece.text}](${escapeUrl(piece.url)})`;
        break;
      case "mark": {
        const marker = OPEN[piece.mark];
        const at = active.lastIndexOf(piece.mark);
        if (at < 0) {
          active.push(piece.mark);
          out += marker;
          justOpened = marker;
          continue;
        }
        active.splice(at, 1);
        if (marker && justOpened === marker && out.endsWith(marker)) {
          // Nothing between the markers: drop both.
          out = out.slice(0, out.length - marker.length);
        } else {
          // Nor does it end emphasis just after a space.
          const trail = /\s+$/.exec(out)?.[0] ?? "";
          out = `${out.slice(0, out.length - trail.length)}${marker}${trail}`;
        }
        break;
      }
    }
    justOpened = "";
  }
  return out;
}

export function telegramToCommonMark(source: string): string {
  return render(tokenize(source.replace(/\r\n?/g, "\n")))
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
