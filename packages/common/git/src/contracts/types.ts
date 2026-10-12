/**
 * 公共 Git 领域类型（`@fenix/git` 根出口的一部分）。
 *
 * 这些类型是消费者与适配器之间的稳定合同：Forgejo DTO 只在 `src/forgejo/` 内出现，跨出适配器一律
 * 转成本文件的领域类型（方案 §5）。所有外部数字 ID（仓库、Issue、评论、标签）在协议与领域层统一
 * 以**字符串**承载——Forgejo 侧是 int64，JavaScript 的 number 在超过 2^53 后不再精确，一旦在某一层
 * 退化成 number，序列化与比较就会静默出错。
 */

/** 仓库引用：绑定解析后的稳定坐标，是所有操作的寻址依据。 */
export interface RepositoryRef {
  /** 连接 ID（`AOS_GIT_CONFIG_FILE` 中 connections[].id）。 */
  readonly connectionId: string;
  /** 托管平台侧的仓库数字 ID（字符串承载）。 */
  readonly providerRepositoryId: string;
  readonly owner: string;
  readonly name: string;
}

/** 仓库元数据投影；`createPrivate` / `ensureIssuesEnabled` 也返回该形状。 */
export interface GitRepository {
  readonly ref: RepositoryRef;
  readonly isPrivate: boolean;
  /** Issues 功能是否开启；未开启时工单能力不可用（`ensureIssuesEnabled` 负责补齐）。 */
  readonly issuesEnabled: boolean;
  readonly defaultBranch: string | null;
  readonly description: string | null;
}

/** 外部数字 ID 的协议表示；见文件头说明。 */
export type GitObjectId = string;

export type IssueState = "open" | "closed";

/** 操作者投影：只保留展示所需的稳定标识与显示名。 */
export interface GitActor {
  readonly id: string;
  readonly name: string;
}

/** 标签投影；`color` 与 `description` 允许为空（Forgejo 原生字段可为空）。 */
export interface GitLabel {
  readonly id: GitObjectId;
  readonly name: string;
  readonly color: string | null;
  readonly description: string | null;
}

/** Issue 投影（工单正文的事实源在 Forgejo，这里只做领域转换）。 */
export interface GitIssue {
  readonly number: GitObjectId;
  readonly title: string;
  readonly body: string;
  readonly state: IssueState;
  readonly labels: readonly GitLabel[];
  readonly author: GitActor;
  /** 负责人是可变业务字段；未指派时为 null。 */
  readonly assignee: GitActor | null;
  /**
   * 托管平台侧的更新时间（ISO 字符串），仅作同步参考。
   *
   * 并发判定的版本指纹**不是**这个值：工单模块从正文、标题、原生状态与排序后的标签计算内容指纹
   * （方案 §8），不依赖秒级时间戳。
   */
  readonly providerUpdatedAt: string | null;
}

/** 评论投影。 */
export interface GitComment {
  readonly id: GitObjectId;
  readonly issueNumber: GitObjectId;
  readonly body: string;
  readonly author: GitActor;
  readonly providerUpdatedAt: string | null;
}

/** 统一分页信封：`nextCursor` 为 null 表示已到末页。 */
export interface GitPage<TItem> {
  readonly items: readonly TItem[];
  readonly nextCursor: string | null;
  /**
   * 最后一页的页码（`Link` 头 `rel="last"`）；头缺失、无 `last` 或分页参数被上游忽略时为 null。
   *
   * 存在的唯一理由：评论按创建时间**升序**返回，而评论区要「先给最新一页」——消费方据此把游标定位到
   * 末页，一次读就能拿到最新的一页，不必从头翻完整个讨论串（方案 §12 的万级评论门槛）。
   * 它是 `Link` 头的透出，不是分页事实源；`nextCursor` 仍按 `rel="next"` 判定末页。
   */
  readonly lastCursor?: string | null;
}

/** 列表游标查询；`limit` 的默认值与上限由适配器按方案约定（默认 30、最大 100）夹取。 */
export interface GitListQuery {
  readonly cursor?: string | null;
  readonly limit?: number;
  /**
   * 只返回该时间之后创建/更新的对象（RFC3339）。
   *
   * 恢复核对用它把扫描面收窄到本次操作附近的窗口：Forgejo 的列表按创建时间**升序**返回，长讨论串
   * （万级评论）从第一页翻永远扫不到最新那条。空串按「不提供」处理。
   */
  readonly since?: string;
}

/** Issue 列表查询：`state` / `labels` / `query` 是方案 §8 约定的筛选维度。 */
export interface GitIssueListQuery extends GitListQuery {
  readonly state?: IssueState | "all";
  readonly labels?: readonly string[];
  readonly query?: string;
}

/** 创建 Issue 输入；`labels` 传标签名，`assignee` 传托管平台用户名。 */
export interface CreateIssueInput {
  readonly title: string;
  readonly body: string;
  readonly labels?: readonly string[];
  readonly assignee?: string | null;
}

/** 修改 Issue 输入；未提供的字段不发送。 */
export interface EditIssueInput {
  readonly title?: string;
  readonly body?: string;
  readonly state?: IssueState;
}

export interface CreateCommentInput {
  readonly body: string;
}

export interface EditCommentInput {
  readonly body: string;
}

export interface CreateLabelInput {
  readonly name: string;
  readonly color?: string | null;
  readonly description?: string | null;
}

export interface EditLabelInput {
  readonly name?: string;
  readonly color?: string | null;
  readonly description?: string | null;
}

/** 创建仓库输入（管理操作；`owner` 必须是连接下已授权的服务账号命名空间）。 */
export interface CreateRepositoryInput {
  readonly owner: string;
  readonly name: string;
  readonly description?: string | null;
}
