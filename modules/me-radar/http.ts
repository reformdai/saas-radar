// The card buttons' targets: feedback recording and the dive page, both plain GETs — a Feishu custom-bot
// webhook can only send, so useful/useless come back as URLs the group owner clicks.
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { marked } from "marked";
import { sql } from "@aihot/backend/db";
import { itemUrl, siteUrl } from "@aihot/backend/publication/links";
import { publicSourceName } from "@aihot/backend/publication/rules";
import { SITE } from "@aihot/site";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const page = (title: string, body: string) =>
  `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} — ${esc(SITE.name)}</title>
<style>body{font-family:system-ui,sans-serif;max-width:640px;margin:48px auto;padding:0 16px;color:#202a30;line-height:1.7}
pre{background:#f4f5f5;padding:12px;border-radius:8px;white-space:pre-wrap;word-break:break-word}
a{color:#176b75}</style></head><body>${body}</body></html>`;

const VALUE_LABEL: Record<string, string> = { useful: "有用", useless: "没用" };

async function feedback(req: FastifyRequest, reply: FastifyReply) {
  const { a, v } = req.query as { a?: string; v?: string };
  if (!a || !v || !(v in VALUE_LABEL)) return reply.code(400).type("text/html").send(page("参数不对", "<p>链接缺少参数。</p>"));
  const [item] = await sql<{ title: string }[]>`SELECT title FROM publications WHERE article_id = ${a} AND visibility = 'public'`;
  if (!item) return reply.code(404).type("text/html").send(page("没找到", "<p>这条内容不存在或已下线。</p>"));
  await sql`INSERT INTO me_feedback (article_id, value) VALUES (${a}, ${v})`;
  return reply.type("text/html").send(page(
    `已记录：${VALUE_LABEL[v]}`,
    `<h1>已记录：${VALUE_LABEL[v]}</h1><p>「${esc(item.title)}」</p><p>你的每次表态都在教它怎么筛；攒多了它会越来越准。</p><p><a href="${itemUrl(a)}">回站内看看</a></p>`,
  ));
}

async function dive(req: FastifyRequest, reply: FastifyReply) {
  const { a } = req.query as { a?: string };
  if (!a) return reply.code(400).type("text/html").send(page("参数不对", "<p>链接缺少参数。</p>"));
  const [r] = await sql<{ title: string; summary: string | null; url: string; source_name: string }[]>`
    SELECT p.title, p.summary, p.url, s.name AS source_name
    FROM publications p JOIN sources s ON s.id = p.source_id
    WHERE p.article_id = ${a} AND p.visibility = 'public'`;
  if (!r) return reply.code(404).type("text/html").send(page("没找到", "<p>这条内容不存在或已下线。</p>"));
  const prompt = [
    `帮我深挖这条 SaaS 动态：「${r.title}」（${publicSourceName(r.source_name)}，原文 ${r.url}）。`,
    r.summary ? `站内摘要：${r.summary}` : null,
    "我在做订阅制出海工具。请帮我判断：",
    "1. 这件事背后是什么需求或趋势，值不值得跟进；",
    "2. 对我（需求发掘/定价/获客/留存）有什么可借鉴或可警惕的；",
    "3. 如果值得研究，给出下一步调研的具体问题和要查的资料。",
  ].filter(Boolean).join("\n");
  return reply.type("text/html").send(page(
    `深挖：${r.title}`,
    `<h1>${esc(r.title)}</h1>
     ${r.summary ? marked.parse(r.summary) : ""}
     <p>来源：${esc(publicSourceName(r.source_name))} · <a href="${esc(r.url)}">原文</a> · <a href="${itemUrl(a)}">站内页</a></p>
     <h2>把这段发给你的 Agent</h2>
     <pre>${esc(prompt)}</pre>
     <p>复制上面这段，发给 Devin、Claude 或任何一个能联网的 Agent，让它替你去调研。</p>`,
  ));
}

export function registerMeRoutes(app: FastifyInstance) {
  app.get("/me/feedback", feedback);
  app.get("/me/dive", dive);
}
