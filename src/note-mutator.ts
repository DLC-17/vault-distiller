import { App, TFile } from "obsidian";
import { ConceptPrimerResult, DistilledResult, LocalOrganizerSettings, OllamaSuggestedLink } from "./types";

/**
 * Safely extracts existing tags from frontmatter, normalizing from string, comma-separated, or array formats.
 */
function extractExistingTags(rawTags: unknown): string[] {
  if (!rawTags) return [];
  if (Array.isArray(rawTags)) {
    return rawTags.map((t) => String(t).trim().replace(/^#/, "")).filter(Boolean);
  }
  if (typeof rawTags === "string") {
    return rawTags
      .split(/[\s,]+/)
      .map((t) => t.trim().replace(/^#/, ""))
      .filter(Boolean);
  }
  return [];
}

/**
 * Updates YAML frontmatter using Obsidian's official processFrontMatter API.
 * Extracts existing tags and merges with suggested tags, removes the frontmatter 'tags'
 * property so tags are placed exclusively at the end of the note, and sets note title.
 * Returns the complete merged list of tags.
 */
export async function updateFrontmatter(
  app: App,
  file: TFile,
  result: DistilledResult,
  settings: LocalOrganizerSettings
): Promise<string[]> {
  let mergedTags: string[] = [];

  await app.fileManager.processFrontMatter(file, (fm) => {
    const existing = extractExistingTags(fm.tags);
    const existingLower = new Set(existing.map((t) => t.toLowerCase()));

    const resultTags = Array.isArray(result?.tags)
      ? result.tags
      : typeof result?.tags === "string"
      ? (result.tags as string).split(/[\s,]+/)
      : [];

    for (const newTag of resultTags) {
      const clean = String(newTag).replace(/^#/, "").trim();
      if (clean && !existingLower.has(clean.toLowerCase())) {
        existing.push(clean);
        existingLower.add(clean.toLowerCase());
      }
    }
    mergedTags = existing;

    // Remove tags property from YAML frontmatter so tags are placed at the end of the note
    delete fm.tags;

    if (settings.updateFrontmatterTitle && !fm.title && result?.clean_title) {
      fm.title = result.clean_title;
    }
  });

  return mergedTags;
}

/**
 * Replaces or inserts a heading-based section (e.g., Tasks or Related Notes),
 * preceded by a '---' divider instead of HTML comment markers.
 */
function replaceOrInsertHeadingSection(
  body: string,
  heading: string,
  newContent: string
): string {
  // Look for existing heading (e.g. "## Tasks & Open Questions")
  const headingIdx = body.indexOf(heading);
  if (headingIdx !== -1) {
    const textBefore = body.slice(0, headingIdx);
    const lastHrIdx = textBefore.lastIndexOf("\n---");
    let sectionStart = headingIdx;
    if (lastHrIdx !== -1 && textBefore.slice(lastHrIdx + 4).trim() === "") {
      sectionStart = lastHrIdx;
    }

    // Find end of section: next '---', next '## ' heading, or end of text
    const textAfter = body.slice(headingIdx + heading.length);
    const nextHr = textAfter.search(/\n---(?:\s|$)/);
    const nextH2 = textAfter.search(/\n##\s/);

    let endOffset = -1;
    if (nextHr !== -1 && nextH2 !== -1) {
      endOffset = Math.min(nextHr, nextH2);
    } else if (nextHr !== -1) {
      endOffset = nextHr;
    } else if (nextH2 !== -1) {
      endOffset = nextH2;
    }

    const sectionEnd = endOffset !== -1 ? headingIdx + heading.length + endOffset : body.length;
    const before = body.slice(0, sectionStart).trimEnd();
    const after = body.slice(sectionEnd).trimStart();

    return (before + "\n\n" + newContent + (after ? "\n\n" + after : "")).trim();
  }

  // 3. If heading doesn't exist, append cleanly
  return body.trim() + "\n\n" + newContent;
}

/**
 * Updates the note body using app.vault.process for atomic file mutation.
 * Extracts the exact frontmatter boundary using app.metadataCache, updates sections idempotently,
 * and validates that suggested links exist strictly within the vault.
 */
export async function updateNoteBody(
  app: App,
  file: TFile,
  result: DistilledResult,
  settings: LocalOrganizerSettings,
  titleMap: Map<string, string>,
  tags: string[] = []
): Promise<void> {
  await app.vault.process(file, (content) => {
    let frontmatterBlock = "";
    let body = content;

    // Use metadataCache frontmatterPosition for exact byte offset
    const cache = app.metadataCache.getFileCache(file);
    const endOffset = cache?.frontmatterPosition?.end?.offset;

    if (typeof endOffset === "number" && endOffset > 0 && endOffset <= content.length) {
      frontmatterBlock = content.slice(0, endOffset) + "\n\n";
      body = content.slice(endOffset).trim();
    } else if (content.startsWith("---")) {
      const closingIdx = content.indexOf("\n---", 3);
      if (closingIdx !== -1) {
        frontmatterBlock = content.slice(0, closingIdx + 4) + "\n\n";
        body = content.slice(closingIdx + 4).trim();
      }
    }

    // Clean legacy comment markers
    body = body.replace(/<!--\s*vault-distiller:summary:start\s*-->\n?/gi, "");
    body = body.replace(/<!--\s*vault-distiller:summary:end\s*-->\n?/gi, "");
    body = body.replace(/<!--\s*vault-distiller:todos:start\s*-->\n?/gi, "---\n");
    body = body.replace(/<!--\s*vault-distiller:todos:end\s*-->\n?/gi, "");
    body = body.replace(/<!--\s*vault-distiller:links:start\s*-->\n?/gi, "---\n");
    body = body.replace(/<!--\s*vault-distiller:links:end\s*-->\n?/gi, "");

    // Extract any existing hashtag lines preceded by '---' anywhere in body
    const bodyTags: string[] = [];
    const tagLineRegex = /(?:^|\n)---\s*\n((?:#[a-zA-Z0-9_\-/]+[\t ]*(?:\r?\n)?)+)/g;
    let match;
    while ((match = tagLineRegex.exec(body)) !== null) {
      const found = match[1].match(/#([a-zA-Z0-9_\-/]+)/g);
      if (found) {
        bodyTags.push(...found.map((t) => t.replace(/^#/, "")));
      }
    }

    // Strip ALL existing tag lines and legacy tag blocks from anywhere in the body before section mutation
    body = body.replace(/(?:\r?\n---\s*)+\r?\n(?:#[a-zA-Z0-9_\-/]+[\t ]*(?:\r?\n)?)+(?=\r?\n|$)/g, "").trim();
    body = body.replace(/(?:\r?\n---\s*)+\r?\n## Tags[\s\S]*?(?=\r?\n---|---\r?\n##|$)/g, "").trim();
    body = body.replace(/(?:\r?\n---\s*)+\r?\n## Tags[\s\S]*$/g, "").trim();

    // 1. Distilled Summary section (stays at the top of the body)
    if (settings.prependSummary && result.distilled_summary) {
      const summaryLines = result.distilled_summary.split("\n").join("\n> ");
      const summaryBlock = `> [!abstract] Distilled Summary\n> ${summaryLines}`;
      
      const summaryMatch = body.match(/^>\s*\[!abstract\]\s*Distilled Summary[\s\S]*?(?=\n\n[^\n>]|\n\n#|\n\n---|---\n##|$)/);
      if (summaryMatch) {
        body = body.replace(summaryMatch[0], summaryBlock);
      } else {
        body = summaryBlock + "\n\n" + body.trim();
      }
    }

    // 2. Tasks / Todos section (append with --- divider)
    if (
      settings.appendTodos &&
      result.open_questions_or_todos &&
      result.open_questions_or_todos.length > 0
    ) {
      const todoItems = result.open_questions_or_todos.map((t) => `- [ ] ${t}`).join("\n");
      const todoBlock = `---\n## Tasks & Open Questions\n${todoItems}`;
      body = replaceOrInsertHeadingSection(
        body,
        "## Tasks & Open Questions",
        todoBlock
      );
    }

    // 3. Related Links section (append with --- divider, strictly filtered against existing vault notes)
    if (settings.appendRelatedLinks && result.suggested_links && result.suggested_links.length > 0) {
      const validLinks = result.suggested_links
        .map((link) => {
          const resolved = titleMap.get(link.title.trim().toLowerCase());
          return resolved ? { title: resolved, reason: link.reason } : null;
        })
        .filter((link): link is OllamaSuggestedLink => link !== null);

      if (validLinks.length > 0) {
        const linkItems = validLinks.map((l) => `- [[${l.title}]] — ${l.reason}`).join("\n");
        const linksBlock = `---\n## Related Notes\n${linkItems}`;
        body = replaceOrInsertHeadingSection(
          body,
          "## Related Notes",
          linksBlock
        );
      }
    }

    // 4. Tags section at the very end of the note (preceded by ---)
    body = body.replace(/(?:\r?\n---\s*)+\r?\n(?:#[a-zA-Z0-9_\-/]+[\t ]*(?:\r?\n)?)+(?=\r?\n|$)/g, "").trim();
    body = body.replace(/(?:\r?\n---\s*)+\r?\n## Tags[\s\S]*?(?=\r?\n---|---\r?\n##|$)/g, "").trim();
    body = body.replace(/(?:\r?\n---\s*)+\r?\n## Tags[\s\S]*$/g, "").trim();

    const allTags = Array.from(
      new Set(
        [...tags, ...bodyTags, ...(result.tags || [])]
          .map((t) => t.replace(/^#/, "").trim().toLowerCase())
          .filter(Boolean)
      )
    );

    if (allTags.length > 0) {
      const tagLine = allTags.map((t) => `#${t}`).join(" ");
      body = body.trim() + `\n\n---\n${tagLine}\n`;
    }

    return frontmatterBlock + body;
  });
}

/**
 * Strips characters that are illegal in file systems or Obsidian wikilinks.
 */
export function sanitizeFilename(title: string): string {
  if (!title) return "";
  let clean = title
    .replace(/[/\\:*?"<>|#^[\]]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  clean = clean.replace(/[.\s]+$/, "");
  return clean;
}

export interface FileOrganizeResult {
  newPath: string | null;
  renamed: boolean;
  moved: boolean;
  newTitle: string;
  targetFolder: string;
}

/**
 * Reformats filenames and titles for notes sourced from social media, video platforms,
 * or ReelScribe (e.g. "alex3danim_How_to_Animate_Lego_DbLsFBpvJeW") to follow the convention:
 * "<Topic> by <author> <platform>" (e.g. "How to animate lego by alex3danim instagram").
 */
export function formatSourcedTitle(
  basename: string,
  frontmatter: Record<string, unknown> = {},
  fallbackTitle?: string
): string {
  // 1. Detect platform
  let platform = "";
  const url = String(frontmatter.url || "").toLowerCase();
  const fmTags = Array.isArray(frontmatter.tags)
    ? frontmatter.tags.map(String).join(" ").toLowerCase()
    : String(frontmatter.tags || "").toLowerCase();

  if (url.includes("instagram.com") || fmTags.includes("instagram")) {
    platform = "instagram";
  } else if (url.includes("youtube.com") || url.includes("youtu.be") || fmTags.includes("youtube")) {
    platform = "youtube";
  } else if (url.includes("tiktok.com") || fmTags.includes("tiktok")) {
    platform = "tiktok";
  } else if (url.includes("twitter.com") || url.includes("x.com") || fmTags.includes("twitter")) {
    platform = "twitter";
  }

  // 2. Check 3-part ReelScribe/Instagram pattern: <author>_<slug>_<media_id>
  // e.g. alex3danim_How_to_Animate_Lego_DbLsFBpvJeW
  const firstUnderscore = basename.indexOf("_");
  if (firstUnderscore !== -1) {
    const rawAuthor = basename.slice(0, firstUnderscore);
    let mediaId = "";
    let rawSlug = "";

    const fmMediaId = typeof frontmatter.media_id === "string" ? frontmatter.media_id.trim() : "";
    if (fmMediaId && basename.endsWith("_" + fmMediaId)) {
      mediaId = fmMediaId;
      rawSlug = basename.slice(firstUnderscore + 1, -(mediaId.length + 1));
    } else {
      const lastUnderscore = basename.lastIndexOf("_");
      if (lastUnderscore > firstUnderscore) {
        mediaId = basename.slice(lastUnderscore + 1);
        rawSlug = basename.slice(firstUnderscore + 1, lastUnderscore);
      }
    }

    if (mediaId && /^[A-Za-z0-9_-]{6,20}$/.test(mediaId) && rawSlug) {
      if (!platform) platform = "instagram";

      let topicWords = rawSlug.replace(/_/g, " ").trim();
      const fmTitle = String(frontmatter.title || "").trim();
      if (topicWords.length <= 4 && fmTitle && fmTitle.length > topicWords.length) {
        topicWords = fmTitle;
      }

      const topic = topicWords.charAt(0).toUpperCase() + topicWords.slice(1).toLowerCase();
      const author = rawAuthor
        ? rawAuthor.replace(/[/\\:*?"<>|#^[\]]/g, "").trim()
        : String(frontmatter.author || "").replace(/[/\\:*?"<>|#^[\]]/g, "").trim();

      return sanitizeFilename(`${topic} by ${author} ${platform}`);
    }
  }

  // 3. If social media metadata is present, ensure author and platform are included
  if (platform && frontmatter.author && (fallbackTitle || frontmatter.title)) {
    const baseTitle = String(fallbackTitle || frontmatter.title || basename)
      .replace(/\.md$/, "")
      .trim();

    if (!baseTitle.toLowerCase().includes("by ") && !baseTitle.toLowerCase().includes(platform)) {
      const topic = baseTitle.charAt(0).toUpperCase() + baseTitle.slice(1).toLowerCase();
      const author = String(frontmatter.author)
        .replace(/[/\\:*?"<>|#^[\]]/g, "")
        .replace(/\s+/g, "")
        .trim();
      return sanitizeFilename(`${topic} by ${author} ${platform}`);
    }
  }

  return sanitizeFilename(fallbackTitle || basename);
}

/**
 * Renames the file based on the AI clean topic title and/or relocates it to the suggested folder.
 * Uses app.fileManager.renameFile so Obsidian automatically updates all wikilinks across the vault.
 */
export async function organizeFileLocation(
  app: App,
  file: TFile,
  cleanTitle: string | undefined,
  suggestedFolder: string | undefined,
  validFolders: Set<string>,
  autoRename: boolean,
  autoMove: boolean
): Promise<FileOrganizeResult> {
  const currentFolder = file.parent ? file.parent.path.replace(/^\/+|\/+$/g, "") : "";
  const currentBase = file.basename;
  const ext = file.extension ? `.${file.extension}` : "";

  let targetFolder = currentFolder;
  let moved = false;
  if (autoMove && suggestedFolder && suggestedFolder.trim()) {
    const cleanFolder = suggestedFolder.trim().replace(/^\/+|\/+$/g, "");
    if (validFolders.has(cleanFolder) && cleanFolder !== currentFolder) {
      targetFolder = cleanFolder;
      moved = true;
    }
  }

  let targetBase = currentBase;
  let renamed = false;
  if (autoRename) {
    const cache = app.metadataCache.getFileCache(file);
    const fm = (cache?.frontmatter || {}) as Record<string, unknown>;
    const formatted = formatSourcedTitle(currentBase, fm, cleanTitle);
    const candidate = formatted || cleanTitle;
    if (candidate) {
      const sanitized = sanitizeFilename(candidate);
      if (sanitized && sanitized.toLowerCase() !== currentBase.toLowerCase()) {
        targetBase = sanitized;
        renamed = true;
      }
    }
  }

  if (!moved && !renamed) {
    return {
      newPath: null,
      renamed: false,
      moved: false,
      newTitle: currentBase,
      targetFolder: currentFolder,
    };
  }

  const prefix = targetFolder ? `${targetFolder}/` : "";
  let targetPath = `${prefix}${targetBase}${ext}`;

  if (app.vault.getAbstractFileByPath(targetPath) && targetPath !== file.path) {
    let counter = 1;
    while (app.vault.getAbstractFileByPath(`${prefix}${targetBase} ${counter}${ext}`)) {
      counter++;
    }
    targetPath = `${prefix}${targetBase} ${counter}${ext}`;
  }

  if (targetPath !== file.path) {
    await app.fileManager.renameFile(file, targetPath);
    return {
      newPath: targetPath,
      renamed,
      moved,
      newTitle: targetBase,
      targetFolder,
    };
  }

  return {
    newPath: null,
    renamed: false,
    moved: false,
    newTitle: currentBase,
    targetFolder: currentFolder,
  };
}

export interface ReformatResult {
  file: TFile;
  renamed: boolean;
  oldPath: string;
  newPath: string;
  newTitle: string;
  tagsMoved: number;
}

/**
 * Deterministically reformats any note in the vault to adhere to vault-distiller conventions:
 * 1. Removes 'tags:' from YAML frontmatter so tags do not clutter the top of the note.
 * 2. Keeps distilled summaries at the top.
 * 3. Cleans up legacy comment markers into clean '---' markdown dividers.
 * 4. Appends all tags at the very end of the note preceded by '---'.
 * 5. Renames sourced files (e.g. alex3danim_How_to_Animate_Lego_DbLsFBpvJeW) to '<Topic> by <author> <platform>'.
 */
export async function reformatNoteToConvention(
  app: App,
  file: TFile
): Promise<ReformatResult> {
  const originalPath = file.path;
  const originalBasename = file.basename;

  // 1. Read existing frontmatter
  const cache = app.metadataCache.getFileCache(file);
  const fm = (cache?.frontmatter || {}) as Record<string, unknown>;
  const fmTags = extractExistingTags(fm.tags);

  // 2. Read content to find existing tags or comment markers
  const rawContent = await app.vault.read(file);

  // Extract any existing hashtag lines preceded by '---' anywhere in body
  const bodyTags: string[] = [];
  const tagLineRegex = /(?:^|\n)---\s*\n((?:#[a-zA-Z0-9_\-/]+[\t ]*(?:\r?\n)?)+)/g;
  let match;
  while ((match = tagLineRegex.exec(rawContent)) !== null) {
    const found = match[1].match(/#([a-zA-Z0-9_\-/]+)/g);
    if (found) {
      bodyTags.push(...found.map((t) => t.replace(/^#/, "")));
    }
  }

  const allTags = Array.from(
    new Set(
      [...fmTags, ...bodyTags]
        .map((t) => t.replace(/^#/, "").trim().toLowerCase())
        .filter(Boolean)
    )
  );

  // 3. Process frontmatter: delete fm.tags
  if (fm.tags !== undefined) {
    await app.fileManager.processFrontMatter(file, (frontmatter) => {
      delete frontmatter.tags;
    });
  }

  // 4. Process body: clean comments, ensure summary at top, place tags at very end
  await app.vault.process(file, (content) => {
    let frontmatterBlock = "";
    let body = content;

    const fileCache = app.metadataCache.getFileCache(file);
    const endOffset = fileCache?.frontmatterPosition?.end?.offset;
    if (typeof endOffset === "number" && endOffset > 0 && endOffset <= content.length) {
      frontmatterBlock = content.slice(0, endOffset) + "\n\n";
      body = content.slice(endOffset).trim();
    } else if (content.startsWith("---")) {
      const closingIdx = content.indexOf("\n---", 3);
      if (closingIdx !== -1) {
        frontmatterBlock = content.slice(0, closingIdx + 4) + "\n\n";
        body = content.slice(closingIdx + 4).trim();
      }
    }

    // Clean legacy comment markers
    body = body.replace(/<!--\s*vault-distiller:summary:start\s*-->\n?/gi, "");
    body = body.replace(/<!--\s*vault-distiller:summary:end\s*-->\n?/gi, "");
    body = body.replace(/<!--\s*vault-distiller:todos:start\s*-->\n?/gi, "---\n");
    body = body.replace(/<!--\s*vault-distiller:todos:end\s*-->\n?/gi, "");
    body = body.replace(/<!--\s*vault-distiller:links:start\s*-->\n?/gi, "---\n");
    body = body.replace(/<!--\s*vault-distiller:links:end\s*-->\n?/gi, "");

    // Strip ALL existing tag lines and legacy tag blocks from anywhere in the body
    body = body.replace(/(?:\r?\n---\s*)+\r?\n(?:#[a-zA-Z0-9_\-/]+[\t ]*(?:\r?\n)?)+(?=\r?\n|$)/g, "").trim();
    body = body.replace(/(?:\r?\n---\s*)+\r?\n## Tags[\s\S]*?(?=\r?\n---|---\r?\n##|$)/g, "").trim();
    body = body.replace(/(?:\r?\n---\s*)+\r?\n## Tags[\s\S]*$/g, "").trim();

    // Ensure clean single divider before Tasks and Related Notes headings
    body = body.replace(/(?:\s*\r?\n)*\s*(?:---\s*)?\r?\n(## Tasks & Open Questions)/g, "\n\n---\n$1");
    body = body.replace(/(?:\s*\r?\n)*\s*(?:---\s*)?\r?\n(## Related Notes)/g, "\n\n---\n$1");

    // Append tags strictly at the very end
    if (allTags.length > 0) {
      const tagLine = allTags.map((t) => `#${t}`).join(" ");
      body = body.trim() + `\n\n---\n${tagLine}\n`;
    }

    return frontmatterBlock + body;
  });

  // 5. Check if file should be renamed according to sourced title convention
  const newTitle = formatSourcedTitle(
    originalBasename,
    fm,
    typeof fm.title === "string" ? fm.title : undefined
  );
  let renamed = false;
  let newPath = file.path;

  if (newTitle && newTitle.toLowerCase() !== originalBasename.toLowerCase()) {
    const parentDir = file.parent ? file.parent.path : "";
    const prefix = parentDir && parentDir !== "/" ? `${parentDir}/` : "";
    const targetPath = `${prefix}${newTitle}.md`;

    if (targetPath !== file.path && !app.vault.getAbstractFileByPath(targetPath)) {
      await app.fileManager.renameFile(file, targetPath);
      renamed = true;
      newPath = targetPath;
    }
  }

  return {
    file,
    renamed,
    oldPath: originalPath,
    newPath,
    newTitle,
    tagsMoved: allTags.length,
  };
}


/**
 * Ensures target folder hierarchy exists in the vault.
 */
export async function ensureFolderExists(app: App, folderPath: string): Promise<void> {
  const clean = folderPath.trim().replace(/^\/+|\/+$/g, "");
  if (!clean) return;

  const parts = clean.split("/");
  let currentPath = "";
  for (const part of parts) {
    currentPath = currentPath ? `${currentPath}/${part}` : part;
    if (!app.vault.getAbstractFileByPath(currentPath)) {
      try {
        await app.vault.createFolder(currentPath);
      } catch {
        // Folder may have been created concurrently or already exists
      }
    }
  }
}

/**
 * Robustly resolves the target folder for a concept primer.
 * Normalizes slashes, performs case-insensitive matching against existing vault folders,
 * supports nested subfolders, and falls back to defaultConceptFolder or originating note folder.
 */
export function resolveConceptTargetFolder(
  suggestedFolder: string | undefined,
  originatingFile: TFile | null,
  validFolders: Set<string>,
  defaultFolder: string = "Computer Science"
): string {
  if (suggestedFolder !== undefined && suggestedFolder !== null) {
    const raw = suggestedFolder.trim().replace(/^\/+|\/+$/g, "");

    // If user explicitly chose root of vault
    if (raw === "") {
      return "";
    }

    // 1. Direct match in validFolders
    if (validFolders.has(raw)) return raw;

    // 2. Case-insensitive match against validFolders
    const lower = raw.toLowerCase();
    for (const f of validFolders) {
      if (f.toLowerCase() === lower) return f;
    }

    // 3. Parent directory match (e.g. "Computer Science/Web" when "Computer Science" exists)
    const parts = raw.split("/");
    if (parts.length > 1) {
      const parent = parts.slice(0, -1).join("/");
      for (const f of validFolders) {
        if (f.toLowerCase() === parent.toLowerCase()) {
          return `${f}/${parts[parts.length - 1]}`;
        }
      }
    }

    // 4. Valid subfolder name that can be created
    if (!/[\\:*?"<>|#^[\]]/.test(raw) && raw !== "." && raw !== "..") {
      return raw;
    }
  }

  // 5. Fallback: originating file's folder if nested
  if (
    originatingFile &&
    originatingFile.parent &&
    originatingFile.parent.path &&
    originatingFile.parent.path !== "/"
  ) {
    return originatingFile.parent.path.replace(/^\/+|\/+$/g, "");
  }

  // 6. Fallback: defaultFolder setting
  if (defaultFolder && defaultFolder.trim()) {
    return defaultFolder.trim().replace(/^\/+|\/+$/g, "");
  }

  // 7. Ultimate fallback
  for (const candidate of ["Computer Science", "Concepts", "Reference", "Notes"]) {
    for (const f of validFolders) {
      if (f.toLowerCase() === candidate.toLowerCase()) return f;
    }
  }

  return "Concepts";
}

/**
 * Creates and formats a new concept primer file in the vault,
 * places it in the target folder, and links it back to the originating file.
 */
export async function createConceptNote(
  app: App,
  primer: ConceptPrimerResult,
  originatingFile: TFile | null,
  validFolders: Set<string>,
  defaultFolder?: string
): Promise<TFile> {
  const sanitizedTitle = sanitizeFilename(primer.title);
  if (!sanitizedTitle) {
    throw new Error("Invalid concept title generated.");
  }

  // Determine destination folder robustly
  const targetFolder = resolveConceptTargetFolder(
    primer.suggested_folder,
    originatingFile,
    validFolders,
    defaultFolder
  );

  if (targetFolder) {
    await ensureFolderExists(app, targetFolder);
  }

  const prefix = targetFolder ? `${targetFolder}/` : "";
  let targetPath = `${prefix}${sanitizedTitle}.md`;

  // Prevent collision
  if (app.vault.getAbstractFileByPath(targetPath)) {
    let counter = 1;
    while (app.vault.getAbstractFileByPath(`${prefix}${sanitizedTitle} ${counter}.md`)) {
      counter++;
    }
    targetPath = `${prefix}${sanitizedTitle} ${counter}.md`;
  }

  // Format tags for the very end of the note
  const tagsList = Array.from(
    new Set(primer.tags.map((t) => t.replace(/^#/, "").trim().toLowerCase()).filter(Boolean))
  );
  const tagLine = tagsList.length > 0 ? tagsList.map((t) => `#${t}`).join(" ") : "#concept";
  const tagBlock = `\n---\n${tagLine}\n`;

  // Format principles
  const principlesBlock =
    primer.core_principles && primer.core_principles.length > 0
      ? primer.core_principles.map((p) => `- **${p}**`).join("\n")
      : "- Foundational concepts and mechanisms.";

  // Format quickstart implementation tutorial
  let tutorialBlock = "";
  if (primer.brief_tutorial && primer.brief_tutorial.length > 0) {
    const steps = primer.brief_tutorial
      .map((s, idx) => {
        const clean = s.replace(/^\d+[\.\)]\s*/, "").trim();
        return `${idx + 1}. ${clean}`;
      })
      .join("\n");
    tutorialBlock = `\n## Quickstart Implementation Tutorial\n${steps}\n`;
  }

  // Format code / syntax block
  let codeBlock = "";
  if (primer.code_or_syntax_example && primer.code_or_syntax_example.trim()) {
    codeBlock = `\n## Practical Syntax & Example\n\`\`\`text\n${primer.code_or_syntax_example.trim()}\n\`\`\`\n`;
  }

  // Format context across your vault
  let vaultContextBlock = "";
  if (originatingFile) {
    vaultContextBlock = `\n## Context Across Your Vault\n- Discovered and introduced in [[${originatingFile.basename}]].\n`;
  }

  // Format related notes
  let relatedBlock = "";
  if (primer.suggested_links && primer.suggested_links.length > 0) {
    const linkItems = primer.suggested_links
      .map((l) => `- [[${l.title}]] — ${l.reason}`)
      .join("\n");
    relatedBlock = `\n---\n## Related Notes\n${linkItems}\n`;
  }

  const dateStr = new Date().toISOString().split("T")[0];

  const fullContent = `---
title: ${sanitizedTitle}
type: reference-primer
created: ${dateStr}
---

> [!abstract] Executive Overview
> ${primer.overview.split("\n").join("\n> ")}

## Core Principles & How It Works
${principlesBlock}
${tutorialBlock}${codeBlock}${vaultContextBlock}${relatedBlock}${tagBlock}`;

  const createdFile = await app.vault.create(targetPath, fullContent);

  // Wire backlink into originating note's ## Related Notes section
  if (originatingFile && originatingFile.extension === "md") {
    await app.vault.process(originatingFile, (content) => {
      const linkEntry = `- [[${sanitizedTitle}]] — Reference primer`;
      const heading = "## Related Notes";
      const headingIdx = content.indexOf(heading);

      if (headingIdx !== -1) {
        if (!content.includes(`[[${sanitizedTitle}]]`)) {
          return (
            content.slice(0, headingIdx + heading.length) +
            "\n" +
            linkEntry +
            content.slice(headingIdx + heading.length)
          );
        }
        return content;
      } else {
        return content.trim() + `\n\n---\n## Related Notes\n${linkEntry}`;
      }
    });
  }

  return createdFile;
}
