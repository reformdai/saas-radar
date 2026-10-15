// Compose mounts only one account and one key-map. Environment values become
// argv elements, never shell code; secrets remain environment-only.
export {};
const options = process.argv.slice(2);
const groups = (process.env.WECHAT_GROUPS || "").split(",").map(s => s.trim()).filter(Boolean);
const args = ["--db-dir", "/wechat/db", "--key-file", "/wechat/keys.json", "--state", options.includes("--history") ? "/state/private/history-state.json" : "/state/private/collector-state.json",
  "--account", process.env.WECHAT_ACCOUNT || "main", "--interval", process.env.WECHAT_INTERVAL || "600", "--managed",
  ...groups.flatMap(group => ["--group", group])];
if (process.env.WECHAT_SINCE) args.push("--since", process.env.WECHAT_SINCE);
process.argv.splice(2, process.argv.length, ...args, ...options);
await import("../wechat-collect.ts");
