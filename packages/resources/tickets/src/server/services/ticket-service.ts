/**
 * 工单领域服务：创建、列表、详情（回源）。
 *
 * 分层口径：不接收 `ActorContext`，只收 Facade 已授权后传下来的显式范围（`organizationId` / `projectId` /
 * `actorId`）；**不**判断「谁能读这个项目」——那是 Facade 的事。本文件只处理工单自身的规则：幂等、身份头、
 * 作者归属核验、内容指纹、索引写入。
 *
 * 三条不可动摇的顺序：
 * 1. **先声明幂等再出站**（`ticket-operation-service.begin`）：远端写入必须在账本里已有 `pending` 行，
 *    否则崩溃会留下「远端有工单、本端一无所知」的孤儿；`message_id` 也在这一步生成并落库，重试不会换 id。
 * 2. **成功终态与索引/归属写入同一事务**：`ticket_messages`（作者归属证据）、`ticket_index`（列表数据源）、
 *    `markSucceeded` 三者要么全成要么全不成。这一步失败时**不**回滚成 `failed`：远端对象已经存在，重试同键
 *    会看到 `dispatching` → 202，由 T03 按 `message_id` 回源核对补齐（§8.3 步骤 8，绝不二次创建）。
 * 3. **作者只取凭据主体**：请求体里没有任何身份字段，`actorId` 由 Facade 从可信主体传入；远端返回的头部自填
 *    作者一律不采信（`resolveTicketAuthor` 只在归属记录与正文摘要同时吻合时才认 AOS 作者）。
 *
 * 列表只读 `ticket_index`（不回源、不逐行核验，决策 D3 与性能门槛），因此列表行的作者来源由写入路径的
 * 核验背书：`author_id` 只由本模块的写入路径与 T04 的同步（同样经核验）写入。
 */

import { randomUUID } from "node:crypto";
import type { GitIssue, GitScopedClient, GitService } from "@fenix/git/server";
import { ConflictError, ForbiddenError, NotFoundError } from "@fenix/platform-sdk";
import { runInTransaction } from "@fenix/platform-sdk/server";
import { appErrorFromOperationResult, GitUnavailableError, toOperationFailureResult } from "../errors";
import type { TicketIndexRepository, TicketIndexRow } from "../repositories/ticket-index";
import type { TicketMessageRepository } from "../repositories/ticket-messages";
import { computeContentVersion } from "./content-version";
import { classifyGitFailure } from "./git-failure";
import { buildTicketBody, hashBody, parseTicketBody } from "./identity-header";
import { type AuthorResolution, resolveTicketAuthor } from "./ticket-author";
import {
  TICKET_OPERATION_STEP,
  type TicketOperationAdmission,
  type TicketOperationService,
} from "./ticket-operation-service";
import { hashTicketRequest, issueCreateTargetPath } from "./ticket-request-hash";

/** 工单模块在 Git 绑定里的消费者 ID（与开通路径写入 `allowedConsumers` 的键一致）。 */
const TICKET_CONSUMER_ID = "tickets";

/** 标签投影（详情来自远端，列表来自索引的 ID 集合）。 */
export interface TicketIssueLabel {
  readonly id: string;
  readonly name: string;
  readonly color: string | null;
}

/**
 * 工单的领域事实：视图组装（协议 DTO、身份展示名）在 Facade 层，本层交出的只是已经过核验的内容。
 */
export interface TicketIssueFacts {
  readonly issueNumber: string;
  readonly title: string;
  readonly state: "open" | "closed";
  readonly labels: readonly TicketIssueLabel[];
  /** 已剥离身份头与 YAML 头的用户正文（前端不渲染协议头）。 */
  readonly body: string;
  readonly version: string;
  readonly providerUpdatedAt: string | null;
  /** 本端最后一次看到这条工单的时间（ISO）。 */
  readonly syncedAt: string;
  readonly syncStatus: "ready" | "stale";
  readonly author: AuthorResolution;
  /** AOS 侧负责人；T02 恒为 null（指派归 T03）。 */
  readonly assigneeId: string | null;
  /** 无法映射到 AOS 主体时的负责人展示名（远端账号）；`assigneeId` 非空时为 null。 */
  readonly assigneeNameSnapshot: string | null;
}

