// Account archives are readable without model selection; source mode and withdrawal still apply.
import type { MpLibrary, MpLibraryArticle } from "@aihot/contracts/mp";
import { sql } from "../db.ts";
import { proxyBodyImages } from "../media/imgproxy.ts";
import { normalizeMpBody } from "../content/mp-body.ts";
import { mpArchiveCondition } from "./scope.ts";

export async function mpLibrary(input: { source?: string; q?: string; page?: number }): Promise<MpLibrary> {
  const page = Math.min(100000, Math.max(1, Math.floor(input.page || 1)));
  const source = input.source || null;
  const q = input.q?.trim() ? `%${input.q.trim().slice(0, 150)}%` : null;
  const accounts = await sql<MpLibrary["accounts"]>`
    SELECT s.id, s.name, count(a.id)::int AS count,
           count(a.id) FILTER (WHERE a.body_status = 'ok')::int AS "bodyCount"
    FROM sources s LEFT JOIN articles a ON a.source_id = s.id LEFT JOIN publications p ON p.article_id = a.id
    WHERE ${mpArchiveCondition()} GROUP BY s.id ORDER BY s.name`;
  const rows = await sql<MpLibrary["items"]>`
    SELECT a.id, a.title, a.url, s.id AS "sourceId", s.name AS "sourceName", a.published_at AS "publishedAt",
           (a.body_status = 'ok' AND coalesce(a.body_text, '') <> '') AS "hasBody", p.summary
    FROM articles a JOIN sources s ON s.id = a.source_id LEFT JOIN publications p ON p.article_id = a.id
    WHERE ${mpArchiveCondition()} AND (${source}::text IS NULL OR s.id = ${source})
      AND (${q}::text IS NULL OR a.title ILIKE ${q} OR a.excerpt ILIKE ${q})
    ORDER BY a.published_at DESC NULLS LAST, a.id DESC LIMIT 31 OFFSET ${(page - 1) * 30}`;
  return { accounts, items: rows.slice(0, 30), page, hasMore: rows.length > 30 };
}

export async function mpArticleDetail(id: string): Promise<MpLibraryArticle | null> {
  const [row] = await sql<(MpLibraryArticle & { allowed: boolean })[]>`
    SELECT a.id, a.title, a.url, s.id AS "sourceId", s.name AS "sourceName", a.published_at AS "publishedAt", p.summary,
      CASE WHEN s.site_fulltext AND a.body_status = 'ok' AND (p.article_id IS NULL OR (p.visibility <> 'summary-only' AND p.body_mode = 'full'))
           THEN a.body_html END AS html, s.site_fulltext AS allowed
    FROM articles a JOIN sources s ON s.id = a.source_id LEFT JOIN publications p ON p.article_id = a.id
    WHERE a.id = ${id} AND ${mpArchiveCondition()}`;
  if (!row) return null;
  const { allowed: _allowed, ...out } = row;
  return { ...out, html: out.html ? proxyBodyImages(normalizeMpBody(out.html)) : null };
}
