/**
 * The site's own words, written once in Markdown: pages render them, and
 * their .md views and llms.txt serve them as they are.
 */

export const TAGLINE = "One neat page for all your links.";

/** The plans, in a few lines, for the home page and agents. */
export const PRICING = `- **Free:** 2 published pages, and 2 drafts.
- **Own domain:** $10 once. Your pages at your own domains.
- **Pro:** $50 a year, or $100 once for good. Up to 10 pages, own domains, subpages such as articles, files to embed (pictures, video, audio, PDFs), Google, Meta and TikTok pixels, and no neat.link sign.

Prices plus VAT where it applies.`;

export function homeMarkdown(origin: string, bot: string): string {
  const host = new URL(origin).host;
  return `# neat.link

${TAGLINE} A picture, your name, a few lines about you and a button for every
place people can find you: ${host}/yourname.

- **Simple.** A page is a title, a short Markdown text and buttons. Nothing to design.
- **Fast and findable.** Pages load instantly, look right in light and dark, and are listed for search engines.
- **Agent-friendly.** Let Claude, ChatGPT or any MCP client write and update your page. Every page is also Markdown at ${host}/yourname.md.
- **Telegram too.** Open the editor from [@${bot}](https://t.me/${bot}).

## Pricing

${PRICING}

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
\`update_site\`, \`set_picture\`, \`remove_picture\`, \`delete_site\`; with a paid
plan \`set_domain\`, \`check_domain\`, \`remove_domain\`, \`list_subpages\`,
\`create_subpage\`, \`update_subpage\`, \`rotate_subpage_link\`,
\`delete_subpage\`, \`list_files\`, \`upload_file\`, \`create_upload_link\`,
\`delete_file\`; and \`get_plan\` and \`start_checkout\`, which gives a payment
link for the owner to open.

## Use the HTTP API

Make a token in [Settings](${origin}/app/settings) and send it as
\`Authorization: Bearer <token>\`. The guide is at [${origin}/api/v1](${origin}/api/v1).

## Read any page

Every published page is Markdown at its address plus \`.md\` (for example
\`${origin}/borkasm.md\`), or at its own address with \`Accept: text/markdown\`.
The list of pages is in [the sitemap](${origin}/sitemap.xml); an overview for
language models is at [${origin}/llms.txt](${origin}/llms.txt).

## Writing a good page

Keep it short and in the owner's voice. The title is their name or brand; the
headline is one line on what they do. Put contact details and profiles in
buttons, not in the text. New sites are drafts: show the owner before you
publish.

## What only the owner can do

Sign up (with Google), pay, and add DNS records for their own domain.
Everything else an agent can do. When the owner wants something their plan
lacks, \`start_checkout\` gives them a link to pay; the plan changes as soon
as they have.

## Plans

${PRICING}
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
impersonates someone may be reassigned. The same goes for a domain connected
to a page: you confirm it is yours to use.

You can delete your pages at any time in the [editor](${origin}/app).

## Payments

Paid plans are sold by ${OPERATOR} and paid through Stripe. Prices are in US
dollars, plus VAT where it applies, worked out at checkout from where you
are; businesses can give their VAT number. You get an invoice by email.

- **Own domain** and **Pro for life** are paid once and stay with your account
  for as long as neat.link runs.
- **Pro** is paid yearly and renews until you cancel it under Plan → Invoices
  and billing; it then runs to the end of the year paid for.

A paid plan starts as soon as you have paid, so you ask for it to start at
once. If it does not work for you, write to billing@neat.link within 14 days
of paying and you get your money back.

When a plan ends, nothing is deleted: pages past the free limit go back to
drafts, and domains, subpages, pixels and the hidden sign wait until a plan
has them again. Pages that break these terms are removed without a refund.

If you add tracking pixels to your page, you are responsible for them,
including asking visitors' consent where the law requires it.
`;
}

export function privacyMarkdown(origin: string): string {
  return `# Privacy

neat.link keeps what is needed to run your page and nothing more.

- **Your pages** are public once published, and listed for search engines.
- **Your account:** your Google name, email and picture if you sign in with
  Google; your Telegram ID, username and name if you link Telegram. Provider
  access tokens are never stored.
- **Sessions:** a cookie keeps you signed in for 30 days. neat.link itself
  sets no advertising or tracking cookies and runs no analytics scripts.
- **Owners' pixels:** a page's owner may add Google, Meta or TikTok pixels to
  their own page. Those load only on that page, and that owner and the
  vendor are responsible for them.
- **Payments:** Stripe processes payments, and keeps the card and billing
  details. neat.link keeps what was bought and when, and Stripe's IDs for it.
- **Files and domains:** files you upload are public at their address; a
  domain you connect is checked through public DNS and registered with
  Cloudflare, which serves it.
- **Logs:** Cloudflare, which hosts neat.link, keeps request logs for a short
  time for security and debugging.

Delete a page in the [editor](${origin}/app). To delete your account, write to
privacy@neat.link.

The controller of this data is ${OPERATOR}.
`;
}
