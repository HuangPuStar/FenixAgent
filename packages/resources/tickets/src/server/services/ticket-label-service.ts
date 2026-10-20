/**
 * 项目标签领域服务：列表、新建、改名/改色/改描述（backend contract §7）。
 *
 * 两条边界（§7.1）：
 * - 标签的**事实源在托管平台**，本包不为标签建表：本地写入只有账本行，没有索引或归属行要刷；
 * - 标签 CRUD 是**管理员动作**，不要求 `expectedVersion`（上游没有版本字段），但仍要求幂等键——管理员
 *   双击提交不该在仓库里留下两个同名标签。
 *
 * 因此三条路径的收尾都比工单侧短：`succeed(step = upstream_applied)` 就是成功终态，失败时账本保持
 * `dispatching`，由恢复核对接 `intent` 回名字/颜色核对（§8.3 的 `label.create` / `label.update`）。
 */

import type { GitLabel, GitScopedClient, GitService } from "@fenix/git/server";
import type { AppError } from "@fenix/platform-sdk";
import { ConflictError, ForbiddenError, NotFoundError } from "@fenix/platform-sdk";
import { appErrorFromOperationResult, GitUnavailableError, toOperationFailureResult } from "../errors";
import { classifyGitFailure, type GitFailureKind } from "./git-failure";
import { connectTicketGitClient } from "./ticket-git-client";
import { RECOVERY_SINCE_SKEW_MS } from "./ticket-limits";
import type { TicketOperationAdmission, TicketOperationService } from "./ticket-operation-service";
import { TICKET_OPERATION_STEP } from "./ticket-operation-service";
import { hashTicketRequest, labelCreateTargetPath, labelUpdateTargetPath } from "./ticket-request-hash";
import { localWriteFailed, settleTicketWriteFailure } from "./ticket-write-failure";

/** 标签的领域事实（上游投影）；协议视图与它同形，Facade 只做字段搬运。 */
export interface TicketLabelFacts {
  readonly id: string;
  readonly name: string;
  readonly color: string | null;
  readonly description: string | null;
}

export type TicketLabelWriteOutcome =
  | { readonly kind: "written"; readonly operationId: string; readonly label: TicketLabelFacts }
  | { readonly kind: "uncertain"; readonly operationId: string };

export interface TicketLabelScope {
  readonly organizationId: string;
  readonly projectId: string;
  readonly bindingId: string;
}

export interface TicketLabelService {
  /** 仓库标签集合（不翻页：适配器已按 `Link` 头翻完）。 */
  listLabels(input: TicketLabelScope): Promise<readonly TicketLabelFacts[]>;
  createLabel(
    input: TicketLabelScope & {
      readonly actorId: string;
      readonly name: string;
      readonly color?: string;
      readonly description?: string;
      readonly idempotencyKey: string;
    },
  ): Promise<TicketLabelWriteOutcome>;
  updateLabel(
    input: TicketLabelScope & {
      readonly labelId: string;
      readonly actorId: string;
      readonly name?: string;
      readonly color?: string;
      readonly description?: string;
      readonly idempotencyKey: string;
    },
  ): Promise<TicketLabelWriteOutcome>;
}

export interface TicketLabelServiceDeps {
  readonly operations: TicketOperationService;
  readonly git: GitService;
}

