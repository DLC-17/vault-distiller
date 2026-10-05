import {
  App,
  ItemView,
  MarkdownRenderer,
  MarkdownView,
  Notice,
  setIcon,
  TFile,
  WorkspaceLeaf,
} from "obsidian";
import type LocalOrganizerPlugin from "./main";
import { ChatMessage, sendOllamaChat } from "./ollama";
import {
  findRelevantVaultDocumentation,
  findVaultMentions,
  getCachedVaultContext,
  sanitizeNoteBody,
  VaultDocumentationDoc,
} from "./vault-context";
import {
  extractUrlFromText,
  fetchTechnicalDocumentation,
  fetchWebContent,
} from "./web-fetcher";
import { ensureFolderExists, sanitizeFilename } from "./note-mutator";

export const VIEW_TYPE_CHAT = "vault-distiller-chat-view";

interface DisplayMessage {
  role: "user" | "assistant";
  content: string;
  sourceContext?: string;
}

export class ChatStudioView extends ItemView {
  plugin: LocalOrganizerPlugin;
  private messages: DisplayMessage[] = [];
  private isProcessing: boolean = false;
  private autoGroundActiveNote: boolean = true;
  private activeNoteOverride: TFile | null = null;

  // DOM Elements
  private messagesContainerEl!: HTMLElement;
  private textareaEl!: HTMLTextAreaElement;
  private sendButtonEl!: HTMLButtonElement;
  private contextPillEl!: HTMLElement;
  private statusBarEl!: HTMLElement;

  constructor(leaf: WorkspaceLeaf, plugin: LocalOrganizerPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return VIEW_TYPE_CHAT;
  }

  getDisplayText(): string {
    return "AI Chat Studio";
  }

  getIcon(): string {
    return "bot";
  }

