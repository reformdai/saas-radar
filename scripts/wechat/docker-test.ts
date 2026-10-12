// Explicit, isolated Docker integration check. No real chats/config, database or model.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const root = fileURLToPath(new URL("../../", import.meta.url));
const fixture = join(mkdtempSync(join(tmpdir(), "wechat-docker-test-")), "fixture");
await run("python3", ["-B", fileURLToPath(new URL("./docker-fixture.py", import.meta.url)), fixture], { timeout: 15000 });
const hashes = () => readdirSync(join(fixture, "db"), { recursive: true, withFileTypes: true }).filter(e => e.isFile()).map(e => {
  const path = join(e.parentPath, e.name);
  return [path, createHash("sha256").update(readFileSync(path)).digest("hex")];
});
const before = hashes();
const events: Array<{ group_id: string; message_id: string; content: string }> = [];
let checkpoints = 0;
const token = "synthetic-docker-collector-token";
const server = createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  res.setHeader("content-type", "application/json");
  if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401); res.end("{}"); return; }
  if (req.url?.startsWith("/api/ingest/wechat/status?")) { res.end('{"groups":[]}'); return; }
  if (req.url !== "/api/ingest/wechat" || req.method !== "POST") { res.writeHead(404); res.end("{}"); return; }
  const body = JSON.parse(Buffer.concat(chunks).toString());
  events.push(...(body.events ?? []));
  if (body.checkpoints) checkpoints += 1;
  res.end(JSON.stringify({ ok: true, accepted: body.events?.length ?? 0 }));
});
server.listen(0, "127.0.0.1"); await once(server, "listening");
const project = `wechat-docker-test-${process.pid}-${randomUUID().slice(0, 8)}`;
const environment = { ...process.env, WECHAT_DB_DIR: join(fixture, "db"), WECHAT_KEY_FILE: join(fixture, "keys.json"),
  WECHAT_COLLECTOR_UID: String(process.getuid!()), WECHAT_COLLECTOR_GID: String(process.getgid!()),
  COLLECT_ENABLED: "true", WECHAT_LOCAL_ENABLED: "true", MODEL_CALLS_ENABLED: "false", INGEST_TOKEN: token,
  SHIPRADAR_INGEST_URL: `http://host.docker.internal:${(server.address() as AddressInfo).port}`,
  WECHAT_GROUPS: "1@chatroom", WECHAT_ACCOUNT: "synthetic-docker", WECHAT_SINCE: "1970-01-01T00:00:01Z", WECHAT_INTERVAL: "60" };
// Never load the project's real .env into this check.
const compose = ["compose", "--env-file", "/dev/null", "-p", project, "-f", join(root, "compose.wechat.yml")];
const command = async (args: string[]) => run("docker", [...compose, ...args], { cwd: root, env: environment, timeout: 60000, maxBuffer: 2 * 1024 * 1024 });
let continuous: ReturnType<typeof spawn> | undefined;
let service: string | undefined;
const crashName = `${project}-crash`;
try {
  await command(["config", "--quiet"]);
  console.log("✓ Compose validates with isolated synthetic configuration");
  await command(["run", "--no-deps", "--name", `${project}-first`, "collector", "--once"]);
  assert.equal(events.length, 2);
  assert.ok(events.every(e => e.group_id === "1@chatroom" && e.content === "容器压缩合成消息"));
  assert.equal(events[0].message_id, "9007199254740993");
  console.log("✓ Linux SQLCipher reads Mac encrypted DB/WAL, decompresses zstd and uploads only the chosen group");
  await command(["run", "--no-deps", "--name", `${project}-second`, "collector", "--once"]);
  assert.equal(events.length, 2, "recreated container must reuse its saved state");
  console.log("✓ Recreating the container preserves state and uploads no duplicate messages");
  await command(["run", "--no-deps", "--name", `${project}-readonly`, "--entrypoint", "python3", "collector", "-B", "-c", `
import errno
try:
    open('/wechat/db/__write_probe__', 'wb')
except OSError as e:
    assert e.errno == errno.EROFS
else:
    raise AssertionError('source mount is writable')
`]);
  assert.deepEqual(hashes(), before);
  console.log("✓ Source bind mount rejects writes; encrypted source files remain unchanged");
  continuous = spawn("docker", [...compose, "run", "--no-deps", "--name", crashName, "collector"], { cwd: root, env: environment, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  continuous.stdout!.on("data", data => { output += String(data); });
  continuous.stderr!.on("data", data => { output += String(data); });
  for (let i = 0; i < 150 && !output.includes('"checkedAt"'); i++) {
    if (continuous.exitCode !== null) throw new Error("Synthetic continuous collector exited early");
    await delay(100);
  }
  assert.match(output, /"checkedAt"/, "continuous collector did not finish its first round");
  const exited = once(continuous, "exit");
  await run("docker", ["kill", "--signal", "KILL", crashName]);
  await exited;
  await command(["run", "--no-deps", "--name", `${project}-after-crash`, "collector", "--once"]);
  assert.equal(events.length, 2);
  console.log("✓ A forced container kill leaves no blocking lock; the next collector continues without duplicates");
  const initialChecks = checkpoints;
  await command(["up", "-d", "--no-build", "collector"]);
  service = (await command(["ps", "-q", "collector"])).stdout.trim();
  assert.ok(service);
  for (let i = 0; i < 100 && checkpoints === initialChecks; i++) await delay(100);
  assert.ok(checkpoints > initialChecks, "Compose service did not complete its initial collection");
  // Docker only monitors successfully started containers after 10 seconds.
  // Killing via the Docker API is an explicit stop, so simulate a process crash
  // inside the synthetic container instead of asking Docker to stop the service.
  await delay(10000);
  const beforeKill = checkpoints;
  await run("docker", ["exec", service, "node", "--input-type=module", "-e", `
import { readFileSync } from 'node:fs';
const children = readFileSync('/proc/1/task/1/children', 'utf8').trim().split(/\\s+/);
const main = children.find(pid => readFileSync('/proc/' + pid + '/cmdline', 'utf8').includes('scripts/wechat/docker-entrypoint.ts'));
if (!main) throw new Error('synthetic collector process not found');
process.kill(Number(main), 'SIGKILL');
`]);
  for (let i = 0; i < 150 && checkpoints === beforeKill; i++) await delay(100);
  const inspect = (await run("docker", ["inspect", "--format", "{{.RestartCount}} {{.State.Status}}", service])).stdout.trim();
  assert.match(inspect, /^[1-9]\d* running$/);
  assert.ok(checkpoints > beforeKill, "Docker did not resume collection automatically");
  assert.equal(events.length, 2);
  assert.deepEqual(hashes(), before);
  console.log("✓ Compose restart policy automatically recovers a crashed process and preserves deduplication");
  console.log("Docker checks passed; removing this check's isolated Docker resources.");
} finally {
  if (service) await run("docker", ["stop", service]).catch(() => {});
  if (continuous && continuous.exitCode === null) {
    const exited = once(continuous, "exit");
    await run("docker", ["stop", crashName]).catch(() => {});
    await exited;
  }
  // Only the unique project created by this invocation is removed. Source
  // fixtures are bind mounts; no host directories or other projects are deleted.
  await command(["down", "--volumes", "--remove-orphans"]).catch(() => {
    console.error(`测试 Docker 资源自动清理失败，保留项目供检查：${project}`);
    process.exitCode = 1;
  });
  server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
}
