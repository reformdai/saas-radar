import { useEffect, useState } from "react";
import { Link, useRevalidator, useSearchParams } from "react-router";
import type { WechatInbox } from "@aihot/contracts/wechat";
import type { Route } from "./+types/wechat";
import { adminGet } from "../../lib/admin.server";
import { useAdminAction } from "../../features/admin/action";
import { AdminPage, Badge, Button, Card, Empty, Pager, Time } from "../../features/admin/ui";
import { bj } from "../../features/admin/format";

export async function loader({ request }: Route.LoaderArgs) {
  return adminGet<WechatInbox>(request, `/api/admin/wechat${new URL(request.url).search}`);
}

export default function Wechat({ loaderData }: Route.ComponentProps) {
  const { ready, groups, candidates, messages, hasMore } = loaderData;
  const [params] = useSearchParams();
  const page = Math.max(1, Number(params.get("page")) || 1);
  const selected = groups.find((g) => g.group_id === params.get("group") && g.account === params.get("account")) ?? (params.get("group") ? null : groups[0]);
  const revalidator = useRevalidator();
  const { run, pending } = useAdminAction();
  useEffect(() => {
    if (!ready || page !== 1) return;
    const timer = setInterval(() => { if (document.visibilityState === "visible" && revalidator.state === "idle") revalidator.revalidate(); }, 5000);
    return () => clearInterval(timer);
  }, [ready, page, revalidator]);
  return (
    <AdminPage title="微信群聊" subtitle="只读取已选择的群；原消息和摘要仅登录后可见。">
      <Link to="/wechat" className="mb-4 inline-block text-[14px] text-accent hover:underline">查看群聊要点信息流 →</Link>
      {!ready ? <Card title="接入准备中"><Empty>群聊数据表尚未初始化，完成数据库迁移后即可接入。</Empty></Card> : !groups.length ? (
        <>
          <GroupPicker candidates={candidates ?? []} />
          <Card title="已接入的群" className="mt-4"><Empty>选择上方群聊后，消息和摘要会显示在这里。</Empty></Card>
        </>
      ) : (
        <>
        <GroupPicker candidates={candidates ?? []} />
        <div className="grid gap-4 lg:grid-cols-[260px_minmax(0,1fr)]">
          <Card title="已接入的群">
            <div className="space-y-2">{groups.map((g) => (
              <Link key={`${g.account}:${g.group_id}`} to={`?${new URLSearchParams({ account: g.account, group: g.group_id })}`} className={`block rounded-control border p-3 ${selected === g ? "border-accent bg-accent-soft" : "border-line hover:bg-bg-sunk"}`}>
                <div className="flex items-center justify-between gap-2"><span className="break-words text-[14px] font-medium">{g.name}</span>{!g.enabled && <Badge>已暂停</Badge>}</div>
                <div className="mt-1 text-[12px] text-ink-3">{g.message_count ?? 0} 条 · {g.account}</div>
              </Link>
            ))}</div>
          </Card>
          <Card title={selected?.name ?? "请选择群"}>
            {selected && <>
              <div className="mb-4 flex flex-wrap items-center justify-between gap-3 border-b border-line pb-3">
                <div className="text-[12px] leading-6 text-ink-3">
                  <div>最近接收：<Time at={selected.last_received_at} /></div>
                  <div>最近补漏：<Time at={selected.last_checked_at} /></div>
                  {(!selected.last_checked_at || Date.now() - Date.parse(selected.last_checked_at) > 900_000) && <div className="text-amber">尚未完成同步或已超过 15 分钟未更新，请检查 Mac 上的采集器。</div>}
                </div>
                <Button busy={pending === "pause"} onClick={() => run("POST", "/api/admin/wechat/group", { account: selected.account, groupId: selected.group_id, enabled: !selected.enabled }, { label: "pause", success: selected.enabled ? "群聊接收已暂停" : "群聊接收已恢复" })}>{selected.enabled ? "暂停接收" : "恢复接收"}</Button>
              </div>
              {!messages.length ? <Empty>暂无消息。选择群后通常在 10 分钟内开始同步，首次默认回填采集器接入起点前 7 天以来的消息。</Empty> : <ol className="space-y-4">{messages.map((m) => (
                <li key={m.message_id} className="rounded-control border border-line p-3">
                  <div className="mb-2 flex flex-wrap justify-between gap-2 text-[12px] text-ink-3"><span className="font-medium text-ink-2">{m.sender_name || m.sender_id || "发言者未识别"}</span><time>{bj(new Date(m.sent_at * 1000).toISOString(), true)}</time></div>
                  <p className={`whitespace-pre-wrap break-words text-[14px] leading-7 ${m.revoked ? "text-ink-4" : "text-ink"}`}>{m.revoked ? "这条消息已撤回" : m.content || "[无文字内容]"}</p>
                </li>
              ))}</ol>}
              <Pager page={page} hasMore={hasMore} />
            </>}
          </Card>
        </div>
        </>
      )}
    </AdminPage>
  );
}

