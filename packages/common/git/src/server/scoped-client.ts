/**
 * 作用域客户端的组装：把「绑定记录 + 连接 + 已解析凭据 + 适配器」收敛成 {@link GitScopedClient}，并在
 * **每次**调用前重新检查本进程持有的绑定快照。
 *
 * 为什么每次都要检查：绑定状态与授权集合是运维/管理面随时可改的对象，而消费者拿到的客户端可能长期存活
 * （工单模块按请求复用、事件消费循环常驻）。只在创建时判定，等于把「暂停绑定」「收回授权」变成需要重启才
 * 生效的动作。复查用的是本进程内存里的快照，不重新查库：绑定只在创建作用域客户端时读一次，跨进程的撤销
 * 由事件同步与验证环节覆盖；包内再加一层缓存只会制造两份互相不一致的授权视图。
 *
 * 拒绝一律用 `FORBIDDEN`：「你无权做这件事」与「这个对象不存在」对调用方是不同的结论，混用会让人误以为
 * 换个参数就能成功。
 */

import { createLogger } from "@fenix/logger";
import type { GitScopedClient } from "../contracts/client";
import { GitError } from "../contracts/errors";
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
} from "../contracts/types";
import type { ForgejoClient } from "../forgejo/client";
import type { GitConnectionConfig } from "./config";
import type { GitBindingRecord } from "./repositories/bindings";

const logger = createLogger("git");

/**
 * 受控操作名：绑定记录 `allowedConsumers` 的值域。
 *
 * 这些字符串是**持久化契约**（写在 `git_repository_bindings.allowed_consumers` 里）：改名不会报错，只会让
 * 已存量的授权静默失效——所有调用突然变成 FORBIDDEN。因此只能追加新操作名，不得重命名既有名字。
 */
const OPERATIONS = {
  repositoriesRead: "repositories.read",
  issuesRead: "issues.read",
  issuesWrite: "issues.write",
  commentsRead: "comments.read",
  commentsWrite: "comments.write",
  labelsRead: "labels.read",
  labelsWrite: "labels.write",
} as const;

/** 创建作用域客户端的输入；全部字段由服务端装配链提供，值不来自请求正文。 */
export interface CreateScopedClientFromBindingInput {
  /** 已解析的绑定快照；归属与 consumer 授权的创建期判定由 `bindings-service` 完成。 */
  readonly binding: GitBindingRecord;
  /** 绑定的连接配置；本函数只用它核对连接标识（请求地址由已构造好的 `client` 持有）。 */
  readonly connection: GitConnectionConfig;
  readonly consumerId: string;
  /**
   * 已解析的日常凭据值（由调用方按 `binding.credentialRef` 解析）。
   *
   * 本函数不经手它：出站请求一律走 `client`（调用方已用同一凭据构造）。字段按实施合同的输入形状保留，
   * 让装配链上「解析出的凭据」与「用它的客户端」显式成对出现。
   */
  readonly serviceToken: string;
  /** 用日常凭据构造的适配器实例；同一绑定共享一个实例（并发闸随实例生效）。 */
  readonly client: ForgejoClient;
}

/**
 * 组装已绑定作用域的客户端。
 *
 * @throws GitError `FORBIDDEN` consumer 未获授权；`Error` 连接与绑定错配（装配 bug）
 */
