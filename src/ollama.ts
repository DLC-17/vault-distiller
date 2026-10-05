import { requestUrl, RequestUrlParam, RequestUrlResponse } from "obsidian";
import {
  ConceptPrimerResult,
  DiscoveredConcept,
  DistilledResult,
  OllamaSuggestedLink,
  OLLAMA_TIMEOUT_MS,
} from "./types";
import { VaultMention } from "./vault-context";

/**
 * Executes an HTTP request via Obsidian's native requestUrl wrapped in a Promise.race watchdog timer.
 * Since Obsidian does not natively support a timeout option in RequestUrlParam, this guarantees that
 * slow or stalled connections are safely terminated on the client side.
 */
export async function requestUrlWithTimeout(
  params: RequestUrlParam,
  timeoutMs: number = OLLAMA_TIMEOUT_MS
): Promise<RequestUrlResponse> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(
        new Error(
          `Ollama request timed out after ${timeoutMs / 1000}s. Check if your model is overloaded or stalled.`
        )
      );
    }, timeoutMs);
  });

  try {
    return await Promise.race([requestUrl(params), timeoutPromise]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

/**
 * Fetches the list of locally installed models from Ollama's /api/tags endpoint.
 */
export async function fetchInstalledModels(ollamaUrl: string): Promise<string[]> {
  const cleanUrl = ollamaUrl.replace(/\/+$/, "");
  const response = await requestUrlWithTimeout(
    {
      url: `${cleanUrl}/api/tags`,
      method: "GET",
      headers: { "Content-Type": "application/json" },
    },
    10_000
  );

  const data = response.json;
  if (!data?.models || !Array.isArray(data.models)) {
    throw new Error("Unexpected response structure from Ollama /api/tags");
  }

  // Filter out models that cannot be used for chat (e.g. embedding-only models)
  return data.models
    .filter((m: { name?: string; capabilities?: string[] }) => {
      const name = (m.name || "").toLowerCase();
      if (name.includes("embed") || name.includes("bge-") || name.includes("bert")) {
        return false;
      }
      if (Array.isArray(m.capabilities) && m.capabilities.length > 0) {
        return m.capabilities.includes("completion") || m.capabilities.includes("chat");
      }
      return true;
    })
    .map((m: { name: string }) => m.name);
}

/**
 * State-machine balanced brace extractor.
 * Traverses characters while respecting quoted string literals and escape characters (\"),
 * ensuring that internal curly braces inside note summaries, formulas, or code snippets do not prematurely close the JSON block.
 */
export function extractTopLevelJson(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    return trimmed;
  }

  const unfenced = raw.replace(/^```(?:json)?\s*/im, "").replace(/\s*```\s*$/m, "").trim();

  let startIdx = -1;
  let depth = 0;
  let inString = false;
  let isEscaped = false;

  for (let i = 0; i < unfenced.length; i++) {
    const char = unfenced[i];

    if (isEscaped) {
      isEscaped = false;
      continue;
    }

    if (char === "\\") {
      isEscaped = true;
      continue;
    }

    if (char === '"') {
      inString = !inString;
      continue;
    }

    if (!inString) {
      if (char === "{") {
        if (depth === 0) startIdx = i;
        depth++;
      } else if (char === "}") {
        depth--;
        if (depth === 0 && startIdx !== -1) {
          return unfenced.slice(startIdx, i + 1);
        }
      }
    }
  }

  return unfenced;
}

/**
 * Ensures all fields of a DistilledResult are strictly validated and normalized,
 * guaranteeing that tags, open_questions_or_todos, and suggested_links are ALWAYS iterable arrays.
 */
function normalizeDistilledResult(parsed: any): DistilledResult {
  let tags: string[] = [];
  if (Array.isArray(parsed?.tags)) {
    tags = parsed.tags
      .map(String)
      .map((t: string) => t.replace(/^#/, "").trim())
      .filter(Boolean);
  } else if (typeof parsed?.tags === "string") {
    tags = parsed.tags
      .split(/[\s,]+/)
      .map((t: string) => t.replace(/^#/, "").trim())
      .filter(Boolean);
  }

  let todos: string[] = [];
  if (Array.isArray(parsed?.open_questions_or_todos)) {
    todos = parsed.open_questions_or_todos.map(String).filter(Boolean);
  } else if (typeof parsed?.open_questions_or_todos === "string") {
    todos = parsed.open_questions_or_todos
      .split(/\n+/)
      .map((t: string) => t.replace(/^[-*]\s*(\[[ x]\]\s*)?/i, "").trim())
      .filter(Boolean);
  }

  let links: OllamaSuggestedLink[] = [];
  if (Array.isArray(parsed?.suggested_links)) {
    links = parsed.suggested_links
      .filter((l: any) => l && typeof l.title === "string" && l.title.trim().length > 0)
      .map((l: any) => ({
        title: String(l.title).trim(),
        reason: typeof l.reason === "string" ? l.reason.trim() : "",
      }));
  }

  let concepts: DiscoveredConcept[] = [];
  if (Array.isArray(parsed?.discovered_concepts)) {
    concepts = parsed.discovered_concepts
      .filter(
        (c: unknown): c is { name: string; suggested_folder?: string; reason?: string } =>
          Boolean(
            c &&
              typeof (c as { name?: unknown }).name === "string" &&
              (c as { name: string }).name.trim().length > 1
          )
      )
      .map((c: { name: string; suggested_folder?: string; reason?: string }) => ({
        name: c.name.trim(),
        suggested_folder: typeof c.suggested_folder === "string" ? c.suggested_folder.trim() : "",
        reason: typeof c.reason === "string" ? c.reason.trim() : "",
      }));
  }

  return {
    clean_title: typeof parsed?.clean_title === "string" ? parsed.clean_title.trim() : "",
    tags,
    distilled_summary:
      typeof parsed?.distilled_summary === "string" ? parsed.distilled_summary.trim() : "",
    suggested_links: links,
    open_questions_or_todos: todos,
    suggested_folder:
      typeof parsed?.suggested_folder === "string" ? parsed.suggested_folder.trim() : "",
    discovered_concepts: concepts,
  };
}

/**
 * Multi-layer robust JSON parser with error recovery for 3B/small models.
 */
export function parseJsonRobust(raw: string): DistilledResult {
  // 1. Try direct parse
  try {
    const direct = JSON.parse(raw);
    if (direct && typeof direct === "object") {
      return normalizeDistilledResult(direct);
    }
  } catch {
    // Continue to robust extraction
  }

  // 2. Try state-machine extraction
  const extracted = extractTopLevelJson(raw);
  try {
    const parsed = JSON.parse(extracted);
    return normalizeDistilledResult(parsed);
  } catch {
    // 3. Fallback: even if JSON was truncated by context limit, extract partial fields
    const clean_title = (raw.match(/"clean_title"\s*:\s*"([^"]+)"/i) || [])[1] || "";
    const distilled_summary = (raw.match(/"distilled_summary"\s*:\s*"([^"]+)"/i) || [])[1] || "";
    const tagsMatch = raw.match(/"tags"\s*:\s*\[([^\]]*)\]/i);
    let tags: string[] = [];
    if (tagsMatch) {
      tags = (tagsMatch[1].match(/"([^"]+)"/g) || []).map((t) => t.replace(/"/g, "").trim());
    }

    if (distilled_summary || clean_title) {
      return normalizeDistilledResult({
        clean_title,
        distilled_summary,
        tags,
      });
    }

    throw new Error(
      "Failed to parse JSON response from Ollama. The model output was malformed. Please try again or switch models."
    );
  }
}

/**
 * Distills a note using Ollama's /api/chat endpoint with strict JSON format enforcement.
 */
export async function distillNoteContent(
  ollamaUrl: string,
  model: string,
  temperature: number,
  noteTitle: string,
  noteBody: string,
  vaultTags: string[],
  vaultTitles: string[],
  vaultFolders: string[] = []
): Promise<DistilledResult> {
  const cleanUrl = ollamaUrl.replace(/\/+$/, "");

  const foldersSnippet =
    vaultFolders.length > 0
      ? `\n- suggested_folder: Choose the single best matching folder path from this exact list: [${vaultFolders.join(
          ", "
        )}]. If none of these folders are an appropriate fit, return "". Do NOT invent new folder paths.`
      : `\n- suggested_folder: Return "".`;

  const systemPrompt = `You are an expert personal knowledge management assistant for Obsidian.
Analyze the note and respond ONLY with a single JSON object.
Do NOT output any text before or after the JSON.

Strict JSON Schema:
{
  "clean_title": "Concise, descriptive title for this note",
  "tags": ["tag1", "tag2"],
  "distilled_summary": "A 2-3 sentence executive summary of the note's key ideas and insights",
  "suggested_links": [
    { "title": "ExactNoteTitle", "reason": "concise explanation of connection" }
  ],
  "open_questions_or_todos": ["Action item or follow-up question"],
  "suggested_folder": "ExactExistingFolderOrEmpty",
  "discovered_concepts": [
    { "name": "ConceptName", "suggested_folder": "ExactExistingFolderOrEmpty", "reason": "concise explanation of why this concept warrants a reference note" }
  ]
}

RULES:
- tags: Select 3-6 relevant lowercase tags. Prioritize tags from this vault taxonomy where applicable: [${vaultTags.join(
    ", "
  )}]. You may suggest new relevant tags. Do NOT prefix with #.
- suggested_links: You MUST ONLY choose note titles that exist in this exact list: [${vaultTitles.join(
    ", "
  )}]. If no existing notes are relevant, return an empty array [].
- distilled_summary: 2-3 sentences. Dense, objective, and capturing the core value.
- open_questions_or_todos: 2-5 actionable follow-ups or unanswered questions derived from the note.
- clean_title: A specific, descriptive topic title that captures the core subject of the note. SOURCED NOTE RULE: If the note or filename indicates it was sourced from social media or video platforms (e.g. Instagram, YouTube, TikTok, or format 'author_Title_mediaId'), format the title strictly as "<Topic> by <author> <platform>" (e.g. "How to animate lego by alex3danim instagram"). Strip all alphanumeric media IDs, reel shortcodes, or hashes. If not from social media or video, output a concise 3-8 word title in Title Case (strictly no illegal characters like / \\ : * ? " < > | # ^).${foldersSnippet}
- discovered_concepts: Identify 0-3 significant technical concepts, frameworks, algorithms, or tools discussed in this note that do NOT exist in the existing notes list [${vaultTitles.join(
    ", "
  )}]. If none apply, return [].`;

  const userMessage = `Current Note Title: "${noteTitle}"

Current Note Content:
---
${noteBody}
---

Produce the JSON distillation:`;

  let response: RequestUrlResponse;
  try {
    response = await requestUrlWithTimeout(
      {
        url: `${cleanUrl}/api/chat`,
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userMessage },
          ],
          format: "json",
          stream: false,
          options: {
            temperature,
            num_ctx: 8192,
          },
        }),
      },
      OLLAMA_TIMEOUT_MS
    );
  } catch (err: unknown) {
    let detail = err instanceof Error ? err.message : String(err);
    const errObj = err as { text?: string; json?: { error?: string } };
    if (errObj?.json?.error) {
      detail = errObj.json.error;
    } else if (errObj?.text) {
      try {
        const parsed = JSON.parse(errObj.text);
        if (parsed?.error) detail = parsed.error;
      } catch {
        detail = errObj.text;
      }
    }
    throw new Error(`Ollama Error (${model}): ${detail}`);
  }

  const rawJson = response.json?.message?.content;
  if (!rawJson || typeof rawJson !== "string") {
    throw new Error("Empty or invalid response received from Ollama chat endpoint.");
  }

  return parseJsonRobust(rawJson);
}

