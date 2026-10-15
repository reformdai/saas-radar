import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { AnimatePresence, motion } from "motion/react";
import type { Route } from "./+types/agent";
import type { AgentConversation, AgentConversationSummary, AgentMessage, AgentProposal } from "@aihot/contracts/agent";
import { adminGet } from "../../lib/admin.server";
import { useAdminAction } from "../../features/admin/action";
import { AdminPage, Button } from "../../features/admin/ui";

export async function loader({ request }: Route.LoaderArgs) {
  const id = new URL(request.url).searchParams.get("id");
  const [history, conversation] = await Promise.all([
    adminGet<AgentConversationSummary[]>(request, "/api/admin/agent"),
    id ? adminGet<AgentConversation>(request, `/api/admin/agent/${encodeURIComponent(id)}`).catch(() => null) : Promise.resolve(null),
  ]);
  return { history, conversation };
}

type Status = AgentConversation["status"];
const MOOD: Record<Status, { face: string; label: string }> = {
  idle: { face: "(￣▽￣)", label: "在线摸鱼中" },
  thinking: { face: "(・_・ヾ", label: "翻资料中" },
  awaiting: { face: "(ง •̀_•́)ง", label: "等你拍板" },
  error: { face: "(╯°□°)╯", label: "翻车了" },
};
const BUSY_LINES = ["翻账本中…", "跟服务商掰扯中…", "假装很忙中…", "认真干活中（真的）…", "对着数据皱眉中…"];
const STARTERS = ["哪些信源最近在报错？", "最近 7 天花了多少钱？", "公众号的历史归档都到哪一步了？", "运行有没有卡住的任务？"];

function Face({ status, size = "md" }: { status: Status; size?: "sm" | "md" | "lg" }) {
  const box = { sm: "h-7 min-w-7 px-1.5 text-[10.5px]", md: "h-10 min-w-12 px-2.5 text-[12.5px]", lg: "h-16 min-w-16 px-3 text-[17px]" }[size];
  const tone = status === "error" ? "bg-hot-soft text-hot" : status === "awaiting" ? "bg-amber-soft text-amber-ink" : "bg-accent-soft text-accent-ink";
  return (
    <motion.span key={status} initial={{ scale: 0.8, rotate: -6 }} animate={{ scale: 1, rotate: 0 }} transition={{ type: "spring", stiffness: 420, damping: 18 }}
      className={`inline-flex shrink-0 select-none items-center justify-center whitespace-nowrap rounded-full font-medium ${box} ${tone}`} aria-hidden>
      {MOOD[status].face}
    </motion.span>
  );
}

function BusyLine() {
  const [i, setI] = useState(0);
  useEffect(() => { const t = setInterval(() => setI((n) => (n + 1) % BUSY_LINES.length), 1800); return () => clearInterval(t); }, []);
  return (
    <div className="flex items-center gap-2.5" role="status">
      <Face status="thinking" size="sm" />
      <span className="flex items-center gap-1 rounded-card rounded-tl-mark bg-bg-sunk px-3.5 py-2.5 text-[13.5px] text-ink-3">
        {BUSY_LINES[i]}
        <span className="ml-1 inline-flex gap-0.5">{[0, 1, 2].map((d) => <span key={d} className="size-1 animate-bounce rounded-full bg-ink-4" style={{ animationDelay: `${d * 120}ms` }} />)}</span>
      </span>
    </div>
  );
}

