import { useEffect } from "react";
import { Link, useRevalidator, useSearchParams } from "react-router";
import type { Route } from "./+types/wechat";
import type { WechatDigest, WechatDigestDetail, WechatDigestFeed, WechatInbox } from "@aihot/contracts/wechat";
import { adminGet } from "../lib/admin.server";
import { EmptyState } from "../components/ui/Page";
import { fullDateTime } from "../lib/format";
import { WechatMessage } from "../components/WechatMessage";

export async function loader({ request }: Route.LoaderArgs) {
  const params = new URL(request.url).searchParams;
  const page = Math.max(1, Math.floor(Number(params.get("page")) || 1));
  if (params.has("day")) {
    const query = new URLSearchParams({ account: params.get("account") ?? "", group: params.get("group") ?? "", day: params.get("day") ?? "" });
    return { detail: await adminGet<WechatDigestDetail>(request, `/api/admin/wechat/digest?${query}`), feed: null, inbox: null, page };
  }
  if (params.get("view") === "summary") {
    return { detail: null, inbox: null, feed: await adminGet<WechatDigestFeed>(request, `/api/admin/wechat/digests?page=${page}`), page };
  }
  const query = new URLSearchParams({ page: String(page) });
  for (const key of ["account", "group"]) if (params.has(key)) query.set(key, params.get(key)!);
  return { detail: null, feed: null, inbox: await adminGet<WechatInbox>(request, `/api/admin/wechat?${query}`), page };
}

export const headers: Route.HeadersFunction = () => ({ "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex, nofollow" });
export const meta: Route.MetaFunction = () => [{ title: "微信群聊" }, { name: "robots", content: "noindex, nofollow" }];

const href = (digest: WechatDigest) => `/wechat?${new URLSearchParams({ account: digest.account, group: digest.group_id, day: digest.day })}`;

function DigestCard({ digest, detail }: { digest: WechatDigest; detail?: WechatDigestDetail }) {
  return <article className="card mb-4 p-5 lg:p-6">
    <div className="mb-4 flex flex-wrap items-center justify-between gap-2 text-[12px] text-ink-4">
      <span>{digest.day} · {digest.name}</span><span>{digest.status === "ready" ? `${digest.message_count} 条消息` : "消息更新中"} · 仅自己可见</span>
    </div>
    {digest.status !== "ready" ? <p role="status" className="text-[14px] leading-7 text-ink-3">{digest.status === "error" ? digest.error || "摘要生成失败，等待重试。" : "消息已收录，等待生成最新要点。"}</p>
      : !digest.points.length ? <p className="text-[14px] text-ink-3">本批讨论暂未提炼出有信息量的核心要点。</p>
      : <ol className="space-y-5">{digest.points.map((point, i) => <li key={i}>
        <h2 className="text-[16px] font-semibold leading-7 text-ink">{point.title}</h2>
        <p className="mt-1 whitespace-pre-wrap break-words text-[14px] leading-7 text-ink-2">{point.summary}</p>
        {detail ? <details className="mt-2 rounded-control border border-line px-3 py-2">
          <summary className="cursor-pointer text-[12px] text-accent">查看 {point.evidenceIds.length} 条原消息依据</summary>
          <ol className="mt-3 space-y-3">{point.evidenceIds.map(id => {
            const message = detail.messages.find(m => m.message_id === id);
            return <li key={id} className="border-t border-line pt-2 text-[13px] leading-6">
              {message ? <><p className="text-[11px] text-ink-4">{message.sender_name || message.sender_id || "发言者未识别"} · {fullDateTime(new Date(message.sent_at * 1000).toISOString())}</p><WechatMessage content={message.content} revoked={message.revoked} /></> : "原消息已不可用，等待摘要更新。"}
            </li>;
          })}</ol>
        </details> : null}
      </li>)}</ol>}
    {digest.status === "ready" && !detail && digest.points.length > 0 && <Link to={href(digest)} className="mt-4 inline-block text-[13px] text-accent hover:underline">查看原消息依据 →</Link>}
    <p className="mt-4 text-[11px] text-ink-4">更新于 {fullDateTime(digest.updated_at)} · AI 归纳，观点和数字未经独立核实</p>
  </article>;
}