export function createTicketLabelService(deps: TicketLabelServiceDeps): TicketLabelService {
  const { operations, git } = deps;

  function toLabelFacts(label: GitLabel): TicketLabelFacts {
    return { id: label.id, name: label.name, color: label.color, description: label.description };
  }

  /** 写失败的对外映射：`CONFLICT` 在标签路径上只可能是同名占用，与工单侧的「内容被他人变更」不同。 */
  function toLabelWriteError(
    failure: Extract<GitFailureKind, { kind: "definite" }>,
    action: "create" | "update",
  ): AppError {
    if (failure.code === "NOT_FOUND") {
      return new NotFoundError(action === "create" ? "项目仓库不存在" : "标签不存在或不属于该项目");
    }
    if (failure.code === "FORBIDDEN") return new ForbiddenError("当前凭据无权管理项目标签");
    if (failure.code === "RATE_LIMITED") {
      return new GitUnavailableError("托管平台限流，请稍后重试", "GIT_RATE_LIMITED");
    }
    if (failure.code === "CONFLICT") {
      return new ConflictError(action === "create" ? "同名标签已存在" : "标签名已被占用");
    }
    return new GitUnavailableError("托管平台不可用，请稍后重试");
  }

  /** 读标签集合：`NOT_FOUND` 是仓库不存在（404），其余上游故障一律 503。 */
  async function readLabels(client: GitScopedClient): Promise<readonly TicketLabelFacts[]> {
    try {
      return (await client.labels.list()).map(toLabelFacts);
    } catch (error) {
      const failure = classifyGitFailure(error);
      if (failure === undefined) throw error;
      if (failure.kind === "definite" && failure.code === "NOT_FOUND") throw new NotFoundError("项目仓库不存在");
      if (failure.kind === "definite" && failure.code === "RATE_LIMITED") {
        throw new GitUnavailableError("托管平台限流，请稍后重试", "GIT_RATE_LIMITED");
      }
      throw new GitUnavailableError("托管平台不可用，请稍后重试");
    }
  }

  /** 成功重放：标签字段已在成功终态的 `result` 里（无本地行可读，也不重放远端写入）。 */
  function replayLabel(admission: Extract<TicketOperationAdmission, { kind: "replayed" }>): TicketLabelFacts {
    const result = admission.result;
    const id = typeof result.labelId === "string" ? result.labelId : null;
    const name = typeof result.name === "string" ? result.name : null;
    if (id === null || name === null) throw new Error("标签操作已成功，但结果缺少标签字段");
    return {
      id,
      name,
      color: typeof result.color === "string" ? result.color : null,
      description: typeof result.description === "string" ? result.description : null,
    };
  }

  /** 领取与四种裁决（复用操作账本，不新建第二套幂等）；`label.*` 不进互斥组（§5.5）。 */
  async function beginLabel(input: {
    readonly organizationId: string;
    readonly projectId: string;
    readonly actorId: string;
    readonly kind: "label.create" | "label.update";
    readonly targetId: string | null;
    readonly idempotencyKey: string;
    readonly requestHash: string;
    readonly intent: Record<string, unknown>;
  }): Promise<
    | { readonly kind: "acquired"; readonly operationId: string }
    | { readonly kind: "replayed"; readonly operationId: string; readonly label: TicketLabelFacts }
    | { readonly kind: "uncertain"; readonly operationId: string }
  > {
    const admission = await operations.begin({
      organizationId: input.organizationId,
      actorId: input.actorId,
      kind: input.kind,
      projectId: input.projectId,
      targetId: input.targetId,
      idempotencyKey: input.idempotencyKey,
      requestHash: input.requestHash,
      messageId: null,
      expectedVersion: null,
      intent: input.intent,
      step: TICKET_OPERATION_STEP.dispatching,
    });
    if (admission.kind === "failed") throw appErrorFromOperationResult(admission.result);
    if (admission.kind === "in_flight") return { kind: "uncertain", operationId: admission.operationId };
    if (admission.kind === "replayed") {
      return { kind: "replayed", operationId: admission.operationId, label: replayLabel(admission) };
    }
    return { kind: "acquired", operationId: admission.operationId };
  }

  /** 两条标签写路径的共同骨架：取客户端 → 一次远端写（失败收敛）→ 成功终态（含 202 收敛）。 */
  async function runLabelWrite(input: {
    readonly operationId: string;
    readonly scope: TicketLabelScope;
    readonly action: "create" | "update";
    readonly write: (client: GitScopedClient) => Promise<GitLabel>;
  }): Promise<TicketLabelWriteOutcome> {
    let client: GitScopedClient;
    try {
      client = await connectTicketGitClient(git, input.scope);
    } catch (error) {
      // 绑定不可用是**确定**失败：写终态后抛出，同键重放还原同一个 503（与 T02 建工单同口径）。
      if (error instanceof GitUnavailableError) {
        await operations.fail({
          operationId: input.operationId,
          step: TICKET_OPERATION_STEP.upstreamFailed,
          result: toOperationFailureResult(error),
        });
      }
      throw error;
    }

    let written: TicketLabelFacts;
    try {
      written = toLabelFacts(await input.write(client));
    } catch (error) {
      await settleTicketWriteFailure({
        operations,
        operationId: input.operationId,
        error,
        toError: (failure) => toLabelWriteError(failure, input.action),
      });
      return { kind: "uncertain", operationId: input.operationId };
    }

    try {
      await operations.succeed({
        operationId: input.operationId,
        step: TICKET_OPERATION_STEP.upstreamApplied,
        targetId: written.id,
        // 标签没有本地行可补：成功终态就是账本自己，`result` 同时是重放要用的视图。
        result: { labelId: written.id, name: written.name, color: written.color, description: written.description },
        intentSummary: { name: written.name, color: written.color },
      });
    } catch (error) {
      return localWriteFailed({
        operationId: input.operationId,
        projectId: input.scope.projectId,
        targetId: written.id,
        targetKind: "label",
        error,
      });
    }
    return { kind: "written", operationId: input.operationId, label: written };
  }

  return {
    async listLabels(input) {
      return await readLabels(await connectTicketGitClient(git, input));
    },

    async createLabel(input) {
      const begun = await beginLabel({
        ...input,
        kind: "label.create",
        targetId: null,
        requestHash: hashTicketRequest({
          kind: "label.create",
          targetPath: labelCreateTargetPath(input.projectId),
          payload: { name: input.name, color: input.color, description: input.description },
        }),
        intent: {
          name: input.name,
          color: input.color,
          description: input.description,
          since: sinceForRecovery(),
        },
      });
      if (begun.kind === "replayed") return { kind: "written", operationId: begun.operationId, label: begun.label };
      if (begun.kind === "uncertain") return begun;
      return await runLabelWrite({
        operationId: begun.operationId,
        scope: input,
        action: "create",
        write: (client) =>
          client.labels.create({ name: input.name, color: input.color, description: input.description }),
      });
    },

    async updateLabel(input) {
      const client = await connectTicketGitClient(git, input);
      // 准入前读一次集合：标签不存在 → 404 且不产生账本行；`before` 同时是恢复核对的「未落库」判据（§8.3）。
      const before = (await readLabels(client)).find((label) => label.id === input.labelId);
      if (before === undefined) throw new NotFoundError("标签不存在或不属于该项目");

      const begun = await beginLabel({
        ...input,
        kind: "label.update",
        targetId: input.labelId,
        requestHash: hashTicketRequest({
          kind: "label.update",
          targetPath: labelUpdateTargetPath(input.projectId, input.labelId),
          payload: { name: input.name, color: input.color, description: input.description },
        }),
        intent: {
          name: input.name,
          color: input.color,
          description: input.description,
          before: { name: before.name, color: before.color, description: before.description },
          since: sinceForRecovery(),
        },
      });
      if (begun.kind === "replayed") return { kind: "written", operationId: begun.operationId, label: begun.label };
      if (begun.kind === "uncertain") return begun;
      return await runLabelWrite({
        operationId: begun.operationId,
        scope: input,
        action: "update",
        write: (writeClient) =>
          writeClient.labels.edit(input.labelId, {
            name: input.name,
            color: input.color,
            description: input.description,
          }),
      });
    },
  };
}

/** `intent.since`：领取时刻回拨一分钟，把恢复扫描收窄到本次操作附近（不进请求指纹，§5.1）。 */
function sinceForRecovery(): string {
  return new Date(Date.now() - RECOVERY_SINCE_SKEW_MS).toISOString();
}
