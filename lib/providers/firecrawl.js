/**
 * web_fetch 的第二层：Firecrawl `POST /v2/scrape`。
 *
 * 与 Tavily 同样的归一约定：返回 `{ ok, kind, status, message }`，不抛错。
 *
 * 注意 Firecrawl 是两层状态：HTTP 200 且 `success: true` 只说明请求成功了，
 * 目标页真正的状态码在 `data.metadata.statusCode` 里。
 */
import { endpoint, errorDetail } from "../config.js";
import { postJSON, throwIfAborted } from "../http.js";

/** 本层在额度标记里的 key，与 seam 注册表无关。 */
export const FIRECRAWL_PROVIDER_ID = "firecrawl";

/** 额度类状态码：402/432/433 表示本月套餐额度已经用光。 */
const QUOTA_STATUSES = new Set([402, 432, 433]);
/** 限流只需要退避，不该被记成"额度耗尽"。 */
const RATE_LIMIT_STATUSES = new Set([429]);

/**
 * 抓单个 URL 并取 markdown 正文。
 * @param url - 目标地址。
 * @param options - `{ apiKey, baseURL, onlyMainContent, maxAge, timeoutMs, fetchImpl }`。
 * @param signal - 调用方的取消信号。
 */
export async function firecrawlScrape(url, options, signal) {
  throwIfAborted(signal, "Firecrawl scrape");

  const body = {
    url,
    // 显式锁定 formats，避免命中 Firecrawl 的加价选项（JSON 抽取 +4、highlights +4 …）。
    formats: ["markdown"],
    onlyMainContent: options.onlyMainContent,
  };
  if (Number.isInteger(options.maxAge) && options.maxAge >= 0) {
    body.maxAge = options.maxAge;
  }

  const response = await postJSON(endpoint(options.baseURL, "/v2/scrape"), {
    headers: { authorization: `Bearer ${options.apiKey}` },
    body,
    signal,
    timeoutMs: options.timeoutMs,
    what: "Firecrawl scrape",
    fetchImpl: options.fetchImpl,
  });

  if (!response.ok) return httpFailure(response);

  const json = response.json;
  if (json?.success !== true) {
    return failure("error", response.status, `Firecrawl scrape failed (HTTP ${response.status})${errorDetail(response)}`);
  }

  const data = json.data ?? {};
  const metadata = data.metadata ?? {};
  const statusCode = Number.isInteger(metadata.statusCode) ? metadata.statusCode : 200;
  const finalUrl = typeof metadata.url === "string" && metadata.url.length > 0 ? metadata.url : url;
  const content = typeof data.markdown === "string" ? data.markdown : "";

  if (statusCode >= 400) {
    // 目标页本身是错误页：如实带回状态码，让工具层渲染 "Fetched <url> (HTTP 403)"。
    return { ok: true, url: finalUrl, statusCode, content };
  }
  if (content.length === 0) {
    return failure("empty", statusCode, "Firecrawl returned an empty document");
  }
  return { ok: true, url: finalUrl, statusCode, content };
}

function failure(kind, status, message) {
  return { ok: false, kind, status, message };
}

function httpFailure(response) {
  const detail = errorDetail(response);
  if (QUOTA_STATUSES.has(response.status)) {
    return failure("quota", response.status, `Firecrawl quota exhausted (HTTP ${response.status})${detail}`);
  }
  if (RATE_LIMIT_STATUSES.has(response.status)) {
    return failure("rate-limit", response.status, `Firecrawl rate limited (HTTP ${response.status})${detail}`);
  }
  if (response.status === 401) {
    return failure("credential", response.status, `Firecrawl rejected the API key (HTTP 401)${detail}`);
  }
  if (response.status === 403) {
    return failure("blocked", response.status, `Firecrawl access denied (HTTP 403)${detail}`);
  }
  if (response.status === 404 || response.status === 410) {
    return failure("not-found", response.status, `Firecrawl reports the page does not exist (HTTP ${response.status})${detail}`);
  }
  return failure("error", response.status, `Firecrawl scrape failed (HTTP ${response.status})${detail}`);
}
