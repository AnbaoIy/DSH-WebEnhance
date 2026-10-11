import assert from "node:assert/strict";
import test from "node:test";

import { AUTO_PROVIDER_ID, AutoFetchProvider } from "../lib/providers/auto.js";

const TAVILY_BASE = "https://api.tavily.com";
const FIRECRAWL_BASE = "https://api.firecrawl.dev";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const LONG = `# 标题\n\n${"正文".repeat(400)}`;

class FakeLedger {
  constructor(exhausted) {
    this.exhausted = new Map(exhausted === undefined ? [] : [[exhausted.vendor, exhausted.reason]]);
    this.usage = [];
  }
  async exhaustedReason(vendor) {
    return this.exhausted.get(vendor);
  }
  async markExhausted(vendor, info) {
    this.exhausted.set(vendor, info.reason);
  }
  async noteUsage(vendor, units) {
    this.usage.push({ vendor, units });
  }
}

/** 按 URL 前缀路由的假 fetch，同时记录调用顺序。 */
function router(handlers) {
  const calls = [];
  const impl = async (url, init) => {
    const target = String(url);
    calls.push(target);
    for (const [prefix, respond] of handlers) {
      if (target.startsWith(prefix)) return respond(JSON.parse(init.body));
    }
    throw new Error(`没有为 ${target} 准备响应`);
  };
  return { impl, calls };
}

function makeAuto({ tavilyFetch, firecrawlFetch, ledger, overrides = {} }) {
  return new AutoFetchProvider(() => ({
    minChars: 500,
    maxBodyChars: 200000,
    totalTimeoutMs: 55000,
    ledger,
    tavily: {
      usable: true,
      resolveApiKey: async () => "tvly-key",
      apiKeyEnv: "TAVILY_API_KEY",
      baseURL: TAVILY_BASE,
      extractDepth: "basic",
      timeoutMs: 20000,
      minChars: 500,
      fetchImpl: tavilyFetch,
    },
    firecrawl: {
      usable: true,
      resolveApiKey: async () => "fc-key",
      apiKeyEnv: "FIRECRAWL_API_KEY",
      baseURL: FIRECRAWL_BASE,
      onlyMainContent: true,
      maxAge: 172800000,
      proxy: "auto",
      timeoutMs: 45000,
      maxBodyChars: 200000,
      fetchImpl: firecrawlFetch,
    },
    ...overrides,
  }));
}

const tavilyOk = (content) => jsonResponse({ results: [{ url: "https://example.com/a", raw_content: content }], failed_results: [] });
const firecrawlOk = (markdown) => jsonResponse({
  success: true,
  data: { markdown, metadata: { statusCode: 200, url: "https://example.com/final" } },
});

test("Tavily 抓成功时直接返回，不碰 Firecrawl", async () => {
  const { impl: tavilyFetch } = router([[TAVILY_BASE, () => tavilyOk(LONG)]]);
  const firecrawlCalls = [];
  const ledger = new FakeLedger();

  const provider = makeAuto({
    tavilyFetch,
    firecrawlFetch: async (url) => {
      firecrawlCalls.push(String(url));
      return firecrawlOk(LONG);
    },
    ledger,
  });

  const result = await provider.fetch({ url: "https://example.com/a" }, undefined);

  assert.equal(provider.id, AUTO_PROVIDER_ID);
  // 服务端给的就是 markdown，必须标成 text，否则工具层会用 turndown 再转一遍。
  assert.equal(result.body.kind, "text");
  assert.equal(result.statusCode, 200);
  assert.equal(result.truncated, false);
  assert.deepEqual(firecrawlCalls, []);
  assert.deepEqual(ledger.usage, [{ vendor: "tavily", units: 0.2 }]);
});

