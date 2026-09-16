import * as z from "zod/v4";

export const ResourceAccessSchema = z
  .object({
    ownership: z.string().describe("资源所有权类型，例如 internal 或 external。"),
    sourceOrganizationId: z.string().describe("资源来源组织 ID。"),
    sourceOrganizationName: z.string().optional().describe("资源来源组织名称。"),
    resourceUid: z.string().describe("资源唯一 ID。"),
    resourceKey: z.string().describe("跨组织可读的稳定资源键。"),
    manageable: z.boolean().describe("当前组织是否可管理该资源的共享属性。"),
    writable: z.boolean().describe("当前组织是否可修改该资源。"),
    publicReadable: z.boolean().optional().describe("该资源是否对其他组织公开可读。"),
  })
  .describe("资源访问控制信息。");
