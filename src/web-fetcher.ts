import { requestUrl } from "obsidian";

export interface FetchedContent {
  url: string;
  title: string;
  text: string;
  isArxiv: boolean;
  authors?: string[];
  published?: string;
}

/**
 * Detects if a string is or contains an HTTP/HTTPS URL.
 */
export function extractUrlFromText(text: string): string | null {
  const match = text.match(/https?:\/\/[^\s<>"')]+(?:\([^\s<>"')]*\)|[^\s`!()\[\]{};:'".,<>?«»“”‘’])/i);
  return match ? match[0] : null;
}

/**
 * Checks if a URL points to arXiv.org.
 */
export function isArxivUrl(url: string): boolean {
  return /arxiv\.org\/(?:abs|pdf)\/(\d+\.\d+(?:v\d+)?|[a-z\-]+(?:\.[a-z\-]+)?\/\d+)/i.test(url);
}

/**
 * Extracts arXiv paper ID from an arXiv URL.
 */
export function extractArxivId(url: string): string | null {
  const match = url.match(/arxiv\.org\/(?:abs|pdf)\/([0-9]+\.[0-9]+(?:v[0-9]+)?|[a-z\-]+(?:\.[a-z\-]+)?\/[0-9]+)/i);
  if (match) {
    return match[1].replace(/\.pdf$/i, "");
  }
  return null;
}

/**
 * Fetches paper metadata from the official arXiv export API.
 */
export async function fetchArxivMetadata(arxivId: string, originalUrl: string): Promise<FetchedContent> {
  const apiUrl = `https://export.arxiv.org/api/query?id_list=${encodeURIComponent(arxivId)}`;
  
  const response = await requestUrl({
    url: apiUrl,
    method: "GET",
    headers: {
      "User-Agent": "ObsidianVaultDistiller/1.0 (academic note assistant)",
    },
  });

  const xml = response.text;
  
  // Extract title
  const titleMatch = xml.match(/<entry>[\s\S]*?<title>([\s\S]*?)<\/title>/i);
  const rawTitle = titleMatch ? titleMatch[1].replace(/\s+/g, " ").trim() : `arXiv:${arxivId}`;

  // Extract summary / abstract
  const summaryMatch = xml.match(/<entry>[\s\S]*?<summary>([\s\S]*?)<\/summary>/i);
  const abstract = summaryMatch ? summaryMatch[1].replace(/\s+/g, " ").trim() : "";

  // Extract authors
  const authors: string[] = [];
  const authorRegex = /<author>\s*<name>([\s\S]*?)<\/name>\s*<\/author>/gi;
  let aMatch;
  while ((aMatch = authorRegex.exec(xml)) !== null) {
    authors.push(aMatch[1].trim());
  }

  // Extract published date
  const pubMatch = xml.match(/<published>([\s\S]*?)<\/published>/i);
  const published = pubMatch ? pubMatch[1].slice(0, 10) : undefined;

  let text = `# ${rawTitle}\n\n`;
  if (authors.length > 0) {
    text += `**Authors**: ${authors.slice(0, 8).join(", ")}${authors.length > 8 ? " et al." : ""}\n`;
  }
  if (published) {
    text += `**Published**: ${published}\n`;
  }
  text += `**arXiv ID**: [${arxivId}](${originalUrl})\n\n`;
  text += `## Abstract\n\n${abstract}\n`;

  return {
    url: originalUrl,
    title: rawTitle,
    text,
    isArxiv: true,
    authors,
    published,
  };
}

/**
 * Fetches and converts a standard web page into clean markdown text.
 */
export async function fetchWebContent(url: string, maxChars: number = 10000): Promise<FetchedContent> {
  // 1. If it's arXiv, use the dedicated high-accuracy metadata API
  if (isArxivUrl(url)) {
    const arxivId = extractArxivId(url);
    if (arxivId) {
      try {
        return await fetchArxivMetadata(arxivId, url);
      } catch (err) {
        console.warn("arXiv API fetch failed, falling back to standard web fetch", err);
      }
    }
  }

  // 2. Fetch HTML page
  const response = await requestUrl({
    url,
    method: "GET",
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 (ObsidianVaultDistiller/1.0)",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
  });

  const html = response.text;

  // Extract page title
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  let title = titleMatch ? titleMatch[1].trim() : "Web Article";
  title = title.replace(/\s+/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");

  // Remove scripts, styles, svgs, navigation, headers, footers
  let cleanHtml = html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, "")
    .replace(/<svg\b[^<]*(?:(?!<\/svg>)<[^<]*)*<\/svg>/gi, "")
    .replace(/<noscript\b[^<]*(?:(?!<\/noscript>)<[^<]*)*<\/noscript>/gi, "")
    .replace(/<nav\b[^<]*(?:(?!<\/nav>)<[^<]*)*<\/nav>/gi, "")
    .replace(/<footer\b[^<]*(?:(?!<\/footer>)<[^<]*)*<\/footer>/gi, "")
    .replace(/<header\b[^<]*(?:(?!<\/header>)<[^<]*)*<\/header>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "");

  // Convert headings
  cleanHtml = cleanHtml.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, "\n\n# $1\n\n");
  cleanHtml = cleanHtml.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, "\n\n## $1\n\n");
  cleanHtml = cleanHtml.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, "\n\n### $1\n\n");
  cleanHtml = cleanHtml.replace(/<h4[^>]*>([\s\S]*?)<\/h4>/gi, "\n\n#### $1\n\n");

  // Convert paragraphs & list items
  cleanHtml = cleanHtml.replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, "\n\n$1\n\n");
  cleanHtml = cleanHtml.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, "\n- $1");
  cleanHtml = cleanHtml.replace(/<br\s*[\/]?>/gi, "\n");

  // Convert pre/code blocks
  cleanHtml = cleanHtml.replace(/<pre[^>]*><code[^>]*>([\s\S]*?)<\/code><\/pre>/gi, "\n```\n$1\n```\n");
  cleanHtml = cleanHtml.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, "`$1`");

  // Strip remaining HTML tags
  let text = cleanHtml.replace(/<[^>]+>/g, " ");

  // Decode common HTML entities
  text = text
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#x27;/gi, "'")
    .replace(/&#x2F;/gi, "/");

  // Normalize whitespace and blank lines
  text = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line, i, arr) => line.length > 0 || (i > 0 && arr[i - 1].length > 0))
    .join("\n")
    .trim();

  // Cap length
  if (text.length > maxChars) {
    const cut = text.lastIndexOf("\n\n", maxChars);
    text = (cut > maxChars * 0.7 ? text.slice(0, cut) : text.slice(0, maxChars)) +
      "\n\n[... Remaining webpage content truncated for context limit ...]";
  }

  return {
    url,
    title,
    text,
    isArxiv: false,
  };
}

