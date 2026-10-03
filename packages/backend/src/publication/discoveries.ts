// 今日发现: every listed report, selected or not, newest discovery first. `discovered_at` is when the
// site first stored the material (articles.discovered_at, copied at publish time), not when it was
// analysed: a report appears once analysis made it eligible, and a selected one once its release gate
// opens. Old material keeps its place by discovery and says how it arrived (first import, late,
// backfill) and, when the site's own search found it, the query; the timeline, heat and pushes are unchanged.
import type { DiscoveriesResponse, DiscoveryArrival, DiscoveryItem, MaterialStatus } from "@aihot/contracts/site";
import type { CategoryKey } from "@aihot/contracts/taxonomy";
import { sql } from "../db.ts";
import { decodeCursor, encodeCursor, InvalidCursorError, queryBinding } from "../lib/cursor.ts";
import { categoryCondition, ITEM_COLUMNS, ITEM_FROM, toFeedItemSummary, type ItemRow } from "./items.ts";
import { listedCondition, pendingReleaseCondition } from "./scope.ts";

interface DiscoveryRow extends ItemRow {
  body_status: string;
  has_body: boolean;
  has_excerpt: boolean;
  backfill_reason: string | null;
  research_question: string | null;
  search: { provider?: unknown; query?: unknown } | null;
}

/** The search that found the material (raw.search, written by sources/search.ts), when it is well formed. */
export function searchEvidence(raw: { provider?: unknown; query?: unknown } | null): DiscoveryItem["search"] {
  const provider = typeof raw?.provider === "string" ? raw.provider.trim() : "";
  const query = typeof raw?.query === "string" ? raw.query.replace(/\s+/g, " ").trim() : "";
  return provider && query ? { provider: provider.slice(0, 40), query: query.slice(0, 200) } : null;
}

/** What was fetched of the original. `ok` without stored text (a failed write) counts as no body. */
export function materialStatus(r: { body_status: string; has_body: boolean; has_excerpt: boolean }): MaterialStatus {
  if (r.body_status === "ok" && r.has_body) return "body";
  return r.has_excerpt ? "excerpt" : "title";
}

/** How the material arrived, from the timeline rule's backfill flag and reason (content/materials.ts). */
export function arrivalOf(r: { backfill: boolean; backfill_reason: string | null }): DiscoveryArrival {
  if (!r.backfill) return "live";
  if (r.backfill_reason === "first-import") return "first-import";
  if (r.backfill_reason === "stale-on-discovery") return "late";
  return "backfill";
}

function toDiscoveryItem(row: DiscoveryRow): DiscoveryItem {
  const question = row.research_question?.trim();
  return {
    ...toFeedItemSummary(row),
    discoveredAt: row.discovered_at.toISOString(),
    originalUrl: row.url,
    material: materialStatus(row),
    arrival: arrivalOf(row),
    // A lead for the reader to check, not a reason to read, so it shows whether or not the item was selected.
    researchQuestion: question ? question.slice(0, 200) : null,
    search: searchEvidence(row.search),
  };
}

export interface DiscoveriesQuery {
  category?: CategoryKey | null;
  cursor?: string | null;
  limit?: number;
  now?: Date;
}

/** Latest discovery time a cursor may carry (9999-12-31): a time JavaScript or PostgreSQL cannot read is a bad cursor, not a failed query. */
const MAX_CURSOR_TIME = Date.UTC(9999, 11, 31, 23, 59, 59, 999);

function binding(q: DiscoveriesQuery): string {
  return queryBinding({ k: q.category ?? null });
}

/** Where a page resumes; refuses a cursor made under another filter or carrying an impossible time. */
export function readDiscoveryCursor(cursor: string, q: DiscoveriesQuery): { d: number; i: string } {
  const c = decodeCursor<{ d: unknown; i: unknown; b: unknown }>("dc1", cursor);
  if (c.b !== binding(q)) throw new InvalidCursorError("cursor does not match this query");
  if (typeof c.d !== "number" || !Number.isSafeInteger(c.d) || c.d < 0 || c.d > MAX_CURSOR_TIME) throw new InvalidCursorError("malformed cursor");
  if (typeof c.i !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(c.i)) throw new InvalidCursorError("malformed cursor");
  return { d: c.d, i: c.i };
}

export async function loadDiscoveries(q: DiscoveriesQuery): Promise<Omit<DiscoveriesResponse, "generatedAt">> {
  const now = q.now ?? new Date();
  // Only a whole number reaches LIMIT; the site route refuses anything else before it gets here.
  const limit = Number.isInteger(q.limit) ? Math.min(Math.max(q.limit!, 1), 40) : 20;
  const category = q.category ?? null;
  const after = q.cursor ? readDiscoveryCursor(q.cursor, q) : null;
  const [rows, [pending]] = await Promise.all([
    sql<DiscoveryRow[]>`
      SELECT ${ITEM_COLUMNS}, a.body_status, (coalesce(a.body_text, '') <> '' OR a.x_post IS NOT NULL) AS has_body,
             coalesce(a.excerpt, '') <> '' AS has_excerpt, a.backfill_reason, an.output->>'researchQuestion' AS research_question,
             CASE WHEN jsonb_typeof(a.raw->'search') = 'object' THEN a.raw->'search' END AS search
      ${ITEM_FROM}
      LEFT JOIN analyses an ON an.id = p.analysis_id
      WHERE ${listedCondition(now)} ${categoryCondition(category)}
        ${after ? sql`AND (p.discovered_at, p.article_id) < (${new Date(after.d)}, ${after.i})` : sql``}
      ORDER BY p.discovered_at DESC, p.article_id DESC
      LIMIT ${limit + 1}`,
    sql<{ t: Date | null }[]>`SELECT min(p.visible_after) AS t FROM publications p WHERE ${pendingReleaseCondition(now)} ${categoryCondition(category)}`,
  ]);
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    filters: { category },
    items: page.map(toDiscoveryItem),
    nextCursor: rows.length > limit && last ? encodeCursor("dc1", { d: last.discovered_at.getTime(), i: last.id, b: binding(q) }) : null,
    refreshAt: pending?.t ? pending.t.toISOString() : null,
  };
}
