import { type AgentSession, getBoundAgentRuntime, type PromptTurn } from "@fenix/agent-runtime/runtime";
import { findOrCreateNamedApiInstance, getAgentRuntimeConfig } from "@fenix/agent-runtime/server";
import { error as logError, warn as logWarn } from "@fenix/logger";
import {
  buildImInstanceName,
  getChannelConfig,
  IM_INBOX_RESOURCE_URI,
  type ImSessionPort,
  type ImSessionTarget,
  type ImWakePromptInput,
  issueImToken,
} from "@fenix/resource-channel/server";

/**
 * 宿主对 `ImSessionPort` 的生产实现（规格 §6.1 第 5-7 步）。
 *
 * 为什么在宿主：专属实例、ACP 会话与 relay 属于 Agent 运行时的数据面，资源包不得依赖
 * `@fenix/agent-runtime`；channel 包只声明端口，由宿主在启动期绑定。
 *
 * 环境按「通道所有者 + Agent 配置」复用（与 HTTP 自动会话同一推导），实例按聊天隔离为
 * `im-<conversationId>`（`creation_source = api`）；一次投递只持有自己的 relay 消费租约，不拥有实例生命周期。
 */

interface OpenedTurn {
  readonly session: AgentSession;
  readonly turn: PromptTurn;
  /** prompt 已经发出；此时不能提前关闭 relay，否则会话租约无法在 turn 终止时释放。 */
  promptSent: boolean;
}

/** 唤醒失败对外的稳定字符串码；资源包只按码分类，不共享具体错误类型。 */
const IM_WAKE_FAILED = "IM_WAKE_FAILED";

/** 手动停止的实例由 coordinator 以这个码拒绝 ensure；只有它代表「可以显式唤醒」。 */
function isInstanceStoppedError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "INSTANCE_STOPPED"
  );
}

/**
 * 自动唤醒失败。
 *
 * 消息保留底层错误摘要供日志定位；用户可见回复由桥接层固定文案决定，不读取这里的内容。
 */
class ImWakeFailedError extends Error {
  readonly code = IM_WAKE_FAILED;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ImWakeFailedError";
  }
}

