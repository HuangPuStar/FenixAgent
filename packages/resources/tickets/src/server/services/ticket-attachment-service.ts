/**
 * 附件领域服务：列表、上传与下载（T05；backend contract §7）。
 *
 * 三条与其它域不同的口径，都必须留在这里而不是散到路由或 Facade：
 *
 * 1. **附件的坐标是工单，不是评论**。上游的附件端点挂在 Issue 上（`POST/GET .../issues/{n}/assets`），
 *    因此「评论框里上传的附件」在事实层面归属于该工单；本端既不为附件建表，也不把附件挂到评论 ID 上。
 *    由此推出下载的归属校验方式：附件编号在**该工单的**元数据端点下读取，不属于此工单时上游直接 404。
 * 2. **上传不读回、不重放**。成功后只写账本终态（没有本地行要补）；`WRITE_UNCERTAIN` 落 `uncertain`
 *    并返回 202，由恢复核对按 `intent` 里的文件名与字节数回源认领——附件没有身份头，唯一的匹配依据
 *    就是这两个字段。
 * 3. **上传是唯一会「确定拒绝」的写路径**：上游对扩展名有白名单（422）、对大小有上限（413），两者都
 *    映射成 `INVALID_REQUEST`（协议层 400）。它们**不得**升级成未定态：那会让一次从未发生的写入进恢复
 *    核对，并让用户在「结果确认中」里等一个不存在的结论。
 *
 * 内存口径：单次上传的字节数上限由 {@link TICKET_ATTACHMENT_MAX_BYTES} 在**读入之前**把关（路由按
 * `File.size` 预检）并在此处复核；服务本身不把整个文件复制第二份，`content` 直接交给适配器构造 multipart。
 */

import { createHash } from "node:crypto";
import type { GitAttachment, GitAttachmentDownload, GitScopedClient, GitService } from "@fenix/git/server";
import type { AppError } from "@fenix/platform-sdk";
import { ForbiddenError, NotFoundError, ValidationError } from "@fenix/platform-sdk";
import { appErrorFromOperationResult, GitUnavailableError, toOperationFailureResult } from "../errors";
import { classifyGitFailure, type GitFailureKind } from "./git-failure";
import { connectTicketGitClient } from "./ticket-git-client";
import { TICKET_ATTACHMENT_MAX_BYTES, TICKET_ATTACHMENT_NAME_MAX_LENGTH } from "./ticket-limits";
import type { TicketOperationService } from "./ticket-operation-service";
import { TICKET_OPERATION_STEP } from "./ticket-operation-service";
import { attachmentUploadTargetPath, hashTicketRequest } from "./ticket-request-hash";
import { localWriteFailed, settleTicketWriteFailure } from "./ticket-write-failure";

/** 附件的领域事实（上游投影）；协议视图与它同形，Facade 只做字段搬运。 */
export interface TicketAttachmentFacts {
  /** 附件编号：外部数字 ID，按字符串承载（与工单号、评论 ID 同口径）。 */
  readonly id: string;
  readonly name: string;
  readonly size: number;
  readonly createdAt: string | null;
}

/** 下载结果：元数据 + 上游字节流；流的生命周期归调用方（消费完或取消才算归还适配器的并发名额）。 */
export interface TicketAttachmentDownloadFacts {
  readonly attachment: TicketAttachmentFacts;
  readonly contentType: string | null;
  readonly contentLength: number | null;
  readonly stream: ReadableStream<Uint8Array>;
}

export type TicketAttachmentWriteOutcome =
  | { readonly kind: "written"; readonly operationId: string; readonly attachment: TicketAttachmentFacts }
  | { readonly kind: "uncertain"; readonly operationId: string };

/** 三个坐标与工单号都由 Facade 从已授权的项目行与路径参数传入，绝不取自请求体。 */
export interface TicketAttachmentScope {
  readonly organizationId: string;
  readonly projectId: string;
  readonly bindingId: string;
  readonly issueNumber: string;
}

export interface TicketAttachmentService {
  listAttachments(input: TicketAttachmentScope): Promise<readonly TicketAttachmentFacts[]>;
  uploadAttachment(
    input: TicketAttachmentScope & {
      readonly actorId: string;
      readonly name: string;
      readonly content: Uint8Array;
      readonly contentType?: string;
      readonly idempotencyKey: string;
    },
  ): Promise<TicketAttachmentWriteOutcome>;
  downloadAttachment(
    input: TicketAttachmentScope & { readonly attachmentId: string },
  ): Promise<TicketAttachmentDownloadFacts>;
}

export interface TicketAttachmentServiceDeps {
  readonly operations: TicketOperationService;
  readonly git: GitService;
}

/** 去 C0（NUL–0x1F）与 DEL（0x7F）控制字符。用码点遍历而非正则字面量，规避 lint 的
 * `noControlCharactersInRegex` 规则（与 `file-path-validator` 同一口径）。 */
