import { App, Modal, Notice, Setting, TFile } from "obsidian";
import type LocalOrganizerPlugin from "./main";
import { getVaultFolders } from "./vault-context";
import { reformatNoteToConvention } from "./note-mutator";

/**
 * Modal for bulk reformatting notes to adhere to vault-distiller conventions:
 * 1. Move tags from YAML frontmatter to the very end of notes (preceded by '---').
 * 2. Ensure distilled summaries stay at the top.
 * 3. Clean legacy comment markers into clean markdown dividers.
 * 4. Rename social/video notes (e.g. 'alex3danim_How_to_Animate_Lego_DbLsFBpvJeW')
 *    to '<Topic> by <author> <platform>'.
 */
export class ReformatConventionModal extends Modal {
  plugin: LocalOrganizerPlugin;
  private selectedFolder: string = "__ALL__";
  private isCancelled: boolean = false;
  private isRunning: boolean = false;

  constructor(app: App, plugin: LocalOrganizerPlugin) {
    super(app);
    this.plugin = plugin;

    // Check if Projects/ReelScribe exists to make it default if available
    const folders = getVaultFolders(app);
    if (folders.includes("Projects/ReelScribe")) {
      this.selectedFolder = "Projects/ReelScribe";
    }
  }

  onOpen(): void {
    this.renderInitialView();
  }

  onClose(): void {
    this.isCancelled = true;
    const { contentEl } = this;
    contentEl.empty();
  }

  private renderInitialView(): void {
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl("h2", { text: "Reformat Notes to Vault Convention" });
    contentEl.createEl("p", {
      text: "Standardize note structure across your vault: moves tags to the very end of notes, removes 'tags' from frontmatter YAML, keeps summaries at the top, and renames social/video files to '<Topic> by <author> <platform>'.",
      cls: "setting-item-description",
    });

    const folders = getVaultFolders(this.app);

    new Setting(contentEl)
      .setName("Scope / Target Folder")
      .setDesc("Choose which folder to reformat, or select the entire vault.")
      .addDropdown((dropdown) => {
        dropdown.addOption("__ALL__", "Entire Vault (All Folders)");
        for (const f of folders) {
          dropdown.addOption(f, f);
        }
        dropdown.setValue(this.selectedFolder);
        dropdown.onChange((val) => {
          this.selectedFolder = val;
        });
      });

    const infoBox = contentEl.createDiv({ cls: "vault-distiller-reformat-info" });
    infoBox.style.backgroundColor = "var(--background-secondary)";
    infoBox.style.padding = "12px 16px";
    infoBox.style.borderRadius = "6px";
    infoBox.style.fontSize = "0.9em";
    infoBox.style.marginBottom = "20px";
    infoBox.style.lineHeight = "1.5";

    infoBox.createEl("div", {
      text: "✨ What this reformat will do:",
      cls: "setting-item-name",
    });
    const ul = infoBox.createEl("ul");
    ul.style.margin = "6px 0 0 16px";
    ul.style.padding = "0";
    ul.createEl("li", {
      text: "Remove 'tags:' from YAML frontmatter so tags do not clutter the top of notes.",
    });
    ul.createEl("li", {
      text: "Place hashtags at the very end of notes preceded by a '---' horizontal divider.",
    });
    ul.createEl("li", {
      text: "Ensure distilled summaries stay at the top (under frontmatter) and clean legacy comment markers.",
    });
    ul.createEl("li", {
      text: "Rename social/video files (e.g. 'alex3danim_How_to_Animate_Lego_DbLsFBpvJeW') to 'How to animate lego by alex3danim instagram'.",
    });

    // Action button row
    const buttonRow = contentEl.createDiv({ cls: "modal-button-container" });
    buttonRow.style.display = "flex";
    buttonRow.style.justifyContent = "flex-end";
    buttonRow.style.gap = "10px";

    const cancelBtn = buttonRow.createEl("button", { text: "Cancel" });
    cancelBtn.onclick = () => this.close();

    const startBtn = buttonRow.createEl("button", {
      text: "Start Reformatting",
      cls: "mod-cta",
    });
    startBtn.onclick = () => this.startProcessing();
  }

  private async startProcessing(): Promise<void> {
    let candidateFiles = this.app.vault.getMarkdownFiles().filter((file) => {
      const parts = file.path.split("/");
      return !parts.some((p) => p.startsWith("."));
    });

    if (this.selectedFolder !== "__ALL__") {
      candidateFiles = candidateFiles.filter(
        (f) =>
          f.path.startsWith(this.selectedFolder + "/") ||
          f.parent?.path === this.selectedFolder
      );
    }

    if (candidateFiles.length === 0) {
      new Notice("Local Organizer: No Markdown notes found in the selected folder.");
      return;
    }

    this.renderProgressView(candidateFiles);
  }

  private renderProgressView(queue: TFile[]): void {
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl("h2", { text: "Reformatting Notes..." });

    const statusText = contentEl.createEl("p", {
      text: `Preparing to reformat ${queue.length} note(s)...`,
    });

    const progressBar = contentEl.createEl("progress");
    progressBar.max = queue.length;
    progressBar.value = 0;
    progressBar.style.width = "100%";
    progressBar.style.marginBottom = "15px";

    const logContainer = contentEl.createDiv({
      cls: "vault-distiller-bulk-log",
    });
    logContainer.style.height = "240px";
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
      text: "Stop / Cancel",
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
    queue: TFile[],
    progressBar: HTMLProgressElement,
    statusText: HTMLParagraphElement,
    appendLog: (msg: string) => void,
    stopBtn: HTMLButtonElement
  ): Promise<void> {
    this.isRunning = true;
    this.isCancelled = false;

    let reformattedCount = 0;
    let renamedCount = 0;

    for (let i = 0; i < queue.length; i++) {
      if (this.isCancelled) {
        appendLog("⏹️ Reformat stopped by user.");
        break;
      }

      const file = queue[i];
      progressBar.value = i + 1;
      statusText.setText(`[${i + 1}/${queue.length}] Reformatting "${file.basename}"...`);
      appendLog(`▶ [${i + 1}/${queue.length}] Processing "${file.basename}"...`);

      try {
        const res = await reformatNoteToConvention(this.app, file);
        reformattedCount++;

        let logMsg = `   ✅ Reordered sections (summary at top`;
        if (res.tagsMoved > 0) {
          logMsg += `, ${res.tagsMoved} tag(s) placed at end)`;
        } else {
          logMsg += `)`;
        }

        if (res.renamed) {
          renamedCount++;
          logMsg += ` → 📝 Renamed to "${res.newTitle}"`;
        }

        appendLog(logMsg);
      } catch (err) {
        appendLog(`   ❌ Error: ${err instanceof Error ? err.message : String(err)}`);
      }

      // Small yield to UI
      await new Promise((r) => setTimeout(r, 20));
    }

    this.isRunning = false;
    statusText.setText(
      `Finished! Reformatted ${reformattedCount} note(s), renamed ${renamedCount} file(s).`
    );
    stopBtn.setText("Done");
    stopBtn.className = "mod-cta";
    stopBtn.disabled = false;
    stopBtn.onclick = () => this.close();
  }
}
