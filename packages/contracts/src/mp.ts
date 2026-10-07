export interface MpArchiveState {
  runId: string;
  mode: "list" | "bodies";
  status: "queued" | "running" | "paused" | "completed" | "error";
  offset: string;
  pages: number;
  stored: number;
  bodies: number;
  failed: number;
  listComplete: boolean;
  /** Follows the account's list provider; switching provider starts the history list again. */
  listProvider?: "dajiala" | "everyinfra";
  lastReceiptId: number | null;
  error: string | null;
  workingUntil?: string | null;
}
export interface MpLibrary {
  accounts: Array<{ id: string; name: string; count: number; bodyCount: number }>;
  items: Array<{ id: string; title: string; url: string; sourceId: string; sourceName: string; publishedAt: string | null; hasBody: boolean; summary: string | null }>;
  page: number;
  hasMore: boolean;
}
export interface MpLibraryArticle {
  id: string; title: string; url: string; sourceId: string; sourceName: string;
  publishedAt: string | null; summary: string | null; html: string | null;
}
