import { useEffect, useState } from "react";
import { Link } from "react-router";
import type { MpArchiveState } from "@aihot/contracts/mp";
import { useAdminAction } from "./action";
import { Button, Card, Input } from "./ui";
const STATUS = { queued: "排队中", running: "执行中", paused: "已暂停，可继续", completed: "本阶段完成", error: "执行失败" };
const LIST_PRICE = { dajiala: 0.14, everyinfra: 0.04 };
export function MpArchive({ sourceId, listProvider }: { sourceId: string; listProvider: "dajiala" | "everyinfra" }) {
  const [state, setState] = useState<MpArchiveState | null>(null);
  const [maxRequests, setMax] = useState(5);
  const [confirm, setConfirm] = useState<"list" | "bodies" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { run, pending } = useAdminAction();
  const path = `/api/admin/sources/${encodeURIComponent(sourceId)}/archive`;
  const listDone = !!state?.listComplete && (state.listProvider ?? "dajiala") === listProvider;
  const active = state?.status === "queued" || state?.status === "running" || Date.parse(state?.workingUntil ?? "") > Date.now();
  useEffect(() => {
    const abort = new AbortController();
    const read = async () => {
      try {
        const r = await fetch(path, { signal: abort.signal });
        if (!r.ok) throw new Error("无法读取归档进度");
        const j = await r.json() as { state: MpArchiveState | null }; setState(j.state); setError(null);
      } catch (e) { if (!abort.signal.aborted) setError((e as Error).message); }
    };
    void read(); const timer = active ? setInterval(() => void read(), 3000) : null;
    return () => { abort.abort(); if (timer) clearInterval(timer); };
  }, [path, active]);
  const act = async (action: "list" | "bodies" | "pause") => {
    const result = await run<MpArchiveState>("POST", path, { action, maxRequests }, { revalidate: false });
    if (result) setState(result); setConfirm(null);
  };
  return <Card title="历史文章归档" right={<Link to={`/mp?source=${encodeURIComponent(sourceId)}`} className="text-accent">打开公众号资料库 ↗</Link>}>
    <p className="text-[13px] leading-6 text-ink-3">手动归档历史列表，再按已保存链接补全文。历史列表跟随本信源的列表服务商：极致了按页付费、可翻到最早；万有引擎一次获取最近一两百篇、不能更早。全文直接读取文章页（免费）；不会自动分析或推送这些旧文章。</p>
    <div className="my-4 flex items-center gap-3 text-[13px]"><label htmlFor="archive-limit">本批最多请求</label><Input id="archive-limit" type="number" min={1} max={20} value={maxRequests} onChange={e => setMax(Number(e.target.value))} className="!w-20" /><span className="text-ink-4">达到上限自动暂停</span></div>
    <div className="flex flex-wrap gap-2"><Button disabled={active || listDone} onClick={() => setConfirm("list")}>{state?.pages ? "继续历史列表" : "获取历史列表"}</Button><Button disabled={active} onClick={() => setConfirm("bodies")}>获取缺失全文</Button>{active && <Button busy={!!pending} onClick={() => void act("pause")}>暂停归档</Button>}</div>
    {confirm && <div className="mt-4 rounded-control border border-line p-4 text-[13px] leading-6"><p>本批最多 {maxRequests} 次{confirm !== "list" ? "正文请求，读取文章页不计费" : listProvider === "everyinfra" ? "列表请求；万有引擎只需 1 次，约 ¥0.04，最长等待约4分钟" : `列表请求，按当前单价约 ¥${(maxRequests * LIST_PRICE.dajiala).toFixed(2)}`}。不调用分析模型。暂停时已发出的请求会完成并保存结果。</p><div className="mt-3 flex gap-2"><Button tone="primary" busy={!!pending} onClick={() => void act(confirm)}>确认并开始</Button><Button onClick={() => setConfirm(null)}>取消</Button></div></div>}
    {state && <div className="mt-4 text-[13px] leading-7"><p>{STATUS[state.status]} · {state.mode === "list" ? "列表归档" : "补齐全文"}</p><p>已保存 {state.stored} 篇新条目 · 列表 {state.pages} 页 · 已补全文 {state.bodies} 篇 · 空正文 {state.failed} 篇</p><p className="text-ink-4">列表累计估算 ¥{(state.pages * LIST_PRICE[state.listProvider ?? "dajiala"]).toFixed(2)}；实际费用以后台回执为准。</p>{state.error && <p className="text-hot">{state.error}</p>}</div>}
    {error && <p className="mt-3 text-[13px] text-hot">{error}</p>}
  </Card>;
}
