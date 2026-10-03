import { useEffect } from "react";
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
  const { ready, groups, messages, hasMore } = loaderData;
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
    <AdminPage title="微信群聊" subtitle="只接收你选择的群；消息仅在后台可见。最新消息每 5 秒刷新。">
      {!ready ? <Card title="接入准备中"><Empty>群聊数据表尚未初始化，完成数据库迁移后即可接入。</Empty></Card> : !groups.length ? (
        <Card title="连接 WeFlow">
          <p className="text-[14px] leading-7 text-ink-2">在 Mac 上打开 WeFlow 的“API 服务”和“主动推送”，启动采集桥并选择要接入的群。连接成功后，群和新消息会自动出现在这里。</p>
          <p className="mt-3 text-[13px] text-ink-3">首次默认从启动接入时开始同步。历史消息可以在启动采集桥时指定起始日期。</p>
        </Card>
      ) : (
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
                  {(!selected.last_checked_at || Date.now() - Date.parse(selected.last_checked_at) > 180_000) && <div className="text-amber">尚未完成补漏或采集桥离线，请检查 Mac 上的连接。</div>}
                </div>
                <Button busy={pending === "pause"} onClick={() => run("POST", "/api/admin/wechat/group", { account: selected.account, groupId: selected.group_id, enabled: !selected.enabled }, { label: "pause", success: selected.enabled ? "群聊接收已暂停" : "群聊接收已恢复" })}>{selected.enabled ? "暂停接收" : "恢复接收"}</Button>
              </div>
              {!messages.length ? <Empty>暂无消息。请检查群聊采集连接，或等待这个群的新消息。</Empty> : <ol className="space-y-4">{messages.map((m) => (
                <li key={m.message_id} className="rounded-control border border-line p-3">
                  <div className="mb-2 flex flex-wrap justify-between gap-2 text-[12px] text-ink-3"><span className="font-medium text-ink-2">{m.sender_name || m.sender_id || "发言者未识别"}</span><time>{bj(new Date(m.sent_at * 1000).toISOString(), true)}</time></div>
                  <p className={`whitespace-pre-wrap break-words text-[14px] leading-7 ${m.revoked ? "text-ink-4" : "text-ink"}`}>{m.revoked ? "这条消息已撤回" : m.content || "[无文字内容]"}</p>
                </li>
              ))}</ol>}
              <Pager page={page} hasMore={hasMore} />
            </>}
          </Card>
        </div>
      )}
    </AdminPage>
  );
}
