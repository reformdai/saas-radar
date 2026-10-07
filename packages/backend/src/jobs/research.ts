import type { PgBoss } from "pg-boss";
import { answerResearch } from "../research.ts";
import { QUEUES, work } from "./queue.ts";
export async function registerResearchJobs(boss: PgBoss) {
  await work(boss, QUEUES.research, { localConcurrency: 1, pollingIntervalSeconds: 2 }, async data => answerResearch(data.id));
}