function Message({ m }: { m: AgentMessage }) {
  if (m.role === "user") return <div className="flex justify-end"><p className="max-w-[78%] whitespace-pre-wrap rounded-card rounded-tr-mark bg-ink px-3.5 py-2.5 text-[14px] leading-relaxed text-bg">{m.text}</p></div>;
  if (m.role === "agent") return (
    <div className="flex items-start gap-2.5">
      <Face status="idle" size="sm" />
      <p className="max-w-[78%] whitespace-pre-wrap rounded-card rounded-tl-mark bg-bg-sunk px-3.5 py-2.5 text-[14px] leading-relaxed text-ink">{m.text}</p>
    </div>
  );
  if (m.role === "tool") return (
    <div className="pl-10 text-[12.5px]">
      <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 ring-1 ${m.ok ? "text-ink-3 ring-line" : "text-hot ring-hot/30"}`}>
        <span aria-hidden>{m.ok ? "⌕" : "!"}</span>{m.summary}
      </span>
    </div>
  );
  const tone = { done: "text-ok-ink bg-ok-soft", failed: "text-hot bg-hot-soft", cancelled: "text-ink-3 bg-bg-sunk" }[m.outcome];
  const word = { done: "已执行", failed: "没办成", cancelled: "作废" }[m.outcome];
  return (
    <div className="flex justify-center">
      <p className={`max-w-[88%] rounded-control px-3 py-1.5 text-center text-[12.5px] leading-relaxed ${tone}`}><b className="font-semibold">{word}</b> · {m.title}{m.detail ? ` — ${m.detail}` : ""}</p>
    </div>
  );
}

function ProposalCard({ p, busy, onConfirm, onCancel }: { p: AgentProposal; busy: boolean; onConfirm: () => void; onCancel: () => void }) {
  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="ml-10 max-w-[560px] rounded-card bg-surface ring-1 ring-amber/50">
      <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-2.5">
        <p className="text-[13.5px] font-semibold text-ink">要动手了：{p.title}</p>
        <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11.5px] font-medium ${p.costCny ? "bg-amber-soft text-amber-ink" : "bg-ok-soft text-ok-ink"}`}>
          {p.costCny ? <>约 <span className="num">¥{p.costCny.toFixed(2)}</span></> : "不花钱"}
        </span>
      </div>
      <ul className="space-y-1 px-4 py-3 font-mono text-[12.5px] leading-relaxed text-ink-2">{p.lines.map((l, i) => <li key={i} className="break-all">{l}</li>)}</ul>
      {p.costNote && <p className="px-4 pb-2 text-[12px] text-ink-4">{p.costNote}</p>}
      <div className="flex gap-2 border-t border-line px-4 py-3">
        <Button tone="primary" busy={busy} onClick={onConfirm}>冲！</Button>
        <Button tone="ghost" disabled={busy} onClick={onCancel}>算了</Button>
      </div>
    </motion.div>
  );
}

