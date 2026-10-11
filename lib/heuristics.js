/**
 * 内容启发式：判断一份抓取结果是不是"看似成功、实则没用"。
 *
 * 只在 Tavily 这一层使用——它决定要不要多花一个 Firecrawl credit 升级重抓。
 * 判定必须便宜且保守：宁可偶尔多升级一次，也不要把正常正文误判成防火墙页。
 */

/** 反爬 / 拦截页特征词（大小写不敏感）。 */
export const BLOCK_MARKERS = [
  "just a moment",
  "checking your browser",
  "enable javascript and cookies to continue",
  "__cf_chl",
  "cf-browser-verification",
  "attention required! | cloudflare",
  "ddos protection by cloudflare",
  "access denied",
  "request blocked",
  "you have been blocked",
  "please verify you are a human",
  "verify you are human",
  "unusual traffic from your computer network",
  "enable javascript to continue",
];

/** 登录墙特征词。 */
export const LOGIN_MARKERS = [
  "sign in to continue",
  "sign in to view",
  "log in to view",
  "please log in",
  "请登录后查看",
  "登录后继续",
];

/** 只扫描开头这么多个字符，避免正则在超长正文上变慢。 */
const MAX_SCAN_CHARS = 20000;

const MARKERS = [...BLOCK_MARKERS, ...LOGIN_MARKERS];

/** 正文里是否出现反爬/登录墙特征。 */
export function looksBlocked(text) {
  if (typeof text !== "string" || text.length === 0) return false;
  const haystack = text.slice(0, MAX_SCAN_CHARS).toLowerCase();
  return MARKERS.some((marker) => haystack.includes(marker));
}

/**
 * 正文去掉空白后是否短到不足以回答任何问题。
 * minChars <= 0 时关闭该判定。
 */
export function isSparse(text, minChars) {
  if (!Number.isInteger(minChars) || minChars <= 0) return false;
  if (typeof text !== "string") return true;
  return text.replace(/\s+/gu, "").length < minChars;
}
