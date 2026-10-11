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
| `web` | `searchProvider: parallel`、`fetchProvider: auto` |
| `web-search-deepseek` | `disabled: true`，因此不再需要 `DEEPSEEK_API_KEY` |

按 id 定位的 patch 会**整体替换**目标条目的 `config`，且只作用于配置树顶层。
agent 预设里真正生效的那份 `tool-web` 嵌在 `preset-standard.config.plugins[]` 内，
顶层 patch 触及不到它，因此本插件不依赖放宽工具层超时：抓取链的默认总预算
`fetch.totalTimeoutMs` 为 28000，稳在 `tool-web.fetchTimeoutMs` 默认的 30000 之内。
若要让升级链跑得更久，先在 agent 预设里把 `tool-web.fetchTimeoutMs` 改为 60000，
再把 `fetch.totalTimeoutMs` 提到 55000。

## 凭据

三家各一把 key，按以下优先级解析（与 dsh 内置 provider 一致）：

1. 插件 config 中的字面量 `apiKey`
2. dsh 凭据服务中以 `apiKeyEnv` 为名的条目
3. dsh 启动环境中的同名环境变量

通常直接设置环境变量即可：

```bash
PARALLEL_API_KEY=...
TAVILY_API_KEY=...
FIRECRAWL_API_KEY=...
```

只配置需要的那几把即可：缺少 key 的供应商会被跳过。`fetchProvider: auto` 至少需要
Tavily 与 Firecrawl 其中之一，只配 Firecrawl 时可将 `web.fetchProvider` 直接指向它。

## 配置项

### `search`（Parallel）

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `apiKey` | — | 字面量 key |
| `apiKeyEnv` | `PARALLEL_API_KEY` | 凭据引用名 / 环境变量名 |
| `baseURL` | `https://api.parallel.ai` | |
| `mode` | `basic` | `turbo` / `fast` / `basic` / `advanced`；免费额度内均计 1 request |
| `maxResults` | `10` | 单次上限，公开上限 20 |
| `maxCharsTotal` | `0` | 整个响应的字符上限，0 表示不限 |
| `snippetChars` | `1200` | 单条摘录的截断长度 |
| `timeoutMs` | `30000` | |
| `objective` | — | 可选的自然语言搜索目标 |

### `fetch`

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `minChars` | `500` | 正文短于此值即判为「未抓到」，触发升级；0 关闭该判定 |
| `maxBodyChars` | `200000` | 返回给工具层的正文上限 |
| `totalTimeoutMs` | `28000` | 整条链的总预算，须小于 `tool-web.fetchTimeoutMs`（默认 30000） |
| `tavily.extractDepth` | `basic` | `basic` 时每 5 个成功 URL 记 1 credit |
| `tavily.timeoutMs` | `12000` | 为 Firecrawl 兜底预留预算 |
| `firecrawl.onlyMainContent` | `true` | 确定性 HTML 过滤，不额外计费 |
| `firecrawl.maxAge` | `172800000` | 缓存容忍度（2 天）；0 表示强制新鲜抓取 |
| `firecrawl.proxy` | `auto` | `basic` / `enhanced` / `auto`，`enhanced` 不额外计费 |
| `firecrawl.timeoutMs` | `45000` | 调用时还会被剩余总预算截断 |

各层单独的超时也会被剩余总预算截断，因此 `tavily.timeoutMs + firecrawl.timeoutMs`
超过 `totalTimeoutMs` 不会真的跑那么久。

### `ledger`

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 关闭则只保留内存态，不落盘 |
| `path` | `$DSH_HOME/web-enhance-ledger.json` | 账本位置 |

## 升级与额度

Tavily 与 Firecrawl 都没有可靠的余额查询接口，插件因此维护一份本地账本：

- Tavily 返回 402 / 432 / 433 时记为「本月额度耗尽」，此后直接跳过 Tavily，直到下个自然月；
- 每次成功抓取按估算额度累加（Tavily 0.2 credit，Firecrawl 1 credit）；
- 读取时若月份已变，整本账自动作废。

429 不会被记为额度耗尽 —— 它只代表请求过快，退避后可继续。

账本写入失败会被静默忽略并降级为内存态，磁盘问题不会影响抓取。

## 调试

把 `web.fetchProvider` 由 `auto` 改为 `firecrawl`，即可跳过 Tavily 直连 Firecrawl：

```yaml
- id: web
  config:
    searchProvider: parallel
    fetchProvider: firecrawl
```

`firecrawl` 是强制单家 provider，可在 Tavily 故障时用于应急绕行。

## 已知限制

- **搜索只有 Parallel。** seam 的搜索请求只携带 `query` 与 `maxResults`，插件无法按
  时效性等维度切换供应商。确实需要时可把 `web.searchProvider` 指向别家的 provider。
- **Parallel 默认走索引缓存**，新鲜度弱于实时抓取。
- **Tavily 的 extract 按「每 5 个成功 URL 记 1 credit」计费**，单条抓取往往向上取整为
  1 credit，因此它在该用法下未必比 Firecrawl 便宜。把它放在第一层，主要是看重 100 RPM
  的响应速度，以及保护 Firecrawl 的 1000 credits。
- 账本是**本地估算**，并非服务端真实余额；仅在明显耗尽时才硬性跳过。
- 抓取链最坏会串行两层；`totalTimeoutMs` 是唯一的硬预算，用尽后不再升级。

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
  index.js                插件入口：Config、三个 provider 的注册
  config.js               配置与凭据解析
  http.js                 出站 HTTP：超时、取消、错误归一
  result.js               归一成 seam 的 WebFetchResult
  ledger.js               额度账本
  heuristics.js           反爬 / 空正文启发式
  providers/parallel.js   web_search
  providers/auto.js       web_fetch：Tavily → Firecrawl
  providers/tavily.js     Tavily /extract
  providers/firecrawl.js  Firecrawl /v2/scrape
  providers/firecrawl-provider.js  强制单家 provider
```

## License

MIT
