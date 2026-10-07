import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeMpBody } from "../packages/backend/src/content/mp-body.ts";
import { sanitizeBody } from "../packages/backend/src/content/sanitize.ts";

test("account body restores escaped and real paragraph breaks, including stored HTML", () => {
  assert.equal(normalizeMpBody("第一段\\n\\n第二段"), "第一段<br><br>第二段");
  assert.equal(normalizeMpBody("<p>第一段\\n\\n第二段</p>"), "<p>第一段<br><br>第二段</p>");
  assert.equal(normalizeMpBody("第一段\n\n第二段"), "第一段<br><br>第二段");
  const html = sanitizeBody(normalizeMpBody("第一段\\n\\n第二段"));
  assert.equal(normalizeMpBody(html), html);
});

test("account body preserves markup, URL attributes, code, and escaped HTML", () => {
  const html = '<p>正文</p><img src="https://example.com/\\name"><pre>const s = "\\n";</pre>';
  assert.equal(normalizeMpBody(html), html);
  assert.equal(normalizeMpBody("&lt;script&gt;\\n正文"), "&lt;script&gt;<br>正文");
});
