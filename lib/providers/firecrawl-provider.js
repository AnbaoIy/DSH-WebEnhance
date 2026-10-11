/**
 * 强制走 Firecrawl 的 fetch provider。
 *
 * 抓取链已经由 auto 覆盖；这个 provider 存在的意义是把 `web.fetchProvider`
 * 改成 `firecrawl` 就能跳过 Tavily 直接升级，用于调试和应急。
 */
import { WebError } from "@deepseek-ai/dsh-web";
import { buildFetchResult, notFoundResult } from "../result.js";
import { FIRECRAWL_PROVIDER_ID, firecrawlScrape } from "./firecrawl.js";

export class FirecrawlFetchProvider {
  constructor(resolveOptions) {
    this.resolveOptions = resolveOptions;
    this.id = FIRECRAWL_PROVIDER_ID;
  }

  available() {
    let options;
    try {
      options = this.resolveOptions();
    } catch {
      return false;
    }
    return options.usable;
  }

  async fetch(request, signal) {
    const options = this.resolveOptions();
    const url = request.url;

    const apiKey = await options.resolveApiKey();
    if (apiKey === undefined) {
      throw new WebError(
        `Firecrawl fetch has no API key; set "fetch.firecrawl.apiKey" in the web-enhance config or export ${options.apiKeyEnv} in the launching environment`,
        "WEB_PROVIDER_CREDENTIAL_MISSING",
      );
    }

    const outcome = await firecrawlScrape(url, { ...options, apiKey }, signal);
    if (outcome.ok) {
      await options.ledger.noteUsage(FIRECRAWL_PROVIDER_ID, 1);
      return buildFetchResult(outcome, options.maxBodyChars);
    }
    if (outcome.kind === "not-found") {
      return notFoundResult(url, outcome.status >= 400 ? outcome.status : 404);
    }
    throw new WebError(`Firecrawl fetch failed for ${url} (${outcome.message})`, "WEB_PROVIDER_ERROR");
  }
}
