import { readdirSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as acp from "@agentclientprotocol/sdk";
import { getSessionMessages, type Query, query } from "@anthropic-ai/claude-agent-sdk";
import { ProtocolAdapter } from "./protocol-adapter.js";

/** 会话状态 */
interface SessionState {
  sessionId: string;
  cwd: string;
  createdAt: number;
  title: string;
  /** SDK session UUID，用于 resume。首次 prompt 后由 SDK init 消息填充 */
  ccSessionId?: string;
}

/** Claude Code 支持的模式列表 */
const CC_MODES = [
  { modeId: "default", name: "Default", description: "Ask for all permissions" },
  { modeId: "acceptEdits", name: "Accept Edits", description: "Auto-accept file edits" },
  { modeId: "bypassPermissions", name: "Bypass Permissions", description: "Skip all permission checks" },
  { modeId: "plan", name: "Plan", description: "Plan mode, no actual operations" },
  { modeId: "dontAsk", name: "Don't Ask", description: "Don't ask, just execute" },
];

/** Claude Code 支持的模型列表（从环境变量读取，或使用默认值） */
function buildAvailableModels(): Array<{ modelId: string; name: string }> {
  const modelName = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-6";
  return [
    { modelId: modelName, name: modelName },
    { modelId: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
    { modelId: "claude-opus-4-8", name: "Claude Opus 4.8" },
    { modelId: "claude-haiku-4-5-20251001", name: "Claude Haiku 4.5" },
  ];
}

/** 持久化 session 元数据到 workspace 目录 */
async function saveSessionState(workspace: string, state: SessionState) {
  try {
    const dir = join(workspace, ".claude", "acp-sessions");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${state.sessionId}.json`), JSON.stringify({ ...state, updatedAt: Date.now() }));
  } catch {
    /* best effort */
  }
}

/** 从 workspace 读取 session */
async function loadSessionFromDisk(workspace: string, sessionId: string): Promise<SessionState | null> {
  try {
    const data = await readFile(join(workspace, ".claude", "acp-sessions", `${sessionId}.json`), "utf-8");
    const parsed = JSON.parse(data) as Record<string, unknown>;
    return {
      sessionId: parsed.sessionId as string,
      cwd: parsed.cwd as string,
      createdAt: parsed.createdAt as number,
      title: parsed.title as string,
      ccSessionId: parsed.ccSessionId as string | undefined,
    };
  } catch {
    return null;
  }
}

/** 从 workspace 恢复所有已知 session */
function loadAllSessionsFromDiskSync(workspace: string): SessionState[] {
  try {
    const dir = join(workspace, ".claude", "acp-sessions");
    const files = readdirSync(dir);
    const results: SessionState[] = [];
    for (const f of files) {
      if (!f.endsWith(".json")) continue;
      const s = loadSessionFromDiskSync(workspace, f.replace(".json", ""));
      if (s) results.push(s);
    }
    return results;
  } catch {
    return [];
  }
}

function loadSessionFromDiskSync(workspace: string, sessionId: string): SessionState | null {
  try {
    const { readFileSync } = require("node:fs") as { readFileSync: (path: string, encoding: string) => string };
    const data = readFileSync(join(workspace, ".claude", "acp-sessions", `${sessionId}.json`), "utf-8");
    const parsed = JSON.parse(data) as Record<string, unknown>;
    return {
      // sessionId 优先取 JSON 中的值，兼容旧文件只有 ccSessionId 的情况
      sessionId: (parsed.sessionId as string) || sessionId,
      cwd: (parsed.cwd as string) || workspace,
      createdAt: (parsed.createdAt as number) || Date.now(),
      title: (parsed.title as string) || `Conversation ${sessionId.slice(-4)}`,
      ccSessionId: parsed.ccSessionId as string | undefined,
    };
  } catch {
    return null;
  }
}

/** 异步队列：支持 push 端的 AsyncIterable */
class AsyncQueue<T> implements AsyncIterable<T> {
  private _queue: T[] = [];
  private _deferreds: Array<{ resolve: (result: IteratorResult<T>) => void }> = [];
  private _done = false;

  push(item: T): void {
    if (this._done) return;
    const d = this._deferreds.shift();
    if (d) {
      d.resolve({ value: item, done: false });
    } else {
      this._queue.push(item);
    }
  }

  end(): void {
    this._done = true;
    for (const d of this._deferreds) {
      d.resolve({ value: undefined as unknown as T, done: true });
    }
    this._deferreds = [];
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this._queue.length > 0) {
          return Promise.resolve({ value: this._queue.shift()!, done: false });
        }
        if (this._done) {
          return Promise.resolve({ value: undefined as unknown as T, done: true });
        }
        return new Promise((resolve) => {
          this._deferreds.push({ resolve });
        });
      },
    };
  }
}

/**
 * 包装 Claude Code SDK 的 query() 为 ACP ClientSideConnection，
 * SDK 流式输出通过 send 回调推送到 relay 通道。
 *
 * @param cwd 工作目录
 * @param instanceId 实例 ID
 * @param send 发送回调（已由 InstanceManager.start() 包裹 relay 信封）
 * @param systemPrompt 系统提示词（来自 agent config）
 * @param modelName 模型名称（来自 agent config 的 model.modelName 或 ANTHROPIC_MODEL 环境变量）
 */
export function createClaudeAcpConnection(
  cwd: string,
  instanceId: string,
  send: (message: unknown) => void,
  systemPrompt?: string,
  modelName?: string,
): acp.ClientSideConnection {
  // 模型优先级：参数传入 > ANTHROPIC_MODEL 环境变量 > 默认值
  const effectiveModel = modelName ?? process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-6";

  // 多会话支持：Map 维护所有历史会话
  const sessions = new Map<string, SessionState>();
  let activeSessionId: string | null = null;
  // 默认 acceptEdits：允许文件读写不弹确认，但不能用 bypassPermissions（root 用户被 CC 禁止）
  let currentMode = "acceptEdits";
  let currentModel = effectiveModel;

  // 权限确认 Promise 管理
  const pendingPermissions = new Map<
    string,
    { resolve: (approved: boolean) => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout> }
  >();
  // 用户选择 "Always Allow" 后，同会话内自动允许后续工具
  let sessionAutoAllow = false;

  // 交互式工具（AskUserQuestion 等）答案队列
  const interactiveAnswers = new Map<
    string,
    { resolve: (answer: Record<string, unknown>) => void; timer: ReturnType<typeof setTimeout> }
  >();
  // 当前活跃的 SDK Query 对象（用于 streamInput）
  let currentQuery: Query | null = null;
  // 标记：下次 prompt 需要 resume 的 CC session UUID
  let pendingResumeSessionId: string | null = null;
  // 标记：历史消息已由 unstable_resumeSession 发送到前端，prompt 中跳过 SDK resume 回放
  let historyReplayed = false;

  // send 回调已由 InstanceManager.start() 包裹 relay 信封（type/instance_id/session_id）
  // 此处只需发送原始 JSON-RPC payload
  function sendJsonRpc(id: string | number | null, payload: unknown) {
    if (id != null) {
      send({ jsonrpc: "2.0", id, result: payload });
    } else {
      send({ jsonrpc: "2.0", method: "session/update", params: payload });
    }
  }

  // 从磁盘恢复之前持久化的 session（machine 重启后不丢，同步执行）
  for (const s of loadAllSessionsFromDiskSync(cwd)) {
    sessions.set(s.sessionId, s);
  }

  const conn = {
    async initialize() {
      return {
        protocolVersion: acp.PROTOCOL_VERSION,
        agentCapabilities: {
          loadSession: false,
          mcpCapabilities: { http: true, sse: true },
          promptCapabilities: { embeddedContext: true, image: true },
          sessionCapabilities: { list: {}, resume: {} },
        },
      };
    },

    async newSession(_params: Record<string, unknown>) {
      const sessionId = `claude_${Date.now()}`;
      const title = (_params?.title as string) || `Conversation ${sessions.size + 1}`;
      const state: SessionState = { sessionId, cwd, createdAt: Date.now(), title };
      sessions.set(sessionId, state);
      saveSessionState(cwd, state); // 持久化，重启不丢
      activeSessionId = sessionId;
      return {
        sessionId,
        title,
        models: { currentModelId: currentModel, availableModels: buildAvailableModels() },
        modes: { currentModeId: currentMode, availableModes: CC_MODES },
      };
    },

    async prompt(params: Record<string, unknown>) {
      const blocks = (params.prompt ?? []) as Array<{ type: string; text?: string }>;
      const text = blocks.map((b) => (b.type === "text" ? b.text : "")).join("\n");
      const msgId = (params as Record<string, unknown>).id as string | number | undefined;

      // 自动标题
      if (activeSessionId) {
        const s = sessions.get(activeSessionId);
        if (s && s.title.startsWith("Conversation ") && text.trim()) {
          s.title = text.trim().slice(0, 50) + (text.trim().length > 50 ? "…" : "");
        }
      }

      // 权限回调
      const canUseTool = async (toolName: string, input: Record<string, unknown>, ctx: unknown) => {
        if (toolName === "AskUserQuestion") {
          return { behavior: "allow" as const, updatedInput: input };
        }
        if (sessionAutoAllow || pendingPermissions.size > 0) {
          return { behavior: "allow" as const, updatedInput: input };
        }
        const ctxObj = ctx as Record<string, unknown> | undefined;
        const title = (ctxObj?.title as string) ?? `Claude Code wants to use ${toolName}`;
        const requestId = `perm_${Date.now()}_${toolName}`;
        const permissionPromise = new Promise<boolean>((resolve, reject) => {
          const timer = setTimeout(() => {
            pendingPermissions.delete(requestId);
            resolve(true);
          }, 30000);
          pendingPermissions.set(requestId, { resolve, reject, timer });
        });
        send({
          type: "permission_request",
          payload: {
            sessionId: activeSessionId!,
            requestId,
            options: [
              { kind: "allow_always", label: "Always Allow", optionId: "allow_always" },
              { kind: "allow_once", label: "Allow Once", optionId: "allow_once" },
              { kind: "reject_once", label: "Deny", optionId: "reject_once" },
            ],
            toolCall: { toolCallId: requestId, title },
            toolName,
            toolInput: input,
            description: (ctxObj?.decisionReason as string) || title,
          },
        });
        const approved = await permissionPromise;
        return approved
          ? { behavior: "allow" as const, updatedInput: input }
          : { behavior: "deny" as const, message: "User denied permission" };
      };

      const isFollowUp = activeSessionId ? sessions.get(activeSessionId)?.ccSessionId != null : false;

      // 加载历史 session 时用 resume 回放消息；follow-up 用 continue
      const resumeId = pendingResumeSessionId;
      pendingResumeSessionId = null;

      const q = query({
        prompt: resumeId && !historyReplayed ? "" : text,
        options: {
          cwd,
          systemPrompt,
          model: currentModel,
          permissionMode: currentMode as "default" | "acceptEdits" | "bypassPermissions" | "plan" | "dontAsk",
          canUseTool,
          ...(resumeId ? { resume: resumeId } : isFollowUp ? { continue: true } : {}),
          allowedTools: [],
          mcpServers: {},
          maxTurns: 200,
          pathToClaudeCodeExecutable: process.env.CLAUDE_CODE_CLI_PATH,
        },
      });
      currentQuery = q;

      // historyReplayed 时 unstable_resumeSession 已发送历史消息
      // 仍需 streamInput 推送新 prompt，但 ProtocolAdapter 跳过 SDK resume 回放的消息
      const skipReplay = historyReplayed && resumeId != null;
      historyReplayed = false;

      if (resumeId && text.trim()) {
        const rq = new AsyncQueue<{
          type: "user";
          message: { role: "user"; content: Array<{ type: "text"; text: string }> };
          parent_tool_use_id: null;
        }>();
        rq.push({
          type: "user",
          message: { role: "user", content: [{ type: "text", text }] },
          parent_tool_use_id: null,
        });
        rq.end();
        try {
          await q.streamInput(rq);
        } catch {}
      }

      const adapter = new ProtocolAdapter((type: string, payload?: unknown) => {
        if (type === "prompt_complete") return;
        // 跳过 resume 回放的历史消息（已由 unstable_resumeSession 发送到前端）
        if (skipReplay && (type === "user_message_chunk" || type === "agent_message_chunk")) return;
        sendJsonRpc(null, { sessionId: activeSessionId!, update: { sessionUpdate: type, content: payload } });
      });
      const outputBlocks: Array<Record<string, unknown>> = [];
      for await (const msg of q) {
        adapter.handleSdkOutput(msg);
        if (msg.type === "system" && (msg as Record<string, unknown>).subtype === "init") {
          const ccSid = (msg as Record<string, unknown>).session_id as string | undefined;
          if (ccSid && activeSessionId) {
            const st = sessions.get(activeSessionId);
            if (st) {
              st.ccSessionId = ccSid;
              saveSessionState(cwd, st);
            }
          }
        }
        if (msg.type === "assistant") {
          const inner = ((msg as Record<string, unknown>).message ?? msg) as Record<string, unknown>;
          const innerBlocks = (inner.content ?? []) as Array<Record<string, unknown>>;
          for (const b of innerBlocks) {
            if (b.type === "tool_use" && b.name === "AskUserQuestion") {
              const toolId = b.id as string;
              const toolInput = (b.input ?? {}) as Record<string, unknown>;
              const questions = (toolInput.questions ?? []) as Array<{
                question: string;
                header: string;
                options: Array<{ label: string; description: string }>;
              }>;
              const iqaId = `iqa_${Date.now()}`;
              const answerPromise = new Promise<Record<string, unknown>>((resolve) => {
                const timer = setTimeout(() => {
                  interactiveAnswers.delete(iqaId);
                  resolve({});
                }, 60000);
                interactiveAnswers.set(iqaId, { resolve, timer });
              });
              send({
                type: "interactive_question",
                payload: {
                  sessionId: activeSessionId!,
                  questionId: iqaId,
                  toolId,
                  toolName: "AskUserQuestion",
                  questions,
                  description: "Please answer the following questions",
                },
              });
              const answer = await answerPromise;
              // 通过 streamInput 推答案给 SDK，CC 自动消费
              const answerQueue = new AsyncQueue<{
                type: "user";
                message: { role: "user"; content: Array<{ type: "text"; text: string }> };
                parent_tool_use_id: string;
                tool_use_result?: unknown;
              }>();
              answerQueue.push({
                type: "user",
                message: { role: "user", content: [{ type: "text", text: JSON.stringify(answer) }] },
                parent_tool_use_id: toolId,
                tool_use_result: answer,
              });
              answerQueue.end();
              try {
                await currentQuery?.streamInput(answerQueue);
              } catch {}
              outputBlocks.push(b);
            } else if (b.type === "text" || b.type === "tool_use") {
              outputBlocks.push(b);
            }
          }
        }
      }

      currentQuery = null;
      return { stopReason: "end_turn" as const, content: outputBlocks };
    },

    async cancel(_params: Record<string, unknown>) {},

    /** 返回所有历史会话（不再只返回当前会话） */
    async listSessions(_params: Record<string, unknown>) {
      const list = Array.from(sessions.values()).map((s) => ({
        sessionId: s.sessionId,
        cwd: s.cwd,
        title: s.title,
        updatedAt: new Date(s.createdAt).toISOString(),
      }));
      return { sessions: list };
    },

    async loadSession(params: Record<string, unknown>) {
      const requestedId = (params as Record<string, unknown>).sessionId as string;
      if (requestedId && sessions.has(requestedId)) {
        activeSessionId = requestedId;
        const s = sessions.get(requestedId)!;
        // 标记下次 prompt 需要 resume，以便 SDK 回放历史消息
        // 优先内存，其次从 workspace 磁盘恢复
        const disk = !s.ccSessionId ? loadSessionFromDiskSync(cwd, requestedId) : null;
        const ccId = s.ccSessionId || disk?.ccSessionId;
        if (ccId) {
          s.ccSessionId = ccId;
          pendingResumeSessionId = ccId;
        }
        return {
          sessionId: activeSessionId,
          cwd: s.cwd,
          models: { currentModelId: currentModel, availableModels: buildAvailableModels() },
          modes: { currentModeId: currentMode, availableModes: CC_MODES },
        };
      }
      return { sessionId: activeSessionId ?? "", cwd };
    },

    async setSessionMode(params: Record<string, unknown>) {
      const newMode = ((params as Record<string, unknown>).modeId as string) ?? "bypassPermissions";
      if (CC_MODES.some((m) => m.modeId === newMode)) {
        currentMode = newMode;
      }
    },

    async unstable_setSessionModel(params: Record<string, unknown>) {
      const newModel = ((params as Record<string, unknown>).modelId as string) ?? effectiveModel;
      currentModel = newModel;
    },

    // biome-ignore lint/suspicious/noExplicitAny: unstable API
    async unstable_resumeSession(_params: any) {
      const requestedId = _params?.sessionId as string | undefined;
      // 从内存或磁盘恢复 session
      let sess = requestedId ? sessions.get(requestedId) : undefined;
      if (requestedId && !sess) {
        const disk = loadSessionFromDiskSync(cwd, requestedId);
        if (disk) {
          sessions.set(requestedId, disk);
          sess = disk;
        }
      }
      if (requestedId && sess) {
        activeSessionId = requestedId;
        const ccId = sess.ccSessionId;
        if (ccId) {
          sess.ccSessionId = ccId;
          pendingResumeSessionId = ccId;
          // 从 SDK session 中读取历史消息并推送到前端
          // 标记 historyReplayed，避免 prompt() 中 SDK resume 再次回放
          historyReplayed = true;
          try {
            const msgs = await getSessionMessages(ccId, { dir: cwd });
            for (const m of msgs) {
              if (m.type === "user") {
                const inner = (m.message as Record<string, unknown>) ?? {};
                const content = (inner.content ?? []) as Array<Record<string, unknown>>;
                for (const b of content) {
                  if (b.type === "text" && b.text) {
                    sendJsonRpc(null, {
                      sessionId: activeSessionId!,
                      update: {
                        sessionUpdate: "user_message_chunk",
                        content: { type: "text", text: b.text as string },
                      },
                    });
                  }
                }
              } else if (m.type === "assistant") {
                const inner = (m.message as Record<string, unknown>) ?? {};
                const blocks = (inner.content ?? []) as Array<Record<string, unknown>>;
                for (const b of blocks) {
                  if (b.type === "text" && b.text) {
                    sendJsonRpc(null, {
                      sessionId: activeSessionId!,
                      update: {
                        sessionUpdate: "agent_message_chunk",
                        content: { type: "text", text: b.text as string },
                      },
                    });
                  } else if (b.type === "tool_use") {
                    sendJsonRpc(null, {
                      sessionId: activeSessionId!,
                      update: { sessionUpdate: "tool_call", content: b },
                    });
                  }
                }
              }
            }
          } catch {
            /* best effort */
          }
        }
      }
      return {
        sessionId: activeSessionId ?? "",
        models: { currentModelId: currentModel, availableModels: buildAvailableModels() },
        modes: { currentModeId: currentMode, availableModes: CC_MODES },
      };
    },

    /** requestPermission 回调：通过 session/update 将权限请求转发给前端 */
    async requestPermission(params: Record<string, unknown>) {
      const toolName = (params.toolName as string) ?? "unknown";
      const toolArgs = (params.toolArgs as Record<string, unknown>) ?? {};

      sendJsonRpc(null, {
        sessionId: activeSessionId!,
        update: {
          sessionUpdate: "permission_request",
          content: {
            toolName,
            toolArgs,
            timestamp: Date.now(),
          },
        },
      });

      return { outcome: { outcome: "selected" as const, optionId: "allow" } };
    },

    closed: new Promise<void>(() => {}),

    /** 处理前端返回的 control_response，解析对应的 canUseTool Promise */
    handleControlResponse(requestId: string, approved: boolean, extra?: Record<string, unknown>) {
      // 先检查是否是交互式工具答案
      const iqa = interactiveAnswers.get(requestId);
      if (iqa) {
        clearTimeout(iqa.timer);
        interactiveAnswers.delete(requestId);
        // 从 permission response 的 optionId 提取用户选择的答案
        const outcome = (extra?.outcome as Record<string, unknown>) ?? {};
        const selectedOption = (outcome.optionId as string) ?? "";
        const answers = selectedOption ? { selected: selectedOption } : (extra?.answers ?? extra ?? {});
        iqa.resolve(answers as Record<string, unknown>);
        return;
      }

      const pending = pendingPermissions.get(requestId);
      if (pending) {
        clearTimeout(pending.timer);
        pendingPermissions.delete(requestId);
        const outcome = (extra?.outcome as Record<string, unknown>) ?? {};
        if (outcome.optionId === "allow_always") {
          sessionAutoAllow = true;
        }
        pending.resolve(approved);
      }
    },
  };

  return conn as unknown as acp.ClientSideConnection;
}
