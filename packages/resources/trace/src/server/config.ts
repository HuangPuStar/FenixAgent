import { getModuleConfig } from "@fenix/platform-sdk/server";
import * as z from "zod/v4";

/**
 * Trace 观测模块的部署配置。
 *
 * 三个字段就是 Agent 侧上报观测所用的同一组 Langfuse 兼容后端连接参数（`LANGFUSE_BASE_URL` /
 * `LANGFUSE_PUBLIC_KEY` / `LANGFUSE_SECRET_KEY`）。**声明 owner 仍是 `@fenix/agent-config`**（该包
 * manifest 的 `envDefinitions` 逐键写明了归属判据），本包只是同一份部署值在读取侧的第二个消费者，
 * 因此不重复声明环境键——同名两处声明会被宿主 env-loader 的 `assertNoHostKeyOverride` 在启动期拒绝。
 * 值由宿主 `apps/server/src/bootstrap/module-configs.ts` 从 `config.langfuse*` 投影进来。
 *
 * 三者缺一即「观测读取未启用」：本包不提供任何默认值（默认值等于把部署知识复制进资源模块，且会掩盖
 * 主服务指向与 Agent 上报端不一致的错配）。未启用时路由返回 `configured: false`，前端据此展示引导态，
 * 而不是把「没配」表现成「这个会话没有 run」。
 *
 * `langfuseSecretKey` 只用于服务端 Basic 认证，绝不出现在任何响应、日志或错误文案里（见
 * `services/langfuse-client.ts` 的错误归一）。
 */
export interface TraceModuleConfig {
  /** 自托管 Langfuse（含 Peri-Fuse 等兼容实现）的基址；未配置表示读取链路未启用。 */
  readonly langfuseBaseUrl?: string;
  /** Langfuse public key；与 secret key 组成 Basic 凭据。 */
  readonly langfusePublicKey?: string;
  /** Langfuse secret key（密钥：只随服务端请求头发送，不得进入日志、响应或错误文案）。 */
  readonly langfuseSecretKey?: string;
}

/**
 * 模块配置形状校验。
 *
 * `getModuleConfig()` 返回 `unknown`，宿主投影也只是宽松记录类型，两处都不校验字段名与类型；漏配或拼错
 * 字段名必须在读取时立刻失败，而不是在更远处表现成「观测面板空着」。`ZodType<TraceModuleConfig>` 的标注
 * 让「接口加了字段而 schema 没加」在编译期报错，`strictObject` 在运行期拒绝宿主多投影的字段（改名会当场
 * 暴露，而不是被静默忽略）。
 */
const TraceModuleConfigSchema: z.ZodType<TraceModuleConfig> = z.strictObject({
  langfuseBaseUrl: z.string().min(1).optional(),
  langfusePublicKey: z.string().min(1).optional(),
  langfuseSecretKey: z.string().min(1).optional(),
});

/**
 * 读取本模块的已校验配置。
 *
 * 只能在请求处理中调用：模块加载期宿主可能尚未完成基础设施初始化，那时读取会抛错。
 */
export function getTraceConfig(): TraceModuleConfig {
  return TraceModuleConfigSchema.parse(getModuleConfig("trace"));
}

/** Langfuse 连接参数（三者齐备才可发起读取）。 */
export interface LangfuseConnection {
  readonly baseUrl: string;
  readonly publicKey: string;
  readonly secretKey: string;
}

/**
 * 把模块配置收敛成「可用的连接参数或 null」。
 *
 * 三键必须同时存在：缺任一键都只说明部署未配置观测读取，调用方据此走引导态而不是试探性请求
 * （半配置下的请求只会得到一个 401，把配置问题伪装成凭据问题）。
 */
export function resolveLangfuseConnection(config: TraceModuleConfig = getTraceConfig()): LangfuseConnection | null {
  const { langfuseBaseUrl, langfusePublicKey, langfuseSecretKey } = config;
  if (!langfuseBaseUrl || !langfusePublicKey || !langfuseSecretKey) return null;
  return { baseUrl: langfuseBaseUrl, publicKey: langfusePublicKey, secretKey: langfuseSecretKey };
}
