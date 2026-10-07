export interface ResearchReference { id: string; title: string; href: string; excerpt: string; material: "body" | "summary" }
/** One conversation in the owner's research history, by its latest turn. */
export interface ResearchThreadSummary {
  id: string; articleId: string; articleTitle: string | null;
  firstQuestion: string; turns: number; status: ResearchTurn["status"]; updatedAt: string;
}
export interface ResearchTurn {
  id: string; owner: string; articleId: string; scope: "article" | "source" | "all";
  status: "queued" | "answering" | "completed" | "error";
  question: string; answer: string | null; error: string | null;
  previousId: string | null; references: ResearchReference[]; citations: number[];
}
