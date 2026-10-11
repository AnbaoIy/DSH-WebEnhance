/**
 * web_search 的提供方：Parallel `POST /v1/search`。
 *
 * 选它的理由：免费额度最大（5000 requests/月，搜索与抓取共享）、限流最宽（600 RPM）、
 * 单价最低，而且一次请求能带多个 query、返回按相关性排序的 markdown 摘录。
 * 弱点是默认走索引缓存，新鲜度不如 Tavily —— 真需要时效性时改用 tavily provider。
 */
import { WebError } from "@deepseek-ai/dsh-web";
import { endpoint, errorDetail, isPositiveInteger } from "../config.js";
import { postJSON, throwIfAborted } from "../http.js";

export const PARALLEL_PROVIDER_ID = "parallel";

export class ParallelSearchProvider {
  /**
   * @param resolveOptions - 每次搜索前快照一次的配置 thunk；
   *   快照语义让设置页改动无需重新注册 provider 即可生效。
   */
  constructor(resolveOptions) {
    this.resolveOptions = resolveOptions;
    this.id = PARALLEL_PROVIDER_ID;
  }

  available() {
    // 契约要求 available() 是廉价的本地检查，且绝不抛错：
    // 配置写错时返回 false，让 seam 去报 WEB_PROVIDER_CONFIGURED_UNAVAILABLE。
    let options;
    try {
      options = this.resolveOptions();
    } catch {
      return false;
    }
    return URL.canParse(options.baseURL)
      && isPositiveInteger(options.maxResults)
      && isPositiveInteger(options.timeoutMs);
  }

  async search(request, signal) {
    const options = this.resolveOptions();
    throwIfAborted(signal, "Parallel search");

    const apiKey = await options.resolveApiKey();
    if (apiKey === undefined) {
      throw new WebError(
        `Parallel search has no API key; set "search.apiKey" in the web-enhance config or export ${options.apiKeyEnv} in the launching environment`,
        "WEB_PROVIDER_CREDENTIAL_MISSING",
      );
    }

    const limit = Math.min(request.maxResults ?? options.maxResults, options.maxResults);
    const payload = {
      search_queries: [request.query],
      mode: options.mode,
      advanced_settings: { max_results: limit },
    };
    if (typeof options.objective === "string" && options.objective.length > 0) {
      payload.objective = options.objective;
    }
    if (isPositiveInteger(options.maxCharsTotal)) {
      payload.max_chars_total = options.maxCharsTotal;
    }

    const response = await postJSON(endpoint(options.baseURL, "/v1/search"), {
      headers: { "x-api-key": apiKey },
      body: payload,
      signal,
      timeoutMs: options.timeoutMs,
      what: "Parallel search",
      fetchImpl: options.fetchImpl,
    });

    if (!response.ok) throw parallelError(response);

    const results = Array.isArray(response.json?.results) ? response.json.results : [];
    return {
      sources: results
        .slice(0, limit)
        .map((item) => projectResult(item, options.snippetChars))
        .filter((source) => source !== undefined),
      truncated: false,
    };
  }
}

/** Parallel 的一次结果是 `{ url, title, publish_date, excerpts[] }`。 */
function projectResult(item, snippetChars) {
  if (item === null || typeof item !== "object") return undefined;
  const url = typeof item.url === "string" && item.url.length > 0 ? item.url : undefined;
  if (url === undefined) return undefined;
  const snippet = excerptText(item.excerpts, snippetChars);
  return {
    url,
    ...(typeof item.title === "string" && item.title.length > 0 ? { title: item.title } : {}),
    ...(snippet !== undefined ? { snippet } : {}),
    ...(typeof item.publish_date === "string" && item.publish_date.length > 0 ? { publishedAt: item.publish_date } : {}),
  };
}

/** 把多条摘录拼成一段，并按配置截断。 */
function excerptText(excerpts, maxChars) {
  if (!Array.isArray(excerpts)) return undefined;
  const joined = excerpts
    .filter((part) => typeof part === "string" && part.trim().length > 0)
    .join("\n\n")
    .trim();
  if (joined.length === 0) return undefined;
  if (!isPositiveInteger(maxChars) || joined.length <= maxChars) return joined;
  return `${joined.slice(0, maxChars)}…`;
}

function parallelError(response) {
  const detail = errorDetail(response);
  if (response.status === 401) {
    return new WebError(
      `Parallel search rejected the API key (HTTP 401)${detail}`,
      "WEB_PROVIDER_CREDENTIAL_MISSING",
    );
  }
  return new WebError(`Parallel search failed (HTTP ${response.status})${detail}`, "WEB_PROVIDER_ERROR");
}
