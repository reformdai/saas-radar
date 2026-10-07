import assert from "node:assert/strict";
import { test } from "node:test";
import { parseWechatPage } from "../packages/backend/src/providers/wechat-page.ts";
import { sanitizeBody } from "../packages/backend/src/content/sanitize.ts";
import { normalizeMpBody } from "../packages/backend/src/content/mp-body.ts";

const page = (body: string) => `<html><head><meta property="og:title" content="标题">
<meta name="author" content="作者"><meta property="og:description" content="摘要"></head>
<body><h1 id="activity-name">标题</h1>${body}<script>var ct = "1780020151";</script></body></html>`;

test("an article page yields its body, metadata and lazily loaded images", () => {
  const p = parseWechatPage(page(`<div id="js_content" style="visibility: hidden;"><section><p>第一段</p><div><p>第二段</p></div>
    <p><img data-src="https://mmbiz.qpic.cn/a/640?wx_fmt=png" src=""></p></section></div><div id="after">页脚</div>`));
  assert.deepEqual([p.title, p.author, p.desc, p.publishedAt], ["标题", "作者", "摘要", 1780020151]);
  assert.doesNotMatch(p.content, /页脚/, "nested divs do not end the body early, and nothing after it is taken");
  const html = sanitizeBody(normalizeMpBody(p.content), "https://mp.weixin.qq.com/s/x");
  assert.match(html, /第一段[\s\S]*第二段/);
  assert.match(html, /<img src="https:\/\/mmbiz\.qpic\.cn\/a\/640\?wx_fmt=png"/);
});

test("a verification page is a passing failure, never an empty body", () => {
  assert.throws(() => parseWechatPage("<html><body>当前环境异常，完成验证后即可继续访问。</body></html>"), /verification/);
  assert.throws(() => parseWechatPage("<html></html>", "https://mp.weixin.qq.com/mp/wappoc_appmsgcaptcha?x=1"), /verification/);
  // Seen while archiving 200 articles quickly: the same links read fine minutes later.
  assert.throws(() => parseWechatPage(`<html><head><title>未知错误</title></head><body><p>未知错误，请稍后再试</p>
    <script>var title = '失效的验证页面'</script></body></html>`), /verification/);
  assert.match(parseWechatPage(page(`<div id="js_content"><p>服务器环境异常怎么办</p></div>`)).content, /环境异常/, "an article may mention the words");
});

test("a deleted or invalid article returns an empty body", () => {
  const p = parseWechatPage(`<html><body><div class="weui-msg"><div class="weui-msg__title warn">参数错误</div></div></body></html>`);
  assert.deepEqual(p, { title: "", content: "", author: null, desc: null, publishedAt: null, sharedFrom: null });
});

test("a repost points to its original, whose body it takes", () => {
  const p = parseWechatPage(page(`<div id="js_content"></div><div id="js_share_content"><span id="js_share_source" class="weui-link"
    data-url="http://mp.weixin.qq.com/s?__biz=MzkyNDEzOTAzNg%3D%3D&amp;mid=2247487772&amp;idx=1&amp;sn=5cc9&amp;scene=45#wechat_redirect">阅读全文</span></div>`));
  assert.equal(p.content, "");
  assert.equal(p.sharedFrom, "http://mp.weixin.qq.com/s?__biz=MzkyNDEzOTAzNg%3D%3D&mid=2247487772&idx=1&sn=5cc9&scene=45#wechat_redirect");
  assert.equal(parseWechatPage(page(`<div id="js_content"><p>正文</p></div><span id="js_share_source" data-url="x"></span>`)).sharedFrom, null);
});
