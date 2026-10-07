import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router";
import type { Route } from "./+types/research";
import type { ResearchTurn } from "@aihot/contracts/research";
import type { MpLibraryArticle } from "@aihot/contracts/mp";
import type { SiteItemDetail } from "@aihot/contracts/site";
import { adminGet } from "../../lib/admin.server";
import { loadOr404 } from "../../lib/api.server";
import { useAdminAction } from "../../features/admin/action";
import { AdminPage, Button, Card, Select, Textarea } from "../../features/admin/ui";
export async function loader({ request }: Route.LoaderArgs) {
  const p = new URL(request.url).searchParams;
  const turn = p.get("id") ? await adminGet<ResearchTurn>(request, `/api/admin/research/${encodeURIComponent(p.get("id")!)}`) : null;
  const articleId = turn?.articleId ?? p.get("article");
  if (!articleId) return { seed: null, turn };
  const kind = p.get("kind") === "mp" ? "mp" : "item";
  const seed = kind === "mp"
    ? await loadOr404<MpLibraryArticle>(`/api/site/mp/${encodeURIComponent(articleId)}`, { signal: request.signal })
    : await loadOr404<SiteItemDetail>(`/api/site/items/${encodeURIComponent(articleId)}`, { signal: request.signal });
  return { seed: { id: seed.id, title: seed.title, href: kind === "mp" ? `/mp/articles/${seed.id}` : `/items/${seed.id}` }, turn };
}
export default function Research({ loaderData }: Route.ComponentProps) {
  const { seed } = loaderData;
  const [turns, setTurns] = useState<ResearchTurn[]>(loaderData.turn ? [loaderData.turn] : []);
  const [question, setQuestion] = useState("");
  const [scope, setScope] = useState<"article" | "source" | "all">("article");
  const [params, setParams] = useSearchParams();
  const { run, pending } = useAdminAction();
  const last = turns.at(-1);
  const busy = last?.status === "queued" || last?.status === "answering";
  useEffect(() => {
    setTurns(loaderData.turn ? [loaderData.turn] : []); setQuestion("");
  }, [seed?.id]);
  useEffect(() => {
    if (!busy || !last) return;
    const abort = new AbortController();
    const read = async () => {
      try {
        const r = await fetch(`/api/admin/research/${last.id}`, { signal: abort.signal });
        if (!r.ok) return;
        const turn = await r.json() as ResearchTurn;
        setTurns(old => old.map(t => t.id === turn.id ? turn : t));
      } catch { /* A transient polling error does not submit another paid question. */ }
    };
    // The worker writes the growing answer about every 0.4 s; reading as often shows it as it is written.
    void read(); const timer = setInterval(() => void read(), 500);
    return () => { abort.abort(); clearInterval(timer); };
  }, [busy, last?.id]);
  const submit = async () => {
    if (!seed || !question.trim()) return;
    const t = await run<ResearchTurn>("POST", "/api/admin/research", { articleId: seed.id, question, scope, previousId: last?.status === "completed" ? last.id : null }, { revalidate: false });
    if (t) { setTurns(old => [...old, t]); setQuestion(""); const next = new URLSearchParams(params); next.set("id", t.id); setParams(next, { replace: true }); }
  };
  return <AdminPage title="文章研究" subtitle="引用文章提问，结合资料理解与探索。回答由模型生成，请核对引用；每次主动提问会产生模型费用。">
    {!seed ? <Card title="从文章开始"><p className="text-[14px] text-ink-3">在任意文章详情点击“引用本文，开始研究”。</p><Link to="/mp" className="mt-4 inline-block text-accent">打开公众号资料库 →</Link></Card> : <div className="mx-auto max-w-[900px] space-y-5">
      <Card title="已引用文章"><Link className="text-[16px] font-medium text-accent" to={seed.href}>{seed.title}</Link></Card>
      {turns.map(t => <section key={t.id} className="space-y-3"><div className="rounded-card bg-bg-sunk p-5"><p className="mb-2 text-[12px] text-ink-4">你的问题</p><p className="whitespace-pre-wrap leading-7">{t.question}</p></div><Card title="研究回答"><p role="status" aria-busy={t.status === "queued" || t.status === "answering"} className="whitespace-pre-wrap text-[15px] leading-8">{t.status === "queued" ? "正在读取引用资料…" : t.status === "error" ? <>{t.answer && <>{t.answer}{"\n\n"}</>}<span className="text-hot">{t.error}</span></> : t.status === "answering" ? (t.answer ? <>{t.answer}<span className="ml-0.5 inline-block animate-pulse text-ink-4">▍</span></> : "正在思考…") : t.answer}</p>{t.references.length > 0 && <div className="mt-5 border-t border-line pt-4"><p className="mb-3 text-[12px] text-ink-4">提供给模型的引用资料</p>{t.references.map((r, i) => <details key={r.id} className="mb-3 text-[13px]"><summary className="cursor-pointer text-accent">[{i + 1}] {r.title} · {r.material === "body" ? "正文片段" : "仅摘要/标题"}{t.citations.includes(i + 1) ? " · 回答引用" : ""}</summary><p className="mt-2 whitespace-pre-wrap leading-6 text-ink-3">{r.excerpt.slice(0, 1200)}</p><Link to={r.href} className="mt-2 inline-block text-accent">打开引用文章 →</Link></details>)}</div>}</Card></section>)}
      <Card title={turns.length ? "继续追问" : "开始提问"}><label className="mb-3 flex items-center gap-3 text-[13px]">引用范围<Select value={scope} onChange={e => setScope(e.target.value as typeof scope)}><option value="article">当前文章</option><option value="source">当前文章与同一信源</option><option value="all">当前文章与全部信源</option></Select></label><p className="mb-3 text-[12px] text-ink-4">扩大范围时按问题检索相关文章，不会把整个资料库一次性输入模型。</p><Textarea rows={4} value={question} maxLength={2000} onChange={e => setQuestion(e.target.value)} placeholder="例如：这里的关键词选站方法是什么？我应该怎样开始实践？" /><div className="mt-4 flex justify-end"><Button tone="primary" disabled={busy || !question.trim()} busy={!!pending} onClick={() => void submit()}>发送问题</Button></div></Card>
    </div>}
  </AdminPage>;
}
