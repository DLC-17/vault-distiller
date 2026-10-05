import { App, Modal, Notice, Setting, TFile } from "obsidian";
import type LocalOrganizerPlugin from "./main";
import { DiscoveredConcept } from "./types";
import { findVaultMentions, getCachedVaultContext, getVaultFolders } from "./vault-context";
import { generateConceptPrimer } from "./ollama";
import { createConceptNote } from "./note-mutator";

interface ConceptItemState {
  name: string;
  suggested_folder: string;
  reason: string;
  selected: boolean;
}

/**
 * Interactive modal presented when novel technical concepts are discovered
 * during active note distillation. Users can select which concepts to synthesize
 * into dedicated reference primers and specify target folders.
 */
export class ConceptReviewModal extends Modal {
  plugin: LocalOrganizerPlugin;
  private originatingFile: TFile;
  private items: ConceptItemState[];
  private isCancelled: boolean = false;
  private isRunning: boolean = false;

  constructor(
    app: App,
    plugin: LocalOrganizerPlugin,
    concepts: DiscoveredConcept[],
    originatingFile: TFile
  ) {
    super(app);
    this.plugin = plugin;
    this.originatingFile = originatingFile;
    this.items = concepts.map((c) => ({
      name: c.name,
      suggested_folder: c.suggested_folder || "",
      reason: c.reason,
      selected: true,
    }));
  }

  onOpen(): void {
    this.renderSelectionView();
  }

  onClose(): void {
    this.isCancelled = true;
    const { contentEl } = this;
    contentEl.empty();
  }

  private renderSelectionView(): void {
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl("h2", { text: "Discovered Technical Concepts" });
    contentEl.createEl("p", {
      text: `The model discovered ${this.items.length} technical concept(s) in "${this.originatingFile.basename}" that do not have dedicated notes. Select the concepts you want to research and synthesize into reference primers:`,
      cls: "setting-item-description",
    });

    const folders = getVaultFolders(this.app);

    // List of concepts
    const listContainer = contentEl.createDiv({ cls: "vault-distiller-concept-list" });
    listContainer.style.maxHeight = "360px";
    listContainer.style.overflowY = "auto";
    listContainer.style.marginBottom = "20px";
    listContainer.style.display = "flex";
    listContainer.style.flexDirection = "column";
    listContainer.style.gap = "12px";

    for (const item of this.items) {
      const card = listContainer.createDiv({ cls: "vault-distiller-concept-card" });
      card.style.border = "1px solid var(--background-modifier-border)";
      card.style.borderRadius = "8px";
      card.style.padding = "12px 16px";
      card.style.backgroundColor = "var(--background-secondary)";

      // Top row: Checkbox + Concept Name
      const topRow = card.createDiv();
      topRow.style.display = "flex";
      topRow.style.alignItems = "center";
      topRow.style.gap = "10px";
      topRow.style.marginBottom = "6px";

      const cb = topRow.createEl("input", { type: "checkbox" });
      cb.checked = item.selected;
      cb.onchange = () => {
        item.selected = cb.checked;
        updateCtaButton();
      };

      const titleEl = topRow.createEl("span", { text: item.name });
      titleEl.style.fontWeight = "600";
      titleEl.style.fontSize = "1.05em";

      // Middle: Rationale / Reason
      if (item.reason) {
        const reasonEl = card.createEl("p", { text: item.reason });
        reasonEl.style.fontSize = "0.9em";
        reasonEl.style.color = "var(--text-muted)";
        reasonEl.style.margin = "0 0 10px 28px";
      }

      // Bottom row: Folder selector
      const folderRow = card.createDiv();
      folderRow.style.display = "flex";
      folderRow.style.alignItems = "center";
      folderRow.style.gap = "8px";
      folderRow.style.marginLeft = "28px";
      folderRow.style.fontSize = "0.88em";

      folderRow.createEl("span", { text: "Destination Folder:" });

      const folderSelect = folderRow.createEl("select");
      folderSelect.style.padding = "2px 8px";
      folderSelect.style.borderRadius = "4px";

      // Options
      const rootOpt = folderSelect.createEl("option", { text: "/ (Root of Vault)", value: "" });
      if (!item.suggested_folder) rootOpt.selected = true;

      for (const f of folders) {
        const opt = folderSelect.createEl("option", { text: f, value: f });
        if (item.suggested_folder && f === item.suggested_folder) {
          opt.selected = true;
        }
      }

      folderSelect.onchange = () => {
        item.suggested_folder = folderSelect.value;
      };
    }

    // Action button row
    const buttonRow = contentEl.createDiv({ cls: "modal-button-container" });
    buttonRow.style.display = "flex";
    buttonRow.style.justifyContent = "flex-end";
    buttonRow.style.gap = "10px";

    const cancelBtn = buttonRow.createEl("button", { text: "Skip / Close" });
    cancelBtn.onclick = () => this.close();

    const startBtn = buttonRow.createEl("button", {
      cls: "mod-cta",
    });

    const updateCtaButton = () => {
      const selectedCount = this.items.filter((i) => i.selected).length;
      startBtn.setText(`Generate Selected (${selectedCount})`);
      startBtn.disabled = selectedCount === 0;
    };

    updateCtaButton();

    startBtn.onclick = () => {
      const selectedItems = this.items.filter((i) => i.selected);
      if (selectedItems.length > 0) {
        this.renderProgressView(selectedItems);
      }
    };
  }

