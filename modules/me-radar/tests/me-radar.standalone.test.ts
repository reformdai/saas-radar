import assert from "node:assert/strict";
import { test } from "node:test";
import { personalCard, digestCard } from "../card.ts";
import { mePrompt, mePromptVersion } from "../prompts.ts";

const item = {
  article_id: "a1",
  title: "Slack 改为按用量计费",
  summary: "Slack 宣布新计费方式。",
  reason: null,
  url: "https://example.com/slack-pricing",
  source_name: "Example Blog",
  score: 86,
  why: "你上次在研究按席位转按用量的定价，这是大厂的实测案例",
};

test("the personal card leads with why-it-matters and links feedback and dive", () => {
  const card = personalCard(item);
  assert.equal(card.header.title.content, "【荐】Slack 改为按用量计费");
  const body = (card.elements[0] as { text: { content: string } }).text.content;
  assert.ok(body.startsWith("**为什么和你有关**"), "the card opens with the relevance reason, not the summary");
  assert.ok(body.includes(item.why));
  const urls = card.elements.flatMap((e) => ("actions" in e ? e.actions.map((a) => a.url) : []));
  assert.ok(urls.some((u) => u === item.url), "links the original");
  assert.ok(urls.some((u) => u.includes("/me/feedback?a=a1&v=useful")));
  assert.ok(urls.some((u) => u.includes("/me/feedback?a=a1&v=useless")));
  assert.ok(urls.some((u) => u.includes("/me/dive?a=a1")));
});

test("the digest card is one card listing each item with its reason", () => {
  const card = digestCard([item], "2026-10-16");
  const body = (card.elements[0] as { text: { content: string } }).text.content;
  assert.ok(body.includes(item.title));
  assert.ok(body.includes(item.why));
});

test("the relevance prompt includes the profile inline and fills the site name", () => {
  const prompt = mePrompt("relevance");
  assert.ok(prompt.includes("Dai"), "profile.md is pulled in");
  assert.ok(prompt.includes("SaaS Radar"), "{{siteName}} is filled");
  assert.ok(!/\{\{[^}]+\}\}/.test(prompt), "no placeholder is left");
});

test("the prompt version changes when a prompt file does", () => {
  assert.match(mePromptVersion("relevance"), /^relevance@[0-9a-f]{10}$/);
});
