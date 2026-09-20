import * as z from "zod/v4";
import type { ResourceAccess, ResourceScope } from "../resource/authorization";

/**
 * 已发布 `/api/*` 合同的资源访问视图。
 *
 * 这是**唯一的**旧字段形状保留点：`/web/*` 与内部调用一律使用 `ResourceScope` +
 * `ResourceAccess.actions`，只有对外稳定协议需要把动作集合映射回这组布尔/来源字段。
 * 映射逻辑见 {@link toResourceAccessView}，资源包不得各自再写一份。
 */
export interface ResourceAccessView {
  ownership: "internal" | "external";
  sourceOrganizationId: string;
  sourceOrganizationName?: string;
  resourceUid: string;
  resourceKey: string;
  manageable: boolean;
  writable: boolean;
  publicReadable?: boolean;
}

export const ResourceAccessViewSchema = z
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

/**
 * 从新栈的 `scope + access` 派生 `/api/*` 视图字段。
 *
 * 语义对应关系（迁移自旧的 `resource_permission` 装饰逻辑）：
 * - `internal` / `external` 由资源归属组织与当前 active organization 比较得出；
 * - `manageable` 与 `writable` 等价于拥有 `update` 动作（成员只拿到 `memberDefaultActions`，
 *   因此对组织资源不再可写，这是设计要求的收紧）；
 * - `publicReadable` 由资源自身的 `visibility` 表达，而不是查询侧权限记录。
 *
 * `sourceOrganizationName` 是展示信息，由调用方批量查询后传入；缺失时字段整体省略，
 * 与迁移前"组织名录不可用时不出名称"的行为一致。
 */
export function toResourceAccessView(input: {
  readonly resource: { readonly id: string; readonly scope: ResourceScope; readonly access: ResourceAccess };
  readonly activeOrganizationId?: string;
  readonly sourceOrganizationName?: string;
}): ResourceAccessView {
  const organizationId = input.resource.scope.organizationId ?? "";
  const actions = input.resource.access.actions;
  return {
    ownership: organizationId === input.activeOrganizationId ? "internal" : "external",
    sourceOrganizationId: organizationId,
    ...(input.sourceOrganizationName === undefined ? {} : { sourceOrganizationName: input.sourceOrganizationName }),
    resourceUid: input.resource.id,
    resourceKey: `${organizationId}/${input.resource.id}`,
    manageable: actions.includes("update"),
    writable: actions.includes("update"),
    publicReadable: input.resource.scope.visibility === "public",
  };
}
