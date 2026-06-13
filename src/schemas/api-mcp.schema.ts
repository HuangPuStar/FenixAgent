import { z } from "zod/v4";

export const ApiMcpIdParamsSchema = z.object({ id: z.string() });

export const ApiMcpCreateBodySchema = z.object({
  name: z.string(),
  type: z.enum(["local", "remote"]).default("local"),
  command: z.array(z.string()).optional(),
  url: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  timeout: z.number().optional(),
  oauth: z
    .object({
      clientId: z.string().optional(),
      clientSecret: z.string().optional(),
      scope: z.string().optional(),
      redirectUri: z.string().optional(),
    })
    .optional(),
  publicReadable: z.boolean().optional(),
});

export const ApiMcpUpdateBodySchema = ApiMcpCreateBodySchema.partial();

export const ApiMcpListItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.string(),
  enabled: z.boolean(),
  summary: z.string().nullable(),
  toolsCount: z.number().optional(),
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

export const ApiMcpListResponseSchema = z.object({ servers: z.array(ApiMcpListItemSchema) });

export const ApiMcpDetailSchema = z.object({
  name: z.string(),
  type: z.string(),
  enabled: z.boolean(),
  summary: z.string().nullable(),
  config: z.unknown(),
  resourceAccess: z
    .object({
      ownership: z.enum(["internal", "external"]),
      writable: z.boolean(),
      publicReadable: z.boolean().optional(),
    })
    .optional(),
});

export const ApiMcpDeleteResponseSchema = z.object({ name: z.string(), deleted: z.literal(true) });
