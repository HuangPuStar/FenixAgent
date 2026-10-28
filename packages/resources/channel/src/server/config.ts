import { getModuleConfig } from "@fenix/platform-sdk/server";
import * as z from "zod/v4";

/**
 * Channel 模块的部署配置。
 *
 * 值由宿主在装配期从 manifest 的 `envDefinitions` 投影进来（`apps/server/src/bootstrap/module-configs.ts`）。
 * 包内不读 `process.env`：否则会出现「宿主认为未配置、包认为已配置」的分歧。
 *
 * LangBot 三项都允许缺省：未配置 `LANGBOT_BASE_URL` 的部署不启用数据面，控制面返回明确错误但不阻断启动；
 * 一旦配置基址，数据面密钥的完整性由装配期校验（{@link assertLangBotDataPlaneConfigured}）兜住。空串按
 * 未配置处理（docker-compose 的 `${VAR:-}` 会透传空串）。
 */
export interface ChannelModuleConfig {
  /** LangBot Service API 基址；未配置时控制面明确返回 LANGBOT_NOT_CONFIGURED。 */
  readonly langbotBaseUrl?: string;
  /** LangBot Service API 密钥；只存在服务端 env，不落库、不回显。 */
  readonly langbotApiKey?: string;
  /** IM 连接 token 的 HMAC 密钥；本阶段只投影，供数据面启用时校验。 */
  readonly imTokenSecret?: string;
  /** 入站事件正文保留小时数；数据面启用时用于清理，本阶段只校验形状。 */
  readonly imEventTextTtlHours: number;
}

const trimToUndefined = (value: unknown): unknown => {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
};

const ChannelModuleConfigSchema = z.strictObject({
  langbotBaseUrl: z.preprocess(
    trimToUndefined,
    z
      .string()
      .url()
      .refine((value) => value.startsWith("http://") || value.startsWith("https://"), "仅支持 http/https 基址")
      .optional(),
  ),
  langbotApiKey: z.preprocess(trimToUndefined, z.string().min(1).optional()),
  imTokenSecret: z.preprocess(trimToUndefined, z.string().min(1).optional()),
  imEventTextTtlHours: z.coerce.number().int().positive(),
});

/** 读取并校验 Channel 模块配置；只在请求、装配或任务路径调用。 */
export function getChannelConfig(): ChannelModuleConfig {
  const parsed = ChannelModuleConfigSchema.safeParse(getModuleConfig("channel"));
  if (!parsed.success) {
    // 只报字段路径与错误码：配置值可能包含密钥。
    const issues = parsed.error.issues.map((issue) => `${issue.path.join(".") || "<root>"}:${issue.code}`);
    throw new Error(`channel 模块配置校验失败（${issues.join(", ")}）`);
  }
  return parsed.data;
}

/**
 * 装配期校验：LangBot 数据面（Webhook / MCP / 冷启动桥）每条消息都要用 API Key 与 token 密钥。
 *
 * 只在启用了 LangBot 的部署上强制——未配置 `LANGBOT_BASE_URL` 时数据面不会被调用，缺密钥不应阻断其它
 * 模块启动。错误只列缺失的键名，不包含任何配置值。
 */
export function assertLangBotDataPlaneConfigured(config: ChannelModuleConfig): void {
  if (!config.langbotBaseUrl) return;
  const missing: string[] = [];
  if (!config.langbotApiKey) missing.push("LANGBOT_API_KEY");
  if (!config.imTokenSecret) missing.push("IM_TOKEN_SECRET");
  if (missing.length === 0) return;
  throw new Error(`channel 模块配置了 LANGBOT_BASE_URL，但缺少必需配置：${missing.join(", ")}`);
}