  private renderProgressView(queue: ConceptItemState[]): void {
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl("h2", { text: "Synthesizing Concept Primers..." });

    const statusText = contentEl.createEl("p", {
      text: `Preparing to research & generate ${queue.length} concept note(s)...`,
    });

    const progressBar = contentEl.createEl("progress");
    progressBar.max = queue.length;
    progressBar.value = 0;
    progressBar.style.width = "100%";
    progressBar.style.marginBottom = "15px";

    const logContainer = contentEl.createDiv({
      cls: "vault-distiller-concept-log",
    });
    logContainer.style.height = "220px";
    logContainer.style.overflowY = "auto";
    logContainer.style.backgroundColor = "var(--background-secondary)";
    logContainer.style.padding = "10px";
    logContainer.style.borderRadius = "6px";
    logContainer.style.fontFamily = "monospace";
    logContainer.style.fontSize = "0.85em";
    logContainer.style.marginBottom = "15px";

    const buttonRow = contentEl.createDiv({ cls: "modal-button-container" });
    buttonRow.style.display = "flex";
    buttonRow.style.justifyContent = "flex-end";

    const stopBtn = buttonRow.createEl("button", {
      text: "Cancel Remaining",
      cls: "mod-warning",
    });

    stopBtn.onclick = () => {
      this.isCancelled = true;
      stopBtn.disabled = true;
      stopBtn.setText("Stopping...");
    };

    const appendLog = (msg: string) => {
      const line = logContainer.createEl("div", { text: msg });
      line.style.marginBottom = "3px";
      logContainer.scrollTop = logContainer.scrollHeight;
    };

    this.runQueue(queue, progressBar, statusText, appendLog, stopBtn);
  }

  private async runQueue(
    queue: ConceptItemState[],
    progressBar: HTMLProgressElement,
    statusText: HTMLParagraphElement,
    appendLog: (msg: string) => void,
    stopBtn: HTMLButtonElement
  ): Promise<void> {
    this.isRunning = true;
    this.isCancelled = false;
    let createdCount = 0;

    for (let i = 0; i < queue.length; i++) {
      if (this.isCancelled) {
        appendLog("⏹️ Concept generation stopped by user.");
        break;
      }

      const item = queue[i];
      progressBar.value = i + 1;
      statusText.setText(`[${i + 1}/${queue.length}] Researching "${item.name}"...`);
      appendLog(`▶ [${i + 1}/${queue.length}] Searching vault for mentions of "${item.name}"...`);

      try {
        // 1. Gather mentions from existing notes
        const mentions = await findVaultMentions(this.app, item.name, this.originatingFile, 6);
        appendLog(`   Found ${mentions.length} prior mention(s) across vault.`);

        // 2. Fetch context (titles, folders)
        const { titles, folders } = getCachedVaultContext(
          this.app,
          this.originatingFile,
          this.plugin.settings.maxContextTags,
          this.plugin.settings.maxContextNotes
        );

        // 3. Synthesize primer with local Ollama
        appendLog(`   Synthesizing reference primer with ${this.plugin.settings.selectedModel}...`);
        const primer = await generateConceptPrimer(
          this.plugin.settings.ollamaUrl,
          this.plugin.settings.selectedModel,
          this.plugin.settings.temperature,
          item.name,
          mentions,
          folders,
          titles
        );

        // Apply folder override if set by user in modal
        if (item.suggested_folder) {
          primer.suggested_folder = item.suggested_folder;
        }

        // 4. Create concept note and wire bidirectional backlinks
        const createdFile = await createConceptNote(
          this.app,
          primer,
          this.originatingFile,
          new Set(folders),
          this.plugin.settings.defaultConceptFolder
        );

        createdCount++;
        const targetDir = createdFile.parent?.path || "/";
        appendLog(`   ✅ Created "[[${createdFile.basename}]]" in ${targetDir}/ and linked to originating note.`);
      } catch (err) {
        appendLog(`   ❌ Error creating "${item.name}": ${err instanceof Error ? err.message : String(err)}`);
      }

      // Small pause between concept queries to let local GPU cool
      await new Promise((r) => setTimeout(r, 60));
    }

    this.isRunning = false;
    statusText.setText(`Finished! Successfully created ${createdCount} concept primer(s).`);
    stopBtn.setText("Done");
    stopBtn.className = "mod-cta";
    stopBtn.disabled = false;
    stopBtn.onclick = () => this.close();
  }
}

