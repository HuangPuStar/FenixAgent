/**
 * 工单的业务上限与协议模式常量：本包内的**唯一**定义处。
 *
 * 为什么必须集中：标题、正文与列表分页的上限要在两处同时生效——协议层 zod（边界上快速拒绝，转成 400）
 * 与写入路径的最终校验（`buildTicketBody` 在拼好身份头后的整串上再量一次 UTF-8 字节数，见方案 §7）。
 * 两处各写一份字面量时，一次调参就会分叉成「协议放行、服务拒绝」或相反，且只会在生产流量里显形。
 *
 * 身份头自身的格式常量（8 KiB 块上限、嵌套深度 6）**不**在这里：它们描述的是身份头的编码格式，与解析器
 * 同文件内聚（`identity-header.ts`）。本文件因此不依赖任何模块内实现，可被路由、服务与 schema 同时引用。
 *
 * T02 只消费标题、正文、列表分页与幂等键四项；标签、负责人与附件是已裁定的上限（T03/T05 使用），
 * 先落地常量以免后续各自为政。附件按字节（10 MiB）与「每条消息单次提交的个数」计数（方案 §7）。
 */

/** 标题长度，按 Unicode 字符数（不是字节数）：1–200。 */
export const TICKET_TITLE_MAX_LENGTH = 200;

/**
 * 用户正文的 UTF-8 字节上限。
 *
 * 校验点在序列化后的最终字符串上（身份头 + 正文 + 分隔符），而不是用户输入的字符数：字符数相同的中英文
 * 正文字节数可以差三倍，按字节量才不会让序列化后的请求静默超过上游限制。
 */
export const MESSAGE_MAX_BYTES = 64 * 1024;

/** 一条工单最多挂载的标签数。 */
export const LABEL_MAX_COUNT = 20;

/** 负责人 0 或 1 人：工单只持有一个 `assignee_id`，本上限用于拒绝对多值形态的输入。 */
export const TICKET_ASSIGNEE_MAX_COUNT = 1;

/** 单个附件的字节上限（10 MiB）。 */
export const TICKET_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;

/** 每条消息单次提交的附件数上限。 */
export const TICKET_ATTACHMENT_MAX_COUNT = 5;

/** 列表默认页大小。 */
export const TICKET_LIST_DEFAULT_LIMIT = 30;

/** 列表页大小上限（`TicketListQuerySchema` 的 zod 上界）。 */
export const TICKET_LIST_MAX_LIMIT = 100;

/**
 * 幂等键形状：8–128 位 URL 安全字符。
 *
 * 路由把它作为 `headers` 模型校验；缺失与不合法必须映射成两个稳定错误码
 * （`IDEMPOTENCY_KEY_REQUIRED` / `IDEMPOTENCY_KEY_INVALID`），前端据此区分提示文案。
 */
export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
