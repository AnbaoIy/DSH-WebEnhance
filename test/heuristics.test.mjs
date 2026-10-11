import assert from "node:assert/strict";
import test from "node:test";

import { isSparse, looksBlocked } from "../lib/heuristics.js";

test("looksBlocked 能认出常见防火墙与登录墙", () => {
  assert.equal(looksBlocked("Just a moment..."), true);
  assert.equal(looksBlocked("<title>Attention Required! | Cloudflare</title>"), true);
  assert.equal(looksBlocked("Please verify you are a human to continue"), true);
  assert.equal(looksBlocked("请登录后查看全文"), true);
});

test("looksBlocked 不会把正常正文误判", () => {
  assert.equal(looksBlocked("# 如何绕过 Cloudflare 的验证"), false);
  assert.equal(looksBlocked("本文讨论了 captcha 的识别方案"), false);
  assert.equal(looksBlocked(""), false);
  assert.equal(looksBlocked(undefined), false);
});

test("isSparse 忽略空白后比较长度", () => {
  assert.equal(isSparse("   \n\t  ", 10), true);
  assert.equal(isSparse("abcdefg", 10), true);
  assert.equal(isSparse("abcdefghijk", 10), false);
});

test("isSparse 在 minChars <= 0 时关闭判定", () => {
  assert.equal(isSparse("", 0), false);
  assert.equal(isSparse(undefined, 0), false);
});
