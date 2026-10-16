// The conversation with 小雷, shared by the site-wide panel and the /admin/agent page: messages with
// cited answers, the confirmation card for a change, and the input. Commands go to /api/admin/agent*
// with the session's CSRF token; the answer is read by polling while the worker writes it.
import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { AnimatePresence, motion } from "motion/react";
import type { AgentCitation, AgentConversation, AgentMessage, AgentPageContext, AgentProposal } from "@aihot/contracts/agent";
import { Button } from "../../features/admin/ui";
import { IconClose, IconDoc } from "../icons";

type Status = AgentConversation["status"];
export const MOOD: Record<Status, { face: string; label: string }> = {
  idle: { face: "(￣▽￣)", label: "在线摸鱼中" },
  thinking: { face: "(・_・ヾ", label: "翻资料中" },
  awaiting: { face: "(ง •̀_•́)ง", label: "等你拍板" },
  error: { face: "(╯°□°)╯", label: "翻车了" },
};
const BUSY_LINES = ["翻资料中…", "跟服务商掰扯中…", "假装很忙中…", "认真干活中（真的）…", "对着数据皱眉中…"];
const STARTERS = ["刘小排最近在讲什么？", "群里最近怎么聊支付和风控？", "哪些信源最近在报错？", "最近 7 天花了多少钱？"];
const PAGE_STARTERS = ["这篇的核心观点是什么？", "这篇讲的方法我该怎么落地？", "资料库里还有谁聊过类似的话题？"];

export class AgentApiError extends Error {}

/** A command to the agent API; the same key on a retry of the same message never queues a second paid turn. */
export async function agentCall<T>(method: "GET" | "POST", path: string, csrf: string, body?: unknown, key?: string): Promise<T> {
  const res = await fetch(path, {
    method, credentials: "same-origin",
    headers: { accept: "application/json", ...(method === "POST" ? { "content-type": "application/json", "x-csrf-token": csrf, "idempotency-key": key ?? crypto.randomUUID() } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) throw new AgentApiError(json?.detail ?? `请求失败（${res.status}）`);
  return json as T;
}

export function Face({ status, size = "md" }: { status: Status; size?: "sm" | "md" | "lg" }) {
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

/** **bold** and [n] citation marks inside a line; everything else is plain text (never HTML). */
function inline(text: string, cite: (n: number) => void, known: Set<number>): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*|\[\d+\])/g).map((part, i) => {
    const mark = /^\[(\d+)\]$/.exec(part);
    if (mark && known.has(Number(mark[1]))) {
      const n = Number(mark[1]);
      return <button key={i} type="button" onClick={() => cite(n)} aria-label={`查看引用 ${n}`}
        className="num mx-px inline-flex h-[17px] min-w-[17px] -translate-y-[3px] items-center justify-center rounded-[5px] bg-accent-soft px-1 align-baseline text-[10.5px] font-semibold text-accent-ink hover:bg-accent hover:text-white">{n}</button>;
    }
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) return <strong key={i} className="font-semibold">{part.slice(2, -2)}</strong>;
    return <Fragment key={i}>{part}</Fragment>;
  });
}

/** A model answer as short paragraphs, headings and lists (the Markdown it tends to write), without rendering HTML. */
function RichText({ text, citations, onCite }: { text: string; citations: AgentCitation[]; onCite: (n: number) => void }) {
  const known = new Set(citations.map((c) => c.n));
  return (
    <div className="space-y-1.5">
      {text.split("\n").map((line, i) => {
        const t = line.trim();
        if (!t) return null;
        const heading = /^#{1,4}\s+(.*)$/.exec(t);
        if (heading) return <p key={i} className="pt-1 font-semibold text-ink">{inline(heading[1]!, onCite, known)}</p>;
        const item = /^(?:[-*•]|\d+[.、)])\s+(.*)$/.exec(t);
        if (item) return <p key={i} className="relative pl-4"><span className="absolute left-0.5 top-0 text-ink-4">{/^\d/.test(t) ? `${t.match(/^\d+/)![0]}.` : "•"}</span>{inline(item[1]!, onCite, known)}</p>;
        return <p key={i}>{inline(t, onCite, known)}</p>;
      })}
    </div>
  );
}

const when = (at: string | null) => at ? new Date(at).toLocaleDateString("zh-CN", { timeZone: "Asia/Shanghai", year: "numeric", month: "numeric", day: "numeric" }) : null;

