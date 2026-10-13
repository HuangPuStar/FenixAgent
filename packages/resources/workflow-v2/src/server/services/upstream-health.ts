/**
 * 上游健康度与最小熔断（3C）。
 *
 * 为什么需要它：上游不可用时（进程死了、网络断了、会话被踢），控制台与画布面的每一次请求都会走完整
 * 的超时预算（默认 10s）才失败；画布还会自动重试（设计 §5.4 的 0.5s/1.5s/4s/30s）。没有熔断时，上游宕机
 * 期间每个用户请求都在替我们「探测」一个已经确定不可用的上游，线程与连接被拖住，恢复后还会被积压的请求
 * 打一次二次冲击。
 *
 * 口径（冻结 §4 的调用层语义 + 设计 §4.7「写接口不做无边界重试」）：
 * - **只对传输/会话级失败计数**：超时、网络错误、会话不可用（登录失败/重放仍失效）、上游 5xx。业务失败码
 *   （400 缺参、720701011 反序列化失败、777777775 panic、777777769 版本非法……）**一律不计入**——那些是
 *   「上游活着但拒绝了这个请求」，把它们算成失败会让一次参数拼错把整个上游判死；
 * - 连续 {@link UPSTREAM_FAILURE_THRESHOLD} 次这类失败 → **打开**；打开态下 {@link UpstreamHealth.tryAcquire}
 *   返回 false，调用方（`upstream-client`）直接以 503 `upstream_unavailable` 短路，**不发上游请求**；
 * - 打开态持续 {@link UPSTREAM_COOLDOWN_MS} 后 → **半开**，只放行**一次**探测（并发时其余调用仍被短路）；
 *   探测成功即**恢复**（关闭），失败则重新打开并刷新冷却起点；
 * - 状态与判定只住在本模块（禁止在业务函数里散落计数器），时钟可注入以便测试控制冷却窗口。
 *
 * 单例形态：与 `upstream-session` / `iframe-ticket` 相同——进程内自持单例，经 {@link getUpstreamHealth} 取用；
 * 多副本部署时每个副本各自熔断（上游是同一个，各副本的判定会趋同，见设计 §9.3 的部署面待办）。
 */

import { createLogger } from "@fenix/logger";

const logger = createLogger("wf2-upstream-health");

/** 计入熔断的失败种类：只含传输/会话级，业务失败码不在此列（见文件头）。 */
export type UpstreamFailureKind = "timeout" | "network" | "session" | "upstream_5xx";

/** 熔断状态：关闭（正常）/ 打开（短路）/ 半开（放行一次探测）。 */
export type UpstreamCircuitState = "closed" | "open" | "half_open";

/**
 * 连续失败阈值。
 *
 * 取 5：一次上游抖动（单次超时或一次被踢的会话）不应立刻熔断——`callUpstream` 的鉴权失败本身已经带有「重登 +
 * 重放一次」的容错，真正走到这里的是重放后仍失败的确定性故障；而 5 次 × 10s 超时已足够让一个确实宕掉的
 * 上游在 ~50s 内被判定，不会无限拖延。
 */
export const UPSTREAM_FAILURE_THRESHOLD = 5;

/**
 * 冷却时长。
 *
 * 取 30s：与设计 §5.4 给画布定义的「自动重试间隔 30s」同频——熔断恢复的节奏与客户端重试的节奏对齐，避免
 * 「客户端刚重试完，熔断刚好半开」这类无意义的探测碰撞，也不至于让上游恢复后长时间不可用。
 */
export const UPSTREAM_COOLDOWN_MS = 30_000;

/** 熔断状态的只读快照；`cooldownRemainingMs` 只在打开态非 0。 */
export interface UpstreamHealthSnapshot {
  readonly state: UpstreamCircuitState;
  /** 当前连续（计入的）失败次数；成功一次即清零。 */
  readonly consecutiveFailures: number;
  /** 进入打开态的时刻（epoch ms）；非打开态为 null。 */
  readonly openedAtMs: number | null;
  /** 冷却剩余毫秒；非打开态为 0。 */
  readonly cooldownRemainingMs: number;
}

/**
 * 上游健康度判定面。
 *
 * 调用方（`upstream-client`）的用法固定为：`tryAcquire()` 取到名额才允许发请求，随后**恰好一次**用
 * `recordUpstreamSuccess` / `recordUpstreamFailure` / `recordLocalError` 结算——漏结算会让半开探测名额
 * 一直占着，那次探测之后的调用会被持续短路到下一次状态变化为止。
 */
