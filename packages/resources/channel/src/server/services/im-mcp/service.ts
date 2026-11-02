import * as z from "zod/v4";
import { getChannelConfig } from "../../config";
import { type ChannelAgentConfigLookup, ChannelAgentConfigUnavailableError } from "../../ports/agent-config-lookup";
import type { ImChannelRepository, ImChannelRow } from "../../repositories/im-channel";
import type {
  ImChannelConversationRepository,
  ImChannelConversationRow,
} from "../../repositories/im-channel-conversation";
import type { ImChannelEventRepository } from "../../repositories/im-channel-event";
import {
  type DeliveryDispatcher,
  IM_INBOX_RESOURCE_URI,
  type ImSubscriptionSink,
} from "../langbot/delivery-dispatcher";
import { verifyImToken } from "../langbot/im-token";
import type { ImOutboundService } from "../langbot/outbound-service";
import { buildImContext } from "./context-tool";
import { decodeInboxCursor, readImInbox } from "./inbox-resource";
import { getImChannelSkill, IM_CHANNEL_SKILL_MARKDOWN, IM_CHANNEL_SKILL_URI, listImChannelSkills } from "./skill";
import {
  IM_MCP_PROTOCOL_VERSION,
  IM_MCP_SERVER_CAPABILITIES,
  IM_MCP_SERVER_NAME,
  IM_MCP_SERVER_VERSION,
  ImMcpError,
  type ImMcpResourceReadResult,
  type ImMcpSession,
  type ImMcpSkillDetail,
  type ImMcpSkillSummary,
  type ImMcpToolDefinition,
  type ImMcpToolResult,
} from "./types";

/**
 * `/mcp/im` 的领域服务（规格 §4.4 / §4.6 / §9）。
 *
 * 连接身份由 `Authorization: Bearer` 唯一确定：工具与资源都不接受 `chat_id`，所有查询都从会话记录取
 * channelId + chatType + chatId 三件套，因此不存在跨会话读取或回复的第二条路径。协议适配（JSON-RPC、
 * SSE）在路由层，本文件只返回结构化结果。
 *
 * 三个硬约束：
 * 1. 只有持有有效连接 token 的请求能进入：未知 token 一律由路由 401，不存在未认证旁路。
 * 2. 通知只带资源 URI；正文只能经 `resources/read` 取出，且取出即清。
 * 3. Skill 只经 MCP 下发，不写平台 skill 表（规格 §4.5）。
 */

const ImReplyArgumentsSchema = z.strictObject({
  text: z.string().min(1),
  mention_user_id: z.string().min(1).optional(),
});

const ImContextArgumentsSchema = z.strictObject({});

const IM_REPLY_TOOL: ImMcpToolDefinition = {
  name: "im_reply",
  title: "回复当前 IM 聊天",
  description:
    "向当前连接绑定的 IM 聊天发送纯文本。群聊默认 @ 触发者，可显式指定 mention_user_id；禁止 @all，单条超过 4000 字符会被切片。",
  inputSchema: {
    type: "object",
    properties: {
      text: { type: "string", description: "要发送的纯文本。" },
      mention_user_id: {
        type: "string",
        description: "群聊要 @ 的成员；必须是该会话近期消息的发送者。省略时回退到最近一条事件的发送者。",
      },
    },
    required: ["text"],
    additionalProperties: false,
  },
};

const IM_CONTEXT_TOOL: ImMcpToolDefinition = {
  name: "im_context",
  title: "读取当前 IM 会话上下文",
  description: "返回通道名、聊天类型、掩码后的聊天与会话标识、Agent 名称与待处理消息数；不返回原始 ID 或凭据。",
  inputSchema: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
};

const TOOL_DEFINITIONS: readonly ImMcpToolDefinition[] = [IM_REPLY_TOOL, IM_CONTEXT_TOOL];

function readBearerToken(authorization: string | null): string | null {
  if (!authorization) return null;
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

/** 会话行或通道行已删除时工具仍要给出固定失败形状，不能静默返回空上下文。 */
function noConversation(): { ok: false; error: { code: "NO_CONVERSATION"; message: string } } {
  return { ok: false, error: { code: "NO_CONVERSATION", message: "IM 会话或其通道不存在" } };
}

function invalidArguments(message: string): { ok: false; error: { code: "INVALID_ARGUMENTS"; message: string } } {
  return { ok: false, error: { code: "INVALID_ARGUMENTS", message } };
}

/** 只回字段路径，不回显调用方传入的值（可能是正文或伪造的 ID）。 */
function argumentPaths(error: z.ZodError): string {
  const paths = error.issues.map((issue) => issue.path.join(".") || "<root>");
  return [...new Set(paths)].join(", ");
}

function toolResult(payload: Record<string, unknown>, isError = false): ImMcpToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: payload,
    ...(isError ? { isError: true } : {}),
  };
}

export interface ImMcpServiceDeps {
  readonly channels: ImChannelRepository;
  readonly conversations: ImChannelConversationRepository;
  readonly events: ImChannelEventRepository;
  readonly outbound: ImOutboundService;
  readonly dispatcher: DeliveryDispatcher;
  /** 测试注入；生产按调用时读取模块配置，配置缺失时校验必失败。 */
  readonly tokenSecret?: () => string | undefined;
  readonly now?: () => Date;
  /** 宿主端口的惰性取用：端口在启动流程里晚于模块构造绑定。 */
  readonly agentConfigLookup?: () => ChannelAgentConfigLookup;
}

