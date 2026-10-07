export interface ResearchReference { id: string; title: string; href: string; excerpt: string; material: "body" | "summary" }
export interface ResearchTurn {
  id: string; owner: string; articleId: string; scope: "article" | "source" | "all";
  status: "queued" | "answering" | "completed" | "error";
  question: string; answer: string | null; error: string | null;
  previousId: string | null; references: ResearchReference[]; citations: number[];
}
