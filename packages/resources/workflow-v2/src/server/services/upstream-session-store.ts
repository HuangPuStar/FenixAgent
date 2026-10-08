/**
 * 上游会话的外部存储（4B）：把「平台账号的登录态」从进程内存搬到多副本可共享的后端。
 *
 * 为什么必须有它：上游是**单会话**账号——重新登录会踢掉旧 `session_key`（P0-2 实测，设计 §9.1.1 第 3 条）。
 * 会话只住在各副本自己的内存里时，任何一次扩容或副本重启都会让两个副本互相踢键：A 登录 → B 的键失效 →
 * B 重登 → A 又失效，表现为画布与列表间歇性 503。
 *
 * 后端选择：
 * - **Redis（`RCS_REDIS_URL`，宿主经 `getRedisConnection()` 提供）**：多副本共享同一份会话与同一把登录租约；
 * - **进程内单例**：Redis 未配置、未建连或**操作出错**时的降级形态，语义与 4B 之前完全一致（单副本自洽，
 *   多副本会互相踢键）——降级必须显式告警（{@link UpstreamSessionStore} 的实现里按窗口节流），绝不静默改变
 *   鉴权语义：降级只影响「谁能复用登录态」，不影响任何访问判定（票据、归属、组织谓词都不经过本模块）。
 *
 * 存储内容与凭据边界：Redis 里存的**只有**会话记录（`session_key` 的 Cookie 头、声明到期时间、登录时刻、
 * 上游回显的用户 ID）。它是凭据材料，因此：只进 Redis 与出站请求头，不进日志、不进响应、不进测试 fixture；
 * 键名带版本前缀，将来改编码格式不会与旧键互相解释。
 *
 * 依赖收窄：本文件不引入 `ioredis`（会话共享只用到四个命令），而是声明结构化的最小客户端接口
 * {@link WorkflowV2RedisClient}，由 `getRedisConnection<T>()` 的泛型参数在读取处收窄——与
 * `@fenix/chat-channel` 的用法一致，但省掉一个包级依赖（本包没有别的 Redis 消费方）。
 */

import { createLogger } from "@fenix/logger";
import { getRedisConnection } from "@fenix/platform-sdk/server";

const logger = createLogger("wf2-upstream-session-store");

/** 会话键与登录租约键；`v1` 是编码版本，改格式时换版本号而不是让新旧值互相解释。 */
const SESSION_KEY = "wf2:upstream:session:v1";
const LEASE_KEY = "wf2:upstream:login-lease:v1";

/**
 * 键名对照表。
 *
 * 导出它的唯一目的是排障：运维在 Redis CLI 里核对「会话是否存在、租约被谁持有」时需要准确的键名，让
 * 每个消费方各写一份字面量迟早会漂移。读写语义不受它影响。
 */
export const UPSTREAM_SESSION_REDIS_KEYS = { session: SESSION_KEY, loginLease: LEASE_KEY } as const;

/**
 * 会话记录（Redis 值与进程内值的同一形状）。
 *
 * `expiresAtMs` 为 null 表示上游没声明 `max-age`（此时不主动判过期，与 `upstream-session` 的口径一致）。
 */
export interface UpstreamSessionRecord {
  /** 出站 `Cookie` 头全文（`session_key=<值>`）；凭据材料，不得进日志。 */
  readonly cookieHeader: string;
  readonly expiresAtMs: number | null;
  readonly loggedInAt: number;
  readonly platformUserId: string | null;
}

/**
 * 本模块用到的 Redis 能力子集（ioredis 客户端在结构上满足它）。
 *
 * 只声明真正用到的三个命令：`GET`、`SET`（带 `PX` 过期，`NX` 只用于租约）、`DEL`，以及租约释放用的
 * `EVAL`（比较后删除，避免误删别的副本刚拿到的租约）。
 */
export interface WorkflowV2RedisClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, px: "PX", milliseconds: number, nx?: "NX"): Promise<unknown>;
  del(key: string): Promise<unknown>;
  eval(script: string, numKeys: number, ...args: string[]): Promise<unknown>;
}

/** 会话存储后端；`redis` 表示多副本共享，`memory` 表示进程内单例（降级或未配置 Redis）。 */
export type UpstreamSessionStoreKind = "redis" | "memory";