function Citations({ citations, open, onToggle }: { citations: AgentCitation[]; open: number | null; onToggle: (n: number) => void }) {
  return (
    <div className="mt-2.5 space-y-1 border-t border-line pt-2">
      <p className="text-[11.5px] text-ink-4">引用资料 · 点开看原文片段</p>
      {citations.map((c) => (
        <div key={c.n} id={`cite-${c.n}`} className={`rounded-control text-[12.5px] transition-colors ${open === c.n ? "bg-surface ring-1 ring-accent/40" : ""}`}>
          <button type="button" onClick={() => onToggle(c.n)} className="flex w-full items-start gap-2 px-1.5 py-1 text-left hover:text-ink">
            <span className="num mt-px inline-flex h-[17px] min-w-[17px] shrink-0 items-center justify-center rounded-[5px] bg-accent-soft px-1 text-[10.5px] font-semibold text-accent-ink">{c.n}</span>
            <span className="min-w-0 flex-1">
              <span className="line-clamp-1 text-ink-2">{c.title}</span>
              <span className="text-[11.5px] text-ink-4">{c.source}{when(c.at) ? ` · ${when(c.at)}` : ""}</span>
            </span>
          </button>
          {open === c.n && (
            <div className="px-1.5 pb-2 pl-8">
              <p className="max-h-60 overflow-y-auto whitespace-pre-wrap rounded-control bg-bg-sunk px-2.5 py-2 text-[12.5px] leading-relaxed text-ink-3">{c.quote}</p>
              <div className="mt-1.5 flex gap-3 text-[12px] text-accent">
                {c.href && <Link to={c.href} prefetch="intent">站内查看</Link>}
                {c.url && <a href={c.url} target="_blank" rel="noreferrer">原文 ↗</a>}
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function AgentBubble({ m }: { m: Extract<AgentMessage, { role: "agent" }> }) {
  const [open, setOpen] = useState<number | null>(null);
  const citations = m.citations ?? [];
  const cite = (n: number) => setOpen((o) => (o === n ? null : n));
  return (
    <div className="flex items-start gap-2.5">
      <Face status="idle" size="sm" />
      <div className="min-w-0 max-w-[88%] rounded-card rounded-tl-mark bg-bg-sunk px-3.5 py-2.5 text-[14px] leading-relaxed text-ink">
        {m.text ? <RichText text={m.text} citations={citations} onCite={cite} /> : <span className="text-ink-3">正在写…</span>}
        {m.streaming && <span className="ml-0.5 inline-block animate-pulse text-ink-4">▍</span>}
        {citations.length > 0 && !m.streaming && <Citations citations={citations} open={open} onToggle={cite} />}
      </div>
    </div>
  );
}

function Message({ m }: { m: AgentMessage }) {
  if (m.role === "user") return (
    <div className="flex flex-col items-end gap-1">
      {m.context && <span className="inline-flex max-w-[80%] items-center gap-1 text-[11.5px] text-ink-4"><IconDoc size={12} /><span className="truncate">{m.context.title}</span></span>}
      <p className="max-w-[85%] whitespace-pre-wrap rounded-card rounded-tr-mark bg-ink px-3.5 py-2.5 text-[14px] leading-relaxed text-bg">{m.text}</p>
    </div>
  );
  if (m.role === "agent") return <AgentBubble m={m} />;
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

export function ChatBody({ conversation: c, onConversation, csrf, page, onDismissPage, compact = false }: {
  conversation: AgentConversation | null;
  onConversation: (c: AgentConversation) => void;
  csrf: string;
  /** The page being read, sent with the next message. */
  page?: AgentPageContext | null;
  onDismissPage?: () => void;
  compact?: boolean;
}) {
  const [text, setText] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const end = useRef<HTMLDivElement>(null);
  // A retry of the same text keeps its key; an edited message is a new command.
  const sendKey = useRef<{ text: string; key: string } | null>(null);
  const status: Status = c?.status ?? "idle";
  const thinking = status === "thinking";
  const last = c?.messages.at(-1);
  const streaming = last?.role === "agent" && !!last.streaming;

  useEffect(() => { end.current?.scrollIntoView({ behavior: "smooth", block: "end" }); }, [c?.messages.length, status, last?.role === "agent" ? last.text.length : 0]);
  useEffect(() => {
    if (!thinking || !c) return;
    const abort = new AbortController();
    const read = async () => {
      try {
        const r = await fetch(`/api/admin/agent/${c.id}`, { signal: abort.signal, credentials: "same-origin" });
        if (r.ok) onConversation(await r.json() as AgentConversation);
      } catch { /* A transient polling error does not resend the message. */ }
    };
    // The worker writes a growing answer about every 0.4 s.
    const timer = setInterval(() => void read(), 500);
    return () => { abort.abort(); clearInterval(timer); };
  }, [thinking, c?.id]);

  const send = async (message = text) => {
    if (!message.trim() || thinking || pending) return;
    if (sendKey.current?.text !== message) sendKey.current = { text: message, key: crypto.randomUUID() };
    setPending("send"); setError(null);
    try {
      const next = await agentCall<AgentConversation>("POST", "/api/admin/agent", csrf, { conversationId: c?.id ?? null, message, context: page ?? null }, sendKey.current.key);
      sendKey.current = null;
      onConversation(next); setText("");
    } catch (e) {
      setError(e instanceof AgentApiError ? e.message : "网络错误，请稍后再试");
    } finally { setPending(null); }
  };
  const decide = async (action: "confirm" | "cancel") => {
    if (!c?.pending) return;
    setPending(action); setError(null);
    try {
      onConversation(await agentCall<AgentConversation>("POST", `/api/admin/agent/${c.id}/${action}`, csrf, { proposalId: c.pending.id }));
    } catch (e) {
      setError(e instanceof AgentApiError ? e.message : "网络错误，请稍后再试");
    } finally { setPending(null); }
  };

  const starters = page ? PAGE_STARTERS : STARTERS;
  return (
    <>
      <div className={`flex-1 space-y-3.5 overflow-y-auto overscroll-contain ${compact ? "px-3.5 py-4" : "px-4 py-5"}`} aria-live="polite">
        {!c || c.messages.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-4 py-8 text-center">
            <motion.div animate={{ rotate: [0, -4, 4, 0] }} transition={{ repeat: Infinity, repeatDelay: 3, duration: 0.6 }}><Face status="idle" size="lg" /></motion.div>
            <div>
              <p className="text-[16px] font-semibold text-ink">我是小雷，有事说事。</p>
              <p className="mt-1 max-w-[420px] text-[13.5px] leading-relaxed text-ink-3">
                {page ? "这篇我能帮你拆，也能翻整个资料库找相关的说法，每句都带出处。" : "能翻全部资料库（公众号、博客、群聊）回答问题，每句带出处；也能查信源、办后台的事，动手前先给你看确认卡。"}
              </p>
            </div>
            <div className="flex max-w-[560px] flex-wrap justify-center gap-2">
              {starters.map((s) => <button key={s} type="button" onClick={() => void send(s)} disabled={!!pending}
                className="rounded-full px-3 py-1.5 text-[12.5px] text-ink-2 ring-1 ring-line-strong transition-colors hover:bg-bg-sunk hover:text-ink disabled:opacity-45">{s}</button>)}
            </div>
          </div>
        ) : (
          <AnimatePresence initial={false}>
            {c.messages.map((m, i) => <motion.div key={`${i}-${m.at}`} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.18 }}><Message m={m} /></motion.div>)}
          </AnimatePresence>
        )}
        {thinking && !streaming && <BusyLine />}
        {c?.pending && status === "awaiting" && <ProposalCard p={c.pending} busy={pending === "confirm"} onConfirm={() => void decide("confirm")} onCancel={() => void decide("cancel")} />}
        {status === "error" && c?.error && (
          <div className="ml-10 max-w-[560px] rounded-control bg-hot-soft px-3.5 py-2.5 text-[13px] text-hot">
            翻车了：{c.error}
            <p className="mt-1 text-[12px] opacity-80">模型没配好时检查 LLM_BASE_URL、LLM_API_KEY 和 LLM_MODEL；直接再发一句也行。</p>
          </div>
        )}
        <div ref={end} />
      </div>

      <form className="border-t border-line p-3" onSubmit={(e) => { e.preventDefault(); void send(); }}>
        {error && <p className="mb-2 rounded-control bg-hot-soft px-2.5 py-1.5 text-[12.5px] text-hot">{error}</p>}
        {page && (
          <div className="mb-2 flex items-center gap-1.5">
            <span className="inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-full bg-accent-soft py-1 pl-2.5 pr-1 text-[12px] text-accent-ink">
              <IconDoc size={13} /><span className="truncate">正在看：{page.title}</span>
              <button type="button" onClick={onDismissPage} aria-label="不带上这篇" className="rounded-full p-0.5 hover:bg-accent/15"><IconClose size={12} /></button>
            </span>
          </div>
        )}
        <div className="flex items-end gap-2">
          <textarea value={text} rows={1} maxLength={2000} onChange={(e) => setText(e.target.value)} aria-label="给小雷发消息"
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); } }}
            placeholder={thinking ? "小雷还在忙…" : status === "awaiting" ? "先拍板，或者直接说别的（提议会作废）" : "问点啥…（Enter 发送，Shift+Enter 换行）"}
            className="max-h-40 min-h-10 flex-1 resize-none rounded-control bg-field px-3 py-2.5 text-[14px] leading-relaxed text-ink ring-1 ring-line-strong outline-none placeholder:text-ink-4 focus:ring-2 focus:ring-accent [field-sizing:content]" />
          <Button type="submit" tone="primary" className="h-10" disabled={thinking || !text.trim()} busy={pending === "send"}>发送</Button>
        </div>
      </form>
    </>
  );
}
