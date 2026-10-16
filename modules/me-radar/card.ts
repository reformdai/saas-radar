// The personal push card: unlike the selected card it leads with "为什么和你有关" — the judgement the
// reader would otherwise have to make himself. Buttons: read on-site, the original, useful/useless
// feedback and the dive page (all plain URLs; a custom-bot webhook gets no callbacks).
import { itemUrl, siteUrl } from "@aihot/backend/publication/links";
import { SITE } from "@aihot/site";

export interface MeItem {
  article_id: string;
  title: string;
  summary: string | null;
  reason: string | null;
  url: string;
  source_name: string;
  score: number;
  why: string;
}

export function personalCard(it: MeItem) {
  const lines = [
    `**为什么和你有关**：${it.why}`,
    it.summary,
    it.reason ? `推荐理由：${it.reason}` : null,
    `来源：${it.source_name} · 相关度 ${it.score}`,
  ].filter(Boolean);
  return {
    header: { title: { tag: "plain_text", content: `【荐】${it.title}` }, template: "turquoise" },
    elements: [
      { tag: "div", text: { tag: "lark_md", content: lines.join("\n\n") } },
      {
        tag: "action",
        actions: [
          { tag: "button", text: { tag: "plain_text", content: `${SITE.name} 查看` }, url: itemUrl(it.article_id), type: "primary" },
          { tag: "button", text: { tag: "plain_text", content: "原文" }, url: it.url, type: "default" },
        ],
      },
      {
        tag: "action",
        actions: [
          { tag: "button", text: { tag: "plain_text", content: "有用" }, url: siteUrl(`/me/feedback?a=${it.article_id}&v=useful`), type: "default" },
          { tag: "button", text: { tag: "plain_text", content: "没用" }, url: siteUrl(`/me/feedback?a=${it.article_id}&v=useless`), type: "default" },
          { tag: "button", text: { tag: "plain_text", content: "深挖" }, url: siteUrl(`/me/dive?a=${it.article_id}`), type: "default" },
        ],
      },
    ],
  };
}

export function digestCard(items: MeItem[], day: string) {
  const list = items
    .map((it, i) => `${i + 1}. [${it.title}](${itemUrl(it.article_id)})\n   ${it.why} · ${it.source_name} · ${it.score} 分`)
    .join("\n");
  return {
    header: { title: { tag: "plain_text", content: `${day} · 今天还有 ${items.length} 条和你沾边` }, template: "turquoise" },
    elements: [
      { tag: "div", text: { tag: "lark_md", content: list } },
      { tag: "note", elements: [{ tag: "plain_text", content: "不值得单独打扰的，攒在一起发；点开有需要的再看。" }] },
    ],
  };
}
