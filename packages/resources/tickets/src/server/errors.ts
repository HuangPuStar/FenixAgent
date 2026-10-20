/**
 * 工单模块的对外错误类与「账本结果 → 错误」的还原入口。
 *
 * 为什么必须派生平台的 `AppError`：宿主错误处理器按 `instanceof AppError` 映射 HTTP 状态，自建同名类
 * 会让 403/409/503 静默退化成 500（`platform-sdk/src/protocol/errors.ts` 的文件头已记录该故障模式）。
 * 因此这里只放**跨边界**的错误：Facade 抛它们、路由按 `code`/`statusCode` 映射信封；模块内部的可恢复
 * 失败（例如某次读不到索引行）仍用普通 `Error`，不为了复用状态码而包装成本类。
 *
 * 错误消息是给人看的描述，不是契约：`code` 才是调用方分支依据。消息里**不得**出现 token、凭据引用值或
 * 请求正文（§12.6）——本文件的所有默认消息因此只描述状态本身。
 *
 * 与幂等账本的关系：明确失败会被持久化（`ticket_operations.status = "failed"`），同一幂等键再次到达时
 * 必须还原成**同一个**对外错误而不是重试。`appErrorFromOperationResult` / `toOperationFailureResult`
 * 是这一对映射的唯一实现处，读写的字段名必须同时改。
 */

