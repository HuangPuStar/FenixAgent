/**
 * 工单内容的版本指纹（T02 的唯一口径，T03 的 `expectedVersion` 与 `VERSION_CONFLICT` 直接复用）。
 *
 * 为什么不用 `provider_updated_at`：Forgejo 的时间戳精度是秒，同一秒内的两次编辑会得到相同版本，
 * 「读到旧版本再提交」因此不会被发现；而按字段合成的指纹只在内容真的变化时才变（§8.4）。
 *
 * 口径细节（每一条都对应一个曾经的坑）：
 * - 用**数组**而不是对象拼摘要输入：对象键序在 JS 里虽然稳定，但跨语言/跨序列化路径会产生分歧，
 *   数组杜绝这一类「同内容不同指纹」的伪冲突；
 * - 标签按**名称字典序**排序：集合语义，与挂载顺序无关（`setLabels` 是全量设置，顺序不携带信息）；
 * - 正文用**剥离身份头之后**的用户正文：把 `message_id` 之类写进指纹，会让每次生成头部都造成一次伪冲突；
 * - 摘要与正文都先经 {@link normalizeBody}：CRLF 与 LF、尾部空行的差异不是内容差异，不该产生新版本。
 */

import { createHash } from "node:crypto";

/** 指纹口径的版本前缀：口径变更（增删参与字段）时必须改它，否则新旧指纹会被当作同一个版本比较。 */
const CONTENT_VERSION_PREFIX = "fenix.tickets.v1";

/**
 * 评论指纹的版本前缀；与工单前缀**刻意不同**。
 *
 * 评论没有标题、状态与标签，同一条正文在工单与评论两处必须得到不同的指纹：共用前缀会让「把评论正文
 * 填进工单版本」这类串味在比较中通过，而两者的写路径与核对口径完全不同。
 */
const COMMENT_VERSION_PREFIX = "fenix.tickets.comment.v1";

/**
 * 正文归一化：统一 `\n`、去掉尾部空白。
 *
 * 写入路径与读取路径必须共用本函数：gray-matter 序列化会补一个尾换行、解析又会去掉一个前导换行，
 * `trimEnd` 把这层编码差异抹平，否则「写进去的摘要」与「回源算出的摘要」永远对不上。
 */
export function normalizeBody(body: string): string {
  return body.replace(/\r\n/g, "\n").trimEnd();
}

/**
 * 计算内容指纹：sha256（十六进制）覆盖标题、正文、原生状态与排序后的标签名。
 *
 * `body` 传**已剥离身份头**的正文；`labelNames` 传标签名称集合（不是 ID：ID 属于托管平台，
 * 重新绑定同一仓库时可能变化，而名称是用户可见的稳定语义）。
 */
export function computeContentVersion(input: {
  readonly title: string;
  readonly body: string;
  readonly state: "open" | "closed";
  readonly labelNames: readonly string[];
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        CONTENT_VERSION_PREFIX,
        input.title,
        normalizeBody(input.body),
        input.state,
        [...input.labelNames].sort(),
      ]),
    )
    .digest("hex");
}

/**
 * 评论版本：前缀独立，只覆盖**剥离身份头之后**的正文（评论没有标题/状态/标签）。
 *
 * 与工单版本同一套规范化（`normalizeBody`），否则「写进去的评论」与「回源读出的评论」会因尾换行差异
 * 得到不同指纹，每次提交都判成版本冲突。
 */
export function computeCommentVersion(body: string): string {
  return createHash("sha256")
    .update(JSON.stringify([COMMENT_VERSION_PREFIX, normalizeBody(body)]))
    .digest("hex");
}
