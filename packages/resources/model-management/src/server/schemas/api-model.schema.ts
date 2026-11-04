import * as z from "zod/v4";

/** Independent v1 authorization projection. */
export const ApiResourceScopeSchema = z.object({
  organizationId: z.string().optional(),
  ownerUserId: z.string().optional(),
  visibility: z.enum(["private", "public"]),
});
/** Effective actions for the authenticated caller. */
export const ApiResourceAccessSchema = z.object({ actions: z.array(z.string()) });
/** SQL pagination for the published v1 collection. */
export const ApiModelListQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict();
/** Provider stable resource identifier. */
export const ApiProviderIdParamsSchema = z.object({ providerId: z.string().min(1) });
export const ApiProviderOnlyParamsSchema = ApiProviderIdParamsSchema;
/** Model database ID, distinct from its upstream modelId. */
export const ApiModelIdParamsSchema = ApiProviderIdParamsSchema.extend({ id: z.string().min(1) });
const providerFields = {
  displayName: z.string().nullable().optional(),
  protocol: z.enum(["openai", "anthropic"]).optional(),
  baseUrl: z.string().nullable().optional(),
  apiKey: z.string().nullable().optional(),
  extraOptions: z.record(z.string(), z.unknown()).nullable().optional(),
  publicReadable: z.boolean().optional(),
};
/** Creation alone defaults the upstream protocol. */
export const ApiProviderUpsertBodySchema = z
  .object({
    name: z.string().min(1).max(64),
    ...providerFields,
    protocol: z.enum(["openai", "anthropic"]).default("openai"),
  })
  .strict();
/** Omitted fields preserve existing configuration. */
export const ApiProviderUpdateBodySchema = z
  .object(providerFields)
  .strict()
  .refine((v) => Object.keys(v).length > 0, "Empty update");
const modelFields = {
  displayName: z.string().nullable().optional(),
  modalities: z
    .union([
      z.array(z.string()),
      z
        .object({
          input: z.array(z.enum(["text", "image"])).optional(),
          output: z.array(z.enum(["text", "image"])).optional(),
        })
        .strict(),
    ])
    .nullable()
    .optional(),
  limitConfig: z
    .object({
      context: z.number().int().optional(),
      output: z.number().int().optional(),
      rpm: z.number().int().optional(),
    })
    .strict()
    .nullable()
    .optional(),
  cost: z.object({ input: z.number().optional(), output: z.number().optional() }).strict().nullable().optional(),
  options: z.record(z.string(), z.unknown()).nullable().optional(),
};
/** Model creation with an immutable upstream identifier. */
export const ApiModelUpsertBodySchema = z.object({ modelId: z.string().min(1), ...modelFields }).strict();
/** Partial model configuration update. */
export const ApiModelUpdateBodySchema = z
  .object(modelFields)
  .strict()
  .refine((v) => Object.keys(v).length > 0, "Empty update");
/** Safe public Provider projection; credentials are write-only. */
export const ApiProviderListItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  displayName: z.string().nullable(),
  kind: z.enum(["direct", "gateway"]),
  gatewayType: z.string().nullable(),
  protocol: z.enum(["openai", "anthropic"]),
  baseUrl: z.string().nullable(),
  modelCount: z.number().int().nonnegative(),
  hasApiKey: z.boolean(),
  scope: ApiResourceScopeSchema,
  access: ApiResourceAccessSchema,
});
/** Provider details exclude unbounded embedded model collections. */
export const ApiProviderDetailSchema = ApiProviderListItemSchema.omit({ modelCount: true }).extend({
  extraOptions: z.record(z.string(), z.unknown()).nullable(),
});
/** Public model projection. */
export const ApiModelDetailSchema = z.object({
  id: z.string(),
  providerId: z.string(),
  modelId: z.string(),
  displayName: z.string().nullable(),
  modalities: z.unknown().nullable(),
  limitConfig: z.unknown().nullable(),
  cost: z.unknown().nullable(),
  options: z.record(z.string(), z.unknown()).nullable(),
});
export const ApiModelListItemSchema = ApiModelDetailSchema;
/** Versioned paginated result. */
const pageOf = <T extends z.ZodType>(item: T) =>
  z.object({
    items: z.array(item),
    total: z.number().int().nonnegative(),
    page: z.number().int().positive(),
    pageSize: z.number().int().positive(),
  });
export const ApiProviderListResponseSchema = pageOf(ApiProviderListItemSchema);
export const ApiModelListResponseSchema = pageOf(ApiModelListItemSchema);
export type ApiModelListQuery = z.infer<typeof ApiModelListQuerySchema>;
export type ApiProviderUpsertBody = z.infer<typeof ApiProviderUpsertBodySchema>;
export type ApiProviderUpdateBody = z.infer<typeof ApiProviderUpdateBodySchema>;
export type ApiModelUpsertBody = z.infer<typeof ApiModelUpsertBodySchema>;
export type ApiModelUpdateBody = z.infer<typeof ApiModelUpdateBodySchema>;