export interface ImMcpService {
  /** 缺失或非法凭据返回 null，由路由统一 401。 */
  authenticate(authorization: string | null): Promise<ImMcpSession | null>;
  discover(): Record<string, unknown>;
  listTools(): readonly ImMcpToolDefinition[];
  callTool(input: { session: ImMcpSession; name: string; arguments: unknown }): Promise<ImMcpToolResult>;
  readResource(input: { session: ImMcpSession; uri: string; cursor?: string }): Promise<ImMcpResourceReadResult>;
  listSkills(): readonly ImMcpSkillSummary[];
  getSkill(name: string): ImMcpSkillDetail | undefined;
  /** 注册进程内订阅流；返回取消函数。 */
  subscribe(input: { session: ImMcpSession; sink: ImSubscriptionSink }): () => void;
}

export function createImMcpService(deps: ImMcpServiceDeps): ImMcpService {
  const now = deps.now ?? (() => new Date());
  const tokenSecret = deps.tokenSecret ?? (() => getChannelConfig().imTokenSecret);

  async function resolveAgentName(
    channel: ImChannelRow,
    conversation: ImChannelConversationRow,
  ): Promise<string | null> {
    const lookup = deps.agentConfigLookup?.();
    if (!lookup) return null;
    try {
      const result = await lookup.requireUsable({
        organizationId: channel.organizationId,
        ownerUserId: channel.userId,
        agentConfigId: conversation.agentConfigId,
      });
      return result.name;
    } catch (error) {
      // Agent 配置被删除或对所有者失去 use 权限是业务状态，不是基础设施故障；上下文照常返回。
      if (error instanceof ChannelAgentConfigUnavailableError) return null;
      throw error;
    }
  }

  async function callReply(session: ImMcpSession, args: unknown): Promise<ImMcpToolResult> {
    const parsed = ImReplyArgumentsSchema.safeParse(args ?? {});
    if (!parsed.success) {
      return toolResult(invalidArguments(`参数不合法：${argumentPaths(parsed.error)}`), true);
    }

    const result = await deps.outbound.replyToConversation({
      conversationId: session.conversationId,
      text: parsed.data.text,
      ...(parsed.data.mention_user_id !== undefined ? { mentionUserId: parsed.data.mention_user_id } : {}),
    });
    return toolResult({ ...result }, !result.ok);
  }

  async function callContext(session: ImMcpSession, args: unknown): Promise<ImMcpToolResult> {
    const parsed = ImContextArgumentsSchema.safeParse(args ?? {});
    if (!parsed.success) {
      return toolResult(invalidArguments(`参数不合法：${argumentPaths(parsed.error)}`), true);
    }

    const conversation = await deps.conversations.findById({ conversationId: session.conversationId });
    const channel = conversation ? await deps.channels.findById({ channelId: conversation.channelId }) : undefined;
    if (!conversation || !channel) return toolResult(noConversation(), true);

    const pendingCount = await deps.events.countPendingByChat({
      channelId: conversation.channelId,
      chatType: conversation.chatType,
      chatId: conversation.chatId,
    });
    const agentName = await resolveAgentName(channel, conversation);
    return toolResult({ ...buildImContext({ channelName: channel.name, conversation, agentName, pendingCount }) });
  }

  async function readInbox(session: ImMcpSession, uri: string, cursor: string | undefined) {
    const after = cursor === undefined ? undefined : decodeInboxCursor(cursor);
    if (cursor !== undefined && !after) throw new ImMcpError(-32602, "分页游标不合法");

    const conversation = await deps.conversations.findById({ conversationId: session.conversationId });
    if (!conversation) throw new ImMcpError(-32004, "会话不存在");

    const page = await readImInbox({
      events: deps.events,
      conversation,
      ...(after ? { after } : {}),
      now: now(),
    });
    return { contents: [{ uri, mimeType: "application/json", text: JSON.stringify(page) }] };
  }

  return {
    async authenticate(authorization) {
      const token = readBearerToken(authorization);
      if (!token) return null;

      const conversationId = await verifyImToken(token, tokenSecret());
      if (!conversationId) return null;

      const conversation = await deps.conversations.findById({ conversationId });
      // 通道与会话已删除时 token 必须失效，不能留下指向不存在会话的连接。
      return conversation ? { conversationId } : null;
    },

    discover() {
      // rmcp 3.5.1 的 DiscoverResult：resultType 与 supportedVersions 等字段都必填，缺一个就回退 initialize。
      return {
        resultType: "complete",
        supportedVersions: [IM_MCP_PROTOCOL_VERSION],
        capabilities: IM_MCP_SERVER_CAPABILITIES,
        ttlMs: 0,
        cacheScope: "private",
        _meta: {
          "io.modelcontextprotocol/serverInfo": { name: IM_MCP_SERVER_NAME, version: IM_MCP_SERVER_VERSION },
        },
      };
    },

    listTools() {
      return TOOL_DEFINITIONS;
    },

    async callTool(input) {
      switch (input.name) {
        case "im_reply":
          return callReply(input.session, input.arguments);
        case "im_context":
          return callContext(input.session, input.arguments);
        default:
          throw new ImMcpError(-32602, "未知工具");
      }
    },

    async readResource(input) {
      if (input.uri === IM_CHANNEL_SKILL_URI) {
        return {
          contents: [{ uri: IM_CHANNEL_SKILL_URI, mimeType: "text/markdown", text: IM_CHANNEL_SKILL_MARKDOWN }],
        };
      }
      if (input.uri === IM_INBOX_RESOURCE_URI) return readInbox(input.session, input.uri, input.cursor);
      throw new ImMcpError(-32602, "不支持的资源 URI");
    },

    listSkills() {
      return listImChannelSkills();
    },

    getSkill(name) {
      return getImChannelSkill(name);
    },

    subscribe(input) {
      return deps.dispatcher.subscribe(input.session.conversationId, input.sink);
    },
  };
}
