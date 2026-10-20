/**
 * Forgejo v1 响应体的字段清单（只列本适配器**实际消费**的字段）。
 *
 * 字段一律声明为 optional + `unknown`，这是刻意的：上游响应不由我们控制，Forgejo 的版本差异、可选字段
 * 与代理改写都可能让某个字段缺席或换类型。若在这里写具体类型（如 `login?: string`），类型系统就会替
 * 运行时作保，mapper 的逐字段校验看起来像多余代码，实际却仍是唯一的安全来源。
 *
 * 因此本文件的职责是「声明我们读了哪些上游字段」，值的收窄全部发生在 `mapper.ts`。数组元素与嵌套对象
 * 同样按未知值处理：列表里的单个元素也可能是任何东西。
 */

/** 用户/操作者（issue.user、comment.user、repository.owner 等位置共用同一形状）。 */
export interface ForgejoUserDto {
  readonly id?: unknown;
  readonly login?: unknown;
  readonly full_name?: unknown;
}

/** 标签。 */
export interface ForgejoLabelDto {
  readonly id?: unknown;
  readonly name?: unknown;
  readonly color?: unknown;
  readonly description?: unknown;
}

/** 仓库。 */
export interface ForgejoRepositoryDto {
  readonly id?: unknown;
  readonly name?: unknown;
  /** 内嵌的 owner 对象（ForgejoUserDto）。 */
  readonly owner?: unknown;
  readonly private?: unknown;
  readonly has_issues?: unknown;
  readonly default_branch?: unknown;
  readonly description?: unknown;
}

/**
 * Issue。
 *
 * `state` 只可能是 `open` / `closed`；`updated_at` 是秒级时间戳，只作同步参考，不用于并发判定
 * （内容指纹见方案 §8）。
 */
export interface ForgejoIssueDto {
  readonly number?: unknown;
  readonly title?: unknown;
  readonly body?: unknown;
  readonly state?: unknown;
  readonly labels?: unknown;
  readonly user?: unknown;
  readonly assignee?: unknown;
  readonly updated_at?: unknown;
}

/** 评论；`issue_url` 是编辑评论路径取工单编号的唯一来源（该端点不含编号参数）。 */
export interface ForgejoCommentDto {
  readonly id?: unknown;
  readonly body?: unknown;
  readonly user?: unknown;
  readonly issue_url?: unknown;
  readonly updated_at?: unknown;
}

/**
 * 附件（issue asset）。
 *
 * `uuid` 是**内容地址的唯一来源**：字节不在 API 前缀下，只能经 `/attachments/{uuid}` 取，而
 * `browser_download_url` 是上游给的完整 URL，本适配器不采信（见 `client.ts` 的附件下载）。
 */
export interface ForgejoAttachmentDto {
  readonly id?: unknown;
  readonly name?: unknown;
  readonly size?: unknown;
  readonly created_at?: unknown;
  readonly uuid?: unknown;
  readonly type?: unknown;
}
