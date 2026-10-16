// The module's prompts live beside it (prompts/*.md), not in the industry pack: profile.md is Dai's own
// know-how, changed only with his sign-off. Same two template forms as the pack: {{name}} values and
// {{> file}} includes inside this folder.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "@aihot/backend/config";
import { SITE } from "@aihot/site";

const DIR = path.join(REPO_ROOT, "modules/me-radar/prompts");
const TOKEN = /\{\{(>\s*)?([A-Za-z][\w.-]*)\s*\}\}/g;

const files = new Map<string, string>();

function raw(name: string): string {
  let text = files.get(name);
  if (text === undefined) {
    text = readFileSync(path.join(DIR, `${name}.md`), "utf8");
    files.set(name, text);
  }
  return text;
}

function expand(name: string, seen: string[] = []): { text: string; used: string[] } {
  if (seen.includes(name)) throw new Error(`prompt include cycle: ${[...seen, name].join(" → ")}`);
  const used = [name];
  const text = raw(name).replace(TOKEN, (token, include: string | undefined, key: string) => {
    if (!include) return token;
    const inner = expand(key, [...seen, name]);
    used.push(...inner.used);
    return inner.text;
  });
  return { text, used };
}

export function mePrompt(name: string, values: Record<string, string> = {}): string {
  const all: Record<string, string> = { siteName: SITE.name, ...values };
  return expand(name).text.replace(TOKEN, (_t, _i, key: string) => {
    const value = all[key];
    if (value === undefined) throw new Error(`prompt ${name}: no value for {{${key}}}`);
    return value;
  });
}

/** `name@hash` over the files a prompt reads, so an edit shows up as a new version on receipts. */
export function mePromptVersion(...names: string[]): string {
  const used = [...new Set(names.flatMap((n) => expand(n).used))].sort();
  const hash = createHash("sha256");
  for (const n of used) hash.update(`${n}\n${raw(n)}\n`);
  return `${names.join("+")}@${hash.digest("hex").slice(0, 10)}`;
}
