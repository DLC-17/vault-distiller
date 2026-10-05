import { App, TFile, TFolder } from "obsidian";

export interface VaultTitleContext {
  titles: string[];
  titleMap: Map<string, string>; // lowercase basename -> actual basename
}

interface VaultContextCache {
  tags: string[];
  titles: string[];
  titleMap: Map<string, string>;
  folders: string[];
  timestamp: number;
}

let contextCache: VaultContextCache | null = null;
const CACHE_TTL_MS = 60_000; // 60 seconds in-memory TTL

export function invalidateVaultContextCache(): void {
  contextCache = null;
}

/**
 * Gathers all non-hidden, non-trash folders in the vault.
 */
export function getVaultFolders(app: App): string[] {
  const folders = app.vault
    .getAllLoadedFiles()
    .filter((f): f is TFolder => f instanceof TFolder)
    .map((f) => f.path)
    .filter((path) => {
      if (!path || path === "/" || path === ".") return false;
      const parts = path.split("/");
      return !parts.some((p) => p.startsWith("."));
    });

  return Array.from(new Set(folders)).sort();
}

/**
 * Extracts a ranked list of unique tags across the vault sorted by occurrence frequency.
 */
export function getVaultTags(app: App, limit: number): string[] {
  try {
    const tagCounts =
      (app.metadataCache as unknown as { getTags(): Record<string, number> }).getTags?.() || {};

    return Object.entries(tagCounts)
      .map(([tag, count]) => ({ tag: tag.replace(/^#/, "").trim(), count }))
      .filter((item) => item.tag.length > 0)
      .sort((a, b) => b.count - a.count)
      .slice(0, limit)
      .map((item) => item.tag);
  } catch {
    return [];
  }
}

/**
 * Gathers all vault Markdown note titles (basenames) excluding the active file,
 * ranked by hub centrality (backlink count via resolvedLinks) and recent modification time.
 * Runs in O(N) by accumulating incoming links across resolvedLinks in a single pass.
 */
export function getRankedVaultNoteTitles(
  app: App,
  currentFile: TFile | null | undefined,
  limit: number
): VaultTitleContext {
  const backlinkCounts = new Map<string, number>();
  const resolved = app.metadataCache.resolvedLinks || {};

  for (const sourcePath in resolved) {
    const targets = resolved[sourcePath];
    for (const destPath in targets) {
      backlinkCounts.set(destPath, (backlinkCounts.get(destPath) ?? 0) + (targets[destPath] || 1));
    }
  }

  const mdFiles = app.vault
    .getMarkdownFiles()
    .filter((f) => !currentFile || f.path !== currentFile.path);
  const scored = mdFiles.map((file) => ({
    file,
    score: (backlinkCounts.get(file.path) ?? 0) * 1000 + file.stat.mtime / 1e9,
  }));

  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, limit);

  const titleMap = new Map<string, string>();
  const titles: string[] = [];
  for (const { file } of top) {
    const basename = file.basename;
    titles.push(basename);
    titleMap.set(basename.toLowerCase(), basename);
  }

  return { titles, titleMap };
}

/**
 * Returns vault tags and candidate note titles using an in-memory 60s TTL cache
 * to eliminate UI latency when processing notes in large vaults.
 */
export function getCachedVaultContext(
  app: App,
  currentFile: TFile | null | undefined,
  maxTags: number,
  maxNotes: number
): { tags: string[]; titles: string[]; titleMap: Map<string, string>; folders: string[] } {
  const now = Date.now();
  if (contextCache && now - contextCache.timestamp < CACHE_TTL_MS) {
    const filteredTitles = currentFile
      ? contextCache.titles.filter((t) => t.toLowerCase() !== currentFile.basename.toLowerCase())
      : contextCache.titles;
    return {
      tags: contextCache.tags,
      titles: filteredTitles,
      titleMap: contextCache.titleMap,
      folders: contextCache.folders,
    };
  }

  const tags = getVaultTags(app, maxTags);
  const { titles, titleMap } = getRankedVaultNoteTitles(app, currentFile, maxNotes);
  const folders = getVaultFolders(app);

  contextCache = {
    tags,
    titles,
    titleMap,
    folders,
    timestamp: now,
  };

  return { tags, titles, titleMap, folders };
}

/**
 * Extracts note body, strips existing generated vault-distiller sections,
 * and caps the content length safely at paragraph breaks to preserve markdown structure.
 */
export function sanitizeNoteBody(
  rawContent: string,
  maxChars: number,
  frontmatterEndOffset?: number
): string {
  let body = rawContent;

  // Use exact frontmatter offset from metadataCache if available
  if (
    typeof frontmatterEndOffset === "number" &&
    frontmatterEndOffset > 0 &&
    frontmatterEndOffset <= rawContent.length
  ) {
    body = rawContent.slice(frontmatterEndOffset).trim();
  } else if (body.startsWith("---")) {
    const closingIdx = body.indexOf("\n---", 3);
    if (closingIdx !== -1) {
      body = body.slice(closingIdx + 4).trim();
    }
  }

  // Strip existing vault-distiller sections so repeated runs don't inflate context
  body = body.replace(/<!--\s*vault-distiller:[a-z]+:start\s*-->[\s\S]*?<!--\s*vault-distiller:[a-z]+:end\s*-->/gi, "");

  // Also strip existing Tasks & Open Questions or Related Notes sections
  for (const heading of ["## Tasks & Open Questions", "## Related Notes"]) {
    const headingIdx = body.indexOf(heading);
    if (headingIdx !== -1) {
      const before = body.slice(0, headingIdx);
      const lastHr = before.lastIndexOf("\n---");
      const cutIdx = lastHr !== -1 && before.slice(lastHr + 4).trim() === "" ? lastHr : headingIdx;
      body = body.slice(0, cutIdx).trim();
    }
  }

  body = body.trim();

  // Paragraph-aware truncation
  if (body.length > maxChars) {
    const cleanCut = body.lastIndexOf("\n\n", maxChars);
    const cutPoint = cleanCut > maxChars * 0.7 ? cleanCut : maxChars;
    body = body.slice(0, cutPoint) + "\n\n[... Remaining note content truncated for context limit ...]";
  }

  return body;
}

export interface VaultMention {
  file: TFile;
  snippet: string;
}

/**
 * Searches the entire vault for paragraphs or bullet points mentioning the term.
 * Ignores hidden folders (.obsidian, .trash) and caps snippets to keep prompts clean.
 */
export async function findVaultMentions(
  app: App,
  term: string,
  excludeFile?: TFile,
  maxSnippets: number = 6
): Promise<VaultMention[]> {
  const cleanTerm = term.trim().toLowerCase();
  if (!cleanTerm) return [];

  const mdFiles = app.vault.getMarkdownFiles().filter((f) => {
    if (excludeFile && f.path === excludeFile.path) return false;
    const parts = f.path.split("/");
    return !parts.some((p) => p.startsWith("."));
  });

  const mentions: VaultMention[] = [];
  const regex = new RegExp(`\\b${cleanTerm.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}\\b`, "i");

  for (const file of mdFiles) {
    if (mentions.length >= maxSnippets) break;
    const content = await app.vault.cachedRead(file);
    if (!regex.test(content)) continue;

    // Extract the most relevant paragraph or line containing the term
    const paragraphs = content.split(/\n\s*\n/);
    for (const para of paragraphs) {
      if (regex.test(para)) {
        const trimmed = para.trim().replace(/^[-*#>]+\s*/, "");
        if (trimmed.length > 20 && !trimmed.startsWith("<!--")) {
          const snippet = trimmed.length > 280 ? trimmed.slice(0, 280) + "..." : trimmed;
          mentions.push({ file, snippet });
          break;
        }
      }
    }
  }

  return mentions;
}

export interface VaultDocumentationDoc {
  file: TFile;
  title: string;
  path: string;
  content: string;
  isConceptNote: boolean;
  score: number;
}

/**
 * Searches the vault specifically for documentation, concept primers, guides, or reference notes
 * matching a queried technical topic, library, or entity.
 */
export async function findRelevantVaultDocumentation(
  app: App,
  entityOrTopic: string
): Promise<VaultDocumentationDoc | null> {
  const clean = entityOrTopic.trim().toLowerCase();
  if (!clean) return null;

  const allFiles = app.vault.getMarkdownFiles().filter((f) => {
    const parts = f.path.split("/");
    return !parts.some((p) => p.startsWith("."));
  });

  const candidates: VaultDocumentationDoc[] = [];

  for (const file of allFiles) {
    let score = 0;
    const baseLower = file.basename.toLowerCase();
    const pathLower = file.path.toLowerCase();

    // 1. Exact title match or title contains topic
    if (baseLower === clean) {
      score += 100;
    } else if (baseLower.includes(clean)) {
      score += 60;
    }

    // 2. Folder relevance (Computer Science, Docs, References, Guides, Concepts)
    const isDocFolder =
      pathLower.includes("computer science") ||
      pathLower.includes("reference") ||
      pathLower.includes("doc") ||
      pathLower.includes("guide") ||
      pathLower.includes("resource") ||
      pathLower.includes("tech");
    if (isDocFolder) {
      score += 25;
    }

    // 3. Metadata / tags relevance
    const cache = app.metadataCache.getFileCache(file);
    const tags = (cache?.tags || []).map((t) => t.tag.toLowerCase());
    const isConceptNote =
      tags.some(
        (t) =>
          t.includes("concept") ||
          t.includes("doc") ||
          t.includes("reference") ||
          t.includes("guide")
      ) || pathLower.includes("computer science");
    if (isConceptNote) {
      score += 20;
    }

    if (score < 40) {
      // Check content if filename wasn't an immediate match
      const content = await app.vault.cachedRead(file);
      const regex = new RegExp(`\\b${clean.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}\\b`, "i");
      if (regex.test(file.basename) || (isDocFolder && regex.test(content))) {
        score += 30;
      }
    }

    if (score >= 40) {
      const rawContent = await app.vault.cachedRead(file);
      const fmOffset = cache?.frontmatterPosition?.end?.offset;
      const body = sanitizeNoteBody(rawContent, 6000, fmOffset);

      candidates.push({
        file,
        title: file.basename,
        path: file.path,
        content: body,
        isConceptNote,
        score,
      });
    }
  }

  if (candidates.length === 0) return null;

  candidates.sort((a, b) => b.score - a.score);
  return candidates[0];
}
