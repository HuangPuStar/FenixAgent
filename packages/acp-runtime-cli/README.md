# @fenix-agent/acp-runtime-cli

> 在远程节点启动 ACP bridge 并向 RCS (Remote Control Server) 主服务器注册。

## 简介

`acp-runtime` 是一个 CLI 工具，部署在远程机器上运行。它会：

1. 启动指定的 ACP agent（如 opencode、Claude Code）
2. 通过 [acp-link](../acp-link) 建立 ACP stdio ↔ WebSocket bridge
3. 向 RCS 主服务器注册本机，让 RCS 可以远程调度本机上运行的 agent 实例

RCS 主服务器通过这个注册通道，向远程节点下发 `prepare` / `start` / `stop` 指令，实现多租户隔离的远程 agent 管理。

## 安装

### 全局安装（发布后）

```bash
npm install -g @fenix-agent/acp-runtime-cli
```

### 通过 bun 直接运行（无需安装）

```bash
bunx @fenix-agent/acp-runtime-cli <agent-command> [agent-args...]
```

## 快速开始

配置三个必填环境变量后即可启动：

```bash
RCS_URL=ws://localhost:3000 \
RCS_SECRET=<client端鉴权secret> \
RCS_TENANT_ID=<组织ID> \
  acp-runtime opencode acp
```

使用 Claude Code (ccb) 模式连接远程 RCS：

```bash
AGENT_TYPE=ccb \
RCS_URL=wss://rcs.example.com \
RCS_SECRET=<secret> \
RCS_TENANT_ID=<组织ID> \
  acp-runtime npx @anthropic-ai/claude-code --acp
```

启动时 CLI 会先对 RCS 做一次 HTTP 健康检查，任何 HTTP 响应（含 3xx/4xx）都视为在线，只有网络错误才会中断。

## 环境变量

### 必填

以下三个变量缺一不可，缺失时 CLI 会报错退出。

| 变量 | 说明 |
|------|------|
| `RCS_URL` | RCS 的 WS base URL，如 `ws://localhost:3000` 或 `wss://rcs.example.com` |
| `RCS_SECRET` | client 端鉴权 secret，需与 RCS 端配置一致 |
| `RCS_TENANT_ID` | 用于远程注册机器的组织 ID，决定机器在 RCS 中的可见范围 |

### 可选

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `RCS_USER_ID` | — | 用户 ID，进一步限定机器可见范围 |
| `RCS_LABELS` | `remote-runtime` | 节点标签，逗号分隔（如 `production,gpu`），用于调度筛选 |
| `RCS_MACHINE_NAME` | 系统主机名 | 机器在 RCS 中的显示名称 |

### AGENT_TYPE

`AGENT_TYPE` 决定使用哪种 agent runtime，**直接影响节点能运行的 agent 类型和 RCS 对其生命周期的管理方式**。

| 值 | 说明 | 启动命令示例 |
|------|------|-------------|
| `opencode`（默认） | 使用 opencode runtime | `acp-runtime opencode acp` |
| `ccb` | 使用 Claude Code Bridge（Claude Code） | `AGENT_TYPE=ccb acp-runtime npx @anthropic-ai/claude-code --acp` |

> ⚠️ `AGENT_TYPE` **必须与实际启动的 agent 命令匹配**。类型不一致会导致 RCS 无法正确管理 agent 的 prepare/start/stop 生命周期。

## 工作区路径

启动目录（`cwd`）即为 workspace 根目录。RCS 会按以下结构计算实例路径：

```
{cwd}/{organizationId}/{userId}/{environmentId}
```

## 构建与发布

### 本地构建

```bash
cd packages/acp-runtime-cli
bun run build
```

产物 `dist/bin.js` 是自包含 bundle（约 440KB），`acp-link` 及其所有依赖已打包进去，运行时无需额外 `npm install`。

### 发布到 npm

```bash
cd packages/acp-runtime-cli
npm publish
```

`prepublishOnly` 钩子会自动执行 `bun run build`，确保发布的产物是最新的。

## 开发

```bash
# 类型检查
bun run typecheck

# 运行 build 验证产物
bun run build && bun dist/bin.js
```

## License

MIT
