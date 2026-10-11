/**
 * DSH-WebEnhance — 把 web seam 的搜索与抓取分流到不同供应商。
 *
 *   web_search -> web-enhance  Parallel /v1/search
 *   web_fetch  -> web-enhance  Tavily /extract，必要时升级 Firecrawl /v2/scrape
 *
 * 与 dsh-tavily-firecrawl 的核心区别：那边靠多个 key 轮询换额度，这边是
 * "一个操作只对应一家主供应商，失败才升级"，因此不必囤积 key，也不会
 * 因为同一账号下的多个 key 被关联而提前触发风控。
 *
 * config 的每个字段都放在顶层：dsh 设置页的表单模型只按顶层字段名读写
 * （@deepseek-ai/dsh-client-ui-primitives 的 SettingsFormModel 内部是
 *  `snapshot.value?.[field]`、`path: [field]`），嵌套字段在设置页里根本
 * 显示不出来，所以这里不做嵌套。
 */
import z from "@deepseek-ai/schemastery";
import { createCredentialResolver, normaliseBaseURL } from "./config.js";
import { QuotaLedger, defaultLedgerPath } from "./ledger.js";
import { SEARCH_PROVIDER_ID, ParallelSearchProvider } from "./providers/parallel.js";
import { FETCH_PROVIDER_ID, EnhancedFetchProvider } from "./providers/auto.js";

/** Cordis 插件名，出现在加载器诊断里。 */
const name = "web-enhance";
/** 本插件注册进哪个 seam。 */
const inject = ["web"];

/** Parallel 的搜索档位。 */
const SEARCH_MODES = new Set(["turbo", "fast", "basic", "advanced"]);
/** Tavily 的抽取深度。 */
const EXTRACT_DEPTHS = new Set(["basic", "advanced"]);
/** 抓取供应商：auto 走升级链，另外两个强制单家。 */
const FETCH_VENDORS = new Set(["auto", "tavily", "firecrawl"]);

const DEFAULT_PARALLEL_BASE_URL = "https://api.parallel.ai";
const DEFAULT_TAVILY_BASE_URL = "https://api.tavily.com";
const DEFAULT_FIRECRAWL_BASE_URL = "https://api.firecrawl.dev";

const Config = z.object({
  // ── 供应商选择 ────────────────────────────────────────────────────────
  /**
   * 抓取供应商。auto = Tavily 起步、按需升级 Firecrawl；
   * tavily / firecrawl = 强制只用一家（额度和效果都更好预测）。
   */
  fetchVendor: z.string().default("auto").volatile(),

  // ── 抓取链的公共参数 ──────────────────────────────────────────────────
  /** 正文短于这个字符数（忽略空白）就认为没抓到东西，触发升级；0 关闭该判定。 */
  fetchMinChars: z.number().step(1).min(0).default(500).volatile(),
  /**
   * 整条抓取链的总预算，必须小于 tool-web 的 fetchTimeoutMs。
   * agent 预设里 tool-web 的 fetchTimeoutMs 默认是 30000，这里留 2 秒余量；
   * 若你把预设里的 fetchTimeoutMs 放宽到 60000，可同步把这里调到 55000。
   */
  fetchTotalTimeoutMs: z.number().step(1).min(1).default(28000).volatile(),

  // ── Parallel（web_search）───────────────────────────────────────────
  /** 字面量 key；留空则从凭据服务或环境变量取。 */
  searchApiKey: z.string().role("secret").volatile(),
  /** 凭据引用名 / 环境变量名。 */
  searchApiKeyEnv: z.string().role("credential-ref").default("PARALLEL_API_KEY").volatile(),
  searchBaseURL: z.string().default(DEFAULT_PARALLEL_BASE_URL).volatile(),
  /** turbo | fast | basic | advanced；默认 basic（每请求 1 份用量）。 */
  searchMode: z.string().default("basic").volatile(),
  /** 单次搜索返回的最大结果数（Parallel 公开上限 20）。 */
  searchMaxResults: z.number().step(1).min(1).max(20).default(10).volatile(),
  searchTimeoutMs: z.number().step(1).min(1).default(30000).volatile(),

  // ── Tavily（web_fetch 第一层）─────────────────────────────────────────
  tavilyApiKey: z.string().role("secret").volatile(),
  tavilyApiKeyEnv: z.string().role("credential-ref").default("TAVILY_API_KEY").volatile(),
  tavilyBaseURL: z.string().default(DEFAULT_TAVILY_BASE_URL).volatile(),
  /** basic 时每 5 个成功 URL 记 1 credit。 */
  tavilyExtractDepth: z.string().default("basic").volatile(),
  /** 单级超时；留出足够预算给 Firecrawl 兜底。 */
  tavilyTimeoutMs: z.number().step(1).min(1).default(12000).volatile(),

  // ── Firecrawl（web_fetch 第二层）──────────────────────────────────────
  firecrawlApiKey: z.string().role("secret").volatile(),
  firecrawlApiKeyEnv: z.string().role("credential-ref").default("FIRECRAWL_API_KEY").volatile(),
  firecrawlBaseURL: z.string().default(DEFAULT_FIRECRAWL_BASE_URL).volatile(),
  /** 确定性 HTML 过滤（免费，不是 LLM），默认剥掉 nav/footer。 */
  firecrawlOnlyMainContent: z.boolean().default(true).volatile(),
  /** 缓存容忍度（毫秒），默认 2 天；0 表示强制新鲜抓取。 */
  firecrawlMaxAge: z.number().step(1).min(0).default(172800000).volatile(),
  firecrawlTimeoutMs: z.number().step(1).min(1).default(45000).volatile(),

  // ── 额度标记 ──────────────────────────────────────────────────────────
  /** 留空则用 $DSH_HOME/web-enhance-ledger.json。 */
  ledgerPath: z.string().default("").volatile(),
});