test("Tavily 抓到的正文太短时升级到 Firecrawl", async () => {
  const { impl: tavilyFetch } = router([[TAVILY_BASE, () => tavilyOk("太短")]]);
  const { impl: firecrawlFetch, calls } = router([[FIRECRAWL_BASE, () => firecrawlOk(LONG)]]);
  const ledger = new FakeLedger();

  const result = await makeAuto({ tavilyFetch, firecrawlFetch, ledger })
    .fetch({ url: "https://example.com/a" }, undefined);

  assert.equal(calls.length, 1);
  assert.equal(result.url, "https://example.com/final");
  assert.equal(result.body.content, LONG);
  assert.deepEqual(ledger.usage, [{ vendor: "firecrawl", units: 1 }]);
});

test("Tavily 返回反爬页面时升级", async () => {
  const { impl: tavilyFetch } = router([[TAVILY_BASE, () => tavilyOk("Just a moment...")]]);
  const { impl: firecrawlFetch, calls } = router([[FIRECRAWL_BASE, () => firecrawlOk(LONG)]]);

  const result = await makeAuto({ tavilyFetch, firecrawlFetch, ledger: new FakeLedger() })
    .fetch({ url: "https://example.com/a" }, undefined);

  assert.equal(calls.length, 1);
  assert.equal(result.body.content, LONG);
});

test("Tavily 的 HTTP 403 与 200+failed_results 都会升级", async () => {
  for (const respond of [
    () => jsonResponse({ detail: { error: "forbidden" } }, 403),
    () => jsonResponse({ results: [], failed_results: [{ url: "https://example.com/a", error: "403 Forbidden" }] }),
  ]) {
    const { impl: tavilyFetch } = router([[TAVILY_BASE, respond]]);
    const { impl: firecrawlFetch, calls } = router([[FIRECRAWL_BASE, () => firecrawlOk(LONG)]]);

    const result = await makeAuto({ tavilyFetch, firecrawlFetch, ledger: new FakeLedger() })
      .fetch({ url: "https://example.com/a" }, undefined);

    assert.equal(calls.length, 1);
    assert.equal(result.statusCode, 200);
  }
});

test("Tavily 额度耗尽会升级并把本月标记成耗尽", async () => {
  const { impl: tavilyFetch } = router([[TAVILY_BASE, () => jsonResponse({ detail: { error: "plan limit" } }, 432)]]);
  const { impl: firecrawlFetch, calls } = router([[FIRECRAWL_BASE, () => firecrawlOk(LONG)]]);
  const ledger = new FakeLedger();

  const result = await makeAuto({ tavilyFetch, firecrawlFetch, ledger })
    .fetch({ url: "https://example.com/a" }, undefined);

  assert.equal(calls.length, 1);
  assert.equal(result.body.content, LONG);
  assert.match(ledger.exhausted.get("tavily"), /432/u);
});

test("账本已标记耗尽时跳过 Tavily，直接从 Firecrawl 开始", async () => {
  const tavilyCalls = [];
  const { impl: firecrawlFetch, calls } = router([[FIRECRAWL_BASE, () => firecrawlOk(LONG)]]);
  const ledger = new FakeLedger({ vendor: "tavily", reason: "Tavily quota exhausted (HTTP 432)" });

  await makeAuto({
    tavilyFetch: async (url) => {
      tavilyCalls.push(String(url));
      return tavilyOk(LONG);
    },
    firecrawlFetch,
    ledger,
  }).fetch({ url: "https://example.com/a" }, undefined);

  assert.deepEqual(tavilyCalls, []);
  assert.equal(calls.length, 1);
});

test("Tavily 报 404 时直接返回，不再浪费 Firecrawl 的额度", async () => {
  const { impl: tavilyFetch } = router([[TAVILY_BASE, () => jsonResponse({ detail: { error: "not found" } }, 404)]]);
  const firecrawlCalls = [];

  const result = await makeAuto({
    tavilyFetch,
    firecrawlFetch: async (url) => {
      firecrawlCalls.push(String(url));
      return firecrawlOk(LONG);
    },
    ledger: new FakeLedger(),
  }).fetch({ url: "https://example.com/gone" }, undefined);

  assert.deepEqual(firecrawlCalls, []);
  assert.equal(result.statusCode, 404);
  assert.equal(result.body.content, "");
});

