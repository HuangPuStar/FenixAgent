import type { AgentRuntimePort, PromptTurn } from "@fenix/agent-runtime/runtime";
import {
  classifyAgentTurnEvent,
  getBoundAgentRuntime,
  iterateWithSignal,
  waitWithSignal,
} from "@fenix/agent-runtime/runtime";
import { extractJsonRpc } from "@fenix/chat-channel";
import { log, error as logError } from "@fenix/logger";
import type { TaskExecInput, TaskExecOutput, TaskExecutor } from "./types";

/** 默认实现：经运行 port 打开一次程序化会话（1.4 W3b；`api/primary` 类持久实例 + 独立 relay/ACP session）。 */
const defaultOpenAgentSession: AgentRuntimePort["openAgentSession"] = (input) =>
  getBoundAgentRuntime().openAgentSession(input);

const deps = {
  openAgentSession: defaultOpenAgentSession,
};

/** 测试用：覆盖 executor 依赖。 */
export function setAgentExecutorDeps(overrides: Partial<typeof deps> | null): void {
  if (overrides) {
    Object.assign(deps, overrides);
    return;
  }
  deps.openAgentSession = defaultOpenAgentSession;
}

interface AgentDefinition {
  prompt: string;
}

function parseDefinition(raw: unknown): AgentDefinition {
  const def = raw as AgentDefinition;
  return { prompt: String(def.prompt ?? "") };
}

/** 只保留有界文本摘要，避免长任务缓存整段 ACP 事件流。 */
function extractPlainText(event: unknown): string {
  const rpc = extractJsonRpc(event);
  if (rpc?.method !== "session/update") return "";
  const params = rpc.params as Record<string, unknown> | undefined;
  const update = params?.update as Record<string, unknown> | undefined;
  if (update?.sessionUpdate !== "agent_message_chunk") return "";
  const content = update.content as Record<string, unknown> | undefined;
  return typeof content?.text === "string" ? content.text : "";
}

export const agentExecutor: TaskExecutor = {
  type: "agent",

  async execute(input: TaskExecInput): Promise<TaskExecOutput> {
    const { task, requestId } = input;
    const def = parseDefinition(task.definition);
    const startTime = Date.now();

    if (!task.agentId) {
      return { status: "failed", duration: Date.now() - startTime, error: "agentId is null" };
    }

    const timeoutMs = (task.timeoutSeconds ?? 300) * 1000;
    const deadline = new AbortController();
    const timeoutId = setTimeout(() => deadline.abort(new Error("Agent execution timeout")), timeoutMs);

    let turn: PromptTurn | undefined;
    try {
      const result = await waitWithSignal(
        deps.openAgentSession({
          userId: task.userId,
          agentConfigId: task.agentId,
          organizationId: task.organizationId,
          startSource: "scheduled",
          signal: deadline.signal,
        }),
        deadline.signal,
        (late) => late.turn.dispose(),
      );
      turn = result.turn;

      deadline.signal.throwIfAborted();
      turn.prompt([{ type: "text", text: def.prompt }]);

      let resultSummary = "";
      let succeeded = false;
      for await (const event of iterateWithSignal(turn.events(), deadline.signal)) {
        resultSummary = (resultSummary + extractPlainText(event)).slice(0, 2000);
        const terminal = classifyAgentTurnEvent(event);
        if (!terminal) continue;
        if (terminal.outcome !== "succeeded") throw new Error(`Agent execution ${terminal.outcome}`);
        succeeded = true;
        break;
      }
      if (!succeeded) throw new Error("Agent execution ended without a confirmed success");
      const duration = Date.now() - startTime;
      resultSummary = resultSummary.trim();

      // 关联 ID 取自显式输入（§7）；未给时记 null，与日志条目里由 ALS 注入的 requestId 字段区分开
      // （那个字段是当前异步上下文，直接调用本执行器时未必属于本次执行）
      log(`[agent-executor] Task ${task.id} completed: duration=${duration}ms summaryLen=${resultSummary.length}`, {
        requestId: requestId ?? null,
      });
      return { status: "success", duration, resultSummary };
    } catch (err) {
      const duration = Date.now() - startTime;
      const msg = err instanceof Error ? err.message : String(err);
      const isTimeout = msg === "Agent execution timeout";

      logError(`[agent-executor] Task ${task.id} failed:`, msg, { requestId: requestId ?? null });
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
