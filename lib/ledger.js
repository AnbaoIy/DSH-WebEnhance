/**
 * 额度标记。
 *
 * 三家供应商的免费额度跨操作共享，而它们之中只有 Tavily 提供余额查询接口，
 * 所以这里不做用量统计，只记一件事：某个供应商的免费额度已经用光。
 *
 * 标记落盘到 $DSH_HOME，按自然月自动失效 —— 免费额度按月重置，所以下个月
 * 应该再给它一次机会，而不是永久拉黑。标记只用于"少白撞一次"，即使全部
 * 丢失也只是多花一次失败的请求，不影响正确性。
 *
 * 写不进去（权限、磁盘满）时降级成纯内存状态，绝不让抓取因此失败。
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** 当前自然月，形如 "2026-05"。用本地时区，符合"记到月底"的直觉。 */
export function currentMonth(now = new Date()) {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

/** 默认标记文件位置：$DSH_HOME/web-enhance-ledger.json。 */
export function defaultLedgerPath(env = process.env) {
  const home = typeof env.DSH_HOME === "string" && env.DSH_HOME.length > 0
    ? env.DSH_HOME
    : join(homedir(), ".dsh");
  return join(home, "web-enhance-ledger.json");
}

/** 空的月度状态。 */
function emptyState(month) {
  return { month, exhausted: {} };
}

export class QuotaLedger {
  #path;
  #now;
  #state;
  #writing = Promise.resolve();

  constructor({ path = defaultLedgerPath(), now = () => new Date() } = {}) {
    this.#path = path;
    this.#now = now;
  }

  get path() {
    return this.#path;
  }

  /** 当前标记所属月份。 */
  get month() {
    return currentMonth(this.#now());
  }

  /** 取本月状态；跨月或首次访问时读一次盘。 */
  async #snapshot() {
    const month = this.month;
    if (this.#state === undefined || this.#state.month !== month) {
      this.#state = await this.#read(month);
    }
    return this.#state;
  }

  async #read(month) {
    let parsed;
    try {
      parsed = JSON.parse(await readFile(this.#path, "utf8"));
    } catch {
      parsed = undefined;
    }
    const usable = parsed !== null
      && typeof parsed === "object"
      && parsed.month === month
      && parsed.exhausted !== null
      && typeof parsed.exhausted === "object";
    return usable ? { month, exhausted: { ...parsed.exhausted } } : emptyState(month);
  }

  /** 原子落盘；失败只吞掉，不影响抓取。 */
  async #persist(state) {
    const payload = `${JSON.stringify(state, null, 2)}\n`;
    this.#writing = this.#writing.then(async () => {
      try {
        await mkdir(dirname(this.#path), { recursive: true });
        const temporary = `${this.#path}.tmp`;
        await writeFile(temporary, payload, "utf8");
        await rename(temporary, this.#path);
      } catch {
        // 标记文件不可写：保持内存态即可。
      }
    });
    await this.#writing;
  }

  /** 该供应商本月是否已被判定额度耗尽；是则给出原因。 */
  async exhaustedReason(vendor) {
    const state = await this.#snapshot();
    const entry = state.exhausted[vendor];
    return typeof entry?.reason === "string" ? entry.reason : undefined;
  }

  /** 标记额度耗尽（记到本月月底，下个月自动失效）。 */
  async markExhausted(vendor, { reason, status }) {
    const state = await this.#snapshot();
    state.exhausted[vendor] = { reason, status, at: this.#now().toISOString() };
    await this.#persist(state);
  }
}
