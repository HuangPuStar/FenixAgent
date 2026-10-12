import * as z from "zod/v4";

/**
 * 身份头（`aos`）在 YAML 中的**线格式** schema —— 只描述形状，解析与生成见
 * `src/server/services/identity-header.ts`。
 *
 * 键名取 snake_case：身份头是写进 Forgejo 正文的对外事实，键名即协议（生成样例见 backend contract §7.2）。
 * 包内领域对象 `TicketIdentityHeader` 用 camelCase，两者之间的映射只有 identity-header.ts 一处，
 * 不得在别处再写第二份，否则改名时会出现「写得进、读不出」的半失效头。
 *
 * `strictObject`：未知键一律拒绝（fail closed）。身份头只由本服务生成，出现未知字段说明有别的写入者，
 * 此时不能按自填值授信；宁可判成外部来源（`header = null`）也不接受一个「看起来像我方」的头。
 *
 * 刻意**不**在此 schema 里放 `MESSAGE_MAX_BYTES` 一类的业务上限：那是协议层与服务层共用的常量，
 * 归属 `ticket-limits.ts`。
 */
export const TicketIdentityHeaderSchema = z.strictObject({
  /** 身份头版本号；将来做不兼容变更时靠它分流，不靠字段嗅探。 */
  schema: z.literal(1),
  organization_id: z.string().min(1),
  message_id: z.string().min(1),
  author: z.strictObject({
    id: z.string().min(1),
    name: z.string().min(1),
  }),
  /** T03 起才有负责人；T02 生成时整块省略。 */
  ticket: z
    .strictObject({
      assignee_id: z.string().min(1).optional(),
    })
    .optional(),
});

/** 身份头的线格式（YAML 键名）；领域对象见 `identity-header.ts` 的 `TicketIdentityHeader`。 */
export type TicketIdentityHeaderWire = z.infer<typeof TicketIdentityHeaderSchema>;
