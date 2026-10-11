import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { apply } from "../lib/index.js";

/** cordis 交给 apply 的 config 里，叶子字段是 reactive 的。 */
const field = (value) => ({ get: () => value });

/** config 全部是顶层字段：设置页的表单模型只按顶层字段名读写。 */
function makeConfig(overrides = {}) {
  return {
    fetchVendor: field("auto"),
    fetchMinChars: field(500),
    fetchTotalTimeoutMs: field(28000),

    searchApiKey: field(undefined),
    searchApiKeyEnv: field("PARALLEL_API_KEY"),
    searchBaseURL: field("https://api.parallel.ai"),
    searchMode: field("basic"),
    searchMaxResults: field(10),
    searchTimeoutMs: field(30000),

    tavilyApiKey: field(undefined),
    tavilyApiKeyEnv: field("TAVILY_API_KEY"),
    tavilyBaseURL: field("https://api.tavily.com"),
    tavilyExtractDepth: field("basic"),
    tavilyTimeoutMs: field(12000),

    firecrawlApiKey: field(undefined),
    firecrawlApiKeyEnv: field("FIRECRAWL_API_KEY"),
    firecrawlBaseURL: field("https://api.firecrawl.dev"),
    firecrawlOnlyMainContent: field(true),
    firecrawlMaxAge: field(172800000),
    firecrawlTimeoutMs: field(45000),

    ledgerPath: field(join(tmpdir(), "dsh-webenhance-apply-test.json")),
    ...overrides,
  };
}

function makeCtx(env = {}) {
  const searchProviders = [];
  const fetchProviders = [];
  return {
    ctx: {
      __launchEnvironment: env,
      get: () => undefined,
      web: {
        registerSearchProvider(provider) {
          searchProviders.push(provider);
          return () => {};
        },
        registerFetchProvider(provider) {
          fetchProviders.push(provider);
          return () => {};
        },
      },
    },
    searchProviders,
    fetchProviders,
  };
}

test("apply 各注册一个搜索提供方与抓取提供方，且共用同一个 id", () => {
  const { ctx, searchProviders, fetchProviders } = makeCtx();
  apply(ctx, makeConfig());

  assert.deepEqual(searchProviders.map((provider) => provider.id), ["web-enhance"]);
  assert.deepEqual(fetchProviders.map((provider) => provider.id), ["web-enhance"]);
});

test("available() 只看本地配置是否成形，不看密钥是否已配", () => {
  const { ctx, searchProviders, fetchProviders } = makeCtx();
  apply(ctx, makeConfig());

  // 与内置 dsh-web-search-deepseek 的约定一致：缺 key 推迟到调用时报
  // WEB_PROVIDER_CREDENTIAL_MISSING，否则只在设置页填 key 的用户会先撞上
  // WEB_PROVIDER_CONFIGURED_UNAVAILABLE。
  assert.equal(searchProviders[0].available(), true);
  assert.equal(fetchProviders[0].available(), true);
});

test("baseURL 写坏时 available() 返回 false", () => {
  const { ctx, searchProviders, fetchProviders } = makeCtx();
  apply(ctx, makeConfig({ searchBaseURL: field("坏掉的地址"), firecrawlBaseURL: field("坏掉的地址") }));

  assert.equal(searchProviders[0].available(), false);
  assert.equal(fetchProviders[0].available(), false);
});

test("选项是每次调用前快照的，注册后改配置依然生效", () => {
  let baseURL = "https://api.parallel.ai";
  const { ctx, searchProviders } = makeCtx();
  apply(ctx, makeConfig({ searchBaseURL: { get: () => baseURL } }));

  const provider = searchProviders[0];
  assert.equal(provider.available(), true);

  baseURL = "坏掉的地址";
  assert.equal(provider.available(), false);
});
