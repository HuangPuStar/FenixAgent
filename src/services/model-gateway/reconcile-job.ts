import { randomUUID } from "node:crypto";
import { ModelGatewayError } from "@fenix/model-gateway-sdk";
import schedule, { type Job } from "node-schedule";
import type { ModelGatewayCredential } from "../../repositories/model-gateway-credential";

export interface ModelGatewayReconcileJobDeps {
  listMappings: (input: {
    statuses: Array<"active" | "error">;
    afterId?: string;
    limit: number;
  }) => Promise<ModelGatewayCredential[]>;
  isSubjectValid: (mapping: ModelGatewayCredential) => Promise<boolean>;
  blockCredential: (externalCredentialId: string) => Promise<void>;
  updateStatus: (id: string, status: "blocked") => Promise<unknown>;
  clearCredential: (id: string) => Promise<void>;
  withLock: <T>(fn: () => Promise<T>) => Promise<T | null>;
  batchSize?: number;
  concurrency?: number;
}

export interface ReconcileResult {
  runId: string;
  scanned: number;
  invalid: number;
  blocked: number;
  failed: number;
  skipped: boolean;
}

export interface ModelGatewayReconcileScheduleOptions {
  cron: string;
  timezone: string;
}

/**
 * 模型网关凭证夜间对账任务。
 *
 * 任务只依赖当前主体校验函数，不监听业务模块事件；这样接受最多约 24
 * 小时的最终一致性，同时避免在用户、组织和 Agent 写路径增加反向耦合。
 */
export function createModelGatewayReconcileJob(
  deps: ModelGatewayReconcileJobDeps,
  options: ModelGatewayReconcileScheduleOptions,
) {
  if (!options) throw new Error("model gateway reconcile schedule options are required");
  if (!options.cron.trim()) throw new Error("model gateway reconcile cron is required");
  if (!options.timezone.trim()) throw new Error("model gateway reconcile timezone is required");
  const batchSize = deps.batchSize ?? 200;
  const concurrency = Math.max(1, deps.concurrency ?? 5);
  let job: Job | null = null;

  async function run(): Promise<ReconcileResult> {
    const runId = randomUUID();
    const result = await deps.withLock(async () => {
      let afterId: string | undefined;
      let scanned = 0;
      let invalid = 0;
      let blocked = 0;
      let failed = 0;
      while (true) {
        const mappings = await deps.listMappings({ statuses: ["active", "error"], afterId, limit: batchSize });
        if (mappings.length === 0) break;
        scanned += mappings.length;
        afterId = mappings[mappings.length - 1]?.id;
        const invalidMappings: ModelGatewayCredential[] = [];
        for (const mapping of mappings) {
          if (!(await deps.isSubjectValid(mapping))) invalidMappings.push(mapping);
        }
        invalid += invalidMappings.length;
        let nextIndex = 0;
        async function worker() {
          while (true) {
            const mapping = invalidMappings[nextIndex++];
            if (!mapping) return;
            try {
              await deps.blockCredential(mapping.externalCredentialId);
              await deps.updateStatus(mapping.id, "blocked");
              await deps.clearCredential(mapping.id);
              blocked += 1;
            } catch (error) {
              // 远端已经不存在时，状态仍可安全收敛为 blocked。
              if (error instanceof ModelGatewayError && error.code === "NOT_FOUND") {
                await deps.updateStatus(mapping.id, "blocked");
                await deps.clearCredential(mapping.id);
                blocked += 1;
              } else {
                failed += 1;
              }
            }
          }
        }
        await Promise.all(Array.from({ length: Math.min(concurrency, invalidMappings.length) }, () => worker()));
      }
      return { runId, scanned, invalid, blocked, failed, skipped: false };
    });
    return result ?? { runId, scanned: 0, invalid: 0, blocked: 0, failed: 0, skipped: true };
  }

  function start(): void {
    if (job) return;
    job = schedule.scheduleJob({ rule: options.cron, tz: options.timezone }, () => void run());
  }

  function stop(): void {
    job?.cancel();
    job = null;
  }

  return { run, start, stop };
}