/**
 * On-demand modal for manually researching and generating a dedicated reference
 * primer for any technical topic or concept.
 */
export class ManualConceptModal extends Modal {
  plugin: LocalOrganizerPlugin;
  private activeFile: TFile | null;
  private conceptInput: string = "";
  private selectedFolder: string = "__AUTO__";

  constructor(app: App, plugin: LocalOrganizerPlugin, activeFile?: TFile | null) {
    super(app);
    this.plugin = plugin;
    this.activeFile = activeFile ?? null;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl("h2", { text: "Research & Generate Concept Note" });
    contentEl.createEl("p", {
      text: "Synthesize a comprehensive reference primer for any technical topic using your local Ollama instance, incorporating any existing mentions found across your vault.",
      cls: "setting-item-description",
    });

    const folders = getVaultFolders(this.app);

    // Topic Input
    new Setting(contentEl)
      .setName("Concept or Topic Name")
      .setDesc("Enter the technical topic, tool, or architecture pattern (e.g., GraphQL, Docker, Vector Search).")
      .addText((text) => {
        text.setPlaceholder("e.g. GraphQL");
        text.onChange((val) => {
          this.conceptInput = val.trim();
        });
      });

    // Destination Folder
    new Setting(contentEl)
      .setName("Destination Folder")
      .setDesc("Select where to save the generated concept note.")
      .addDropdown((dropdown) => {
        const defaultTarget = this.plugin.settings.defaultConceptFolder || "Computer Science";
        dropdown.addOption("__AUTO__", `Auto-detect Best Folder (Default: ${defaultTarget})`);
        for (const f of folders) {
          dropdown.addOption(f, f);
        }
        dropdown.addOption("__ROOT__", "/ (Root of Vault)");
        dropdown.setValue(this.selectedFolder);
        dropdown.onChange((val) => {
          this.selectedFolder = val;
        });
      });

    if (this.activeFile) {
      contentEl.createEl("p", {
        text: `🔗 Will be cross-linked with active note: [[${this.activeFile.basename}]]`,
        cls: "setting-item-description",
      });
    }

    // Action buttons
    const buttonRow = contentEl.createDiv({ cls: "modal-button-container" });
    buttonRow.style.marginTop = "20px";
    buttonRow.style.display = "flex";
    buttonRow.style.justifyContent = "flex-end";
    buttonRow.style.gap = "10px";

    const cancelBtn = buttonRow.createEl("button", { text: "Cancel" });
    cancelBtn.onclick = () => this.close();

    const generateBtn = buttonRow.createEl("button", {
      text: "Research & Generate Primer",
      cls: "mod-cta",
    });

    generateBtn.onclick = async () => {
      if (!this.conceptInput) {
        new Notice("Local Organizer: Please enter a concept name.");
        return;
      }
      if (!this.plugin.settings.selectedModel) {
        new Notice("Local Organizer: Please configure an Ollama model in Settings first.");
        return;
      }

      generateBtn.disabled = true;
      cancelBtn.disabled = true;
      generateBtn.setText("Researching & Synthesizing...");

      const notice = new Notice(
        `Local Organizer: Synthesizing primer for "${this.conceptInput}" with ${this.plugin.settings.selectedModel}...`,
        0
      );

      try {
        const mentions = await findVaultMentions(this.app, this.conceptInput, this.activeFile ?? undefined, 6);
        const { titles, folders: vFolders } = getCachedVaultContext(
          this.app,
          this.activeFile,
          this.plugin.settings.maxContextTags,
          this.plugin.settings.maxContextNotes
        );

        const primer = await generateConceptPrimer(
          this.plugin.settings.ollamaUrl,
          this.plugin.settings.selectedModel,
          this.plugin.settings.temperature,
          this.conceptInput,
          mentions,
          vFolders,
          titles
        );

        if (this.selectedFolder === "__ROOT__") {
          primer.suggested_folder = "";
        } else if (this.selectedFolder !== "__AUTO__") {
          primer.suggested_folder = this.selectedFolder;
        }

        const createdFile = await createConceptNote(
          this.app,
          primer,
          this.activeFile,
          new Set(vFolders),
          this.plugin.settings.defaultConceptFolder
        );

        notice.hide();
        new Notice(`✅ Concept note created: [[${createdFile.basename}]]`);

        // Open newly created note in workspace
        const leaf = this.app.workspace.getLeaf(false);
        await leaf.openFile(createdFile);

        this.close();
      } catch (err) {
        notice.hide();
        new Notice(
          `Local Organizer Error: ${err instanceof Error ? err.message : String(err)}`
        );
        generateBtn.disabled = false;
        cancelBtn.disabled = false;
        generateBtn.setText("Research & Generate Primer");
      }
    };
  }

  onClose(): void {
    const { contentEl } = this;
    contentEl.empty();
  }
}
