import { getModuleConfig } from "@fenix/platform-sdk/server";
import * as z from "zod/v4";

/**
 * Knowledge 模块的部署配置。
 *
 * 值的来源是宿主 `apps/server` 已解析的 env（`apps/server/src/env.ts` 是变量真相来源），由宿主在装配
 * 阶段经 `initializeApplicationInfrastructure({ moduleConfigs: { knowledge } })` 注入。包内不做第二份
 * 环境解析（既不读 `process.env`，也不读 `.env`）：两处默认值一旦分歧便无法在启动期暴露。
 *
 * 字段集是本包实测的读取面（RAGFlow 基址 / 密钥 / 请求超时 + Office 转 PDF 的 Gotenberg 基址）。
 * 这些字段暂由宿主直接提供，而不是走模块 `envDefinitions`（声明、校验与 preflight 收敛归任务 1.7）。
 */
export interface KnowledgeModuleConfig {
  /** RAGFlow API 基址（不含尾部斜杠），如 `http://localhost:9380`。 */
  readonly ragflowApiUrl: string;
  /**
   * RAGFlow API key。
   *
   * 允许空串：空值表达「未配置 RAGFlow」这一真实部署状态，`resolveRagflowApiKey()` 与
   * `ensureConfigured()` 靠它快速失败，因此不能当成缺字段拒绝。
   */
  readonly ragflowApiKey: string;
  /** RAGFlow 单次请求超时（毫秒）。 */
  readonly ragflowRequestTimeoutMs: number;
  /** Gotenberg 服务基址，用于把 Office 文档转成 PDF；不可用时调用方回退 LibreOffice CLI。 */
  readonly gotenbergUrl: string;
}

/**
 * 模块配置的形状校验。
 *
 * 为什么需要它：`getModuleConfig()` 对模块配置的类型是调用方断言（平台契约返回 `unknown`），宿主
 * `main.ts` 的字面量落在宽松的 `Record<string, unknown>` 上——两处都不校验字段齐全与类型，漏一个必填项
 * 会让被测/被部署的代码在更远处（如 `fetch` 拼出 `undefined/api/v1`）才以异常行为暴露。
 *
 * `z.ZodType<KnowledgeModuleConfig>` 的标注让「接口加了字段而 schema 没加」在编译期报错；schema 多出的
 * 字段由 `strictObject` 在运行期拒绝（宿主字段改名、拼写错误会立刻失败，而不是静默忽略）。
 */
const KnowledgeModuleConfigSchema: z.ZodType<KnowledgeModuleConfig> = z.strictObject({
  ragflowApiUrl: z.string().min(1),
  ragflowApiKey: z.string(),
  ragflowRequestTimeoutMs: z.number().int().positive(),
  gotenbergUrl: z.string().min(1),
});

/**
 * 读取 Knowledge 模块的已校验配置。
 *
 * 只能在请求、任务或启动逻辑中调用：模块加载期宿主可能尚未完成基础设施初始化，那时读取会抛错。
 */
export function getKnowledgeConfig(): KnowledgeModuleConfig {
  const parsed = KnowledgeModuleConfigSchema.safeParse(getModuleConfig("knowledge"));
  if (!parsed.success) {
    // 只报字段路径与错误码，不回显字段值：本配置含 RAGFlow 密钥，错误信息会被日志与错误响应带走。
    const issues = parsed.error.issues.map((issue) => `${issue.path.join(".") || "<root>"}:${issue.code}`);
    throw new Error(`knowledge 模块配置校验失败（${issues.join(", ")}）`);
  }
  return parsed.data;
}
