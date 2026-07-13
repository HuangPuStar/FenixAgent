import * as z from "zod/v4";

export const ProdViewModuleConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
  })
  .passthrough();

export const ProdViewModulesConfigSchema = z
  .object({
    chatHeader: ProdViewModuleConfigSchema.optional(),
    sessionSidebar: ProdViewModuleConfigSchema.optional(),
    chatView: ProdViewModuleConfigSchema.optional(),
    chatComposer: ProdViewModuleConfigSchema.optional(),
    permissionPanel: ProdViewModuleConfigSchema.optional(),
    todoPanel: ProdViewModuleConfigSchema.optional(),
    contextPanel: ProdViewModuleConfigSchema.optional(),
    toolCallRow: ProdViewModuleConfigSchema.optional(),
    filesPanel: ProdViewModuleConfigSchema.optional(),
    sitesPanel: ProdViewModuleConfigSchema.optional(),
    tasksPanel: ProdViewModuleConfigSchema.optional(),
    viewsPanel: ProdViewModuleConfigSchema.optional(),
  })
  .passthrough();

export const CreateProdViewSchema = z.object({
  name: z.string().min(1).max(200),
  agentId: z.string().uuid(),
  description: z.string().max(500).optional(),
});

export const UpdateProdViewSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(500).optional(),
  modulesConfig: ProdViewModulesConfigSchema.optional(),
  enabled: z.boolean().optional(),
});

/** 通用 ID 参数 — 用于路由 params */
export const IdParamsSchema = z.object({ id: z.string().min(1) });

/** ProdView 列表查询参数 */
export const ListProdViewQuerySchema = z.object({
  agentId: z.string().optional(),
  enabled: z.coerce.boolean().optional(),
});

/** 通用成功响应 — passthrough 允许额外字段（如 data）通过校验 */
export const OkResponseSchema = z.object({ success: z.literal(true) }).passthrough();

export type CreateProdViewInput = z.infer<typeof CreateProdViewSchema>;
export type UpdateProdViewInput = z.infer<typeof UpdateProdViewSchema>;
