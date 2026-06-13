import { z } from "zod/v4";

export const ApiProviderIdParamsSchema = z.object({ id: z.string() });

export const ApiProviderUpsertBodySchema = z.object({
  name: z.string(),
  displayName: z.string().optional(),
  protocol: z.enum(["openai", "anthropic"]).default("openai"),
  baseUrl: z.string().optional(),
  apiKey: z.string().optional(),
  extraOptions: z.record(z.string(), z.string()).optional(),
  publicReadable: z.boolean().optional(),
});

export const ApiProviderUpdateBodySchema = ApiProviderUpsertBodySchema.partial();

export const ApiProviderListItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  displayName: z.string().nullable(),
  protocol: z.enum(["openai", "anthropic"]),
  baseUrl: z.string().nullable(),
  modelCount: z.number().int(),
  resourceAccess: z
    .object({
      ownership: z.enum(["internal", "external"]),
      sourceOrganizationId: z.string().optional(),
      sourceOrganizationName: z.string().optional(),
      resourceKey: z.string().optional(),
      manageable: z.boolean(),
      writable: z.boolean(),
      publicReadable: z.boolean().optional(),
    })
    .optional(),
});

export const ApiProviderListResponseSchema = z.object({ providers: z.array(ApiProviderListItemSchema) });

export const ApiProviderDetailSchema = z.object({
  id: z.string(),
  name: z.string(),
  displayName: z.string().nullable(),
  protocol: z.enum(["openai", "anthropic"]),
  baseUrl: z.string().nullable(),
  apiKey: z.string().nullable(),
  extraOptions: z.record(z.string(), z.string()).nullable().optional(),
  models: z.array(
    z.object({
      id: z.string(),
      name: z.string().nullable(),
      modalities: z.unknown().nullable(),
      limitConfig: z.unknown().nullable(),
      cost: z.unknown().nullable(),
    }),
  ),
  resourceAccess: z
    .object({
      ownership: z.enum(["internal", "external"]),
      writable: z.boolean(),
      publicReadable: z.boolean().optional(),
    })
    .optional(),
});

export const ApiProviderDeleteResponseSchema = z.object({ id: z.string(), deleted: z.literal(true) });

export const ApiProviderOnlyParamsSchema = z.object({ providerId: z.string() });
export const ApiModelIdParamsSchema = z.object({ providerId: z.string(), modelId: z.string() });

export const ApiModelUpsertBodySchema = z.object({
  modelId: z.string(),
  displayName: z.string().optional(),
  modalities: z.unknown().optional(),
  limitConfig: z.object({ context: z.number().int().optional(), output: z.number().int().optional() }).optional(),
  cost: z.object({ input: z.number().optional(), output: z.number().optional() }).optional(),
  options: z.record(z.string(), z.string()).optional(),
});

export const ApiModelUpdateBodySchema = ApiModelUpsertBodySchema.partial();

export const ApiModelListItemSchema = z.object({
  id: z.string(),
  providerName: z.string(),
  displayName: z.string().nullable(),
  modalities: z.unknown().nullable(),
  limitConfig: z.unknown().nullable(),
  cost: z.unknown().nullable(),
});

export const ApiModelListResponseSchema = z.object({ models: z.array(ApiModelListItemSchema) });

export const ApiModelDetailSchema = z.object({
  id: z.string(),
  providerName: z.string(),
  displayName: z.string().nullable(),
  modalities: z.unknown().nullable(),
  limitConfig: z.unknown().nullable(),
  cost: z.unknown().nullable(),
  options: z.record(z.string(), z.string()).nullable(),
});

export const ApiModelDeleteResponseSchema = z.object({
  providerId: z.string(),
  modelId: z.string(),
  deleted: z.literal(true),
});
