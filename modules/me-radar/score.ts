// The personal layer: after the engine has judged whether a story matters to the industry, this scores
// it against Dai's own profile (prompts/profile.md + relevance.md). Everything eligible in the pool is
// scored — not only selected items — because what the industry threshold drops may still be exactly what
// he watches. High scores push one card each; mid scores collect into a once-a-day digest card.
import { z } from "zod";
import { sql } from "@aihot/backend/db";
import { beijingDate } from "@aihot/contracts/time";
import { modelFor } from "@aihot/backend/editorial/models";
import { defineQueue } from "@aihot/backend/modules";
import { enqueueOn } from "@aihot/backend/jobs/queue";
import { deliverContent } from "@aihot/backend/notify/deliver";
import { chatJson } from "@aihot/backend/providers/llm";
import { publicSourceName } from "@aihot/backend/publication/rules";
import { personalCard, digestCard, type MeItem } from "./card.ts";
import { mePrompt, mePromptVersion } from "./prompts.ts";

/** Score bands: PUSH now, collect into the daily digest, or stay silent in the DB. */
export const ME_BANDS = { push: 80, digest: 55 };
/** Items already sent as a card are excluded from the digest. */
const PUSH_TARGET = "feishu-personal-main";
const MAX_AGE_MS = 12 * 3600_000;
const SCAN_BATCH = 60;
const DIGEST_BAND_MAX_ITEMS = 12;

const RelevanceSchema = z.object({ relevanceScore: z.number().int().min(0).max(100), why: z.string().max(200) });

interface PubRow {
  article_id: string;
  title: string;
  summary: string | null;
  reason: string | null;
  category: string | null;
  tags: string[];
  url: string;
  published_at: Date | null;
  discovered_at: Date;
  timeline_at: Date;
  fact_id: number | null;
  source_name: string;
}

/** The personal push group. Content targets start disabled upstream; this one is enabled on first use. */
export async function ensurePersonalTarget() {
  await sql`
    INSERT INTO notify_targets (key, purpose, kind, enabled, enabled_at, config_ref, note) VALUES
      (${PUSH_TARGET}, 'content', 'feishu_webhook', true, now(), 'FEISHU_ME_PUSH_WEBHOOK_URL', 'Dai 的个人筛选推送')
    ON CONFLICT (key) DO NOTHING`;
}

export const meScoreQueue = defineQueue<{ articleId: string }>({
  name: "me-radar.score",
  options: { policy: "short", retryLimit: 2, retryDelay: 60, retryBackoff: true, expireInSeconds: 600 },
  worker: { localConcurrency: 1, pollingIntervalSeconds: 5 },
  run: async (jobs: { articleId: string }[]) => Promise.all(jobs.map((j) => scoreArticle(j.articleId))),
});

/** Finds newly eligible pool items without a personal verdict and queues scoring (worker schedule). */
export async function scanPending() {
  const rows = await sql<{ article_id: string }[]>`
    SELECT p.article_id FROM publications p
    WHERE p.eligible AND p.visibility = 'public' AND NOT p.backfill
      AND p.discovered_at > now() - interval '7 days'
      AND NOT EXISTS (SELECT 1 FROM me_relevance m WHERE m.article_id = p.article_id)
    ORDER BY p.discovered_at DESC LIMIT ${SCAN_BATCH}`;
  let queued = 0;
  for (const r of rows) {
    if (await enqueueOn(meScoreQueue, { articleId: r.article_id })) queued++;
  }
  return { found: rows.length, queued };
}

async function loadItem(articleId: string): Promise<PubRow | null> {
  const [r] = await sql<PubRow[]>`
    SELECT p.article_id, p.title, p.summary, p.reason, p.category, p.tags, p.url,
           p.published_at, p.discovered_at, p.timeline_at, p.fact_id, s.name AS source_name
    FROM publications p JOIN sources s ON s.id = p.source_id
    WHERE p.article_id = ${articleId} AND p.eligible AND p.visibility = 'public'`;
  return r ?? null;
}

