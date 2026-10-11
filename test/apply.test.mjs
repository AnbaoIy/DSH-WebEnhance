import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { apply } from "../lib/index.js";

/** cordis 交给 apply 的 config 里，叶子字段是 reactive 的。 */
const field = (value) => ({ get: () => value });

function makeConfig(overrides = {}) {
  return {
    search: {
      apiKey: field(undefined),
      apiKeyEnv: field("PARALLEL_API_KEY"),
      baseURL: field("https://api.parallel.ai"),
      mode: field("basic"),
      maxResults: field(10),
      maxCharsTotal: field(0),
      snippetChars: field(1200),
      timeoutMs: field(30000),
      objective: field(""),
      ...(overrides.search ?? {}),
    },
    fetch: {
      minChars: field(500),
      maxBodyChars: field(200000),
      totalTimeoutMs: field(55000),
      ...(overrides.fetch ?? {}),
      tavily: {
        apiKey: field(undefined),
        apiKeyEnv: field("TAVILY_API_KEY"),
        baseURL: field("https://api.tavily.com"),
        extractDepth: field("basic"),
        timeoutMs: field(20000),
        ...(overrides.tavily ?? {}),
      },
      firecrawl: {
        apiKey: field(undefined),
        apiKeyEnv: field("FIRECRAWL_API_KEY"),
        baseURL: field("https://api.firecrawl.dev"),
        onlyMainContent: field(true),
        maxAge: field(172800000),
        proxy: field("auto"),
        timeoutMs: field(45000),
        ...(overrides.firecrawl ?? {}),
      },
    },
    ledger: {
      enabled: field(true),
      path: field(join(tmpdir(), "dsh-webenhance-apply-test.json")),
      ...(overrides.ledger ?? {}),
    },
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

test("apply 注册一个搜索提供方与两个抓取提供方", () => {
  const { ctx, searchProviders, fetchProviders } = makeCtx();
  apply(ctx, makeConfig());

  assert.deepEqual(searchProviders.map((provider) => provider.id), ["parallel"]);
  assert.deepEqual(fetchProviders.map((provider) => provider.id), ["auto", "firecrawl"]);
});

test("没有任何凭据时抓取提供方不可用，但搜索提供方仍然可选", () => {
  const { ctx, searchProviders, fetchProviders } = makeCtx();
  apply(ctx, makeConfig());

  // 搜索侧沿用内置 provider 的约定：key 的有无推迟到调用时再报。
  assert.equal(searchProviders[0].available(), true);
  assert.equal(fetchProviders.find((provider) => provider.id === "auto").available(), false);
  assert.equal(fetchProviders.find((provider) => provider.id === "firecrawl").available(), false);
});

test("启动环境里的 key 让抓取链与强制单家都可用", () => {
  const { ctx, fetchProviders } = makeCtx({ TAVILY_API_KEY: "tvly-x", FIRECRAWL_API_KEY: "fc-x" });
  apply(ctx, makeConfig());

  assert.equal(fetchProviders.find((provider) => provider.id === "auto").available(), true);
  assert.equal(fetchProviders.find((provider) => provider.id === "firecrawl").available(), true);
});

test("只配 Firecrawl 时 auto 仍可用，只是会跳过 Tavily", () => {
  const { ctx, fetchProviders } = makeCtx({ FIRECRAWL_API_KEY: "fc-x" });
  apply(ctx, makeConfig());

  assert.equal(fetchProviders.find((provider) => provider.id === "auto").available(), true);
  assert.equal(fetchProviders.find((provider) => provider.id === "firecrawl").available(), true);
});

test("config 里的字面量 key 也算本地可见", () => {
  const { ctx, fetchProviders } = makeCtx();
  apply(ctx, makeConfig({
    tavily: { apiKey: field("tvly-literal") },
    firecrawl: { apiKey: field("fc-literal") },
  }));

  assert.equal(fetchProviders.find((provider) => provider.id === "auto").available(), true);
});

test("选项是每次调用前快照的，注册后改配置依然生效", () => {
  let baseURL = "https://api.parallel.ai";
  const { ctx, searchProviders } = makeCtx();
  apply(ctx, makeConfig({ search: { baseURL: { get: () => baseURL } } }));

  const provider = searchProviders[0];
  assert.equal(provider.available(), true);

  baseURL = "坏掉的地址";
  assert.equal(provider.available(), false);
});
