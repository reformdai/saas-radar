import { Form, Link } from "react-router";
import type { Route } from "./+types/mp";
import type { MpLibrary } from "@aihot/contracts/mp";
import { loadOr404 } from "../lib/api.server";
import { pageMeta } from "../lib/seo";

function queryString(values: Record<string, string | number | null>) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) if (value !== null && value !== "") params.set(key, String(value));
  const query = params.toString();
  return query ? `?${query}` : "";
}
export async function loader({ request }: Route.LoaderArgs) {
  const params = new URL(request.url).searchParams;
  const filters = { source: params.get("source") ?? "", q: params.get("q") ?? "" };
  return { data: await loadOr404<MpLibrary>(`/api/site/mp${queryString({ ...filters, page: params.get("page") })}`, { signal: request.signal }), filters };
}
export const headers = () => ({ "Cache-Control": "no-cache" });
export const meta = () => pageMeta({ title: "公众号资料库", description: "按公众号浏览、搜索已归档的文章，阅读与研究。", path: "/mp", noindex: true });
export default function MpPage({ loaderData: { data, filters } }: Route.ComponentProps) {
  const href = (page: number) => `/mp${queryString({ ...filters, page })}`;
  return <div className="pb-8">
    <div className="flex items-center justify-between gap-3 pt-5 lg:pt-0"><h1 className="text-[24px] font-semibold">公众号</h1><Link to="/admin/sources?kind=mp_account" className="text-[13px] text-accent">管理订阅与历史归档</Link></div>
    <p className="mt-2 text-[14px] text-ink-3">按账号保存的文章资料库，不受精选评分限制。未获取全文的文章保留原文入口。</p>
    <div className="my-5 flex flex-wrap gap-2"><Link className={`chip ${!filters.source ? "text-accent" : ""}`} to="/mp">全部公众号</Link>{data.accounts.map(a => <Link key={a.id} className={`chip ${filters.source === a.id ? "text-accent" : ""}`} to={`/mp${queryString({ source: a.id })}`}>{a.name} · {a.count} 篇</Link>)}</div>
    <Form method="get" className="mb-5 flex gap-2"><input type="hidden" name="source" value={filters.source} /><input className="min-w-0 flex-1 rounded-control border border-line bg-surface px-3 py-2 text-[14px]" name="q" defaultValue={filters.q} placeholder="搜索文章标题或摘要" aria-label="搜索公众号文章" /><button className="chip" type="submit">搜索</button></Form>
    {!data.items.length && <div className="rounded-card border border-line p-8 text-ink-3">还没有匹配的文章。已订阅公众号的文章会出现在这里；历史文章需在后台手动归档。</div>}
    <div className="divide-y divide-line">{data.items.map(a => <article key={a.id} className="py-5"><div className="mb-2 flex flex-wrap gap-3 text-[12px] text-ink-4"><span>{a.sourceName}</span><span>{a.publishedAt ? new Date(a.publishedAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" }) : "时间未知"}</span><span>{a.hasBody ? "正文已获取" : "仅列表 · 待获取全文"}</span></div><Link to={`/mp/articles/${a.id}`} className="text-[19px] font-semibold leading-relaxed hover:text-accent">{a.title}</Link>{a.summary && <p className="mt-2 line-clamp-3 text-[14px] leading-7 text-ink-3">{a.summary}</p>}<div className="mt-3 flex gap-4 text-[13px] text-accent"><Link to={`/mp/articles/${a.id}`}>阅读文章</Link><Link to={`/admin/research?article=${a.id}&kind=mp`}>引用并提问</Link><a href={a.url} target="_blank" rel="noreferrer">微信原文 ↗</a></div></article>)}</div>
    <nav className="mt-6 flex gap-4 text-[14px] text-accent" aria-label="分页">{data.page > 1 && <Link to={href(data.page - 1)}>上一页</Link>}{data.hasMore && <Link to={href(data.page + 1)}>下一页</Link>}</nav>
  </div>;
}
