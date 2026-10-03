// 主动搜索（sources/search.ts）：每天北京时间 06:30 跑一轮，用搜索服务找信源之外的新线索。
// 四条线各占固定次数；每条线一半用下面的固定模板（按日期轮换），一半由模型按公开主题生成，
// 生成失败、关闭或数量不够时用模板补齐。每条线第一条用 advanced（更贵、更深），其余 basic。
// 额度是硬上限：日次数按北京自然日、月 credits 按北京自然月计，失败和重试同样占额度。
// 模板文案是草稿，上线前请站长本人确认。

export type SearchLane = "reddit" | "founder-blog" | "niche-need" | "new-product";

export interface SearchLanePlan {
  lane: SearchLane;
  /** 这条线每天的查询总数。 */
  total: number;
  /** 其中用 advanced 的条数（每条线排在最前）。 */
  advanced: number;
  /** 其中用固定模板的条数，其余交给模型；模板也负责补齐。 */
  fixed: number;
  /** 给模型看的这条线要找什么。 */
  brief: string;
  templates: string[];
}

export const SEARCH_LANES: SearchLanePlan[] = [
  {
    lane: "reddit",
    total: 6,
    advanced: 1,
    fixed: 3,
    brief: "Reddit 上 SaaS 创始人和用户的经营讨论：获客、定价、收入里程碑、平台问题、找替代品。",
    templates: [
      "reddit r/SaaS how I got my first 100 paying customers",
      "reddit r/SaaS raised prices what happened to churn",
      "reddit r/SaaS MRR milestone lessons learned",
      "reddit r/indiehackers cold email B2B SaaS what worked",
      "reddit r/smallbusiness looking for software to replace spreadsheets",
      "reddit r/startups Stripe account frozen SaaS payouts",
      "reddit r/microsaas launched revenue update",
      "reddit r/Entrepreneur SaaS customer acquisition channel that worked",
    ],
  },
  {
    lane: "founder-blog",
    total: 6,
    advanced: 1,
    fixed: 3,
    brief: "SaaS 创始人自己写的博客复盘：收入、定价调整、增长渠道、关停与出售。",
    templates: [
      "bootstrapped SaaS founder blog monthly revenue report",
      "SaaS founder blog lessons from raising prices",
      "indie hacker blog how we reached 10k MRR",
      "SaaS founder postmortem why we shut down",
      "B2B SaaS founder blog first sales hire lessons",
      "solo founder SaaS churn reduction case study",
      "micro SaaS acquisition story founder blog",
      "SaaS founder SEO content strategy results",
    ],
  },
  {
    lane: "niche-need",
    total: 4,
    advanced: 1,
    fixed: 2,
    brief: "细分行业用户说出的软件需求、抱怨和找替代品：可能的产品机会。",
    templates: [
      "dental clinic owners complain about practice management software alternative",
      "accountants frustrated with manual bank reconciliation looking for tool",
      "property managers need simple tenant communication software",
      "marketing agencies looking for client reporting tool alternative",
      "ecommerce sellers inventory sync tool complaints",
      "freelancers looking for simple invoicing and time tracking app",
    ],
  },
  {
    lane: "new-product",
    total: 4,
    advanced: 1,
    fixed: 2,
    brief: "新上线的 SaaS 产品与追查：Show HN、Product Hunt 首发、AI 小工具、开源替代品。",
    templates: [
      "Show HN new SaaS launch this week",
      "Product Hunt launch B2B SaaS today",
      "new AI SaaS tool launched for small businesses",
      "open source alternative to popular SaaS launched",
      "new Shopify app launched for merchants",
      "indie developer launched subscription app pricing",
    ],
  },
];

/** 硬上限：日 basic 16 次、advanced 4 次（北京自然日），月 900 credits（北京自然月，余量留给站长在平台的其他用途）。 */
export const SEARCH_QUOTA = { basicPerDay: 16, advancedPerDay: 4, creditsPerMonth: 900 } as const;

/** 每次搜索最多取几条结果。 */
export const SEARCH_MAX_RESULTS = 5;