export function createScopedClientFromBinding(input: CreateScopedClientFromBindingInput): GitScopedClient {
  const { binding, consumerId, client } = input;

  // 连接与绑定错配只可能来自装配 bug（读取路径按 binding.connectionId 取连接）。放任它会让请求打到另一个
  // Forgejo 实例上的同名仓库——一条静默的跨实例改写，宁可当场失败。
  if (input.connection.id !== binding.connectionId) {
    throw new Error(
      `公共 Git 装配错误：绑定 ${binding.id} 属于连接 ${binding.connectionId}，与传入的连接 ${input.connection.id} 不一致`,
    );
  }

  // 创建期先拒绝一次：交回一个「每次调用都必然失败」的客户端，只会把配置错误推迟到业务路径上。
  const grant = binding.allowedConsumers[consumerId];
  if (grant === undefined || grant.length === 0) {
    throw denial(binding, consumerId, "create", `消费者 ${consumerId} 未获授权访问仓库绑定 ${binding.id}`);
  }

  const repository: RepositoryRef = {
    connectionId: binding.connectionId,
    providerRepositoryId: binding.providerRepositoryId,
    owner: binding.owner,
    name: binding.name,
  };
  const guard = (operation: string): void => requireOperation(binding, consumerId, operation);

  return {
    consumerId,
    organizationId: binding.organizationId,
    repository,
    repositories: {
      async get(): Promise<GitRepository> {
        guard(OPERATIONS.repositoriesRead);
        return client.getRepository(repository);
      },
      async ensureIssuesEnabled(): Promise<GitRepository> {
        // 开启 Issues 是仓库级写动作，归 `issues.write`（不是 `repositories.read`）：只读消费者不得借此改仓库。
        guard(OPERATIONS.issuesWrite);
        return client.setRepositoryIssuesEnabled(repository);
      },
    },
    issues: {
      async list(query?: GitIssueListQuery): Promise<GitPage<GitIssue>> {
        guard(OPERATIONS.issuesRead);
        return client.listIssues(repository, query ?? {});
      },
      async get(issueNumber: string): Promise<GitIssue> {
        guard(OPERATIONS.issuesRead);
        return client.getIssue(repository, issueNumber);
      },
      async create(issueInput: CreateIssueInput): Promise<GitIssue> {
        guard(OPERATIONS.issuesWrite);
        return client.createIssue(repository, issueInput);
      },
      async edit(issueNumber: string, issueInput: EditIssueInput): Promise<GitIssue> {
        guard(OPERATIONS.issuesWrite);
        return client.editIssue(repository, issueNumber, issueInput);
      },
      async setLabels(issueNumber: string, labels: readonly string[]): Promise<GitIssue> {
        guard(OPERATIONS.issuesWrite);
        // `PUT .../labels` 只返回标签集合，而本方法必须给出完整的工单投影，因此回读一次。回读是这次写操作的
        // 收尾，不额外要求 `issues.read`——否则只写消费者永远拿不到合法的返回值。
        await client.setIssueLabels(repository, issueNumber, labels);
        return client.getIssue(repository, issueNumber);
      },
    },
    comments: {
      async list(issueNumber: string, query?: GitListQuery): Promise<GitPage<GitComment>> {
        guard(OPERATIONS.commentsRead);
        return client.listComments(repository, issueNumber, query ?? {});
      },
      async create(issueNumber: string, commentInput: CreateCommentInput): Promise<GitComment> {
        guard(OPERATIONS.commentsWrite);
        return client.createComment(repository, issueNumber, commentInput.body);
      },
      async edit(commentId: string, commentInput: EditCommentInput): Promise<GitComment> {
        guard(OPERATIONS.commentsWrite);
        return client.editComment(repository, commentId, commentInput.body);
      },
    },
    labels: {
      async list(): Promise<readonly GitLabel[]> {
        guard(OPERATIONS.labelsRead);
        return client.listLabels(repository);
      },
      async create(labelInput: CreateLabelInput): Promise<GitLabel> {
        guard(OPERATIONS.labelsWrite);
        return client.createLabel(repository, labelInput);
      },
      async edit(labelId: string, labelInput: EditLabelInput): Promise<GitLabel> {
        guard(OPERATIONS.labelsWrite);
        return client.editLabel(repository, labelId, labelInput);
      },
    },
  };
}

/**
 * 每次操作前的授权判定（读的都是本进程持有的绑定快照，不查库）。
 *
 * 顺序刻意固定：先看绑定是否被暂停，再看消费者是否还持有授权。暂停是运维对**整条绑定**的决定，它比
 * 「某个 consumer 少了某个操作」更根本，先报暂停能让排障直接落到正确的层级。
 */
function requireOperation(binding: GitBindingRecord, consumerId: string, operation: string): void {
  if (binding.status !== "active") {
    throw denial(binding, consumerId, operation, `仓库绑定 ${binding.id} 处于 ${binding.status} 状态，已停止读写`);
  }
  const allowed = binding.allowedConsumers[consumerId];
  if (allowed === undefined || allowed.length === 0) {
    throw denial(binding, consumerId, operation, `消费者 ${consumerId} 未获授权访问仓库绑定 ${binding.id}`);
  }
  if (!allowed.includes(operation)) {
    throw denial(binding, consumerId, operation, `消费者 ${consumerId} 无权执行 ${operation}`);
  }
}

/**
 * 构造拒绝错误并留痕。
 *
 * 授权拒绝是安全事件：没有日志时，线上只会表现为「某功能时好时坏」，运维无法区分「消费者没配权限」与
 * 「绑定被暂停」。日志只带非敏感关联字段（绑定、连接、仓库坐标、consumerId、操作名），不含凭据。
 */
function denial(binding: GitBindingRecord, consumerId: string, operation: string, reason: string): GitError {
  logger.warn("git.scoped.operation_denied", {
    bindingId: binding.id,
    organizationId: binding.organizationId,
    connectionId: binding.connectionId,
    repositoryRef: `${binding.owner}/${binding.name}`,
    consumerId,
    operation,
    reason,
  });
  return new GitError("FORBIDDEN", reason);
}
