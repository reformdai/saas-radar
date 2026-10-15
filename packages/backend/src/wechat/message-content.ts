import { XMLParser, XMLValidator } from "fast-xml-parser";

const parser = new XMLParser({ parseTagValue: false, ignoreAttributes: true });
const text = (value: unknown): string => typeof value === "string" ? value.trim() : "";

/** Older imports contain flattened replies with an XML card embedded in the quote. */
export function readableWechatContent(content: string, depth = 0): string {
  const start = content.indexOf("<msg");
  if (start < 0 || !/<(?:appmsg|img|voicemsg|videomsg|emoji|location)\b/.test(content.slice(start))) return content;
  const prefix = content.slice(0, start).replace(/<\?xml[\s\S]*?\?>\s*$/, "");
  if (depth >= 8) return prefix + "[引用层级过深]";
  const xml = content.slice(start);
  if (/<!DOCTYPE|<!ENTITY/i.test(xml) || XMLValidator.validate(xml) !== true) return prefix + "[引用内容暂不可解析]";
  try {
    const root = parser.parse(xml)?.msg;
    if (!root || typeof root !== "object") return content;
    for (const [tag, label] of [["img", "图片"], ["voicemsg", "语音"], ["videomsg", "视频"], ["emoji", "表情"], ["location", "位置"]] as const) {
      if (Object.hasOwn(root, tag)) return prefix + `[${label}]`;
    }
    const card = root.appmsg;
    if (!card || typeof card !== "object") return content;
    const parts = [card.title, card.des, card.url].map(text).filter(Boolean).map(value => readableWechatContent(value, depth + 1));
    const quote = card.refermsg;
    if (quote && typeof quote === "object" && text(quote.content)) {
      const author = text(quote.displayname);
      parts.push(`[引用] ${author ? author + ": " : ""}${readableWechatContent(text(quote.content), depth + 1)}`);
    }
    return prefix + (parts.join("\n") || "[卡片无文字]");
  } catch {
    return prefix + "[引用内容暂不可解析]";
  }
}
