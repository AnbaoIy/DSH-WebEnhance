/**
 * 配置与凭据解析。
 *
 * 凭据来源优先级（与 dsh 内置 provider 一致）：
 *   1. config 里写的字面量 apiKey
 *   2. ctx.get("credentials") 凭据服务里按 apiKeyEnv 存的值（dsh 设置页写入的那份）
 *   3. dsh 启动环境里的同名环境变量
 */
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { launchEnvironmentOf } from "@deepseek-ai/dsh-launch-environment";

/** 出站请求的 User-Agent。 */
export const USER_AGENT = "dsh-webenhance/0.1.0";

/**
 * 为一条凭据建解析器。
 * @param ctx - 插件上下文，用于取 credentials 服务与启动环境。
 * @param literalApiKey - config 里的字面量 key（可为空）。
 * @param apiKeyEnv - 凭据引用名 / 环境变量名。
 */
export function createCredentialResolver(ctx, { literalApiKey, apiKeyEnv }) {
  const envName = credentialRef(apiKeyEnv);
  const literal = typeof literalApiKey === "string" && literalApiKey.trim().length > 0
    ? literalApiKey.trim()
    : undefined;

  /** 读启动环境里的值（不是网络调用，可放心在 available() 里用）。 */
  const ambientValue = () => {
    const entry = launchEnvironmentOf(ctx)?.get?.(envName);
    return typeof entry?.value === "string" && entry.value.length > 0 ? entry.value : undefined;
  };

  return {
    envName,
    /** config 里是否写了字面量 key。 */
    hasLiteral: literal !== undefined,
    /** 是否至少有一个本地可见的凭据来源。 */
    configuredLocally: literal !== undefined || ambientValue() !== undefined,
    /**
     * 解析出真正用于请求的 key；没有则返回 undefined。
     * credentials 服务是异步的，所以这里必须是 async。
     */
    async resolve() {
      if (literal !== undefined) return literal;
      const credentials = ctx.get?.("credentials");
      if (credentials !== undefined) {
        const credential = await credentials.resolve(envName);
        if (typeof credential?.value === "string" && credential.value.length > 0) return credential.value;
      }
      return ambientValue();
    },
  };
}

/** 正整数校验。 */
export function isPositiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

/** 非负整数校验。 */
export function isNonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
}

/** 规范化 baseURL：必须是 http(s) 且去掉尾部斜杠。 */
export function normaliseBaseURL(value, fallback) {
  const raw = typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
  if (!URL.canParse(raw)) {
    throw new Error(`dsh-webenhance: invalid baseURL "${raw}"`);
  }
  const url = new URL(raw);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`dsh-webenhance: baseURL must be http(s), got "${raw}"`);
  }
  return raw.replace(/\/+$/u, "");
}

/** 把 baseURL 与路径拼成完整端点。 */
export function endpoint(baseURL, path) {
  return `${baseURL.replace(/\/+$/u, "")}/${path.replace(/^\/+/u, "")}`;
}

/** 从响应体里尽量抠出一条人类可读的错误说明。 */
export function errorDetail(response) {
  const json = response?.json;
  const message = typeof json?.error === "string" ? json.error
    : typeof json?.detail === "string" ? json.detail
    : typeof json?.detail?.error === "string" ? json.detail.error
    : typeof json?.message === "string" ? json.message
    : undefined;
  if (message !== undefined && message.length > 0) return `: ${message}`;
  const text = typeof response?.text === "string" ? response.text.trim() : "";
  return text.length > 0 ? `: ${text.slice(0, 300)}` : "";
}
