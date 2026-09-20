import { getModuleConfig } from "@fenix/platform-sdk/server";
import * as z from "zod/v4";

/**
 * 模型管理模块的部署配置。
 *
 * 值的来源是宿主 `apps/server` 已解析并校验过的 env（`apps/server/src/env.ts` 是变量真相来源），由宿主
 * 在装配阶段经 `initializeApplicationInfrastructure({ moduleConfigs: { "model-management": … } })` 注入。
 * 包内不做第二份环境解析（既不读 `process.env`，也不读 `.env`）：两处默认值一旦分歧便无法在启动期
 * 暴露，也会把部署知识泄漏进资源模块——迁移前 `runtime.ts` / `system-model-gateway.ts` 直接
 * `import { config } from "@server/config"` 正是这种耦合。
 *
 * **宿主注入尚未落盘**（实测 2026-09-20：`apps/server/src/main.ts:165` 的 `moduleConfigs` 只有
 * `identity` 与 `sandbox`，全仓 `grep '"model-management"' apps` 零命中）：这是包切片不能写 `apps/**`
 * 造成的临时缺口，宿主补上这一段之前 `main.ts:285` 的 `createModelGatewayRuntime` 会在启动期抛
 * 「模块配置校验失败」。补丁内容见 README「边界残留」。
 *
 * 字段清单来自迁移前的实测（当时 `grep -n "config\." src/**` 只命中模型网关运行时的 6 项与系统路由的
 * 2 项），宿主 config 的其余字段一概不进契约；迁移完成后包内已无 `config.` 读取点，这份清单即契约本身。
 */
export interface ModelManagementModuleConfig {
  /** 模型网关类型标识（如 `litellm`）；决定选用哪个适配器。 */
  readonly modelGatewayType: string;
  /** 模型网关服务端基址；包内调用网关 API 用。 */
  readonly modelGatewayBaseUrl: string;
  /** 暴露给沙盒 Agent 的网关地址；后端与 Agent 可能处于不同网络命名空间。 */
  readonly modelGatewayPublicBaseUrl: string;
  /** 网关管理密钥；未配置时网关运行时整体不启用。不得返回给浏览器。 */
  readonly modelGatewayAdminKey?: string;
  /**
   * 网关控制台地址；系统管理页用它生成跳转链接，适配器构造必填。
   *
   * 必填而不是可选：宿主 `RCS_MODEL_GATEWAY_ADMIN_UI_URL` 带默认值（`apps/server/src/env.ts`），
   * 传入的模块配置里该字段恒有值；包内再给一份兜底默认值等于把部署知识复制到资源模块。
   */
  readonly modelGatewayAdminUiUrl: string;
  /** 写库凭据的加密密钥；未配置时网关运行时整体不启用，不得返回给浏览器。 */
  readonly modelGatewayCredentialEncryptionKey?: string;
  /** 新用户默认预算（美元）；未配置时不创建默认预算。 */
  readonly modelGatewayDefaultUserBudgetUsd?: number;
  /** 默认预算周期（如 `monthly`）；宿主已把 `permanent` / `once` 归一成"未配置"。 */
  readonly modelGatewayDefaultBudgetDuration?: string;
}

/**
 * 模块配置的形状校验。
 *
 * 为什么需要它：`getModuleConfig()` 返回的类型是调用方断言（平台契约的返回是 `unknown`），宿主
 * `main.ts` 的字面量也落在宽松的记录类型上，两处都不校验字段齐全与类型。而 `runtime.ts` 用
 * 「admin key 与加密密钥都缺失就返回 null」表达"网关未启用"，漏配或拼错字段名必须在这里失败，而不是
 * 在更远处表现为"网关静默不可用"。
 *
 * `z.ZodType<ModelManagementModuleConfig>` 的标注让「接口加了字段而 schema 没加」在编译期报错；
 * `strictObject` 在运行期拒绝多出的字段（宿主机字段改名会立刻失败，而不是被静默忽略）。
 */
const ModelManagementModuleConfigSchema: z.ZodType<ModelManagementModuleConfig> = z.strictObject({
  modelGatewayType: z.string().min(1),
  modelGatewayBaseUrl: z.string().min(1),
  modelGatewayPublicBaseUrl: z.string().min(1),
  modelGatewayAdminKey: z.string().min(1).optional(),
  modelGatewayAdminUiUrl: z.string().min(1),
  modelGatewayCredentialEncryptionKey: z.string().min(1).optional(),
  modelGatewayDefaultUserBudgetUsd: z.number().nonnegative().optional(),
  modelGatewayDefaultBudgetDuration: z.string().min(1).optional(),
});

/**
 * 读取本模块的已校验配置。
 *
 * 只能在请求、任务或启动逻辑中调用：模块加载期宿主可能尚未完成基础设施初始化，那时读取会抛错。
 */
export function getModelManagementConfig(): ModelManagementModuleConfig {
  const raw = getModuleConfig("model-management");
  const parsed = ModelManagementModuleConfigSchema.safeParse(raw);
  if (!parsed.success) {
    // 只报字段路径与错误码，不回显字段值：本配置含网关管理密钥与凭据加密密钥，错误信息会被日志与错误响应带走。
    const issues = parsed.error.issues.map((issue) => `${issue.path.join(".") || "<root>"}:${issue.code}`);
    throw new Error(`model-management 模块配置校验失败（${issues.join(", ")}）`);
  }
  return parsed.data;
}