export interface UpstreamHealth {
  /** 是否放行一次上游调用；false 表示熔断打开或已有探测在途，调用方必须直接短路。 */
  tryAcquire(): boolean;
  /** 结算：本次调用拿到了上游的正常响应（含业务失败码）→ 上游可达，清零连续失败。 */
  recordUpstreamSuccess(): void;
  /** 结算：本次调用命中传输/会话级失败 → 计入熔断。 */
  recordUpstreamFailure(kind: UpstreamFailureKind): void;
  /** 结算：本次失败与上游健康无关（我方入参/配置错误）→ 只释放探测名额，不改变状态与计数。 */
  recordLocalError(): void;
  snapshot(): UpstreamHealthSnapshot;
}

/** 熔断判定与状态机；时钟与阈值可注入（测试控制冷却窗口用的就是这两个口子）。 */
export function createUpstreamHealth(
  options: { readonly now?: () => number; readonly failureThreshold?: number; readonly cooldownMs?: number } = {},
): UpstreamHealth {
  const now = options.now ?? Date.now;
  const failureThreshold = options.failureThreshold ?? UPSTREAM_FAILURE_THRESHOLD;
  const cooldownMs = options.cooldownMs ?? UPSTREAM_COOLDOWN_MS;

  let state: UpstreamCircuitState = "closed";
  let consecutiveFailures = 0;
  let openedAtMs: number | null = null;
  /** 半开态下是否已有探测在途：并发调用里只有第一个能拿到名额。 */
  let probeInFlight = false;

  const cooldownRemainingMs = (): number =>
    state === "open" && openedAtMs !== null ? Math.max(0, openedAtMs + cooldownMs - now()) : 0;

  /** 进入/回到打开态；`kind` 只用于日志（探测失败的标签与计数失败不同，便于区分）。 */
  const trip = (kind: UpstreamFailureKind | "probe"): void => {
    state = "open";
    openedAtMs = now();
    probeInFlight = false;
    logger.error("上游熔断打开，冷却期内不再发上游请求", {
      failureKind: kind,
      consecutiveFailures,
      cooldownMs,
      retryAtMs: openedAtMs + cooldownMs,
    });
  };

  return {
    tryAcquire(): boolean {
      if (state === "open") {
        if (cooldownRemainingMs() > 0) return false;
        // 冷却结束：转入半开，只放行一次探测；其余并发调用继续被短路（探测信号必须干净）。
        state = "half_open";
        logger.warn("上游熔断冷却结束，半开放行一次探测", { consecutiveFailures });
      }
      if (state === "half_open") {
        if (probeInFlight) return false;
        probeInFlight = true;
      }
      return true;
    },

    recordUpstreamSuccess(): void {
      const recovered = state !== "closed";
      const previousFailures = consecutiveFailures;
      probeInFlight = false;
      consecutiveFailures = 0;
      state = "closed";
      openedAtMs = null;
      if (recovered) logger.info("上游熔断恢复（关闭）", { previousFailures });
    },

    recordUpstreamFailure(kind: UpstreamFailureKind): void {
      probeInFlight = false;
      consecutiveFailures += 1;
      logger.warn("上游传输/会话级失败计入熔断", { kind, consecutiveFailures, state, failureThreshold });
      // 半开探测失败 → 立刻回到打开态并刷新冷却起点（探测是唯一能证明恢复的信号）。
      if (state === "half_open") {
        trip(kind);
        return;
      }
      // 已在打开态：只累加计数，**不刷新** openedAtMs——否则打开前发出的在途请求会无限延长冷却。
      if (state === "open") return;
      if (consecutiveFailures >= failureThreshold) trip(kind);
    },

    recordLocalError(): void {
      // 本地错误（路径非法、配置缺失）不携带上游健康信息：释放探测名额即可，状态与计数都不动。
      probeInFlight = false;
    },

    snapshot(): UpstreamHealthSnapshot {
      return { state, consecutiveFailures, openedAtMs, cooldownRemainingMs: cooldownRemainingMs() };
    },
  };
}

/** 进程内单例；首次使用时才构造（模块加载期不做任何事）。 */
let current: UpstreamHealth | null = null;

/** 取进程级上游健康度判定面。 */
export function getUpstreamHealth(): UpstreamHealth {
  current ??= createUpstreamHealth();
  return current;
}

/**
 * 测试 seam：把单例换成新实例（可注入时钟），生产代码不得调用。
 *
 * 复位而不是「清空计数」是刻意的：新实例连时钟也一起换掉，用例之间不会互相看到对方推进过的冷却窗口
 * （同 `canvas-passthrough` 的 `resetRateLimitBuckets` 口径）。
 */
export function resetUpstreamHealth(now: () => number = Date.now): void {
  current = createUpstreamHealth({ now });
}