export default function WechatFeed({ loaderData }: Route.ComponentProps) {
  const { feed, detail, inbox, page } = loaderData;
  const revalidator = useRevalidator();
  useEffect(() => {
    const timer = setInterval(() => { if (document.visibilityState === "visible" && revalidator.state === "idle") void revalidator.revalidate(); }, 30000);
    return () => clearInterval(timer);
  }, [revalidator]);
  return <div className="pt-5 lg:pt-0">
    <div className="mb-4 flex items-center justify-between gap-3"><h1 className="text-[24px] font-semibold tracking-tight">微信群聊</h1><Link to="/admin/wechat" className="text-[12px] text-ink-4 hover:text-accent">管理接入群</Link></div>
    <nav aria-label="信息流" className="mb-5 flex gap-5 border-b border-line pb-3 text-[14px]"><Link to="/discover" className="text-ink-3">公开资料</Link><Link to="/wechat" aria-current={inbox ? "page" : undefined} className={inbox ? "font-semibold text-accent" : "text-ink-3"}>原消息 · 私人</Link><Link to="/wechat?view=summary" aria-current={!inbox ? "page" : undefined} className={!inbox ? "font-semibold text-accent" : "text-ink-3"}>AI 要点</Link></nav>
    {inbox ? <MessageInbox inbox={inbox} page={page} /> : <p className="mb-5 text-[13px] leading-6 text-ink-3">按群和日期汇总讨论中的结论、方法与分歧，每个要点都保留原消息依据。原消息无需开启摘要即可查看。</p>}
    {detail ? <><Link to="/wechat?view=summary" className="mb-4 inline-block text-[13px] text-accent">← 返回群聊要点</Link><DigestCard digest={detail.digest} detail={detail} /></>
      : feed && <>
            {!feed.ready ? <EmptyState title="群聊摘要尚未初始化">完成摘要存储准备后，已接入群的要点会出现在这里。</EmptyState>
          : <>{feed.enabled && <p role="status" className="mb-4 rounded-control bg-bg-sunk p-3 text-[13px] text-ink-3">每 30 分钟检查新消息，滚动更新当天要点，并补齐昨天；旧历史不自动生成。生成需要一些时间，原消息可随时查看。</p>}{!feed.enabled && <p role="status" className="mb-4 rounded-control bg-bg-sunk p-3 text-[13px] text-ink-3">自动摘要已关闭，等待不会自动生成。已有摘要仍可查看；查看聊天请切换“原消息 · 私人”。</p>}
            {!feed.items.length ? <EmptyState title="还没有群聊要点">这里仅展示已生成的要点。摘要需要单独生成；已同步的聊天可在“原消息 · 私人”查看。</EmptyState> : feed.items.map(d => <DigestCard key={`${d.account}/${d.group_id}/${d.day}`} digest={d} />)}
            <nav aria-label="分页" className="my-6 flex justify-center gap-5 text-[13px] text-accent">{page > 1 && <Link to={`/wechat?view=summary&page=${page - 1}`}>更新的要点</Link>}{feed.hasMore && <Link to={`/wechat?view=summary&page=${page + 1}`}>更早的要点 →</Link>}</nav>
          </>}
      </>}
  </div>;
}

function MessageInbox({ inbox, page }: { inbox: WechatInbox; page: number }) {
  const [params] = useSearchParams();
  const selected = inbox.groups.find(g => g.group_id === params.get("group") && g.account === params.get("account"))
    ?? (params.has("group") ? null : inbox.groups[0]);
  const link = (account: string, group: string, page = 1) => `/wechat?${new URLSearchParams({ account, group, page: String(page) })}`;
  if (!inbox.ready) return <EmptyState title="群聊数据尚未初始化">请在群管理页检查接入状态。</EmptyState>;
  if (!inbox.groups.length) return <EmptyState title="还没有已接入的群"><Link to="/admin/wechat" className="text-accent">选择要接入的群 →</Link></EmptyState>;
  return <div className="grid items-start gap-4 lg:grid-cols-[240px_minmax(0,1fr)]">
    <aside className="card p-4" aria-label="已接入的群">
      <h2 className="mb-3 font-semibold">已接入的群（{inbox.groups.length}）</h2>
      <div className="flex gap-2 overflow-x-auto lg:flex-col">{inbox.groups.map(g => <Link key={`${g.account}:${g.group_id}`} to={link(g.account, g.group_id)}
        aria-current={selected === g ? "page" : undefined}
        className={`min-w-[180px] rounded-control border p-3 lg:min-w-0 ${selected === g ? "border-accent bg-accent-soft" : "border-line hover:bg-bg-sunk"}`}>
        <div className="break-words text-[14px] font-medium">{g.name}</div><div className="mt-1 text-[12px] text-ink-3">{(g.message_count ?? 0).toLocaleString("zh-CN")} 条{!g.enabled && " · 已暂停"}</div>
      </Link>)}</div>
    </aside>
    <section className="card min-w-0 p-4 lg:p-5" aria-label="群聊原消息">
      {!selected ? <EmptyState title="请选择群">点击左侧群名查看消息。</EmptyState> : <>
        <h2 className="text-[18px] font-semibold">{selected.name}</h2>
        <p className="mb-4 mt-2 text-[12px] text-ink-3">已收录 {(selected.message_count ?? 0).toLocaleString("zh-CN")} 条 · 最新在前 · 每页 100 条 · 第 {page} 页</p>
        {!inbox.messages.length ? <EmptyState title="这一页没有消息">可以返回第一页，或在群管理中检查同步状态。</EmptyState> :
          <ol className="space-y-3">{inbox.messages.map(m => <li key={m.message_id} data-message-id={m.message_id} className="rounded-control border border-line p-3">
            <div className="mb-2 flex flex-wrap justify-between gap-2 text-[12px] text-ink-3"><span>{m.sender_name || m.sender_id || "发言者未识别"}</span><time>{fullDateTime(new Date(m.sent_at * 1000).toISOString())}</time></div>
            <WechatMessage content={m.content} revoked={m.revoked} />
          </li>)}</ol>}
        <nav aria-label="原消息分页" className="mt-5 flex flex-wrap items-center justify-between gap-3 text-[13px] text-accent">
          {page > 1 ? <><Link to={link(selected.account, selected.group_id)}>回到最新</Link><Link to={link(selected.account, selected.group_id, page - 1)}>上一页</Link></> : <span />}
          {inbox.hasMore && <Link to={link(selected.account, selected.group_id, page + 1)}>更早的消息 →</Link>}
        </nav>
      </>}
    </section>
  </div>;
}