function GroupPicker({ candidates }: { candidates: WechatInbox["candidates"] }) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("selected");
  const [page, setPage] = useState(1);
  const { run, pending } = useAdminAction();
  const selectedCount = candidates.filter(g => g.selected).length;
  const filtered = candidates.filter(g => (filter === "all" || g.selected)
    && g.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const pages = Math.max(1, Math.ceil(filtered.length / 10));
  const currentPage = Math.min(page, pages);
  const visible = filtered.slice((currentPage - 1) * 10, currentPage * 10);
  return <Card title="选择要接入的群" className="mb-4">
    <p className="mb-3 text-[13px] leading-6 text-ink-3">只读取已选择的群。首次默认回填接入起点前 7 天以来的消息，不会自动导入全部历史；取消选择保留已有记录。</p>
    <div className="mb-3 flex flex-wrap items-center gap-2">
      <Button size="sm" tone={filter === "selected" ? "primary" : "secondary"} onClick={() => { setFilter("selected"); setPage(1); }}>已选择（{selectedCount}）</Button>
      <Button size="sm" tone={filter === "all" ? "primary" : "secondary"} onClick={() => { setFilter("all"); setPage(1); }}>全部群（{candidates.length}）</Button>
      <input type="search" aria-label="搜索群名称" placeholder="搜索群名称，查找并添加群" value={query}
        onChange={e => { setQuery(e.target.value); setFilter("all"); setPage(1); }}
        className="h-9 min-w-0 flex-1 rounded-control border border-line bg-surface px-3 text-[14px] outline-none focus:border-accent" />
    </div>
    {!candidates.length ? <Empty>还没有发现群。请先在运行微信的 Mac 上启动采集器。</Empty> : !filtered.length ?
      <Empty>{query.trim() ? "没有匹配的群，请换个关键词。" : "还没有选择群。搜索群名称或切换到全部群添加。"}</Empty> : <>
      <div className="space-y-2">{visible.map(g => <div key={`${g.account}:${g.group_id}`} className="flex flex-wrap items-center justify-between gap-3 rounded-control border border-line p-3">
        <div className="min-w-0"><div className="break-words text-[14px] font-medium">{g.name}</div><div className="mt-1 text-[12px] text-ink-3">账号：{g.account}{g.selected && " · 已选择"}</div></div>
        <Button busy={pending === `select:${g.account}:${g.group_id}`} onClick={() => run("POST", "/api/admin/wechat/selection", { account: g.account, groupId: g.group_id, selected: !g.selected }, { label: `select:${g.account}:${g.group_id}`, success: g.selected ? "已停止接收该群" : "已选择该群，采集器将在下一轮同步消息" })}>{g.selected ? "停止接收" : "选择此群"}</Button>
      </div>)}</div>
      <div className="mt-3 flex items-center justify-between gap-2 text-[12px] text-ink-3">
        <span>共 {filtered.length} 个群 · 第 {currentPage} / {pages} 页</span>
        <div className="flex gap-2"><Button size="sm" disabled={currentPage <= 1} onClick={() => setPage(currentPage - 1)}>上一页</Button><Button size="sm" disabled={currentPage >= pages} onClick={() => setPage(currentPage + 1)}>下一页</Button></div>
      </div>
    </>}
  </Card>;
}
