import * as z from "zod/v4";

const common = { timeout: z.number().int().positive().optional(), enabled: z.boolean().optional() };
/** Full v1 connection configuration; secrets are write-only. */
export const ApiMcpConfigSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("local"),
      command: z.array(z.string().min(1)).min(1),
      environment: z.record(z.string(), z.string()).optional(),
      ...common,
    })
    .strict(),
  z
    .object({
      type: z.literal("remote"),
      url: z.string().url(),
      headers: z.record(z.string(), z.string()).optional(),
      oauth: z
        .union([
          z.literal(false),
          z
            .object({
              clientId: z.string().optional(),
              clientSecret: z.string().optional(),
              scope: z.string().optional(),
              redirectUri: z.string().optional(),
            })
            .strict(),
        ])
        .optional(),
      ...common,
    })
    .strict(),
  z
    .object({
      type: z.literal("streamable-http"),
      url: z.string().url(),
      headers: z.record(z.string(), z.string()).optional(),
      ...common,
    })
    .strict(),
]);
/** Version-owned pagination. */
export const ApiMcpListQuerySchema = z
  .object({
    page: z.coerce.number().int().positive().default(1),
    pageSize: z.coerce.number().int().positive().max(100).default(20),
  })
  .strict();
/** Stable resource identifier. */
export const ApiMcpIdParamsSchema = z.object({ id: z.string().min(1) });
/** Strict create request. */
export const ApiMcpCreateBodySchema = z
  .object({ name: z.string().min(1).max(64), config: ApiMcpConfigSchema, publicReadable: z.boolean().optional() })
  .strict();
/** Toggle, full replacement, and audience-only updates are mutually exclusive. */
export const ApiMcpUpdateBodySchema = z.union([
  z.object({ enabled: z.boolean() }).strict(),
  z.object({ config: ApiMcpConfigSchema, publicReadable: z.boolean().optional() }).strict(),
  z.object({ publicReadable: z.boolean() }).strict(),
]);
/** Safe list DTO. */
export const ApiMcpListItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.enum(["local", "remote", "streamable-http"]),
  enabled: z.boolean(),
  summary: z.string(),
  toolsCount: z.number().int().nonnegative(),
  scope: z.object({
    organizationId: z.string().optional(),
    ownerUserId: z.string().optional(),
    visibility: z.enum(["public", "private"]),
  }),
  access: z.object({ actions: z.array(z.string()) }),
});
/** Paginated v1 result. */
export const ApiMcpListResponseSchema = z.object({
  items: z.array(ApiMcpListItemSchema),
  total: z.number().int(),
  page: z.number().int(),
  pageSize: z.number().int(),
});
/** Credential-free detail. */
export const ApiMcpDetailSchema = ApiMcpListItemSchema.extend({
  config: z.record(z.string(), z.unknown()),
  headerNames: z.array(z.string()),
  environmentNames: z.array(z.string()),
  hasClientSecret: z.boolean(),
});
/** Delete succeeds without a resource body. */
export const ApiMcpDeleteResponseSchema = z.null();
export type ApiMcpListQuery = z.infer<typeof ApiMcpListQuerySchema>;
export type ApiMcpCreateBody = z.infer<typeof ApiMcpCreateBodySchema>;
export type ApiMcpUpdateBody = z.infer<typeof ApiMcpUpdateBodySchema>;