export interface TicketListInput {
  readonly projectId: string;
  readonly limit: number;
  readonly cursor?: string;
  readonly q?: string;
  readonly state?: "open" | "closed" | "all";
  readonly assigneeId?: string;
  readonly labelId?: string;
}

/** 列表结果：`items` 是索引行（组装成视图归 Facade），`nextCursor` 的表达口径见 `listPage`。 */
export interface TicketListResult {
  readonly items: readonly TicketIndexRow[];
  readonly nextCursor: string | null;
}

export interface TicketCreateIssueInput {
  readonly organizationId: string;
  readonly projectId: string;
  /** 仓库绑定 ID（`ticket_projects.repository_ref`）。 */
  readonly bindingId: string;
  readonly actorId: string;
  /** 显示名快照：来自身份目录，写进 `ticket_messages.author_name_snapshot` 与身份头。 */
  readonly authorName: string;
  readonly title: string;
  readonly body: string;
  readonly idempotencyKey: string;
}

export type TicketCreateIssueOutcome =
  | { readonly kind: "created"; readonly operationId: string; readonly facts: TicketIssueFacts }
  | { readonly kind: "uncertain"; readonly operationId: string };

export interface TicketService {
  listPage(input: TicketListInput): Promise<TicketListResult>;
  /** 详情：回源读取远端正文并按 §7.3 核验作者；上游不可用时报 503，绝不返回空内容。 */
  getIssue(input: {
    readonly organizationId: string;
    readonly projectId: string;
    readonly bindingId: string;
    readonly issueNumber: string;
  }): Promise<TicketIssueFacts>;
  createIssue(input: TicketCreateIssueInput): Promise<TicketCreateIssueOutcome>;
}

export interface TicketServiceDeps {
  readonly messages: TicketMessageRepository;
  readonly index: TicketIndexRepository;
  readonly operations: TicketOperationService;
  readonly git: GitService;
}

/** 详情路径的最小入参：项目行已由 Facade 取到，这里只取需要的三列。 */
export interface TicketIssueScope {
  readonly organizationId: string;
  readonly projectId: string;
  readonly bindingId: string;
}

