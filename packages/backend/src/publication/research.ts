import type { ResearchReference } from "@aihot/contracts/research";
import { sql } from "../db.ts";
import { stripTags } from "../lib/text.ts";
import { mpArchiveCondition, storyReportCondition } from "./scope.ts";

export function researchTerms(question: string): string[] {
  const parts = Array.from(new Intl.Segmenter("zh", { granularity: "word" }).segment(question));
  const stop = new Set(["什么", "怎么", "如何", "为什么", "这个", "那个", "文章", "解释", "一下", "可以", "哪些", "请问", "我们"]);
  return [...new Set(parts.filter(p => p.isWordLike && p.segment.length >= 2 && !stop.has(p.segment)).map(p => p.segment))].slice(0, 8);
}

export async function researchReferences(articleId: string, question: string, scope: "article" | "source" | "all"): Promise<ResearchReference[]> {
  const terms = researchTerms(question);
  const [seed] = await sql<{ source_id: string }[]>`SELECT source_id FROM articles WHERE id = ${articleId}`;
  if (!seed) return [];
  const patterns = terms.map(t => `%${t}%`);
  const rows = await sql<{ id: string; title: string; source_kind: string; body: string | null; summary: string | null }[]>`
    SELECT a.id, coalesce(p.title, a.title) AS title, s.kind AS source_kind,
      CASE WHEN s.site_fulltext AND (p.article_id IS NULL OR (p.visibility <> 'summary-only' AND p.body_mode = 'full'))
           THEN a.body_html END AS body, coalesce(p.summary, a.excerpt) AS summary
    FROM articles a JOIN sources s ON s.id = a.source_id LEFT JOIN publications p ON p.article_id = a.id
    WHERE (${mpArchiveCondition()} OR (${storyReportCondition(new Date())}))
      AND (a.id = ${articleId} OR (${scope} <> 'article' AND (${scope} = 'all' OR a.source_id = ${seed.source_id})
        AND (${patterns.length > 0} AND (a.title ILIKE ANY(${patterns}::text[]) OR coalesce(p.summary, a.excerpt) ILIKE ANY(${patterns}::text[]) OR (s.site_fulltext AND (p.article_id IS NULL OR (p.visibility <> 'summary-only' AND p.body_mode = 'full')) AND a.body_text ILIKE ANY(${patterns}::text[]))))))
    ORDER BY (a.id = ${articleId}) DESC, a.published_at DESC NULLS LAST LIMIT 5`;
  // A withdrawn or private seed cannot be used to open research of an unrelated collection.
  if (!rows.some(r => r.id === articleId)) return [];
  return rows.map(r => ({ id: r.id, title: r.title, href: r.source_kind === "mp_account" ? `/mp/articles/${r.id}` : `/items/${r.id}`,
    excerpt: stripTags(r.body || r.summary || r.title).slice(0, 9000), material: r.body ? "body" : "summary" }));
}
