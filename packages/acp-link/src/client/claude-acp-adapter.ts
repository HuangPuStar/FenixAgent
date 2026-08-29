import { existsSync, readdirSync } from "node:fs";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as acp from "@agentclientprotocol/sdk";
import { getSessionMessages, type Query, query } from "@anthropic-ai/claude-agent-sdk";
import { type AcpSessionUpdate, ProtocolAdapter, translateCompleteAssistantMessage } from "./protocol-adapter.js";
import { ActiveQueryRegistry } from "./query-registry.js";

/** 会话状态 */
export interface SessionState {
  sessionId: string;
  cwd: string;
  createdAt: number;
  title: string;
  /** SDK session UUID，用于 resume。首次 prompt 后由 SDK init 消息填充 */
  ccSessionId?: string;
  /** 会话隔离目录。每个 RCS session 使用独立 subdirectory 作为 CC SDK 的 cwd，
   *  避免所有 RCS session 共享同一个 CC 内部 session。 */
  sessionCwd?: string;
}

/** Claude Code 支持的模式列表 */
const CC_MODES = [
  { modeId: "default", name: "Default", description: "Ask for all permissions" },
  { modeId: "acceptEdits", name: "Accept Edits", description: "Auto-accept file edits" },
  { modeId: "bypassPermissions", name: "Bypass Permissions", description: "Skip all permission checks" },
  { modeId: "plan", name: "Plan", description: "Plan mode, no actual operations" },
  { modeId: "dontAsk", name: "Don't Ask", description: "Don't ask, just execute" },
];

// sessionId 生成：时间戳 + 模块级自增计数。
// 并发 newSession 同毫秒调用时，仅 Date.now() 会生成相同 sessionId，
// 导致两个 run 拿到同一会话；自增后缀保证进程内唯一。
let sessionIdSeq = 0;
function nextSessionId(): string {
  sessionIdSeq += 1;
  return `claude_${Date.now()}_${sessionIdSeq}`;
}

/**
 * 解析一次 prompt 调用的目标会话。
 *
 * 并发 run 各自在 session/prompt 请求中携带 sessionId（server.ts 已按
 * params.sessionId 路由）；未携带时（yjs 前端路径）沿用连接级当前会话。
 * 只读取、不写回 activeSessionId，避免并发下互相覆盖共享上下文。
 */
export function resolvePromptTargetSession(
  params: Record<string, unknown>,
  sessions: Map<string, SessionState>,
  activeSessionId: string | null,
): { targetSessionId: string | null; targetSession: SessionState | undefined } {
  const requestedSessionId = (params.sessionId as string | undefined) ?? activeSessionId;
  const targetSession = requestedSessionId ? sessions.get(requestedSessionId) : undefined;
  const targetSessionId = targetSession ? requestedSessionId : activeSessionId;
  return { targetSessionId, targetSession };
}

/**
 * 判断 SDK user 帧是否只是本次 ACP prompt 的实时回显。
 *
 * replay、工具结果与带异步来源的 user 帧承载真实时间线边界，必须保留；仅抑制
 * 主会话中与本次 prompt 文本完全一致的首次人类输入回显，避免 Chat Doc 双写。
 */
function isCurrentPromptEcho(message: Record<string, unknown>, promptText: string): boolean {
  if (message.type !== "user" || message.isReplay === true || message.isSynthetic === true) return false;
  if (message.shouldQuery === false || (message.parent_tool_use_id ?? null) !== null) return false;
  const origin = message.origin as Record<string, unknown> | undefined;
  if (origin?.kind !== undefined && origin.kind !== "human") return false;

  const inner = (message.message ?? {}) as Record<string, unknown>;
  const content = inner.content;
  if (message.tool_use_result !== undefined) return false;
  if (typeof content === "string") return content === promptText;
  if (!Array.isArray(content) || content.length === 0) return false;

  const textBlocks: string[] = [];
  for (const block of content) {
    if (typeof block !== "object" || block === null) return false;
    const record = block as Record<string, unknown>;
    if (record.type !== "text" || typeof record.text !== "string") return false;
    textBlocks.push(record.text);
  }
  return textBlocks.join("\n") === promptText;
}

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
async function _loadSessionFromDisk(workspace: string, sessionId: string): Promise<SessionState | null> {
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
      sessionCwd: parsed.sessionCwd as string | undefined,
    };
  } catch {
    return null;
  }
}

/**
 * 为 RCS session 创建独立的 working directory，确保 CC SDK 为每个 session
 * 创建独立的内部 session，避免所有 RCS session 共享同一个 CC session 导致消息混合。
 */
