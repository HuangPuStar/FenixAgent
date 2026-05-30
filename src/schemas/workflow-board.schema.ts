import * as z from "zod/v4";

export const BoardCreateSchema = z.object({
  action: z.literal("create"),
  name: z.string().min(1).max(100),
});

export const BoardUpdateSchema = z.object({
  action: z.literal("update"),
  boardId: z.string().min(1),
  name: z.string().min(1).max(100),
});

export const BoardDeleteSchema = z.object({
  action: z.literal("delete"),
  boardId: z.string().min(1),
});

export const BoardGetSchema = z.object({
  action: z.literal("get"),
  boardId: z.string().min(1),
});

export const BoardListSchema = z.object({
  action: z.literal("list"),
});
