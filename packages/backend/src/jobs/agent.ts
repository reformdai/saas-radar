import type { PgBoss } from "pg-boss";
import { runAgentTurn } from "../agent/index.ts";
import { QUEUES, work } from "./queue.ts";
export async function registerAgentJobs(boss: PgBoss) {
  await work(boss, QUEUES.agent, { localConcurrency: 2, pollingIntervalSeconds: 1 }, async data => runAgentTurn(data.id));
}
