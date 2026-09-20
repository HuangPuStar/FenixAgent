import { getModuleConfig } from "@fenix/platform-sdk/server";
import * as z from "zod/v4";

/**
 * AgentConfig 模块的部署配置。
 *
 * 值的来源是宿主 `apps/server` 已解析并校验过的 env（`apps/server/src/env.ts` 是变量真相来源），由
 * 宿主在装配阶段经 `initializeApplicationInfrastructure({ moduleConfigs: { "agent-config": ... } })`
 * 注入。包内不做第二份环境解析：本包此前直接读运行环境变量的写法已在本切片切断（1.3 静态条件 4），
 * 否则「宿主认为已配置、包认为未配置」这类分歧只在运行期以界面差异或 502 的形式暴露。
 *
 * 这些字段暂由宿主直接提供，而不是走模块 `envDefinitions`（声明、校验与 preflight 收敛归任务 1.7）。
 */
export interface AgentConfigModuleConfig {
  /**
   * 控制台侧边栏需要隐藏的 tab id 原始列表（逗号分隔，允许空串）。
   *
   * 保留原始字符串而不是让宿主解析成数组：切分、trim、去重的规则（{@link parseHiddenSidebarTabs}）
   * 属于本包的展示配置语义，包内已有对应用例；宿主只负责把已校验的 env 值原样传进来。
   */
  readonly hiddenSidebarTabs: string;
  /** Agent Sites 平台基址（宿主 `AGENT_SITES_BASE_URL`）；未配置时站点链路按「未配置」快速失败。 */
  readonly agentSitesBaseUrl?: string;
  /** Agent Sites master key（宿主 `AGENT_SITES_MASTER_KEY`）；只在服务端使用，不得返回浏览器。 */
  readonly agentSitesMasterKey?: string;
  /**
   * 智能生成使用的模型名（宿主 `OPENAI_MODEL`）。
   *
   * 只在 API Key 可用时下发：Key 由 OpenAI SDK 自行从运行环境读取（SDK 的既有行为，包侧不复制这条
   * 解析），因此「是否已配置」在包侧就等价于「模型名是否存在」——一个字段表达两种状态，不会出现
   * 「已启用但没有模型名」的中间态。
   */
  readonly agentGenerationModel?: string;
}

/**
 * 模块配置的形状校验。
 *
 * 为什么需要它：`getModuleConfig()` 对模块配置的类型是调用方断言（平台契约返回 `unknown`），宿主
 * `main.ts` 的字面量落在宽松的 `Readonly<Record<string, unknown>>` 上——两处都不校验字段类型，把
 * 非字符串（如误传数组）塞进来时只会在 `split` 更远处才以异常行为暴露。
 *
 * `z.ZodType<AgentConfigModuleConfig>` 的标注让「接口加了字段而 schema 没加」在编译期报错；schema 多出
 * 的字段由 `strictObject` 在运行期拒绝（宿主字段改名、拼写错误会立刻失败，而不是静默忽略）。
 */
const AgentConfigModuleConfigSchema: z.ZodType<AgentConfigModuleConfig> = z.strictObject({
  hiddenSidebarTabs: z.string(),
  agentSitesBaseUrl: z.string().min(1).optional(),
  agentSitesMasterKey: z.string().min(1).optional(),
  agentGenerationModel: z.string().min(1).optional(),
});

/**
 * 读取 AgentConfig 模块的已校验配置。
 *
 * 只能在请求、任务或启动逻辑中调用：模块加载期宿主可能尚未完成基础设施初始化，那时读取会抛错
 * （`@fenix/platform-sdk/server` 的既定语义，不在本包兜底）。
 */
export function getAgentConfigConfig(): AgentConfigModuleConfig {
  const raw = getModuleConfig("agent-config");
  const parsed = AgentConfigModuleConfigSchema.safeParse(raw);
  if (!parsed.success) {
    // 只报字段路径与错误码，不回显字段值：错误信息会被日志与错误响应带走。
    const issues = parsed.error.issues.map((issue) => `${issue.path.join(".") || "<root>"}:${issue.code}`);
    throw new Error(`agent-config 模块配置校验失败（${issues.join(", ")}）`);
  }
  return parsed.data;
}
