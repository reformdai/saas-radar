import assert from "node:assert/strict";
import { test } from "node:test";
import { readableWechatContent } from "../packages/backend/src/wechat/message-content.ts";

const card = '<msg><appmsg appid="" sdkver="0"><title>原来的讨论 &amp; 补充</title><type>57</type><refermsg></refermsg><appattach><aeskey>synthetic-private-field</aeskey></appattach></appmsg><fromusername>synthetic-id</fromusername></msg>';

test("existing flattened replies keep the reply and author while decoding quoted XML", () => {
  for (const declaration of ["", '<?xml version="1.0"?>\n']) {
    const result = readableWechatContent(`我的回复\n[引用] 合成群友: ${declaration}${card}`);
    assert.equal(result, "我的回复\n[引用] 合成群友: 原来的讨论 & 补充");
    assert.doesNotMatch(result, /appmsg|aeskey|synthetic-id|synthetic-private-field/);
  }
});

test("nested reference cards preserve each readable quote and links", () => {
  const outer = `<msg><appmsg><title>当前回复</title><refermsg><displayname>甲</displayname><content><![CDATA[${card}]]></content></refermsg></appmsg></msg>`;
  assert.equal(readableWechatContent(outer), "当前回复\n[引用] 甲: 原来的讨论 & 补充");
  assert.equal(readableWechatContent('<msg><appmsg><title>链接标题</title><url>https://example.com/?a=1&amp;b=2</url></appmsg></msg>'), "链接标题\nhttps://example.com/?a=1&b=2");
  assert.equal(readableWechatContent("普通文字 <script>不执行</script>"), "普通文字 <script>不执行</script>");
  assert.equal(readableWechatContent('[引用] 甲: <msg><img aeskey="synthetic-private-key" /></msg>'), "[引用] 甲: [图片]");
});

test("malformed cards and recursion bounds never expose internal XML", () => {
  assert.equal(readableWechatContent("[引用] 甲: <msg><appmsg><title>断开的引用"), "[引用] 甲: [引用内容暂不可解析]");
  assert.equal(readableWechatContent('<msg><appmsg><title>x</title></appmsg></msg>', 8), "[引用层级过深]");
});
