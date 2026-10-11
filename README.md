# DSH-WebEnhance

把 DSH web seam 的**搜索**与**抓取**分流到不同供应商，并让抓取在必要时升级。

```
web_search ─▶ Parallel   POST /v1/search

web_fetch  ─▶ Tavily     POST /extract ─┬─ 额度耗尽   402 / 432 / 433
                                         ├─ 触发反爬   403、正文命中防火墙特征
                                         └─ 无可用正文 failed_results、正文过短
                                              ▼
                                         Firecrawl   POST /v2/scrape
```

两种操作消耗各自的额度，互不挤占：搜索只花 Parallel 的 5000 requests/月；
抓取先花 Tavily 的 1000 credits/月，只有确实拿不到正文时才动用 Firecrawl 的 1000 credits。

## 设计取舍

[dsh-tavily-firecrawl](https://github.com/skillre/dsh-tavily-firecrawl) 用多个 key 轮流请求来堆额度。
这有两个代价：同一账号下的多个 key 一旦被关联，反而更容易触发风控；key 变多之后，
出问题也难以定位到具体一把。

本插件反向处理：**一个操作只对应一家主供应商，失败才升级**。结果是搜索结果风格稳定、
额度消耗可预测、排障只需看一条链路。

## 安装

```bash
dsh plugin --profile desktop add dsh-webenhance
```

安装后由插件的 `cordis.patch.yml` 覆盖三处：

| 目标 | 改动 |
| --- | --- |
| `web-enhance` | 插入本插件 |
| `web` | `searchProvider: web-enhance`、`fetchProvider: web-enhance` |
| `web-search-deepseek` | `disabled: true`，因此不再需要 `DEEPSEEK_API_KEY` |

按 id 定位的 patch 会**整体替换**目标条目的 `config`，且只作用于配置树顶层。
agent 预设里真正生效的那份 `tool-web` 嵌在 `preset-standard.config.plugins[]` 内，
顶层 patch 触及不到它，因此本插件不依赖放宽工具层超时：抓取链的默认总预算
`fetchTotalTimeoutMs` 为 28000，稳在 `tool-web.fetchTimeoutMs` 默认的 30000 之内。
若要让升级链跑得更久，先在 agent 预设里把 `tool-web.fetchTimeoutMs` 改为 60000，
再把 `fetchTotalTimeoutMs` 提到 55000。

## 设置页

装好后在 **设置 → 插件 → 网页增强** 里可以直接填三把 key、选择抓取供应商，
不需要改配置文件，也不需要重启 dsh。

这一页由 `lib/client.js` 提供（客户端插件，`package.json` 的 `dsh.client` 与
`exports["./client"]` 声明）。Host 侧不需要任何额外代码：只要 `Config` 里存在
`.volatile()` 字段，dsh 的 settings 服务就会自动为该 profile 条目投影出表单。

**配置项全部是顶层字段**，这是设置页的硬约束 —— 表单模型按顶层字段名读写
（写入 op 形如 `{op: "set", path: ["fetchVendor"], value}`），嵌套字段在页面上不会显示。
因此本插件的 Config 没有任何嵌套对象。

## 凭据

三家各一把 key，按以下优先级解析（与 dsh 内置 provider 一致）：

1. 插件 config 中的字面量 key（`searchApiKey` / `tavilyApiKey` / `firecrawlApiKey`）
2. dsh 凭据服务中以 `*ApiKeyEnv` 为名的条目（设置页写的就是这里）
3. dsh 启动环境中的同名环境变量

通常直接设置环境变量即可：

```bash
PARALLEL_API_KEY=...
TAVILY_API_KEY=...
FIRECRAWL_API_KEY=...
```

只配置需要的那几把即可：缺少 key 的供应商会被跳过。

注意 `available()` **刻意不看凭据** —— 只看本地配置是否成形（baseURL 能解析等）。
这与内置 `dsh-web-search-deepseek` 的约定一致：缺 key 推迟到真正调用时才报
`WEB_PROVIDER_CREDENTIAL_MISSING`。否则只在设置页填 key 的用户会先撞上
`WEB_PROVIDER_CONFIGURED_UNAVAILABLE`，而那时 key 明明已经填好了。

## 配置项

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `fetchVendor` | `auto` | `auto` / `tavily` / `firecrawl`；强制单家时忽略额度标记 |
| `fetchMinChars` | `500` | 正文短于此值即判为「未抓到」，触发升级；0 关闭该判定 |
| `fetchTotalTimeoutMs` | `28000` | 整条链的总预算，须小于 `tool-web.fetchTimeoutMs`（默认 30000） |
| `searchApiKey` | — | Parallel 字面量 key |
| `searchApiKeyEnv` | `PARALLEL_API_KEY` | 凭据引用名 / 环境变量名 |
| `searchBaseURL` | `https://api.parallel.ai` | |
| `searchMode` | `basic` | `turbo` / `fast` / `basic` / `advanced`；免费额度内均计 1 request |
| `searchMaxResults` | `10` | 单次上限，公开上限 20 |
| `searchTimeoutMs` | `30000` | |
| `tavilyApiKey` | — | 字面量 key |
| `tavilyApiKeyEnv` | `TAVILY_API_KEY` | |
| `tavilyBaseURL` | `https://api.tavily.com` | |
| `tavilyExtractDepth` | `basic` | `basic` 时每 5 个成功 URL 记 1 credit |
| `tavilyTimeoutMs` | `12000` | 为 Firecrawl 兜底预留预算 |
| `firecrawlApiKey` | — | 字面量 key |
| `firecrawlApiKeyEnv` | `FIRECRAWL_API_KEY` | |
| `firecrawlBaseURL` | `https://api.firecrawl.dev` | |
| `firecrawlOnlyMainContent` | `true` | 确定性 HTML 过滤，不额外计费 |
| `firecrawlMaxAge` | `172800000` | 缓存容忍度（2 天）；0 表示强制新鲜抓取 |
| `firecrawlTimeoutMs` | `45000` | 调用时还会被剩余总预算截断 |
| `ledgerPath` | `$DSH_HOME/web-enhance-ledger.json` | 额度标记位置 |

各层单独的超时也会被剩余总预算截断，因此 `tavilyTimeoutMs + firecrawlTimeoutMs`
超过 `fetchTotalTimeoutMs` 不会真的跑那么久。

## 升级与额度

Tavily 与 Firecrawl 都没有可靠的余额查询接口，插件因此只维护一件事：
**某家在本月已确认额度耗尽**。

- Tavily 返回 402 / 432 / 433 时记为「本月额度耗尽」，此后直接跳过 Tavily，直到下个自然月；
- 读取时若月份已变，标记自动作废；
- 写入失败会被静默忽略并降级为内存态，磁盘问题不会影响抓取。

这里**不做用量估算**。凭错误码判断一次，比持续猜余额更不容易出错；
`fetchVendor` 强制指定单家时也会忽略这个标记 —— 用户已经点名要走这家，
耗尽与否由它自己回答。

429 不会被记为额度耗尽 —— 它只代表请求过快，退避后可继续。

## 调试

把 `fetchVendor` 改为 `firecrawl`，即可跳过 Tavily 直连 Firecrawl：

```yaml
- id: web-enhance
  config:
    fetchVendor: firecrawl
```

也可在设置页里直接切换，效果相同。可在 Tavily 故障时用于应急绕行。

## 已知限制

- **搜索只有 Parallel。** seam 的搜索请求只携带 `query` 与 `maxResults`，插件无法按
  时效性等维度切换供应商。确实需要时可把 `web.searchProvider` 指向别家的 provider。
- **Parallel 默认走索引缓存**，新鲜度弱于实时抓取。
- **Tavily 的 extract 按「每 5 个成功 URL 记 1 credit」计费**，单条抓取往往向上取整为
  1 credit，因此它在该用法下未必比 Firecrawl 便宜。把它放在第一层，主要是看重 100 RPM
  的响应速度，以及保护 Firecrawl 的 1000 credits。
- 额度标记是**本地记录**，并非服务端真实余额；仅在明显耗尽时才硬性跳过。
- 抓取链最坏会串行两层；`fetchTotalTimeoutMs` 是唯一的硬预算，用尽后不再升级。

## 开发

```bash
npm test          # pretest 会先生成 @deepseek-ai/* 的本地 shim
```

测试不联网，全部使用注入的假 `fetch`。若运行环境禁止子进程管道（例如受限沙箱），
`node --test` 会因 spawn EPERM 失败，改用同进程模式：

```bash
node --test --test-isolation=none 'test/**/*.test.mjs'
```

```
lib/
  index.js                插件入口：Config、两个 provider 的注册
  client.js               设置页（浏览器半边，无构建步骤）
  config.js               配置与凭据解析
  http.js                 出站 HTTP：超时、取消、错误归一
  result.js               归一成 seam 的 WebFetchResult
  ledger.js               「本月额度耗尽」标记
  heuristics.js           反爬 / 空正文启发式
  providers/parallel.js   web_search
  providers/auto.js       web_fetch：Tavily → Firecrawl
  providers/tavily.js     Tavily /extract
  providers/firecrawl.js  Firecrawl /v2/scrape
```

## License

MIT
