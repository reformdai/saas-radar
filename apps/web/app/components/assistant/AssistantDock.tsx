// 小雷 on every page, for the administrator only: a button at the bottom right (or ⌘J / Ctrl+J) opens
// the conversation. On wide screens it docks at the right and the page makes room; narrower, it is a
// drawer over the page; on a phone, a full-screen sheet. The open state and the conversation follow
// the administrator from page to page.
import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router";
import { AnimatePresence, motion } from "motion/react";
import type { AgentConversation, AgentConversationSummary } from "@aihot/contracts/agent";
import { IconArrowUpRight, IconClose, IconHistory } from "../icons";
import { ChatBody, Face, MOOD, agentCall } from "./AssistantChat";
import { closeAssistant, detectAdmin, dismissPage, openAssistant, showConversation, toggleAssistant, useAssistant } from "./store";

const ago = (iso: string) => new Date(iso).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });

export function AssistantDock() {
  const { admin, open, conversationId, page, pageDismissed } = useAssistant();
  const { pathname } = useLocation();
  const [conversation, setConversation] = useState<AgentConversation | null>(null);
  const [history, setHistory] = useState<AgentConversationSummary[] | null>(null);
  // The full page shows the same conversation; the panel stays out of its way.
  const onAgentPage = pathname === "/admin/agent";
  const shown = !!admin && !onAgentPage;

  useEffect(() => { detectAdmin(); }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === "j" && (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && shown) { e.preventDefault(); toggleAssistant(); }
      else if (e.key === "Escape" && open && shown) closeAssistant();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [shown, open]);
  useEffect(() => {
    const docked = shown && open;
    document.documentElement.classList.toggle("assistant-open", docked);
    return () => document.documentElement.classList.remove("assistant-open");
  }, [shown, open]);
  useEffect(() => {
    if (!shown || !open || !admin) return;
    if (!conversationId) { setConversation(null); return; }
    if (conversation?.id === conversationId) return;
    agentCall<AgentConversation>("GET", `/api/admin/agent/${encodeURIComponent(conversationId)}`, admin.csrf)
      .then(setConversation).catch(() => showConversation(null));
  }, [shown, open, conversationId, admin]);

  if (!shown || !admin) return null;
  const status = conversation?.status ?? "idle";
  const change = (c: AgentConversation) => { setConversation(c); if (c.id !== conversationId) showConversation(c.id); };
  const toggleHistory = () => {
    if (history) { setHistory(null); return; }
    agentCall<AgentConversationSummary[]>("GET", "/api/admin/agent", admin.csrf).then(setHistory).catch(() => setHistory([]));
  };
  const pick = (id: string | null) => { setHistory(null); setConversation(null); showConversation(id); };

  return (
    <>
      <AnimatePresence>
        {!open && (
          <motion.button key="launcher" type="button" onClick={() => openAssistant()} aria-label="打开小雷（⌘J）" title="小雷 · ⌘J"
            initial={{ opacity: 0, scale: 0.85 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.85 }}
            className="fixed bottom-[calc(126px+env(safe-area-inset-bottom))] right-4 z-[45] flex h-12 items-center gap-2 rounded-full bg-surface py-1.5 pl-1.5 pr-3.5 text-[13px] font-medium text-ink shadow-[var(--shadow-soft)] ring-1 ring-line-strong transition-transform hover:-translate-y-0.5 lg:bottom-[84px] lg:right-6">
            <Face status={status} size="sm" />小雷
          </motion.button>
        )}
      </AnimatePresence>
      <AnimatePresence>
        {open && (
          <>
            <motion.div key="scrim" className="fixed inset-0 z-[54] hidden bg-black/15 sm:block xl:hidden" onClick={closeAssistant}
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} aria-hidden />
            <motion.aside key="panel" role="dialog" aria-label="小雷"
              initial={{ x: 24, opacity: 0 }} animate={{ x: 0, opacity: 1 }} exit={{ x: 24, opacity: 0 }} transition={{ type: "spring", stiffness: 420, damping: 38 }}
              className="fixed inset-0 z-[55] flex flex-col bg-bg sm:inset-y-0 sm:left-auto sm:right-0 sm:w-[400px] sm:border-l sm:border-line sm:shadow-[var(--shadow-soft)] xl:shadow-none">
              <header className="flex items-center gap-2.5 border-b border-line px-3.5 py-2.5 pt-[max(10px,env(safe-area-inset-top))]">
                <Face status={status} />
                <div className="min-w-0 flex-1">
                  <p className="text-[14px] font-semibold text-ink">小雷</p>
                  <p className="text-[11.5px] text-ink-3">{MOOD[status].label}</p>
                </div>
                <button type="button" onClick={toggleHistory} title="聊过的" aria-label="聊过的" className={`rounded-control p-2 text-ink-3 hover:bg-bg-sunk hover:text-ink ${history ? "bg-bg-sunk text-ink" : ""}`}><IconHistory size={17} /></button>
                <button type="button" onClick={() => pick(null)} title="新对话" className="rounded-control px-2 py-1.5 text-[12.5px] text-ink-3 hover:bg-bg-sunk hover:text-ink">＋ 新对话</button>
                <Link to={conversationId ? `/admin/agent?id=${conversationId}` : "/admin/agent"} title="在整页打开" aria-label="在整页打开" className="rounded-control p-2 text-ink-3 hover:bg-bg-sunk hover:text-ink"><IconArrowUpRight size={17} /></Link>
                <button type="button" onClick={closeAssistant} title="收起（Esc）" aria-label="收起" className="rounded-control p-2 text-ink-3 hover:bg-bg-sunk hover:text-ink"><IconClose size={17} /></button>
              </header>
              {history ? (
                <div className="flex-1 overflow-y-auto px-2 py-2">
                  {history.length === 0 ? <p className="px-2 py-6 text-center text-[13px] text-ink-4">还没聊过，别害羞。</p> : history.map((h) => (
                    <button key={h.id} type="button" onClick={() => pick(h.id)}
                      className={`block w-full rounded-control px-2.5 py-2 text-left text-[13px] hover:bg-bg-sunk ${h.id === conversationId ? "bg-surface ring-1 ring-line" : ""}`}>
                      <span className="line-clamp-1 text-ink">{h.title}</span>
                      <span className="text-[11.5px] text-ink-4">{h.turns} 句{h.status === "awaiting" ? " · 等你拍板" : h.status === "error" ? " · 翻车" : ""} · {ago(h.updatedAt)}</span>
                    </button>
                  ))}
                </div>
              ) : (
                <ChatBody compact conversation={conversation} onConversation={change} csrf={admin.csrf}
                  page={pageDismissed ? null : page} onDismissPage={dismissPage} />
              )}
            </motion.aside>
          </>
        )}
      </AnimatePresence>
    </>
  );
}
