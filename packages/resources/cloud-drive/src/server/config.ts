import { getModuleConfig } from "@fenix/platform-sdk/server";
import * as z from "zod/v4";

/**
 * CloudDrive 模块的部署配置。
 *
 * 值由宿主 `apps/server/src/env.ts` 解析后经 `bootstrap/module-configs.ts` 投影进来（路线 A：模块
 * `envDefinitions` 只承担启动期校验与汇总）。包内不读 `process.env`，也不带默认值——两处默认值一旦
 * 分歧就无法在启动期暴露。
 *
 * `baseUrl` / `masterKey` 允许未配置：CloudDrive 是可选外部依赖，未配置时服务照常启动，相关路由返回
 * 503。空串与 `undefined` 都由声明侧的 preprocess 归一为 `undefined`。
 */
export interface CloudDriveModuleConfig {
  /** CloudDrive REST 基址（不含尾部斜杠的语义由 client 归一），如 `http://127.0.0.1:8080`。 */
  readonly baseUrl?: string;
  /** CloudDrive master key；密钥材料，不得进入日志、响应或错误文案。 */
  readonly masterKey?: string;
  /** 可选 key id，随请求发送 `X-Key-Id`。 */
  readonly keyId?: string;
  /** 出站请求超时（毫秒）。 */
  readonly timeoutMs: number;
}

/**
 * 模块配置的形状校验。
 *
 * 宿主投影的字面量落在 `Record<string, unknown>` 上，这两处都不校验字段齐全与类型；漏一个必填项会让
 * 失败出现在更远处（如 `fetch` 拼出 `undefined/v1/me`）。`z.ZodType<CloudDriveModuleConfig>` 的标注
 * 让「接口加了字段而 schema 没加」在编译期报错，`strictObject` 让宿主拼错字段名立刻失败。
 */
const CloudDriveModuleConfigSchema: z.ZodType<CloudDriveModuleConfig> = z.strictObject({
  baseUrl: z.string().optional(),
  masterKey: z.string().optional(),
  keyId: z.string().optional(),
  timeoutMs: z.number().int().positive(),
});

/**
 * 读取 CloudDrive 模块的已校验配置。
 *
 * 只能在请求或启动逻辑中调用：模块加载期宿主可能尚未完成基础设施初始化。错误信息只含字段路径与
 * 错误码，不回显字段值（`masterKey` 会被日志与错误响应带走）。
 */
export function getCloudDriveConfig(): CloudDriveModuleConfig {
  const parsed = CloudDriveModuleConfigSchema.safeParse(getModuleConfig("cloud-drive"));
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join(".") || "<root>"}:${issue.code}`);
    throw new Error(`cloud-drive 模块配置校验失败（${issues.join(", ")}）`);
  }
  return parsed.data;
}
