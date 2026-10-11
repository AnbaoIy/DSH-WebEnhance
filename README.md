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

**尚未发布到 npm**，所以不能用包名安装，要指向仓库地址。下面任选一种。

### 方式 1 · 让 agent 装（推荐）

对话里直接说「从 https://github.com/AnbaoIy/DSH-WebEnhance 安装插件」，
agent 会调用 `plugin_manager` 工具的 `install_bundle`。
这个动作要求 `danger-full-access` 权限或当次批准——安装的代码会在宿主进程里运行，
不受工作区沙箱限制。

> 这个构建没有对外露出插件管理界面：`main` 槽位只被会话占用，`settings.plugins.tab` 为空，
> 侧边栏也没有插件图标。所以这条路是不依赖手敲命令的安装途径。

### 方式 2 · CLI

```bash
dsh plugin --profile desktop install https://github.com/AnbaoIy/DSH-WebEnhance
```

### 方式 3 · 本地路径（改代码时用）

```bash
dsh plugin --profile desktop install C:\path\to\dsh-webenhance
dsh plugin --profile desktop install file:C:\path\to\dsh-webenhance
```

路径必须是**绝对**的。相对路径会被拒绝：Host 的工作目录对一个在浏览器里打字的人
没有意义，而按 profile 目录解析出来的路径只会落进 profile 内部。

### 支持的 spec 形式

| 形式 | 例子 |
| --- | --- |
| git | `https://github.com/AnbaoIy/DSH-WebEnhance`、`github:AnbaoIy/DSH-WebEnhance`、`git+https://…`、`git@github.com:…` |
| 本地路径 | `C:\…\dsh-webenhance`、`file:…`、`link:…` |
| tarball | `https://…/dsh-webenhance-0.1.0.tgz` |
| registry | `dsh-webenhance`（发布之后才可用） |

### 关于兼容性检查

dsh 会拿插件的 `peerDependencies` 和当前运行时比对，不匹配就拒绝安装。
本地路径与 registry spec 在 pnpm 之前就能判定；**git 与 tarball 必须先抓下来才知道，
所以判定发生在安装之后** —— 被拒时会回滚 `package.json` 与 `pnpm-lock.yaml`。

本插件的 peer 全部声明为 `*`，正常情况不会触发拒绝。若 dsh 升级后开始拒绝，
用 `dsh plugin --profile desktop allow-version` 或插件管理器授予**精确版本**的豁免；
这会承担崩溃与数据丢失的风险，务必先看清提示。

安装时如果 pnpm 拦下了某个依赖的构建脚本，页面会提示「允许这些脚本并重试」，
需要单独批准。

### 安装后改了什么

由插件的 `cordis.patch.yml` 覆盖三处：

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

### 什么时候要重启

- **首次安装**：要**重启 dsh**。插件模块在宿主进程启动时 import 一次并被缓存，
  仅靠 enable/disable 不会重新加载——这也是排查「改了代码没反应」时先看的地方。
  客户端半边（设置页）随后刷新页面即可出现。
- **升级到新版本**：同样必须重启 dsh 进程。已加载的 JavaScript 模块不会原地换掉。

## 卸载

### 让 agent 卸（推荐）

`plugin_manager` 工具，`action: "remove_bundle"`，`target: "dsh-webenhance"`。
`target` 用**包名**，不是安装时用的那个路径。

### CLI

```bash
dsh plugin --profile desktop remove dsh-webenhance
```

仅当你的 dsh 有命令行入口时可用。

> 移除后建议重启 dsh：patch 会立即失效，但已加载的模块仍在进程里。

### 卸载做了什么

按顺序三步，任一步失败就停在那里、不继续：

1. 从 `package.json` 的 `dsh.profile.bundles` 移除
2. 卸载运行时贡献（本插件的 patch 随之失效）
3. `pnpm remove dsh-webenhance`

失败的删除可能留下部分依赖改动——诊断在 profile 的 `.plugin-manager/logs` 目录里。

### 卸载后会怎样

- `web` 行的 `searchProvider` / `fetchProvider` 回到内置的 `deepseek-official` / `http`
- `web-search-deepseek` 恢复启用，**此时必须有 `DEEPSEEK_API_KEY`**，否则 `web_search` 会直接报错
- 额度标记文件 `$DSH_HOME/web-enhance-ledger.json` **不会被删**，要清理请手动删除
- 键值仍留在 dsh 凭据服务里。设置页消失后无法再从界面清掉，用 `dsh` 的凭据管理或直接删对应条目

## 设置页

装好并**重启 dsh** 后，打开 **设置 → 网页增强**（与「常规」「模型」并列的一个分区），
可以直接填三把 key、选择抓取供应商，不需要改配置文件。

抓取供应商是分段控件，三段是 **自动 / Tavily / Firecrawl**。点击只是改动表单里的
暂存值，仍然要点「保存」才落盘；供应商被覆盖过时会显示「已覆盖」和「恢复默认」。
它和三个 key 字段共用一套提交时机，所以改完一起保存即可。

> 它注册在 `settings.section` 槽位（`order: 45`），不是某个「插件」分区下的页面——
> 这个构建没有对外露出插件管理界面，注册到 `plugins.item` 的卡片无处渲染。

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
