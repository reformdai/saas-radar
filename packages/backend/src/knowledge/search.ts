// The administrator's knowledge search for the assistant: every collected article body (whatever its
// public full-text setting; only the administrator asks, and the public pages are unchanged), the
// WeChat group digests, and windows of the raw group messages around a hit (speakers anonymised,
// numbers scrubbed, as in the digests). Ranking is by the passages that match, not by article date,
// so evidence deep inside a long article still comes back.
import type { AgentCitation } from "@aihot/contracts/agent";
import { sql } from "../db.ts";
import { stripTags } from "../lib/text.ts";
import { scrubWechat } from "../wechat/digest-content.ts";
import { readableWechatContent } from "../wechat/message-content.ts";

export type KnowledgeHit = Omit<AgentCitation, "n">;
export interface KnowledgeQuery {
  q: string;
  /** A source or group name (or source id): only its articles, digests and messages. */
  source?: string;
  kind?: "all" | "article" | "wechat";
  /** One article only (the page the administrator is reading). */
  articleId?: string;
  /** YYYY-MM-DD, Beijing time. */
  since?: string;
}

const STOP = new Set(["什么", "怎么", "如何", "为什么", "这个", "那个", "这篇", "文章", "解释", "一下", "可以", "哪些", "请问", "我们", "他们", "觉得",
  "认为", "有没有", "是不是", "关于", "看法", "观点", "最近", "总结", "介绍", "the", "and", "for", "with", "how", "what", "why"]);
const WINDOW = 520;
const MESSAGE_CONTEXT = 10;

export function knowledgeTerms(q: string, source?: string): string[] {
  const words = Array.from(new Intl.Segmenter("zh", { granularity: "word" }).segment(q))
    .filter((p) => p.isWordLike && p.segment.length >= 2).map((p) => p.segment.toLowerCase());
  const own = source?.toLowerCase() ?? "";
  // A word that names the source is a filter already, not something the passage must contain.
  return [...new Set(words.filter((w) => !STOP.has(w) && !(own && own.includes(w))))].slice(0, 8);
}

const count = (text: string, term: string) => {
  let n = 0;
  for (let i = text.indexOf(term); i >= 0 && n < 3; i = text.indexOf(term, i + term.length)) n++;
  return n;
};

/** Term weights from how many candidates contain each term: a rare term says more than a common one. */
function weights(terms: string[], texts: string[]): Map<string, number> {
  const lower = texts.map((t) => t.toLowerCase());
  return new Map(terms.map((t) => [t, Math.log(1 + texts.length / Math.max(1, lower.filter((x) => x.includes(t)).length))]));
}

function score(text: string, w: Map<string, number>): number {
  const lower = text.toLowerCase();
  let total = 0, matched = 0;
  for (const [term, weight] of w) {
    const n = count(lower, term);
    if (n) { total += weight * n; matched++; }
  }
  // Passages that hold several of the asked words rank above ones repeating a single word.
  return w.size ? total * (1 + matched / w.size) : 0;
}

