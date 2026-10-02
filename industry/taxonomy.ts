// 这个行业的分类体系：类别、标签词表、公司（主体）名录，以及防止张冠李戴的身份词典。
// 模型按这里的词表打标签，主题页（topics.json）按标签归类，筛选栏按类别分组。
// 换行业时：类别的 key 会出现在网址里（/all?category=…），上线后就不要再改；标签和名录可以随时增减。

/**
 * 网页上的类别（筛选栏、卡片角标、RSS 分类订阅）。key 是网址和接口里的身份，上线后不要改。
 * section 是日报里的分节标题（几个类别可以共用一节，按这里的顺序排）；guide 告诉模型怎么归类。
 * 没归上类的资料在日报里放进第一个 key 为 industry 的类别所在的节（没有就放最后一节）。
 */
export const CATEGORIES = [
  { key: "products", label: "产品发现", section: "产品发现", guide: "新产品、新工具和重要功能的上线与发布，独立开发者和小团队的作品展示（Show HN、上线帖等），以及产品定位和形态的变化" },
  { key: "growth", label: "收入与获客", section: "收入与获客", guide: "收入、定价、付费转化、留存、获客渠道、SEO 与内容营销、销售与分发打法，以及创始人的经营复盘（收入数字多为作者自报）" },
  { key: "problems", label: "用户问题", section: "用户问题", guide: "用户在社区里提出的痛点、求助、抱怨、找替代品和愿意付费的需求，以及对现有工具的不满" },
  { key: "market", label: "市场变化", section: "市场变化", guide: "平台与渠道规则、支付与合规、竞争格局、融资并购与关停、价格与成本变化、大公司动作和行业趋势" },
] as const;

/**
 * 内容理解一步给每篇资料判的“内容类型”（写在 prompts/content-understanding.md 里，改了类型要同步改那份提示词）。
 * 评分提示词（prompts/selection-score.md）按类型给五个维度不同的权重。
 * 类型的 key 和权重沿用示例站，含义在两份提示词里按出海 SaaS 重新解释；换权重前先用标注样本校准。
 */
export const ITEM_TYPES = ["model_release", "product_launch", "tool_or_prompt", "research_paper", "industry_event", "opinion_analysis", "tutorial_explainer"] as const;

// ── 标签词表 ────────────────────────────────────────────────────────────────────────────

/** 每篇资料的第一个标签必须是这些“分类标签”之一。 */
export const CATEGORY_TAGS = [
  "产品发布", "经营复盘", "定价/变现", "获客/增长", "用户痛点", "需求求助", "平台/渠道", "支付/合规", "融资/并购", "竞争/格局", "方法/教程", "观点/趋势",
  "其他",
] as const;

/** 可选的主题标签。 */
export const TOPIC_TAGS = [
  "AI 产品", "独立开发", "B2B", "B2C", "SEO", "内容营销", "冷启动", "社区运营", "订阅制", "买断制", "开源", "浏览器插件", "移动应用", "无代码", "开发者工具",
] as const;

/** 可选的实体标签（公司、机构、平台）。 */
export const ENTITY_TAGS = ["Stripe", "Paddle", "Lemon Squeezy", "Shopify", "Product Hunt", "Reddit", "Hacker News", "OpenAI", "Google", "Apple"] as const;

/** 模型常写的近义词，统一成词表里的写法。 */
export const TAG_SYNONYMS: Readonly<Record<string, string>> = {
  发布: "产品发布", 上线: "产品发布", 产品: "产品发布", 新产品: "产品发布", "show hn": "产品发布",
  复盘: "经营复盘", 收入: "经营复盘", 营收: "经营复盘", 收入复盘: "经营复盘", MRR: "经营复盘", ARR: "经营复盘",
  定价: "定价/变现", 变现: "定价/变现", 付费: "定价/变现", 订阅: "定价/变现",
  获客: "获客/增长", 增长: "获客/增长", 营销: "获客/增长", 分发: "获客/增长", 推广: "获客/增长", 销售: "获客/增长",
  痛点: "用户痛点", 抱怨: "用户痛点", 吐槽: "用户痛点", 求助: "需求求助", 需求: "需求求助", 找工具: "需求求助", 替代品: "需求求助",
  平台: "平台/渠道", 渠道: "平台/渠道", 平台政策: "平台/渠道", 应用商店: "平台/渠道",
  支付: "支付/合规", 合规: "支付/合规", 监管: "支付/合规", 政策: "支付/合规", 税务: "支付/合规",
  融资: "融资/并购", 收购: "融资/并购", 并购: "融资/并购", 投资: "融资/并购", 关停: "融资/并购",
  竞争: "竞争/格局", 竞品: "竞争/格局", 格局: "竞争/格局", 市场: "竞争/格局",
  教程: "方法/教程", 方法: "方法/教程", 指南: "方法/教程", 打法: "方法/教程", 实践: "方法/教程",
  观点: "观点/趋势", 趋势: "观点/趋势", 现象: "观点/趋势", 行业: "观点/趋势",
};

