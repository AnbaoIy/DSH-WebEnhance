import assert from "node:assert/strict";
import test from "node:test";

import { SEARCH_PROVIDER_ID, ParallelSearchProvider } from "../lib/providers/parallel.js";

const BASE = "https://api.parallel.ai";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function makeProvider({ fetchImpl, overrides = {} }) {
  return new ParallelSearchProvider(() => ({
    apiKeyEnv: "PARALLEL_API_KEY",
    resolveApiKey: async () => "test-key",
    baseURL: BASE,
    mode: "basic",
    maxResults: 10,
    timeoutMs: 5000,
    fetchImpl,
    ...overrides,
  }));
}

/** 记下唯一一次请求；同一个 Response 读不了两次，所以也接受工厂。 */
function capture(response) {
  const seen = {};
  const fetchImpl = async (url, init) => {
    seen.url = String(url);
    seen.init = init;
    seen.body = JSON.parse(init.body);
    seen.calls = (seen.calls ?? 0) + 1;
    return typeof response === "function" ? response() : response;
  };
  return { seen, fetchImpl };
}

test("把 Parallel 的结果映射成 seam 的 sources", async () => {
  const { seen, fetchImpl } = capture(jsonResponse({
    search_id: "s-1",
    results: [
      { url: "https://example.com/a", title: "A", publish_date: "2026-05-01", excerpts: ["first", "second"] },
      { url: "https://example.com/b", title: null, publish_date: null, excerpts: [] },
      { title: "没有 url 的条目会被丢掉" },
    ],
    usage: [{ name: "sku_search", count: 1 }],
  }));

  const provider = makeProvider({ fetchImpl });
  assert.equal(provider.id, SEARCH_PROVIDER_ID);

  const result = await provider.search({ query: "hello world", maxResults: 5 }, undefined);

  assert.equal(seen.url, `${BASE}/v1/search`);
  assert.equal(seen.init.method, "POST");
  assert.equal(seen.init.headers["x-api-key"], "test-key");
  assert.deepEqual(seen.body.search_queries, ["hello world"]);
  assert.equal(seen.body.mode, "basic");
  assert.equal(seen.body.advanced_settings.max_results, 5);
  // 请求体只发 Parallel 认得的字段。
  assert.deepEqual(Object.keys(seen.body).sort(), ["advanced_settings", "mode", "search_queries"]);
  assert.deepEqual(Object.keys(seen.body.advanced_settings), ["max_results"]);

  assert.equal(result.truncated, false);
  assert.deepEqual(result.sources, [
    {
      url: "https://example.com/a",
      title: "A",
      snippet: "first\n\nsecond",
      publishedAt: "2026-05-01",
    },
    { url: "https://example.com/b" },
  ]);
});

test("request.maxResults 缺省时落到配置值，且不超过配置上限", async () => {
  const { seen, fetchImpl } = capture(() => jsonResponse({ results: [] }));
  const provider = makeProvider({ fetchImpl, overrides: { maxResults: 8 } });

  await provider.search({ query: "q" }, undefined);
  assert.equal(seen.body.advanced_settings.max_results, 8);

  await provider.search({ query: "q", maxResults: 99 }, undefined);
  assert.equal(seen.body.advanced_settings.max_results, 8);
});

test("摘录按固定的 1200 字符截断", async () => {
  const long = "a".repeat(1400);
  const { fetchImpl } = capture(jsonResponse({
    results: [{ url: "https://example.com/a", excerpts: [long] }],
  }));

  const result = await makeProvider({ fetchImpl }).search({ query: "q" }, undefined);
  assert.equal(result.sources[0].snippet.length, 1201);
  assert.equal(result.sources[0].snippet.endsWith("…"), true);
});

test("没有 key 时抛 WEB_PROVIDER_CREDENTIAL_MISSING", async () => {
  const provider = makeProvider({
    fetchImpl: async () => {
      throw new Error("不该发出请求");
    },
    overrides: { resolveApiKey: async () => undefined, apiKeyEnv: "PARALLEL_API_KEY" },
  });

  await assert.rejects(
    () => provider.search({ query: "q" }, undefined),
    (error) => error.code === "WEB_PROVIDER_CREDENTIAL_MISSING" && error.message.includes("PARALLEL_API_KEY"),
  );
});

test("HTTP 401 归为凭据问题，其它非 2xx 归为提供方错误", async () => {
  const rejected = makeProvider({ fetchImpl: async () => jsonResponse({ error: "bad key" }, 401) });
  await assert.rejects(
    () => rejected.search({ query: "q" }, undefined),
    (error) => error.code === "WEB_PROVIDER_CREDENTIAL_MISSING" && error.message.includes("bad key"),
  );

  const broken = makeProvider({ fetchImpl: async () => jsonResponse({ message: "boom" }, 500) });
  await assert.rejects(
    () => broken.search({ query: "q" }, undefined),
    (error) => error.code === "WEB_PROVIDER_ERROR" && error.message.includes("HTTP 500")
      && error.message.includes("boom"),
  );
});

test("available() 是本地检查：不因缺 key 而 false，但 baseURL 非法时 false", () => {
  assert.equal(makeProvider({ fetchImpl: async () => jsonResponse({}) }).available(), true);
  assert.equal(
    makeProvider({
      fetchImpl: async () => jsonResponse({}),
      overrides: { resolveApiKey: async () => undefined },
    }).available(),
    true,
  );
  assert.equal(
    makeProvider({ fetchImpl: async () => jsonResponse({}), overrides: { baseURL: "不是 URL" } }).available(),
    false,
  );
});
