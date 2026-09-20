import { getModuleConfig } from "@fenix/platform-sdk/server";
import * as z from "zod/v4";

/**
 * Agent Runtime 模块的部署配置。
 *
 * 值的来源是宿主 `apps/server` 已解析并校验过的 env（`apps/server/src/env.ts` 是变量真相来源），由宿主在
 * 装配阶段经 `initializeApplicationInfrastructure({ moduleConfigs: { "agent-runtime": … } })` 注入。包内不做
 * 第二份环境解析：两处默认值一旦分歧便无法在启动期暴露，也会把部署知识泄漏进 runtime。
 *
 * 覆盖范围只含「运行态自身的旋钮」——并发上限、ACP 空闲 / 业务超时、WS 保活间隔。编排与启动参数类的配置
 * （默认机器、引擎类型、workspace 根、langfuse 等）仍由持有它们的调用方读宿主配置：那部分职责随 1.4 的 W4
 * 搬出本包，提前搬进这里只会形成第二处取数点。
 *
 * 这些字段暂由宿主直接提供，而不是走模块 `envDefinitions`（声明、校验与 preflight 收敛归任务 1.7）。
 */
export interface AgentRuntimeModuleConfig {
  /** 全部活跃 Agent 实例的并发上限；缺省表示不限制总量。 */
  readonly agentMaxConcurrency?: number;
  /** 单用户活跃 Agent 实例的并发上限；缺省表示不限制单用户。 */
  readonly userAgentMaxConcurrency?: number;
  /** 定时任务触发的活跃 Agent 实例并发上限；缺省表示不限制定时来源。 */
  readonly scheduledAgentMaxConcurrency?: number;
  /** 非交互式实例的空闲回收阈值（秒）。 */
  readonly acpIdleTimeoutSeconds: number;
  /** 非交互式实例的空闲巡检间隔（秒）。 */
  readonly acpIdleSweepIntervalSeconds: number;
  /** 非交互式实例业务静默的硬超时（秒）。 */
  readonly acpActivityTimeoutSeconds: number;
  /** `/acp/ws` 服务端 keep_alive 数据帧间隔（秒）。 */
  readonly wsKeepaliveInterval: number;
}

/**
 * 模块配置的形状校验。
 *
 * `z.ZodType<AgentRuntimeModuleConfig>` 的标注让「接口加了字段而 schema 没加」在编译期报错；schema 多出的
 * 字段由 `strictObject` 在运行期拒绝（宿主字段改名、拼写错误会立刻失败，而不是静默忽略）。
 *
 * 三个并发上限保持可选：消费方（`agent-concurrency.ts`）的语义是「未配置即不设上限」，写成必填会把
 * 「不限制」表达成必须给一个哨兵值。
 */
const AgentRuntimeModuleConfigSchema: z.ZodType<AgentRuntimeModuleConfig> = z.strictObject({
  agentMaxConcurrency: z.number().int().positive().optional(),
  userAgentMaxConcurrency: z.number().int().positive().optional(),
  scheduledAgentMaxConcurrency: z.number().int().positive().optional(),
  acpIdleTimeoutSeconds: z.number().int().positive(),
  acpIdleSweepIntervalSeconds: z.number().int().positive(),
  acpActivityTimeoutSeconds: z.number().int().positive(),
  wsKeepaliveInterval: z.number().int().positive(),
});

/**
 * 读取 Agent Runtime 模块的已校验配置。
 *
 * 只能在请求、任务或启动逻辑中调用：模块加载期宿主可能尚未完成基础设施初始化，那时读取会抛错（宿主
 * `main.ts` 的装配顺序保证请求路径晚于初始化）。这比模块级读取更安全——顶层常量若在初始化前求值，
 * `undefined * 1000` 会静默变成 NaN 定时器，而不是抛出一个指出装配顺序的错误。
 */
export function getAgentRuntimeConfig(): AgentRuntimeModuleConfig {
  const raw = getModuleConfig("agent-runtime");
  const parsed = AgentRuntimeModuleConfigSchema.safeParse(raw);
  if (!parsed.success) {
    // 只报字段路径与错误码，不回显字段值：错误信息会被日志与错误响应带走。
    const issues = parsed.error.issues.map((issue) => `${issue.path.join(".") || "<root>"}:${issue.code}`);
    throw new Error(`agent-runtime 模块配置校验失败（${issues.join(", ")}）`);
  }
  return parsed.data;
}
