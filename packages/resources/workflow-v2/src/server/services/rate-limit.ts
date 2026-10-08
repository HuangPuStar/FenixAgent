/**
 * 令牌桶限流（4B）：画布透传面与票据端点的最小可用保护。
 *
 * 为什么需要它：票据端点里 `session/exchange` 是**免票**入口（它就是拿票的地方），画布面则是唯一能把请求
 * 放大到上游的通道（调试运行以 300ms 间隔轮询 `get_process`）。没有限流时，一次脚本化刷量或前端死循环重试
 * 就能把上游会话、上游配额与本地库一起打满（设计 §4.7「限流与背压」）。
 *
 * 为什么是令牌桶而不是固定窗口：固定窗口在窗口边界允许两倍突发（前一个窗口末尾与后一个窗口开头各打满一次），
 * 而画布流量的形态正是突发（用户打开画布、启动调试）；令牌桶以「容量 = 每分钟阈值」把突发限制在一个明确的
 * 上限内，同时给持续轮询留出与阈值一致的稳态速率。
 *
 * 维度（谁被限）：**票据的 `sub`（我方用户）**，不是来源地址也不是票据本身：
 * - 来源地址在反代之后往往全站同一个（用户的 NAT/入口 IP），按来源限流会把「一个用户在刷」放大成
 *   「同源的所有用户一起被拒」（既有 `session/exchange` 的注释已经指出这个风险）；
 * - 按 `jti`/票据限流可以被重新换票绕过，形同虚设；
 * - `sub` 是鉴权后的稳定主体，正是「按用户配额」的语义。免票的兑换端点没有 `sub` 可用，退化为来源地址
 *   （唯一可用维度），阈值取「正常画布打开远达不到」的量级。
 *
 * 进程内状态：桶住在进程里，多副本部署下实际阈值 = 配置值 × 副本数。这是**显式接受**的取舍（真正的边缘限流
 * 归部署层，见设计 §4.7），不做分布式计数——那需要每次请求一次 Redis 往返，代价与收益（本模块的流量规模）
 * 不成比例；需要全局阈值时应在反代层做。
 *
 * 资源上限：桶按需创建，键数上限 {@link DEFAULT_MAX_KEYS}；达到上限时先回收「已满且闲置」的桶，再按插入序
 * 淘汰最旧的，因此内存不随来源/用户数无界增长（同 `canvas-passthrough` 的惰性回收口径）。
 */

/** 桶参数：容量（突发上限）与补充速率。 */
export interface TokenBucketPolicy {
  /** 桶容量：一次可连续消耗的令牌数（= 允许的瞬时突发）。 */
  readonly capacity: number;
  /** 每秒补充的令牌数。 */
  readonly refillPerSecond: number;
}

/** 一次判定结果。 */
export interface RateLimitDecision {
  readonly allowed: boolean;
  /** 被拒时给调用方的 `Retry-After` 秒数（至少 1）；放行时为 0。 */
  readonly retryAfterSeconds: number;
}

/** 限流面：按 `key` 维护独立桶。 */
export interface TokenBucketLimiter {
  /** 取一个令牌；拒绝时不消耗，但会把当前（未满的）余量记下，等待时间因此是准确的。 */
  tryAcquire(key: string, policy: TokenBucketPolicy, nowMs: number): RateLimitDecision;
  /** 清空全部桶；**只供测试**从零计数（生产没有「重置限流」的场景）。 */
  reset(): void;
}

/** 桶数量上限：超过即回收/淘汰，避免内存随键数无界增长。 */
export const DEFAULT_MAX_KEYS = 4096;

/** 回收判据里的「闲置」时长：满桶闲置这么久之后可以被直接丢弃（再出现时重新填满，语义不变）。 */
const IDLE_EVICTION_MS = 60_000;

/**
 * 把「每分钟阈值」折算成桶参数：容量 = 每分钟阈值（允许一分钟的突发），补充速率 = 阈值 / 60。
 *
 * 容量取一整个窗口的量是刻意的：容量小于阈值会让「打开画布 → 立刻密集拉取」这类正常突发被误伤，
 * 而容量大于阈值则等于悄悄放宽了配置值。
 */
export function policyPerMinute(perMinute: number): TokenBucketPolicy {
  return { capacity: perMinute, refillPerSecond: perMinute / 60 };
}

interface Bucket {
  tokens: number;
  updatedAtMs: number;
}

/** 创建进程内令牌桶限流器；`maxKeys` 只由测试收紧，生产取默认值。 */
export function createTokenBucketLimiter(maxKeys: number = DEFAULT_MAX_KEYS): TokenBucketLimiter {
  const buckets = new Map<string, Bucket>();

  /** 淘汰一个位置：先丢已满且闲置的桶，再按插入序（Map 迭代序）丢最旧的。 */
  function evict(nowMs: number, keepKey: string): void {
    for (const [key, bucket] of buckets) {
      if (key !== keepKey && nowMs - bucket.updatedAtMs >= IDLE_EVICTION_MS) buckets.delete(key);
    }
    while (buckets.size >= maxKeys) {
      const oldest = buckets.keys().next();
      if (oldest.done === true) break;
      buckets.delete(oldest.value);
    }
  }

  return {
    tryAcquire(key, policy, nowMs) {
      const existing = buckets.get(key);
      if (existing === undefined && buckets.size >= maxKeys) evict(nowMs, key);
      const tokens = existing === undefined ? policy.capacity : refill(existing, policy, nowMs);
      if (tokens >= 1) {
        buckets.set(key, { tokens: tokens - 1, updatedAtMs: nowMs });
        return { allowed: true, retryAfterSeconds: 0 };
      }
      buckets.set(key, { tokens, updatedAtMs: nowMs });
      // 补齐一个令牌所需的时间；速率恒为正（策略来自正数配置值）。
      const waitSeconds = (1 - tokens) / policy.refillPerSecond;
      return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(waitSeconds)) };
    },
    reset() {
      buckets.clear();
    },
  };
}

/** 按经过时间补充令牌并封顶到容量；不改状态（调用方负责写回）。 */
function refill(bucket: Bucket, policy: TokenBucketPolicy, nowMs: number): number {
  const elapsedMs = Math.max(0, nowMs - bucket.updatedAtMs);
  return Math.min(policy.capacity, bucket.tokens + (elapsedMs / 1000) * policy.refillPerSecond);
}