/** Sentence-aligned windows of about WINDOW characters (the stored bodies have no paragraph breaks). */
export function windows(text: string): string[] {
  const sentences = text.match(/[^。！？!?；\n]+[。！？!?；\n]*/g) ?? [text];
  const out: string[] = [];
  let current = "";
  for (const sentence of sentences) {
    for (let i = 0; i < sentence.length; i += WINDOW * 2) {
      const piece = sentence.slice(i, i + WINDOW * 2);
      if (current && current.length + piece.length > WINDOW) { out.push(current.trim()); current = ""; }
      current += piece;
    }
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

const like = (terms: string[]) => terms.map((t) => `%${t.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
const sourcePattern = (source?: string) => source?.trim() ? `%${source.trim()}%` : null;
const day = (value: unknown) => value instanceof Date ? value.toISOString() : value ? String(value) : null;

interface ArticleRow { id: string; title: string; source: string; kind: string; url: string | null; published_at: Date | null; summary: string | null; body: string | null; visibility: string | null }

async function articleHits(terms: string[], query: KnowledgeQuery, limit: number): Promise<KnowledgeHit[]> {
  const patterns = like(terms);
  const source = sourcePattern(query.source);
  if (!patterns.length && !query.articleId) return [];
  const rows = await sql<ArticleRow[]>`
    SELECT a.id, coalesce(p.title, a.title) AS title, s.name AS source, s.kind, a.url, a.published_at,
           coalesce(p.summary, a.excerpt) AS summary, a.body_text AS body, p.visibility
    FROM articles a JOIN sources s ON s.id = a.source_id
    LEFT JOIN publications p ON p.article_id = a.id LEFT JOIN editorial_overrides o ON o.article_id = a.id
    WHERE coalesce(o.visibility, p.visibility, 'public') <> 'withdrawn'
      AND (${query.articleId ?? null}::text IS NULL OR a.id = ${query.articleId ?? null})
      AND (${source}::text IS NULL OR s.name ILIKE ${source} OR s.id = ${query.source?.trim() ?? ""})
      AND (${query.since ?? null}::date IS NULL OR a.published_at >= (${query.since ?? null}::date::timestamp AT TIME ZONE 'Asia/Shanghai'))
      AND (${query.articleId ?? null}::text IS NOT NULL OR a.title ILIKE ANY(${patterns}::text[]) OR p.title ILIKE ANY(${patterns}::text[])
        OR coalesce(p.summary, a.excerpt) ILIKE ANY(${patterns}::text[]) OR a.body_text ILIKE ANY(${patterns}::text[]))
    -- Candidates holding more of the asked words first (a title hit counts double); passages are ranked below.
    ORDER BY (SELECT count(*) FROM unnest(${patterns}::text[]) x WHERE a.title ILIKE x OR p.title ILIKE x) * 2
           + (SELECT count(*) FROM unnest(${patterns}::text[]) x WHERE a.body_text ILIKE x OR coalesce(p.summary, a.excerpt) ILIKE x) DESC,
      a.published_at DESC NULLS LAST
    LIMIT 60`;
  if (!rows.length) return [];
  const w = weights(terms, rows.map((r) => `${r.title} ${r.summary ?? ""} ${r.body ?? ""}`));
  const passages = rows.flatMap((r) => {
    const body = stripTags(r.body ?? "").trim();
    const parts = body.length > 200 ? windows(body) : [stripTags(r.summary ?? r.title)];
    const titleBonus = score(r.title, w) * 0.3;
    return parts.map((text, position) => ({ r, text, position, score: score(text, w) + titleBonus, body: body.length > 200 }));
  });
  let chosen: typeof passages;
  if (query.articleId) {
    // One article: its best passages in reading order, or its opening when nothing particular was asked.
    const ranked = terms.length ? passages.filter((p) => p.score > 0).sort((a, b) => b.score - a.score).slice(0, limit) : [];
    chosen = (ranked.length ? ranked : passages.slice(0, limit)).sort((a, b) => a.position - b.position);
  } else {
    const perArticle = new Map<string, number>();
    chosen = passages.filter((p) => p.score > 0).sort((a, b) => b.score - a.score).filter((p) => {
      const n = perArticle.get(p.r.id) ?? 0;
      if (n >= 2) return false;
      perArticle.set(p.r.id, n + 1);
      return true;
    }).slice(0, limit);
  }
  return chosen.map(({ r, text, body }) => ({
    kind: "article", title: r.title, source: r.source, at: day(r.published_at), url: r.url,
    href: r.kind === "mp_account" ? `/mp/articles/${r.id}` : r.visibility === "public" ? `/items/${r.id}` : null,
    quote: body ? text : `（只有摘要）${text}`,
  }));
}

async function digestHits(terms: string[], query: KnowledgeQuery, limit: number): Promise<KnowledgeHit[]> {
  const patterns = like(terms);
  if (!patterns.length) return [];
  const source = sourcePattern(query.source);
  const rows = await sql<{ account: string; group_id: string; name: string; day: string; title: string; summary: string }[]>`
    SELECT d.account, d.group_id, g.name, d.day::text, point->>'title' AS title, point->>'summary' AS summary
    FROM wechat_digests d JOIN wechat_groups g USING (account, group_id), jsonb_array_elements(d.points) point
    WHERE d.status = 'ready' AND g.enabled
      AND (${source}::text IS NULL OR g.name ILIKE ${source})
      AND (${query.since ?? null}::date IS NULL OR d.day >= ${query.since ?? null}::date)
      AND (point->>'title' ILIKE ANY(${patterns}::text[]) OR point->>'summary' ILIKE ANY(${patterns}::text[]))
    ORDER BY d.day DESC LIMIT 80`;
  const w = weights(terms, rows.map((r) => `${r.title} ${r.summary}`));
  return rows.map((r) => ({ r, score: score(`${r.title} ${r.title} ${r.summary}`, w) })).filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score).slice(0, limit).map(({ r }) => ({
      kind: "wechat_digest", title: `${r.title}`, source: `${r.name} · 群摘要`, at: r.day, url: null,
      href: `/wechat?${new URLSearchParams({ account: r.account, group: r.group_id, day: r.day })}`,
      quote: `${r.title}：${r.summary}`.slice(0, 1600),
    }));
}

interface MessageRow { account: string; group_id: string; name: string; message_id: string; sender_id: string; content: string; sent_at: number }

async function messageHits(terms: string[], query: KnowledgeQuery, limit: number): Promise<KnowledgeHit[]> {
  const patterns = like(terms);
  if (!patterns.length) return [];
  const source = sourcePattern(query.source);
  const since = query.since ? Date.parse(`${query.since}T00:00:00+08:00`) / 1000 : null;
  const rows = await sql<MessageRow[]>`
    SELECT m.account, m.group_id, g.name, m.message_id, m.sender_id, m.content, m.sent_at::float8 AS sent_at
    FROM wechat_messages m JOIN wechat_groups g USING (account, group_id)
    WHERE g.enabled AND NOT m.revoked AND m.content ILIKE ANY(${patterns}::text[])
      AND (${source}::text IS NULL OR g.name ILIKE ${source})
      AND (${since}::bigint IS NULL OR m.sent_at >= ${since})
    ORDER BY (SELECT count(*) FROM unnest(${patterns}::text[]) x WHERE m.content ILIKE x) DESC, m.sent_at DESC LIMIT 300`;
  const w = weights(terms, rows.map((r) => r.content));
  const ranked = rows.map((r) => ({ r, score: score(readableWechatContent(r.content), w) })).filter((x) => x.score > 0).sort((a, b) => b.score - a.score);
  const hits: KnowledgeHit[] = [];
  const taken: Array<{ group: string; from: number; to: number }> = [];
  for (const { r } of ranked) {
    if (hits.length >= limit) break;
    if (taken.some((t) => t.group === `${r.account}:${r.group_id}` && r.sent_at >= t.from && r.sent_at <= t.to)) continue;
    const around = await sql<MessageRow[]>`
      (SELECT message_id, sender_id, content, sent_at::float8 AS sent_at FROM wechat_messages
        WHERE account = ${r.account} AND group_id = ${r.group_id} AND NOT revoked AND (sent_at, message_id) < (${r.sent_at}::bigint, ${r.message_id})
        ORDER BY sent_at DESC, message_id DESC LIMIT ${MESSAGE_CONTEXT})
      UNION ALL
      (SELECT message_id, sender_id, content, sent_at::float8 AS sent_at FROM wechat_messages
        WHERE account = ${r.account} AND group_id = ${r.group_id} AND NOT revoked AND (sent_at, message_id) >= (${r.sent_at}::bigint, ${r.message_id})
        ORDER BY sent_at, message_id LIMIT ${MESSAGE_CONTEXT + 1})`;
    around.sort((a, b) => a.sent_at - b.sent_at || a.message_id.localeCompare(b.message_id));
    // Speakers are numbered within the window; names never reach the model.
    const speakers = new Map<string, string>();
    const lines = around.map((m) => {
      const who = m.sender_id || `unknown:${m.message_id}`;
      if (!speakers.has(who)) speakers.set(who, `发言者${speakers.size + 1}`);
      const time = new Date((m.sent_at + 8 * 3600) * 1000).toISOString().slice(11, 16);
      const text = scrubWechat(readableWechatContent(m.content)).replace(/\s+/g, " ").slice(0, 300);
      return `${time} ${speakers.get(who)}${m.message_id === r.message_id ? "（命中）" : ""}：${text}`;
    });
    const from = around[0]?.sent_at ?? r.sent_at, to = around.at(-1)?.sent_at ?? r.sent_at;
    taken.push({ group: `${r.account}:${r.group_id}`, from, to });
    const date = new Date((r.sent_at + 8 * 3600) * 1000).toISOString().slice(0, 10);
    hits.push({
      kind: "wechat_messages", title: `${r.name} 的群聊片段`, source: `${r.name} · 原消息`, at: new Date(r.sent_at * 1000).toISOString(), url: null,
      href: `/wechat?${new URLSearchParams({ account: r.account, group: r.group_id })}`,
      quote: `${date}\n${lines.join("\n")}`.slice(0, 3000),
    });
  }
  return hits;
}

/** Passages for a question, best first: articles, then group digests, then raw group conversations. */
export async function searchKnowledge(query: KnowledgeQuery): Promise<KnowledgeHit[]> {
  const terms = knowledgeTerms(query.q, query.source);
  const kind = query.articleId ? "article" : query.kind ?? "all";
  const [articles, digests, messages] = await Promise.all([
    kind === "wechat" ? [] : articleHits(terms, query, query.articleId ? 10 : kind === "article" ? 10 : 7),
    kind === "article" ? [] : digestHits(terms, query, kind === "wechat" ? 4 : 3),
    kind === "article" ? [] : messageHits(terms, query, kind === "wechat" ? 4 : 2),
  ]);
  return [...articles, ...digests, ...messages];
}
