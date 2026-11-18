import { z } from "zod/v4";

/** 自描述对象分片标记；本模块不包含序列化或服务端依赖。 */
export const HISTORY_OBJECT_PART_KEY = "__fenixSyncObjectPart";
/** 客户端先校验信封，再按容量预算验证、收集及重组原始对象。 */
export const contentObjectPartSchema = z
  .strictObject({
    [HISTORY_OBJECT_PART_KEY]: z.literal(1),
    kind: z.enum(["history_object", "text_part", "tool_object", "tool_boundary"]),
    partIndex: z.number().int().nonnegative(),
    partCount: z.number().int().positive().max(1048576),
    totalBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
    data: z.string(),
  })
  .refine((value) => value.partIndex < value.partCount, "part index exceeds count");
/** 浏览器安全的分片信封 DTO。 */
export type ContentObjectPart = z.infer<typeof contentObjectPartSchema>;
