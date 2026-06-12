import { ACPClient } from "acp-link/client";
import { createApiClient, getDemoConfig, logSection, requireValue, toWebSocketUrl, withTimeout } from "./common.js";

const config = getDemoConfig();
const api = createApiClient(config);
const command = process.argv[2] ?? "new-session";
const arg1 = process.argv[3] ?? "";
const promptArg = process.argv
  .slice(command === "new-session" ? 3 : 4)
  .join(" ")
  .trim();

/**
 * 打印 ACP demo 的命令说明，帮助对方快速定位 session 行为。
 */
function printUsage() {
  console.log(`Usage:
  bun acp-events-demo.js list-sessions
    列出当前 Agent 可见的 ACP 会话列表
  bun acp-events-demo.js new-session [prompt]
    创建一个新会话；如果传入 prompt，会立即发送第一条消息
  bun acp-events-demo.js load-session <sessionId> [prompt]
    加载已有会话；如果传入 prompt，会在加载后继续发消息
  bun acp-events-demo.js resume-session <sessionId> [prompt]
    恢复已有会话；如果传入 prompt，会在恢复后继续发消息

Required env:
  API_KEY
    Fenix 控制台生成的 External API Key
  AGENT_CONFIG_ID
    要连接和发起会话的 AgentConfig ID

Optional env:
  BASE_URL
    Fenix 服务地址，默认是 http://localhost:3000
  SESSION_CWD
    ACP 会话的工作目录，常见值是 user
  PROMPT
    new-session 未显式传入 prompt 时使用的默认提示词
  ACP_AUTO_APPROVE=1
    遇到权限请求时自动批准，便于快速演示完整流程
`);
}

/**
 * 等待 Agent 能力同步完成，尤其是 session/list 支持位。
 * Web 端也会在连接成功后做一段时间的能力等待，而不是立刻发请求。
 */
async function waitForSessionListSupport(client, timeoutMs = 15_000) {
  if (client.supportsSessionList) return true;

  return withTimeout(
    new Promise((resolve) => {
      const onCaps = () => {
        if (client.supportsSessionList) {
          client.state.off("capabilitiesChange", onCaps);
          resolve(true);
        }
      };

      client.state.on("capabilitiesChange", onCaps);

      setTimeout(() => {
        client.state.off("capabilitiesChange", onCaps);
        resolve(client.supportsSessionList);
      }, timeoutMs);
    }),
    timeoutMs + 500,
    "waitForSessionListSupport",
  );
}

/**
 * 等待 load/resume 相关 capability 到位。
 */
async function waitForSessionSwitchSupport(client, timeoutMs = 15_000) {
  if (client.supportsLoadSession || client.supportsResumeSession) {
    return {
      supportsLoadSession: client.supportsLoadSession,
      supportsResumeSession: client.supportsResumeSession,
    };
  }

  return withTimeout(
    new Promise((resolve) => {
      const onCaps = () => {
        if (client.supportsLoadSession || client.supportsResumeSession) {
          client.state.off("capabilitiesChange", onCaps);
          resolve({
            supportsLoadSession: client.supportsLoadSession,
            supportsResumeSession: client.supportsResumeSession,
          });
        }
      };

      client.state.on("capabilitiesChange", onCaps);

      setTimeout(() => {
        client.state.off("capabilitiesChange", onCaps);
        resolve({
          supportsLoadSession: client.supportsLoadSession,
          supportsResumeSession: client.supportsResumeSession,
        });
      }, timeoutMs);
    }),
    timeoutMs + 500,
    "waitForSessionSwitchSupport",
  );
}

/**
 * 将会话增量压缩成一行日志，避免 demo 输出过于爆炸。
 */
function summarizeUpdate(update) {
  switch (update.sessionUpdate) {
    case "agent_message_chunk":
      return `agent_message_chunk: ${update.content?.text ?? JSON.stringify(update.content)}`;
    case "user_message_chunk":
      return `user_message_chunk: ${update.content?.text ?? JSON.stringify(update.content)}`;
    case "agent_thought_chunk":
      return `agent_thought_chunk: ${update.thought ?? ""}`;
    case "tool_call":
      return `tool_call: ${update.title ?? update.toolName ?? "tool"}`;
    case "tool_call_status":
      return `tool_call_status: ${update.status ?? "unknown"}`;
    case "available_commands_update":
      return `available_commands_update: ${update.availableCommands?.length ?? 0} command(s)`;
    case "plan":
      return `plan: ${update.entries?.length ?? 0} step(s)`;
    default:
      return JSON.stringify(update);
  }
}

