import { WebOkSchema } from "@fenix/platform-sdk";
import * as z from "zod/v4";
import { TicketOperationViewSchema } from "./ticket-operation.schema";

/**
 * 工单项目（`/web/ticket-projects...`）的请求与响应 schema。
 *
 * 开通请求的 owner 口径：**请求里的 `owner` 不是授权依据**。仓库固定建在当前凭据所属账号下，服务端回读
 * 创建响应的 `ref.owner` 与凭据账号比对，不一致即失败且不落库（t02-decisions 一.D1）；`bind` 模式则以
 * 「当前凭据能访问该仓库」为前置（先查询校验，不通过即拒绝）。字段保留在请求体里是因为它同时承载
 * 「向 Git 服务声明的目标账号」与 bind 模式的必要坐标（backend contract §6.1 的调用形状）。
 *
 * `mode` 用 `discriminatedUnion` 而不是 `refine`：`create` 的 `name` 可省略（服务端按组织派生预留名），
 * `bind` 的 `name` 必填，两种形态在类型层面就应当互斥。
 */
export const TicketProvisionRequestSchema = z.discriminatedUnion("mode", [
  z.object({
    connectionId: z.string().min(1),
    mode: z.literal("create"),
    repository: z.object({
      owner: z.string().min(1),
      name: z.string().min(1).max(100).optional(),
    }),
  }),
  z.object({
    connectionId: z.string().min(1),
    mode: z.literal("bind"),
    repository: z.object({
      owner: z.string().min(1),
      name: z.string().min(1).max(100),
    }),
  }),
]);

/**
 * 默认项目切换与组织级暂停：两者都是数据库事务内的本地变更，因此不受幂等键保护（backend contract §8.1）。
 *
 * `refine` 保证至少一项：空 body 的 PATCH 语义上等于「什么都不做」，放行只会让调用方以为操作生效。
 */
export const TicketProjectPatchRequestSchema = z
  .object({
    defaultProjectId: z.string().uuid().optional(),
    status: z.enum(["active", "paused"]).optional(),
  })
  .refine((value) => value.defaultProjectId !== undefined || value.status !== undefined, {
    message: "至少提供 defaultProjectId 或 status",
  });

/** 项目视图：`bindingId` 是 git 绑定 ID，`repository` 是开通时的坐标快照（展示与排障用）。 */
export const TicketProjectViewSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  bindingId: z.string(),
  repository: z.object({
    connectionId: z.string(),
    providerRepositoryId: z.string(),
    owner: z.string(),
    name: z.string(),
  }),
  isDefault: z.boolean(),
  status: z.enum(["active", "paused"]),
  createdAt: z.string(),
  updatedAt: z.string(),
});

/** 项目总览：`state` 是组织级三态，`unconfigured` 表示还没有任何项目（关闭态下前端零请求）。 */
export const TicketProjectOverviewResponseSchema = WebOkSchema(
  z.object({
    projects: TicketProjectViewSchema.array(),
    defaultProjectId: z.string().nullable(),
    state: z.enum(["unconfigured", "ready", "paused"]),
  }),
);

/** 开通成功（200）：项目与操作一并返回，前端无需再查一次操作即可定位账本行。 */
export const TicketProvisionResponseSchema = WebOkSchema(
  z.object({
    project: TicketProjectViewSchema,
    operation: TicketOperationViewSchema,
  }),
);
