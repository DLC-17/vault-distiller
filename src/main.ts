import { Notice, Plugin, TFile } from "obsidian";
import { DEFAULT_SETTINGS, LocalOrganizerSettings, MIN_CONTENT_CHARS } from "./types";
import { LocalOrganizerSettingTab } from "./settings";
import { distillNoteContent } from "./ollama";
import { getCachedVaultContext, sanitizeNoteBody } from "./vault-context";
import { organizeFileLocation, updateFrontmatter, updateNoteBody } from "./note-mutator";
import { BulkOrganizeModal } from "./bulk-modal";
import { ConceptReviewModal, ManualConceptModal } from "./concept-modal";
import { ReformatConventionModal } from "./reformat-modal";
import { SyncConflictModal } from "./sync-conflict-modal";
import { scanVaultForSyncConflicts } from "./sync-conflict-merger";
import { ChatStudioView, VIEW_TYPE_CHAT } from "./chat-view";

export default class LocalOrganizerPlugin extends Plugin {
  settings: LocalOrganizerSettings;

  async onload(): Promise<void> {
    await this.loadSettings();

    // Register Chat Studio View
    this.registerView(VIEW_TYPE_CHAT, (leaf) => new ChatStudioView(leaf, this));

    // Register Ribbon Icons
    this.addRibbonIcon("bot", "Local Organizer: Open AI Chat Studio", () => {
      this.activateChatView();
    });

    this.addRibbonIcon("sparkles", "Distill & Organize Active Note", async () => {
      await this.processActiveNote();
    });

    // Register Chat Studio Command
    this.addCommand({
      id: "open-chat-studio",
      name: "Local Organizer: Open AI Chat Studio",
      callback: () => {
        this.activateChatView();
      },
    });

    // Register Single Note Command
    this.addCommand({
      id: "process-active-note",
      name: "Local Organizer: Process Active Note",
      checkCallback: (checking: boolean) => {
        const activeFile = this.app.workspace.getActiveFile();
        if (activeFile && activeFile.extension === "md") {
          if (!checking) {
            this.processActiveNote();
          }
          return true;
        }
        return false;
      },
    });

    // Register Bulk Organization Command
    this.addCommand({
      id: "bulk-organize-notes",
      name: "Local Organizer: Bulk Organize Vault or Folder",
      callback: () => {
        new BulkOrganizeModal(this.app, this).open();
      },
    });

    // Register Manual Concept Primer Command
    this.addCommand({
      id: "research-concept-note",
      name: "Local Organizer: Research & Generate Concept Note...",
      callback: () => {
        const activeFile = this.app.workspace.getActiveFile();
        new ManualConceptModal(this.app, this, activeFile).open();
      },
    });

    // Register Reformat Notes to Convention Command
    this.addCommand({
      id: "reformat-notes-convention",
      name: "Local Organizer: Reformat Notes to Convention (End Tags & Sourced Titles)...",
      callback: () => {
        new ReformatConventionModal(this.app, this).open();
      },
    });

    // Register Sync Conflict Resolver Command
    this.addCommand({
      id: "scan-sync-conflicts",
      name: "Local Organizer: Scan & Merge Sync Conflicts...",
      callback: () => {
        new SyncConflictModal(this.app, this).open();
      },
    });

    // Register Plugin Settings Tab
    this.addSettingTab(new LocalOrganizerSettingTab(this.app, this));

    // Deferred scan for sync conflicts on startup
    this.app.workspace.onLayoutReady(() => {
      if (this.settings.autoScanSyncConflicts) {
        const conflicts = scanVaultForSyncConflicts(this.app);
        if (conflicts.length > 0) {
          const notice = new Notice(
            `⚠️ Local Organizer: Found ${conflicts.length} sync conflict file(s) in your vault. Click to review & merge.`,
            10000
          );
          (notice as unknown as { noticeEl?: HTMLElement }).noticeEl?.addEventListener("click", () => {
            new SyncConflictModal(this.app, this).open();
          });
        }
      }
    });
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  async activateChatView(): Promise<void> {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE_CHAT)[0];
    if (!leaf) {
      const rightLeaf = workspace.getRightLeaf(false);
      if (rightLeaf) {
        await rightLeaf.setViewState({ type: VIEW_TYPE_CHAT, active: true });
        leaf = rightLeaf;
      }
    }
    if (leaf) {
      workspace.revealLeaf(leaf);
    }
  }

  async processActiveNote(): Promise<void> {
    const activeFile = this.app.workspace.getActiveFile();
    if (!activeFile || !(activeFile instanceof TFile) || activeFile.extension !== "md") {
      new Notice("Local Organizer: Please open a Markdown note first.");
      return;
    }

    if (!this.settings.selectedModel) {
      new Notice(
        "Local Organizer: No model selected. Open Settings → Local Vault Organizer to configure."
      );
      return;
    }

    const rawContent = await this.app.vault.cachedRead(activeFile);
    const fileCache = this.app.metadataCache.getFileCache(activeFile);
    const fmOffset = fileCache?.frontmatterPosition?.end?.offset;
    const body = sanitizeNoteBody(rawContent, this.settings.maxNoteChars, fmOffset);

    if (body.length < MIN_CONTENT_CHARS) {
      new Notice(
        "Local Organizer: Note has too little content to distill (minimum 50 characters required)."
      );
      return;
    }

    new Notice("Local Organizer: Indexing vault context...");
    const { tags, titles, titleMap, folders } = getCachedVaultContext(
      this.app,
      activeFile,
      this.settings.maxContextTags,
      this.settings.maxContextNotes
    );

    const processingNotice = new Notice(
      `Local Organizer: Processing note with ${this.settings.selectedModel}... this may take 30-60s`,
      0
    );

    const startMs = Date.now();

    try {
      const result = await distillNoteContent(
        this.settings.ollamaUrl,
        this.settings.selectedModel,
        this.settings.temperature,
        activeFile.basename,
        body,
        tags,
        titles,
        folders
      );

      // Explicit sequential await: frontmatter flush completes before body mutation begins
      const mergedTags = await updateFrontmatter(this.app, activeFile, result, this.settings);
      await updateNoteBody(this.app, activeFile, result, this.settings, titleMap, mergedTags);

      let actionNotice = "";
      const orgResult = await organizeFileLocation(
        this.app,
        activeFile,
        result.clean_title,
        result.suggested_folder,
        new Set(folders),
        this.settings.autoRenameFile,
        this.settings.autoMoveToFolder
      );

      if (orgResult.renamed) {
        actionNotice += ` → 📝 "${orgResult.newTitle}"`;
      }
      if (orgResult.moved) {
        actionNotice += ` → 📁 "${orgResult.targetFolder}/"`;
      }

      const elapsedSec = ((Date.now() - startMs) / 1000).toFixed(1);
      new Notice(
        `✅ Local Organizer: Note organized in ${elapsedSec}s with ${this.settings.selectedModel}!${actionNotice}`
      );

      // Prompt user to review & synthesize novel discovered concepts
      if (
        this.settings.autoDiscoverConcepts &&
        result.discovered_concepts &&
        result.discovered_concepts.length > 0
      ) {
        new ConceptReviewModal(this.app, this, result.discovered_concepts, activeFile).open();
      }
    } catch (err) {
      new Notice(
        `Local Organizer Error: ${err instanceof Error ? err.message : "Unexpected error"}`
      );
    } finally {
      processingNotice.hide();
    }
  }
}
