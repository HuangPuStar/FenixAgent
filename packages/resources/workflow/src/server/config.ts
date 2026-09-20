import { getModuleConfig } from "@fenix/platform-sdk/server";
import * as z from "zod/v4";

/**
 * Workflow 模块的部署配置。
 *
 * 值的来源是宿主 `apps/server` 已解析并校验过的 env（`apps/server/src/env.ts` 是变量真相来源），
 * 由宿主在装配阶段经 `initializeApplicationInfrastructure({ moduleConfigs: { workflow } })` 注入。
 * 包内不做第二份环境解析（既不读 `process.env`，也不读 `.env` 文件）：两处默认值一旦分歧便无法在
 * 启动期暴露，也会把部署知识泄漏进资源模块。
 *
 * 这些字段暂由宿主直接提供，而不是走模块 `envDefinitions`（声明、校验与 preflight 收敛归任务 1.7）。
 * 迁移前的三处直读（`@server/config` 的 `acpxGUrl` / `getBaseUrl`、`process.env` 的
 * `WORKFLOW_TOOLS_DIR` 与 `RCS_WORKFLOW_HMAC_SECRET`）全部收敛到这里。
 */
export interface WorkflowModuleConfig {
  /** 服务对外基址（已去掉尾部斜杠），用于拼装 webhook 回调 URL 展示给用户。 */
  readonly baseUrl: string;
  /** `acpx-g` 内部服务基址，`/workflow-ui` 静态代理的转发目标。 */
  readonly acpxGUrl: string;
  /** 自定义节点工具目录；缺省时按 `<cwd>/tools` 解析，与宿主 env 的 `WORKFLOW_TOOLS_DIR` 默认值一致。 */
  readonly toolsDir?: string;
  /**
   * 工作流引擎的 HMAC 签名密钥；缺省时每个进程生成一个随机值。
   *
   * 多实例部署必须显式配置同一密钥：随机值只在单实例内自洽，跨实例恢复的 run 会签名校验失败。
   */
  readonly hmacSecret?: string;
}

/**
 * 模块配置的形状校验。
 *
 * 为什么需要它：`getModuleConfig()` 返回的是调用方断言（平台契约返回 `unknown`），宿主 `main.ts`
 * 的字面量落在宽松的 `Readonly<Record<string, unknown>>` 上——两处都不校验字段齐全与类型，漏一个
 * 必填字段会让代码在更远处（如 `fetch(undefined)`、`new URL(undefined)`）才以异常行为暴露。
 *
 * `z.ZodType<WorkflowModuleConfig>` 的标注让「接口加了字段而 schema 没加」在编译期报错；schema 多出的
 * 字段由 `strictObject` 在运行期拒绝（宿主字段改名、拼写错误会立刻失败，而不是静默忽略）。
 */
const WorkflowModuleConfigSchema: z.ZodType<WorkflowModuleConfig> = z.strictObject({
  baseUrl: z.string().min(1),
  acpxGUrl: z.string().min(1),
  toolsDir: z.string().min(1).optional(),
  hmacSecret: z.string().min(1).optional(),
});

/**
 * 读取 Workflow 模块的已校验配置。
 *
 * 只能在请求、任务或启动逻辑中调用：模块加载期宿主可能尚未完成基础设施初始化，那时读取会抛错。
 * `hmacSecret` 属于敏感值，校验失败信息只报字段路径与错误码，不回显字段值。
 */
export function getWorkflowConfig(): WorkflowModuleConfig {
  const raw = getModuleConfig("workflow");
  const parsed = WorkflowModuleConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join(".") || "<root>"}:${issue.code}`);
    throw new Error(`workflow 模块配置校验失败（${issues.join(", ")}）`);
  }
  return parsed.data;
}
