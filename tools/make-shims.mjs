/**
 * 生成 @deepseek-ai/* 的本地 shim，只为跑单元测试。
 *
 * 真实运行时这些包由 dsh 自带的 fallback node_modules 提供（它们躺在 app.asar 里），
 * 所以插件源码不需要、也不应该自带它们。测试环境里没有 dsh，就补一层最小的替身。
 *
 * 产物写在 node_modules/ 下，已被 .gitignore 忽略；`npm test` 会先跑本脚本。
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const scope = join(root, "node_modules", "@deepseek-ai");

const packageJSON = (name) => `${JSON.stringify({
  name: `@deepseek-ai/${name}`,
  version: "0.0.0-local-shim",
  private: true,
  type: "module",
  main: "index.js",
  exports: { ".": "./index.js" },
}, null, 2)}\n`;

/** schemastery：只需要让 Config 的链式 DSL 能构造出来，测试不经过它做校验。 */
const SCHEMASTERY = `class Schema {
  constructor(meta = {}) {
    this.meta = meta;
  }
  default(value) { return new Schema({ ...this.meta, default: value }); }
  role(value) { return new Schema({ ...this.meta, role: value }); }
  volatile() { return this; }
  step(value) { return new Schema({ ...this.meta, step: value }); }
  min(value) { return new Schema({ ...this.meta, min: value }); }
  max(value) { return new Schema({ ...this.meta, max: value }); }
  description(value) { return new Schema({ ...this.meta, description: value }); }
}

const z = {
  string: () => new Schema({ type: "string" }),
  number: () => new Schema({ type: "number" }),
  boolean: () => new Schema({ type: "boolean" }),
  object: (shape) => new Schema({ type: "object", shape }),
  union: (list) => new Schema({ type: "union", list }),
  const: (value) => new Schema({ type: "const", value }),
  array: (inner) => new Schema({ type: "array", inner }),
};

export { Schema, z };
export default z;
`;

/** dsh-web：测试只用到 WebError 的 code 字段。 */
const DSH_WEB = `export class HarnessError extends Error {
  constructor(message, code, options = {}) {
    super(message, options);
    this.name = "HarnessError";
    this.code = code;
  }
}

export class WebError extends HarnessError {
  constructor(message, code, options = {}) {
    super(message, code, options);
    this.name = "WebError";
  }
}
`;

/** dsh-credentials：credentialRef 把配置里的名字规整成一个引用标识。 */
const DSH_CREDENTIALS = `export function credentialRef(name) {
  return typeof name === "string" && name.length > 0 ? name : "UNKNOWN_CREDENTIAL";
}
`;

/** dsh-launch-environment：测试用 ctx.__launchEnvironment 注入环境变量。 */
const DSH_LAUNCH_ENVIRONMENT = `export function launchEnvironmentOf(ctx) {
  const store = ctx && ctx.__launchEnvironment;
  return {
    get(name) {
      const value = store instanceof Map ? store.get(name) : store ? store[name] : undefined;
      return typeof value === "string" ? { value } : undefined;
    },
  };
}
`;

const SHIMS = {
  schemastery: SCHEMASTERY,
  "dsh-web": DSH_WEB,
  "dsh-credentials": DSH_CREDENTIALS,
  "dsh-launch-environment": DSH_LAUNCH_ENVIRONMENT,
};

for (const [name, source] of Object.entries(SHIMS)) {
  const directory = join(scope, name);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "package.json"), packageJSON(name), "utf8");
  await writeFile(join(directory, "index.js"), source, "utf8");
}

console.log(`dsh-webenhance: wrote ${Object.keys(SHIMS).length} local shims into ${scope}`);
