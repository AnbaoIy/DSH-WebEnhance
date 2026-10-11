import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { QuotaLedger, currentMonth } from "../lib/ledger.js";

async function withTempDir(run) {
  const directory = await mkdtemp(join(tmpdir(), "dsh-webenhance-"));
  try {
    return await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("标记额度耗尽后会持久化，并在新实例里可见", async () => {
  await withTempDir(async (directory) => {
    const path = join(directory, "ledger.json");
    const first = new QuotaLedger({ path, now: () => new Date(2026, 4, 12) });
    assert.equal(await first.exhaustedReason("tavily"), undefined);

    await first.markExhausted("tavily", { reason: "HTTP 432", status: 432 });
    assert.equal(await first.exhaustedReason("tavily"), "HTTP 432");

    const second = new QuotaLedger({ path, now: () => new Date(2026, 4, 28) });
    assert.equal(await second.exhaustedReason("tavily"), "HTTP 432");

    const persisted = JSON.parse(await readFile(path, "utf8"));
    assert.equal(persisted.month, "2026-05");
    assert.equal(persisted.exhausted.tavily.status, 432);
  });
});

test("跨自然月自动失效", async () => {
  await withTempDir(async (directory) => {
    const path = join(directory, "ledger.json");
    const may = new QuotaLedger({ path, now: () => new Date(2026, 4, 31) });
    await may.markExhausted("tavily", { reason: "HTTP 432", status: 432 });

    const june = new QuotaLedger({ path, now: () => new Date(2026, 5, 1) });
    assert.equal(await june.exhaustedReason("tavily"), undefined);
  });
});

test("账本目录不可写时降级为内存状态，不抛错", async () => {
  await withTempDir(async (directory) => {
    // 把一个已存在的文件当成目录用，mkdir/写盘必然失败。
    const path = join(directory, "blocked", "ledger.json");
    const ledger = new QuotaLedger({ path, now: () => new Date(2026, 4, 12) });
    await ledger.markExhausted("tavily", { reason: "HTTP 432", status: 432 });
    assert.equal(await ledger.exhaustedReason("tavily"), "HTTP 432");
  });
});

test("currentMonth 补零", () => {
  assert.equal(currentMonth(new Date(2026, 0, 5)), "2026-01");
  assert.equal(currentMonth(new Date(2026, 11, 31)), "2026-12");
});
