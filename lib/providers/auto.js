/**
 * 抓取链：Tavily 起步，必要时升级到 Firecrawl。
 *
 * 升级条件（三条，都来自与用户确认过的设计）：
 *   1. 额度耗尽 —— Tavily 返回 402/432/433，记进账本直到本月月底；
 *   2. 触发反爬 —— HTTP 403，或返回的正文命中防火墙/登录墙特征；
 *   3. 抓不到内容 —— failed_results 命中该 URL，或正文短到不足以回答任何问题。
 *
 * 不升级的情况：页面确实不存在（404/410）。换哪家都是 404，没必要再花一个 credit。
 *
 * 总预算默认 55s（dsh-tool-web 的 fetchTimeoutMs 在 cordis.patch.yml 里抬到了 60s），
 * 每一层拿到的是 `min(该层超时, 剩余预算)`，保证整条链不会撞上工具层的超时。
 */
import { WebError } from "@deepseek-ai/dsh-web";
import { throwIfAborted } from "../http.js";
import { buildFetchResult, notFoundResult } from "../result.js";
import { FIRECRAWL_PROVIDER_ID, firecrawlScrape } from "./firecrawl.js";
import { TAVILY_PROVIDER_ID, tavilyExtract } from "./tavily.js";

export const AUTO_PROVIDER_ID = "auto";

export class AutoFetchProvider {
  /**
   * @param resolveOptions - 每次抓取前快照一次的配置 thunk。
   */
  constructor(resolveOptions) {
    this.resolveOptions = resolveOptions;
    this.id = AUTO_PROVIDER_ID;
  }

  available() {
    // 同 Parallel：快照配置可能因为 baseURL 写错而抛，但 available() 不许抛。
    let options;
    try {
      options = this.resolveOptions();
    } catch {
      return false;
    }
    return options.tavily.usable || options.firecrawl.usable;
  }

  async fetch(request, signal) {
    const options = this.resolveOptions();
    const url = request.url;
    throwIfAborted(signal, "web fetch");

    const deadline = Date.now() + options.totalTimeoutMs;
    const remaining = () => deadline - Date.now();
    const attempts = [];

    const [tavilyKey, firecrawlKey] = await Promise.all([
      options.tavily.resolveApiKey(),
      options.firecrawl.resolveApiKey(),
    ]);

    // ── 第一层：Tavily ────────────────────────────────────────────────────
    const exhausted = await options.ledger.exhaustedReason(TAVILY_PROVIDER_ID);
    if (tavilyKey === undefined) {
      attempts.push("tavily: no API key configured");
    } else if (exhausted !== undefined) {
      attempts.push(`tavily: skipped, month quota already exhausted (${exhausted})`);
    } else {
      const budget = Math.min(options.tavily.timeoutMs, remaining());
      if (budget <= 0) {
        throw new WebError(
          `web fetch budget of ${options.totalTimeoutMs} ms ran out before Tavily could be tried`,
          "WEB_PROVIDER_ERROR",
        );
      }
      const outcome = await tavilyExtract(url, { ...options.tavily, apiKey: tavilyKey, timeoutMs: budget }, signal);
      if (outcome.ok) {
        await options.ledger.noteUsage(TAVILY_PROVIDER_ID, 0.2);
        return buildFetchResult(outcome, options.maxBodyChars);
      }
      if (outcome.kind === "not-found") {
        return notFoundResult(url, outcome.status >= 400 ? outcome.status : 404);
      }
      if (outcome.kind === "quota") {
        await options.ledger.markExhausted(TAVILY_PROVIDER_ID, { reason: outcome.message, status: outcome.status });
        attempts.push(`tavily: ${outcome.message} (recorded as exhausted until the end of the month)`);
      } else {
        attempts.push(`tavily: ${outcome.message}`);
      }
    }

    // ── 第二层：Firecrawl ────────────────────────────────────────────────
    if (firecrawlKey === undefined) {
      attempts.push("firecrawl: no API key configured");
      throw new WebError(`web fetch failed for ${url} (${attempts.join("; ")})`, "WEB_PROVIDER_ERROR");
    }
    const budget = Math.min(options.firecrawl.timeoutMs, remaining());
    if (budget <= 0) {
      attempts.push(`firecrawl: skipped, ${options.totalTimeoutMs} ms budget exhausted`);
      throw new WebError(`web fetch failed for ${url} (${attempts.join("; ")})`, "WEB_PROVIDER_ERROR");
    }

    const escalated = await firecrawlScrape(
      url,
      { ...options.firecrawl, apiKey: firecrawlKey, timeoutMs: budget },
      signal,
    );
    if (escalated.ok) {
      await options.ledger.noteUsage(FIRECRAWL_PROVIDER_ID, 1);
      return buildFetchResult(escalated, options.maxBodyChars);
    }
    if (escalated.kind === "not-found") {
      return notFoundResult(url, escalated.status >= 400 ? escalated.status : 404);
    }
    attempts.push(`firecrawl: ${escalated.message}`);
    throw new WebError(`web fetch failed for ${url} (${attempts.join("; ")})`, "WEB_PROVIDER_ERROR");
  }
}
