import { getModuleConfig } from "@fenix/platform-sdk/server";
import * as z from "zod/v4";

/**
 * Sandbox 模块的部署配置。
 *
 * 值的来源是宿主 `apps/server` 已解析并校验过的 env（`apps/server/src/env.ts` 是变量真相来源），
 * 由宿主在装配阶段经 `initializeApplicationInfrastructure({ moduleConfigs: { sandbox } })` 注入。
 * 包内不做第二份环境解析（既不读运行环境变量，也不读 `.env` 文件）：两处默认值一旦分歧便无法在
 * 启动期暴露，也会把部署知识泄漏进资源模块。
 *
 * 这些字段暂由宿主直接提供，而不是走模块 `envDefinitions`（声明、校验与 preflight 收敛归任务 1.7）。
 */
export interface SandboxModuleConfig {
  /** 是否启用沙盒能力；关闭时默认 Pool 不初始化，控制台也不暴露可选资源池。 */
  readonly sandboxEnabled: boolean;
  /** 启动时创建/覆盖全局默认资源池的标识；启用沙盒时必填。 */
  readonly defaultSandboxPoolId?: string;
  /** 默认资源池镜像；启用沙盒时必填。 */
  readonly defaultSandboxImage?: string;
  /** 默认沙盒 Agent 类型，写入默认 Pool 并用于生成 Sandbox Machine 身份。 */
  readonly defaultSandboxAgentType?: string;
  /** 默认资源池的资源配置 JSON；启用沙盒时必填。 */
  readonly defaultSandboxResourcesJson?: string;
  /** 默认资源池的 Provider 扩展配置 JSON。 */
  readonly defaultSandboxExtraJson?: string;
  /** Cluster 管理 API 基址；缺省时 Cluster 管理面按「服务不可用」快速失败。 */
  readonly openSandboxClusterUrl?: string;
  /** 调用 Cluster 管理 API 的凭据，只在服务端使用，不得返回给浏览器。 */
  readonly openSandboxClusterApiKey?: string;
  /** 等待 Machine 以 ACP 回连的连接超时。 */
  readonly sandboxRuntimeConnectTimeoutMs: number;
  /** Cluster / Provider 单次请求超时。 */
  readonly sandboxProviderRequestTimeoutMs: number;
  /** Provider 创建沙盒资源超时。 */
  readonly sandboxProviderCreateTimeoutMs: number;
  /** Provider 恢复已停止资源超时。 */
  readonly sandboxProviderResumeTimeoutMs: number;
  /** Provider 销毁资源超时。 */
  readonly sandboxProviderDestroyTimeoutMs: number;
}

/**
 * 模块配置的形状校验。
 *
 * 为什么需要它：`getModuleConfig()` 对模块配置的类型是调用方断言（平台契约返回 `unknown`），宿主
 * `main.ts` 的字面量落在宽松的 `Readonly<Record<string, unknown>>` 上——两处都不校验字段齐全与类型，
 * 漏一个必填 timeout 会让被测/被部署的代码在更远处（如 `setTimeout`）才以异常行为暴露。
 *
 * `z.ZodType<SandboxModuleConfig>` 的标注让「接口加了字段而 schema 没加」在编译期报错；schema 多出的
 * 字段由 `strictObject` 在运行期拒绝（宿主字段改名、拼写错误会立刻失败，而不是静默忽略）。
 */
const SandboxModuleConfigSchema: z.ZodType<SandboxModuleConfig> = z.strictObject({
  sandboxEnabled: z.boolean(),
  defaultSandboxPoolId: z.string().min(1).optional(),
  defaultSandboxImage: z.string().min(1).optional(),
  defaultSandboxAgentType: z.string().min(1).optional(),
  defaultSandboxResourcesJson: z.string().min(1).optional(),
  defaultSandboxExtraJson: z.string().min(1).optional(),
  openSandboxClusterUrl: z.string().min(1).optional(),
  openSandboxClusterApiKey: z.string().min(1).optional(),
  sandboxRuntimeConnectTimeoutMs: z.number().int().positive(),
  sandboxProviderRequestTimeoutMs: z.number().int().positive(),
  sandboxProviderCreateTimeoutMs: z.number().int().positive(),
  sandboxProviderResumeTimeoutMs: z.number().int().positive(),
  sandboxProviderDestroyTimeoutMs: z.number().int().positive(),
});

/**
 * 读取 Sandbox 模块的已校验配置。
 *
 * 只能在请求、任务或启动逻辑中调用：模块加载期宿主可能尚未完成基础设施初始化，那时读取会抛错。
 */
export function getSandboxConfig(): SandboxModuleConfig {
  const raw = getModuleConfig("sandbox");
  const parsed = SandboxModuleConfigSchema.safeParse(raw);
  if (!parsed.success) {
    // 只报字段路径与错误码，不回显字段值：本配置含 Cluster 凭据，错误信息会被日志与错误响应带走。
    const issues = parsed.error.issues.map((issue) => `${issue.path.join(".") || "<root>"}:${issue.code}`);
    throw new Error(`sandbox 模块配置校验失败（${issues.join(", ")}）`);
  }
  return parsed.data;
}
