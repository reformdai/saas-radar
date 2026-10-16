// Dai's personal layer on top of the industry pipeline: score everything eligible against his own
// profile, push only what passes. See prompts/profile.md — his know-how, changed only with his sign-off.
import { defineServerModule } from "@aihot/backend/modules";
import { registerMeRoutes } from "./http.ts";
import { meScoreQueue, scanPending, sendDailyDigest } from "./score.ts";

export default defineServerModule({
  name: "me-radar",
  models: {
    meRelevance: {
      label: "个人相关性评分（这条动态对 Dai 有没有用，并写一句为什么）",
      env: "ME_RADAR_MODEL",
      purposes: ["me_relevance"],
    },
  },
  queues: [meScoreQueue],
  schedules: [
    { name: "me-radar.scan", cron: "*/5 * * * *", run: scanPending },
    { name: "me-radar.digest", cron: "5 21 * * *", missed: "once", run: sendDailyDigest },
  ],
  http: registerMeRoutes,
});