test("Tavily 没配 key 时静默降级到 Firecrawl", async () => {
  const { impl: firecrawlFetch, calls } = router([[FIRECRAWL_BASE, () => firecrawlOk(LONG)]]);
  const provider = makeAuto({
    tavilyFetch: async () => {
      throw new Error("不该发出请求");
    },
    firecrawlFetch,
    ledger: new FakeLedger(),
    overrides: {
      tavily: {
        usable: false,
        resolveApiKey: async () => undefined,
        apiKeyEnv: "TAVILY_API_KEY",
        baseURL: TAVILY_BASE,
        extractDepth: "basic",
        timeoutMs: 20000,
        minChars: 500,
      },
    },
  });

  assert.equal(provider.available(), true);
  const result = await provider.fetch({ url: "https://example.com/a" }, undefined);
  assert.equal(calls.length, 1);
  assert.equal(result.body.content, LONG);
});

test("两家都失败时抛出带两家原因的 WEB_PROVIDER_ERROR", async () => {
  const { impl: tavilyFetch } = router([[TAVILY_BASE, () => jsonResponse({ detail: { error: "boom" } }, 500)]]);
  const { impl: firecrawlFetch } = router([[FIRECRAWL_BASE, () => jsonResponse({ detail: { error: "nope" } }, 403)]]);

  await assert.rejects(
    () => makeAuto({ tavilyFetch, firecrawlFetch, ledger: new FakeLedger() })
      .fetch({ url: "https://example.com/a" }, undefined),
    (error) => {
      assert.equal(error.code, "WEB_PROVIDER_ERROR");
      assert.match(error.message, /tavily: Tavily extract failed \(HTTP 500\)/u);
      assert.match(error.message, /firecrawl: Firecrawl access denied \(HTTP 403\)/u);
      return true;
    },
  );
});

test("Firecrawl 报目标页 403 时按结果返回，让工具层显示状态码", async () => {
  const { impl: tavilyFetch } = router([[TAVILY_BASE, () => tavilyOk("太短")]]);
  const { impl: firecrawlFetch } = router([[FIRECRAWL_BASE, () => jsonResponse({
    success: true,
    data: { markdown: "Access denied", metadata: { statusCode: 403, url: "https://example.com/a" } },
  })]]);

  const result = await makeAuto({ tavilyFetch, firecrawlFetch, ledger: new FakeLedger() })
    .fetch({ url: "https://example.com/a" }, undefined);

  assert.equal(result.statusCode, 403);
  assert.equal(result.body.content, "Access denied");
});

test("两家都没配 key 时 available() 为 false，且抓取时报凭据错误", async () => {
  const bare = {
    usable: false,
    resolveApiKey: async () => undefined,
    apiKeyEnv: "TAVILY_API_KEY",
    baseURL: TAVILY_BASE,
    extractDepth: "basic",
    timeoutMs: 20000,
    minChars: 500,
  };
  const provider = makeAuto({
    tavilyFetch: async () => tavilyOk(LONG),
    firecrawlFetch: async () => firecrawlOk(LONG),
    ledger: new FakeLedger(),
    overrides: {
      tavily: bare,
      firecrawl: { ...bare, apiKeyEnv: "FIRECRAWL_API_KEY", baseURL: FIRECRAWL_BASE, onlyMainContent: true, maxAge: 0, proxy: "auto" },
    },
  });

  assert.equal(provider.available(), false);
  await assert.rejects(
    () => provider.fetch({ url: "https://example.com/a" }, undefined),
    (error) => error.code === "WEB_PROVIDER_ERROR" && error.message.includes("no API key configured"),
  );
});