export default function Agent({ loaderData }: Route.ComponentProps) {
  const { history } = loaderData;
  const [c, setC] = useState<AgentConversation | null>(loaderData.conversation);
  const [text, setText] = useState("");
  const [params, setParams] = useSearchParams();
  const { run, pending } = useAdminAction();
  const end = useRef<HTMLDivElement>(null);
  const status: Status = c?.status ?? "idle";
  const thinking = status === "thinking";

  useEffect(() => { setC(loaderData.conversation); }, [loaderData.conversation?.id]);
  useEffect(() => { end.current?.scrollIntoView({ behavior: "smooth", block: "end" }); }, [c?.messages.length, status]);
  useEffect(() => {
    if (!thinking || !c) return;
    const abort = new AbortController();
    const read = async () => {
      try {
        const r = await fetch(`/api/admin/agent/${c.id}`, { signal: abort.signal });
        if (r.ok) setC(await r.json() as AgentConversation);
      } catch { /* A transient polling error does not resend the message. */ }
    };
    const timer = setInterval(() => void read(), 700);
    return () => { abort.abort(); clearInterval(timer); };
  }, [thinking, c?.id]);

  const send = async (message = text) => {
    if (!message.trim() || thinking) return;
    const next = await run<AgentConversation>("POST", "/api/admin/agent", { conversationId: c?.id ?? null, message }, { revalidate: false, label: "agent-send" });
    if (!next) return;
    setC(next); setText("");
    if (params.get("id") !== next.id) { const p = new URLSearchParams(params); p.set("id", next.id); setParams(p, { replace: true }); }
  };
  const decide = async (action: "confirm" | "cancel") => {
    if (!c?.pending) return;
    const next = await run<AgentConversation>("POST", `/api/admin/agent/${c.id}/${action}`, { proposalId: c.pending.id }, { revalidate: false, label: `agent-${action}` });
    if (next) setC(next);
  };
  const fresh = () => { setC(null); setText(""); const p = new URLSearchParams(params); p.delete("id"); setParams(p); };

  return (
    <AdminPage title="小雷" subtitle="后台的嘴替兼跑腿。查东西直接查，动手之前先给你看确认卡；每句对话都会调用 DeepSeek，费用记在回执里。">
      <div className="grid gap-5 lg:grid-cols-[232px_minmax(0,1fr)]">
        <aside className="order-2 lg:order-1">
          <Button className="mb-3 w-full" onClick={fresh}>＋ 新对话</Button>
          <p className="mb-1.5 px-1 text-[11.5px] font-medium tracking-wide text-ink-4">聊过的</p>
          {history.length === 0 ? <p className="px-1 text-[12.5px] text-ink-4">还没聊过，别害羞。</p> : (
            <ul className="space-y-0.5">{history.map((h) => (
              <li key={h.id}><Link to={`/admin/agent?id=${h.id}`} className={`block rounded-control px-2.5 py-2 text-[13px] hover:bg-bg-sunk ${h.id === c?.id ? "bg-surface ring-1 ring-line" : ""}`}>
                <span className="line-clamp-1 text-ink">{h.title}</span>
                <span className="text-[11.5px] text-ink-4">{h.turns} 句{h.status === "awaiting" ? " · 等你拍板" : h.status === "error" ? " · 翻车" : ""} · {new Date(h.updatedAt).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span>
              </Link></li>
            ))}</ul>
          )}
        </aside>

        <section className="order-1 flex min-h-[560px] flex-col rounded-panel bg-surface ring-1 ring-line lg:order-2 lg:h-[calc(100dvh-170px)]">
          <header className="flex items-center gap-3 border-b border-line px-4 py-3">
            <Face status={status} />
            <div className="min-w-0">
              <p className="text-[14.5px] font-semibold text-ink">小雷 <span className="ml-1 text-[11.5px] font-normal text-ink-4">DeepSeek 驱动</span></p>
              <p className="flex items-center gap-1.5 text-[12px] text-ink-3">
                <span className={`size-1.5 rounded-full ${status === "error" ? "bg-hot" : status === "awaiting" ? "bg-amber" : "bg-ok"} ${thinking ? "animate-pulse" : ""}`} />
                {MOOD[status].label}
              </p>
            </div>
          </header>

          <div className="flex-1 space-y-3.5 overflow-y-auto px-4 py-5" aria-live="polite">
            {!c || c.messages.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center gap-4 py-10 text-center">
                <motion.div animate={{ rotate: [0, -4, 4, 0] }} transition={{ repeat: Infinity, repeatDelay: 3, duration: 0.6 }}><Face status="idle" size="lg" /></motion.div>
                <div>
                  <p className="text-[16px] font-semibold text-ink">我是小雷，有事说事。</p>
                  <p className="mt-1 max-w-[420px] text-[13.5px] leading-relaxed text-ink-3">查信源、改配置、拉公众号历史、撤内容都行。花钱和动数据的事我先给你看确认卡，你点了我才干。</p>
                </div>
                <div className="flex max-w-[560px] flex-wrap justify-center gap-2">
                  {STARTERS.map((s) => <button key={s} type="button" onClick={() => void send(s)} disabled={!!pending}
                    className="rounded-full px-3 py-1.5 text-[12.5px] text-ink-2 ring-1 ring-line-strong transition-colors hover:bg-bg-sunk hover:text-ink disabled:opacity-45">{s}</button>)}
                </div>
              </div>
            ) : (
              <AnimatePresence initial={false}>
                {c.messages.map((m, i) => <motion.div key={`${i}-${m.at}`} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.18 }}><Message m={m} /></motion.div>)}
              </AnimatePresence>
            )}
            {thinking && <BusyLine />}
            {c?.pending && status === "awaiting" && <ProposalCard p={c.pending} busy={pending === "agent-confirm"} onConfirm={() => void decide("confirm")} onCancel={() => void decide("cancel")} />}
            {status === "error" && c?.error && (
              <div className="ml-10 max-w-[560px] rounded-control bg-hot-soft px-3.5 py-2.5 text-[13px] text-hot">
                翻车了：{c.error}
                <p className="mt-1 text-[12px] opacity-80">模型没配好时检查 DEEPSEEK_BASE_URL 和 DEEPSEEK_API_KEY；直接再发一句也行。</p>
              </div>
            )}
            <div ref={end} />
          </div>

          <form className="flex items-end gap-2 border-t border-line p-3" onSubmit={(e) => { e.preventDefault(); void send(); }}>
            <textarea value={text} rows={1} maxLength={2000} onChange={(e) => setText(e.target.value)} aria-label="给小雷发消息"
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); } }}
              placeholder={thinking ? "小雷还在忙…" : status === "awaiting" ? "先拍板，或者直接说别的（提议会作废）" : "说点啥…（Enter 发送，Shift+Enter 换行）"}
              className="max-h-40 min-h-10 flex-1 resize-none rounded-control bg-field px-3 py-2.5 text-[14px] leading-relaxed text-ink ring-1 ring-line-strong outline-none placeholder:text-ink-4 focus:ring-2 focus:ring-accent [field-sizing:content]" />
            <Button type="submit" tone="primary" className="h-10" disabled={thinking || !text.trim()} busy={pending === "agent-send"}>发送</Button>
          </form>
        </section>
      </div>
    </AdminPage>
  );
}
