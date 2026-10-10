/**
 * 对外触发面的平台账号 PAT（个人访问令牌）共享存储。
 *
 * 为什么需要它：上游 `/v1/*` 只接受 `Authorization: Bearer pat_*`（会话 cookie 不被接受，见冻结面
 * `backend/api/middleware/openapi_auth.go`），而那枚 PAT 与平台账号会话同源——每个副本各自换一枚，
 * 上游就会累积同账号的多枚长期凭据（既无法盘点也无从收敛）。权威副本因此同样放在共享存储
 * （`RCS_REDIS_URL`，宿主经 `getRedisConnection()` 提供），进程内只留一枚短 TTL 缓存；换取新 PAT 用
 * 跨副本租约收口：只有拿到租约的副本去换，其它副本等它写进共享存储后复用。
 *
 * 与 `upstream-session-store` 的关系：两者是**不同的凭据**，因此各自一份实现——会话是登录态（上游单会话，
 * 重登即踢旧键，严格单飞是正确性要求），PAT 是多枚可并存的令牌（并发换取只会多一枚，不会互相作废）；
 * 键名、TTL 来源与失效判定都不同。抽取公共层要改动已交付且被多副本用例覆盖的会话存储，收益（约 60 行）
 * 与回归风险不成比例；出现第三种共享凭据时再做统一抽象。
 *
 * 降级：Redis 未配置、未建连或**操作出错**时退回进程内单例并显式告警——单副本自洽，多副本会各自换取
 * PAT（上游多出几枚同账号凭据，不影响鉴权正确性）。降级绝不改变任何**访问判定**：归属与租户隔离全在
 * 本地注册表与路由层完成，本模块只回答「用哪枚令牌调上游」。
 *
 * 凭据边界：`token` 是密钥材料，只进 Redis 与出站 `Authorization` 头；不进日志、不进响应、不进错误文案、
 * 不进测试 fixture（用例里的值一律运行期生成）。
 */

import { createLogger } from "@fenix/logger";
import { getRedisConnection } from "@fenix/platform-sdk/server";
import type { WorkflowV2RedisClient } from "./upstream-session-store";

const logger = createLogger("wf2-upstream-pat-store");

/** PAT 键与换取租约键；`v1` 是编码版本，改格式时换版本号而不是让新旧值互相解释。 */
const PAT_KEY = "wf2:upstream:pat:v1";
const LEASE_KEY = "wf2:upstream:pat-lease:v1";

/** 键名对照表；导出只为排障（运维在 Redis CLI 里核对键名时不必回到源码里找字面量）。 */
export const UPSTREAM_PAT_REDIS_KEYS = { pat: PAT_KEY, lease: LEASE_KEY } as const;

/** PAT 记录；`token` 是密钥材料，其余字段只用于判定可用性、轮换清理与排障。 */
export interface UpstreamPatRecord {
  /** 令牌明文（`pat_*`）；只在本模块与出站请求头之间流动。 */
  readonly token: string;
  /**
   * 上游侧的令牌 ID（创建响应 `data.personal_access_token.id`）；轮换后用它吊销被替换的旧令牌。
   *
   * 不是密钥材料（它是标识而非凭据），但仍不出现在响应与日志里。旧版本写入的记录没有这个字段，取 null。
   */
  readonly tokenId: string | null;
  /** 换取时刻（毫秒）；同时是「本进程已判定失效」的水位参照。 */
  readonly createdAt: number;
  /** 到期时刻（毫秒）；由换取时请求的有效期推算（见 `upstream-pat`）。 */
  readonly expiresAtMs: number;
}

/** 存储后端；`redis` 表示多副本共享，`memory` 表示进程内单例（降级或未配置 Redis）。 */
export type UpstreamPatStoreKind = "redis" | "memory";

/** PAT 存储的读写与换取租约；每个操作都自带降级（见文件头）。 */
export interface UpstreamPatStore {
  /** 最近一次操作实际使用的后端（Redis 出错后立刻反映为 `memory`，恢复后回到 `redis`）。 */
  currentBackend(): UpstreamPatStoreKind;
  read(): Promise<UpstreamPatRecord | null>;
  write(record: UpstreamPatRecord): Promise<void>;
  clear(): Promise<void>;
  /** 尝试取得换取租约；拿到才允许换取新 PAT（避免多副本同时换出多枚）。 */
  acquireLease(): Promise<boolean>;
  /** 释放自己持有的租约；未持有则什么也不做。 */
  releaseLease(): Promise<void>;
}

/**
 * 租约存活时长。
 *
 * 取 30s：换取本身有 `upstreamTimeoutMs`（默认 10s）的预算，租约必须活得比一次换取更久，否则持有者还在等
 * 上游响应时租约就过期，第二个副本会插进来并发换取；也不能太长——副本崩溃时其它副本要等租约自然过期。
 */
const LEASE_TTL_MS = 30_000;

/** 降级告警的节流窗口：Redis 长时间不可用时，每个请求一行告警会自己变成日志放大面。 */
const DEGRADED_WARNING_INTERVAL_MS = 10 * 60_000;

interface MemoryBackend {
  record: UpstreamPatRecord | null;
  leaseToken: string | null;
  leaseExpiresAtMs: number;
}

let memoryBackend: MemoryBackend = { record: null, leaseToken: null, leaseExpiresAtMs: 0 };
let lastDegradedAtMs: number | null = null;
let lastDegradedWarningAtMs = 0;
let heldLeaseToken: string | null = null;
let storeSingleton: UpstreamPatStore | null = null;

