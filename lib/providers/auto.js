/**
 * web_fetch 的提供方：按 fetchVendor 在 Tavily 与 Firecrawl 之间调度。
 *
 *   auto       Tavily 起步，必要时升级 Firecrawl
 *   tavily     只用 Tavily
 *   firecrawl  只用 Firecrawl
 *
 * 升级条件（三条）：
 *   1. 额度耗尽 —— Tavily 返回 402/432/433，记进额度标记直到本月月底；
 *   2. 触发反爬 —— HTTP 403，或返回的正文命中防火墙/登录墙特征；
 *   3. 抓不到内容 —— failed_results 命中该 URL，或正文短到不足以回答任何问题。
 *
 * 不升级的情况：页面确实不存在（404/410）。换哪家都是 404，没必要再花一个 credit。
 *
 * 总预算默认 28s：agent 预设里真正生效的 tool-web.fetchTimeoutMs 是 30000，且该行嵌在
 * preset 的 config.plugins[] 内，顶层 cordis.patch.yml 改不到它。每一层拿到的是
 * `min(该层超时, 剩余预算)`，因此整条链不会撞上工具层的超时。
 */
import { WebError } from "@deepseek-ai/dsh-web";
import { isPositiveInteger } from "../config.js";
import { throwIfAborted } from "../http.js";
import { buildFetchResult, notFoundResult } from "../result.js";
import { FIRECRAWL_PROVIDER_ID, firecrawlScrape } from "./firecrawl.js";
import { TAVILY_PROVIDER_ID, tavilyExtract } from "./tavily.js";

/** 本 provider 在 seam 注册表里的 id，也是 plugins 条目 id。 */
export const FETCH_PROVIDER_ID = "web-enhance";

export class EnhancedFetchProvider {
  /**
   * @param resolveOptions - 每次抓取前快照一次的配置 thunk。
   */
  constructor(resolveOptions) {
    this.resolveOptions = resolveOptions;
    this.id = FETCH_PROVIDER_ID;
  }

  /**
   * 同 Parallel：快照配置可能因为 baseURL 写错而抛错，但 available() 不许抛。
   * 这里同样不看凭据是否已配置，理由见 parallel.js 的注释。
   */
  available() {
    let options;
    try {
      options = this.resolveOptions();
    } catch {
      return false;
    }
    return URL.canParse(options.tavily.baseURL)
      && URL.canParse(options.firecrawl.baseURL)
      && isPositiveInteger(options.totalTimeoutMs);
  }

  async fetch(request, signal) {
    const options = this.resolveOptions();
    const url = request.url;
    throwIfAborted(signal, "web fetch");

    const deadline = Date.now() + options.totalTimeoutMs;
    const remaining = () => deadline - Date.now();
    const attempts = [];
    const vendor = options.vendor;

    const wantsTavily = vendor === "auto" || vendor === "tavily";
    const wantsFirecrawl = vendor === "auto" || vendor === "firecrawl";

    const [tavilyKey, firecrawlKey] = await Promise.all([
      wantsTavily ? options.tavily.resolveApiKey() : Promise.resolve(undefined),
      wantsFirecrawl ? options.firecrawl.resolveApiKey() : Promise.resolve(undefined),
    ]);

    // ── 第一层：Tavily ────────────────────────────────────────────────────
    if (wantsTavily) {
      const budget = Math.min(options.tavily.timeoutMs, remaining());
      if (budget <= 0) {
        attempts.push(`tavily: skipped, ${options.totalTimeoutMs} ms budget exhausted`);
      } else if (tavilyKey === undefined) {
        attempts.push(`tavily: no API key configured (${options.tavily.apiKeyEnv})`);
      } else {
        // 强制单家时忽略标记：用户已经明确要求走这一家，耗尽与否由它自己回答。
        const exhausted = vendor === "auto" ? await options.ledger.exhaustedReason(TAVILY_PROVIDER_ID) : undefined;
        if (exhausted !== undefined) {
          attempts.push(`tavily: skipped, month quota already exhausted (${exhausted})`);
        } else {
          const outcome = await tavilyExtract(
            url,
            { ...options.tavily, apiKey: tavilyKey, timeoutMs: budget },
            signal,
          );
          if (outcome.ok) return buildFetchResult(outcome);
          if (outcome.kind === "not-found") {
            return notFoundResult(url, outcome.status >= 400 ? outcome.status : 404);
          }
          if (outcome.kind === "quota") {
            await options.ledger.markExhausted(TAVILY_PROVIDER_ID, {
              reason: outcome.message,
              status: outcome.status,
            });
            attempts.push(`tavily: ${outcome.message} (recorded as exhausted until the end of the month)`);
          } else {
            attempts.push(`tavily: ${outcome.message}`);
          }
        }
      }
      if (!wantsFirecrawl) {
        throw new WebError(`web fetch failed for ${url} (${attempts.join("; ")})`, "WEB_PROVIDER_ERROR");
      }
    }

    // ── 第二层：Firecrawl ────────────────────────────────────────────────
    const budget = Math.min(options.firecrawl.timeoutMs, remaining());
    if (budget <= 0) {
      attempts.push(`firecrawl: skipped, ${options.totalTimeoutMs} ms budget exhausted`);
    } else if (firecrawlKey === undefined) {
      attempts.push(`firecrawl: no API key configured (${options.firecrawl.apiKeyEnv})`);
    } else {
      const exhausted = vendor === "auto" ? await options.ledger.exhaustedReason(FIRECRAWL_PROVIDER_ID) : undefined;
      if (exhausted !== undefined) {
        attempts.push(`firecrawl: skipped, month quota already exhausted (${exhausted})`);
      } else {
        const outcome = await firecrawlScrape(
          url,
          { ...options.firecrawl, apiKey: firecrawlKey, timeoutMs: budget },
          signal,
        );
        if (outcome.ok) return buildFetchResult(outcome);
        if (outcome.kind === "not-found") {
          return notFoundResult(url, outcome.status >= 400 ? outcome.status : 404);
        }
        if (outcome.kind === "quota") {
          await options.ledger.markExhausted(FIRECRAWL_PROVIDER_ID, {
            reason: outcome.message,
            status: outcome.status,
          });
          attempts.push(`firecrawl: ${outcome.message} (recorded as exhausted until the end of the month)`);
        } else {
          attempts.push(`firecrawl: ${outcome.message}`);
        }
      }
    }

    throw new WebError(`web fetch failed for ${url} (${attempts.join("; ")})`, "WEB_PROVIDER_ERROR");
  }
}
