import { createLogger } from "@fenix/logger";
import { AppError } from "@fenix/platform-sdk";
import * as z from "zod/v4";

/** 部署兜底值和动态覆盖共用的并发维度。 */
export interface ConcurrencyLimits {
  readonly agentMaxConcurrency?: number;
  readonly userAgentMaxConcurrency?: number;
  readonly scheduledAgentMaxConcurrency?: number;
}
/** null 表示继承部署值。 */
export interface ConcurrencyOverrides {
  readonly agentMaxConcurrency: number | null;
  readonly userAgentMaxConcurrency: number | null;
  readonly scheduledAgentMaxConcurrency: number | null;
}
/** 策略持久化的独立投影。 */
export interface ConcurrencyPolicyRecord extends ConcurrencyOverrides {
  readonly userId: string | null;
}
/** 策略持久化端口。 */
export interface ConcurrencyPolicyRepository {
  list(): Promise<ConcurrencyPolicyRecord[]>;
  save(userId: string | null, values: ConcurrencyOverrides): Promise<void>;
  delete(userId: string): Promise<void>;
}
/** 管理端显示覆盖、实际值与继承来源。 */
export interface ConcurrencySetting {
  readonly override: number | null;
  readonly value: number | null;
  readonly source: "environment" | "global" | "user";
}
/** 三项并发设置的管理投影。 */
export type ConcurrencyPolicyView = { readonly [K in keyof ConcurrencyOverrides]: ConcurrencySetting };
const logger = createLogger("agent-concurrency-policy");
const keys = ["agentMaxConcurrency", "userAgentMaxConcurrency", "scheduledAgentMaxConcurrency"] as const;
const empty: ConcurrencyOverrides = Object.freeze({
  agentMaxConcurrency: null,
  userAgentMaxConcurrency: null,
  scheduledAgentMaxConcurrency: null,
});
const limitSchema = z.number().int().positive().max(2147483647).nullable();
const overridesSchema = z
  .object({
    agentMaxConcurrency: limitSchema,
    userAgentMaxConcurrency: limitSchema,
    scheduledAgentMaxConcurrency: limitSchema,
  })
  .strict();

/** 提交后发布不可变同步快照；管理写入排队，准入路径没有 await。 */
export class AgentConcurrencyPolicyService {
  private snapshot: { global: ConcurrencyOverrides; users: ReadonlyMap<string, number> } | undefined;
  private writes: Promise<unknown> = Promise.resolve();
  constructor(
    private readonly repository: ConcurrencyPolicyRepository,
    private readonly environment: () => ConcurrencyLimits,
  ) {}

  /** 启动加载失败保持关闭；不得用空策略掩盖数据库故障。 */
  async initialize(): Promise<void> {
    await this.serialize(async () => {
      const rows = await this.repository.list();
      let global = empty;
      const users = new Map<string, number>();
      for (const row of rows) {
        const values = overridesSchema.parse({
          agentMaxConcurrency: row.agentMaxConcurrency,
          userAgentMaxConcurrency: row.userAgentMaxConcurrency,
          scheduledAgentMaxConcurrency: row.scheduledAgentMaxConcurrency,
        });
        if (row.userId === null) global = Object.freeze(values);
        else {
          if (
            values.agentMaxConcurrency !== null ||
            values.scheduledAgentMaxConcurrency !== null ||
            values.userAgentMaxConcurrency === null
          )
            throw new Error("Invalid user concurrency policy");
          users.set(row.userId, values.userAgentMaxConcurrency);
        }
      }
      this.snapshot = { global, users };
      logger.info("Concurrency policy initialized", { userOverrides: users.size });
    });
  }

  /** 同步返回当前有效限额，undefined 沿用原算法的无限制语义。 */
  limits(userId?: string): ConcurrencyLimits {
    const view = this.describe(userId);
    return {
      agentMaxConcurrency: view.agentMaxConcurrency.value ?? undefined,
      userAgentMaxConcurrency: view.userAgentMaxConcurrency.value ?? undefined,
      scheduledAgentMaxConcurrency: view.scheduledAgentMaxConcurrency.value ?? undefined,
    };
  }

  /** 返回独立 DTO，不泄露可变内部快照。 */
  describe(userId?: string): ConcurrencyPolicyView {
    const state = this.current();
    const env = this.environment();
    const setting = (key: keyof ConcurrencyOverrides): ConcurrencySetting => {
      const user = key === "userAgentMaxConcurrency" && userId ? state.users.get(userId) : undefined;
      const override = userId ? (user ?? null) : state.global[key];
      return {
        override,
        value: user ?? state.global[key] ?? env[key] ?? null,
        source: user !== undefined ? "user" : state.global[key] !== null ? "global" : "environment",
      };
    };
    return {
      agentMaxConcurrency: setting(keys[0]),
      userAgentMaxConcurrency: setting(keys[1]),
      scheduledAgentMaxConcurrency: setting(keys[2]),
    };
  }

  /** 列出显式用户覆盖，不把环境或运行实例加入管理列表。 */
  listUsers(): { userId: string; policy: ConcurrencyPolicyView }[] {
    return [...this.current().users.keys()].sort().map((userId) => ({ userId, policy: this.describe(userId) }));
  }

  /** 原子合并部分全局更新，持久化成功后才替换快照。 */
  async patchGlobal(patch: Partial<ConcurrencyOverrides>): Promise<void> {
    const validated = overridesSchema.partial().parse(patch);
    await this.serialize(async () => {
      const state = this.current();
      const global = Object.freeze({ ...state.global, ...validated });
      await this.repository.save(null, global);
      this.snapshot = { ...state, global };
      logger.info("Global concurrency policy committed", { limits: global });
    });
  }

  /** 用户只能覆盖每用户限额；null 等价恢复继承。 */
  async putUser(userId: string, value: number | null): Promise<void> {
    const validated = limitSchema.parse(value);
    if (validated === null) return this.deleteUser(userId);
    await this.serialize(async () => {
      const state = this.current();
      await this.repository.save(userId, { ...empty, userAgentMaxConcurrency: validated });
      const users = new Map(state.users);
      users.set(userId, validated);
      this.snapshot = { ...state, users };
      logger.info("User concurrency policy committed", { userId });
    });
  }

  /** 删除覆盖后，下次准入立即恢复全局／部署继承。 */
  async deleteUser(userId: string): Promise<void> {
    await this.serialize(async () => {
      const state = this.current();
      await this.repository.delete(userId);
      const users = new Map(state.users);
      users.delete(userId);
      this.snapshot = { ...state, users };
      logger.info("User concurrency policy committed", { userId });
    });
  }

  private current() {
    if (!this.snapshot)
      throw new AppError("Agent concurrency policy not initialized", "AGENT_CONCURRENCY_POLICY_UNAVAILABLE", 503);
    return this.snapshot;
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.writes.then(operation);
    // 队列尾仅恢复调度能力；原始失败由 result 交给调用方处理。
    this.writes = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
