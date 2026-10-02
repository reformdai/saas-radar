// One selected report on 今日发现: what was fetched of the original, how it arrived, its source time
// beside the site's discovery time, the reason and the open question kept apart, and the original link.
import { memo } from "react";
import { ARRIVAL_LABELS, MATERIAL_LABELS, type DiscoveryItem as Item } from "@aihot/contracts/site";
import { CATEGORY_LABELS } from "@aihot/contracts/taxonomy";
import { Badge } from "../../components/ui/Badge";
import { IntentLink } from "../../components/ui/IntentLink";
import { ScoreLabel } from "../../components/ui/Score";
import { IconExternal } from "../../components/icons";
import { fullDateTime } from "../../lib/format";
import { SourceLine, StarButton } from "./parts";

/** Revenue figures in this category are mostly the author's own claims. */
const SELF_REPORTED_CATEGORY = "growth";

export const DiscoveryItem = memo(function DiscoveryItem({ item, read = false, onOpen }: { item: Item; read?: boolean; onOpen?: (id: string) => void }) {
  const material = MATERIAL_LABELS[item.material];
  const arrival = item.arrival === "live" ? null : ARRIVAL_LABELS[item.arrival];
  return (
    <article className="relative min-w-0 lg:card lg:card-hover lg:px-[18px] lg:pb-[14px] lg:pt-[15px]" data-item-id={item.id}>
      <header className="flex min-h-[18px] flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px] leading-[18px] text-ink-4">
        <SourceLine item={item} className="text-ink-4" />
        {item.category && <span className="shrink-0">{CATEGORY_LABELS[item.category]}</span>}
        <Badge tone={item.material === "body" ? "ok" : "neutral"} title={material.hint}>{material.label}</Badge>
        {arrival && <Badge tone="amber" title={arrival.hint}>{arrival.label}</Badge>}
        <span className="ml-auto flex shrink-0 items-center gap-1.5 pl-2">
          <ScoreLabel score={item.score} compact />
          <span className="relative z-10 -my-1 inline-flex">
            <StarButton item={item} />
          </span>
        </span>
      </header>

      <h3 className={`mt-2 text-[17px] font-bold leading-[1.55] lg:font-[650] ${read ? "text-ink-4" : "text-ink"}`}>
        <IntentLink to={`/items/${item.id}`} onClick={() => onOpen?.(item.id)} className="after:absolute after:inset-0 after:content-['']">
          {item.title}
        </IntentLink>
      </h3>
      {item.summary && <p className="mt-1.5 text-[14.5px] leading-[1.75] text-ink-3 lg:mt-2 lg:text-[15px]">{item.summary}</p>}
      {item.category === SELF_REPORTED_CATEGORY && <p className="mt-1.5 text-[12px] text-ink-4">收入与经营数字多为作者自报，未经核验；请看原文确认时间段和口径。</p>}

      <p className="mt-2 flex flex-wrap gap-x-3 gap-y-0.5 text-[12px] text-ink-4">
        <span>原文发表 <span className="num">{item.publishedAt ? fullDateTime(item.publishedAt) : "时间未知"}</span></span>
        <span>本站发现 <span className="num">{fullDateTime(item.discoveredAt)}</span></span>
        <a href={item.originalUrl} target="_blank" rel="noopener noreferrer" className="relative z-10 inline-flex items-center gap-0.5 text-accent hover:underline">
          原文 <IconExternal size={12} />
        </a>
      </p>

      {(item.reason || item.researchQuestion) && (
        <dl className="mt-2.5 space-y-1.5 rounded-control bg-bg-sunk px-3 py-2 text-[13px] leading-[1.65] dark:bg-bg-muted/60 lg:mt-3">
          {item.reason && (
            <div className="flex gap-1.5">
              <dt className="shrink-0 text-ink-4">推荐理由</dt>
              <dd className="text-ink-3">{item.reason}</dd>
            </div>
          )}
          {item.researchQuestion && (
            <div className="flex gap-1.5">
              <dt className="shrink-0 text-ink-4">待调查</dt>
              <dd className="text-ink-2">{item.researchQuestion}</dd>
            </div>
          )}
        </dl>
      )}
    </article>
  );
});