/**
 * 建立一个新的 ACPClient，并把常见事件都挂上日志。
 * 这部分代码刻意写得比较展开，方便调用方按需摘出：
 * 1. 先走 REST connect
 * 2. 再拿 relay.wsUrl 建立 ACP 连接
 * 3. 最后通过事件回调观察会话生命周期
 */
async function createConnectedClient() {
  const agentConfigId = requireValue("AGENT_CONFIG_ID", config.agentConfigId);
  const connected = await api.request(`/api/agents/${agentConfigId}/instances/connect`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ preferNewInstance: false }),
  });

  const proxyUrl = toWebSocketUrl(config.baseUrl, requireValue("relay.wsUrl", connected.relay?.wsUrl ?? ""));
  const client = new ACPClient({
    proxyUrl,
    token: requireValue("API_KEY", config.apiKey),
    cwd: config.sessionCwd || undefined,
  });

  // 这几个 Promise resolver 用来把 ACP 的回调风格包装成 await 风格。
  // Demo 里这样写更利于串行展示；业务系统也可以改成完全事件驱动的处理方式。
  let createResolver = null;
  let createRejecter = null;
  let promptResolver = null;

  // 连接状态日志：便于区分“HTTP connect 成功”与“ACP WebSocket 真正 ready”这两个阶段。
  client.setConnectionStateHandler((state, error) => {
    console.log(`[connection] state=${state}${error ? ` error=${error}` : ""}`);
  });
  // 新会话创建成功后，ACP 会返回实际 sessionId，这里把它回填给等待中的 Promise。
  client.setSessionCreatedHandler((sessionId) => {
    console.log(`[session_created] ${sessionId}`);
    createResolver?.(sessionId);
    createResolver = null;
    createRejecter = null;
  });
  client.setSessionLoadedHandler((sessionId) => {
    console.log(`[session_loaded] ${sessionId}`);
  });
  client.setSessionSwitchingHandler((sessionId) => {
    console.log(`[session_switching] ${sessionId}`);
  });
  // 增量事件统一压缩成单行日志，避免 demo 输出因为 chunk 太多而失去可读性。
  client.setSessionUpdateHandler((sessionId, update) => {
    console.log(`[session_update] ${sessionId} -> ${summarizeUpdate(update)}`);
  });
  // prompt 完成是“本轮发言结束”的可靠信号，适合在脚本模式下作为 await 的完成点。
  client.setPromptCompleteHandler((stopReason, usage) => {
    console.log(`[prompt_complete] stopReason=${stopReason} usage=${JSON.stringify(usage ?? {})}`);
    promptResolver?.({ stopReason, usage });
    promptResolver = null;
  });
  // 演示权限请求如何接入自动批准逻辑。实际业务里通常会改成弹窗、审批流或策略系统。
  client.setPermissionRequestHandler((request) => {
    console.log(`[permission_request] ${request.requestId} tool=${request.toolCall.title ?? "unknown"}`);
    if (!config.autoApprove) return;

    const preferred =
      request.options.find((option) => option.kind === "allow_once") ??
      request.options.find((option) => option.kind === "allow_always") ??
      request.options[0];

    if (preferred) {
      console.log(`[permission_request] auto approve -> ${preferred.optionId}`);
      client.respondToPermission(request.requestId, preferred.optionId);
    }
  });
  // Agent 主动上报错误时，同时透传给等待中的 createSession Promise，避免脚本无感挂住。
  client.setErrorMessageHandler((message) => {
    console.error(`[agent_error] ${message}`);
    createRejecter?.(new Error(message));
    createResolver = null;
    createRejecter = null;
  });

  await client.connect();

  // 能力声明决定后续能不能 list/load/resume，先打出来方便调用方理解 Agent 当前支持什么。
  console.log("[capabilities]", JSON.stringify(client.agentCapabilities ?? {}, null, 2));

  return {
    client,
    async createSession() {
      return withTimeout(
        new Promise((resolve, reject) => {
          createResolver = resolve;
          createRejecter = reject;
          client.createSession(config.sessionCwd || undefined);
        }),
        60_000,
        "createSession",
      );
    },
    async waitPrompt(promptText) {
      // sendPrompt 仍然是回调式完成；这里包装成 Promise 只是为了 demo 串行输出更直观。
      return withTimeout(
        new Promise((resolve) => {
          promptResolver = resolve;
          client.sendPrompt(promptText);
        }),
        180_000,
        "sendPrompt",
      );
    },
  };
}

