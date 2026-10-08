// packages/chat-channel/src/persist/snapshot-config.ts
// 快照持久化的节流 / TTL 参数契约（SP-A1 / SP-C1）与 SP-0 服务端打点。
//
// 参数值的真相来源是 agent-runtime 模块 `fenix.module.ts` 的 `envDefinitions` 声明
// （`RCS_YJS_SNAPSHOT_INTERVAL_MS` / `RCS_YJS_SNAPSHOT_IDLE_MS` / `RCS_YJS_SNAPSHOT_TTL_SECONDS`）：
// 宿主在启动期完成校验与投影，再经 `ChatChannelDependencies.snapshotPersist` 装入 DocManager，
// 最终落在 provider options 上（见 `state/factory.ts` 的 `safeProvider`）。
//
// 包内**不保留同名默认值，也不读 process.env**：直读拿到的是部署进程的原始字符串，与宿主启动期校验、
// 归一后投影进模块配置的那一份是两个来源；默认值再留一份，两处漂移会在部署后静默生效。
// 宿主未注入时由 `safeProvider` 明确失败。

/** 快照节流 / TTL 参数（`RCS_YJS_SNAPSHOT_*` 三项的装配投影值）。 */
export interface SnapshotPersistConfig {
  /** trailing 节流窗口：距上次成功 CAS 的最小间隔（毫秒） */
  intervalMs: number;
  /** 静默期：持续无新 update 该时长后提前 flush（毫秒） */
  idleMs: number;
  /** 快照滑动 TTL（秒），每次成功 CAS 续期 */
  ttlSeconds: number;
}

/**
 * 参数来源函数。惰性求值不是风格选择：宿主模块配置在应用基础设施初始化完成前不可读，
 * 而 DocManager 单例在文件加载期就已构造。
 */
export type SnapshotPersistConfigSource = () => SnapshotPersistConfig;

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