/** 会话存储的读写与登录租约；每个操作都自带降级（见文件头）。 */
export interface UpstreamSessionStore {
  /** 最近一次操作实际使用的后端（Redis 出错后立刻反映为 `memory`，恢复后回到 `redis`）。 */
  currentBackend(): UpstreamSessionStoreKind;
  read(): Promise<UpstreamSessionRecord | null>;
  write(record: UpstreamSessionRecord): Promise<void>;
  clear(): Promise<void>;
  /** 尝试取得登录租约；拿到才允许登录（上游单会话，多副本同时登录会互相踢键）。 */
  acquireLoginLease(): Promise<boolean>;
  /** 释放自己持有的租约；未持有则什么也不做。 */
  releaseLoginLease(): Promise<void>;
}

/**
 * 登录租约的存活时长。
 *
 * 取 30s：登录本身有 `upstreamTimeoutMs`（默认 10s）的预算，租约必须活得比一次登录更久，否则持有者还在等
 * 上游响应时租约就过期，第二个副本会插进来并发登录（正是租约要防的事）；也不能太长——副本崩溃时其它副本
 * 要等租约自然过期才能接手，30s 是可接受的恢复延迟。
 */
const LEASE_TTL_MS = 30_000;

/** 上游会话的兜底 TTL：登录响应没声明 `max-age` 时按 30 天存（与 `SessionMaxAgeSecond` 同量级）。 */
const FALLBACK_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** 降级告警的节流窗口：Redis 长时间不可用时，每个请求一行告警会自己变成日志放大面。 */
const DEGRADED_WARNING_INTERVAL_MS = 10 * 60_000;

/** 进程内单例后端（未配置 Redis，或 Redis 操作出错时使用）。 */
interface MemoryBackend {
  record: UpstreamSessionRecord | null;
  leaseToken: string | null;
  leaseExpiresAtMs: number;
}

let memoryBackend: MemoryBackend = { record: null, leaseToken: null, leaseExpiresAtMs: 0 };
let lastDegradedAtMs: number | null = null;
let lastDegradedWarningAtMs = 0;

/** 测试用：清空进程内后端、降级标记与告警节流，并换一个全新的存储句柄（生产没有「重置会话存储」的场景）。 */
export function resetUpstreamSessionStoreForTests(): void {
  memoryBackend = { record: null, leaseToken: null, leaseExpiresAtMs: 0 };
  heldLeaseToken = null;
  storeSingleton = null;
  lastDegradedAtMs = null;
  lastDegradedWarningAtMs = 0;
}

/** 降级/失败告警：按窗口节流，内容含原因与后果，**不含任何会话值**。 */
function reportDegraded(reason: "unavailable" | "operation_failed", error?: unknown): void {
  lastDegradedAtMs = Date.now();
  const now = Date.now();
  if (now - lastDegradedWarningAtMs < DEGRADED_WARNING_INTERVAL_MS) return;
  lastDegradedWarningAtMs = now;
  logger.warn("上游会话退回进程内单例（Redis 不可用），多副本会各自登录并互相踢键", {
    reason,
    error: error instanceof Error ? error.message : undefined,
  });
}

/** JSON 解析 + 形状校验：Redis 里的值可能来自旧版本或被外部改写，形状不符一律按「没有会话」处理。 */
function parseRecord(raw: string | null): UpstreamSessionRecord | null {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const candidate = parsed as Record<string, unknown>;
    const { cookieHeader, expiresAtMs, loggedInAt, platformUserId } = candidate;
    if (typeof cookieHeader !== "string" || cookieHeader.length === 0) return null;
    if (expiresAtMs !== null && typeof expiresAtMs !== "number") return null;
    if (typeof loggedInAt !== "number") return null;
    if (platformUserId !== null && typeof platformUserId !== "string") return null;
    return { cookieHeader, expiresAtMs, loggedInAt, platformUserId };
  } catch {
    // 解析失败不打印原值（可能含会话材料），只报告「格式不可用」这一事实。
    logger.warn("上游会话存储中的值不是合法 JSON，按无会话处理");
    return null;
  }
}

/** 会话在 Redis 里的存活时间：按声明的到期时间算，未声明则用兜底 TTL（都不小于 1 秒）。 */
function sessionTtlMs(record: UpstreamSessionRecord): number {
  if (record.expiresAtMs === null) return FALLBACK_SESSION_TTL_MS;
  return Math.max(1000, record.expiresAtMs - Date.now());
}

/** 租约释放脚本：只有值仍是自己的 token 才删（避免删掉别的副本刚拿到的租约）。 */
const RELEASE_LEASE_SCRIPT =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";