import { AppError, ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@fenix/platform-sdk";

/** 工单写路径被组织级暂停拦下（项目 `status = "paused"`）：读仍可用，写一律 503。 */
export class TicketsPausedError extends AppError {
  constructor(message = "工单已暂停：当前组织暂停了工单写入") {
    super(message, "TICKETS_PAUSED", 503);
    this.name = "TicketsPausedError";
  }
}

/** 上游 Git 不可用或限流（读路径与明确失败的写路径）。 */
export class GitUnavailableError extends AppError {
  constructor(message: string, code: "GIT_UNAVAILABLE" | "GIT_RATE_LIMITED" = "GIT_UNAVAILABLE") {
    super(message, code, 503);
    this.name = "GitUnavailableError";
  }
}

/** 同一个 `Idempotency-Key` 被用于**不同**请求内容：既有操作不能被覆盖，也不能当作重放。 */
export class IdempotencyConflictError extends AppError {
  constructor(message = "同一个 Idempotency-Key 已用于不同的请求内容") {
    super(message, "IDEMPOTENCY_CONFLICT", 409);
    this.name = "IdempotencyConflictError";
  }
}

/** 内容版本冲突：T02 只落地错误类与状态映射，真正的判定点在 T03 的编辑/评论路径（§8.4/§8.6）。 */
export class VersionConflictError extends AppError {
  constructor(message = "内容已被他人修改，请重新读取后再提交") {
    super(message, "VERSION_CONFLICT", 409);
    this.name = "VersionConflictError";
  }
}

/**
 * 同一对象上还有未确认的变更：拒绝后续修改，等前一次核对完成（方案 §9.7 / 裁定二.9）。
 *
 * 错误码取裁定三.15 的 `TICKET_OPERATION_PENDING`——前端「待确认」的兜底分支只认这个码，写路径必须给出
 * 同一个码才能把它转成「先去核对」而不是普通冲突。类名沿用 backend contract §5.4 的
 * `TicketChangeInFlightError`；同一条规则**只产出一个码**，合同 §1.4 里的 `TICKET_CHANGE_IN_FLIGHT`
 * 仅作为重放还原表的同义键存在（见文件末的还原表），避免前端要同时认两个码。
 */
export class TicketChangeInFlightError extends AppError {
  constructor(message = "该工单还有一次未确认的变更，确认完成后才能继续修改") {
    super(message, "TICKET_OPERATION_PENDING", 409);
    this.name = "TicketChangeInFlightError";
  }
}

/**
 * 恢复核对确认远端没有落库：该次修改可安全重提（换个幂等键）。
 *
 * 只出现在重放路径：`failed` 行的结果被还原成同一个错误，让同键重试拿到与首次一致的答复。
 */
export class TicketWriteNotAppliedError extends AppError {
  constructor(message = "该修改未在托管平台生效，请重新提交") {
    super(message, "WRITE_NOT_APPLIED", 409);
    this.name = "TicketWriteNotAppliedError";
  }
}

/** 负责人不是当前组织的成员（含已离职）：指派前必须现查成员关系，绝不按请求体自填的 id 落库。 */
export class AssigneeNotMemberError extends AppError {
  constructor(message = "负责人必须是当前组织的有效成员") {
    super(message, "ASSIGNEE_NOT_MEMBER", 400);
    this.name = "AssigneeNotMemberError";
  }
}

/** 标签不在该仓库的标签集合内：拒绝而不是静默丢弃，否则用户会以为标签挂上了。 */
export class UnknownLabelError extends AppError {
  constructor(message = "标签不存在或不属于该项目") {
    super(message, "LABEL_UNKNOWN", 400);
    this.name = "UnknownLabelError";
  }
}

/**
 * 仓库绑定冲突：上游报「同名仓库已存在」但 AOS 没有对应绑定记录。
 *
 * 刻意不复用代码即接管：那种情况下的仓库归属未确认，唯一安全的出路是让调用方显式走 `bind` 模式
 * （§6.2）。跨组织抢占既有绑定时同样用本类（上游把该情形报成 CONFLICT）。
 */
export class RepositoryConflictError extends AppError {
  constructor(message = "仓库已存在但无法确认归属，请改用 bind 模式显式绑定") {
    super(message, "REPOSITORY_ALREADY_BOUND", 409);
    this.name = "RepositoryConflictError";
  }
}

/** 操作账本行不存在或不属于当前主体（决策 D5：非本人可查与不存在同形，一律 404）。 */
export class OperationNotFoundError extends NotFoundError {
  constructor(message = "操作记录不存在") {
    super(message);
    this.name = "OperationNotFoundError";
  }
}

/**
 * 建仓库响应的 owner 与请求声明的不一致（决策 D1）。
 *
 * 上游的 `POST /user/repos` 只能建在凭据账号下，请求里的 owner 只是声明；回读不一致说明调用方想用
 * 别人的账号命名空间建仓。这是请求本身不可满足，不是权限拒绝也不是冲突，因此按 400 报，并引导改用
 * `bind` 模式接管已存在的仓库。
 */
export class RepositoryOwnerMismatchError extends AppError {
  constructor(message = "仓库创建返回的 owner 与请求不一致：只能在当前凭据账号下建仓，接管既有仓库请改用 bind 模式") {
    super(message, "GIT_OWNER_MISMATCH", 400);
    this.name = "RepositoryOwnerMismatchError";
  }
}

/**
 * 失败重放的还原表：`code` → 原错误类。
 *
 * 为什么要还原**类**而不只是 `code`/`statusCode`：路由层按 `instanceof` 把错误映射成 `/web` 信封
 * （§9.1 的映射表），同一个幂等键第二次请求若拿到一个通用 `AppError`，就会绕过那张表落到宿主兜底错误
 * 处理器上，同一个失败在首次与重放时得到两种响应体。表里只列本模块**会持久化**的错误码
 * （`toProvisionError` / `toIssueWriteError` 与 T05 附件路径的 `toWriteError` 的产出），新增持久化错误码
 * 时必须同步这里，否则重放会退化成通用 `AppError`——状态码与错误码仍正确，只是路由层的分支不再命中。
 */
const OPERATION_FAILURE_REHYDRATION: Readonly<Record<string, (message: string) => AppError>> = {
  NOT_FOUND: (message) => new NotFoundError(message),
  FORBIDDEN: (message) => new ForbiddenError(message),
  ALREADY_EXISTS: (message) => new ConflictError(message),
  GIT_UNAVAILABLE: (message) => new GitUnavailableError(message),
  GIT_RATE_LIMITED: (message) => new GitUnavailableError(message, "GIT_RATE_LIMITED"),
  REPOSITORY_ALREADY_BOUND: (message) => new RepositoryConflictError(message),
  GIT_OWNER_MISMATCH: (message) => new RepositoryOwnerMismatchError(message),
  // T03：写路径的版本冲突与三种「领取之前」的判定。它们都不产生账本行，写进表里是为了同键第二次请求
  // 在极端时序下仍得到同一个错误类（§5.4）。
  VERSION_CONFLICT: (message) => new VersionConflictError(message),
  WRITE_NOT_APPLIED: (message) => new TicketWriteNotAppliedError(message),
  ASSIGNEE_NOT_MEMBER: (message) => new AssigneeNotMemberError(message),
  LABEL_UNKNOWN: (message) => new UnknownLabelError(message),
  TICKET_OPERATION_PENDING: (message) => new TicketChangeInFlightError(message),
  /** T05：附件上传被上游**确定拒绝**（413/422：大小上限、扩展名白名单）后写下的终态。 */
  VALIDATION_ERROR: (message) => new ValidationError(message),
  /** 同义码（合同 §1.4 的命名）：本批不产出，仅用于还原人工改库或早期版本写下的行。 */
  TICKET_CHANGE_IN_FLIGHT: (message) => new TicketChangeInFlightError(message),
};

/**
 * 把 `failed` 操作的存量结果还原成对外错误：同 `class`/`code`/`statusCode`，**不**重试。
 *
 * 字段缺失（历史行、人工改库）或错误码不在还原表内时退化为通用 `AppError` 而不是抛异常：还原失败不该把
 * 「已知失败」变成「未知故障」，那会让幂等重放出现 500 与 409 之间的抖动。
 */
export function appErrorFromOperationResult(result: Readonly<Record<string, unknown>> | null): AppError {
  const statusCode = typeof result?.statusCode === "number" ? result.statusCode : 500;
  const code = typeof result?.code === "string" ? result.code : "OPERATION_FAILED";
  const message = typeof result?.message === "string" ? result.message : "该操作此前已失败，请发起新的请求";
  const rehydrate = OPERATION_FAILURE_REHYDRATION[code];
  if (rehydrate !== undefined) return rehydrate(message);
  const error = new AppError(message, code, statusCode);
  // 通用分支保留可识别的名字：日志里能看出这条 500 来自账本重放而不是新发生的故障。
  error.name = "OperationReplayError";
  return error;
}

/**
 * 失败终态要持久化的结果投影。
 *
 * 只保留对外会重新用到的三要素：正文、上游报文与诊断上下文一律不进账本（`ticket_operations.result` 是
 * 持久化字段，写入即长期保留，且会经 `/web/ticket-operations/:id` 返回给用户）。
 */
export function toOperationFailureResult(error: AppError): Record<string, unknown> {
  return { statusCode: error.statusCode, code: error.code, message: error.message };
}
