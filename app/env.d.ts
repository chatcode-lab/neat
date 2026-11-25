// Values `wrangler types` cannot know: what tests and other environments set.
declare namespace Cloudflare {
  interface Env {
    /** "production" where pages may be indexed; anything else keeps crawlers out. */
    ENVIRONMENT: string;
    /** Production only: a token that may edit the neat.link zone's custom hostnames. */
    CF_API_TOKEN?: string;
  }
}

// Built files imported as their public address, such as a font to preload.
declare module "*?url" {
  const href: string;
  export default href;
}

// Markdown files imported as text, such as the API guide.
declare module "*.md?raw" {
  const content: string;
  export default content;
}
