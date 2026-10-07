import { Field, Select } from "./ui";

/** The JSON remains the single source of truth, including edits made in the text area. */
export function MpListProvider({ config, onChange }: { config: string; onChange: (config: string) => void }) {
  let parsed: Record<string, unknown> | null = null;
  try {
    const value: unknown = JSON.parse(config);
    if (value && typeof value === "object" && !Array.isArray(value)) parsed = value as Record<string, unknown>;
  } catch { /* The configuration editor displays its validation error on save. */ }
  return (
    <Field label="公众号列表服务商" hint="只选择列表来源；正文直接读取公开文章页，不计费。EveryInfra（万有引擎）约 ¥0.04 一次，一次给最近一两百篇、不能翻页；极致了约 ¥0.14 一页，可翻到最早。">
      <Select disabled={!parsed} value={String(parsed?.listProvider ?? "dajiala")} onChange={(e) => {
        if (parsed) onChange(JSON.stringify({ ...parsed, listProvider: e.target.value }, null, 2));
      }}>
        <option value="dajiala">极致了（Dajiala）</option>
        <option value="everyinfra">EveryInfra（万有引擎）</option>
      </Select>
    </Field>
  );
}
