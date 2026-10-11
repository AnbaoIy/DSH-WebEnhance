/**
 * 出站 HTTP：统一超时、取消与错误归一。
 *
 * 所有网络失败都归一成 WebError，让上层只需要判断"要不要升级到下一家"，
 * 而不是去分辨 Node 的各种底层异常。
 */
import { WebError } from "@deepseek-ai/dsh-web";
import { USER_AGENT } from "./config.js";

/** 调用方主动取消。 */
export function abortError(signal, what) {
  return new WebError(`${what} aborted`, "WEB_ABORTED", {
    cause: signal?.aborted === true ? signal.reason : undefined,
  });
}

/** 进入网络调用前先看一次取消信号。 */
export function throwIfAborted(signal, what) {
  if (signal?.aborted === true) throw abortError(signal, what);
}

/** 把任意异常压成一行可读文本。 */
export function describeError(error) {
  if (error instanceof Error) {
    const cause = error.cause;
    if (cause instanceof Error && cause.message.length > 0 && cause.message !== error.message) {
      return `${error.message} (${cause.message})`;
    }
    return error.message;
  }
  return String(error);
}

/**
 * 发一次 JSON POST，返回 `{ status, ok, headers, json, text }`。
 * 只有网络层失败（连不上、超时、body 读不出来）才抛错；HTTP 状态码原样返回，
 * 由各 provider 自己决定哪些状态码意味着"该升级了"。
 */
export async function postJSON(url, { body, headers, signal, timeoutMs, what, fetchImpl = fetch }) {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const combined = signal === undefined ? timeoutSignal : AbortSignal.any([signal, timeoutSignal]);
  const fail = (error) => {
    if (signal?.aborted === true) return abortError(signal, what);
    if (timeoutSignal.aborted === true) {
      return new WebError(`${what} timed out after ${timeoutMs} ms`, "WEB_PROVIDER_ERROR", { cause: error });
    }
    return new WebError(`${what} failed: ${describeError(error)}`, "WEB_PROVIDER_ERROR", { cause: error });
  };

  let response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": USER_AGENT,
        ...headers,
      },
      body: JSON.stringify(body),
      redirect: "error",
      signal: combined,
    });
  } catch (error) {
    throw fail(error);
  }

  let text = "";
  try {
    text = await response.text();
  } catch (error) {
    throw fail(error);
  }

  let json;
  if (text.length > 0) {
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
  }

  return { status: response.status, ok: response.ok, headers: response.headers, json, text };
}
