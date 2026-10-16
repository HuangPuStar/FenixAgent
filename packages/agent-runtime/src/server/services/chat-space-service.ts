import { randomUUID } from "node:crypto";
import type {
  ChatSpaceRecord,
  ChatSpaceRemoveSessionInput,
  ChatSpaceRenameInput,
  ChatSpaceScope,
  ChatSpaceSessionInput,
  ChatSpaceUserInput,
  ChatSpaceWriteOutcome,
  IChatSpaceRepo,
} from "../repositories/chat-space";
import { chatSpaceRepo } from "../repositories/chat-space";
import {
  CHAT_SPACE_NAME_MAX_LENGTH,
  CHAT_SPACE_SESSION_ID_MAX_LENGTH,
  chatSpaceNameConflictError,
  chatSpaceNameInvalidError,
  chatSpaceNotFoundError,
  invalidSessionIdError,
} from "./chat-space-errors";

/**
 * Chat 会话分组的领域服务。
 *
 * 职责只有三件：分组名规则、把仓储的三态写法结论翻译成领域错误、生成分组标识。**不做归属判定**——
 * 「实例属于谁、环境属于哪个组织」由 `facades/chat-space-facade` 完成，本层收到的 `scope` 已是已授权范围
 * （因此本层签名里没有 organizationId，也没有 actor）。错误词汇表见 `./chat-space-errors`。
 */

/** 生成分组业务标识（`space_` + 32 位十六进制），与实例 uid 同风格。 */
function createChatSpaceId(): string {
  return `space_${randomUUID().replaceAll("-", "")}`;
}

export type ChatSpaceCreateInput = ChatSpaceScope & { readonly name: string };

/** Chat 会话分组的领域服务契约面。 */
export interface ChatSpaceServiceApi {
  listSpaces(scope: ChatSpaceScope): Promise<ChatSpaceRecord[]>;
  /** 按 (分组 id, 属主) 定位分组：门面用它确认分组落在入参 `instanceUid` 的实例内。 */
  findByIdForUser(input: ChatSpaceUserInput): Promise<ChatSpaceRecord | undefined>;
  createSpace(input: ChatSpaceCreateInput): Promise<ChatSpaceRecord>;
  renameSpace(input: ChatSpaceRenameInput): Promise<ChatSpaceRecord>;
  assignSession(input: ChatSpaceSessionInput): Promise<ChatSpaceRecord>;
  /** 取消归属：从该实例的所有分组摘除该会话；本就不在任何分组时返回 `undefined`（幂等成功，不是 404）。 */
  removeSession(input: ChatSpaceRemoveSessionInput): Promise<ChatSpaceRecord | undefined>;
}

export class ChatSpaceService implements ChatSpaceServiceApi {
  constructor(private readonly repository: IChatSpaceRepo) {}

  listSpaces(scope: ChatSpaceScope): Promise<ChatSpaceRecord[]> {
    return this.repository.listByScope(scope);
  }

  findByIdForUser(input: ChatSpaceUserInput): Promise<ChatSpaceRecord | undefined> {
    return this.repository.findByIdForUser(input);
  }

  async createSpace(input: ChatSpaceCreateInput): Promise<ChatSpaceRecord> {
    const name = this.#normalizeName(input.name);
    const result = await this.repository.insert({
      id: createChatSpaceId(),
      instanceUid: input.instanceUid,
      userId: input.userId,
      name,
    });
    return this.#unwrap(result);
  }

  async renameSpace(input: ChatSpaceRenameInput): Promise<ChatSpaceRecord> {
    // 不做「先查后写」的存在性预检：改名到与自身同名不会与唯一索引冲突，而「未命中」与「重名」分别由
    // 更新的空结果与 23505 表达，两者本就可区分；预检只会多一次查询和一条竞态窗口。
    const name = this.#normalizeName(input.name);
    return this.#unwrap(await this.repository.renameInScope({ ...input, name }));
  }

  async assignSession(input: ChatSpaceSessionInput): Promise<ChatSpaceRecord> {
    this.#assertSessionId(input.sessionId);
    return this.#unwrap(await this.repository.moveSessionToSpace(input));
  }

  async removeSession(input: ChatSpaceRemoveSessionInput): Promise<ChatSpaceRecord | undefined> {
    this.#assertSessionId(input.sessionId);
    // 不做 `#unwrap`：取消归属没有「分组不存在」这一失败面（分组由 scope 决定，不由调用方指定），
    // 未命中即会话本就不在任何分组，映射成 undefined 的成功。
    return this.repository.removeSessionFromScope(input);
  }

  /** 分组名规则：trim 后 1..100 字符。存储的是 trim 后的值，库侧 CHECK 因此恒成立。 */
  #normalizeName(raw: string): string {
    const name = raw.trim();
    if (name.length === 0 || name.length > CHAT_SPACE_NAME_MAX_LENGTH) throw chatSpaceNameInvalidError();
    return name;
  }

  /** 会话 id 只校验非空与长度：会话本体归 ACP 侧，平台没有可在本地比对的会话注册表。 */
  #assertSessionId(sessionId: string): void {
    if (sessionId.trim().length === 0 || sessionId.length > CHAT_SPACE_SESSION_ID_MAX_LENGTH) {
      throw invalidSessionIdError();
    }
  }

  #unwrap(result: ChatSpaceWriteOutcome): ChatSpaceRecord {
    if (result.outcome === "written") return result.space;
    if (result.outcome === "conflict") throw chatSpaceNameConflictError();
    throw chatSpaceNotFoundError();
  }
}

/** 分组领域服务单例：进程内只有一个实现，仓储替换点是 DB 句柄（用例经 `stubDb` 注入）。 */
export const chatSpaceService: ChatSpaceServiceApi = new ChatSpaceService(chatSpaceRepo);
