# Agent Demo

这个目录提供了一组可直接运行的 External API 示例脚本，覆盖：

- AgentConfig CRUD
- Instance 连接
- Workspace 文件上传
- ACP 会话与事件通信

建议从仓库根目录执行，统一使用 `bun` 运行。

目录定位：

- 这一组 demo 关注 AgentConfig 和 Agent 运行链路
- 后续如果增加其他能力域，请在 `demo/` 下新增新的子目录，不要继续堆到这里

## 前置准备

先准备几个环境变量：

```bash
# Fenix 服务地址，默认本地开发环境一般是 http://localhost:3000
export BASE_URL=http://localhost:3000
# Fenix 控制台生成的 External API Key
export API_KEY=rcs_xxx
```

## 文件说明

- `common.js`
  公共工具：环境变量读取、带鉴权的 HTTP 请求、URL 处理、超时保护
- `agent-config-demo.js`
  AgentConfig CRUD demo
- `instance-connect-demo.js`
  Instance 连接 demo
- `workspace-upload-demo.js`
  Workspace 文件上传 demo
- `acp-events-demo.js`
  ACP 会话与事件 demo
- `demo-upload.txt`
  默认上传用示例文件

## 1. AgentConfig Demo

查看列表：

```bash
bun agent-config-demo.js list
```

完整 CRUD 流程：

```bash
bun agent-config-demo.js crud
```

单独操作：

```bash
bun agent-config-demo.js get <agentConfigId>
bun agent-config-demo.js create
bun agent-config-demo.js update <agentConfigId>
bun agent-config-demo.js delete <agentConfigId>
```

注意操作 `create` / `update`，需要额外的环境变量：

```bash
# 创建或更新 AgentConfig 时使用的模型 ID（从模型的 API 获取）
export MODEL_ID=<你的Model ID>
```

## 2. Instance 连接 Demo

```bash
bun instance-connect-demo.js
```

这个脚本会调用：

- `POST /api/agents/:agentId/instances/connect`

并输出：

- `agentConfigId`
- `environmentId`
- `instanceId`
- `relay.wsUrl`

默认连接第一个AgentConfig，如需指定，使用下面的环境变量：

```bash
# 要连接或发起会话的 AgentConfig ID（从 AgentConfig 的 API获取）
export AGENT_CONFIG_ID=<你的AgentConfig ID>
```

## 3. Workspace 文件上传 Demo

```bash
bun workspace-upload-demo.js
```

这个脚本会：

1. 复用 `ENVIRONMENT_ID`，或先通过 connect 自动拿到 `environmentId`
2. 读取 `demo-upload.txt`
3. 上传到：
   `POST /api/environments/:environmentId/workspace/files`

需要使用下面的环境变量来指定AgentConfig：

```bash
# 要连接或发起会话的 AgentConfig ID（从 AgentConfig 的 API获取）
export AGENT_CONFIG_ID=<你的AgentConfig ID>
```

## 4. ACP 事件 Demo

列出现有会话：

```bash
bun acp-events-demo.js list-sessions
```

这个命令会先等待 ACP capabilities 同步完成，再发 `session/list`。

新建会话并发一条 prompt：

```bash
bun acp-events-demo.js new-session "请介绍一下你自己"
```

加载已有会话后继续发消息：

```bash
bun acp-events-demo.js load-session <sessionId> "继续上一轮对话"
```

这个命令会优先尝试 `session/load`；如果目标 Agent 只声明了 `resume` 能力，会自动回退到 `session/resume`。

如果你只想切换会话而不发送消息，可以直接执行：

```bash
bun acp-events-demo.js load-session <sessionId>
```

恢复已有会话后继续发消息：

```bash
bun acp-events-demo.js resume-session <sessionId> "继续执行刚才的任务"
```

这个脚本会演示并打印这些事件：

- `connectionState`
- `session_created`
- `session_loaded`
- `session_switching`
- `session_update`
- `prompt_complete`
- `permission_request`


需要使用下面的环境变量来指定AgentConfig：

```bash
# 要连接或发起会话的 AgentConfig ID（从 AgentConfig 的 API获取）
export AGENT_CONFIG_ID=<你的AgentConfig ID>
```

如果你希望会话自动批准权限请求，可以设置：

```bash
export ACP_AUTO_APPROVE=1
```

## 推荐体验顺序

建议按下面顺序体验最顺：

1. `bun agent-config-demo.js list`
2. `bun instance-connect-demo.js`
3. `bun workspace-upload-demo.js`
4. `bun acp-events-demo.js new-session "请读取 user/demo/demo-upload.txt 并总结内容"`
