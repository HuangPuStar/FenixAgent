import * as z from "zod/v4";
import { WebOkSchema } from "./common.schema";

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
