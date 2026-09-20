import { getModuleConfig } from "@fenix/platform-sdk/server";
import * as z from "zod/v4";

/**
 * Memory 模块的部署配置。
 *
 * 值的来源是宿主 `apps/server` 已解析并校验过的 env（`apps/server/src/env.ts` 的 `HINDSIGHT_MCP_URL`
 * 是变量真相来源），由宿主在装配阶段经 `initializeApplicationInfrastructure({ moduleConfigs: { memory } })`
 * 注入。包内不做第二份环境解析：本包既读 `process.env` 也读 `.env` 的旧写法已在本切片切断（静态条件 4），
 * 否则「包认为已配置、宿主认为未配置」这类分歧只在运行期以 503 的形式暴露。
 *
 * 这些字段暂由宿主直接提供，而不是走模块 `envDefinitions`（声明、校验与 preflight 收敛归任务 1.7）。
 */
export interface MemoryModuleConfig {
  /**
   * Hindsight MCP 服务地址；未配置表示记忆能力整体不可用。
   *
   * 「未配置」有两种外部形状：字段缺失（宿主未设置 `HINDSIGHT_MCP_URL`）与空串（docker 默认部署的
   * `HINDSIGHT_MCP_URL: ${HINDSIGHT_MCP_URL:-}` 在 .env 未设置时透传空串而非 undefined）。两者都在
   * `MemoryModuleConfigSchema` 里归一为 undefined——否则「未部署记忆」会从「静默禁用」变成校验抛错，
   * 而这条路径恰好是最常见的部署形态。
   *
   * 该值同时是三处行为的开关：`/web/hindsight/**` 代理的上游基址、Agent 记忆开关的系统级判据
   * （`isHindsightAvailable()`）、以及 Hindsight bank 的登记入口。
   */
  readonly hindsightMcpUrl?: string;
}

/**
 * 模块配置的形状校验。
 *
 * 为什么需要它：`getModuleConfig()` 对模块配置的类型是调用方断言（平台契约返回 `unknown`），宿主
 * `main.ts` 的字面量落在宽松的 `Readonly<Record<string, unknown>>` 上——两处都不校验字段类型，
 * 把非字符串（如误传 `new URL(...)`）塞进来时只会在 `fetch()` 更远处才以异常行为暴露。
 *
 * `z.ZodType<MemoryModuleConfig>` 的标注让「接口加了字段而 schema 没加」在编译期报错；schema 多出的
 * 字段由 `strictObject` 在运行期拒绝（宿主字段改名、拼写错误会立刻失败，而不是静默忽略）。
 */
const MemoryModuleConfigSchema: z.ZodType<MemoryModuleConfig> = z.strictObject({
  // 空串归一为 undefined（同宿主 `apps/server/src/env.ts` 的 RCS_DEFAULT_MACHINE_ID 先例）：
  // docker-compose 的 `${HINDSIGHT_MCP_URL:-}` 透传的是空串，不归一就会被 min(1) 判为非法值。
  hindsightMcpUrl: z.preprocess((value) => (value === "" ? undefined : value), z.string().min(1).optional()),
});

/**
 * 读取 Memory 模块的已校验配置。
 *
 * 只能在请求、任务或启动逻辑中调用：模块加载期宿主可能尚未完成基础设施初始化，那时读取会抛错
 * （`@fenix/platform-sdk/server` 的既定语义，不在本包兜底）。部署未配置时宿主传入空对象，
 * 此时 `hindsightMcpUrl` 为 undefined，记忆能力按「未启用」处理；宿主透传空串（docker-compose 的
 * `${VAR:-}` 形态）同样归一到「未启用」，不抛错。
 */
export function getMemoryConfig(): MemoryModuleConfig {
  const raw = getModuleConfig("memory");
  const parsed = MemoryModuleConfigSchema.safeParse(raw);
  if (!parsed.success) {
    // 只报字段路径与错误码，不回显字段值：错误信息会被日志与错误响应带走。
    const issues = parsed.error.issues.map((issue) => `${issue.path.join(".") || "<root>"}:${issue.code}`);
    throw new Error(`memory 模块配置校验失败（${issues.join(", ")}）`);
  }
  return parsed.data;
}
