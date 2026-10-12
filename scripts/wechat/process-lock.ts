import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

export async function acquireCollectorLock(path: string, signal: AbortSignal, onLost = () => {}): Promise<() => Promise<void>> {
  const child = spawn(process.env.WECHAT_PYTHON || "python3", ["-B", fileURLToPath(new URL("./lock.py", import.meta.url)), path],
    { stdio: ["pipe", "pipe", "pipe"], env: { PATH: process.env.PATH, PYTHONUTF8: "1" } });
  const exited = once(child, "exit").catch(() => undefined);
  let releasing = false;
  let acquired = false;
  child.on("exit", () => { if (acquired && !releasing && !signal.aborted) onLost(); });
  child.stdin.on("error", () => {});
  const abort = () => { child.stdin.end(); };
  signal.addEventListener("abort", abort, { once: true });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { reject(new Error("采集状态锁获取超时")); child.kill(); }, 5000);
      let output = "";
      const done = (error?: Error) => { clearTimeout(timer); error ? reject(error) : resolve(); };
      child.stdout.on("data", data => { output += String(data); if (output === "locked\n") { acquired = true; done(); } });
      child.on("error", () => done(new Error("无法启动采集状态锁，需要 Python 3")));
      child.on("exit", code => { if (code !== 0 || output !== "locked\n") done(new Error("已有采集器使用同一状态文件，或状态锁不可访问")); });
      if (signal.aborted) { abort(); done(new Error("采集已停止")); }
    });
  } catch (error) {
    releasing = true;
    signal.removeEventListener("abort", abort);
    child.stdin.end();
    await exited;
    throw error;
  }
  return async () => {
    releasing = true;
    signal.removeEventListener("abort", abort);
    child.stdin.end();
    await exited;
  };
}
