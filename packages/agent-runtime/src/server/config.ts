import { getModuleConfig } from "@fenix/platform-sdk/server";
import * as z from "zod/v4";

/**
 * Agent Runtime 模块的部署配置。
 *
 * 值的来源是宿主 `apps/server` 已解析并校验过的 env（`apps/server/src/env.ts` 是变量真相来源），由宿主在
 * 装配阶段经 `initializeApplicationInfrastructure({ moduleConfigs: { "agent-runtime": … } })` 注入。包内不做
 * 第二份环境解析：两处默认值一旦分歧便无法在启动期暴露，也会把部署知识泄漏进 runtime。
 *
 * 覆盖范围含三类：
 *
 * 1. **运行态旋钮**（W1 落地）——并发上限、ACP 空闲 / 业务超时、WS 保活间隔。
 * 2. **环境解析与协议入口的部署值**（W2 落地）——本地节点开关、workspace 根、`acp` 注册密钥、file-ws 帧
 *    上限。这些值不参与「启动参数组装」，但本包的环境归属解析（`environment-orchestration` 的 fallback
 *    链）、workspace 路径规则与 `/acp/*` 协议入口必须读它们，读宿主 `@server/config` / `@server/env`
 *    会把部署知识反向泄漏进本包，因此经模块配置注入。
 * 3. **启动组装的两个残留输入**（1.5b 落地）——`defaultEngineType`（本地执行的引擎类型）与 `baseUrl`
 *    （`platformEnv` 的 `USER_META_BASE_URL`）。1.4 W4 把模型密钥 / Skill / MCP / 知识库的组装搬到
 *    agent-config（经 `AgentLaunchSpecPort`），但 `orchestration-instance.ts` 的
 *    `buildAgentLaunchSpecForCore` 仍负责 platformEnv 组装与端口调用，这两个值因此留在本包配置里。
 *    它们原由 `@server/config` 直读，1.5b 改为与其余键同一路径注入——本包至此不再导入宿主 config。
 *
 * 兜底机器 ID 与 machine 模块的 `MachineModuleConfig.defaultMachineId` 同源（都来自宿主 `RCS_DEFAULT_MACHINE_ID`）。
 * 未沿用 observer 的「读 `getMachineConfig()` 不复制」口径，是因为：observer 读它是为了复述 machine 的身份，
 * 而这里读它的 `environment-orchestration` fallback 链是 agent-runtime 自己的节点选择策略（`agent_config.machineId`
 * → 兜底机器 → `local-default`），值必须与 `disableLocalExecution` 在同一处决策；且 agent-runtime 目前不依赖
 * `@fenix/resource-machine`，为一个字符串引入新的跨包边不在本任务授权内。宿主是唯一取数点，两款模块配置各持
 * 一份自己的切片，不构成两处 env 解析。
 *
 * 「`workspace-resolver` 直读 `process.env.WORKSPACE_ROOT`」这条 W2 已知分歧已在 1.7 C1 收口：
 * `server/services/workspace-resolver.ts` 改读本配置的 `workspaceRoot`。收口方式不是「让 machine 的测试也
 * 初始化本模块配置」，而是**拆开两种语义**——机器侧的 host port 要求每次调用直读 `WORKSPACE_ROOT`
 * （`@fenix/platform-sdk/testing` 的 workspace 根锁按用例切根，读配置快照会让锁静默失效），该实现因此归宿主
 * `apps/server/src/bootstrap/workspace-path.ts`，本包不再向 Machine 导出 `resolveWorkspacePath`。
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
  /** agent config 未绑定 `machineId` 时的兜底机器 ID；缺省表示退回本地默认节点。 */
  readonly defaultMachineId?: string;
  /** 是否禁用本地 `local-default` 节点；启用后实例必须路由到远程 machine。 */
  readonly disableLocalExecution: boolean;
  /** workspace 根目录；宿主已解析为绝对路径（`WORKSPACE_ROOT`，默认运行目录下的 `workspaces`）。 */
  readonly workspaceRoot: string;
  /** `/acp/*` 接入方必须携带的共享密钥（query `secret`）。 */
  readonly acpRegistrySecret: string;
  /** file-ws 单帧最大载荷（MB）。 */
  readonly fileWsMaxPayloadMb: number;
  /** `/yjs/*` 的连接上限（`YJS_MAX_CLIENTS`）；超限关闭新连接并回 `too_many_connections`。 */
  readonly yjsMaxClients: number;
  /** 本地执行的默认引擎类型（`RCS_DEFAULT_ENGINE_TYPE`）；缺省时调用方回退 `"peri"`。 */
  readonly defaultEngineType?: string;
  /** 平台对外基址（宿主 `getBaseUrl()` 的已解析结果），注入 launch spec 的 `USER_META_BASE_URL`。 */
  readonly baseUrl: string;
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
  defaultMachineId: z.string().min(1).optional(),
  disableLocalExecution: z.boolean(),
  workspaceRoot: z.string().min(1),
  acpRegistrySecret: z.string().min(1),
  fileWsMaxPayloadMb: z.number().int().positive(),
  yjsMaxClients: z.number().int().positive(),
  defaultEngineType: z.string().min(1).optional(),
  baseUrl: z.string().min(1),
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
