// 站点身份和读者看得到的文案。换成你的行业时，先改这个文件。
// 网页和后端都读它；改完重新构建（docker compose up --build）即可生效。
// 域名不在这里：部署时用环境变量 SITE_URL 设置。

export const SITE = {
  /** 站名：导航、页面标题、分享图、RSS、MCP、后台都用它。 */
  name: "出海 SaaS 雷达",
  /**
   * 行业词：拼进默认说法里，比如“AI 日报”“AI 动态”。
   * 改成“法律”“HR”“黄金”之类，页面上就会变成“法律日报”“法律动态”。
   */
  subject: "SaaS",
  /** 首页的完整标题（浏览器标签、搜索结果）。 */
  homeTitle: "出海 SaaS 雷达 — 产品、收入获客、用户问题与市场变化",
  /** 一句话介绍：搜索引擎、分享卡片、RSS、llms.txt 会用。 */
  description: "个人使用的出海 SaaS 信息雷达：从创始人博客、Reddit 与 Hacker News 的公开搜索收集材料，用模型筛选和摘要，保留原文链接、发表时间和待调查问题。",
  /** 首页左上角和侧边栏下面的一行小字。 */
  tagline: "开工前看一眼的出海 SaaS 线索",
  /** 界面语言（HTML lang、og:locale）。 */
  locale: "zh-CN",
  /** 默认域名，只在没设置 SITE_URL 时使用。 */
  defaultUrl: "http://localhost:3000",
  /**
   * MCP 工具名的前缀（小写字母、数字、下划线），工具会叫 myhot_get_latest、myhot_search……
   * 已经有人接入后就不要再改。
   */
  mcpPrefix: "saasradar",
  /** 对外联系邮箱（选填）：使用规则、llms.txt、响应头里会写。 */
  contactEmail: null as string | null,
  /** 页脚的一行小字（选填）。 */
  footerNote: "个人自用的信息雷达：摘要与线索，不替代阅读原文",
  /** 中国大陆网站的 ICP 备案号（选填），填了就显示在页脚并链接到工信部备案系统。 */
  icp: null as string | null,
  /** 结构化数据里的网站运营者（搜索引擎用）。 */
  organization: {
    name: "出海 SaaS 雷达",
    /** 创始人（选填）：{ name, url, description }。 */
    founder: null as null | { name: string; url?: string; description?: string },
  },
  /** 抓取信源时报上的名字（User-Agent 里用），不要冒用别的站。 */
  crawlerName: "SaaSRadarBot",
} as const;

/** 关于页的文案。数字（信源数、收录数、精选数、日报期数）来自站内实时统计，不用写在这里。 */
export const ABOUT = {
  kicker: `关于 ${SITE.name}`,
  /** 大标题：第一行正常颜色，第二行强调色。 */
  headline: ["出海 SaaS 的线索很散，", "先收拢，再自己判断。"] as [string, string],
  /** 标题下面的一段话。{sources} 会换成实时的信源数。 */
  lead: `${SITE.name} 盯着 {sources} 个公开信源：抓取、归并、打分、精选，保留原文链接和待调查的问题，判断留给自己。`,
  /** 信源河动画下面的四个环节。 */
  steps: {
    collect: "创始人博客的订阅源、Reddit 搜索订阅源和 Hacker News 公开搜索接口；只看配置好的关键词，不是全网搜索。",
    store: "抓到的都存下来，同一件事的讨论归到一起；卡片标明原文发表时间、本站发现时间，以及拿到的是摘要还是正文。",
    select: "模型先看是不是出海 SaaS 的事、有没有实际信息，再写中文标题、摘要、推荐理由和一个待调查问题；收入数字按作者自报处理。",
    publish: "“今日发现”按发现时间列出入选的材料，旧文标明原文时间；每天 08:00 出日报，周一出周报，每月 1 日出月报。",
  },
  /**
   * 作者块（选填），null 就不显示。
   * avatarSourceId：一个 X 账号信源的 id，头像取它的（选填）。
   * 二维码在后台“设置”里上传，或者放进 industry/brand/contact/；没有二维码就不显示那张卡片。
   */
  maker: null as null | {
    name: string;
    greeting: string[];
    avatarSourceId?: string | null;
    wechat?: { title: string; note: string };
    feishu?: { title: string; note: string };
  },
  /** 页面底部的版权与下架说明（结尾会接“反馈页”的链接）。 */
  copyright: `${SITE.name} 是个人使用的聚合摘要和阅读索引，原文版权归各来源所有；摘要里的收入与经营数字多为作者自报，未经核验。如果你是来源方，希望更正、下架或调整展示方式，可以通过`,
} as const;

/** “AI 日报”这类说法：行业词和名词之间，英文词加空格，中文词不加。 */
export function withSubject(noun: string): string {
  return /[A-Za-z0-9]$/.test(SITE.subject) ? `${SITE.subject} ${noun}` : `${SITE.subject}${noun}`;
}

/** “按主题看 AI”“往期 AI 日报”这类说法：行业词接在中文后面，英文词前加空格，中文词不加；noun 照 withSubject 接上。 */
export function subjectAfter(text: string, noun?: string): string {
  const gap = /^[A-Za-z0-9]/.test(SITE.subject) ? " " : "";
  return `${text}${gap}${noun ? withSubject(noun) : SITE.subject}`;
}
