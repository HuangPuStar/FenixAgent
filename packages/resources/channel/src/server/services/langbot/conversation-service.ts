import type { ImChatType } from "@fenix/resource-channel/db";
import type {
  ImChannelConversationRepository,
  ImChannelConversationRow,
} from "../../repositories/im-channel-conversation";

/**
 * IM 聊天的长会话映射（规格 §5.4）。
 *
 * 一个 IM 聊天只有一条 conversation，长期复用；唯一例外是路由改绑 Agent——ACP session 属于创建它的
 * Agent，不能跨 Agent 恢复，因此必须换 `rcsSessionId` 并清空 `acpSessionId`。
 *
 * `rcsSessionId` 必须确定性：刷新与重启后要靠它找回同一份 Y.Doc / relay 会话。这里用
 * `sha256(agentConfigId, ownerUserId, conversationId)` 截断 128 位——三个 UUID 直接 base64url 编码会超过
 * `varchar(128)`，而哈希只用于生成隔离键、不需要可逆。禁止时间戳与随机值。
 */

export interface EnsureConversationInput {
  readonly channelId: string;
  readonly ownerUserId: string;
  readonly chatType: ImChatType;
  readonly chatId: string;
  readonly agentConfigId: string;
}

export interface EnsureConversationResult {
  readonly conversation: ImChannelConversationRow;
  readonly created: boolean;
  /** 路由改绑 Agent 导致会话键重建；调用方据此停止旧实例（实例生命周期不在本阶段）。 */
  readonly agentChanged: boolean;
}

export interface ConversationService {
  /** 必须在事务内调用：`findByChat(forUpdate)` 的行锁与唯一键共同保证只创建一条会话。 */
  ensure(input: EnsureConversationInput): Promise<EnsureConversationResult>;
}

export interface ConversationServiceDeps {
  readonly conversations: ImChannelConversationRepository;
  /** 测试注入；生产用 `crypto.randomUUID`。 */
  readonly generateId?: () => string;
}

function toHex(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

/**
 * 生成 IM 聊天的确定性 Chat 会话键。
 *
 * 只用于 Y.Doc / relay / 冷启动 prompt 的隔离键，不得与 ACP `ses_*` 或 relay session 混用。
 */
export async function createDeterministicImRcsSessionId(
  agentConfigId: string,
  ownerUserId: string,
  conversationId: string,
): Promise<string> {
  const payload = `${agentConfigId}\n${ownerUserId}\n${conversationId}`;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(payload));
  return `rcs_im_${toHex(new Uint8Array(digest).slice(0, 16))}`;
}

export function createConversationService(deps: ConversationServiceDeps): ConversationService {
  const generateId = deps.generateId ?? (() => crypto.randomUUID());

  async function applyAgent(
    existing: ImChannelConversationRow,
    input: EnsureConversationInput,
  ): Promise<EnsureConversationResult> {
    if (existing.agentConfigId === input.agentConfigId) {
      return { conversation: existing, created: false, agentChanged: false };
    }
    const rcsSessionId = await createDeterministicImRcsSessionId(input.agentConfigId, input.ownerUserId, existing.id);
    const reset = await deps.conversations.resetForAgent({
      conversationId: existing.id,
      agentConfigId: input.agentConfigId,
      rcsSessionId,
    });
    if (!reset) throw new Error("会话已存在但换 Agent 时未返回行");
    return { conversation: reset, created: false, agentChanged: true };
  }

  return {
    async ensure(input) {
      const existing = await deps.conversations.findByChat({
        channelId: input.channelId,
        chatType: input.chatType,
        chatId: input.chatId,
        forUpdate: true,
      });
      if (existing) return applyAgent(existing, input);

      const conversationId = generateId();
      const rcsSessionId = await createDeterministicImRcsSessionId(
        input.agentConfigId,
        input.ownerUserId,
        conversationId,
      );
      const inserted = await deps.conversations.insertIfAbsent({
        id: conversationId,
        channelId: input.channelId,
        chatType: input.chatType,
        chatId: input.chatId,
        agentConfigId: input.agentConfigId,
        rcsSessionId,
      });
      if (inserted) return { conversation: inserted, created: true, agentChanged: false };

      // 并发插入被唯一键拦截：另一实例已经创建，回读并走同一套「是否换 Agent」判定。
      const raced = await deps.conversations.findByChat({
        channelId: input.channelId,
        chatType: input.chatType,
        chatId: input.chatId,
        forUpdate: true,
      });
      if (!raced) throw new Error("会话唯一键冲突后仍读不到会话行");
      return applyAgent(raced, input);
    },
  };
}
