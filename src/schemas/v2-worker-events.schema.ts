import * as z from "zod/v4";
import { StatusOkResponseSchema } from "./common.schema";

export const WorkerEventsRequestSchema = z.union([
  z.object({
    events: z.array(z.record(z.string(), z.unknown())),
  }),
  z.array(z.record(z.string(), z.unknown())),
  z.record(z.string(), z.unknown()),
]);

export const WorkerStateRequestSchema = z.object({
  status: z.string().optional(),
});

/** POST /v1/code/sessions/:id/worker/events — 写入事件响应 */
export const WorkerEventsResponseSchema = z.object({
  status: z.literal("ok"),
  count: z.number(),
});

export type WorkerEventsRequest = z.infer<typeof WorkerEventsRequestSchema>;
export type WorkerStateRequest = z.infer<typeof WorkerStateRequestSchema>;
export type WorkerEventsResponse = z.infer<typeof WorkerEventsResponseSchema>;
