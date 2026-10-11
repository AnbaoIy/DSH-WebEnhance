/**
 * web_search 的提供方：Parallel `POST /v1/search`。
 *
 * 选它的理由：免费额度最大（5000 requests/月，搜索与抓取共享）、限流最宽（600 RPM）、
 * 单价最低，而且一次请求能带多个 query、返回按相关性排序的 markdown 摘录。
 * 弱点是搜索默认走索引缓存，新鲜度弱于实时抓取。
 */
import { WebError } from "@deepseek-ai/dsh-web";
import { endpoint, errorDetail, isPositiveInteger } from "../config.js";
import { postJSON, throwIfAborted } from "../http.js";

/** 本 provider 在 seam 注册表里的 id，也是 plugins 条目 id。 */
export const SEARCH_PROVIDER_ID = "web-enhance";

/** 单条结果摘录的截断长度。Parallel 的 excerpts 有时整段很长，压一下更省上下文。 */
const SNIPPET_CHARS = 1200;

export class ParallelSearchProvider {
  /**
   * @param resolveOptions - 每次搜索前快照一次的配置 thunk；
   *   快照语义让设置页改动无需重新注册 provider 即可生效。
   */
  constructor(resolveOptions) {
    this.resolveOptions = resolveOptions;
    this.id = SEARCH_PROVIDER_ID;
  }

  /**
   * 契约要求 available() 是廉价的本地检查，且绝不抛错。
   *
   * 这里刻意**不看凭据是否存在**：凭据服务是异步的，而 available() 必须同步返回，
   * 任何"本地可见性"判断都会漏掉只在设置页填过 key 的用户，把他们挡在
   * WEB_PROVIDER_CONFIGURED_UNAVAILABLE 外面。缺 key 留到执行时抛
   * WEB_PROVIDER_CREDENTIAL_MISSING —— 与内置 provider 的行为一致。
   */
  available() {
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
        `Parallel search has no API key; set the searchApiKey field in the web-enhance settings, or export ${options.apiKeyEnv} in the launching environment`,
        "WEB_PROVIDER_CREDENTIAL_MISSING",
      );
    }

    const limit = Math.min(request.maxResults ?? options.maxResults, options.maxResults);
    const response = await postJSON(endpoint(options.baseURL, "/v1/search"), {
      headers: { "x-api-key": apiKey },
      body: {
        search_queries: [request.query],
        mode: options.mode,
        advanced_settings: { max_results: limit },
      },
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
        .map(projectResult)
        .filter((source) => source !== undefined),
      truncated: false,
    };
  }
}

/** Parallel 的一次结果是 `{ url, title, publish_date, excerpts[] }`。 */
function projectResult(item) {
  if (item === null || typeof item !== "object") return undefined;
  const url = typeof item.url === "string" && item.url.length > 0 ? item.url : undefined;
  if (url === undefined) return undefined;
  const snippet = excerptText(item.excerpts);
  return {
    url,
    ...(typeof item.title === "string" && item.title.length > 0 ? { title: item.title } : {}),
    ...(snippet !== undefined ? { snippet } : {}),
    ...(typeof item.publish_date === "string" && item.publish_date.length > 0 ? { publishedAt: item.publish_date } : {}),
  };
}

/** 把多条摘录拼成一段，并按固定上限截断。 */
function excerptText(excerpts) {
  if (!Array.isArray(excerpts)) return undefined;
  const joined = excerpts
    .filter((part) => typeof part === "string" && part.trim().length > 0)
    .join("\n\n")
    .trim();
  if (joined.length === 0) return undefined;
  return joined.length <= SNIPPET_CHARS ? joined : `${joined.slice(0, SNIPPET_CHARS)}…`;
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