export async function scoreArticle(articleId: string, now = new Date()): Promise<{ status: string; score?: number }> {
  const r = await loadItem(articleId);
  if (!r) return { status: "skipped", score: undefined };

  const model = await modelFor("meRelevance");
  const res = await chatJson({
    model,
    purpose: "me_relevance",
    subject: `article:${articleId}`,
    promptVersion: mePromptVersion("relevance"),
    system: mePrompt("relevance"),
    user: JSON.stringify({
      title: r.title,
      summary: r.summary,
      reason: r.reason,
      category: r.category,
      tags: r.tags,
      source: publicSourceName(r.source_name),
      url: r.url,
      publishedAt: r.published_at ?? r.discovered_at,
    }),
    schema: RelevanceSchema,
    temperature: 0,
    maxTokens: 512,
  });
  const score = res.data.relevanceScore;
  const why = res.data.why.slice(0, 80);

  await sql`
    INSERT INTO me_relevance (article_id, score, why, model, prompt_version, receipt_ids)
    VALUES (${articleId}, ${score}, ${why}, ${res.model}, ${mePromptVersion("relevance")}, ${[res.receiptId]})
    ON CONFLICT (article_id) DO NOTHING`;

  if (score >= ME_BANDS.push && now.getTime() - r.timeline_at.getTime() <= MAX_AGE_MS) {
    const siblings = r.fact_id
      ? (await sql<{ article_id: string }[]>`SELECT article_id FROM fact_articles WHERE fact_id = ${r.fact_id} AND article_id <> ${articleId}`).map((x) => x.article_id)
      : [];
    await ensurePersonalTarget();
    const card = personalCard(toItem(r, score, why));
    const dedupeKey = r.fact_id ? `me:fact:${r.fact_id}` : `me:article:${articleId}`;
    const targets = await deliverContent({ subjectKind: "me", subjectId: articleId, dedupeKey, contentAt: r.discovered_at, card, targetKey: PUSH_TARGET, siblings });
    if (targets.some((t) => t.status === "sent")) {
      await sql`UPDATE me_relevance SET pushed_at = now() WHERE article_id = ${articleId}`;
    }
    return { status: "pushed", score };
  }
  return { status: "scored", score };
}

const toItem = (r: PubRow, score: number, why: string): MeItem => ({
  article_id: r.article_id, title: r.title, summary: r.summary, reason: r.reason,
  url: r.url, source_name: publicSourceName(r.source_name), score, why,
});

/** One card a day with the mid-band items nobody got pushed about (worker schedule, 21:05 Beijing). */
export async function sendDailyDigest(now = new Date()) {
  const rows = await sql<(PubRow & { score: number; why: string })[]>`
    SELECT p.article_id, p.title, p.summary, p.reason, p.category, p.tags, p.url,
           p.published_at, p.discovered_at, p.timeline_at, p.fact_id, s.name AS source_name,
           m.score, m.why
    FROM me_relevance m JOIN publications p ON p.article_id = m.article_id JOIN sources s ON s.id = p.source_id
    WHERE m.score >= ${ME_BANDS.digest} AND m.score < ${ME_BANDS.push} AND m.pushed_at IS NULL
      AND p.visibility = 'public' AND m.decided_at > now() - interval '1 day'
    ORDER BY m.score DESC LIMIT ${DIGEST_BAND_MAX_ITEMS}`;
  if (!rows.length) return { sent: 0 };
  const items = rows.map((r) => toItem(r, r.score, r.why));
  const day = beijingDate(now);
  await ensurePersonalTarget();
  const card = digestCard(items, day);
  const targets = await deliverContent({
    subjectKind: "me-digest",
    subjectId: `digest:${day}`,
    dedupeKey: `me-digest:${day}`,
    contentAt: now,
    card,
    targetKey: PUSH_TARGET,
  });
  return { sent: targets.filter((t) => t.status === "sent").length, items: items.length };
}
