/**
 * The site's own words, written once in Markdown: pages render them, and
 * their .md views and llms.txt serve them as they are.
 */

export const TAGLINE = "One neat page for all your links.";

export function homeMarkdown(origin: string, bot: string): string {
  const host = new URL(origin).host;
  return `# neat.link

${TAGLINE} A picture, your name, a few lines about you and a button for every
place people can find you: ${host}/yourname.

- **Simple.** A page is a title, a short Markdown text and buttons. Nothing to design.
- **Fast and findable.** Pages load instantly, look right in light and dark, and are listed for search engines.
- **Agent-friendly.** Let Claude, ChatGPT or any MCP client write and update your page. Every page is also Markdown at ${host}/yourname.md.
- **Telegram too.** Open the editor from [@${bot}](https://t.me/${bot}).

[Create your page](${origin}/signin) · [For agents](${origin}/agents) · [API](${origin}/api/v1)
`;
}

export function agentsMarkdown(origin: string): string {
  return `# neat.link for agents

neat.link pages can be written and kept up to date by an AI agent. Everything
the editor does is available over MCP and an HTTP API.

## Connect over MCP

The server is \`${origin}/mcp\` (Streamable HTTP). Clients sign in with OAuth:
you approve the connection once in the browser.

- **Claude Code:** \`claude mcp add --transport http neat ${origin}/mcp\`
- **Claude (web and desktop):** Settings → Connectors → Add custom connector → \`${origin}/mcp\`
- **ChatGPT:** Settings → Connectors → Create → MCP server URL \`${origin}/mcp\`
- **Codex:** \`codex mcp add neat --url ${origin}/mcp\`
- **Cursor and others:** add an HTTP MCP server with the URL \`${origin}/mcp\`.

Tools: \`whoami\`, \`list_sites\`, \`read_page\`, \`check_handle\`, \`create_site\`,
\`update_site\`, \`set_picture\`, \`remove_picture\`, \`delete_site\`.

## Use the HTTP API

Make a token in [Settings](${origin}/app/settings) and send it as
\`Authorization: Bearer <token>\`. The guide is at [${origin}/api/v1](${origin}/api/v1).

## Read any page

Every published page is Markdown at its address plus \`.md\` (for example
\`${origin}/elon.md\`), or at its own address with \`Accept: text/markdown\`.
The list of pages is in [the sitemap](${origin}/sitemap.xml); an overview for
language models is at [${origin}/llms.txt](${origin}/llms.txt).

## Writing a good page

Keep it short and in the owner's voice. The title is their name or brand; the
headline is one line on what they do. Put contact details and profiles in
buttons, not in the text. New sites are drafts: show the owner before you
publish.
`;
}

/** The company that runs neat.link, as the terms and the privacy notice name it. */
export const OPERATOR = "Holy Traction OÜ, Sepapaja 6, 15551 Tallinn, Estonia";

export function termsMarkdown(origin: string): string {
  return `# Terms of use

neat.link is operated by ${OPERATOR}. It is provided as is, without warranty. By making a page you confirm
that you have the right to publish what is on it and that it breaks no law.

Pages that impersonate someone, deceive visitors, collect credentials,
distribute malware, spam, or carry illegal or hateful content are removed, and
the account may be closed. Report a page to abuse@neat.link.

Handles are first come, first served. A handle that infringes a trademark or
impersonates someone may be reassigned.

You can delete your pages at any time in the [editor](${origin}/app).
`;
}

export function privacyMarkdown(origin: string): string {
  return `# Privacy

neat.link keeps what is needed to run your page and nothing more.

- **Your pages** are public once published, and listed for search engines.
- **Your account:** your Google name, email and picture if you sign in with
  Google; your Telegram ID, username and name if you link Telegram. Provider
  access tokens are never stored.
- **Sessions:** a cookie keeps you signed in for 30 days. There are no
  advertising or tracking cookies, and no analytics scripts.
- **Logs:** Cloudflare, which hosts neat.link, keeps request logs for a short
  time for security and debugging.

Delete a page in the [editor](${origin}/app). To delete your account, write to
privacy@neat.link.

The controller of this data is ${OPERATOR}.
`;
}
