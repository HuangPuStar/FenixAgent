// packages/chat-channel/src/persist/snapshot-config.ts
// 快照持久化的节流 / TTL 配置（SP-A1 / SP-C1）与 SP-0 服务端打点。
//
// 配置默认值与 src/env.ts 的 schema 声明保持一致（env.ts 是类型/默认值/部署文档的
// 真相来源）。provider 在包内 factory 深处创建、当前无宿主 DI 通道，因此这里直读
// 同名环境变量；宿主后续把校验后的值经 ChatChannelDependencies 注入 options 时，
// 应删除此直读并仅保留 options 通道。非法值（非正整数）回落默认，不阻塞启动。

const DEFAULT_SNAPSHOT_INTERVAL_MS = 2000;
const DEFAULT_SNAPSHOT_IDLE_MS = 500;
const DEFAULT_SNAPSHOT_TTL_SECONDS = 7 * 24 * 60 * 60;

export type SnapshotEnvConfig = { intervalMs: number; idleMs: number; ttlSeconds: number };

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

let cachedEnvConfig: SnapshotEnvConfig | null = null;

/** 解析快照节流 / TTL 环境配置（进程内缓存一次；options 显式传入优先于此值）。 */
export function getSnapshotEnvConfig(): SnapshotEnvConfig {
  cachedEnvConfig ??= {
    intervalMs: readPositiveIntEnv("RCS_YJS_SNAPSHOT_INTERVAL_MS", DEFAULT_SNAPSHOT_INTERVAL_MS),
    idleMs: readPositiveIntEnv("RCS_YJS_SNAPSHOT_IDLE_MS", DEFAULT_SNAPSHOT_IDLE_MS),
    ttlSeconds: readPositiveIntEnv("RCS_YJS_SNAPSHOT_TTL_SECONDS", DEFAULT_SNAPSHOT_TTL_SECONDS),
  };
  return cachedEnvConfig;
}

// ── SP-0 打点 ──
// 仅尺寸/耗时/标识（docName），绝不包含会话内容。测试环境静默避免污染输出；
// 生产默认 console.log（包内无 @fenix/logger 依赖），宿主接入结构化日志后经
// options.log 注入即可替换。casPerMin 为滚动分钟窗口内的近似计数。
const isTestEnvironment = process.env.NODE_ENV === "test" || (typeof Bun !== "undefined" && !!Bun.env.BUN_TEST);
const snapshotMetrics = { windowStart: Date.now(), windowCount: 0 };

/** 未注入打点接收器时的默认值：生产 console.log、测试静默。 */
export const defaultSnapshotMetricsLog: ((msg: string) => void) | undefined = isTestEnvironment
  ? undefined
  : console.log;

/** 输出一次快照 CAS 打点（字节数 / encode 与 CAS 耗时 / 滚动分钟计数，无内容）。 */
export function reportSnapshotCasMetric(
  log: ((msg: string) => void) | undefined,
  docName: string,
  bytes: number,
  encodeMs: number,
  casMs: number,
  persisted: boolean,
): void {
  if (!log) return;

  const now = Date.now();
  snapshotMetrics.windowCount += 1;
  if (now - snapshotMetrics.windowStart >= 60_000) {
    snapshotMetrics.windowStart = now;
    snapshotMetrics.windowCount = 1;
  }
  log(
    `[redis-provider] snapshot cas doc=${docName} bytes=${bytes} encodeMs=${encodeMs} casMs=${casMs} persisted=${persisted} casPerMin=${snapshotMetrics.windowCount}`,
  );
}
