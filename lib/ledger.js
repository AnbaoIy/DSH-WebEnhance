/**
 * 额度账本。
 *
 * 三家供应商的免费额度跨操作共享，而且只有 Tavily 提供余额查询接口，
 * 所以这里只做两件事：
 *   1. 记一份"某个供应商的免费额度已经用光"的标记，持久化到 $DSH_HOME，
 *      按自然月自动失效（用户选择：Tavily 额度耗尽就记到月底）。
 *   2. 记一份本地用量计数，纯参考，不参与判断。
 *
 * 账本写不进去（权限、磁盘满）时降级成纯内存状态，绝不让抓取因此失败。
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** 当前自然月，形如 "2026-05"。用本地时区，符合"记到月底"的直觉。 */
export function currentMonth(now = new Date()) {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

/** 默认账本位置：$DSH_HOME/web-enhance-ledger.json。 */
export function defaultLedgerPath(env = process.env) {
  const home = typeof env.DSH_HOME === "string" && env.DSH_HOME.length > 0
    ? env.DSH_HOME
    : join(homedir(), ".dsh");
  return join(home, "web-enhance-ledger.json");
}

/** 空的月度账本。 */
function emptyState(month) {
  return { month, exhausted: {}, usage: {} };
}

export class QuotaLedger {
  #path;
  #enabled;
  #now;
  #state;
  #loading;
  #writing = Promise.resolve();

  constructor({ path = defaultLedgerPath(), enabled = true, now = () => new Date() } = {}) {
    this.#path = path;
    this.#enabled = enabled;
    this.#now = now;
  }

  get path() {
    return this.#path;
  }

  /** 当前账本所属月份。 */
  get month() {
    return currentMonth(this.#now());
  }

  async #load() {
    if (!this.#enabled) {
      this.#state ??= emptyState(this.month);
      return this.#state;
    }
    if (this.#state !== undefined) return this.#state;
    this.#loading ??= this.#read();
    return this.#loading;
  }

  async #read() {
    const month = this.month;
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
    this.#state = usable
      ? {
        month,
        exhausted: { ...parsed.exhausted },
        usage: parsed.usage !== null && typeof parsed.usage === "object" ? { ...parsed.usage } : {},
      }
      : emptyState(month);
    return this.#state;
  }

  /** 原子落盘；失败只吞掉，不影响抓取。 */
  async #persist() {
    if (!this.#enabled || this.#state === undefined) return;
    const payload = `${JSON.stringify(this.#state, null, 2)}\n`;
    this.#writing = this.#writing.then(async () => {
      try {
        await mkdir(dirname(this.#path), { recursive: true });
        const temporary = `${this.#path}.tmp`;
        await writeFile(temporary, payload, "utf8");
        await rename(temporary, this.#path);
      } catch {
        // 账本不可写：保持内存态即可。
      }
    });
    await this.#writing;
  }

  /** 该供应商本月是否已被判定额度耗尽；是则给出原因。 */
  async exhaustedReason(vendor) {
    const state = await this.#load();
    const entry = state.exhausted[vendor];
    return typeof entry?.reason === "string" ? entry.reason : undefined;
  }

  /** 标记额度耗尽（记到本月月底）。 */
  async markExhausted(vendor, { reason, status }) {
    const state = await this.#load();
    state.exhausted[vendor] = { reason, status, at: this.#now().toISOString() };
    await this.#persist();
  }

  /** 本地用量计数，仅供参考。 */
  async noteUsage(vendor, units = 1) {
    const state = await this.#load();
    const entry = state.usage[vendor] ?? { units: 0, calls: 0 };
    state.usage[vendor] = {
      units: entry.units + units,
      calls: entry.calls + 1,
      lastAt: this.#now().toISOString(),
    };
    await this.#persist();
  }

  /** 供诊断/测试读取的快照。 */
  async snapshot() {
    const state = await this.#load();
    return JSON.parse(JSON.stringify(state));
  }
}
