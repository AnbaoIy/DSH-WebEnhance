/**
 * DSH-WebEnhance — 把 web seam 的搜索与抓取分流到不同供应商。
 *
 *   web_search -> parallel   Parallel  /v1/search
 *   web_fetch  -> auto       Tavily /extract，必要时升级 Firecrawl /v2/scrape
 *   web_fetch  -> firecrawl  强制单家，调试与应急用
 *
 * 与 dsh-tavily-firecrawl 的核心区别：那边靠多 key 轮询换额度，这边是
 * "一个操作只找一家、顶不住才升级"，因此不需要囤一堆 key，也不会因为
 * 同一家被反复打到而提前触发风控。
 */
import z from "@deepseek-ai/schemastery";
import { createCredentialResolver, normaliseBaseURL } from "./config.js";
import { QuotaLedger, defaultLedgerPath } from "./ledger.js";
import { PARALLEL_PROVIDER_ID, ParallelSearchProvider } from "./providers/parallel.js";
import { AUTO_PROVIDER_ID, AutoFetchProvider } from "./providers/auto.js";
import { FirecrawlFetchProvider } from "./providers/firecrawl-provider.js";

/** Cordis 插件名，出现在加载器诊断里。 */
const name = "web-enhance";
/** 本插件注册进哪个 seam。 */
const inject = ["web"];

/** Parallel 的搜索档位。 */
const SEARCH_MODES = new Set(["turbo", "fast", "basic", "advanced"]);
/** Tavily 的抽取深度。 */
const EXTRACT_DEPTHS = new Set(["basic", "advanced"]);

const Config = z.object({
  search: z.object({
    /** 字面量 key；留空则从凭据服务或环境变量取。 */
    apiKey: z.string().role("secret").volatile(),
    /** 凭据引用名 / 环境变量名。 */
    apiKeyEnv: z.string().role("credential-ref").default("PARALLEL_API_KEY").volatile(),
    baseURL: z.string().default("https://api.parallel.ai").volatile(),
    /** turbo | fast | basic | advanced；免费额度内一律 1 request，默认 basic。 */
    mode: z.string().default("basic").volatile(),
    /** 单次搜索返回的最大结果数（Parallel 公开上限 20）。 */
    maxResults: z.number().step(1).min(1).max(20).default(10).volatile(),
    /** 整个响应的最大字符数；0 表示不限制。 */
    maxCharsTotal: z.number().step(1).min(0).default(0).volatile(),
    /** 每条结果摘录的截断长度。 */
    snippetChars: z.number().step(1).min(1).default(1200).volatile(),
    timeoutMs: z.number().step(1).min(1).default(30000).volatile(),
    /** 可选的自然语言搜索目标，会作为 objective 一起发出。 */
    objective: z.string().default("").volatile(),
  }),
  fetch: z.object({
    /** 正文短于这个字符数（忽略空白）就认为没抓到东西，触发升级。0 关闭该判定。 */
    minChars: z.number().step(1).min(0).default(500).volatile(),
    /** 返回给工具层的正文上限。 */
    maxBodyChars: z.number().step(1).min(1).default(200000).volatile(),
    /**
     * 整条抓取链的总预算，必须小于 tool-web 的 fetchTimeoutMs。
     * agent 预设里 tool-web 的 fetchTimeoutMs 默认是 30000，这里留 2 秒余量；
     * 若你把预设里的 fetchTimeoutMs 放宽到 60000，可同步把这里调到 55000。
     */
    totalTimeoutMs: z.number().step(1).min(1).default(28000).volatile(),
    tavily: z.object({
      apiKey: z.string().role("secret").volatile(),
      apiKeyEnv: z.string().role("credential-ref").default("TAVILY_API_KEY").volatile(),
      baseURL: z.string().default("https://api.tavily.com").volatile(),
      /** basic 时每 5 个成功 URL 记 1 credit。 */
      extractDepth: z.string().default("basic").volatile(),
      /** 单级超时；留出足够预算给 Firecrawl 兜底。 */
      timeoutMs: z.number().step(1).min(1).default(12000).volatile(),
    }),
    firecrawl: z.object({
      apiKey: z.string().role("secret").volatile(),
      apiKeyEnv: z.string().role("credential-ref").default("FIRECRAWL_API_KEY").volatile(),
      baseURL: z.string().default("https://api.firecrawl.dev").volatile(),
      /** 确定性 HTML 过滤（免费，不是 LLM），默认剥掉 nav/footer。 */
      onlyMainContent: z.boolean().default(true).volatile(),
      /** 缓存容忍度（毫秒），默认 2 天；0 表示强制新鲜抓取。 */
      maxAge: z.number().step(1).min(0).default(172800000).volatile(),
      /** basic | enhanced | auto；enhanced 不额外计费。 */
      proxy: z.string().default("auto").volatile(),
      timeoutMs: z.number().step(1).min(1).default(45000).volatile(),
    }),
  }),
  ledger: z.object({
    enabled: z.boolean().default(true).volatile(),
    /** 留空则用 $DSH_HOME/web-enhance-ledger.json。 */
    path: z.string().default("").volatile(),
  }),
});

