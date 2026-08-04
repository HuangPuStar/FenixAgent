# acp-link

ACP stdio-to-WebSocket bridge — spawns an ACP agent and exposes it via WebSocket.

## 安装

```bash
bun add acp-link
```

## 编程接口

有两种运行模式：

### Server 模式（标准用法）

在本进程中启动 WebSocket 服务器，直接管理 agent 子进程。这是包作为依赖被引用时的典型用法：

```ts
import { createAcpServer, type ServerConfig } from "acp-link";

const config: ServerConfig = {
  port: 9315,
  host: "127.0.0.1",
  command: "opencode",          // 可执行文件名
  args: ["acp"],                // 传给 agent 的参数
  cwd: "/path/to/workspace",    // 工作目录
  env: { OPENAI_API_KEY: "..." },
  agentType: "opencode",        // "opencode" | "ccb" | "claude-code"
};

const server = createAcpServer(config);
// server.close() 关闭服务
```

### Client 模式

不启动本地服务器，而是作为客户端连接到远程 RCS 注册中心。仅 CLI 独立二进制使用：

```ts
import { createAcpClient } from "acp-link";

const client = createAcpClient({
  port: 9315,
  host: "127.0.0.1",
  command: "opencode",
  args: ["acp"],
  cwd: "/path/to/workspace",
  agentType: "opencode",
  rcsUrl: "ws://rcs.example.com:3000",   // RCS 服务地址
  rcsSecret: "your-rcs-token",           // RCS 认证密钥
  tenantId: "org-123",                   // 租户 ID（可选）
  userId: "user-456",                    // 用户 ID（可选）
  labels: ["production"],                // 机器标签（可选）
  name: "My Machine",                    // 机器显示名（可选）
});
// client.close() 断开连接
```

`startServer(config)` 会根据 `config.rcsUrl` 是否存在自动选择模式，仅供 CLI 入口使用。

### 使用 ACP 消息分发器

`AcpDispatcher` 提供与具体传输层无关的 ACP 协议消息处理，常用于在已有 WebSocket 连接的 handler 中嵌入 ACP 能力：

```ts
import { AcpDispatcher, createAcpSessionState } from "acp-link/acp-dispatcher";

const state = createAcpSessionState();
const dispatcher = new AcpDispatcher(state, {
  send: (msg) => ws.send(JSON.stringify(msg)),
  workspace: "/path/to/workspace",
  onControlResponse: (requestId, approved, extra) => {
    // 处理来自前端的权限响应
  },
  onPermissionOutcome: (requestId, outcome) => {
    // 将权限结果路由回 spawnAcpAgent 的待决 Promise
  },
});

// 处理来自 WebSocket 的原始消息
await dispatcher.handleMessage(rawMessage);
```

### 前端 ACP 客户端

```ts
import { ACPClient, DisconnectRequestedError } from "acp-link/client";
import type {
  ConnectionStateHandler,
  SessionUpdateHandler,
  PermissionRequestHandler,
} from "acp-link/client";

const client = new ACPClient("ws://localhost:9315/ws");

client.onConnectionStateChange((state, error) => {
  console.log("Connection:", state);
});

client.onSessionUpdate((sessionId, update) => {
  console.log("Session update:", sessionId, update);
});

client.onPermissionRequest((request) => {
  // 展示权限请求 UI，调用 client.respondToPermission(...) 响应
});

await client.connect();
await client.createSession({ cwd: "/path/to/workspace" });
await client.sendPrompt([{ type: "text", text: "Hello!" }]);
```

### 引擎 Handler 开发

实现自定义 Agent 引擎时，需要暴露 `EngineHandler` 接口：

```ts
import type { EngineHandler, EngineStartContext } from "acp-link/client/instance-manager";
import { AcpDispatcher } from "acp-link/acp-dispatcher";

export function createMyEngineHandler(): EngineHandler {
  return {
    start(ctx: EngineStartContext) {
      // ctx.relay.send(...) — 向客户端发送消息
      // ctx.agentConfig — 当前 agent 配置
      // ctx.sessions — session 管理
      return {
        stop() { /* 清理逻辑 */ },
      };
    },
  };
}
```

### 辅助工具

```ts
// 解析可执行文件路径
import { resolveExecutable } from "acp-link/client/resolve-executable";

// 启动 ACP agent 子进程（opencode / ccb）
import { spawnAcpAgent } from "acp-link/client/acp-spawn-helper";

// 创建 Claude Code 的 ACP 连接适配器
import { createClaudeAcpConnection } from "acp-link/client/claude-acp-adapter";
```

### 类型导出

```ts
import type {
  AgentCapabilities,
  PromptCapabilities,
  PermissionRequestPayload,
  InteractiveQuestionPayload,
  SessionUpdate,
  ContentBlock,
} from "acp-link/types";
```

## 模块导出一览

| 入口 | 说明 |
|------|------|
| `acp-link` | `createAcpServer`, `createAcpClient`, `startServer`, `ServerConfig`, `AcpServerHandle` |
| `acp-link/acp-dispatcher` | `AcpDispatcher`, `createAcpSessionState`, `AcpSessionState` |
| `acp-link/client` | `ACPClient`, `DisconnectRequestedError`, 事件类型 |
| `acp-link/client/acp-spawn-helper` | `spawnAcpAgent` |
| `acp-link/client/claude-acp-adapter` | `createClaudeAcpConnection` |
| `acp-link/client/instance-manager` | `InstanceManager`, `EngineHandler`, `EngineStartContext` |
| `acp-link/client/resolve-executable` | `resolveExecutable` |
| `acp-link/types` | 所有公共类型定义 |


