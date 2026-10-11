/**
 * 测试替身：@deepseek-ai/dsh-launch-environment
 *
 * 测试用 ctx.__launchEnvironment（Map 或普通对象）注入启动环境变量。
 * 真实包由 dsh 自带。
 *
 * 本目录刻意不叫 node_modules，原因见 test/shims/schemastery.js 顶部注释。
 */
export function launchEnvironmentOf(ctx) {
  const store = ctx && ctx.__launchEnvironment;
  return {
    get(name) {
      const value = store instanceof Map ? store.get(name) : store ? store[name] : undefined;
      return typeof value === "string" ? { value } : undefined;
    },
  };
}