function stripControlCharacters(value: string): string {
  let result = "";
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f) continue;
    result += character;
  }
  return result;
}

/**
 * 归一附件文件名：取基名、去控制字符、去首尾空白。
 *
 * multipart 的 filename 由客户端给出，因此可能带目录分隔符（`../`）、换行或控制字符；它会同时进入
 * 上游的 `?name=` 参数与下载响应的 `Content-Disposition` 头。这里只做**归一**（拿基名 + 去控制字符），
 * 目录穿越在附件场景里没有落点（我们不按文件名落盘），真正的红线是响应头注入，控制字符清除即封死。
 *
 * @throws ValidationError 归一后为空或超过 {@link TICKET_ATTACHMENT_NAME_MAX_LENGTH}
 */
export function sanitizeAttachmentName(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? "";
  const cleaned = stripControlCharacters(base).trim();
  if (cleaned.length === 0) throw new ValidationError("附件缺少文件名");
  if (cleaned.length > TICKET_ATTACHMENT_NAME_MAX_LENGTH) {
    throw new ValidationError(`附件名过长：最多 ${TICKET_ATTACHMENT_NAME_MAX_LENGTH} 个字符`);
  }
  return cleaned;
}

/** 内容摘要：幂等指纹与恢复核对都用它表达「这一次上传的是哪份字节」。 */
function contentDigest(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

export function createTicketAttachmentService(deps: TicketAttachmentServiceDeps): TicketAttachmentService {
  const { operations, git } = deps;

  function toAttachmentFacts(attachment: GitAttachment): TicketAttachmentFacts {
    return {
      id: attachment.id,
      name: attachment.name,
      size: attachment.size,
      createdAt: attachment.createdAt,
    };
  }

  /** 读失败的对外映射：`NOT_FOUND` 是「工单/附件不存在」，其余上游故障一律 503（不伪装成空列表）。 */
  function toReadError(failure: Extract<GitFailureKind, { kind: "definite" }>, notFoundMessage: string): AppError {
    if (failure.code === "NOT_FOUND") return new NotFoundError(notFoundMessage);
    if (failure.code === "RATE_LIMITED") {
      return new GitUnavailableError("托管平台限流，请稍后重试", "GIT_RATE_LIMITED");
    }
    return new GitUnavailableError("托管平台不可用，请稍后重试");
  }

  /** 写失败的对外映射：附件路径上 `CONFLICT` 不可达（没有「同名占用」语义），保持与其它写路径同形即可。 */
  function toWriteError(failure: Extract<GitFailureKind, { kind: "definite" }>): AppError {
    if (failure.code === "NOT_FOUND") return new NotFoundError("工单不存在");
    if (failure.code === "FORBIDDEN") return new ForbiddenError("当前凭据无权上传附件");
    if (failure.code === "INVALID_REQUEST") {
      // 上游的 413/422 是给**用户**的结论：文件名/扩展名不被接受，或超出上游大小上限。
      return new ValidationError("托管平台拒绝了该附件：请检查文件扩展名与大小");
    }
    if (failure.code === "RATE_LIMITED") {
      return new GitUnavailableError("托管平台限流，请稍后重试", "GIT_RATE_LIMITED");
    }
    return new GitUnavailableError("托管平台不可用，请稍后重试");
  }

  /** 读取时的异常收敛：`classifyGitFailure` 认不出的异常原样上抛（交宿主兜底 500）。 */
  function failRead(error: unknown, notFoundMessage: string): never {
    const failure = classifyGitFailure(error);
    if (failure === undefined) throw error;
    if (failure.kind === "definite") throw toReadError(failure, notFoundMessage);
    // 读路径没有「结果未定」：`WRITE_UNCERTAIN` 只出现在写方法上，其余一律是上游不可用。
    throw new GitUnavailableError("托管平台不可用，请稍后重试");
  }

  return {
    async listAttachments(input) {
      const client = await connectTicketGitClient(git, input);
      try {
        // 适配器已按 `Link` 头翻完整份集合（有界），这里不再分页：附件集合与工单同量级。
        return (await client.attachments.list(input.issueNumber)).map(toAttachmentFacts);
      } catch (error) {
        return failRead(error, "工单不存在");
      }
    },

    async uploadAttachment(input) {
      const name = sanitizeAttachmentName(input.name);
      // 空内容一律拒绝：文件选择器选不出 0 字节文件，走到这里通常是 multipart 解析出了空 part。
      // 放行它会在工单上留下一个「看起来上传成功、下载下来是空文件」的附件，比当场拒绝更难排查。
      if (input.content.byteLength === 0) throw new ValidationError("附件内容为空");
      if (input.content.byteLength > TICKET_ATTACHMENT_MAX_BYTES) {
        const limitMb = Math.floor(TICKET_ATTACHMENT_MAX_BYTES / (1024 * 1024));
        throw new ValidationError(`附件超过大小上限（${limitMb} MB）`);
      }
      const digest = contentDigest(input.content);

      const admission = await operations.begin({
        organizationId: input.organizationId,
        actorId: input.actorId,
        kind: "attachment.upload",
        projectId: input.projectId,
        // 坐标是工单号（领取时写入），但**不进**工单级短锁：附件之间没有共享的本地状态，五份文件并发上传
        // 是正常用法（§7 的并发上限在前端），让它们串在工单锁上只会把一份文件的排队时间乘五。
        targetId: input.issueNumber,
        idempotencyKey: input.idempotencyKey,
        requestHash: hashTicketRequest({
          kind: "attachment.upload",
          targetPath: attachmentUploadTargetPath(input.projectId, input.issueNumber),
          payload: { name, size: input.content.byteLength, contentDigest: digest },
        }),
        // 附件没有身份头，`message_id` 不适用；恢复核对靠 `intent` 里的文件名与字节数回源。
        messageId: null,
        expectedVersion: null,
        intent: {
          name,
          size: input.content.byteLength,
          contentDigest: digest,
          issueNumber: input.issueNumber,
        },
        step: TICKET_OPERATION_STEP.dispatching,
      });
      if (admission.kind === "failed") throw appErrorFromOperationResult(admission.result);
      if (admission.kind === "in_flight") return { kind: "uncertain", operationId: admission.operationId };
      if (admission.kind === "replayed") {
        // 成功重放：远端对象号与文件名都在终态 `result` 里（附件无本地行，不重放写入也不回源读）。
        return {
          kind: "written",
          operationId: admission.operationId,
          attachment: replayAttachment(admission.result),
        };
      }
      const operationId = admission.operationId;

      let client: GitScopedClient;
      try {
        client = await connectTicketGitClient(git, input);
      } catch (error) {
        // 绑定不可用是**确定**失败：写终态后抛出，同键重放还原同一个 503（与其它写路径同口径）。
        if (error instanceof GitUnavailableError) {
          await operations.fail({
            operationId,
            step: TICKET_OPERATION_STEP.upstreamFailed,
            result: toOperationFailureResult(error),
          });
        }
        throw error;
      }

      let written: TicketAttachmentFacts;
      try {
        written = toAttachmentFacts(
          await client.attachments.upload(input.issueNumber, {
            name,
            content: input.content,
            ...(input.contentType === undefined ? {} : { contentType: input.contentType }),
          }),
        );
      } catch (error) {
        await settleTicketWriteFailure({ operations, operationId, error, toError: toWriteError });
        return { kind: "uncertain", operationId };
      }

      try {
        await operations.succeed({
          operationId,
          step: TICKET_OPERATION_STEP.attachmentUploaded,
          targetId: written.id,
          result: {
            attachmentId: written.id,
            name: written.name,
            size: written.size,
            createdAt: written.createdAt,
          },
          // 摘要里只留可核对的坐标：名字与字节数正是恢复核对在远端要找的东西。
          intentSummary: { name: written.name, size: written.size, issueNumber: input.issueNumber },
        });
      } catch (error) {
        // 远端已写入、本地终态未提交：说成功是说谎（本地没记完），说失败也是说谎（远端已落库）。
        return localWriteFailed({
          operationId,
          projectId: input.projectId,
          targetId: written.id,
          targetKind: "attachment",
          error,
        });
      }
      return { kind: "written", operationId, attachment: written };
    },

    async downloadAttachment(input) {
      const client = await connectTicketGitClient(git, input);
      let download: GitAttachmentDownload;
      try {
        // 两步在适配器内完成：先按附件编号回读元数据（不属于该工单 → 上游 404），再按 uuid 开内容流。
        download = await client.attachments.download(input.issueNumber, input.attachmentId);
      } catch (error) {
        return failRead(error, "附件不存在或不属于该工单");
      }
      if (download.stream === null) {
        // 适配器已把「2xx 但无正文」判成读失败；这里是类型上的兜底，绝不把空流当成空文件发给浏览器。
        throw new GitUnavailableError("托管平台未返回附件内容，请稍后重试");
      }
      return {
        attachment: toAttachmentFacts(download.attachment),
        contentType: download.contentType,
        contentLength: download.contentLength,
        stream: download.stream,
      };
    },
  };
}

/** 成功重放：附件坐标已在终态 `result` 里；缺字段说明账本行被外力改坏，当场失败而不是编一个 ID。 */
function replayAttachment(result: Readonly<Record<string, unknown>>): TicketAttachmentFacts {
  const id = typeof result.attachmentId === "string" ? result.attachmentId : null;
  const name = typeof result.name === "string" ? result.name : null;
  const size = typeof result.size === "number" ? result.size : null;
  if (id === null || name === null || size === null) throw new Error("附件上传操作已成功，但结果缺少附件字段");
  return {
    id,
    name,
    size,
    createdAt: typeof result.createdAt === "string" ? result.createdAt : null,
  };
}
