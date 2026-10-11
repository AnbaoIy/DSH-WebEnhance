/**
 * Node 解析钩子：把 @deepseek-ai/* 的裸导入指向 test/shims/ 下的测试替身。
 *
 * 只对测试生效（由 test/register-shims.mjs 通过 module.register 装载）。
 * 插件源码本身保持裸露导入，真实运行时由 dsh 自带的 node_modules 解析。
 */
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

const SHIMS = new Map([
  ["@deepseek-ai/schemastery", "shims/schemastery.js"],
  ["@deepseek-ai/dsh-web", "shims/dsh-web.js"],
  ["@deepseek-ai/dsh-credentials", "shims/dsh-credentials.js"],
  ["@deepseek-ai/dsh-launch-environment", "shims/dsh-launch-environment.js"],
]);

export async function resolve(specifier, context, nextResolve) {
  const target = SHIMS.get(specifier);
  if (target !== undefined) {
    return { url: pathToFileURL(join(here, target)).href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
