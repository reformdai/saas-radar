import * as cheerio from "cheerio";
import { textToHtml } from "./sanitize.ts";

/** Mode-1 account bodies sometimes contain literal newline escapes instead of line breaks. */
export function normalizeMpBody(html: string): string {
  const $ = cheerio.load(html, null, false);
  const roots = $.root().contents().toArray();
  const visit = (nodes: typeof roots) => {
    for (const node of nodes) {
      if (node.type === "tag" && (node.name === "pre" || node.name === "code")) continue;
      if (node.type === "text" && /\\r\\n|\\n|\r?\n/.test(node.data)) {
        const text = node.data.replace(/\\r\\n|\\n/g, "\n").replace(/\r\n/g, "\n");
        // Convert text only: never interpret escaped content as HTML or alter URL attributes.
        const encoded = textToHtml(text).replace(/^<p>|<\/p>$/g, "").replace(/<\/p><p>/g, "<br><br>");
        $(node).replaceWith(encoded);
      } else if ("children" in node) visit(node.children);
    }
  };
  visit(roots);
  return $.html();
}
