import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router";
import type { Route } from "./+types/agent";
import type { AgentConversation, AgentConversationSummary } from "@aihot/contracts/agent";
import { adminGet } from "../../lib/admin.server";
import { useAdminMe } from "../../features/admin/action";
import { AdminPage, Button } from "../../features/admin/ui";
import { ChatBody, Face, MOOD } from "../../components/assistant/AssistantChat";
import { showConversation } from "../../components/assistant/store";

export async function loader({ request }: Route.LoaderArgs) {
  const id = new URL(request.url).searchParams.get("id");
  const [history, conversation] = await Promise.all([
    adminGet<AgentConversationSummary[]>(request, "/api/admin/agent"),
    id ? adminGet<AgentConversation>(request, `/api/admin/agent/${encodeURIComponent(id)}`).catch(() => null) : Promise.resolve(null),
  ]);
  return { history, conversation };
}

export default function Agent({ loaderData }: Route.ComponentProps) {
  const { history } = loaderData;
  const me = useAdminMe();
  const [c, setC] = useState<AgentConversation | null>(loaderData.conversation);
  const [params, setParams] = useSearchParams();
  const status = c?.status ?? "idle";

  useEffect(() => { setC(loaderData.conversation); }, [loaderData.conversation?.id]);
  // The site-wide panel picks up the conversation open here.
  useEffect(() => { if (c?.id) showConversation(c.id); }, [c?.id]);
  const change = (next: AgentConversation) => {
    setC(next);
    if (params.get("id") !== next.id) { const p = new URLSearchParams(params); p.set("id", next.id); setParams(p, { replace: true }); }
  };
  const fresh = () => { setC(null); showConversation(null); const p = new URLSearchParams(params); p.delete("id"); setParams(p); };

  return (
    <AdminPage title="小雷" subtitle="能翻全部资料库带出处回答，也能查后台、办事（动手前先给你看确认卡）。任何页面按 ⌘J 都能叫它；每句对话都会调用站点的默认模型，费用记在回执里。">
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
              <p className="text-[14.5px] font-semibold text-ink">小雷 <span className="ml-1 text-[11.5px] font-normal text-ink-4">研究与后台助理</span></p>
              <p className="flex items-center gap-1.5 text-[12px] text-ink-3">
                <span className={`size-1.5 rounded-full ${status === "error" ? "bg-hot" : status === "awaiting" ? "bg-amber" : "bg-ok"} ${status === "thinking" ? "animate-pulse" : ""}`} />
                {MOOD[status].label}
              </p>
            </div>
          </header>
          <ChatBody conversation={c} onConversation={change} csrf={me.csrf} />
        </section>
      </div>
    </AdminPage>
  );
}