/** 测试用：清空进程内后端、降级标记与告警节流，并换一个全新的存储句柄（生产没有「重置存储」的场景）。 */
export function resetUpstreamPatStoreForTests(): void {
  memoryBackend = { record: null, leaseToken: null, leaseExpiresAtMs: 0 };
  heldLeaseToken = null;
  storeSingleton = null;
  lastDegradedAtMs = null;
  lastDegradedWarningAtMs = 0;
}

/** 降级/失败告警：按窗口节流，内容含原因与后果，**不含任何令牌值**。 */
function reportDegraded(reason: "unavailable" | "operation_failed", error?: unknown): void {
  lastDegradedAtMs = Date.now();
  const now = Date.now();
  if (now - lastDegradedWarningAtMs < DEGRADED_WARNING_INTERVAL_MS) return;
  lastDegradedWarningAtMs = now;
  logger.warn("平台 PAT 退回进程内单例（Redis 不可用），多副本会各自换取令牌", {
    reason,
    error: error instanceof Error ? error.message : undefined,
  });
}

/** JSON 解析 + 形状校验：Redis 里的值可能来自旧版本或被外部改写，形状不符一律按「没有 PAT」处理。 */
function parseRecord(raw: string | null): UpstreamPatRecord | null {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const { token, tokenId, createdAt, expiresAtMs } = parsed as Record<string, unknown>;
    if (typeof token !== "string" || token.length === 0) return null;
    if (typeof createdAt !== "number" || typeof expiresAtMs !== "number") return null;
    // 缺 `tokenId` 的旧记录仍然可用（只是没有可吊销的对象），不因此作废一枚有效令牌。
    return {
      token,
      tokenId: typeof tokenId === "string" && tokenId.length > 0 ? tokenId : null,
      createdAt,
      expiresAtMs,
    };
  } catch {
    // 解析失败不打印原值（可能含令牌材料），只报告「格式不可用」这一事实。
    logger.warn("PAT 存储中的值不是合法 JSON，按无令牌处理");
    return null;
  }
}

/** 令牌在 Redis 里的存活时间：按记录声明的到期时间算（不小于 1 秒）。 */
function recordTtlMs(record: UpstreamPatRecord): number {
  return Math.max(1000, record.expiresAtMs - Date.now());
}

/** 租约释放脚本：只有值仍是自己的 token 才删（避免删掉别的副本刚拿到的租约）。 */
const RELEASE_LEASE_SCRIPT =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";

/** 进程内后端的读写；所有操作都是同步语义，包成 Promise 以对齐接口。 */
const memoryOps = {
  async read(): Promise<UpstreamPatRecord | null> {
    return memoryBackend.record;
  },
  async write(record: UpstreamPatRecord): Promise<void> {
    memoryBackend.record = record;
  },
  async clear(): Promise<void> {
    memoryBackend.record = null;
  },
  async acquireLease(): Promise<boolean> {
    const now = Date.now();
    if (memoryBackend.leaseToken !== null && now < memoryBackend.leaseExpiresAtMs) return false;
    memoryBackend.leaseToken = crypto.randomUUID();
    memoryBackend.leaseExpiresAtMs = now + LEASE_TTL_MS;
    return true;
  },
  async releaseLease(): Promise<void> {
    memoryBackend.leaseToken = null;
    memoryBackend.leaseExpiresAtMs = 0;
  },
};

/** 取 PAT 存储单例；每次操作现取 Redis 连接（与 `upstream-session-store` 同形）。 */
export function getUpstreamPatStore(): UpstreamPatStore {
  storeSingleton ??= createUpstreamPatStore();
  return storeSingleton;
}

/** PAT 存储的构造（只在单例首次取用时执行一次；测试经复位入口换新实例）。 */
function createUpstreamPatStore(): UpstreamPatStore {
  /** 当前可用的 Redis 客户端；`null` 表示宿主未配置/尚未建连，走进程内后端。 */
  const redisClient = (): WorkflowV2RedisClient | null => getRedisConnection<WorkflowV2RedisClient | null>();

  return {
    currentBackend: () => (redisClient() !== null && lastDegradedAtMs === null ? "redis" : "memory"),

    async read() {
      const client = redisClient();
      if (client !== null) {
        try {
          const record = parseRecord(await client.get(PAT_KEY));
          // 一次成功即解除降级标记：宿主重新建连（或 Redis 恢复）后，下一次操作就回到共享后端。
          lastDegradedAtMs = null;
          return record;
        } catch (error) {
          reportDegraded("operation_failed", error);
        }
      } else {
        reportDegraded("unavailable");
      }
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
        await client.set(PAT_KEY, JSON.stringify(record), "PX", recordTtlMs(record));
        // Redis 写成功时**不**写进程内副本：两份状态并存会漂移，降级读可能读到已作废的旧令牌。
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
          await client.del(PAT_KEY);
        } catch (error) {
          reportDegraded("operation_failed", error);
        }
      }
      // 进程内副本一律清空：它的语义是「本进程失效水位的产物」，下次换取会重新写入。
      await memoryOps.clear();
    },

    async acquireLease() {
      const client = redisClient();
      if (client === null) {
        reportDegraded("unavailable");
        return await memoryOps.acquireLease();
      }
      const token = crypto.randomUUID();
      try {
        const result = await client.set(LEASE_KEY, token, "PX", LEASE_TTL_MS, "NX");
        // ioredis 在 `NX` 未取到键时回 null、取到时回 "OK"；统一判据是「非空即成功」。
        if (result !== null && result !== undefined) {
          heldLeaseToken = token;
          return true;
        }
        return false;
      } catch (error) {
        reportDegraded("operation_failed", error);
        // 降级期间的租约只在进程内有效：多副本可能同时换取——这正是告警要传达的后果。
        return await memoryOps.acquireLease();
      }
    },

    async releaseLease() {
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
      await memoryOps.releaseLease();
    },
  };
}