async function ensureSessionDir(workspace: string, sessionId: string): Promise<string> {
  const sessionDir = join(workspace, ".cc-sessions", sessionId);
  await mkdir(sessionDir, { recursive: true });

  // 为 CC SDK 准备 .claude 子目录
  const ccDir = join(sessionDir, ".claude");
  await mkdir(ccDir, { recursive: true });

  // Symlink 父 workspace 的关键配置文件到 session 目录
  const links: Array<[string, string]> = [
    [join(workspace, "CLAUDE.md"), join(sessionDir, "CLAUDE.md")],
    [join(workspace, ".mcp.json"), join(sessionDir, ".mcp.json")],
    [join(workspace, ".claude", "settings.local.json"), join(ccDir, "settings.local.json")],
  ];

  for (const [src, dest] of links) {
    try {
      if (existsSync(src) && !existsSync(dest)) {
        await symlink(src, dest);
      }
    } catch {
      /* best effort — 配置文件非必需 */
    }
  }

  return sessionDir;
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
  _instanceId: string,
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
  // 活跃 SDK Query 注册表（按 sessionId 定位）：cancel 携带 sessionId 需精确中断目标 query，
  // 单字段 currentQuery 在多会话并发（workflow/多标签页）下会被后启动的 query 覆盖。
  // reportError 用于同 session 双 prompt（协议违规）的覆盖告警，便于定位异常并发。
  const activeQueries = new ActiveQueryRegistry<Query>({
    reportError: (message, error) => console.warn(`[claude-acp-adapter] ${message}`, error),
  });
  const resumeStates = new Map<
    string,
    { ccSessionId: string; historyDelivered: boolean; replayUpdates: string[]; phase: "idle" | "replaying" | "live" }
  >();

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
      const sessionId = nextSessionId();
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
      const _msgId = (params as Record<string, unknown>).id as string | number | undefined;

      // 并发 run 各自携带 sessionId；此处解析本次调用的目标会话。
      // 不写回 activeSessionId：并发下写回会让共享状态指向最后调用者，
      // 导致 update 通知/权限请求等标记错误的会话
      const { targetSessionId, targetSession } = resolvePromptTargetSession(params, sessions, activeSessionId);

      // 自动标题
      if (targetSession) {
        const s = targetSession;
        if (s.title.startsWith("Conversation ") && text.trim()) {
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
        const ctxObj = ctx as { signal?: AbortSignal; title?: string; decisionReason?: string } | undefined;
        const title = ctxObj?.title ?? `Claude Code wants to use ${toolName}`;
        const requestId = `perm_${Date.now()}_${toolName}`;
        const permissionPromise = new Promise<boolean>((resolve, reject) => {
          const timer = setTimeout(() => {
            pendingPermissions.delete(requestId);
            resolve(true);
          }, 30000);
          // SDK 的 canUseTool options.signal（见 sdk.d.ts CanUseTool）：CLI 侧 interrupt
          // 时 SDK 发送 control_cancel_request 触发 abort。permissionPromise 挂起会阻塞
          // for-await 循环体，interrupt() 不直接穿透 await，不监听将残留挂起最多 30s
          // （注册表条目未释放）。abort 时立即按拒绝处理：取消中不再执行该工具。
          const signal = ctxObj?.signal;
          const onAbort = () => {
            clearTimeout(timer);
            pendingPermissions.delete(requestId);
            resolve(false);
          };
          if (signal) {
            if (signal.aborted) onAbort();
            else signal.addEventListener("abort", onAbort, { once: true });
          }
          pendingPermissions.set(requestId, { resolve, reject, timer });
        });
        send({
          type: "permission_request",
          payload: {
            sessionId: targetSessionId!,
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

      const isFollowUp = targetSession?.ccSessionId != null;

      // 加载历史 session 时用 resume；恢复状态按 RCS session 隔离。
      const resumeState = targetSessionId ? resumeStates.get(targetSessionId) : undefined;
      const resumeId = resumeState?.ccSessionId;

      // 每个 RCS session 使用独立的 CC SDK cwd，避免所有 session 共享同一个 CC 内部 session
      let sessionCwd = cwd;
      if (targetSessionId) {
        const sess = sessions.get(targetSessionId);
        if (sess?.sessionCwd) {
          sessionCwd = sess.sessionCwd;
        } else if (!resumeId && !isFollowUp) {
          // 新 session：创建隔离目录
          sessionCwd = await ensureSessionDir(cwd, targetSessionId);
          if (sess) {
            sess.sessionCwd = sessionCwd;
            saveSessionState(cwd, sess);
          }
        }
      }

      const q = query({
        prompt: resumeId && !resumeState?.historyDelivered ? "" : text,
        options: {
          cwd: sessionCwd,
          systemPrompt,
          model: currentModel,
          permissionMode: currentMode as "default" | "acceptEdits" | "bypassPermissions" | "plan" | "dontAsk",
          canUseTool,
          ...(resumeId ? { resume: resumeId } : isFollowUp ? { continue: true } : {}),
          allowedTools: [],
          mcpServers: {},
          maxTurns: 200,
          includePartialMessages: true,
          pathToClaudeCodeExecutable: process.env.CLAUDE_CODE_CLI_PATH,
        },
      });
      activeQueries.register(targetSessionId, q);

      if (resumeState) resumeState.phase = resumeState.historyDelivered ? "replaying" : "live";

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

      const adapter = new ProtocolAdapter(
        (update: AcpSessionUpdate) => {
          if (update.sessionUpdate === "prompt_complete") return;
          if (resumeState?.phase === "replaying") {
            const replayKey = JSON.stringify(update);
            if (resumeState.replayUpdates[0] === replayKey) {
              resumeState.replayUpdates.shift();
              return;
            }
            resumeState.phase = "live";
          }
          sendJsonRpc(null, { sessionId: targetSessionId!, update });
        },
        (message) => console.warn(`[claude-acp-adapter] session ${targetSessionId}: ${message}`),
      );
      const outputBlocks: Array<Record<string, unknown>> = [];
      let cancelled = false;
      try {
        for await (const msg of q) {
          if (!isCurrentPromptEcho(msg as unknown as Record<string, unknown>, text)) {
            adapter.handleSdkOutput(msg);
          }
          if (msg.type === "system" && (msg as Record<string, unknown>).subtype === "init") {
            const ccSid = (msg as Record<string, unknown>).session_id as string | undefined;
            // ccSessionId 必须写回本次调用的目标会话，否则并发 run 会把 SDK 会话
            // UUID 写到别的 session，后续 resume 时用错会话
            if (ccSid && targetSession) {
              targetSession.ccSessionId = ccSid;
              saveSessionState(cwd, targetSession);
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
                    sessionId: targetSessionId!,
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
                  await q.streamInput(answerQueue);
                } catch {}
                outputBlocks.push(b);
              } else if (b.type === "text" || b.type === "tool_use") {
                outputBlocks.push(b);
              }
            }
          }
        }
        // 收尾前读取 cancel 标记：本 session 的 query 被 cancel() 中断过则响应
        // stopReason:"cancelled"（ACP 语义，前端 acp-channel 据此收敛 turn_cancelled 终态），
        // 未取消的 prompt 保持 end_turn
        cancelled = activeQueries.peekCancelRequested(targetSessionId);
      } finally {
        // 无论正常结束还是异常（CLI 崩溃/OOM）都注销，避免注册表残留 stale 条目：
        // 残留条目会让后续 cancel 命中已结束的 query 并调用 interrupt()（必然 reject）。
        // 异常路径不吞错：unregister 后异常继续向上传播，handlePrompt 回 error RPC。
        activeQueries.unregister(targetSessionId);
        if (targetSessionId && resumeId) resumeStates.delete(targetSessionId);
      }
      return { stopReason: cancelled ? ("cancelled" as const) : ("end_turn" as const), content: outputBlocks };
    },

    async cancel(params: Record<string, unknown>) {
      // ACP 语义：session/cancel 后 prompt 响应应带 stopReason:"cancelled"。
      // interrupt() 中断目标 session 的活跃 query；依赖 SDK 行为：interrupt 后
      // for-await 流正常收尾（query 停止处理并返回控制权，见 sdk.d.ts interrupt()），
      // 循环结束读取 cancelRequested 标记返回 stopReason:"cancelled"。若未来 SDK 版本
      // 行为变化（interrupt 后流不关闭），可 fallback Query.close()（进程级强杀，
      // 会以异常结束 for-await，依赖上方 try/finally 的注销路径）。
      // 无活跃 query 时 no-op——Agent 侧已无进行中的 turn，无需报错（幂等）
      const sessionId = (params as { sessionId?: string | null }).sessionId ?? null;
      await activeQueries.cancel(sessionId);
    },

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
          resumeStates.set(requestedId, {
            ccSessionId: ccId,
            historyDelivered: false,
            replayUpdates: [],
            phase: "idle",
          });
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
      const availableIds = buildAvailableModels().map((m) => m.modelId);
      if (!availableIds.includes(newModel)) {
        console.warn(
          `[claude-acp-adapter] unstable_setSessionModel: model "${newModel}" not in available models, ignoring`,
        );
        return;
      }
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
          const resumeState = {
            ccSessionId: ccId,
            historyDelivered: false,
            replayUpdates: [] as string[],
            phase: "idle" as const,
          };
          resumeStates.set(requestedId, resumeState);
          try {
            const msgDir = sess.sessionCwd || cwd;
            const messages = await getSessionMessages(ccId, { dir: msgDir });
            for (const message of messages) {
              let replayUpdates: AcpSessionUpdate[] = [];
              if (message.type === "user") {
                const inner = (message.message as Record<string, unknown>) ?? {};
                const blocks = (inner.content ?? []) as Array<Record<string, unknown>>;
                replayUpdates = blocks.flatMap((block) =>
                  block.type === "text" && typeof block.text === "string"
                    ? [{ sessionUpdate: "user_message_chunk", content: { type: "text", text: block.text } }]
                    : [],
                );
              } else if (message.type === "assistant") {
                replayUpdates = translateCompleteAssistantMessage(message, new Map(), (diagnostic) =>
                  console.warn(`[claude-acp-adapter] session ${requestedId}: ${diagnostic}`),
                );
              }
              for (const update of replayUpdates) {
                sendJsonRpc(null, { sessionId: requestedId, update });
                resumeState.replayUpdates.push(JSON.stringify(update));
              }
            }
            resumeState.historyDelivered = true;
          } catch (error) {
            console.warn(`[claude-acp-adapter] failed to replay session ${requestedId} history`, error);
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
