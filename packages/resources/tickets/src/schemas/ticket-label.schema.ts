import { WebOkSchema } from "@fenix/platform-sdk";
import * as z from "zod/v4";
import {
  LABEL_MAX_COUNT,
  TICKET_LABEL_DESCRIPTION_MAX_LENGTH,
  TICKET_LABEL_NAME_MAX_LENGTH,
} from "../server/services/ticket-limits";

/**
 * 项目标签（`/web/ticket-projects/:projectId/labels`）与工单标签挂载（`PUT .../labels`）的 schema。
 *
 * 两条边界（backend contract §7.1）：
 * - **挂载**是全量集合语义（`labelIds` 是「设置后应当只剩这些」，空数组表示清空），带 `expectedVersion`；
 * - **标签本体**的 CRUD 是管理员动作，不要求 `expectedVersion`（上游无版本字段，管理动作不参与工单版本口径）。
 *
 * 标签事实源在托管平台，本包不为标签建表：视图 schema 就是上游投影，没有本地字段可泄漏。
 */

/** 颜色按 Forgejo 口径：6 位十六进制、不带 `#`；带 `#` 与大小写在这里统一归一，避免 400 成为 UX 陷阱。 */
const TicketLabelColorSchema = z
  .string()
  .regex(/^#?[0-9a-fA-F]{6}$/)
  .transform((value) => value.replace(/^#/, "").toLowerCase());

export const TicketLabelViewSchema = z.object({
  id: z.string(),
  name: z.string(),
  color: z.string().nullable(),
  description: z.string().nullable(),
});

export const TicketLabelSetRequestSchema = z.strictObject({
  /** 全量集合语义（不是增量追加）：空数组表示清空标签。上限 `LABEL_MAX_COUNT`。 */
  labelIds: z.array(z.string().regex(/^[1-9]\d*$/)).max(LABEL_MAX_COUNT),
  expectedVersion: z.string().regex(/^[0-9a-f]{64}$/),
});

export const TicketLabelCreateRequestSchema = z.strictObject({
  name: z.string().min(1).max(TICKET_LABEL_NAME_MAX_LENGTH),
  color: TicketLabelColorSchema.optional(),
  description: z.string().max(TICKET_LABEL_DESCRIPTION_MAX_LENGTH).optional(),
});

/** 修改标签：至少一项（空 body 的 PATCH 等价于什么都不做，放行只会让调用方以为生效）。 */
export const TicketLabelUpdateRequestSchema = z
  .strictObject({
    name: z.string().min(1).max(TICKET_LABEL_NAME_MAX_LENGTH).optional(),
    color: TicketLabelColorSchema.optional(),
    description: z.string().max(TICKET_LABEL_DESCRIPTION_MAX_LENGTH).optional(),
  })
  .refine((value) => value.name !== undefined || value.color !== undefined || value.description !== undefined, {
    message: "至少提供 name、color 或 description",
  });

/** 项目标签列表**不翻页**：标签是仓库级小集合，适配器已按 `Link` 头翻完（backend contract §1.1 路由 6）。 */
export const TicketLabelListResponseSchema = WebOkSchema(z.object({ items: TicketLabelViewSchema.array() }));
export const TicketLabelResponseSchema = WebOkSchema(
  z.object({ label: TicketLabelViewSchema, operationId: z.string() }),
);

/** 标签路径参数：`labelId` 是 Forgejo 的标签 ID，与评论 ID 同样是「十进制字符串」。 */
export const TicketLabelParamsSchema = z.object({
  projectId: z.string().uuid(),
  labelId: z.string().regex(/^[1-9]\d*$/),
});
