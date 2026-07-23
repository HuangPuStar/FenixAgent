import { log, error as logError } from "@fenix/logger";
import { openAgentSession, type PromptTurn } from "../agent-chat-service";
import type { TaskExecInput, TaskExecOutput, TaskExecutor } from "./types";

const deps = {
  openAgentSession,
};

/** 测试用：覆盖 executor 依赖。 */
export function setAgentExecutorDeps(overrides: Partial<typeof deps> | null): void {
  if (overrides) {
    Object.assign(deps, overrides);
    return;
  }
  deps.openAgentSession = openAgentSession;
}

interface AgentDefinition {
  prompt: string;
}

function parseDefinition(raw: unknown): AgentDefinition {
  const def = raw as AgentDefinition;
  return { prompt: String(def.prompt ?? "") };
}

/** 从 ACP 事件中提取纯文本输出（过滤 tool_call / tool_result，只保留 agent_message_chunk） */
function extractPlainText(events: Array<{ type: string; payload?: unknown }>): string {
  const lines: string[] = [];
  for (const ev of events) {
    const payload = (ev.payload ?? ev) as Record<string, unknown> | undefined;
    if (!payload) continue;

    // JSON-RPC result 中的 stopReason → 结束信号，不参与文本提取
    if (payload.jsonrpc === "2.0" && (payload as unknown as { result?: { stopReason?: unknown } }).result?.stopReason)
      continue;

    // session/update 通知
    if (payload.method === "session/update") {
      const params = payload.params as Record<string, unknown> | undefined;
      const update = params?.update as Record<string, unknown> | undefined;
      if (!update) continue;

      // sessionUpdate 是事件类型，content 是实际内容
      if (update.sessionUpdate !== "agent_message_chunk") continue;
      const content = update.content as Record<string, unknown> | undefined;
      if (content && typeof content.text === "string") lines.push(content.text);
    }
  }
  const text = lines.join("").trim();
  return text.slice(0, 2000);
}

export const agentExecutor: TaskExecutor = {
  type: "agent",

  async execute(input: TaskExecInput): Promise<TaskExecOutput> {
    const { task } = input;
    const def = parseDefinition(task.definition);
    const startTime = Date.now();

    if (!task.agentId) {
      return { status: "failed", duration: Date.now() - startTime, error: "agentId is null" };
    }

    const timeoutMs = (task.timeoutSeconds ?? 300) * 1000;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    let turn: PromptTurn | undefined;
    try {
      const result = await deps.openAgentSession({
        userId: task.userId,
        agentConfigId: task.agentId,
        organizationId: task.organizationId,
        startSource: "scheduled",
      });
      turn = result.turn;

      turn.prompt([{ type: "text", text: def.prompt }]);

      const events: Array<{ type: string; payload?: unknown }> = [];
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error("Agent execution timeout")), timeoutMs);
      });

      await Promise.race([
        (async () => {
          for await (const ev of turn.events()) {
            events.push(ev as unknown as { type: string; payload?: unknown });
            const raw = ev as unknown as Record<string, unknown>;
            const rpc = raw.jsonrpc === "2.0" ? raw : (ev.payload as Record<string, unknown> | undefined);
            if (rpc?.jsonrpc === "2.0" && (rpc as unknown as { result?: { stopReason?: unknown } }).result?.stopReason)
              break;
          }
        })(),
        timeoutPromise,
      ]);

      const duration = Date.now() - startTime;
      const resultSummary = extractPlainText(events);

      log(`[agent-executor] Task ${task.id} completed: duration=${duration}ms summaryLen=${resultSummary.length}`);
      return { status: "success", duration, resultSummary };
    } catch (err) {
      const duration = Date.now() - startTime;
      const msg = err instanceof Error ? err.message : String(err);
      const isTimeout = msg === "Agent execution timeout";

      logError(`[agent-executor] Task ${task.id} failed:`, msg);
      return {
        status: isTimeout ? "timeout" : "failed",
        duration,
        error: msg,
        resultSummary: msg.slice(0, 2000),
      };
    } finally {
      clearTimeout(timeoutId);
      if (turn) {
        await turn.dispose().catch((err) => {
          logError(`[agent-executor] Failed to dispose turn for task ${task.id}:`, err);
        });
      }
    }
  },
};
