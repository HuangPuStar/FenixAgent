/**
 * 远端对象的作者归属核验（§7.3）：把远端正文里的身份头与本端归属记录对上号，判定这条内容是否由 AOS
 * 主体写入。
 *
 * 独立成文件的原因：同一条规则要服务三条路径（issue 详情、T03 的评论、T04 的同步回填），三处必须给出
 * **同一个**结论；留在 `ticket-service.ts` 里会让后两条路径各抄一份，两份规则迟早漂移（例如只改了一处
 * 的摘要算法，另一处就开始把 AOS 作者判成外部来源）。
 *
 * 判定不采信正文里的任何自填身份：身份头只用于**对齐**本端记录（`message_id`、组织、对象 ID），作者
 * ID 与显示名一律取自 `ticket_messages`——写入路径已在那一行留下 AOS 主体坐标。对不上号即按外部来源
 * 处理，展示名取托管平台账号名：那是真实执行写入的账号，伪造不了。
 *
 * 调用方必须用匹配的对象类型读归属记录（唯一索引是 `(projectId, objectKind, providerObjectId)`）：
 * `objectKind` 不在这里复检，传错类型时对象 ID 与 `message_id` 会同时对不上，结果是保守的「外部来源」。
 */

import type { GitActor } from "@fenix/git/server";
import type { TicketMessageRow } from "../repositories/ticket-messages";
import { hashBody, parseTicketBody } from "./identity-header";

/**
 * 列表行连作者显示名快照都没有时的兜底文案（T04 的同步可能只带回外部账号）。
 *
 * 刻意不写「未知用户」：这条工单在 AOS 侧确实没有可归属的主体，前端展示的应是「来源不明」而不是
 * 「查不到的人」。
 */
export const FALLBACK_ACTOR_NAME = "外部来源";

/** 作者归属的核验结论；`external` 的 `authorId` 恒为 null（不可信来源不得参与任何以作者为依据的判定）。 */
export type AuthorResolution =
  | { readonly source: "aos"; readonly authorId: string; readonly authorName: string; readonly messageId: string }
  | { readonly source: "external"; readonly authorId: null; readonly authorName: string };

/**
 * 核验远端正文的作者归属：身份头、本端归属记录、正文摘要三者同时吻合才算 AOS 作者（§7.3）。
 *
 * 入参用 `organizationId` 而不是 `projectId`：判定中真正用到的项目属性只有「项目属于哪个组织」
 * （跨组织搬运正文的防护），而调用方手上已有项目行；传 projectId 反而会诱导实现去多读一次项目行。
 */
export function resolveTicketAuthor(input: {
  readonly organizationId: string;
  readonly providerObjectId: string;
  readonly rawBody: string;
  readonly fallbackActor: GitActor;
  /** 本端归属记录；调用方按「项目 + 对象类型 + 对象 ID」查得。 */
  readonly message: TicketMessageRow | undefined;
}): AuthorResolution {
  const parsed = parseTicketBody(input.rawBody);
  const header = parsed.header;
  const message = input.message;
  if (
    header === null ||
    message === undefined ||
    message.messageId !== header.messageId ||
    message.providerObjectId !== input.providerObjectId ||
    message.bodyHash !== hashBody(parsed.body) ||
    header.organizationId !== input.organizationId
  ) {
    return { source: "external", authorId: null, authorName: input.fallbackActor.name };
  }
  // 作者取归属记录里的 AOS 主体，不取头部自填的 author.id：头部只用于「与本端记录对上号」。
  return {
    source: "aos",
    authorId: message.authorId,
    authorName: message.authorNameSnapshot,
    messageId: message.messageId,
  };
}
