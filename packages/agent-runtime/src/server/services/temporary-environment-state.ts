import { createLogger } from "@fenix/logger";
import { getAgentRuntimeConfig } from "../config";
import {
  environmentRepo,
  listExpiredUnreclaimedTemporaryEnvironments,
  listUnexpiredTemporaryEnvironmentExpiries,
  markTemporaryEnvironmentReclaimed,
} from "../repositories/environment";
import { TemporaryEnvironmentLifecycle } from "./temporary-environment-lifecycle";

const logger = createLogger("temporary-environment");
let stopEnvironment: ((id: string) => Promise<void>) | undefined;
/** Runtime 装配严格停止回调；TTL 不复用 idle 的可回收判据。 */
export function bindTemporaryEnvironmentStop(stop: (id: string) => Promise<void>): void {
  stopEnvironment = stop;
}
/** 全进程共用环境期限协调器，持久记录每次从 owner 仓储重读。 */
export const temporaryEnvironmentLifecycle = new TemporaryEnvironmentLifecycle({
  read: (id) => environmentRepo.getById(id),
  writeExpiry: async (id, expiresAt) => {
    if (!(await environmentRepo.update(id, { expiresAt, expiryReclaimedAt: null })))
      throw new Error("Environment disappeared during renewal");
    scheduleTemporaryEnvironmentExpiry(id, expiresAt);
  },
  markReclaimed: markTemporaryEnvironmentReclaimed,
  stop: async (id) => {
    if (!stopEnvironment) throw new Error("Temporary environment stop is not bound");
    await stopEnvironment(id);
  },
});
interface ExpiryWakeup {
  timer?: ReturnType<typeof setTimeout>;
}
const wakeups = new Map<string, ExpiryWakeup>();
const RECOVERY_INTERVAL_MS = 10 * 60 * 1_000;
const RECOVERY_BATCH_SIZE = 100;
let sweep: ReturnType<typeof setTimeout> | undefined;
let maintenanceActive = false;
let maintenanceGeneration = 0;
let recovery: Promise<void> | undefined;
let recoveryGeneration = 0;

/** 部署上限只读入口，供 AgentConfig owner 的写入校验使用。 */
export function getTemporaryEnvironmentMaxTtl(): number {
  return getAgentRuntimeConfig().tempEnvMaxTtlSeconds ?? 86400;
}
/** 处理后移除成功期限；只保留当前进程尚未确认停止的补偿项。 */
async function expireScheduled(id: string, wakeup: ExpiryWakeup): Promise<void> {
  if (wakeups.get(id) !== wakeup) return;
  try {
    const futureExpiry = await temporaryEnvironmentLifecycle.expire(id);
    if (wakeups.get(id) === wakeup) {
      if (futureExpiry) scheduleTemporaryEnvironmentExpiry(id, futureExpiry);
      else {
        wakeups.delete(id);
      }
    }
  } catch (error) {
    if (wakeups.get(id) === wakeup) wakeups.delete(id);
    logger.error("Temporary environment stop failed; durable sweep will retry", error, { environmentId: id });
  }
}
/** 只保存活动期限的唤醒句柄；续期替换旧回调，停止前仍由 lifecycle 重读 DB。 */
export function scheduleTemporaryEnvironmentExpiry(id: string, expiresAt: Date): void {
  const old = wakeups.get(id);
  if (old?.timer) clearTimeout(old.timer);
  const wakeup: ExpiryWakeup = {};
  wakeups.set(id, wakeup);
  wakeup.timer = setTimeout(
    () => {
      wakeup.timer = undefined;
      void expireScheduled(id, wakeup);
    },
    Math.max(0, Math.min(2_147_483_647, expiresAt.getTime() - Date.now())),
  );
  wakeup.timer.unref();
}
/** 补扫持久待办；单轮固定截止时间并按 ID 翻页，不因某项持续失败而饿死后续环境。 */
export function recoverExpiredTemporaryEnvironments(): Promise<void> {
  const generation = maintenanceGeneration;
  if (recovery && recoveryGeneration === generation) return recovery;
  recoveryGeneration = generation;
  const work = async () => {
    const before = new Date();
    let afterId: string | undefined;
    while (maintenanceActive && maintenanceGeneration === generation) {
      const batch = await listExpiredUnreclaimedTemporaryEnvironments(before, afterId, RECOVERY_BATCH_SIZE);
      for (const { id } of batch) {
        if (!maintenanceActive || maintenanceGeneration !== generation) return;
        try {
          const expiry = await temporaryEnvironmentLifecycle.expire(id);
          if (!maintenanceActive || maintenanceGeneration !== generation) return;
          if (expiry) scheduleTemporaryEnvironmentExpiry(id, expiry);
        } catch (error) {
          logger.error("Temporary environment reclamation remains pending", error, { environmentId: id });
        }
      }
      if (batch.length < RECOVERY_BATCH_SIZE) return;
      afterId = batch[batch.length - 1].id;
    }
  };
  const pending = work().finally(() => {
    if (recovery === pending) recovery = undefined;
  });
  recovery = pending;
  return pending;
}

async function runSweep(generation: number): Promise<void> {
  try {
    await recoverExpiredTemporaryEnvironments();
  } catch (error) {
    logger.error("Temporary environment durable recovery query failed", error);
  }
  if (maintenanceActive && maintenanceGeneration === generation) {
    sweep = setTimeout(() => void runSweep(generation), RECOVERY_INTERVAL_MS);
    sweep.unref();
  }
}
/** 入口开放前按原期限恢复到期任务；Runtime 恢复仍沿用现有节点生命周期。 */
export async function startTemporaryEnvironmentMaintenance(): Promise<void> {
  maintenanceActive = true;
  const generation = ++maintenanceGeneration;
  const environments = await listUnexpiredTemporaryEnvironmentExpiries();
  if (!maintenanceActive || maintenanceGeneration !== generation) return;
  for (const environment of environments) scheduleTemporaryEnvironmentExpiry(environment.id, environment.expiresAt);
  await runSweep(generation);
}
/** 关闭后台句柄；Runtime drain 由原生命周期负责。 */
export function stopTemporaryEnvironmentMaintenance(): void {
  maintenanceActive = false;
  maintenanceGeneration++;
  if (sweep) clearTimeout(sweep);
  for (const wakeup of wakeups.values()) if (wakeup.timer) clearTimeout(wakeup.timer);
  wakeups.clear();
}
