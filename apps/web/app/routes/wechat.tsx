import { useEffect } from "react";
import { Link, useRevalidator } from "react-router";
import type { Route } from "./+types/wechat";
import type { WechatDigest, WechatDigestDetail, WechatDigestFeed } from "@aihot/contracts/wechat";
import { adminGet } from "../lib/admin.server";
import { EmptyState } from "../components/ui/Page";
import { fullDateTime } from "../lib/format";

export async function loader({ request }: Route.LoaderArgs) {
  const params = new URL(request.url).searchParams;
  const page = Math.max(1, Math.floor(Number(params.get("page")) || 1));
  if (params.has("day")) {
    const query = new URLSearchParams({ account: params.get("account") ?? "", group: params.get("group") ?? "", day: params.get("day") ?? "" });
    return { detail: await adminGet<WechatDigestDetail>(request, `/api/admin/wechat/digest?${query}`), feed: null, page };
  }
  return { detail: null, feed: await adminGet<WechatDigestFeed>(request, `/api/admin/wechat/digests?page=${page}`), page };
}

export const headers: Route.HeadersFunction = () => ({ "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex, nofollow" });
export const meta: Route.MetaFunction = () => [{ title: "群聊要点" }, { name: "robots", content: "noindex, nofollow" }];

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
              {message ? <><p className="text-[11px] text-ink-4">{message.sender_name || message.sender_id || "发言者未识别"} · {fullDateTime(new Date(message.sent_at * 1000).toISOString())}</p><p className="whitespace-pre-wrap break-words">{message.revoked ? "这条消息已撤回" : message.content}</p></> : "原消息已不可用，等待摘要更新。"}
            </li>;
          })}</ol>
        </details> : null}
      </li>)}</ol>}
    {digest.status === "ready" && !detail && digest.points.length > 0 && <Link to={href(digest)} className="mt-4 inline-block text-[13px] text-accent hover:underline">查看原消息依据 →</Link>}
    <p className="mt-4 text-[11px] text-ink-4">更新于 {fullDateTime(digest.updated_at)} · AI 归纳，观点和数字未经独立核实</p>
  </article>;
}

export default function WechatFeed({ loaderData }: Route.ComponentProps) {
  const { feed, detail, page } = loaderData;
  const revalidator = useRevalidator();
  useEffect(() => {
    const timer = setInterval(() => { if (document.visibilityState === "visible" && revalidator.state === "idle") void revalidator.revalidate(); }, 30000);
    return () => clearInterval(timer);
  }, [revalidator]);
  return <div className="pt-5 lg:pt-0">
    <div className="mb-4 flex items-center justify-between gap-3"><h1 className="text-[24px] font-semibold tracking-tight">群聊要点</h1><Link to="/admin/wechat" className="text-[12px] text-ink-4 hover:text-accent">群与原消息</Link></div>
    <nav aria-label="信息流" className="mb-5 flex gap-5 border-b border-line pb-3 text-[14px]"><Link to="/discover" className="text-ink-3">公开资料</Link><Link to="/wechat" aria-current="page" className="font-semibold text-accent">群聊要点 · 私人</Link></nav>
    <p className="mb-5 text-[13px] leading-6 text-ink-3">按群和日期汇总讨论中的结论、方法与分歧，每个要点都保留原消息依据。</p>
    {detail ? <><Link to="/wechat" className="mb-4 inline-block text-[13px] text-accent">← 返回群聊信息流</Link><DigestCard digest={detail.digest} detail={detail} /></>
      : feed && <>
        {!feed.ready ? <EmptyState title="群聊摘要尚未初始化">完成摘要存储准备后，已接入群的要点会出现在这里。</EmptyState>
          : <>{!feed.enabled && <p role="status" className="mb-4 rounded-control bg-bg-sunk p-3 text-[13px] text-ink-3">自动摘要尚未开启；已有摘要仍可查看。</p>}
            {!feed.items.length ? <EmptyState title="还没有群聊要点">接入你选择的群并开启摘要后，核心要点会按日期出现在这里。</EmptyState> : feed.items.map(d => <DigestCard key={`${d.account}/${d.group_id}/${d.day}`} digest={d} />)}
            <nav aria-label="分页" className="my-6 flex justify-center gap-5 text-[13px] text-accent">{page > 1 && <Link to={`/wechat?page=${page - 1}`}>更新的要点</Link>}{feed.hasMore && <Link to={`/wechat?page=${page + 1}`}>更早的要点 →</Link>}</nav>
          </>}
      </>}
  </div>;
}
