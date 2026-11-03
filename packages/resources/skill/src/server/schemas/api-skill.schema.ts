import * as z from "zod/v4";
/** Version-owned collection query. */
export const ApiSkillListQuerySchema = z
  .object({
    page: z.coerce.number().int().positive().default(1),
    pageSize: z.coerce.number().int().positive().max(100).default(20),
  })
  .strict();
/** Stable resource ID. */
export const ApiSkillIdParamsSchema = z.object({ id: z.string().min(1) });
/** Import form; files retain binary bytes. */
export const ApiSkillCreateBodySchema = z
  .object({ manifest: z.string(), files: z.array(z.file()).min(1), overwrite: z.enum(["true", "false"]).optional() })
  .strict();
/** Partial content change; an explicit metadata dictionary replaces the old dictionary. */
export const ApiSkillUpdateBodySchema = z
  .object({
    content: z.string().optional(),
    description: z.string().optional(),
    metadata: z.record(z.string(), z.string()).optional(),
    publicReadable: z.boolean().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, "Empty update");
/** Safe metadata projection. */
export const ApiSkillListItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  scope: z.object({
    organizationId: z.string().optional(),
    ownerUserId: z.string().optional(),
    visibility: z.enum(["public", "private"]),
  }),
  access: z.object({ actions: z.array(z.string()) }),
});
/** Paginated result. */
export const ApiSkillListResponseSchema = z.object({
  items: z.array(ApiSkillListItemSchema),
  total: z.number().int(),
  page: z.number().int(),
  pageSize: z.number().int(),
});
/** Public detail, excluding source absolute path. */
export const ApiSkillDetailSchema = ApiSkillListItemSchema.extend({
  content: z.string(),
  metadata: z.record(z.string(), z.string()),
});
/** Successful deletion has no resource body. */
export const ApiSkillDeleteResponseSchema = z.null();
export type ApiSkillListQuery = z.infer<typeof ApiSkillListQuerySchema>;
export type ApiSkillIdParams = z.infer<typeof ApiSkillIdParamsSchema>;
export type ApiSkillCreateBody = z.infer<typeof ApiSkillCreateBodySchema>;