export function createTicketService(deps: TicketServiceDeps): TicketService {
  const { messages, index, operations, git } = deps;

  /** 绑定不可用一律是装配/数据故障（§8.3 步骤 5），报 503 而不是伪装成「工单不存在」。 */
  function toBindingError(error: unknown): Error {
    const failure = classifyGitFailure(error);
    if (failure === undefined) return error instanceof Error ? error : new Error(String(error));
    if (failure.kind === "definite" && failure.code === "RATE_LIMITED") {
      return new GitUnavailableError("托管平台限流，请稍后重试", "GIT_RATE_LIMITED");
    }
    return new GitUnavailableError("仓库绑定不可用：绑定已暂停或应用授权已被收回");
  }

  async function connect(scope: TicketIssueScope): Promise<GitScopedClient> {
    try {
      return await git.createScopedClient({
        consumerId: TICKET_CONSUMER_ID,
        organizationId: scope.organizationId,
        bindingId: scope.bindingId,
      });
    } catch (error) {
      throw toBindingError(error);
    }
  }

  /** 详情：远端读取失败按「确定失败」映射，读路径不产生账本记录。 */
  function toIssueReadError(error: unknown): Error {
    const failure = classifyGitFailure(error);
    if (failure === undefined) return error instanceof Error ? error : new Error(String(error));
    if (failure.kind === "uncertain") return new GitUnavailableError("托管平台响应异常，请稍后重试");
    switch (failure.code) {
      case "NOT_FOUND":
        return new NotFoundError("工单不存在");
      case "RATE_LIMITED":
        return new GitUnavailableError("托管平台限流，请稍后重试", "GIT_RATE_LIMITED");
      default:
        return new GitUnavailableError("托管平台不可用，请稍后重试");
    }
  }

  /** 索引行 → 领域事实的公共部分；`syncedAt`/`syncStatus` 在缺行时退化为「本次回源」与 `stale`。 */
  function indexFreshness(row: TicketIndexRow | undefined): {
    readonly syncedAt: string;
    readonly syncStatus: "ready" | "stale";
  } {
    if (row === undefined) return { syncedAt: new Date().toISOString(), syncStatus: "stale" };
    return { syncedAt: row.syncedAt.toISOString(), syncStatus: row.syncStatus === "stale" ? "stale" : "ready" };
  }

  return {
    /**
     * 列表：授权与筛选条件全部下推到索引查询（Facade 已传 projectId），这里只做游标换算。
     *
     * `nextCursor` 的口径是「取满一页就认为还有下一页」（§9.1）：索引不额外数一次总数，代价是最后一页
     * 恰好取满时会多出一次空查询——比每页多一次 count 便宜，且前端只关心「有没有下一页」。
     */
    async listPage(input) {
      const rows = await index.listPage({
        projectId: input.projectId,
        limit: input.limit,
        ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
        ...(input.q === undefined ? {} : { q: input.q }),
        ...(input.state === undefined ? {} : { state: input.state }),
        ...(input.assigneeId === undefined ? {} : { assigneeId: input.assigneeId }),
        ...(input.labelId === undefined ? {} : { labelId: input.labelId }),
      });
      const last = rows.at(-1);
      const nextCursor = rows.length === input.limit && last !== undefined ? last.issueNumber : null;
      return { items: rows, nextCursor };
    },

    async getIssue(input) {
      const scope: TicketIssueScope = {
        organizationId: input.organizationId,
        projectId: input.projectId,
        bindingId: input.bindingId,
      };
      const client = await connect(scope);
      let issue: GitIssue;
      try {
        issue = await client.issues.get(input.issueNumber);
      } catch (error) {
        throw toIssueReadError(error);
      }

      // 作者核验只发生在详情路径（决策 D3）：列表读索引，这里才回源比对身份头、归属记录与正文摘要。
      const message = await messages.findObjectMessage({
        projectId: input.projectId,
        objectKind: "issue",
        providerObjectId: input.issueNumber,
      });
      const author = resolveTicketAuthor({
        organizationId: input.organizationId,
        providerObjectId: input.issueNumber,
        rawBody: issue.body,
        fallbackActor: issue.author,
        message,
      });
      const parsed = parseTicketBody(issue.body);
      const indexRow = await index.findByIssueNumber({ projectId: input.projectId, issueNumber: input.issueNumber });
      const freshness = indexFreshness(indexRow);

      return {
        issueNumber: issue.number,
        title: issue.title,
        state: issue.state,
        labels: issue.labels.map((label) => ({ id: label.id, name: label.name, color: label.color })),
        body: parsed.body,
        version: computeContentVersion({
          title: issue.title,
          body: parsed.body,
          state: issue.state,
          labelNames: issue.labels.map((label) => label.name),
        }),
        providerUpdatedAt: issue.providerUpdatedAt,
        ...freshness,
        author,
        // 负责人由远端账号投影：索引里没有 AOS 负责人（T02 不指派）时标为外部来源，不做错误映射。
        assigneeId: indexRow?.assigneeId ?? null,
        assigneeNameSnapshot:
          indexRow?.assigneeId === undefined || indexRow.assigneeId === null ? (issue.assignee?.name ?? null) : null,
      };
    },

    async createIssue(input) {
      // 幂等声明（§8.2 步骤 1）：message_id 与待发送正文一并落库，崩溃重试沿用同一个 id。
      const generatedMessageId = `msg_${randomUUID()}`;
      const admission = await operations.begin({
        organizationId: input.organizationId,
        actorId: input.actorId,
        kind: "issue.create",
        projectId: input.projectId,
        idempotencyKey: input.idempotencyKey,
        requestHash: hashTicketRequest({
          kind: "issue.create",
          targetPath: issueCreateTargetPath(input.projectId),
          payload: { title: input.title, body: input.body },
        }),
        messageId: generatedMessageId,
        expectedVersion: null,
        intent: { title: input.title, body: input.body },
        step: TICKET_OPERATION_STEP.dispatching,
      });

      if (admission.kind === "failed") throw appErrorFromOperationResult(admission.result);
      if (admission.kind === "in_flight") return { kind: "uncertain", operationId: admission.operationId };
      if (admission.kind === "replayed") return await replayCreatedIssue(input, admission);

      const operationId = admission.operationId;
      // 既有 `pending` 行保留的是上一执行者写入的 message_id：必须沿用它，否则远端正文里的身份头与本端
      // 账本对不上，T03 的回源核对会查不到这条操作。
      const messageId = admission.messageId ?? generatedMessageId;

      let client: GitScopedClient;
      try {
        client = await connect({
          organizationId: input.organizationId,
          projectId: input.projectId,
          bindingId: input.bindingId,
        });
      } catch (error) {
        // 绑定不可用（§8.3 步骤 5）是**确定**失败：写终态后抛出，同键重放还原同一个 503。
        // 非 Git 故障（装配期编程错误、本地 DB 故障）不写状态：保持 `dispatching` 交给 T03 核对，
        // 绝不把一次偶发故障固化成「这个幂等键永远失败」。
        if (error instanceof GitUnavailableError) {
          await operations.fail({
            operationId,
            step: TICKET_OPERATION_STEP.upstreamFailed,
            result: toOperationFailureResult(error),
          });
        }
        throw error;
      }

      const header = {
        schema: 1 as const,
        organizationId: input.organizationId,
        messageId,
        author: { id: input.actorId, name: input.authorName },
      };
      let issue: GitIssue;
      try {
        issue = await client.issues.create({ title: input.title, body: buildTicketBody({ header, body: input.body }) });
      } catch (error) {
        return await handleCreateFailure(operationId, error);
      }

      const parsed = parseTicketBody(issue.body);
      const bodyHash = hashBody(parsed.body);
      const version = computeContentVersion({
        title: issue.title,
        body: parsed.body,
        state: issue.state,
        labelNames: issue.labels.map((label) => label.name),
      });

      // 成功终态与索引/归属写入同一事务：三者任一失败都整体回滚，操作保持 dispatching 交给 T03 核对。
      const indexRow = await runInTransaction(async () => {
        await messages.insert({
          projectId: input.projectId,
          objectKind: "issue",
          providerObjectId: issue.number,
          messageId,
          authorId: input.actorId,
          authorNameSnapshot: input.authorName,
          bodyHash,
          revision: 1,
        });
        const row = await index.upsertIssue({
          projectId: input.projectId,
          issueNumber: issue.number,
          title: issue.title,
          state: issue.state,
          authorId: input.actorId,
          authorName: input.authorName,
          assigneeId: null,
          labelIds: issue.labels.map((label) => label.id),
          contentVersion: version,
          providerUpdatedAt: issue.providerUpdatedAt === null ? null : new Date(issue.providerUpdatedAt),
          syncStatus: "ready",
        });
        await operations.succeed({
          operationId,
          step: TICKET_OPERATION_STEP.indexWritten,
          targetId: issue.number,
          result: { issueNumber: issue.number, messageId, version },
          // 正文原文在成功这一刻从账本消失，只留可复核的摘要（§8.2）。
          intentSummary: { titleLength: input.title.length, bodyHash },
        });
        return row;
      });

      return {
        kind: "created",
        operationId,
        facts: {
          issueNumber: issue.number,
          title: issue.title,
          state: issue.state,
          labels: issue.labels.map((label) => ({ id: label.id, name: label.name, color: label.color })),
          // 正文取自远端回显：与后续读路径看到的是同一份字节，避免「写入时返回的正文」与「再读一次」不一致。
          body: parsed.body,
          version,
          providerUpdatedAt: issue.providerUpdatedAt,
          syncedAt: indexRow.syncedAt.toISOString(),
          syncStatus: indexRow.syncStatus === "stale" ? "stale" : "ready",
          author: { source: "aos", authorId: input.actorId, authorName: input.authorName, messageId },
          assigneeId: null,
          assigneeNameSnapshot: issue.assignee?.name ?? null,
        },
      };
    },
  };

  /**
   * 重放已成功的创建：不再触碰远端（§8.2），用索引行 + 账本里存的坐标还原同一份结果。
   *
   * 正文取**本次请求的正文**：幂等指纹保证它与首次请求逐字相同（否则会在 `begin` 里报 409）。
   */
  async function replayCreatedIssue(
    input: TicketCreateIssueInput,
    admission: Extract<TicketOperationAdmission, { kind: "replayed" }>,
  ): Promise<TicketCreateIssueOutcome> {
    const issueNumber = typeof admission.result.issueNumber === "string" ? admission.result.issueNumber : undefined;
    const version = typeof admission.result.version === "string" ? admission.result.version : undefined;
    if (issueNumber === undefined || version === undefined) {
      // 成功终态的结果由本模块写入，缺字段只可能是人工改库：报不变量违反，不猜一个工单号返回。
      throw new Error("工单创建操作已成功，但结果缺少工单坐标");
    }
    const indexRow = await index.findByIssueNumber({ projectId: input.projectId, issueNumber });
    const message = await messages.findObjectMessage({
      projectId: input.projectId,
      objectKind: "issue",
      providerObjectId: issueNumber,
    });
    if (indexRow === undefined || message === undefined) {
      // 索引与归属行都和成功终态同事务提交，缺任何一条都说明账本与数据不一致，交运维排查而不是重放写入。
      throw new Error("工单创建操作已成功，但索引行或作者归属记录缺失（账本与数据不一致）");
    }
    const freshness = indexFreshness(indexRow);
    return {
      kind: "created",
      operationId: admission.operationId,
      facts: {
        issueNumber,
        title: indexRow.title,
        state: indexRow.state === "closed" ? "closed" : "open",
        // 索引只存标签 ID：名称与颜色要回源才有，列表路径不为此发起外部调用（T04 的同步负责补齐展示信息）。
        labels: indexRow.labelIds.map((labelId) => ({ id: labelId, name: labelId, color: null })),
        body: input.body,
        version,
        providerUpdatedAt: indexRow.providerUpdatedAt?.toISOString() ?? null,
        ...freshness,
        author: {
          source: "aos",
          authorId: message.authorId,
          authorName: message.authorNameSnapshot,
          messageId: message.messageId,
        },
        assigneeId: indexRow.assigneeId,
        // 重放路径不回源，索引里也没有外部负责人名（T02 不指派）：宁可 `null` 也不拿作者名冒充负责人。
        assigneeNameSnapshot: null,
      },
    };
  }

  /**
   * 创建失败的三分收敛（§8.3 步骤 6）：`WRITE_UNCERTAIN` → 202；上游确定拒绝 → 写 failed 并抛出；
   * 其余异常保持 `dispatching` 上抛，交给 T03 按 `message_id` 回源核对，绝不二次创建。
   */
  async function handleCreateFailure(operationId: string, error: unknown): Promise<TicketCreateIssueOutcome> {
    const failure = classifyGitFailure(error);
    if (failure === undefined) throw error;
    if (failure.kind === "uncertain") {
      await operations.markUncertain({ operationId, step: TICKET_OPERATION_STEP.dispatching });
      return { kind: "uncertain", operationId };
    }
    const mapped = toIssueWriteError(failure);
    await operations.fail({
      operationId,
      step: TICKET_OPERATION_STEP.upstreamFailed,
      result: toOperationFailureResult(mapped),
    });
    throw mapped;
  }

  /**
   * 写工单失败的对外映射（§8.3 步骤 6）：上游对 `issues.create` 的确定拒绝各自对应一个状态码。
   *
   * 这里与 `toBindingError`（步骤 5 的 `createScopedClient` 失败）是两处不同的映射，虽然 Git 错误码同源：
   * 绑定拿不到是**装配/数据故障**（503，本端的问题）；`issues.create` 报 `FORBIDDEN` 则是仓库层面的明确
   * 拒绝（403，调用方或运维要处理的事实）。把两者合并会要么把权限问题伪装成故障，要么反过来。
   */
  function toIssueWriteError(
    failure: Extract<ReturnType<typeof classifyGitFailure>, { kind: "definite" }>,
  ): GitUnavailableError | NotFoundError | ForbiddenError | ConflictError {
    switch (failure.code) {
      case "NOT_FOUND":
        return new NotFoundError("仓库或工单不存在");
      case "FORBIDDEN":
        return new ForbiddenError("当前凭据无权在该仓库写入");
      case "CONFLICT":
        return new ConflictError("上游拒绝了本次写入：目标仓库状态冲突");
      case "RATE_LIMITED":
        return new GitUnavailableError("托管平台限流，请稍后重试", "GIT_RATE_LIMITED");
      default:
        // UNAVAILABLE / INVALID_RESPONSE：上游可达性与响应形态问题，重试由用户按幂等键发起。
        return new GitUnavailableError("托管平台不可用，请稍后重试");
    }
  }
}
