import MarkdownIt from "markdown-it";

/** The longest body a page keeps, in characters. */
export const MAX_BODY_LENGTH = 10_000;

/**
 * Page bodies are CommonMark with strikethrough and bare links made
 * clickable. Raw HTML is never rendered, and markdown-it's own link check
 * refuses javascript:, vbscript:, file: and data: addresses. A line break
 * in the text is a line break on the page, as people expect from a bio.
 * Pictures are left as text for now: pages may not load images from other
 * sites (see the plan's security baseline).
 */
const renderer = new MarkdownIt({ html: false, linkify: true, breaks: true, typographer: false }).disable(["image"]);

const defaultLinkOpen =
  renderer.renderer.rules.link_open ??
  ((tokens, index, options, _env, self) => self.renderToken(tokens, index, options));

// Links in someone's text open in a new tab and pass no ranking or referrer
// trust; a mailto: or tel: link stays in place.
renderer.renderer.rules.link_open = (tokens, index, options, env, self) => {
  const token = tokens[index]!;
  const href = token.attrGet("href") ?? "";
  if (/^https?:/i.test(href)) {
    token.attrSet("target", "_blank");
    token.attrSet("rel", "nofollow ugc noopener");
  }
  return defaultLinkOpen(tokens, index, options, env, self);
};

/** A page body as HTML, safe to put in the page as it is. */
export function renderMarkdown(source: string): string {
  return renderer.render(source);
}

/**
 * A body as plain text, for descriptions and covers: formatting removed,
 * links reduced to their words, blank lines collapsed.
 */
export function markdownToText(source: string): string {
  const tokens = renderer.parse(source, {});
  const lines: string[] = [];
  let line = "";
  for (const token of tokens) {
    if (token.type === "inline") {
      for (const child of token.children ?? []) {
        if (child.type === "text" || child.type === "code_inline") line += child.content;
        else if (child.type === "softbreak" || child.type === "hardbreak") {
          lines.push(line);
          line = "";
        }
      }
    } else if (token.type === "fence" || token.type === "code_block") {
      line += token.content.trim();
    } else if (token.type.endsWith("_close") && token.block) {
      if (line) lines.push(line);
      line = "";
    }
  }
  if (line) lines.push(line);
  return lines.map((text) => text.replace(/\s+/g, " ").trim()).filter(Boolean).join("\n");
}

/** The first characters of a body as one line of text, for a description. */
export function summary(source: string, maxLength = 160): string {
  const text = markdownToText(source).replace(/\n+/g, " ");
  if ([...text].length <= maxLength) return text;
  const chars = [...text];
  const cut = chars.slice(0, maxLength - 1).join("");
  // Ends on a whole word: a word the limit splits is left out.
  const whole = /\s/.test(chars[maxLength - 1] ?? " ") ? cut : cut.replace(/\s+\S*$/, "");
  return `${whole.trimEnd()}…`;
}