/** 读一个 schemastery 字段的当前值；兼容 reactive（.get()）与普通对象。 */
function readField(config, key) {
  const field = config?.[key];
  if (field === undefined || field === null) return undefined;
  return typeof field.get === "function" ? field.get() : field;
}

function normaliseMode(value) {
  return typeof value === "string" && SEARCH_MODES.has(value) ? value : "basic";
}

function normaliseExtractDepth(value) {
  return typeof value === "string" && EXTRACT_DEPTHS.has(value) ? value : "basic";
}

/** 认不出的供应商名一律退回 auto，避免写错一个词就让 web_fetch 整个不可用。 */
function normaliseVendor(value) {
  return typeof value === "string" && FETCH_VENDORS.has(value) ? value : "auto";
}

/** 每次搜索前快照一份选项（设置页改动因此无需重新注册 provider）。 */
function searchOptions(ctx, config) {
  const credentials = createCredentialResolver(ctx, {
    literalApiKey: readField(config, "searchApiKey"),
    apiKeyEnv: readField(config, "searchApiKeyEnv") ?? "PARALLEL_API_KEY",
  });
  return {
    apiKeyEnv: credentials.envName,
    resolveApiKey: () => credentials.resolve(),
    baseURL: normaliseBaseURL(readField(config, "searchBaseURL"), DEFAULT_PARALLEL_BASE_URL),
    mode: normaliseMode(readField(config, "searchMode")),
    maxResults: readField(config, "searchMaxResults") ?? 10,
    timeoutMs: readField(config, "searchTimeoutMs") ?? 30000,
  };
}

/** 每次抓取前快照一份选项。 */
function fetchOptions(ctx, config, ledger) {
  const minChars = readField(config, "fetchMinChars") ?? 500;

  const tavilyCredentials = createCredentialResolver(ctx, {
    literalApiKey: readField(config, "tavilyApiKey"),
    apiKeyEnv: readField(config, "tavilyApiKeyEnv") ?? "TAVILY_API_KEY",
  });
  const firecrawlCredentials = createCredentialResolver(ctx, {
    literalApiKey: readField(config, "firecrawlApiKey"),
    apiKeyEnv: readField(config, "firecrawlApiKeyEnv") ?? "FIRECRAWL_API_KEY",
  });

  return {
    vendor: normaliseVendor(readField(config, "fetchVendor")),
    minChars,
    totalTimeoutMs: readField(config, "fetchTotalTimeoutMs") ?? 28000,
    ledger,
    tavily: {
      apiKeyEnv: tavilyCredentials.envName,
      resolveApiKey: () => tavilyCredentials.resolve(),
      baseURL: normaliseBaseURL(readField(config, "tavilyBaseURL"), DEFAULT_TAVILY_BASE_URL),
      extractDepth: normaliseExtractDepth(readField(config, "tavilyExtractDepth")),
      timeoutMs: readField(config, "tavilyTimeoutMs") ?? 12000,
      minChars,
    },
    firecrawl: {
      apiKeyEnv: firecrawlCredentials.envName,
      resolveApiKey: () => firecrawlCredentials.resolve(),
      baseURL: normaliseBaseURL(readField(config, "firecrawlBaseURL"), DEFAULT_FIRECRAWL_BASE_URL),
      onlyMainContent: readField(config, "firecrawlOnlyMainContent") !== false,
      maxAge: readField(config, "firecrawlMaxAge") ?? 172800000,
      timeoutMs: readField(config, "firecrawlTimeoutMs") ?? 45000,
    },
  };
}

/** 把搜索与抓取两个 provider 注册进 ctx.web。 */
function apply(ctx, config) {
  const ledgerPath = readField(config, "ledgerPath");
  const ledger = new QuotaLedger({
    path: typeof ledgerPath === "string" && ledgerPath.length > 0 ? ledgerPath : defaultLedgerPath(),
  });

  ctx.web.registerSearchProvider(new ParallelSearchProvider(() => searchOptions(ctx, config)));
  ctx.web.registerFetchProvider(new EnhancedFetchProvider(() => fetchOptions(ctx, config, ledger)));
}

export {
  Config,
  EnhancedFetchProvider,
  FETCH_PROVIDER_ID,
  ParallelSearchProvider,
  SEARCH_PROVIDER_ID,
  apply,
  inject,
  name,
};
