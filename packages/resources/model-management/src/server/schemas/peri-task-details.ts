/**
 * Peri 任务详情的协议契约（`/web/peri-task-details` 与 `getPeriTaskDetail` 共用）。
 *
 * 从宿主 `apps/server/src/schemas/peri-task-details.ts` 迁入。**归属偏差已记录**：任务 1.3 的
 * 归属裁定把 peri-task 一族划给 `task` 包，但本包 manifest 的 `dependsOn` 已冻结为 `["agent-config"]`
 * （W1 裁定值，本波次不得改动），改引 `@fenix/resource-task/server` 会让 T2a 的 `assertDependsOnComplete`
 * 判定依赖声明不完整。因此本波次维持在**本包**（与 `src/services/peri-task-detail-store.ts` 同址），
 * 归属纠正留给后续波次连同 manifest 一起改；`sharedPatches` 登记宿主侧删除，`deviations` 记录该决定。
 *
 * 表名与文件路径保持宿主原名，便于与迁移前一一对应。
 */

import { WebOkSchema } from "@fenix/platform-sdk";
import * as z from "zod/v4";

export const PeriTaskDetailParamsSchema = z.object({
  environmentId: z.string().min(1).max(255),
  sessionId: z.string().min(1).max(255),
  taskId: z.string().min(1).max(255),
});

export const PeriTaskDetailQuerySchema = z.object({
  cursor: z.string().max(255).optional(),
  limit: z.coerce.number().int().min(1).max(1).optional().default(1),
  byteLimit: z.coerce.number().int().min(1).max(2_000).optional().default(2_000),
});

export const PeriTaskDetailItemSchema = z.object({
  type: z.literal("text"),
  content: z.string(),
});

export const PeriTaskPreviewDetailSchema = z.object({
  kind: z.literal("preview"),
  taskId: z.string(),
  taskKind: z.enum(["subagent", "background"]),
  items: z.array(PeriTaskDetailItemSchema).max(1),
  nextCursor: z.null(),
  complete: z.literal(false),
  limitation: z.literal("source_only_provides_preview"),
});

export const PeriTaskUnavailableDetailSchema = z.object({
  kind: z.literal("unavailable"),
  taskId: z.string(),
  taskKind: z.enum(["subagent", "background"]),
  reason: z.enum(["not_provided", "expired"]),
});

export const PeriTaskDetailSchema = z.discriminatedUnion("kind", [
  PeriTaskPreviewDetailSchema,
  PeriTaskUnavailableDetailSchema,
]);
export const PeriTaskDetailResponseSchema = WebOkSchema(PeriTaskDetailSchema);

export type PeriTaskDetail = z.infer<typeof PeriTaskDetailSchema>;
export type PeriTaskDetailQuery = z.infer<typeof PeriTaskDetailQuerySchema>;
