/**
 * 测试替身：@deepseek-ai/schemastery
 *
 * 真实包由 dsh 自带（躺在 app.asar 里）。测试环境没有 dsh，这里只补出
 * lib/ 用到的链式 DSL，让 Config 能构造出来；测试从不经过它做校验。
 *
 * 注意：本目录刻意不叫 node_modules。安装插件用的是 `link:`，整个插件目录
 * 被链进 profile，插件自己的 node_modules 会遮蔽 dsh 自带的真包 —— 早期把
 * 这份替身写在 node_modules/ 下，导致真实运行时 Config["~standard"] 缺失，
 * 插件激活时报 "Cannot read properties of undefined (reading 'validate')"。
 * 现在改由 test/register-shims.mjs 通过 module.register 解析钩子注入。
 */
class Schema {
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
