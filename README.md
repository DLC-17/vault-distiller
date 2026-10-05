# Vault Distiller

[![GitHub Release](https://img.shields.io/github/v/release/DLC-17/vault-distiller?color=purple)](https://github.com/DLC-17/vault-distiller/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Obsidian: >= 1.5.0](https://img.shields.io/badge/Obsidian-%3E%3D%201.5.0-705dcf.svg)](https://obsidian.md)
[![Ollama: Local & Offline](https://img.shields.io/badge/Ollama-100%25%20Offline-black.svg)](https://ollama.com)
[![Ko-fi](https://img.shields.io/badge/Ko--fi-Support%20DLC--17-ff5e5b?logo=kofi&logoColor=white)](https://ko-fi.com/dlc17)

**Vault Distiller** is a 100% offline, private AI research assistant and knowledge organizer for [Obsidian](https://obsidian.md), powered by your local [Ollama](https://ollama.com) instance.

Designed from the ground up to run smoothly on consumer laptop GPUs (e.g. NVIDIA RTX 3060 6GB VRAM) and CPU environments, Vault Distiller transforms your notes into an interconnected, queryable second brain without a single byte leaving your computer.

---

## Key Features

### 1. Interactive AI Chat Studio (Right Sidebar)
- **NotebookLM-Style Studio**: A dedicated right-sidebar chat panel rendered with native Obsidian markdown, syntax highlighting, callouts, and internal `[[wikilinks]]`.
- **Active Note Grounding**: Automatically grounds answers in the note you are currently editing. Toggle between note-grounded and vault-wide context with a single click.
- **Dual-Track Query Specificity Engine**:
  - *General Track*: Responds conversationally with intuitive explanations, analogies, and summaries for broad queries (*"What is the difference between sync and async?", "Brainstorm portfolio ideas"*).
  - *Specific Documentation Track*: When asking about syntax, APIs, configurations, or specific libraries (*"How do I configure schema resolvers in GraphQL?"*), the assistant automatically searches your vault documentation (`Computer Science/`, `#concept`, `#reference`) or official technical documentation to provide verified code examples with anti-hallucination constraints.
- **One-Click Actions**:
  - `Insert at Cursor`: Injects AI responses directly into your active note.
  - `Append to Note`: Appends the response to the bottom of the active note preceded by `---`.
  - `Save as Note`: Creates a clean, formatted `.md` file in your vault.
  - `Copy`: Copies formatted markdown to clipboard.

### 2. Autonomous Concept Discovery & Reference Primers
- Analyzes your notes and automatically detects novel tools, frameworks, and foundational concepts that lack dedicated notes in your vault.
- Synthesizes comprehensive **Reference Primers** containing:
  - Executive Overview
  - Core Principles & Architecture
  - **Quickstart Implementation Tutorial** (Setup, Configure, Implement, Run)
  - Practical Syntax & Working Code Boilerplate
  - Bidirectional cross-linking to your existing vault notes.

### 3. External Web & arXiv Paper Ingestion
- Paste any web article URL or arXiv research paper link (e.g. `https://arxiv.org/abs/1706.03762`) directly into the Chat Studio or run `/fetch <url>`.
- Automatically fetches and distills the paper or article into an executive abstract, core mechanisms, practical implications, and relevant vault wikilinks.

### 4. Smart Lossless Sync Conflict Resolver
- Automatically detects conflict files created by **Syncthing**, **Obsidian Sync**, Dropbox, or OneDrive (`.sync-conflict-YYYYMMDD-HHMMSS-DEVICE.md` or `(conflicted copy)`).
- Intelligently merges additions across devices:
  - **Checklists**: Unions checklist tasks (`- [ ]`), preserving completed state (`- [x]`) if checked on either device.
  - **Sections**: Unions unique paragraphs and bullet points under corresponding markdown headings.
  - **Relocated Matching**: Safely matches files even if one copy was relocated to a subfolder.
  - **Non-Destructive Cleanup**: Moves conflict files safely to Obsidian's `.trash` folder (`app.vault.trash(file, true)`).

### 5. Automated Distillation & Organization
- **Executive Summaries**: Places high-density `> [!abstract] Distilled Summary` callouts at the top of notes.
- **Task Extraction**: Extracts action items and unanswered questions into clean checklist tasks (`- [ ]`).
- **Hallucination-Proof Backlinks**: Recommends related notes strictly verified against real Markdown files in your vault.
- **Vault Taxonomy Tags**: Merges suggested tags with your existing vault tag taxonomy.
- **Sourced Title Renaming**: Standardizes social/video notes (e.g. `alex3danim_How_to_Animate_Lego_DbLsFBpvJeW.md` → `How to animate lego by alex3danim instagram.md`).
- **Bulk Processing**: Batch process folders or the entire vault with live progress logging and cancellation controls.

---

## Quickstart & Installation

### Prerequisites

1. Install and run [Ollama](https://ollama.com).
2. Pull a recommended lightweight model (optimized for speed and low VRAM):
   ```bash
   # Meta's 3B model (recommended for fast, structured reasoning)
   ollama pull llama3.2:3b

   # Qwen 2.5 3B (strong technical and multilingual performance)
   ollama pull qwen2.5:3b
   ```

### Option A: Install via Obsidian Community Plugins (Recommended once approved)
1. Open **Settings** → **Community Plugins** in Obsidian.
2. Turn off **Restricted mode**.
3. Click **Browse** and search for **Vault Distiller**.
4. Click **Install**, then **Enable**.

### Option B: Install via BRAT (Beta Reviewers Auto-update Tester)
1. Install the [BRAT plugin](https://github.com/TfTHacker/obsidian42-brat) from Community Plugins.
2. In BRAT settings, click **Add Beta plugin**.
3. Enter repository: `DLC-17/vault-distiller`.
4. Click **Add Plugin** and enable **Vault Distiller**.

### Option C: Manual Installation
1. Download `main.js`, `manifest.json`, and `styles.css` from the [Latest Release](https://github.com/DLC-17/vault-distiller/releases).
2. Inside your Obsidian vault, navigate to `.obsidian/plugins/` and create a folder named `vault-distiller`.
3. Copy the 3 downloaded files into that folder.
4. In Obsidian, go to **Settings** → **Community Plugins** → **Reload plugins**, then toggle on **Vault Distiller**.

---

## Configuration

Open **Settings** → **Vault Distiller**:

| Setting | Default | Description |
| :--- | :--- | :--- |
| **Ollama Server URL** | `http://127.0.0.1:11434` | The endpoint where your local Ollama server is running. |
| **Model Selection** | Dropdown | Automatically populated from your installed Ollama models via `/api/tags`. |
| **Temperature** | `0.2` | Lower values ensure deterministic, structured responses. |
| **Auto-Scan Sync Conflicts** | `true` | Checks for Syncthing/Obsidian Sync conflicts on vault startup. |
| **Default Concept Folder** | `Computer Science` | Folder where generated concept notes and technical primers are saved. |
| **Max Context Notes / Tags** | `50` / `50` | Number of existing notes and tags supplied to Ollama to guide backlink generation. |

---

## Command Reference

| Command | Action |
| :--- | :--- |
| `Local Organizer: Open AI Chat Studio` | Opens the interactive Chat Studio in the right sidebar. |
| `Local Organizer: Process Active Note` | Distills summary, extracts tasks, assigns tags, and suggests related notes. |
| `Local Organizer: Research & Generate Concept Note...` | Opens modal to generate an in-depth reference primer for any technical topic. |
| `Local Organizer: Bulk Organize Vault or Folder` | Batch organizes notes in a selected folder or the entire vault. |
| `Local Organizer: Reformat Notes to Convention...` | Moves tags to the end preceded by `---` and cleans legacy markers. |
| `Local Organizer: Scan & Merge Sync Conflicts...` | Scans for `.sync-conflict` files, displays diffs, and performs lossless smart merge. |

### Chat Studio Slash Commands
* `/condense` — Generate an executive summary and key takeaways from the active note.
* `/synthesize <topic>` — Synthesize knowledge across all vault notes mentioning the topic with `[[wikilinks]]`.
* `/doc <topic>` — Force strict documentation grounding on a specific library or syntax.
* `/generate <topic>` — Draft a full reference primer with step-by-step tutorial and code examples.
* `/format` — Reformat the active note to adhere to vault-distiller conventions.
* `/fetch <url>` — Ingest, analyze, and summarize an external web article or arXiv research paper.

---

## Privacy & Local-First Philosophy

- **Zero Cloud Calls**: Vault Distiller communicates exclusively with your local Ollama instance at `127.0.0.1` via Obsidian's desktop API.
- **Zero Telemetry**: No usage metrics, error reports, or telemetry data are collected.
- **Safe Vault Modification**: All file updates are executed through Obsidian's native APIs (`app.fileManager.processFrontMatter`, `app.vault.process`, and `app.vault.trash`).

---

## Building from Source

```bash
# Clone the repository
git clone https://github.com/DLC-17/vault-distiller.git
cd vault-distiller

# Install dependencies
npm install

# Build for production
npm run build

# Development build with live watch
npm run dev
```

---

## Support & Donations

If you find Vault Distiller helpful for your research, studies, and note-taking workflow, consider supporting its continued development:

[![ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/dlc17)

Or visit [https://ko-fi.com/dlc17](https://ko-fi.com/dlc17). Your support helps keep this project 100% free, open-source, and offline!

---

## License

This project is licensed under the [MIT License](LICENSE).
