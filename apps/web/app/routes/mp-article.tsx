import { Link } from "react-router";
import type { Route } from "./+types/mp-article";
import type { MpLibraryArticle } from "@aihot/contracts/mp";
import { loadOr404 } from "../lib/api.server";
import { pageMeta } from "../lib/seo";
export async function loader({ request, params }: Route.LoaderArgs) { return loadOr404<MpLibraryArticle>(`/api/site/mp/${encodeURIComponent(params.id)}`, { signal: request.signal }); }
export const headers = () => ({ "Cache-Control": "no-cache" });
export const meta = ({ loaderData }: Route.MetaArgs) => pageMeta({ title: loaderData?.title ?? "公众号文章", description: loaderData?.summary ?? "公众号资料库", path: `/mp/articles/${loaderData?.id ?? ""}`, noindex: true });
export default function MpArticle({ loaderData: a }: Route.ComponentProps) {
  return <article className="mx-auto max-w-[800px] pb-10 pt-5 lg:pt-0"><Link className="text-[13px] text-accent" to={`/mp?source=${encodeURIComponent(a.sourceId)}`}>← {a.sourceName}</Link><h1 className="mt-5 text-[26px] font-bold leading-relaxed">{a.title}</h1><div className="mt-3 text-[13px] text-ink-4">{a.publishedAt ? new Date(a.publishedAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" }) : "时间未知"}</div><div className="my-6 flex gap-5 text-[14px] text-accent"><Link to={`/admin/research?article=${a.id}&kind=mp`}>引用本文，开始研究</Link><a href={a.url} target="_blank" rel="noreferrer">阅读微信原文 ↗</a></div>{a.summary && <section className="mb-8 rounded-card bg-bg-sunk p-5"><p className="mb-2 text-[12px] text-accent">AI 导读</p><p className="leading-8">{a.summary}</p></section>}{a.html ? <div className="prose" dangerouslySetInnerHTML={{ __html: a.html }} /> : <p className="rounded-card border border-line p-6 text-[14px] leading-7 text-ink-3">当前没有可展示的全文。可以阅读微信原文；管理员可在信源设置中补齐归档全文。</p>}</article>;
}