/** ACP 会话的 `prompt` 应答在整轮结束时才返回，因此这里只把「发送成功」当作已接受。 */
export function createChannelImSessionPort(): ImSessionPort {
  const runtime = () => getBoundAgentRuntime();
  // 以 handleId 而不是 conversationId 为键：同一聊天换 Agent 后并发冷启动会各自持有一个 turn，
  // 按聊天键存会让后一次 openSession 覆盖前一次，唤醒 prompt 发到错误的会话。
  const opened = new Map<string, OpenedTurn>();
  let handleSequence = 0;

  async function resolveEnvironment(input: {
    agentConfigId: string;
    organizationId: string;
    ownerUserId: string;
  }): Promise<string> {
    // 与 agent-chat-service 的自动环境同名同规则：同一所有者 + Agent 复用同一个 workspace。
    const safeSuffix = input.agentConfigId.replace(/[^a-z0-9-]/g, "").slice(0, 8) || "default";
    const environment = await runtime().createEnvironment({
      name: `auto-${safeSuffix}`,
      agentConfigId: input.agentConfigId,
      userId: input.ownerUserId,
      organizationId: input.organizationId,
      autoStart: true,
    });
    return environment.id;
  }

  /** 逐会话下发 `im` MCP 条目；token 只属于当前 conversation，不进日志（规格 §9.6 / §11.21）。 */
  async function buildMcpServers(target: ImSessionTarget): Promise<Record<string, unknown>[]> {
    const token = await issueImToken(target.conversationId, getChannelConfig().imTokenSecret);
    const baseUrl = getAgentRuntimeConfig().baseUrl.replace(/\/$/, "");
    return [
      {
        type: "http",
        name: "im",
        url: `${baseUrl}/mcp/im`,
        headers: [{ name: "Authorization", value: `Bearer ${token}` }],
        // peri 4.4.1（rmcp 3.5.1）只从 ACP `McpServerHttp._meta["peri.subscriptions"]` 读取订阅声明。
        _meta: { "peri.subscriptions": { resources: [IM_INBOX_RESOURCE_URI] } },
      },
    ];
  }

  async function openTurn(input: {
    target: ImSessionTarget;
    instanceId: string;
    sessionId?: string;
    mcpServers: readonly Record<string, unknown>[];
  }): Promise<{ session: AgentSession; turn: PromptTurn; sessionId: string }> {
    const relayHandle = await runtime().session.connectRelay(input.instanceId, input.target.rcsSessionId);
    const session = runtime().session.createAgentSession({ relayHandle, instanceId: input.instanceId });
    try {
      const started = await runtime().session.startPromptTurn({
        session,
        ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
        mcpServers: input.mcpServers,
      });
      return { session, turn: started.turn, sessionId: started.sessionId };
    } catch (error) {
      await session.dispose().catch((disposeError) => {
        logError("IM 会话握手失败后释放 relay 失败", disposeError instanceof Error ? disposeError : undefined);
      });
      throw error;
    }
  }

  return {
    async ensureInstance(input) {
      const environmentId = await resolveEnvironment(input);
      const instance = await findOrCreateNamedApiInstance({
        environmentId,
        ownerUserId: input.ownerUserId,
        name: buildImInstanceName(input.conversationId),
      });
      try {
        await runtime().ensureInstanceRuntime(instance);
      } catch (error) {
        if (!isInstanceStoppedError(error)) throw error;
        // 手动停止在 IM 场景不是拒绝启动：消息到达本身即唤醒意图，只对这一个码显式重启一次。
        logWarn(
          `[im-session] 实例已手动停止，收到 IM 消息后自动唤醒：conversationId=${input.conversationId}, instanceId=${instance.id}`,
        );
        try {
          await runtime().restartInstanceRuntime(instance);
        } catch (wakeError) {
          throw new ImWakeFailedError(
            `IM 实例自动唤醒失败：${wakeError instanceof Error ? wakeError.message : String(wakeError)}`,
            { cause: wakeError },
          );
        }
      }
      // 实例重启后 uid 不变，只有运行代次变化；桥接层据此作废暖态。
      return {
        instanceId: instance.id,
        runtimeToken: String(runtime().getRuntimeSnapshot(instance.id).runtimeGeneration),
      };
    },

    async openSession(input) {
      const mcpServers = await buildMcpServers(input.target);
      handleSequence += 1;
      const handleId = String(handleSequence);
      if (input.target.acpSessionId) {
        try {
          const restored = await openTurn({
            target: input.target,
            instanceId: input.instance.instanceId,
            sessionId: input.target.acpSessionId,
            mcpServers,
          });
          opened.set(handleId, {
            session: restored.session,
            turn: restored.turn,
            promptSent: false,
          });
          return {
            handleId,
            conversationId: input.target.conversationId,
            instanceId: input.instance.instanceId,
            acpSessionId: restored.sessionId,
          };
        } catch (error) {
          // 会话可能已在 Agent 侧删除：按规格 §6.3 新建会话，由调用方回写 `acp_session_id`。
          logWarn(
            `[im-session] ACP 会话恢复失败，改为新建：conversationId=${input.target.conversationId}`,
            error instanceof Error ? error.message : undefined,
          );
        }
      }

      const created = await openTurn({
        target: input.target,
        instanceId: input.instance.instanceId,
        mcpServers,
      });
      opened.set(handleId, { session: created.session, turn: created.turn, promptSent: false });
      return {
        handleId,
        conversationId: input.target.conversationId,
        instanceId: input.instance.instanceId,
        acpSessionId: created.sessionId,
      };
    },

    async sendWakePrompt(input: ImWakePromptInput) {
      const entry = opened.get(input.session.handleId);
      if (!entry) throw new Error("IM 冷启动会话尚未打开");
      entry.turn.prompt([{ type: "text", text: input.text }]);
      entry.promptSent = true;
    },

    async close(handle) {
      const entry = opened.get(handle.handleId);
      if (!entry) return;
      opened.delete(handle.handleId);
      // 已发出 prompt 时保留 turn 监听：turn 终止时会释放会话租约并关闭 relay。
      entry.turn.release();
      if (!entry.promptSent) await entry.session.dispose();
    },
  };
}
