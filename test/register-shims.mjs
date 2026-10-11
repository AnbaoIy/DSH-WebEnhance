/**
 * 测试启动钩子：注册 @deepseek-ai/* 的解析替身。
 *
 * 用法：node --test --test-isolation=none --import ./test/register-shims.mjs 'test/**\/*.test.mjs'
 * （见 package.json 的 scripts.test）
 *
 * 为什么不在 node_modules/ 里放 shim：安装插件用的是 `link:`，整个插件目录会被
 * 链进 profile，插件自己的 node_modules 会遮蔽 dsh 自带的真包。曾经因此让
 * @deepseek-ai/schemastery 解析到替身，缺少 Config["~standard"]，插件激活失败。
 * 详见 test/shims/schemastery.js 顶部注释。
 */
import { register } from "node:module";
import { pathToFileURL } from "node:url";

register("./shims-resolver.mjs", pathToFileURL(import.meta.filename));
