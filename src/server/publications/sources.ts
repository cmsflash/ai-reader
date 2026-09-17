import { JSDOM, VirtualConsole } from "jsdom";
export const publicationSources = {
  "openai-misalignment": {
    name: "OpenAI Misalignment Reports",
    url: "https://alignment.openai.com/misalignment-reports/",
  },
  "anthropic-alignment": {
    name: "Anthropic Alignment Science",
    url: "https://alignment.anthropic.com/",
  },
  "rundown-ai": {
    name: "The Rundown AI",
    url: "https://www.therundown.ai/articles-category/ai",
  },
} as const;
export type PublicationSource = keyof typeof publicationSources;
export type PublicationEntry = {
  url: string;
  title: string;
  html?: string;
  publishedAt?: string;
};
export function publicationEntries(
  source: PublicationSource,
  html: string,
): PublicationEntry[] {
  const base = publicationSources[source].url;
  const dom = new JSDOM(html, {
    url: base,
    virtualConsole: new VirtualConsole(),
  });
  try {
    const document = dom.window.document;
    const entries: PublicationEntry[] = [];
    if (source === "openai-misalignment") {
      for (const notice of document.querySelectorAll("article.ap-notice[id]")) {
        const title = notice.querySelector("h3")?.textContent?.trim();
        if (!title) continue;
        entries.push({
          url: `${base}#${notice.id}`,
          title: `${title} — Misalignment notice`,
          html: notice.outerHTML,
          publishedAt:
            notice.querySelector("time")?.getAttribute("datetime") ?? undefined,
        });
      }
      for (const link of document.querySelectorAll<HTMLAnchorElement>(
        "a.ap-report-link[href]",
      )) {
        const url = new URL(link.href, base);
        const title = link.querySelector("h3,h2")?.textContent?.trim();
        if (
          title &&
          url.origin === new URL(base).origin &&
          url.pathname.startsWith("/misalignment-reports/") &&
          url.pathname !== new URL(base).pathname
        )
          entries.push({ url: url.href, title });
      }
    } else if (source === "rundown-ai") {
      for (const link of document.querySelectorAll<HTMLAnchorElement>(
        'a[href] > h3',
      )) {
        const anchor = link.parentElement as HTMLAnchorElement;
        const url = new URL(anchor.href, base);
        const title = link.textContent?.trim();
        if (
          title &&
          url.origin === new URL(base).origin &&
          /^\/articles\/[^/]+\/?$/.test(url.pathname) &&
          anchor.querySelector("span")?.textContent?.trim() === "AI"
        ) {
          url.search = "";
          url.hash = "";
          entries.push({ url: url.href, title });
        }
      }
    } else {
      for (const link of document.querySelectorAll<HTMLAnchorElement>(
        ".toc a[href]",
      )) {
        const title = link.querySelector("h3")?.textContent?.trim();
        const url = new URL(link.href, base);
        if (
          !title ||
          ![
            "alignment.anthropic.com",
            "www.anthropic.com",
            "arxiv.org",
          ].includes(url.hostname)
        )
          continue;
        entries.push({ url: url.href, title });
      }
    }
    if (!entries.length)
      throw new Error(
        `No publications found for ${source}; the source layout may have changed.`,
      );
    return [...new Map(entries.map((entry) => [entry.url, entry])).values()];
  } finally {
    dom.window.close();
  }
}
