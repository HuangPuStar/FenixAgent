import * as z from "zod/v4";

/**
 * `/api/system/logs` 的协议形状。
 *
 * 与投影层的对应关系：响应的每个字段都由 `../services/log-projection` 产出（字段白名单 + 红线脱敏 +
 * 长度裁剪），这里只描述形状。协议里**没有**文件路径与原始文件名——客户端能拿到的只有服务端枚举出的
 * 日志源 `id`，它不可用于拼路径（服务端按 ID 命中枚举结果，见 `../services/system-log-service`）。
 */

/** 日志源：`id` 形如 `app-2026-09-20` / `error-2026-09-20`；`kind` 区分全量日志与 error 独立文件。 */
export const SystemLogSourceSchema = z.object({
  id: z.string(),
  kind: z.enum(["app", "error"]),
  date: z.string(),
  size: z.number().int().nonnegative(),
  modifiedAt: z.iso.datetime(),
});

export const SystemLogSourcesResponseSchema = z.object({
  success: z.literal(true),
  data: z.object({ sources: SystemLogSourceSchema.array() }),
});

/** 检索入参：`sourceId` 是唯一的位置标识，长度上限只为挡住畸形输入，形状校验在服务层（映射 400）。 */
export const SystemLogSearchQuerySchema = z.object({
  sourceId: z.string().min(1).max(120),
  q: z.string().max(200).optional(),
  errorOnly: z.stringbool().optional().default(false),
  limit: z.coerce.number().int().min(1).max(1_000).optional().default(500),
});

/**
 * 一行投影后的日志。
 *
 * `timestamp` 不收紧成 `z.iso.datetime()`：日志可能来自非本进程写入的内容（`console` 拦截会把任意
 * 文本并入 pino 流），严格校验会把一条畸形行放大成整个响应的 500。时间与级别的形状由投影层裁剪。
 */
export const SystemLogEntrySchema = z.object({
  timestamp: z.string().nullable(),
  level: z.string().nullable(),
  module: z.string().nullable(),
  requestId: z.string().nullable(),
  message: z.string(),
  error: z
    .object({ type: z.string().nullable(), message: z.string().nullable(), stack: z.string().nullable() })
    .nullable(),
});

export const SystemLogSearchResponseSchema = z.object({
  success: z.literal(true),
  data: z.object({
    source: SystemLogSourceSchema,
    entries: z.array(SystemLogEntrySchema),
    totalMatches: z.number().int().nonnegative(),
    truncated: z.boolean(),
  }),
});

/**
 * 下载（导出）入参。
 *
 * 端点路径仍是 `/download`（对外协议不变），但响应体是**投影后的 JSON Lines**，不是底层文件字节：
 * 见 `../routes/api/system-logs.ts` 的处理器说明。
 */
export const SystemLogDownloadQuerySchema = z.object({
  sourceId: z.string().min(1).max(120),
});
