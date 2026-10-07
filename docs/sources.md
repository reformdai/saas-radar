# 信源

信源在后台“信源”页管理：新建、试抓一次看看抓到什么、改频率、启停、看失败原因和最近的条目。首次启动时，`industry/sources.json` 里的示范信源会被导入。

## 六种信源

| 类型 | 适合 | 需要 |
|---|---|---|
| `rss` | 有 RSS / Atom 的博客、媒体、Substack、公众号转 RSS 服务 | 无 |
| `web_list` | 没有 RSS 的网页列表（新闻页、博客列表、更新日志） | 写选择器；按需配置 Jina Reader 渲染（按次计费） |
| `json_list` | 返回 JSON 的接口（GitHub Releases 等） | 写字段路径 |
| `x_search` | X（推特）账号 | SocialData 的 key，按请求计费 |
| `mp_account` | 微信公众号 | 列表：极致了（Dajiala）或 EveryInfra（万有引擎）的 key，按请求计费；正文免费读取文章页 |
| `external` | 你自己的脚本推送进来的内容 | `INGEST_TOKEN`，见下文 |

`json_list` 的地址或配置可能携带凭据，只跟随同源重定向（协议、主机和端口都相同）。若接口搬到另一个来源，请直接更新信源地址；不要依赖跨源跳转传递认证信息。

每种信源认哪些配置项写在 [`config-keys.ts`](../packages/backend/src/sources/config-keys.ts)。填了不认识的配置项，保存会被拒绝、抓取会直接失败并在后台显示原因，不会悄悄退回通用解析。


## 先预览，再创建

进入 `/admin/sources/new`，填写 ID、名称，选择类型，再把下文对应的 JSON 填入“采集配置（JSON）”。这里填的是配置对象，不要包上 `kind` 或 `config`。切换类型会重置配置，先选类型再粘贴。

`rss`、`web_list`、`json_list`、`x_search` 可以点“预览抓取”：显示条目总数和前 20 条的标题、原文链接、发布时间、摘要，不把条目存入文章库。检查抓到的是文章而不是导航，日期与原文一致，再点“创建”。预览不等于完成生产采集，也不经过后续详情补齐、精选和公开发布流程。

预览仍会发出抓取请求；X 和 Jina 预览也可能产生费用，经过付费回执和预算。`COLLECT_ENABLED=false` 只关闭后台自动采集，不能用它来保证手动预览不访问外部服务。下面的本地 HTML/JSON 示例不需要任何 API key。
### rss

```json
{ "feedUrl": "https://example.com/feed.xml" }
```

可选：`summaryIsBody`（订阅里的摘要就是全文）、`allowCategories` / `denyCategories`（按订阅里的分类过滤）。

### web_list

支持普通 CSS 选择器，`div` 列表也能采集。关键是 `itemSelector` 要选中**每条新闻**，而不是包住所有新闻的容器。例如：

```html
<div class="news-list">
  <div class="news-item">
    <h2><a href="/posts/first">第一条示例新闻</a></h2>
    <time datetime="2026-10-01T09:00:00+08:00">10 月 1 日</time>
  </div>
  <div class="news-item">
    <h2><a href="/posts/second">第二条示例新闻</a></h2>
    <time datetime="2026-10-01T10:00:00+08:00">10 月 1 日</time>
  </div>
</div>
```

