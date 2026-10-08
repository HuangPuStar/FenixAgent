import { getModuleConfig } from "@fenix/platform-sdk/server";
import * as z from "zod/v4";

/**
 * Workflow V2 模块的部署配置。
 *
 * 值的来源是宿主 `apps/server` 已解析并校验过的 env（九枚键的声明在 `fenix.module.ts` 的
 * `envDefinitions`，冻结 §2.2），由宿主在装配阶段经 `initializeApplicationInfrastructure({ moduleConfigs:
 * { "workflow-v2": ... } })` 投影进来（`bootstrap/module-configs.ts`，路线 A，与 workflow 模块同形）。
 * 包内不做第二份环境解析：既不读 `process.env`，也不读 `.env`；`WORKFLOW_V2_NODE_WHITELIST` 的
 * 逗号分隔**字符串**是部署面的表达（env 只能是字符串），拆成运行时消费的类型名数组是模块内的形状归一，
 * 归这里而不是宿主——节点类型名是本模块的领域知识，宿主不该理解它。
 *
 * 与 `envDefinitions` 的分工：那边承担启动期校验与部署模板（`.env.example` / `docker/main/.env.example`）的生成，
 * 本文件是运行期读取面。**两处都不写默认值**——默认值只在声明侧（`envDefinitions` 的 schema 与 `defaultValue`），
 * 宿主投影过来的对象因此是完整的；本文件的 schema 缺字段即报错，把「宿主投影漏字段」暴露在读配置的
 * 那一刻，而不是让它静默落成 undefined 传到更远处。
 */

/** Workflow V2 的运行期配置；字段与冻结 §4 的 `WorkflowV2Config` 逐字一致。 */
export interface WorkflowV2Config {
  /** 上游工作流引擎上游基址（`https://host:port`，不含路径），API 与 passport 登录的目标。 */
  upstreamBaseUrl: string;
  /** `/workflow-canvas/*` 静态反代的上游基址；与 `upstreamBaseUrl` 分开配置以支持入口分离。 */
  canvasUpstreamUrl: string;
  /** 平台上游账号的登录邮箱；不是密钥材料，但仍不得进面向用户的响应。 */
  accountEmail: string;
  /** 平台上游账号的登录密码；密钥材料，禁止进日志、响应与错误文案。 */
  accountPassword: string;
  /** 画布票据的 HMAC 签名密钥；密钥材料，多副本部署必须同一值。 */
  ticketSecret: string;
  /** 一次性 code 的有效期（秒），默认 60。 */
  codeTtlSeconds: number;
  /** 画布票据的有效期（秒），默认 900。 */
  ticketTtlSeconds: number;
  /** 单次上游调用的超时（毫秒），默认 10000。 */
  upstreamTimeoutMs: number;
  /** 节点面板白名单（节点类型名数组），由 `WORKFLOW_V2_NODE_WHITELIST` 的逗号分隔串解析而来。 */
  nodeWhitelist: string[];
  /**
   * 对账任务（4A）的运行周期（秒），默认 300；`0` 表示禁用。
   *
   * 由部署方按实例规模调整：单机开发可以调大或置 0，多副本时每个副本都会各跑一轮（对账动作本身幂等，
   * 重复执行只是多余的上游调用，见 `services/reconciliation.ts` 的「多副本」注释）。
   */
  reconcileIntervalSeconds: number;
  /** 画布透传面（`/workflow-canvas/bff/*`）的每用户每分钟令牌数；默认 1200（≈20 rps）。 */
  bffRateLimitPerMinute: number;
  /** 票据端点（`session/*`）的每用户 / 每来源每分钟令牌数；默认 60。 */
  sessionRateLimitPerMinute: number;
}

/**
 * 模块配置的**写入形状**：宿主 `module-configs.ts` 的投影与包内测试 fixture 用的就是它。
 *
 * 与 `WorkflowV2Config` 只差 `nodeWhitelist`：声明侧与部署面都是逗号分隔字符串（env 只能是字符串），
 * 拆成数组发生在读取时（`getWorkflowV2Config()` 的 schema transform），因此「写进去的形状」与
 * 「读出来的形状」必须分列，否则宿主会以为自己该传数组。
 */
export type WorkflowV2ModuleConfigInput = Omit<WorkflowV2Config, "nodeWhitelist"> & { nodeWhitelist: string };

/** 逗号分隔的白名单串 → 类型名数组；逐项去空白并丢弃空项（尾逗号、`a, ,b` 都不产生空字符串项）。 */ function parseNodeWhitelist(
  raw: string,
): string[] {
  return raw
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
}

/**
 * 模块配置的形状校验。
 *
 * 为什么需要它：`getModuleConfig()` 返回的是调用方断言（平台契约返回 `unknown`），宿主
 * `module-configs.ts` 的字面量落在宽松的 `Readonly<Record<string, unknown>>` 上——两处都不校验字段齐全
 * 与类型，漏一个必填字段会让代码在更远处（`fetch(undefined)`、`as string` 之后的字符串拼接）才暴露。
 *
 * `z.ZodType<WorkflowV2Config>` 的标注让「接口加了字段而 schema 没加」在编译期报错；schema 多出的字段由
 * `strictObject` 在运行期拒绝（宿主字段改名、拼写错误会立刻失败，而不是静默忽略）。
 */
const WorkflowV2ConfigSchema: z.ZodType<WorkflowV2Config> = z.strictObject({
  upstreamBaseUrl: z.string().min(1),
  canvasUpstreamUrl: z.string().min(1),
  accountEmail: z.string().min(1),
  accountPassword: z.string().min(1),
  ticketSecret: z.string().min(1),
  codeTtlSeconds: z.number().int().positive(),
  ticketTtlSeconds: z.number().int().positive(),
  upstreamTimeoutMs: z.number().int().positive(),
  nodeWhitelist: z.string().transform(parseNodeWhitelist),
  // 0 是合法值（对账禁用），故用 `nonnegative` 而不是 `positive`。
  reconcileIntervalSeconds: z.number().int().nonnegative(),
  bffRateLimitPerMinute: z.number().int().positive(),
  sessionRateLimitPerMinute: z.number().int().positive(),
});

/**
 * 读取 Workflow V2 模块的已校验配置。
 *
 * 只能在请求、任务或启动逻辑中调用：模块加载期宿主可能尚未完成基础设施初始化，那时读取会抛错。
 * `accountPassword` / `ticketSecret` 属敏感值，校验失败信息只报字段路径与错误码，**不回显字段值**。
 */
export function getWorkflowV2Config(): WorkflowV2Config {
  const raw = getModuleConfig("workflow-v2");
  const parsed = WorkflowV2ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join(".") || "<root>"}:${issue.code}`);
    throw new Error(`workflow-v2 模块配置校验失败（${issues.join(", ")}）`);
  }
  return parsed.data;
}