/** 读一个 schemastery 字段的当前值；兼容 reactive（.get()）与普通对象。 */
function readField(section, key) {
  const field = section?.[key];
  if (field === undefined || field === null) return undefined;
  return typeof field.get === "function" ? field.get() : field;
}

function normaliseMode(value) {
  return typeof value === "string" && SEARCH_MODES.has(value) ? value : "basic";
}

function normaliseExtractDepth(value) {
  return typeof value === "string" && EXTRACT_DEPTHS.has(value) ? value : "basic";
}

/** 每次搜索前快照一份选项。 */
function searchOptions(ctx, config) {
  const section = config.search;
  const credentials = createCredentialResolver(ctx, {
    literalApiKey: readField(section, "apiKey"),
    apiKeyEnv: readField(section, "apiKeyEnv") ?? "PARALLEL_API_KEY",
  });
  return {
    apiKeyEnv: credentials.envName,
    resolveApiKey: () => credentials.resolve(),
    baseURL: normaliseBaseURL(readField(section, "baseURL"), "https://api.parallel.ai"),
    mode: normaliseMode(readField(section, "mode")),
    maxResults: readField(section, "maxResults") ?? 10,
    maxCharsTotal: readField(section, "maxCharsTotal") ?? 0,
    snippetChars: readField(section, "snippetChars") ?? 1200,
    timeoutMs: readField(section, "timeoutMs") ?? 30000,
    objective: readField(section, "objective") ?? "",
  };
}

/** 每次抓取前快照一份选项。 */
function fetchOptions(ctx, config, ledger) {
  const section = config.fetch;
  const tavilySection = section?.tavily;
  const firecrawlSection = section?.firecrawl;

  const tavilyCredentials = createCredentialResolver(ctx, {
    literalApiKey: readField(tavilySection, "apiKey"),
    apiKeyEnv: readField(tavilySection, "apiKeyEnv") ?? "TAVILY_API_KEY",
  });
  const firecrawlCredentials = createCredentialResolver(ctx, {
    literalApiKey: readField(firecrawlSection, "apiKey"),
    apiKeyEnv: readField(firecrawlSection, "apiKeyEnv") ?? "FIRECRAWL_API_KEY",
  });

  const minChars = readField(section, "minChars") ?? 500;
  const maxBodyChars = readField(section, "maxBodyChars") ?? 200000;

  return {
    minChars,
    maxBodyChars,
    totalTimeoutMs: readField(section, "totalTimeoutMs") ?? 55000,
    ledger,
    tavily: {
      usable: tavilyCredentials.configuredLocally,
      resolveApiKey: () => tavilyCredentials.resolve(),
      apiKeyEnv: tavilyCredentials.envName,
      baseURL: normaliseBaseURL(readField(tavilySection, "baseURL"), "https://api.tavily.com"),
      extractDepth: normaliseExtractDepth(readField(tavilySection, "extractDepth")),
      timeoutMs: readField(tavilySection, "timeoutMs") ?? 20000,
      minChars,
    },
    firecrawl: {
      usable: firecrawlCredentials.configuredLocally,
      resolveApiKey: () => firecrawlCredentials.resolve(),
      apiKeyEnv: firecrawlCredentials.envName,
      baseURL: normaliseBaseURL(readField(firecrawlSection, "baseURL"), "https://api.firecrawl.dev"),
      onlyMainContent: readField(firecrawlSection, "onlyMainContent") !== false,
      maxAge: readField(firecrawlSection, "maxAge") ?? 172800000,
      proxy: readField(firecrawlSection, "proxy") ?? "auto",
      timeoutMs: readField(firecrawlSection, "timeoutMs") ?? 45000,
      ledger,
      maxBodyChars,
    },
  };
}

/** 把三个 provider 注册进 ctx.web。 */
function apply(ctx, config) {
  const ledgerPath = readField(config.ledger, "path");
  const ledger = new QuotaLedger({
    path: typeof ledgerPath === "string" && ledgerPath.length > 0 ? ledgerPath : defaultLedgerPath(),
    enabled: readField(config.ledger, "enabled") !== false,
  });

  ctx.web.registerSearchProvider(new ParallelSearchProvider(() => searchOptions(ctx, config)));

  ctx.web.registerFetchProvider(new AutoFetchProvider(() => fetchOptions(ctx, config, ledger)));

  ctx.web.registerFetchProvider(new FirecrawlFetchProvider(() => fetchOptions(ctx, config, ledger).firecrawl));
}

export {
  AUTO_PROVIDER_ID,
  Config,
  FirecrawlFetchProvider,
  PARALLEL_PROVIDER_ID,
  ParallelSearchProvider,
  AutoFetchProvider,
  apply,
  inject,
  name,
};
