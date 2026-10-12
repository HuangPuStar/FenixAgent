import type {
  CreateCommentInput,
  CreateIssueInput,
  CreateLabelInput,
  EditCommentInput,
  EditIssueInput,
  EditLabelInput,
  GitComment,
  GitIssue,
  GitIssueListQuery,
  GitLabel,
  GitListQuery,
  GitPage,
  GitRepository,
  RepositoryRef,
} from "./types";

/**
 * 作用域客户端契约（方案 §5）。
 *
 * 普通消费者**只能**拿到这一层：作用域（consumerId、organizationId、repositoryRef 与允许的操作）
 * 由宿主在创建时绑定，来自服务端认证、绑定记录与静态消费者注册；客户端不提供任何修改作用域的方法，
 * 也不接受调用方传入的 consumerId 或凭据。包内部在每次操作时重新检查绑定所属组织与授权操作，因此
 * 绑定被暂停或权限被收回后，已创建的客户端不会继续带着旧权限工作。
 *
 * 管理操作（`createPrivate` / `bindExisting`）刻意**不在**这里：它们由独立管理服务
 *（{@link GitAdminService}）执行，不能交给普通工单写入路径。
 */

/** 仓库级只读操作。 */
export interface GitScopedRepositoryOperations {
  /** 读取仓库元数据；仓库不存在时抛 `NOT_FOUND`。 */
  get(): Promise<GitRepository>;
  /** 确保仓库 Issues 功能开启（幂等）；用于项目开通过程中的自愈。 */
  ensureIssuesEnabled(): Promise<GitRepository>;
}

/** Issue 操作。 */
export interface GitScopedIssueOperations {
  list(query?: GitIssueListQuery): Promise<GitPage<GitIssue>>;
  get(issueNumber: string): Promise<GitIssue>;
  create(input: CreateIssueInput): Promise<GitIssue>;
  edit(issueNumber: string, input: EditIssueInput): Promise<GitIssue>;
  /** 全量设置标签集合（不是增量追加）。 */
  setLabels(issueNumber: string, labels: readonly string[]): Promise<GitIssue>;
}

/** 评论操作。 */
export interface GitScopedCommentOperations {
  list(issueNumber: string, query?: GitListQuery): Promise<GitPage<GitComment>>;
  create(issueNumber: string, input: CreateCommentInput): Promise<GitComment>;
  edit(commentId: string, input: EditCommentInput): Promise<GitComment>;
}

/** 标签操作；删除标签暂不开放（方案 §5）。 */
export interface GitScopedLabelOperations {
  list(): Promise<readonly GitLabel[]>;
  create(input: CreateLabelInput): Promise<GitLabel>;
  edit(labelId: string, input: EditLabelInput): Promise<GitLabel>;
}

/**
 * 已绑定作用域的 Git 客户端。
 *
 * 所有方法失败时抛 {@link GitError}（`src/contracts/errors.ts`）；写操作的 `WRITE_UNCERTAIN` 语义
 * 见该文件。接入附件的下载流、公共事件的订阅/确认/重试在 T04 / T05 按同一形状扩展。
 */
export interface GitScopedClient {
  /** 受控消费者 ID（来自宿主调用侧，不接受请求正文覆盖）。 */
  readonly consumerId: string;
  /** 绑定所属组织；与调用方当前组织不一致时操作直接拒绝。 */
  readonly organizationId: string;
  readonly repository: RepositoryRef;
  readonly repositories: GitScopedRepositoryOperations;
  readonly issues: GitScopedIssueOperations;
  readonly comments: GitScopedCommentOperations;
  readonly labels: GitScopedLabelOperations;
}

/** 创建作用域客户端的输入；由宿主在服务端组装，值不来自请求正文。 */
export interface CreateGitScopedClientInput {
  readonly consumerId: string;
  readonly organizationId: string;
  /** 绑定记录 ID 或仓库引用；用绑定 ID 时由包内解析出仓库引用与凭据。 */
  readonly bindingId: string;
}

/** 仓库绑定投影（管理面）。 */
export interface GitRepositoryBindingView {
  readonly id: string;
  readonly organizationId: string;
  readonly connectionId: string;
  readonly repository: RepositoryRef;
  readonly allowedConsumers: Readonly<Record<string, readonly string[]>>;
  readonly status: string;
}

/** 绑定既有仓库的输入（管理操作；要求调用方已完成组织级授权校验）。 */
export interface BindExistingRepositoryInput {
  readonly organizationId: string;
  readonly connectionId: string;
  readonly providerRepositoryId: string;
  readonly owner: string;
  readonly name: string;
  /** 日常读写凭据引用（`{env:NAME}`），必须是 Git manifest 已声明的 secret 键。 */
  readonly credentialRef: string;
  readonly allowedConsumers: Readonly<Record<string, readonly string[]>>;
}

/**
 * 管理服务：初始化与绑定（由 `scripts/git-bootstrap.ts` 与宿主管理接口调用）。
 *
 * 它**不是**消费者接口：普通业务代码只拿 {@link GitScopedClient}。管理服务的调用方必须先完成自己的
 * 授权（例如组织管理员只能选择当前组织已经授权的连接和仓库），包内只做凭据引用合法性与上游存在性
 * 校验——不提供「任意 owner/repo 接管」的通道。
 */
export interface GitAdminService {
  /** 在连接下创建私有仓库（幂等：同名已存在时返回既有仓库，不接管所有权）。 */
  createPrivateRepository(
    connectionId: string,
    input: { owner: string; name: string; description?: string | null },
  ): Promise<GitRepository>;
  /** 读取连接下某个仓库的元数据；不存在时抛 `NOT_FOUND`。 */
  getRepository(connectionId: string, ref: Omit<RepositoryRef, "connectionId">): Promise<GitRepository>;
  /** 确保仓库 Issues 开启。 */
  ensureIssuesEnabled(connectionId: string, ref: Omit<RepositoryRef, "connectionId">): Promise<GitRepository>;
  /** 注册或更新仓库绑定（写入 `git_repository_bindings`）。 */
  bindExistingRepository(input: BindExistingRepositoryInput): Promise<GitRepositoryBindingView>;
  /** 读取绑定记录；未找到时抛 `NOT_FOUND`。 */
  getBinding(bindingId: string): Promise<GitRepositoryBindingView>;
}

/**
 * 公共 Git 模块实例（装配产物）。
 *
 * `createScopedClient` 是普通消费者的唯一入口：创建时解析绑定、核验组织归属与 consumer 授权，
 * 之后每次操作复用同一份作用域并重新校验（绑定暂停 / 权限收回立即生效）。
 */
export interface GitService {
  /** 当前装配的连接 ID 列表（供宿主做「连接是否已配置」的前置判断）。 */
  readonly connectionIds: readonly string[];
  createScopedClient(input: CreateGitScopedClientInput): Promise<GitScopedClient>;
  readonly admin: GitAdminService;
}
