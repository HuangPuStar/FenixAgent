import { getModuleConfig } from "@fenix/platform-sdk/server";
import * as z from "zod/v4";

/**
 * 插件市场模块的部署配置。
 *
 * 值的来源是模块 `envDefinitions` 声明的 `PLUGIN_MARKET_*` 键（`fenix.module.ts` 是这些键的真相来源），
 * 由宿主在装配阶段解析校验后经 `initializeApplicationInfrastructure({ moduleConfigs: { "plugin-market": … } })`
 * 注入。包内**不做第二份环境解析、不读 `process.env`**：两处默认值一旦分歧就无法在启动期暴露，
 * 也会把部署知识泄漏进资源模块。
 */
export interface PluginMarketModuleConfig {
  /** 来源标识，写入 `plugin_market_package.source_id`；缺省值由声明侧给 `npm`。 */
  readonly sourceId: string;
  /** npm 私有源 base URL；**未配置为 null**（见下）。 */
  readonly registryUrl: string | null;
  /** 私有源 Bearer 凭据；未配置为 null。凭据材料，不得进入日志、响应或错误详情。 */
  readonly registryToken: string | null;
  readonly registryTimeoutMs: number;
  readonly registryMaxBytes: number;
}

/**
 * 模块配置的形状校验。
 *
 * `z.ZodType<PluginMarketModuleConfig>` 标注让「接口加了字段而 schema 没加」在编译期报错；`strictObject`
 * 在运行期拒绝多出的字段（宿主字段改名或拼错会立刻失败，而不是静默读到一个不存在的配置）。
 *
 * `registryUrl` / `registryToken` 是 **`.nullable()` 而不是 `.optional()`，也不是必填**：宿主的投影层把
 * 「未配置」显式写成 `null`（`?? null`），使「未配置」在类型上可见、不需要读的人区分 `undefined` 与
 * 「宿主忘了投影这个字段」。URL 与凭据都不得是空串——空串会被下游当成「配置了一个空地址」，是真实故障，
 * 而不是「未配置」；声明的 `.min(1)` 与宿主的 `readDeclaredEnv(...) ?? null` 一起保证只会出现非空串或 null。
 */
const PluginMarketModuleConfigSchema: z.ZodType<PluginMarketModuleConfig> = z.strictObject({
  sourceId: z.string().min(1),
  registryUrl: z.string().min(1).nullable(),
  registryToken: z.string().min(1).nullable(),
  registryTimeoutMs: z.number().int().positive(),
  registryMaxBytes: z.number().int().positive(),
});

/**
 * 读取插件市场的已校验配置。
 *
 * 只能在请求、任务或启动逻辑中调用：模块加载期宿主可能尚未完成基础设施初始化，那时读取会抛错。
 */
export function getPluginMarketConfig(): PluginMarketModuleConfig {
  const raw = getModuleConfig("plugin-market");
  const parsed = PluginMarketModuleConfigSchema.safeParse(raw);
  if (!parsed.success) {
    // 只报字段路径与错误码，不回显字段值：错误信息会被日志与错误响应带走。
    const issues = parsed.error.issues.map((issue) => `${issue.path.join(".") || "<root>"}:${issue.code}`);
    throw new Error(`plugin-market 模块配置校验失败（${issues.join(", ")}）`);
  }
  return parsed.data;
}