if (command === "--help" || command === "-h") {
  printUsage();
  process.exit(0);
}

const runtime = await createConnectedClient();
// 只有 new-session 会回退使用默认 prompt；load/resume 只有显式传入 prompt 才会继续发消息。
const promptText = command === "new-session" ? promptArg || config.prompt : promptArg;

try {
  switch (command) {
    case "list-sessions": {
      logSection("ACP session/list");
      // 某些 Agent 在连接刚建立时还没把 capability 全量同步完，先等待再调用更稳定。
      const supported = await waitForSessionListSupport(runtime.client);
      console.log(`[capabilities-after-wait] supportsSessionList=${supported}`);
      if (!supported) {
        throw new Error(
          `Session list capability did not become available. Current capabilities: ${JSON.stringify(runtime.client.agentCapabilities ?? {})}`,
        );
      }
      const result = await runtime.client.listSessions(config.sessionCwd ? { cwd: config.sessionCwd } : {});
      console.log(JSON.stringify(result, null, 2));
      break;
    }
    case "new-session": {
      logSection("ACP session/new");
      const sessionId = await runtime.createSession();
      console.log(`Active session: ${sessionId}`);
      if (promptText) {
        logSection("ACP session/prompt");
        await runtime.waitPrompt(promptText);
      }
      break;
    }
    case "load-session": {
      const sessionId = requireValue("sessionId", arg1 || config.sessionId);
      logSection("ACP session/load");
      // Web 前端也是优先 load，不支持时再回退 resume；demo 保持同样的调用策略。
      const support = await waitForSessionSwitchSupport(runtime.client);
      console.log(
        `[capabilities-after-wait] supportsLoadSession=${support.supportsLoadSession} supportsResumeSession=${support.supportsResumeSession}`,
      );
      if (!support.supportsLoadSession) {
        if (support.supportsResumeSession) {
          console.log("[session/load] loadSession unavailable, fallback to session/resume");
          await runtime.client.resumeSession({
            sessionId,
            cwd: config.sessionCwd || undefined,
          });
        } else {
          throw new Error(
            `Neither loadSession nor resumeSession became available. Current capabilities: ${JSON.stringify(runtime.client.agentCapabilities ?? {})}`,
          );
        }
      } else {
        await runtime.client.loadSession({
          sessionId,
          cwd: config.sessionCwd || undefined,
        });
      }
      if (promptText) {
        logSection("ACP session/prompt");
        await runtime.waitPrompt(promptText);
      }
      break;
    }
    case "resume-session": {
      const sessionId = requireValue("sessionId", arg1 || config.sessionId);
      logSection("ACP session/resume");
      // 这里不做 load fallback，因为命令本身就是“明确测试 resume 能力”。
      const support = await waitForSessionSwitchSupport(runtime.client);
      console.log(
        `[capabilities-after-wait] supportsLoadSession=${support.supportsLoadSession} supportsResumeSession=${support.supportsResumeSession}`,
      );
      if (!support.supportsResumeSession) {
        throw new Error(
          `Resume session capability did not become available. Current capabilities: ${JSON.stringify(runtime.client.agentCapabilities ?? {})}`,
        );
      }
      await runtime.client.resumeSession({
        sessionId,
        cwd: config.sessionCwd || undefined,
      });
      if (promptText) {
        logSection("ACP session/prompt");
        await runtime.waitPrompt(promptText);
      }
      break;
    }
    default:
      printUsage();
      process.exitCode = 1;
  }
} finally {
  // 脚本模式下退出前显式断开，避免本地残留长连接影响下一次观察日志。
  runtime.client.disconnect();
}
