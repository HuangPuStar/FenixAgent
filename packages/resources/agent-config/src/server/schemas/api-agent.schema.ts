import * as z from "zod/v4";

const AgentNodeSchema = z.union([
  z.object({}).strict(),
  z.object({ kind: z.literal("machine"), machineId: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("sandbox"), sandboxPoolId: z.string().min(1) }).strict(),
]);
const ids = z.array(z.string().min(1)).refine((v) => new Set(v).size === v.length, "Duplicate resource IDs");
/** Independent knowledge binding DTO; no Web view defaults are imported. */
export const ApiAgentKnowledgeSchema = z
  .object({
    knowledgeBaseIds: ids,
    policy: z
      .object({
        searchFirst: z.boolean().optional(),
        maxResults: z.number().int().positive().max(100).optional(),
        defaultNamespaces: z.array(z.string()).optional(),
      })
      .strict()
      .nullable()
      .optional(),
  })
  .strict();
const fields = {
  modelId: z.string().min(1).nullable().optional(),
  prompt: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  extra: z.record(z.string(), z.unknown()).nullable().optional(),
  knowledge: ApiAgentKnowledgeSchema.nullable().optional(),
  agentNode: AgentNodeSchema.optional(),
  skillIds: ids.optional(),
  mcpIds: ids.optional(),
  enableMemory: z.boolean().optional(),
  publicReadable: z.boolean().optional(),
};
/** Creation defaults memory only; omitted bindings remain absent. */
export const ApiAgentUpsertBodySchema = z
  .object({ name: z.string().min(1).max(64), ...fields, enableMemory: z.boolean().default(false) })
  .strict();
/** Immutable name and explicit partial-update semantics. */
export const ApiAgentUpdateBodySchema = z
  .object(fields)
  .strict()
  .refine((v) => Object.keys(v).length > 0, "Empty update");
/** Stable Agent database ID. */
export const ApiAgentIdParamsSchema = z.object({ id: z.string().min(1) });
/** Bounded collection pagination. */
export const ApiAgentListQuerySchema = z
  .object({
    page: z.coerce.number().int().positive().default(1),
    pageSize: z.coerce.number().int().positive().max(100).default(20),
  })
  .strict();
const scope = z.object({
  organizationId: z.string().optional(),
  ownerUserId: z.string().optional(),
  visibility: z.enum(["private", "public"]),
});
const access = z.object({ actions: z.array(z.string()) });
/** Published safe Agent summary. */
export const ApiAgentListItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  modelId: z.string().nullable(),
  agentNode: AgentNodeSchema,
  knowledgeBaseCount: z.number().int().nonnegative(),
  scope,
  access,
});
/** Published details expose configured values and effective permissions. */
export const ApiAgentDetailSchema = ApiAgentListItemSchema.omit({ knowledgeBaseCount: true }).extend({
  builtIn: z.boolean(),
  prompt: z.string().nullable(),
  extra: z.record(z.string(), z.unknown()).nullable(),
  knowledge: ApiAgentKnowledgeSchema.nullable(),
  skillIds: z.array(z.string()),
  mcpIds: z.array(z.string()),
  enableMemory: z.boolean(),
  publicReadable: z.boolean(),
});
/** Stable collection response. */
export const ApiAgentListResponseSchema = z.object({
  items: z.array(ApiAgentListItemSchema),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  pageSize: z.number().int().positive(),
});
export type ApiAgentListQuery = z.infer<typeof ApiAgentListQuerySchema>;
export type ApiAgentIdParams = z.infer<typeof ApiAgentIdParamsSchema>;
export type ApiAgentUpsertBody = z.infer<typeof ApiAgentUpsertBodySchema>;
export type ApiAgentUpdateBody = z.infer<typeof ApiAgentUpdateBodySchema>;
/** Deletion has no remaining resource data. */
export const ApiAgentDeleteResponseSchema = z.null();
