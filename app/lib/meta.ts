import type { MetaDescriptor } from "react-router";

export interface PageMetaInput {
  title: string;
  description: string;
  /** The page's own address, absolute. */
  url: string;
  /** Its cover, absolute, 1200 by 630. */
  image: string;
  /** The page's Markdown, for agents. */
  markdown?: string;
  /** Kept out of search engines: private pages, drafts, the editor. */
  noindex?: boolean;
  /** "profile" for a person's page, "website" otherwise. */
  type?: "website" | "profile";
}

/** Title, description, canonical address, OpenGraph and Twitter tags for a page. */
export function pageMeta(input: PageMetaInput): MetaDescriptor[] {
  return [
    { title: input.title },
    { name: "description", content: input.description },
    { tagName: "link", rel: "canonical", href: input.url },
    ...(input.markdown ? [{ tagName: "link", rel: "alternate", type: "text/markdown", href: input.markdown }] : []),
    ...(input.noindex ? [{ name: "robots", content: "noindex" }] : []),
    { property: "og:site_name", content: "neat.link" },
    { property: "og:type", content: input.type ?? "website" },
    { property: "og:title", content: input.title },
    { property: "og:description", content: input.description },
    { property: "og:url", content: input.url },
    { property: "og:image", content: input.image },
    { property: "og:image:width", content: "1200" },
    { property: "og:image:height", content: "630" },
    { name: "twitter:card", content: "summary_large_image" },
    { name: "twitter:title", content: input.title },
    { name: "twitter:description", content: input.description },
    { name: "twitter:image", content: input.image },
  ];
}

/** A private page's tags: a title, and kept out of search engines. */
export function privateMeta(title: string): MetaDescriptor[] {
  return [{ title: `${title} · neat.link` }, { name: "robots", content: "noindex" }];
}