/**
 * Researches and generates a comprehensive reference primer for a specific concept,
 * synthesizing existing vault mentions with the model's pre-trained knowledge base.
 */
export async function generateConceptPrimer(
  ollamaUrl: string,
  model: string,
  temperature: number,
  conceptName: string,
  vaultMentions: VaultMention[],
  vaultFolders: string[],
  vaultTitles: string[]
): Promise<ConceptPrimerResult> {
  const cleanUrl = ollamaUrl.replace(/\/+$/, "");

  const mentionsText =
    vaultMentions.length > 0
      ? vaultMentions.map((m) => `- In [[${m.file.basename}]]: "${m.snippet}"`).join("\n")
      : "No prior mentions found in the vault.";

  const foldersList = vaultFolders.length > 0 ? `[${vaultFolders.join(", ")}]` : `[]`;

  const systemPrompt = `You are an expert technical researcher and knowledge synthesizer for Obsidian.
Your task is to write a comprehensive, authoritative reference primer about "${conceptName}".
Respond ONLY with a single JSON object.
Do NOT output any markdown text before or after the JSON.

Strict JSON Schema:
{
  "title": "${conceptName}",
  "tags": ["concept", "tag1", "tag2"],
  "overview": "A clear, thorough 2-3 sentence executive definition explaining what ${conceptName} is, its primary purpose, and why it is used.",
  "core_principles": [
    "Key principle 1 with concise explanation",
    "Key principle 2 with concise explanation",
    "Key principle 3 with concise explanation"
  ],
  "brief_tutorial": [
    "Step 1: Install & Prerequisites — exact CLI command or dependencies",
    "Step 2: Configuration & Schema — how to set up the initial configuration or structure",
    "Step 3: Core Implementation — how to write the main code logic or resolvers",
    "Step 4: Running & Testing — command to execute, run, or query the service"
  ],
  "code_or_syntax_example": "A realistic, useful code snippet, query, architecture diagram, or CLI command demonstrating ${conceptName}.",
  "suggested_folder": "BestMatchingFolderFromListOrEmpty",
  "suggested_links": [
    { "title": "ExactExistingNoteTitle", "reason": "why it connects" }
  ]
}

RULES:
- tags: Select 3-6 relevant lowercase tags. Must include "concept".
- overview: Clear, objective, informative.
- core_principles: 3-5 distinct foundational mechanisms, properties, or best practices.
- brief_tutorial: MUST ALWAYS provide 3-5 concise, step-by-step practical implementation instructions (Setup, Configure, Implement, Run) so the reader can immediately go and implement the technology.
- code_or_syntax_example: Clean code or diagram (without enclosing triple backticks; provide the raw code string).
- suggested_folder: Choose the single best matching folder from ${foldersList} (for technical tools, libraries, or computer science concepts, prefer "Computer Science" or relevant subfolder). Never leave empty unless no folder matches.
- suggested_links: Choose up to 3 note titles strictly from: [${vaultTitles.join(", ")}]. If none apply, return [].`;

  const userMessage = `Concept to research: "${conceptName}"

Mentions of "${conceptName}" from the user's existing vault notes:
---
${mentionsText}
---

Generate the comprehensive JSON reference primer:`;

  let response: RequestUrlResponse;
  try {
    response = await requestUrlWithTimeout(
      {
        url: `${cleanUrl}/api/chat`,
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userMessage },
          ],
          format: "json",
          stream: false,
          options: {
            temperature,
            num_ctx: 8192,
          },
        }),
      },
      OLLAMA_TIMEOUT_MS
    );
  } catch (err: unknown) {
    let detail = err instanceof Error ? err.message : String(err);
    const errObj = err as { text?: string; json?: { error?: string } };
    if (errObj?.json?.error) detail = errObj.json.error;
    throw new Error(`Ollama Error generating primer (${model}): ${detail}`);
  }

  const rawJson = response.json?.message?.content;
  if (!rawJson || typeof rawJson !== "string") {
    throw new Error("Empty response received from Ollama for concept primer.");
  }

  const extracted = extractTopLevelJson(rawJson);
  try {
    const parsed = JSON.parse(extracted);
    return {
      title:
        typeof parsed.title === "string" && parsed.title.trim()
          ? parsed.title.trim()
          : conceptName,
      tags: Array.isArray(parsed.tags) ? parsed.tags.map(String) : ["concept"],
      overview: typeof parsed.overview === "string" ? parsed.overview : "",
      core_principles: Array.isArray(parsed.core_principles)
        ? parsed.core_principles.map(String)
        : [],
      brief_tutorial: Array.isArray(parsed.brief_tutorial)
        ? parsed.brief_tutorial.map(String).filter(Boolean)
        : typeof parsed.brief_tutorial === "string"
        ? parsed.brief_tutorial
            .split(/\n+/)
            .map((s: string) => s.replace(/^[-*\d.)\s]+/, "").trim())
            .filter(Boolean)
        : [],
      code_or_syntax_example:
        typeof parsed.code_or_syntax_example === "string" ? parsed.code_or_syntax_example : "",
      suggested_folder:
        typeof parsed.suggested_folder === "string" ? parsed.suggested_folder.trim() : "",
      suggested_links: Array.isArray(parsed.suggested_links) ? parsed.suggested_links : [],
    };
  } catch {
    throw new Error(
      "Failed to parse concept primer JSON response from Ollama. The model output was malformed."
    );
  }
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/**
 * Sends a multi-turn chat request to Ollama /api/chat.
 */
export async function sendOllamaChat(
  ollamaUrl: string,
  model: string,
  messages: ChatMessage[],
  temperature: number = 0.3
): Promise<string> {
  const cleanUrl = ollamaUrl.replace(/\/+$/, "");

  let response: RequestUrlResponse;
  try {
    response = await requestUrlWithTimeout(
      {
        url: `${cleanUrl}/api/chat`,
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          messages,
          stream: false,
          options: {
            temperature,
            num_ctx: 8192,
          },
        }),
      },
      OLLAMA_TIMEOUT_MS
    );
  } catch (err: unknown) {
    let detail = err instanceof Error ? err.message : String(err);
    const errObj = err as { text?: string; json?: { error?: string } };
    if (errObj?.json?.error) detail = errObj.json.error;
    throw new Error(`Ollama Chat Error (${model}): ${detail}`);
  }

  const reply = response.json?.message?.content;
  if (!reply || typeof reply !== "string") {
    throw new Error("Empty response received from Ollama chat.");
  }

  return reply.trim();
}