/**
 * Attempts to fetch authoritative technical documentation overview for a technology
 * when no local note exists in the vault.
 */
export async function fetchTechnicalDocumentation(topic: string): Promise<FetchedContent | null> {
  const clean = topic.trim().replace(/^[/@#]+/, "");
  if (!clean) return null;

  // 1. If it is already a direct URL
  if (clean.startsWith("http://") || clean.startsWith("https://")) {
    return await fetchWebContent(clean);
  }

  // 2. Query technical REST endpoint
  try {
    const apiUrl = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(clean)}`;
    const response = await requestUrl({
      url: apiUrl,
      method: "GET",
      headers: {
        "User-Agent": "ObsidianVaultDistiller/1.0 (academic knowledge assistant)",
        Accept: "application/json",
      },
    });

    const data = response.json;
    if (data && data.title && data.extract && data.type !== "disambiguation") {
      const pageUrl =
        data.content_urls?.desktop?.page ||
        `https://en.wikipedia.org/wiki/${encodeURIComponent(clean)}`;
      const text = `# ${data.title}\n\n> ${data.description || "Technical Documentation"}\n\n${data.extract}\n\nSource: [${data.title} Reference](${pageUrl})`;
      return {
        url: pageUrl,
        title: data.title,
        text,
        isArxiv: false,
      };
    }
  } catch {
    // Return null if offline or not found
  }

  return null;
}
