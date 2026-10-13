import { getModuleConfig } from "@fenix/platform-sdk/server";
import * as z from "zod/v4";

/**
 * Machine 模块的部署配置。
 *
 * 值的来源是宿主 `apps/server` 已解析并校验过的 env（`apps/server/src/env.ts` 是变量真相来源），由宿主在
 * 装配阶段经 `initializeApplicationInfrastructure({ moduleConfigs: { machine } })` 注入。包内不做第二份
 * 环境解析：两处默认值一旦分歧便无法在启动期暴露，也会把部署知识泄漏进资源模块。
 *
 * 不含沙盒侧字段（`sandboxEnabled` / 默认池）：远程文件路由要判断环境是否落在沙盒里，但该判定读的是
 * Sandbox 模块自己的配置与池、实例表，已随 1.4 迁回那个包并经 `MachineSandboxRoutePort` 注入结果。
 * 本接口因此不再需要沙盒字段，也不会出现两个模块配置各持一份同名字段而漂移。
 *
 * 这些字段暂由宿主直接提供，而不是走模块 `envDefinitions`（声明、校验与 preflight 收敛归任务 1.7）。
 */
export interface MachineModuleConfig {
  /** 未绑定 agentConfig / 沙盒时兜底的机器 ID（宿主 `RCS_DEFAULT_MACHINE_ID`）；缺省表示无兜底机器。 */
  readonly defaultMachineId?: string;
  /** file-ws 身份绑定严格模式（§7.1）：未知 machine 的 register 帧是否按 close(4404) 拒绝。 */
  readonly fileWsIdentityStrict: boolean;
  /** `/web/file-events` 文件变更事件订阅的并发连接上限（与 YJS 分池）。 */
  readonly fileEventsMaxClients: number;
}

/**
 * 模块配置的形状校验。
 *
 * `z.ZodType<MachineModuleConfig>` 的标注让「接口加了字段而 schema 没加」在编译期报错；schema 多出的字段
 * 由 `strictObject` 在运行期拒绝（宿主字段改名、拼写错误会立刻失败，而不是静默忽略）。
 */
const MachineModuleConfigSchema: z.ZodType<MachineModuleConfig> = z.strictObject({
  defaultMachineId: z.string().min(1).optional(),
  fileWsIdentityStrict: z.boolean(),
  fileEventsMaxClients: z.number().int().positive(),
});

/**
 * 读取 Machine 模块的已校验配置。
 *
 * 只能在请求、任务或启动逻辑中调用：模块加载期宿主可能尚未完成基础设施初始化，那时读取会抛错。
 */
export function getMachineConfig(): MachineModuleConfig {
  const raw = getModuleConfig("machine");
  const parsed = MachineModuleConfigSchema.safeParse(raw);
  if (!parsed.success) {
    // 只报字段路径与错误码，不回显字段值：错误信息会被日志与错误响应带走。
    const issues = parsed.error.issues.map((issue) => `${issue.path.join(".") || "<root>"}:${issue.code}`);
    throw new Error(`machine 模块配置校验失败（${issues.join(", ")}）`);
  }
  return parsed.data;
}
