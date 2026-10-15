// Runs a proposal the administrator confirmed on the agent's card, through the same functions as the
// back office pages, with the arguments and versions the card showed.
import type { AgentConversation } from "@aihot/contracts/agent";
import { finishAgentProposal, takeAgentProposal } from "../agent/index.ts";
import { archiveAction } from "../sources/mp-archive.ts";
import { mergeStories } from "../events/corrections.ts";
import { createSource, fetchNow, updateSource } from "./sources.ts";
import { rerun, setVisibility } from "./content.ts";

type Run = (args: Record<string, unknown>, actor: string, proposalId: string) => Promise<string>;
const RUN: Record<string, Run> = {
  async create_source(args, actor) {
    const r = await createSource(args, actor);
    if (!r.created) throw new Error(`与已有信源重复：${r.duplicate.name}（${r.duplicate.id}）`);
    return `已新建信源 ${r.source.id}`;
  },
  async update_source(args, actor) {
    const r = await updateSource(String(args.id), { patch: args.patch, version: String(args.version), reason: args.reason ? String(args.reason) : "经后台智能体确认" }, actor);
    if (!r) throw new Error("信源不存在");
    return `已修改信源 ${String(args.id)}`;
  },
  async fetch_now(args, actor) {
    const r = await fetchNow(String(args.id), actor);
    if (!r) throw new Error("信源不存在");
    return `已加入采集队列（任务 ${r.jobId ?? "已在排队"}）`;
  },
  async archive(args, actor) {
    const r = await archiveAction(String(args.sourceId), { action: args.action as "list" | "bodies" | "pause", maxRequests: Number(args.maxRequests) }, actor);
    if (!r) throw new Error("信源不存在或不是公众号");
    return args.action === "pause" ? "已暂停归档" : "归档任务已排队，进度可在信源页查看";
  },
  async set_visibility(args, actor) {
    await setVisibility(String(args.id), { visibility: args.visibility as "public", reason: String(args.reason), version: Number(args.version) }, actor);
    return `可见性已改为 ${String(args.visibility)}`;
  },
  async rerun(args, actor, proposalId) {
    const r = await rerun(String(args.id), args.step as "extract", proposalId, actor);
    if (!r) throw new Error("内容不存在");
    return `已加入队列（任务 ${r.jobId ?? "已在排队"}）`;
  },
  async merge_stories(args, actor) {
    await mergeStories(Number(args.from), Number(args.into), String(args.reason), actor);
    return `事件 #${String(args.from)} 已并入 #${String(args.into)}`;
  },
};

export async function confirmAgentProposal(id: string, proposalId: string, actor: string): Promise<AgentConversation> {
  const proposal = await takeAgentProposal(id, proposalId, actor);
  let outcome: "done" | "failed" = "done", detail: string;
  try {
    const run = RUN[proposal.tool];
    if (!run) throw new Error(`未知操作 ${proposal.tool}`);
    detail = await run(proposal.args, actor, proposal.id);
  } catch (error) {
    // A stale version, a duplicate or a refused action is told to the administrator, never retried.
    outcome = "failed"; detail = error instanceof Error ? error.message.slice(0, 400) : "执行失败";
  }
  return finishAgentProposal(id, actor, proposal, outcome, detail);
}
