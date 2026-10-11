# DSH-WebEnhance

把 DSH web seam 的**搜索**与**抓取**分流到不同供应商，并在抓取失败时按需升级：

```
web_search ──▶ Parallel   POST /v1/search

web_fetch  ──▶ Tavily     POST /extract ──┬─ ① 额度耗尽   HTTP 402 / 432 / 433
                                           ├─ ② 触发反爬   HTTP 403、正文命中防火墙特征
                                           └─ ③ 抓不到内容 failed_results 命中、正文过短
                                                 ▼
                                           Firecrawl  POST /v2/scrape
```

三家在同一个操作上互不竞争额度：搜索只花 Parallel 的 5000 requests/月，
抓取先花 Tavily 的 1000 credits/月，只有真的抓不动时才动用 Firecrawl 的 1000 credits。

## 为什么不是"多 key 轮询"

[dsh-tavily-firecrawl](https://github.com/skillre/dsh-tavily-firecrawl) 的思路是囤多个 key
轮流用，靠数量堆额度。那有两个问题：一是同一账号下的多个 key 被关联识别后反而更容易触发风控，
二是 key 越多，出问题时越难定位是哪一个。

这个插件反过来做：**一个操作只找一家，顶不住才升级**。搜索结果稳定、额度消耗可预测，
出问题也只需要看一条链路。

## 安装

```bash
dsh plugin --profile desktop add dsh-webenhance
```

安装后 `dsh-webenhance` 会以自己的 `cordis.patch.yml` 覆盖三处：

| 目标 | 改动 |
| --- | --- |
| `web-enhance` | 插入本插件 |
| `web` | `searchProvider: parallel`、`fetchProvider: auto` |
| `web-search-deepseek` | `disabled: true`（所以不再需要 `DEEPSEEK_API_KEY`） |

> patch 是**按 id 定位顶层条目并整体替换它的 `config`**，不做深度合并。
> agent 预设里那份真正生效的 `tool-web` 嵌在 `preset-standard.config.plugins[]` 内，
> 顶层 patch 够不到它，所以本插件**不依赖**放宽工具层超时 —— 整条抓取链的默认预算
> `fetch.totalTimeoutMs` 已经压到 28000，稳在 `tool-web.fetchTimeoutMs` 默认的 30000 之内。
> 想让升级链跑得更久（例如让 Firecrawl 处理很慢的页面），先在 agent 预设里把 `tool-web`
> 的 `fetchTimeoutMs` 改成 60000，再把 `fetch.totalTimeoutMs` 调到 55000。

## 配置 API key

三家各一把，按下面的优先级解析（与 dsh 内置 provider 一致）：

1. 插件 config 里的字面量 `apiKey`
2. dsh 凭据服务里按 `apiKeyEnv` 存的值
3. dsh 启动环境里的同名环境变量

最省事的做法是设置环境变量：

```bash
PARALLEL_API_KEY=...
TAVILY_API_KEY=...
FIRECRAWL_API_KEY=...
```

只用改 `web.fetchProvider` 的话，也可以完全跳过 Tavily —— 见下面的"调试"。

## 配置项

### `search`（Parallel）

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `apiKey` | — | 字面量 key |
| `apiKeyEnv` | `PARALLEL_API_KEY` | 凭据引用名 / 环境变量名 |
| `baseURL` | `https://api.parallel.ai` | |
| `mode` | `basic` | `turbo` / `fast` / `basic` / `advanced`；免费额度内都是 1 request |
| `maxResults` | `10` | 单次上限，公开上限 20 |
| `maxCharsTotal` | `0` | 整个响应的字符上限，0 表示不限 |
| `snippetChars` | `1200` | 每条摘录的截断长度 |
| `timeoutMs` | `30000` | |
| `objective` | — | 可选的自然语言搜索目标 |

### `fetch`

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `minChars` | `500` | 正文短于此判为"没抓到"，触发升级；0 关闭该判定 |
| `maxBodyChars` | `200000` | 返回给工具层的正文上限 |
| `totalTimeoutMs` | `28000` | 整条链的总预算，必须小于 `tool-web.fetchTimeoutMs`（默认 30000） |
| `tavily.extractDepth` | `basic` | `basic` 时每 5 个成功 URL 记 1 credit |
| `tavily.timeoutMs` | `12000` | 留给 Firecrawl 兜底预算 |
| `firecrawl.onlyMainContent` | `true` | 确定性 HTML 过滤，免费 |
| `firecrawl.maxAge` | `172800000` | 缓存容忍度（2 天）；0 表示强制新鲜抓取 |
| `firecrawl.proxy` | `auto` | `basic` / `enhanced` / `auto`，`enhanced` 不额外计费 |
| `firecrawl.timeoutMs` | `45000` | |

### `ledger`

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 关掉则不落盘，只保留内存态 |
| `path` | `$DSH_HOME/web-enhance-ledger.json` | 账本位置 |

## 额度账本

Tavily 和 Firecrawl 都没有可靠的"剩余余额"接口，所以插件在本地记一本账：

- Tavily 返回 402 / 432 / 433 时，记下"本月额度耗尽"，之后**直接跳过 Tavily**，直到下个自然月；
- 每次成功抓取按估算的 credit 数累加（Tavily 0.2，Firecrawl 1）；
- 跨月读取时整本账自动失效。

注意 429（限流）**不会**被记成额度耗尽 —— 那只是请求太快，退避一下就能继续。

账本写入失败会被静默忽略并降级为内存态，不会因为磁盘问题让抓取挂掉。

## 调试

把 `web.fetchProvider` 从 `auto` 改成 `firecrawl`，就跳过 Tavily 直接走 Firecrawl。
`firecrawl` 也是强制单家 provider，应急时可以用来绕开 Tavily 的故障。

```yaml
- id: web
  config:
    searchProvider: parallel
    fetchProvider: firecrawl
```

## 已知限制

- **搜索只有 Parallel 一家。** seam 的搜索请求只携带 `query` 和 `maxResults`，插件没有
  办法按"时效性"之类的维度换供应商。真需要时效性强的结果，把 `web.searchProvider` 换成
  `tavily` 并自行配置即可（本插件不提供 tavily 搜索 provider）。
- **Parallel 默认走索引缓存**，新鲜度弱于实时抓取。
- **Tavily 的 extract 是"每 5 个成功 URL 记 1 credit"**，单发抓取很可能向上取整到 1 credit，
  也就是说它在这个用法下不一定比 Firecrawl 便宜 —— 选它作为第一层主要图的是 100 RPM 的
  速度和保护 Firecrawl 那 1000 额度。
- 账本是**本地估算**，不是服务端真实余额；只在"显然耗尽"时才做硬性跳过。
- 抓取链最坏会串行跑两层；`totalTimeoutMs` 是唯一的硬预算，用完就不再升级。
  它默认 28000，受 agent 预设里 `tool-web.fetchTimeoutMs`（默认 30000）的约束。

## 开发

```bash
npm test          # pretest 会先生成 @deepseek-ai/* 的本地 shim
```

测试不联网，全部用注入的假 `fetch`。如果运行环境禁止子进程管道（例如受限沙箱），
`node --test` 会因为 spawn EPERM 失败，改用同进程模式：

```bash
node --test --test-isolation=none 'test/**/*.test.mjs'
```

## License

MIT
