// Values `wrangler types` cannot know: what tests and other environments set.
declare namespace Cloudflare {
  interface Env {
    /** "production" where pages may be indexed; anything else keeps crawlers out. */
    ENVIRONMENT: string;
  }
}

// Markdown files imported as text, such as the API guide.
declare module "*.md?raw" {
  const content: string;
  export default content;
}