/** 模型漏了分类标签时，按内容类型补一个。 */
export const CATEGORY_BY_ITEM_TYPE: Readonly<Record<string, string>> = {
  model_release: "平台/渠道", product_launch: "产品发布", tool_or_prompt: "方法/教程", research_paper: "观点/趋势",
  industry_event: "融资/并购", opinion_analysis: "经营复盘", tutorial_explainer: "方法/教程",
};

// ── 公司与主体 ──────────────────────────────────────────────────────────────────────────

/** 公司主题：id → 显示名、卡片上显示的标签（null 表示只用 entity:<id> 归类）、别名。 */
export const ENTITIES: Record<string, { name: string; displayTag: string | null; aliases: string[] }> = {
  stripe: { name: "Stripe", displayTag: "Stripe", aliases: ["Stripe"] },
  paddle: { name: "Paddle", displayTag: "Paddle", aliases: ["Paddle"] },
  "lemon-squeezy": { name: "Lemon Squeezy", displayTag: "Lemon Squeezy", aliases: ["Lemon Squeezy", "LemonSqueezy"] },
  shopify: { name: "Shopify", displayTag: "Shopify", aliases: ["Shopify"] },
  "product-hunt": { name: "Product Hunt", displayTag: "Product Hunt", aliases: ["Product Hunt", "ProductHunt"] },
  openai: { name: "OpenAI", displayTag: "OpenAI", aliases: ["OpenAI", "ChatGPT", "GPT"] },
  google: { name: "Google", displayTag: "Google", aliases: ["Google", "谷歌", "Gemini"] },
  apple: { name: "Apple", displayTag: "Apple", aliases: ["Apple", "App Store", "苹果"] },
};

/**
 * 身份词典：摘要和标题里出现的公司，必须在原文里也出现过，否则退回原标题、丢掉摘要（防止模型张冠李戴）。
 * 行业没有这个问题时可以留空数组。
 */
export const IDENTITY_LEXICON: ReadonlyArray<{ id: string; name: string; patterns: RegExp[] }> = [
  { id: "stripe", name: "Stripe", patterns: [/\bstripe\b/i] },
  { id: "paddle", name: "Paddle", patterns: [/\bpaddle\b/i] },
  { id: "lemon-squeezy", name: "Lemon Squeezy", patterns: [/lemon\s?squeezy/i] },
  { id: "shopify", name: "Shopify", patterns: [/shopify/i] },
  { id: "product-hunt", name: "Product Hunt", patterns: [/product\s?hunt/i] },
  { id: "openai", name: "OpenAI", patterns: [/openai|chatgpt|\bgpt-?[o\d]/i] },
  { id: "anthropic", name: "Anthropic", patterns: [/anthropic|\bclaude\b/i] },
  { id: "google", name: "Google", patterns: [/google|\bgemini\b|谷歌/i] },
  { id: "apple", name: "Apple", patterns: [/\bapple\b|app\s?store|苹果/i] },
  { id: "microsoft", name: "Microsoft", patterns: [/microsoft|微软/i] },
  { id: "amazon", name: "Amazon / AWS", patterns: [/amazon|\baws\b|亚马逊/i] },
];

/** 这些域名上的文章，发布方就是对应的公司（托管平台如 GitHub、Product Hunt、Reddit 不算）。 */
export const PUBLISHER_DOMAINS: ReadonlyArray<{ entityId: string; domains: readonly string[] }> = [
  { entityId: "stripe", domains: ["stripe.com"] },
  { entityId: "paddle", domains: ["paddle.com"] },
  { entityId: "lemon-squeezy", domains: ["lemonsqueezy.com"] },
  { entityId: "shopify", domains: ["shopify.com"] },
  { entityId: "openai", domains: ["openai.com"] },
  { entityId: "google", domains: ["blog.google"] },
  { entityId: "apple", domains: ["apple.com"] },
];

/** 原文里的这些写法也算提到了对应公司。 */
export const IDENTITY_CONTEXT_ALIASES: ReadonlyArray<{ entityId: string; pattern: RegExp }> = [];
