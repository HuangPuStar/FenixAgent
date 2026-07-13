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
  })
  .passthrough();

export const CreateProdViewSchema = z.object({
  name: z.string().min(1).max(200),
  agentId: z.string().min(1),
  description: z.string().max(500).optional(),
});

export const UpdateProdViewSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(500).optional(),
  modulesConfig: ProdViewModulesConfigSchema.optional(),
  enabled: z.boolean().optional(),
});

export type CreateProdViewInput = z.infer<typeof CreateProdViewSchema>;
export type UpdateProdViewInput = z.infer<typeof UpdateProdViewSchema>;
