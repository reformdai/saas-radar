import { useMemo } from "react";
import { Link, data as withHeaders, useLoaderData, useNavigation } from "react-router";
import type { Route } from "./+types/discover";
import type { DiscoveriesResponse, DiscoveryItem as Item } from "@aihot/contracts/site";
import { isCategoryKey } from "@aihot/contracts/taxonomy";
import { CategoryTabs } from "../features/feed/Filters";
import { loadOr404, queryString, releaseBoundCache } from "../lib/api.server";
import { pageMeta } from "../lib/seo";
import { beijingDate } from "../lib/format";
import { markRead, useReadSet } from "../lib/local-state";
import { EmptyState } from "../components/ui/Page";
import { IconChevronRight } from "../components/icons";
import { DayHeader, TimelineSlot } from "../features/feed/Timeline";
import { DiscoveryItem } from "../features/feed/DiscoveryItem";

export async function loader({ request }: Route.LoaderArgs) {
  const params = new URL(request.url).searchParams;
  const cursor = params.get("cursor")?.trim() || null;
  const rawCategory = params.get("category");
  const category = rawCategory && isCategoryKey(rawCategory) ? rawCategory : null;
  const upstream = new Headers();
  const data = await loadOr404<DiscoveriesResponse>(`/api/site/discoveries${queryString({ cursor, category })}`, { responseHeaders: upstream, signal: request.signal });
  return withHeaders({ data, paged: !!cursor }, { headers: releaseBoundCache(data.refreshAt, 60, Date.now(), upstream) });
}

export function meta({ loaderData }: Route.MetaArgs) {
  return pageMeta({
    title: "今日发现",
    description: "按本站发现时间排列的精选材料，标明原文发表时间、材料获取状态和待调查问题。",
    path: "/discover",
    noindex: !!loaderData?.paged,
  });
}

export function headers({ loaderHeaders }: Route.HeadersArgs) {
  return loaderHeaders;
}

function discoveryHref(category: string | null, cursor?: string | null) {
  const params = new URLSearchParams();
  if (category) params.set("category", category);
  if (cursor) params.set("cursor", cursor);
  const query = params.toString();
  return query ? `/discover?${query}` : "/discover";
}

export default function DiscoverPage() {
  const { data, paged } = useLoaderData<typeof loader>();
  const readSet = useReadSet();
  const navigation = useNavigation();
  const busy = navigation.state === "loading" && navigation.location?.pathname === "/discover";
  const category = data.filters.category;
  const latestHref = discoveryHref(category);
  const today = beijingDate(Date.now());
  const days = useMemo(() => {
    const out: Array<{ day: string; items: Item[] }> = [];
    for (const it of data.items) {
      const d = beijingDate(it.discoveredAt);
      const last = out[out.length - 1];
      if (last && last.day === d) last.items.push(it);
      else out.push({ day: d, items: [it] });
    }
    return out;
  }, [data.items]);

  return (
    <div className="pb-6">
      <h1 className="pb-2 pt-5 text-[22px] font-bold text-ink lg:pt-0 lg:text-[24px] lg:font-semibold">今日发现</h1>
      <p className="mb-4 max-w-[680px] text-[13px] leading-[1.7] text-ink-3">
        新发现的精选线索，按发现时间排列；旧文也可值得读。近期动态请看<Link to="/" className="text-accent hover:underline">精选</Link>。
      </p>
      <CategoryTabs base="/discover" category={category} firstParty={false} layoutId="discover-category" className="mb-4" />
      <p role="status" aria-live="polite" className="mb-2 min-h-5 text-[12px] text-ink-4">{busy ? "正在加载…" : ""}</p>
      <div aria-busy={busy} className={busy ? "opacity-60" : ""}>
      {days.length === 0 ? (
        <div className="lg:card">
          <EmptyState title={category ? "这个分类还没有入选的发现" : "还没有入选的发现"}>
            {category ? <Link to="/discover" className="text-accent hover:underline">查看全部发现</Link> : "信源抓取和分析完成后，入选的材料会出现在这里。"}
          </EmptyState>
        </div>
      ) : (
        days.map(({ day, items }) => (
          <section key={day} aria-label={day}>
            <DayHeader day={day} today={today} count={null} />
            <ol className="lg:pt-1">
              {items.map((it) => (
                <TimelineSlot key={it.id} at={it.discoveredAt}>
                  <DiscoveryItem item={it} read={readSet.has(it.id)} onOpen={markRead} />
                </TimelineSlot>
              ))}
            </ol>
          </section>
        ))
      )}

      <nav aria-label="分页" className="mt-6 flex justify-center gap-2">
        {paged && (
          <Link to={latestHref} className="inline-flex h-9 items-center rounded-full border border-line-strong bg-surface px-4 text-[13px] text-ink-3 hover:border-ink-4 hover:text-ink">
            回到最新
          </Link>
        )}
        {data.nextCursor ? (
          <Link to={discoveryHref(category, data.nextCursor)} className="inline-flex h-9 items-center gap-0.5 rounded-full border border-line-strong bg-surface px-4 text-[13px] text-ink-3 hover:border-ink-4 hover:text-ink">
            更早的发现 <IconChevronRight size={14} />
          </Link>
        ) : (
          days.length > 0 && <span className="text-[12px] text-ink-4">已经到底了</span>
        )}
      </nav>
      </div>
    </div>
  );
}
