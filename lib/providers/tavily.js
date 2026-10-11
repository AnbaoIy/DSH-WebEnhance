/**
 * web_fetch 的第一层：Tavily `POST /extract`。
 *
 * 这里不抛错，而是把结果归一成 `{ ok, kind, status, message }`，
 * 因为"抓不到"在抓取链里是一个正常的控制流分支 —— 它决定要不要升级到 Firecrawl。
 * kind 取值：ok / quota / rate-limit / credential / blocked / not-found / empty / error。
 */
import { endpoint, errorDetail } from "../config.js";
import { isSparse, looksBlocked } from "../heuristics.js";
import { postJSON, throwIfAborted } from "../http.js";

export const TAVILY_PROVIDER_ID = "tavily";

/** 额度类状态码：402/432/433 表示本月套餐额度已经用光。 */
const QUOTA_STATUSES = new Set([402, 432, 433]);
/** 限流只需要退避，不该被记成"额度耗尽"。 */
const RATE_LIMIT_STATUSES = new Set([429]);

/**
 * 抓单个 URL。
 * @param url - 目标地址。
 * @param options - `{ apiKey, baseURL, extractDepth, timeoutMs, minChars, fetchImpl }`。
 * @param signal - 调用方的取消信号。
 */
export async function tavilyExtract(url, options, signal) {
  throwIfAborted(signal, "Tavily extract");

  const response = await postJSON(endpoint(options.baseURL, "/extract"), {
    headers: { authorization: `Bearer ${options.apiKey}` },
    body: {
      urls: [url],
      extract_depth: options.extractDepth,
      format: "markdown",
      include_images: false,
    },
    signal,
    timeoutMs: options.timeoutMs,
    what: "Tavily extract",
    fetchImpl: options.fetchImpl,
  });

  if (!response.ok) return httpFailure(response);

  const results = Array.isArray(response.json?.results) ? response.json.results : [];
  const failed = Array.isArray(response.json?.failed_results) ? response.json.failed_results : [];

  const hit = results.find((item) => item?.url === url) ?? results[0];
  if (hit !== undefined) {
    const content = typeof hit.raw_content === "string" ? hit.raw_content : "";
    if (looksBlocked(content)) {
      return failure("blocked", 200, "Tavily returned an anti-bot or login page");
    }
    if (content.length === 0 || isSparse(content, options.minChars)) {
      return failure("empty", 200, "Tavily returned no usable content");
    }
    return {
      ok: true,
      url: typeof hit.url === "string" && hit.url.length > 0 ? hit.url : url,
      statusCode: 200,
      content,
    };
  }

  // Tavily 把抓取失败的 URL 放在 failed_results 里，HTTP 仍然是 200。
  const miss = failed.find((item) => item?.url === url) ?? failed[0];
  if (miss !== undefined) {
    const message = typeof miss.error === "string" && miss.error.length > 0
      ? miss.error
      : "Tavily failed to extract the URL";
    return failure(classifyFailure(message), 200, message);
  }

  return failure("empty", 200, "Tavily returned no result for the URL");
}

function failure(kind, status, message) {
  return { ok: false, kind, status, message };
}

function httpFailure(response) {
  const detail = errorDetail(response);
  if (QUOTA_STATUSES.has(response.status)) {
    return failure("quota", response.status, `Tavily quota exhausted (HTTP ${response.status})${detail}`);
  }
  if (RATE_LIMIT_STATUSES.has(response.status)) {
    return failure("rate-limit", response.status, `Tavily rate limited (HTTP ${response.status})${detail}`);
  }
  if (response.status === 401) {
    return failure("credential", response.status, `Tavily rejected the API key (HTTP 401)${detail}`);
  }
  if (response.status === 403) {
    return failure("blocked", response.status, `Tavily access denied (HTTP 403)${detail}`);
  }
  if (response.status === 404 || response.status === 410) {
    return failure("not-found", response.status, `Tavily reports the page does not exist (HTTP ${response.status})${detail}`);
  }
  return failure("error", response.status, `Tavily extract failed (HTTP ${response.status})${detail}`);
}

/** failed_results[].error 只是一句话，尽力把它归到升级决策需要的那一类。 */
function classifyFailure(message) {
  const text = message.toLowerCase();
  if (/\b(404|410)\b/u.test(text) || text.includes("not found")) return "not-found";
  if (/\b403\b/u.test(text) || text.includes("forbidden") || text.includes("blocked") || text.includes("captcha")) {
    return "blocked";
  }
  if (/\b429\b/u.test(text) || text.includes("rate limit")) return "rate-limit";
  if (text.includes("quota") || text.includes("credit") || text.includes("plan limit")) return "quota";
  return "error";
}
