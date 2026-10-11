/**
 * 把 provider 的一手结果归一成 seam 认识的 WebFetchResult。
 */

/**
 * 返回给工具层的正文上限。
 *
 * 不再做成配置项：dsh-tool-web 自己还有 fetchMaxOutputChars（默认 200000）兜着，
 * 这里只需要防一手超长页面把内存撑爆。
 */
export const MAX_BODY_CHARS = 200000;

/**
 * @param outcome - `{ url, statusCode, content }`。
 */
export function buildFetchResult({ url, statusCode = 200, content }) {
  const text = typeof content === "string" ? content : "";
  const truncated = text.length > MAX_BODY_CHARS;
  return {
    url,
    statusCode,
    // 拿到手的就是 markdown，必须声明成 text：
    // dsh-tool-web 只对 kind === "html" 跑 turndown，标成 html 会被二次转换。
    body: { kind: "text", content: truncated ? text.slice(0, MAX_BODY_CHARS) : text },
    truncated,
  };
}

/**
 * 页面确实不存在时的结果。
 * 与内置 http provider 对 404 的处理一致：返回结果而不是抛错，
 * 工具层会渲染成 `Fetched <url> (HTTP 404)`。
 */
export function notFoundResult(url, statusCode = 404) {
  return {
    url,
    statusCode,
    body: { kind: "text", content: "" },
    truncated: false,
  };
}