对应配置（`example.com` 是占位地址，换成目标网页；可运行版本见[本地示例](#本地跑通-htmljson-示例)）：

```json
{
  "url": "https://example.com/news",
  "parseMode": "html",
  "itemSelector": ".news-list > .news-item",
  "linkSelector": "h2 a",
  "titleSelector": "h2 a",
  "publishedAtSelector": "time",
  "allowUrlPrefixes": ["https://example.com/posts/"]
}
```

- `itemSelector` 在整个页面找条目；`linkSelector`、`titleSelector` 在每个条目内取第一个匹配节点，也可以匹配条目自身。选 `.news-list` 只会得到一个容器，通常只取到第一条新闻；只写 `div` 又会混入嵌套容器。要选重复出现的新闻节点。
- 链接取自 `href`；`/posts/first` 等相对链接按列表 `url` 解析，也可用 `baseUrl` 指定基准地址。标题取节点文字。重复链接会合并，指向列表自身的链接通常会跳过。
- 日期在条目内查找 `publishedAtSelector`，依次读取 `datetime` 属性、`title` 属性、文字。没有时区的日期时间可用 `publishedAtUtcOffset`（默认 `+08:00`）；自带时区的时间保留原时区语义，纯 `YYYY-MM-DD` 按 UTC 零点读。
- `parseMode`：普通网页默认 `html`；`markdown` 按 Markdown 链接读；`docusaurus_changelog` 读更新日志标题。需要 Jina 时，显式把 `url` 写成 `https://r.jina.ai/https://目标站/路径` 并配置 `JINA_API_KEY`，不是抓不到就自动切换。Jina 默认返回 Markdown；要继续使用 CSS 选择器，显式设 `parseMode: "html"`。
- `detail`：列表缺日期、标题或摘要时抓详情页补齐（`publishedAtSelector`、`titleSelector`、`summarySelector` 等）。
- `allowUrlPrefixes` / `denyUrlPrefixes`：只收某些路径下的文章。

### json_list

假设接口返回下面的结构，`itemsPath` 指向数组，其他字段路径相对**每个数组元素**填写。路径用点分隔，不是 JSONPath，不写 `$` 或 `[*]`。

```json
{
  "data": {
    "items": [
      {
        "id": "first",
        "title": "第一条示例新闻",
        "url": "https://example.com/posts/first",
        "summary": "第一条新闻的摘要。",
        "published_at": "2026-10-01T09:00:00+08:00"
      }
    ]
  }
}
```

对应配置：

```json
{
  "url": "https://example.com/api/news",
  "mode": "json_api",
  "itemsPath": "data.items",
  "titlePaths": ["title"],
  "urlTemplate": "{raw:url}",
  "summaryPaths": ["summary"],
  "publishedAtPath": "published_at",
  "externalIdPath": "id"
}
```

- 接口本身返回数组时，省略 `itemsPath`。`titlePaths`、`summaryPaths`、`authorPaths` 是候选路径数组，按顺序取第一个非空值，例如 `["title", "name"]`。
- 已有完整网址时用 `{raw:url}`；只有 slug 时可用 `https://example.com/posts/{slug}`。`{字段路径}` 会编码字段值，`{raw:字段路径}` 原样插入。JSON 列表不会自动把相对网址补成绝对网址，模板应产出完整的 HTTP(S) 地址。
- 日期建议返回带时区的 ISO 字符串；数字时间戳分别设 `publishedAtUnit: "epoch_s"`（秒）或 `"epoch_ms"`（毫秒），`20261001` 这类日期设 `"yyyymmdd"`。
- 缺少标题或无法生成链接的条目会跳过。非空数组全部映射失败时，会报 `no items mapped (check title/url paths)`；路径不是数组时，会报 `items path did not resolve to an array`。

### 本地跑通 HTML/JSON 示例

仓库提供两份虚构示例：[news.html](examples/sources/news.html) 和 [news.json](examples/sources/news.json)，各有两条新闻。它们用于核对选择器和字段映射，不是运营信源；示例文章链接不提供正文。

在仓库根目录、Node.js 24.11 以上运行以下命令。服务只监听本机，只提供这两份文件；用 `Ctrl+C` 停止。

```bash
node --input-type=module -e '
import http from "node:http";
import { readFileSync } from "node:fs";
const files = {
  "/news.html": ["text/html; charset=utf-8", readFileSync("docs/examples/sources/news.html")],
  "/news.json": ["application/json", readFileSync("docs/examples/sources/news.json")]
};
http.createServer((req, res) => {
  const file = files[req.url];
  res.writeHead(file ? 200 : 404, { "content-type": file ? file[0] : "text/plain" });
  res.end(file ? file[1] : "Not found");
}).listen(8787, "127.0.0.1");'
```

在同一台机器上，按[非 Docker 部署方式](deploy.md#不用-docker)运行开发 API 和网页，保持采集、模型、飞书和 IndexNow 开关关闭，不启动 worker。仅为此次本机示例，在开发 API 进程设置 `ALLOW_PRIVATE_NETWORK_FETCH=true` 后重启；默认禁止抓内网地址，生产环境拒绝启用此项，验证后移除。若 API 在容器或另一台服务器，`127.0.0.1` 指向它自己，此命令的地址不能直接用于该部署。

分别选择 `web_list`、`json_list`，粘贴配置并点“预览抓取”，无需创建信源：

```json
{
  "url": "http://127.0.0.1:8787/news.html",
  "parseMode": "html",
  "itemSelector": ".news-list > .news-item",
  "linkSelector": "h2 a",
  "titleSelector": "h2 a",
  "publishedAtSelector": "time",
  "allowUrlPrefixes": ["http://127.0.0.1:8787/posts/"]
}
```

```json
{
  "url": "http://127.0.0.1:8787/news.json",
  "mode": "json_api",
  "itemsPath": "data.items",
  "titlePaths": ["title"],
  "urlTemplate": "http://127.0.0.1:8787/posts/{id}",
  "summaryPaths": ["summary"],
  "publishedAtPath": "published_at",
  "externalIdPath": "id"
}
```

两次都应显示 **2 条**，依次为下表内容。JSON 示例还显示对应摘要，HTML 示例没有配置摘要提取。预览 API 的日期是 UTC，后台界面按 `+08:00` 显示为 09:00 和 10:00。

| 标题 | 原文链接 | 预览 API 的 publishedAt |
|---|---|---|
| 第一条示例新闻 | `http://127.0.0.1:8787/posts/first` | `2026-10-01T01:00:00.000Z` |
| 第二条示例新闻 | `http://127.0.0.1:8787/posts/second` | `2026-10-01T02:00:00.000Z` |

可以把 HTML 的 `itemSelector` 暂改成 `.news-list` 对照：只会返回第一条。改回 `.news-list > .news-item` 后恢复两条，这就是“列表容器”和“每条新闻”的区别。

抓真实网页时先看原始 HTTP 响应中有没有新闻节点。普通 HTML 模式不执行 JavaScript；浏览器里看得到、响应里没有的内容，不能靠换一个 CSS 选择器生成。优先找 RSS 或 JSON 接口，或按需配置 Jina / 自己维护的外部采集。`no items matched (html)` 还可能是选择器不匹配、没有 `href` 或标题、链接被前缀规则过滤；先核对响应与配置，不必先更换采集器。

### x_search

这类信源使用 SocialData 搜索，不是把 X 个人主页 URL 填入网页列表。以 `https://x.com/SomeAccount` 为例，取用户名 `SomeAccount`，不要包含 `@` 或整段 URL：

```json
{ "query": "from:SomeAccount -filter:replies", "searchType": "Latest" }
```

`SomeAccount` 是占位用户名，换成你要关注的真实账号。`-filter:replies` 排除回复；`Latest` 按最新内容查找。

在后端运行环境的 `.env` 配置 `SOCIALDATA_API_KEY`，重启 API（预览）和 worker（定时采集）后生效；不要把 key 写进信源 JSON 或提交到仓库。先在后台“设置 → 预算”检查 SocialData 额度，再按需预览。未配置 key 会报 `SOCIALDATA_API_KEY is not configured`；服务拒绝请求或预算熔断时看后台错误原因。预览可能有付费请求，本文不要求用真实服务验证，结果取决于账号和服务当时的返回。

生产自动采集时，普通账号会被自动合并成一次搜索（每次最多二十几个账号），省请求数；单个信源的手动预览不是合并采集。

### mp_account

```json
{ "ghid": "gh_xxxxxxxx", "nickname": "公众号名称", "listProvider": "dajiala" }
```

每个公众号按它的抓取间隔检查一次（查列表按次计费），新文章的正文直接读取公开的文章页（`mp.weixin.qq.com`，不需要 key、不计费）。

列表服务商 `listProvider` 可选 `dajiala`（默认，旧配置无需修改）或 `everyinfra`，也可在后台新建/编辑信源的下拉框选择。EveryInfra（万有引擎）需要后端 `EVERYINFRA_API_KEY`，约 ¥0.04 一次，按实际 USD 账单记录费用。它没有翻页参数，一次只给最近的一批（官方目录写上限 160，实测异步可到 175–199 篇），更早的文章拿不到。日常检查用同步请求，返回篇数不稳定（同一账号实测 10–160 篇），对增量采集够用；历史归档用异步请求，会等完整结果（实测 175–199 篇，回溯约一年）。不会因失败自动调用另一家产生额外费用。手动与定时检查共享同一十分钟窗口的列表回执。

用极致了查列表需要在后端 `.env` 配置 `DAJIALA_KEY`，`ghid` 换成公众号原始 ID。

读取文章页有全局限流，避免本机 IP 被微信封：所有进程合起来，两次请求至少间隔 `WECHAT_PAGE_INTERVAL_SECONDS`（默认 20 秒，再随机加最多一半），也就是每分钟 2～3 次。一旦遇到验证页、“未知错误”页或 HTTP 403/429，所有文章页请求暂停 1 小时，期间一个都不发。日常检查最多等 2 分钟排队，排不上下次再试；历史归档最多等 10 分钟。

正文读不到时不会改用付费接口：遇到微信的“环境异常”验证页、服务器错误或超时，文章先只保存标题和摘要，之后的检查再重试（最多 3 次、发布 3 天内）；文章已删除或不是图文消息时直接只保留标题和摘要。配置字段用上面的 `ghid` / `nickname`，不要写成 `biz` / `name`。当前 `mp_account` 不支持“预览抓取”；`external` 也不支持主动试抓，按下方推送接口接入。

## 分级、参与方式与全文

- **分级** `tier`：`T1` 官方一手（官网、官方博客、机构）、`T1_5` 官方账号与准官方创作者、`T2` 媒体与个人、`EXCLUDE_MP` 不参与精选。入选门槛按分级不同（`industry/selection.ts`）。
- **参与方式** `participation_mode`：`editorial` 进精选和全部动态；`hot_signal` 不单独展示，只作为“大家在讨论什么”的热度证据；`isolated` 不进任何公开页面。
- **一手** `first_party`：来源是当事方自己。事件页会优先展示一手报道。
- **全文**：`site_fulltext` 决定站内能不能显示全文，`syndicate_fulltext` 决定全文 RSS 能不能带正文。两者**默认都关**，只显示摘要和原文链接；来源明确允许时再打开。公众号、付费墙内容不会因为技术上抓得到就获得全文展示。

## 抓取频率

每个信源有自己的抓取间隔。每天 04:20 会按近 7 天的产出自动调整：产出多的抓得勤，最短 15 分钟；免费信源最长 60 分钟，按次计费的信源最长 120–180 分钟。

抓取失败不推进位置，下次从同一处继续；连续失败的信源在后台标红，每周一会在运营群发一份信源周报（配置了飞书内部群时）。

## 规则：旧文不刷屏

首次发现时原文已经发布超过 48 小时的资料、新信源第一次导入的存量条目、标记为回灌的推送，都按原文时间归档：不进入“今天”，也不推送。这条规则所有入口共用，防止一次性导入历史内容刷屏。

## 外部推送接口

自己写脚本抓的内容，可以推进站里，走和普通采集一样的判重、精选和归组。

```
POST /api/ingest/items
Authorization: Bearer <INGEST_TOKEN>
Content-Type: application/json

{
  "sourceId": "my-crawler",
  "sourceName": "我的抓取脚本",
  "items": [
    { "title": "必填", "url": "必填", "publishedAt": "2026-10-01T08:00:00+08:00", "author": "可选" }
  ]
}
```

- `INGEST_TOKEN` 在 `.env` 里设置，至少 16 位；不设置时接口一律返回 401。
- 每次最多 50 条；每个客户端每分钟最多 10 次。
- `items` 中每条必须是 JSON 对象；包含 `null`、数组或其他非对象值时返回 400，且不会创建或更新信源，也不会写入条目。
- 返回 `{"ok": true, "created": <新建条数>}`。缺标题或网址的条目会被跳过，同一请求里重复的网址只取第一条。
- `sourceId` 不存在时会自动建一个 `external` 信源，默认不进公开页面：到后台把它的参与方式改成 `editorial` 才会出现在站上。
- 在后台暂停信源后，推送接口返回 409，不再接收新文章；恢复信源后可以继续推送。
- 条目的 `raw._aihot.backfill` 为 `true` 时按历史回灌处理（不进入“今天”、不推送）。

### 公众号资料库与历史归档

左侧「公众号」入口为 `/mp`，按账号筛选、搜索标题/摘要并读取已保存正文。它包含未经过模型筛选的公众号材料；撤回、非编辑信源和全文展示权限仍生效。阅读不会发起采集或模型请求。

后台公众号信源详情的「历史文章归档」按两步操作：

1. 「获取历史列表」：极致了按 `offset` 翻页，保存文章链接、标题、时间。每批请求上限可设1–20，默认5；达到上限暂停，继续时沿用游标。只有供应商明确返回 `is_end=1` 才认定历史遍历结束；不能保证已删除或供应商未覆盖的文章也能获取。
2. 「获取缺失全文」：对该公众号所有尚无正文的条目（归档导入的和日常采集的）读取文章页，不计费；补上正文不会让文章重新进入分析。已有正文不重复获取。空正文单独计数，不自动无限重试；遇到验证页本批停止并显示原因，稍后继续即可。

历史列表跟随该信源的 `listProvider`：极致了按上面的方式逐页翻到最早；万有引擎只发一次异步请求，拿到最近这一批后就算列表完成（等待最长约 4 分钟，超时则回执记为结果未知，不会自动重发）。需要更早的文章时，把该信源的列表服务商改为极致了再获取历史列表，列表会从头开始（已保存的文章不重复入库）。归档旧文不会自动分析、归组或推送；日常增量采集保持原流程。历史列表需要对应服务商的 key（`DAJIALA_KEY` 或 `EVERYINFRA_API_KEY`），两步都需要开启采集，状态与断点复用已有 `settings` 表，无新增业务迁移。

文章详情点击「引用本文，开始研究」进入管理员研究页面。默认仅引用当前文章，可扩大到同一信源或全部信源；按问题关键词检索，最多提供5篇资料，回答展示引用来源。当前为关键词检索，尚未实现向量检索；对话仅管理员可见，模型仅在worker处理主动提交的问题，并走回执及预算。需要已配置默认模型和 `MODEL_CALLS_ENABLED=true`。
