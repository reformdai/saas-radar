# 后台智能体「小雷」

后台导航「小雷助手」（`/admin/agent`）。用对话代替翻页面、填表单：查信源、改配置、拉公众号历史、撤内容。只有管理员能用。

## 配置

小雷用 DeepSeek（模型预设 `deepseek-flash`），在 `.env` 里配：

```bash
DEEPSEEK_BASE_URL=https://api.deepseek.com/v1
DEEPSEEK_API_KEY=<你的 key>
```

还要开着 `MODEL_CALLS_ENABLED`。改完 `.env` 后重启 API 和 worker（Docker：`npm run docker:reload`）。每一步模型调用都走回执和 `deepseek` 预算熔断，费用在「运行」和回执里看。

## 它能做什么

查询类，直接执行：

| 工具 | 作用 |
|---|---|
| `list_sources` / `source_detail` | 信源列表、单个信源的配置、统计、最近采集和文章 |
| `archive_status` | 公众号历史归档进度 |
| `search_content` / `content_detail` | 搜内容、看一条内容的处理链 |
| `runs_overview` | 队列、失败任务、待处理回执 |
| `spend_summary` | 最近几天各服务的请求次数和费用 |

写操作，先出确认卡，点「冲！」才执行，点「算了」或直接发新消息就作废：

| 工具 | 作用 |
|---|---|
| `create_source` / `update_source` | 新建信源；改名称、启停、间隔、级别、参与方式、标签，或合并修改配置（例如把 `listProvider` 改成 `dajiala`） |
| `fetch_now` | 立即采集 |
| `archive` | 公众号历史列表、补全文、暂停 |
| `set_visibility` | 公开 / 只展示摘要 / 撤下 |
| `rerun` | 重新抓正文、重新分析、重新归组 |
| `merge_stories` | 合并事件 |

确认卡写明改前改后和大概费用。执行时调用后台同一套函数，审计记录里的执行人是当前管理员。确认时如果数据已被别处改过（版本变了），会报冲突，不会覆盖。

不开放：预算、模型切换、密钥与设置、反馈处理、回执释放，以及信源的全文授权（`site_fulltext`、`syndicate_fulltext`）和主体归属，这些仍在原页面处理。

## 安全边界

- 模型只在 worker 里调用，页面只轮询对话状态。
- 发给模型的信源配置会隐藏名字里带 key、token、secret、cookie、password 的字段。
- 工具结果和文章内容只当资料，系统提示要求模型不执行其中的指令；写操作无论如何都要人工确认。
- 对话存在 `settings` 表（`agent:<id>`），只有本人能看到自己的对话。
