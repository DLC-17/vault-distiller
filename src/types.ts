export interface LocalOrganizerSettings {
  ollamaUrl: string;
  selectedModel: string;
  availableModels: string[];
  temperature: number;
  prependSummary: boolean;
  appendRelatedLinks: boolean;
  appendTodos: boolean;
  updateFrontmatterTitle: boolean;
  autoRenameFile: boolean;
  autoMoveToFolder: boolean;
  skipAlreadyOrganized: boolean;
  autoDiscoverConcepts: boolean;
  maxContextTags: number;
  maxContextNotes: number;
  maxNoteChars: number;
  defaultConceptFolder: string;
  autoScanSyncConflicts: boolean;
}

export const DEFAULT_SETTINGS: LocalOrganizerSettings = {
  ollamaUrl: "http://127.0.0.1:11434",
  selectedModel: "",
  availableModels: [],
  temperature: 0.2,
  prependSummary: true,
  appendRelatedLinks: true,
  appendTodos: true,
  updateFrontmatterTitle: true,
  autoRenameFile: true,
  autoMoveToFolder: true,
  skipAlreadyOrganized: true,
  autoDiscoverConcepts: true,
  maxContextTags: 50,
  maxContextNotes: 50,
  maxNoteChars: 10000,
  defaultConceptFolder: "Computer Science",
  autoScanSyncConflicts: true,
};

export const MIN_CONTENT_CHARS = 50;
export const OLLAMA_TIMEOUT_MS = 180_000;

export interface SyncConflictPair {
  conflictFile: import("obsidian").TFile;
  canonicalFile: import("obsidian").TFile | null;
  canonicalPath: string;
  isOrphaned: boolean;
  status: "pending" | "merged" | "failed" | "identical";
  message?: string;
}

export interface OllamaSuggestedLink {
  title: string;
  reason: string;
}

export interface DiscoveredConcept {
  name: string;
  suggested_folder: string;
  reason: string;
}

export interface ConceptPrimerResult {
  title: string;
  tags: string[];
  overview: string;
  core_principles: string[];
  brief_tutorial: string[];
  code_or_syntax_example: string;
  suggested_folder: string;
  suggested_links: OllamaSuggestedLink[];
}

export interface DistilledResult {
  clean_title: string;
  tags: string[];
  distilled_summary: string;
  suggested_links: OllamaSuggestedLink[];
  open_questions_or_todos: string[];
  suggested_folder?: string;
  discovered_concepts?: DiscoveredConcept[];
}