/** 进程内后端的读写；所有操作都是同步语义，包成 Promise 以对齐接口。 */
const memoryOps = {
  async read(): Promise<UpstreamSessionRecord | null> {
    return memoryBackend.record;
  },
  async write(record: UpstreamSessionRecord): Promise<void> {
    memoryBackend.record = record;
  },
  async clear(): Promise<void> {
    memoryBackend.record = null;
  },
  async acquireLoginLease(): Promise<boolean> {
    const now = Date.now();
    if (memoryBackend.leaseToken !== null && now < memoryBackend.leaseExpiresAtMs) return false;
    memoryBackend.leaseToken = crypto.randomUUID();
    memoryBackend.leaseExpiresAtMs = now + LEASE_TTL_MS;
    return true;
  },
  async releaseLoginLease(): Promise<void> {
    memoryBackend.leaseToken = null;
    memoryBackend.leaseExpiresAtMs = 0;
  },
};

/** 读取本进程持有的租约 token；`null` 表示本进程没有租约可释放。 */
let heldLeaseToken: string | null = null;

/** 进程级唯一存储句柄（跨调用复用，避免每次请求都新建对象与闭包）。 */
let storeSingleton: UpstreamSessionStore | null = null;

/** 取会话存储单例；每次操作现取 Redis 连接（见 {@link getUpstreamSessionStoreWithClient}）。 */
export function getUpstreamSessionStore(): UpstreamSessionStore {
  storeSingleton ??= createUpstreamSessionStore();
  return storeSingleton;
}

/** 会话存储的构造（只在单例首次取用时执行一次；导出以便将来需要多实例时复用，测试经复位入口换新实例）。 */
function createUpstreamSessionStore(): UpstreamSessionStore {
  /** 当前可用的 Redis 客户端；`null` 表示宿主未配置/尚未建连，走进程内后端。 */
  const redisClient = (): WorkflowV2RedisClient | null => getRedisConnection<WorkflowV2RedisClient | null>();

  return {
    currentBackend: () => (redisClient() !== null && lastDegradedAtMs === null ? "redis" : "memory"),

    async read() {
      const client = redisClient();
      if (client !== null) {
        try {
          const record = parseRecord(await client.get(SESSION_KEY));
          // 一次成功即解除降级标记：宿主重新建连（或 Redis 恢复）后，下一次操作就回到共享后端。
          lastDegradedAtMs = null;
          return record;
        } catch (error) {
          reportDegraded("operation_failed", error);
        }
      } else {
        reportDegraded("unavailable");
      }
      // 降级读：进程内副本只在「默认单例」这一段可用期里有值（Redis 正常时这里恒为空，见 write 的注释）。
      return await memoryOps.read();
    },

    async write(record) {
      const client = redisClient();
      if (client === null) {
        reportDegraded("unavailable");
        await memoryOps.write(record);
        return;
      }
      try {
        await client.set(SESSION_KEY, JSON.stringify(record), "PX", sessionTtlMs(record));
        // Redis 写成功时**不**写进程内副本：两份状态一旦并存就会漂移，降级读到的可能是被上游踢掉的旧键。
      } catch (error) {
        reportDegraded("operation_failed", error);
        await memoryOps.write(record);
      }
    },

    async clear() {
      const client = redisClient();
      if (client === null) {
        reportDegraded("unavailable");
      } else {
        try {
          await client.del(SESSION_KEY);
        } catch (error) {
          reportDegraded("operation_failed", error);
        }
      }
      // 进程内副本一律清空：它是降级期间的残留，留着会在下一次 Redis 故障时复活一个已判定失效的会话。
      await memoryOps.clear();
    },

    async acquireLoginLease() {
      const client = redisClient();
      if (client === null) {
        reportDegraded("unavailable");
        return await memoryOps.acquireLoginLease();
      }
      const token = crypto.randomUUID();
      try {
        const result = await client.set(LEASE_KEY, token, "PX", LEASE_TTL_MS, "NX");
        // ioredis 在 `NX` 未取到键时回 null、取到时回 "OK"；统一判据是「非空即成功」，不逐字比对返回值。
        if (result !== null && result !== undefined) {
          heldLeaseToken = token;
          return true;
        }
        return false;
      } catch (error) {
        reportDegraded("operation_failed", error);
        // 降级期间的租约只在进程内有效：多副本可能同时登录并互相踢键——这正是告警要传达的后果。
        return await memoryOps.acquireLoginLease();
      }
    },

    async releaseLoginLease() {
      const token = heldLeaseToken;
      heldLeaseToken = null;
      const client = redisClient();
      if (client !== null && token !== null) {
        try {
          await client.eval(RELEASE_LEASE_SCRIPT, 1, LEASE_KEY, token);
          return;
        } catch (error) {
          // 释放失败不是错误路径的终点：租约会在 TTL 后自然过期，其它副本最多多等一个租约周期。
          reportDegraded("operation_failed", error);
        }
      }
      await memoryOps.releaseLoginLease();
    },
  };
}
