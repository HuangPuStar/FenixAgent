# External API Agent 管理与会话说明

这篇文档面向 External API 的调用方，重点说明 Agent 运行链路中的核心概念、对象关系，以及推荐调用顺序。

如果你只想先看接口定义，请直接查看：

- 交互式文档：`http://server/docs/openapi/external`
- OpenAPI JSON：`http://server/docs/openapi/external/json`

如果你想直接跑示例，请参考：

- `/docs/developer/api-demo/agent`

如果你想对接 API，也建议参考示例的代码逻辑。

## 核心对象

### AgentConfig

`AgentConfig` 是一个 Agent 的配置定义，描述这个 Agent 应该如何工作，例如：

- 使用哪个模型
- 使用什么 prompt
- 是否挂载 skill、MCP 等能力

External API 的 `GET /api/agents`、`POST /api/agents` 这一组接口，操作的就是 `AgentConfig`。

### Environment

`Environment` 表示这个 Agent 的运行环境。它通常对应一个工作区上下文，用来承载：

- 工作目录
- 用户上传的文件
- Agent 运行时依赖的环境上下文

对外调用方通常不需要先单独创建 environment，而是通过 connect 接口由后端自动准备。

### Instance

`Instance` 表示一个可连接的 Agent 运行实例。

调用方真正要连接的是 instance 对应的 relay WebSocket，但通常也不需要自己管理 instance 的完整生命周期，而是通过：

```text
POST /api/agents/:agentId/instances/connect
```

让后端自动完成：

- 准备 environment
- 启动或复用可用 instance
- 返回可连接的 `relay.wsUrl`

### Workspace

`Workspace` 是 environment 对应的工作目录视角。

上传文件、准备输入资料这类操作，属于 workspace 维度，而不是某个 session 维度。

所以文件接口放在：

```text
/api/environments/:environmentId/workspace/*
```

而不是放在 session 下面。

### ACP Session

真正的聊天会话能力，是在连上 relay WebSocket 之后，通过 ACP 协议完成的。

例如这些能力：

- `session/new`
- `session/list`
- `session/load`
- `session/resume`
- `session/prompt`

它们不是 REST API，而是 ACP 协议能力。

## 对象关系

从调用方视角，可以把关系理解成：

```text
AgentConfig -> Environment -> Instance -> ACP Session
```

含义分别是：

- 先选择一个 `AgentConfig`
- 再通过 connect 获得对应运行环境和可用实例
- 然后连接返回的 relay WebSocket
- 最后通过 ACP 在这个连接上创建或恢复 session

如果只看使用顺序，这套链路可以简化成：

```text
先选 Agent -> connect -> 连 WebSocket -> 用 ACP 会话
```

## 推荐调用顺序

### 场景一：第一次进入聊天

推荐顺序：

1. `GET /api/agents`
2. `POST /api/agents/:agentConfigId/instances/connect`
3. 连接返回的 `relay.wsUrl`
4. 调用 ACP `new-session`
5. 调用 ACP `prompt`

这适合“打开某个 Agent，开始一轮新对话”的场景。

### 场景二：继续历史会话

推荐顺序：

1. `GET /api/agents`
2. `POST /api/agents/:agentConfigId/instances/connect`
3. 连接返回的 `relay.wsUrl`
4. 调用 ACP `list-sessions`
5. 根据需要调用 ACP `load-session` 或 `resume-session`
6. 再调用 ACP `prompt`

这适合“接着上次的会话继续聊”的场景。

### 场景三：先上传文件，再让 Agent 使用

推荐顺序：

1. `POST /api/agents/:agentConfigId/instances/connect`
2. 拿到 `environmentId`
3. 调用 `POST /api/environments/:environmentId/workspace/files`
4. 连接 relay WebSocket
5. 在 ACP 会话里告诉 Agent 去读取对应路径，例如 `user/demo/demo-upload.txt`

这适合“先准备输入文件，再发起对话”的场景。

## connect 接口怎么理解

对调用方来说，下面这个接口是 Agent 运行时入口：

```text
POST /api/agents/:agentId/instances/connect
```

建议把它理解成：

- “为这个 Agent 准备一个可连接的运行实例”

而不是：

- “单纯查一个实例列表”

它的主要作用是把运行时前置步骤压缩掉，避免调用方自己处理 environment、instance 的创建和复用细节。

典型响应里会包含：

- `agentConfigId`
- `environmentId`
- `instanceId`
- `relay.wsUrl`

其中最重要的是：

- `environmentId`
  后续上传文件时要用
- `relay.wsUrl`
  后续建立 ACP 连接时要用

## 会话相关能力怎么选

### new-session

用于创建一轮全新的会话。

适合：

- 第一次进入聊天
- 明确要开始新话题，不复用历史上下文

### list-sessions

用于查询当前 Agent 在当前运行上下文下可见的会话列表。

适合：

- 展示历史会话列表
- 让用户选择继续哪一轮对话

### load-session

用于加载一个已有会话，并把它设为当前活跃会话。

通常这是继续历史对话时优先使用的能力。

### resume-session

用于恢复一个已有会话。

某些 Agent 只提供 `resume` 能力，不提供 `load` 能力，这时需要走 `resume-session`。

调用方如果使用 `acp-link` 的 demo 逻辑，可以采用：

- 优先尝试 `load-session`
- 如果 Agent 不支持，再回退到 `resume-session`

## Workspace 文件为什么不属于 Session

因为当前设计下，文件是放在 environment 对应的工作区里，而不是挂在某条 session 上。

这意味着：

- 同一个 environment 下的不同会话，可以看到同一个工作区里的文件
- 上传文件是“准备运行上下文”，不是“给某条消息挂附件”

所以对调用方来说，应该把文件理解成：

- Agent 工作区里的资源

而不是：

- 某条会话私有的附件

## 常见注意事项

### 1. OpenAPI 只覆盖 REST 部分

`http://server/docs/openapi/external` 主要用于查看 REST API，例如：

- `/api/agents`
- `/api/agents/:id/instances/connect`
- `/api/environments/:environmentId/workspace/files`

会话相关的 ACP 协议能力，不会完整体现在 OpenAPI 里。

### 2. 连接 WebSocket 后，能力可能不会立刻齐全

某些 session 能力需要在 ACP 连接建立后，等待 agent capability 同步完成。

所以调用方不要假设一连上 WebSocket 就能立刻调用：

- `list-sessions`
- `load-session`
- `resume-session`

更稳妥的方式是：

- 等待 capability 到位
- 或直接参考 `/docs/developer/api-demo/agent/acp-events-demo.js` 的处理逻辑

### 3. 不要把 workspace 文件和会话强绑定

如果你上传了一个文件到 workspace，后续应该通过文件路径让 Agent 去读取它，而不是期待这个文件自动挂到某个 session 上。

### 4. 不要直接依赖 `/web/*`

External API 调用方应统一使用：

- `/api/*` 这一组 REST API
- `relay.wsUrl` 对应的 ACP WebSocket

不要直接调用控制台内部使用的 `/web/*` 接口。