  async onOpen(): Promise<void> {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("vault-distiller-chat-view");

    this.buildHeader(contentEl);
    this.buildQuickChips(contentEl);
    this.buildMessageList(contentEl);
    this.buildInputArea(contentEl);

    // Register active leaf change listener to update grounding context
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => {
        if (this.autoGroundActiveNote) {
          this.updateContextPill();
        }
      })
    );

    // Initial greeting if empty
    if (this.messages.length === 0) {
      this.messages.push({
        role: "assistant",
        content: `👋 **Welcome to AI Chat Studio!**\n\nI am connected to your local model (\`${this.plugin.settings.selectedModel || "Ollama"}\`).\n\n* **General Questions**: Ask broad questions freely — I provide direct, conversational answers and summaries.\n* **Specific Questions**: For implementation, syntax, or API questions, I automatically retrieve **verified documentation** from your vault notes and technical references!\n\n**Quick Commands**:\n* \`/doc <topic>\` — Ground query strictly in vault documentation & technical docs\n* \`/condense\` — High-density summary of active note\n* \`/synthesize <topic>\` — Cross-vault synthesis with \`[[wikilinks]]\`\n* \`/generate <topic>\` — Reference primer with tutorial & code\n* \`/fetch <url>\` — Ingest web articles or arXiv papers`,
      });
      this.renderMessages();
    }
  }

  async onClose(): Promise<void> {
    // Cleanup if needed
  }

  /**
   * Builds the top header with context pill and reset button.
   */
  private buildHeader(container: HTMLElement): void {
    const header = container.createDiv({ cls: "vd-chat-header" });

    const titleEl = header.createDiv({ cls: "vd-chat-title" });
    titleEl.createEl("span", { text: "AI Studio", cls: "vd-chat-title-text" });

    this.contextPillEl = header.createDiv({ cls: "vd-context-pill" });
    this.updateContextPill();

    this.contextPillEl.addEventListener("click", () => {
      this.autoGroundActiveNote = !this.autoGroundActiveNote;
      this.updateContextPill();
      new Notice(
        this.autoGroundActiveNote
          ? "Active note context enabled."
          : "Active note context detached (vault-only mode)."
      );
    });

    const actions = header.createDiv({ cls: "vd-header-actions" });
    const clearBtn = actions.createEl("button", {
      cls: "clickable-icon vd-clear-btn",
      title: "Clear Chat History",
    });
    setIcon(clearBtn, "rotate-ccw");
    clearBtn.addEventListener("click", () => {
      this.messages = [];
      this.renderMessages();
      new Notice("Chat history cleared.");
    });
  }

  /**
   * Updates the grounding context pill based on active note.
   */
  private updateContextPill(): void {
    if (!this.contextPillEl) return;
    this.contextPillEl.empty();

    if (!this.autoGroundActiveNote) {
      this.contextPillEl.createEl("span", { text: "🌐 Vault Context Only" });
      this.contextPillEl.addClass("vd-pill-detached");
      this.contextPillEl.removeClass("vd-pill-active");
      return;
    }

    const activeFile = this.getCurrentFile();
    if (activeFile && activeFile.extension === "md") {
      this.contextPillEl.createEl("span", { text: `📄 [[${activeFile.basename}]]` });
      this.contextPillEl.addClass("vd-pill-active");
      this.contextPillEl.removeClass("vd-pill-detached");
      this.contextPillEl.title = `Grounded on ${activeFile.path}. Click to detach.`;
    } else {
      this.contextPillEl.createEl("span", { text: "📚 No Note Open" });
      this.contextPillEl.addClass("vd-pill-detached");
      this.contextPillEl.removeClass("vd-pill-active");
      this.contextPillEl.title = "Open a Markdown note to ground conversation.";
    }
  }

  /**
   * Builds quick command chips above the message list.
   */
  private buildQuickChips(container: HTMLElement): void {
    const chipsContainer = container.createDiv({ cls: "vd-quick-chips" });

    const chips = [
      { label: "⚡ Condense", cmd: "/condense" },
      { label: "🧠 Synthesize", cmd: "/synthesize " },
      { label: "📖 /doc", cmd: "/doc " },
      { label: "✨ Generate", cmd: "/generate " },
      { label: "📝 Format", cmd: "/format" },
      { label: "🌐 Fetch Link", cmd: "/fetch " },
    ];

    for (const chip of chips) {
      const btn = chipsContainer.createEl("button", {
        text: chip.label,
        cls: "vd-chip-btn",
      });
      btn.addEventListener("click", () => {
        if (chip.cmd.endsWith(" ")) {
          this.textareaEl.value = chip.cmd;
          this.textareaEl.focus();
        } else {
          this.textareaEl.value = chip.cmd;
          this.handleSendMessage();
        }
      });
    }
  }

  /**
   * Builds the scrollable message list.
   */
  private buildMessageList(container: HTMLElement): void {
    this.messagesContainerEl = container.createDiv({ cls: "vd-chat-messages" });
  }

  /**
   * Builds the bottom input bar with textarea and send button.
   */
  private buildInputArea(container: HTMLElement): void {
    const inputWrapper = container.createDiv({ cls: "vd-chat-input-wrapper" });

    this.statusBarEl = inputWrapper.createDiv({ cls: "vd-chat-status" });
    this.statusBarEl.style.display = "none";

    const inputRow = inputWrapper.createDiv({ cls: "vd-input-row" });

    this.textareaEl = inputRow.createEl("textarea", {
      cls: "vd-chat-textarea",
      placeholder: "Ask anything, type /command, or paste a link...",
    });

    this.textareaEl.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        this.handleSendMessage();
      }
    });

    // Auto-expand textarea
    this.textareaEl.addEventListener("input", () => {
      this.textareaEl.style.height = "auto";
      this.textareaEl.style.height = `${Math.min(this.textareaEl.scrollHeight, 140)}px`;
    });

    this.sendButtonEl = inputRow.createEl("button", {
      cls: "clickable-icon vd-send-btn",
      title: "Send (Enter)",
    });
    setIcon(this.sendButtonEl, "send");

    this.sendButtonEl.addEventListener("click", () => {
      this.handleSendMessage();
    });
  }

  /**
   * Renders all messages in the chat container.
   */
  private renderMessages(): void {
    this.messagesContainerEl.empty();

    for (let i = 0; i < this.messages.length; i++) {
      const msg = this.messages[i];
      const bubble = this.messagesContainerEl.createDiv({
        cls: `vd-chat-bubble vd-bubble-${msg.role}`,
      });

      if (msg.sourceContext) {
        const meta = bubble.createDiv({ cls: "vd-bubble-meta" });
        meta.setText(msg.sourceContext);
      }

      const body = bubble.createDiv({ cls: "vd-bubble-body markdown-rendered" });
      MarkdownRenderer.render(this.app, msg.content, body, "", this);

      // Assistant action bar
      if (msg.role === "assistant" && i > 0) {
        this.buildAssistantActions(bubble, msg.content);
      }
    }

    this.messagesContainerEl.scrollTop = this.messagesContainerEl.scrollHeight;
  }

  /**
   * Builds action buttons for assistant messages (Insert, Append, Create Note, Copy).
   */
  private buildAssistantActions(container: HTMLElement, content: string): void {
    const actionsRow = container.createDiv({ cls: "vd-assistant-actions" });

    // 1. Insert at Cursor
    const insertBtn = actionsRow.createEl("button", {
      cls: "vd-action-btn",
      text: "Insert at Cursor",
      title: "Insert response directly into active editor at cursor position",
    });
    setIcon(insertBtn, "arrow-down-to-line");
    insertBtn.addEventListener("click", () => {
      const view = this.app.workspace.getActiveViewOfType(MarkdownView);
      if (view && view.editor) {
        view.editor.replaceSelection(content);
        new Notice("Inserted into note at cursor.");
      } else {
        new Notice("Please open a Markdown note in edit mode first.");
      }
    });

    // 2. Append to Active Note
    const appendBtn = actionsRow.createEl("button", {
      cls: "vd-action-btn",
      text: "Append to Note",
      title: "Append response to bottom of active note",
    });
    setIcon(appendBtn, "plus-circle");
    appendBtn.addEventListener("click", async () => {
      const activeFile = this.getCurrentFile();
      if (activeFile && activeFile.extension === "md") {
        await this.app.vault.append(activeFile, `\n\n---\n${content}\n`);
        new Notice(`Appended to ${activeFile.basename}.`);
      } else {
        new Notice("Please open a Markdown note first.");
      }
    });

    // 3. Save as New Note
    const createBtn = actionsRow.createEl("button", {
      cls: "vd-action-btn",
      text: "Save as Note",
      title: "Create a new note from this response",
    });
    setIcon(createBtn, "file-plus");
    createBtn.addEventListener("click", async () => {
      await this.saveResponseAsNote(content);
    });

    // 4. Copy Markdown
    const copyBtn = actionsRow.createEl("button", {
      cls: "vd-action-btn",
      text: "Copy",
      title: "Copy markdown to clipboard",
    });
    setIcon(copyBtn, "copy");
    copyBtn.addEventListener("click", async () => {
      await navigator.clipboard.writeText(content);
      new Notice("Copied markdown to clipboard!");
    });
  }

  /**
   * Derives a clean title and saves the assistant content as a new note in the vault.
   */
  private async saveResponseAsNote(content: string): Promise<void> {
    let title = "Generated Note";
    const headingMatch = content.match(/^#+\s*(.+)$/m);
    if (headingMatch) {
      title = headingMatch[1].replace(/[/\\:*?"<>|]/g, "").trim();
    } else {
      const firstLine = content.split("\n")[0].replace(/[^a-zA-Z0-9 ]/g, "").trim();
      if (firstLine) {
        title = firstLine.slice(0, 40).trim();
      }
    }

    const cleanTitle = sanitizeFilename(title);
    const folder = this.plugin.settings.defaultConceptFolder || "";
    if (folder) {
      await ensureFolderExists(this.app, folder);
    }

    const targetPath = folder ? `${folder}/${cleanTitle}.md` : `${cleanTitle}.md`;
    let finalPath = targetPath;
    let counter = 1;
    while (this.app.vault.getAbstractFileByPath(finalPath)) {
      finalPath = folder
        ? `${folder}/${cleanTitle} ${counter}.md`
        : `${cleanTitle} ${counter}.md`;
      counter++;
    }

    const newFile = await this.app.vault.create(finalPath, content);
    new Notice(`Created note: ${newFile.path}`);
    await this.app.workspace.getLeaf(false).openFile(newFile);
  }

  private getCurrentFile(): TFile | null {
    if (this.activeNoteOverride) return this.activeNoteOverride;
    const file = this.app.workspace.getActiveFile();
    return file instanceof TFile ? file : null;
  }

  /**
   * Main dispatch loop for processing user input and slash commands.
   */
  private async handleSendMessage(): Promise<void> {
    if (this.isProcessing) return;
    const rawInput = this.textareaEl.value.trim();
    if (!rawInput) return;

    if (!this.plugin.settings.selectedModel) {
      new Notice("Please select an Ollama model in Plugin Settings first.");
      return;
    }

    this.textareaEl.value = "";
    this.textareaEl.style.height = "auto";
    this.isProcessing = true;
    this.sendButtonEl.disabled = true;

    // Push user message
    this.messages.push({ role: "user", content: rawInput });
    this.renderMessages();

    this.showStatus(`Thinking with ${this.plugin.settings.selectedModel}...`);

    try {
      const activeFile = this.getCurrentFile();
      const detectedUrl = extractUrlFromText(rawInput);

      // 1. SLASH COMMAND: /fetch <url> OR pasted URL
      if (rawInput.startsWith("/fetch") || (detectedUrl && !rawInput.startsWith("/"))) {
        const targetUrl = detectedUrl || rawInput.replace(/^\/fetch\s*/i, "").trim();
        if (!targetUrl.startsWith("http")) {
          throw new Error("Please provide a valid web URL (e.g. https://arxiv.org/abs/... or https://...)");
        }

        this.showStatus(`Fetching content from ${targetUrl}...`);
        const fetched = await fetchWebContent(targetUrl);

        this.showStatus(`Analyzing & distilling with ${this.plugin.settings.selectedModel}...`);
        const prompt = `The user wants to distill and synthesize an external resource into their Obsidian vault:
Resource Title: "${fetched.title}"
Source URL: ${fetched.url}
Type: ${fetched.isArxiv ? "arXiv Research Paper" : "Web Article"}

Content:
---
${fetched.text}
---

User Prompt / Instruction: "${rawInput}"

Please provide a comprehensive, well-structured Markdown note:
1. Executive Abstract / Thesis
2. Core Architecture / Key Principles (in bullet points)
3. Step-by-Step Implementation or Practical Takeaways
4. Critical Analysis / Tradeoffs
5. Recommended [[wikilinks]] for linking into the user's vault knowledge base
6. Tags at the end preceded by '---'.`;

        const reply = await sendOllamaChat(
          this.plugin.settings.ollamaUrl,
          this.plugin.settings.selectedModel,
          [
            { role: "system", content: "You are an expert research and note distillation assistant." },
            { role: "user", content: prompt },
          ],
          this.plugin.settings.temperature
        );

        this.messages.push({
          role: "assistant",
          content: reply,
          sourceContext: `Fetched: ${fetched.title} (${fetched.url})`,
        });
      }

      // 2. SLASH COMMAND: /condense
      else if (rawInput.startsWith("/condense")) {
        if (!activeFile) {
          throw new Error("No active Markdown note open to condense. Please open a note first.");
        }
        const rawContent = await this.app.vault.cachedRead(activeFile);
        const cache = this.app.metadataCache.getFileCache(activeFile);
        const body = sanitizeNoteBody(
          rawContent,
          this.plugin.settings.maxNoteChars,
          cache?.frontmatterPosition?.end?.offset
        );

        const prompt = `Please condense this active note ("${activeFile.basename}") into a high-density, crystal-clear executive summary.
Note Content:
---
${body}
---

Instructions:
1. > [!abstract] Distilled Summary (2-3 dense sentences capturing the primary thesis and findings).
2. Key Takeaways & Core Arguments (bullet points).
3. Open Questions & Tasks (checklist items with - [ ]).
4. Use [[wikilinks]] for any key concepts.`;

        const reply = await sendOllamaChat(
          this.plugin.settings.ollamaUrl,
          this.plugin.settings.selectedModel,
          [
            { role: "system", content: "You are an executive knowledge condenser." },
            { role: "user", content: prompt },
          ],
          this.plugin.settings.temperature
        );

        this.messages.push({
          role: "assistant",
          content: reply,
          sourceContext: `Condensed from [[${activeFile.basename}]]`,
        });
      }

      // 3. SLASH COMMAND: /synthesize <topic>
      else if (rawInput.startsWith("/synthesize")) {
        const topic = rawInput.replace(/^\/synthesize\s*/i, "").trim();
        const searchTopic = topic || (activeFile ? activeFile.basename : "");
        if (!searchTopic) {
          throw new Error("Please specify a topic to synthesize (e.g. /synthesize machine learning).");
        }

        this.showStatus(`Searching vault for mentions of "${searchTopic}"...`);
        const mentions = await findVaultMentions(this.app, searchTopic, undefined, 8);

        const mentionSnippets = mentions
          .map((m) => `From [[${m.file.basename}]] (${m.file.path}):\n> ${m.snippet}`)
          .join("\n\n");

        let activeContext = "";
        if (activeFile && this.autoGroundActiveNote) {
          const raw = await this.app.vault.cachedRead(activeFile);
          activeContext = `\nCurrent Active Note ([[${activeFile.basename}]]):\n${raw.slice(0, 2000)}\n`;
        }

        const prompt = `The user wants a synthesized cross-vault analysis on "${searchTopic}".

Mentions found across vault notes:
${mentionSnippets || "No direct keyword mentions found; synthesize foundational knowledge."}
${activeContext}

Synthesize these ideas into a coherent, comprehensive Markdown document:
- Interconnections and recurring themes across notes
- Conceptual map using [[wikilinks]]
- Actionable conclusions`;

        const reply = await sendOllamaChat(
          this.plugin.settings.ollamaUrl,
          this.plugin.settings.selectedModel,
          [
            { role: "system", content: "You are a knowledge graph synthesis expert." },
            { role: "user", content: prompt },
          ],
          this.plugin.settings.temperature
        );

        this.messages.push({
          role: "assistant",
          content: reply,
          sourceContext: `Cross-vault synthesis on "${searchTopic}" (${mentions.length} notes cited)`,
        });
      }

      // 4. SLASH COMMAND: /generate <topic>
      else if (rawInput.startsWith("/generate")) {
        const topic = rawInput.replace(/^\/generate\s*/i, "").trim();
        if (!topic) {
          throw new Error("Please specify what topic to generate (e.g. /generate GraphQL).");
        }

        const prompt = `Generate an in-depth reference concept note on: "${topic}".
Format with:
# ${topic}

> [!abstract] Distilled Overview
> Concise explanation of what it is and why it matters.

## Core Principles
1. Foundational property/mechanism
2. Architectural advantage
3. Key tradeoff

## Practical Tutorial
Step-by-step implementation guide (Setup, Configure, Implement, Run) so the reader can implement it themselves immediately.

## Code / Syntax Example
\`\`\`
Provide clean, working code here
\`\`\`

## Related Concepts
- [[Related1]]
- [[Related2]]

---
#concept #${topic.toLowerCase().replace(/[^a-z0-9]/g, "")}`;

        const reply = await sendOllamaChat(
          this.plugin.settings.ollamaUrl,
          this.plugin.settings.selectedModel,
          [
            { role: "system", content: "You are an expert technical writer and developer." },
            { role: "user", content: prompt },
          ],
          this.plugin.settings.temperature
        );

        this.messages.push({
          role: "assistant",
          content: reply,
          sourceContext: `Generated reference note for "${topic}"`,
        });
      }

      // 5. SLASH COMMAND: /format
      else if (rawInput.startsWith("/format")) {
        if (!activeFile) {
          throw new Error("Please open a note to reformat.");
        }
        const rawContent = await this.app.vault.cachedRead(activeFile);
        const prompt = `Reformat this note following vault-distiller conventions:
1. Ensure a clean > [!abstract] Distilled Summary callout is at the top.
2. Ensure markdown headings use clean dividers (---).
3. Unify todos into clean checklist items (- [ ]).
4. Move all hashtags to the very bottom preceded by '---'.
5. Return the full formatted note ready to save.

Original Note Content:
---
${rawContent}
---`;

        const reply = await sendOllamaChat(
          this.plugin.settings.ollamaUrl,
          this.plugin.settings.selectedModel,
          [
            { role: "system", content: "You are a Markdown formatting and structuring expert." },
            { role: "user", content: prompt },
          ],
          this.plugin.settings.temperature
        );

        this.messages.push({
          role: "assistant",
          content: reply,
          sourceContext: `Formatted version of [[${activeFile.basename}]]`,
        });
      }

      // 6. SPECIFIC TECHNICAL QUERY OR EXPLICIT /doc (Documentation-Grounded Track)
      const specificity = this.analyzeQuerySpecificity(rawInput, activeFile);

      if (specificity.explicitDocCommand || specificity.isSpecific) {
        const queryTopic =
          specificity.techEntity || rawInput.replace(/^\/(?:doc|tech)\s*/i, "").trim();

        this.showStatus(`Searching documentation for "${queryTopic}"...`);

        // Step 1: Search Vault Documentation
        const vaultDoc = await findRelevantVaultDocumentation(this.app, queryTopic);

        let docSourceTitle = "";
        let docContext = "";
        let isVaultDoc = false;
        let isExternalDoc = false;

        if (vaultDoc) {
          isVaultDoc = true;
          docSourceTitle = `[[${vaultDoc.title}]]`;
          docContext = `### Vault Reference Note: [[${vaultDoc.title}]] (${vaultDoc.path})\n${vaultDoc.content}`;
        } else {
          // Step 2: Try fetching external authoritative documentation
          this.showStatus(`Fetching technical documentation for "${queryTopic}"...`);
          const externalDoc = await fetchTechnicalDocumentation(queryTopic);
          if (externalDoc) {
            isExternalDoc = true;
            docSourceTitle = `[${externalDoc.title}](${externalDoc.url})`;
            docContext = `### External Documentation: ${externalDoc.title} (${externalDoc.url})\n${externalDoc.text}`;
          }
        }

        // Active note context if available
        let activeContext = "";
        if (activeFile && this.autoGroundActiveNote) {
          const raw = await this.app.vault.cachedRead(activeFile);
          const cache = this.app.metadataCache.getFileCache(activeFile);
          const body = sanitizeNoteBody(
            raw,
            2500,
            cache?.frontmatterPosition?.end?.offset
          );
          activeContext = `\nCurrent Active Note Context ([[${activeFile.basename}]]):\n${body}\n`;
        }

        this.showStatus(
          `Grounding answer in documentation with ${this.plugin.settings.selectedModel}...`
        );

        let systemPrompt = "";
        if (docContext) {
          systemPrompt = `You are an expert technical documentation assistant in STRICT DOCUMENTATION MODE.
The user is asking a specific implementation or technical question: "${rawInput}"
Target Technology / Entity: "${queryTopic}"

RELEVANT DOCUMENTATION:
---
${docContext}
---
${activeContext}

RULES:
1. Always start your response with a documentation callout at the very top:
   > [!tip] Grounded in Documentation: ${docSourceTitle}
2. Provide precise, verified syntax, function signatures, schema definitions, or CLI options.
3. Include a clean, runnable code example with necessary imports and configuration.
4. Highlight key gotchas, parameters, or edge cases documented for ${queryTopic}.
5. STRICT ANTI-HALLUCINATION: Do NOT invent APIs, methods, or parameters not supported by the documentation. If a detail is not documented, explicitly state that caveat.`;
        } else {
          systemPrompt = `You are an expert technical documentation assistant for "${queryTopic}".
Note: No local vault documentation note was found for "${queryTopic}".

The user asked: "${rawInput}"
${activeContext}

RULES:
1. Start your response with:
   > [!note] Technical Reference: Standard ${queryTopic} Conventions (No local note found in vault)
2. Provide exact syntax, standard patterns, and a verified code example according to official conventions.
3. Suggest saving a reference primer using \`/generate ${queryTopic}\` to store it permanently in the vault.`;
        }

        const reply = await sendOllamaChat(
          this.plugin.settings.ollamaUrl,
          this.plugin.settings.selectedModel,
          [
            { role: "system", content: systemPrompt },
            { role: "user", content: rawInput },
          ],
          this.plugin.settings.temperature
        );

        this.messages.push({
          role: "assistant",
          content: reply,
          sourceContext: isVaultDoc
            ? `Grounded in Vault Doc: [[${vaultDoc?.title}]]`
            : isExternalDoc
            ? `Grounded in Official Doc: ${queryTopic}`
            : `Technical Doc Mode: ${queryTopic}`,
        });
      }

      // 7. GENERAL CONVERSATION (Fast Direct Track: High-Level Concepts, Ideation, Summaries)
      else {
        let systemPrompt = `You are an expert personal AI research and knowledge assistant integrated into Obsidian ("Vault Distiller Studio").
The user is asking a general conceptual or knowledge question: "${rawInput}".

GUIDELINES:
- Provide a direct, engaging, and clear conversational answer.
- Focus on intuition, conceptual understanding, analogies, summaries, or structured lists.
- You do NOT need heavy documentation badges unless the user asks for exact API syntax.`;

        if (activeFile && this.autoGroundActiveNote) {
          const raw = await this.app.vault.cachedRead(activeFile);
          const cache = this.app.metadataCache.getFileCache(activeFile);
          const body = sanitizeNoteBody(
            raw,
            this.plugin.settings.maxNoteChars,
            cache?.frontmatterPosition?.end?.offset
          );
          systemPrompt += `\n\nCurrent Active Note Context:
Note Title: "${activeFile.basename}"
Note Path: "${activeFile.path}"
Content:
---
${body}
---

Ground your answers in the active note where relevant. Use [[wikilinks]] when referencing note concepts.`;
        }

        const chatHistory: ChatMessage[] = [
          { role: "system", content: systemPrompt },
          ...this.messages.map((m) => ({
            role: m.role as "user" | "assistant",
            content: m.content,
          })),
        ];

        const reply = await sendOllamaChat(
          this.plugin.settings.ollamaUrl,
          this.plugin.settings.selectedModel,
          chatHistory,
          this.plugin.settings.temperature
        );

        this.messages.push({
          role: "assistant",
          content: reply,
          sourceContext:
            activeFile && this.autoGroundActiveNote
              ? `Grounded on [[${activeFile.basename}]]`
              : undefined,
        });
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.messages.push({
        role: "assistant",
        content: `❌ **Error**: ${message}`,
      });
    } finally {
      this.isProcessing = false;
      this.sendButtonEl.disabled = false;
      this.hideStatus();
      this.renderMessages();
      this.textareaEl.focus();
    }
  }

  /**
   * Analyzes whether a user's prompt is a specific technical question requiring
   * documentation grounding vs a general high-level or conceptual query.
   */
  private analyzeQuerySpecificity(
    input: string,
    activeFile: TFile | null
  ): { isSpecific: boolean; techEntity: string | null; explicitDocCommand: boolean } {
    const trimmed = input.trim();

    // 1. Explicit /doc or /tech command
    if (trimmed.startsWith("/doc") || trimmed.startsWith("/tech")) {
      const topic = trimmed.replace(/^\/(?:doc|tech)\s*/i, "").trim();
      return {
        isSpecific: true,
        techEntity: topic || (activeFile ? activeFile.basename : null),
        explicitDocCommand: true,
      };
    }

    // 2. Specific technical indicators
    const technicalIndicators =
      /\b(syntax|api|how to (?:configure|implement|call|define|install|setup|import|use)|parameters?|arguments?|functions?|methods?|interfaces?|type definitions?|errors?|flags?|options?|resolvers?|schema|queries|mutations|directives?|components?|hooks?|endpoints?|cli|sdk|decorators?|props)\b/i;

    const hasTechIndicator = technicalIndicators.test(trimmed);

    // 3. Extract technical entity
    let techEntity: string | null = null;

    // Pattern A: Preposition followed by Entity (e.g. "in GraphQL", "with PyTorch", "for Docker")
    const prepMatch = trimmed.match(
      /\b(?:in|with|for|using|of|about)\s+([A-Za-z0-9_.\-#+]+)/i
    );
    if (prepMatch && prepMatch[1].length > 1) {
      const candidate = prepMatch[1].replace(/[,?.!:]+$/, "");
      if (
        !["a", "an", "the", "this", "my", "our", "all", "general", "notes", "obsidian"].includes(
          candidate.toLowerCase()
        )
      ) {
        techEntity = candidate;
      }
    }

    // Pattern B: Common technical libraries and frameworks dictionary
    const commonTech = [
      "graphql",
      "react",
      "vue",
      "svelte",
      "angular",
      "nextjs",
      "next.js",
      "nodejs",
      "node.js",
      "typescript",
      "javascript",
      "python",
      "rust",
      "golang",
      "go",
      "docker",
      "kubernetes",
      "k8s",
      "git",
      "sqlite",
      "postgres",
      "postgresql",
      "redis",
      "mongodb",
      "fastapi",
      "flask",
      "django",
      "express",
      "pytorch",
      "tensorflow",
      "obsidian",
      "tailwind",
      "esbuild",
      "webpack",
      "vite",
      "linux",
      "bash",
      "zsh",
      "syncthing",
      "firebase",
      "aws",
      "gcp",
      "azure",
    ];

    if (!techEntity) {
      for (const tech of commonTech) {
        const regex = new RegExp(`\\b${tech.replace(".", "\\.")}\\b`, "i");
        if (regex.test(trimmed)) {
          techEntity = tech;
          break;
        }
      }
    }

    // Pattern C: Active note fallback if located in technical folder
    if (!techEntity && activeFile) {
      const pathLower = activeFile.path.toLowerCase();
      if (
        pathLower.includes("computer science") ||
        pathLower.includes("tech") ||
        pathLower.includes("dev")
      ) {
        techEntity = activeFile.basename;
      }
    }

    return {
      isSpecific: hasTechIndicator && techEntity !== null,
      techEntity,
      explicitDocCommand: false,
    };
  }

  private showStatus(text: string): void {
    if (this.statusBarEl) {
      this.statusBarEl.setText(text);
      this.statusBarEl.style.display = "block";
    }
  }

  private hideStatus(): void {
    if (this.statusBarEl) {
      this.statusBarEl.style.display = "none";
    }
  }
}
