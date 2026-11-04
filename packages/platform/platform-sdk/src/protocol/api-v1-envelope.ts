import * as z from "zod/v4";

/** Published v1 success envelope, independent of console protocol evolution. */
export const ApiV1OkSchema = <T extends z.ZodType>(data: T) => z.object({ success: z.literal(true), data });

/** Published v1 safe error envelope. */
export const ApiV1ErrSchema = z.object({
  success: z.literal(false),
  error: z.object({ code: z.string(), message: z.string() }),
});
